// SECURITY 2026-09-17 — Two separate defects, neither an outright missing
// gate (this function did decode and verify the caller's JWT on every
// route, unlike most of the functions from the earlier audit).
//
// 1. getMemberId() compared trip_members.user_id (TEXT, the platform id
//    space — auth_identities.provider_subject bridges to it) directly
//    against the raw Supabase auth.uid() (a uuid) returned by verifyUser().
//    Those are different id spaces and the comparison could never match, so
//    every real request took the "not a member" path — UNLESS the query
//    itself errored (e.g. a transient DB issue), in which case the code
//    fell back to `return userId`, silently treating the caller as a member
//    using their raw auth uid as memberId. That fallback is a fail-open: an
//    error mid-request would let budget preference reads/writes/deletes
//    proceed under an identity that was never validated against
//    trip_members at all. Fixed by resolving auth.uid() to the platform
//    user id with resolvePlatformUserId() before querying trip_members, and
//    by making every error path return null (not found) instead of falling
//    back to the caller's own id.
// 2. `BUDGET_MASTER_KEY` fell back to a hardcoded all-'a' hex string when
//    the environment variable was unset. Every budget_preferences ciphertext
//    is HKDF-derived from this master key plus (tripId, memberId) alone —
//    both are values an authenticated member already knows — so if the env
//    var were ever unset in this or another environment, anyone could
//    derive the same key and decrypt any trip's budget preferences offline.
//    Fixed by removing the fallback: deriveKey() now throws if the key
//    isn't configured, which every call site already turns into a generic
//    500 rather than silently using a guessable key.
//
// The /band route is additionally reachable from budget-forecast
// server-to-server with the service-role key (it fetches
// `/budget-preferences/band` to compare a forecast against the group's
// comfort band), so it now accepts requireUserOrService rather than
// requireUser alone; /me and /check remain user-only.
//
// 2026-09-17 (2) — platform_trips was dropped and merged into trips.
// computeAggregate() and handleCheck() both queried platform_trips for
// trip metadata (base_currency, start_date/end_date) inside a try/catch
// that swallowed the resulting error and silently fell back to a default
// (baseCurrency = 'USD', tripDays = 1), corrupting the aggregate/check
// output with no visible failure. Repointed both at `trips` (same column
// names) and replaced the silent catch with a captured error that is
// logged.
//
// 2026-09-19 — that last fix logged the fallbacks but kept USING them, and
// the values they produce are exactly the kind this codebase keeps getting
// bitten by. Three fabrications removed here, plus one outright crash:
//
//   a) `baseCurrency = 'USD'` when the trip has no base_currency: the group
//      band was labelled and published as US dollars on no evidence.
//   b) `tripDays = 1` when the trip has no dates: /check compared a whole
//      trip's cost against ONE DAY of a member's comfort range and returned
//      a confident fitsMe verdict from it.
//   c) FX: computeAggregate logged "FX conversion not implemented, using
//      1:1" and then went ahead — running Math.max/Math.min across raw
//      numbers from different currencies. Two members, one budgeting
//      ¥20,000/day and one €150/day, produced a "group comfort band" that is
//      arithmetic on incomparable units, rounded to a neat figure and shown
//      to the group as their agreed range. Amounts are now withheld unless
//      every respondent used the same currency.
//   d) The material-change notification used
//      `.insert({...}).onConflict('trip_id').ignore()`. `onConflict` is not
//      a method on supabase-js's insert builder — that line throws
//      TypeError every time it is reached, and the surrounding try/catch
//      swallowed it. No budget-change notification has ever been queued.
//
// 2026-09-20 — Q2.18: /band and /check served budget_aggregates without ever
// asking whether it was still true.
//
// budget_aggregates is a cache with exactly one writer — computeAggregate(),
// below — and that writer is only ever reached from this file's PUT /me and
// DELETE /me. There is no trigger on budget_preferences, no cron job, and no
// SQL anywhere that could rebuild the row if it wanted to: the source
// preferences are AES-GCM ciphertext keyed from BUDGET_MASTER_KEY, so
// Postgres physically cannot derive the band. The derivation exists only in
// the TypeScript above.
//
// That left three ways for the stored row to stop matching the answers on
// file, with nothing to bring it back:
//
//   a) The 2-minute debounce in PUT /me has no trailing edge. A second member
//      answering within two minutes of the first is DROPPED, not deferred —
//      nothing ever returns to fold that answer in. The band simply never
//      reflects them until some later, unrelated write happens to land
//      outside the window.
//   b) computeAggregate() returns without writing on a preferences fetch
//      error, on ANY decrypt failure, and on a failed upsert. Each of those
//      refusals is right on its own — a band computed from a subset of the
//      group is worse than no band — but each also leaves the previous row
//      in place, and /band went on serving it as the current answer.
//   c) The recompute runs as a background task. If the isolate is torn down
//      first, the answer goes with it.
//
// This project's only budget_aggregates row is a live instance of exactly
// that: it records respondent_count 0 while budget_preferences holds one
// answer for the same trip. /band was reporting "nobody has answered" to a
// group where somebody had.
//
// The fix is a freshness check on the READ path, not another write hook.
// Covering every write path was already the design here, and it is what
// failed: (a), (b) and (c) are each a write path that exists and still leaves
// the cache wrong, and a member being removed from the trip would be a
// fourth. Comparing the cache against its source is a different shape of
// answer — it catches staleness however it arose, including ways nobody has
// thought of yet.
//
// It is cheap because the check needs no decryption. A row count and the
// newest updated_at are plain columns on budget_preferences, and they are
// enough to PROVE disagreement: after a successful recompute the counts match
// and computed_at is newer than every preference that fed it. So one small
// indexed query per read, and the expensive path — decrypt every member's
// preference — runs only when the cache is already known to be wrong.
//
// Recomputing unconditionally on every read was rejected as too big: it pays
// the decrypt cost on reads that are already correct, and it would take /band
// down entirely whenever one member's preference cannot be decrypted, which
// today merely freezes the band.
//
// Either way, the figure is now dated. /band and /check return computedAt and
// a freshness of 'fresh' | 'stale' | 'unknown'. 'stale' means the recompute
// was attempted and did not succeed, so the number really is out of date and
// says so instead of being served as current. 'unknown' means the freshness
// probe itself failed, which is not the same as fresh and is not reported as
// fresh. /check additionally withholds its fitsBand verdict unless the band
// is 'fresh' — a confident "within the group's comfort range" derived from a
// band that no longer matches the answers is precisely the plausible-but-
// untrue output the rest of this file has spent three days removing.
//
// The debounce in PUT /me is deliberately left in place. It exists to stop a
// recompute storm when several members answer at once, and now that the read
// path corrects itself, a skipped recompute is a deferred cost rather than a
// permanently wrong answer. None of this touches the privacy threshold or the
// RLS on budget_aggregates: the recompute happens inside the already-
// authorised handler, and the three-respondent rule below is unchanged.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { requireUser, requireUserOrService, serviceClient, resolvePlatformUserId } from './_shared/auth.ts';
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, DELETE, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json'
};
const MASTER_KEY_HEX = Deno.env.get('BUDGET_MASTER_KEY');
function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for(let i = 0; i < hex.length; i += 2){
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}
async function deriveKey(tripId, memberId) {
  if (!MASTER_KEY_HEX) throw new Error('BUDGET_MASTER_KEY not configured');
  const masterBytes = hexToBytes(MASTER_KEY_HEX);
  const baseKey = await crypto.subtle.importKey('raw', masterBytes, 'HKDF', false, [
    'deriveKey'
  ]);
  const info = new TextEncoder().encode(`budget:${tripId}:${memberId}`);
  const salt = new TextEncoder().encode('travelos-budget-v1');
  return crypto.subtle.deriveKey({
    name: 'HKDF',
    hash: 'SHA-256',
    salt,
    info
  }, baseKey, {
    name: 'AES-GCM',
    length: 256
  }, false, [
    'encrypt',
    'decrypt'
  ]);
}
async function encrypt(plaintext, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({
    name: 'AES-GCM',
    iv
  }, key, encoded);
  return {
    ciphertext: new Uint8Array(ciphertext),
    iv
  };
}
async function decrypt(ciphertext, iv, key) {
  const plaintext = await crypto.subtle.decrypt({
    name: 'AES-GCM',
    iv
  }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}
function packCiphertext(iv, ciphertext) {
  const combined = new Uint8Array(iv.length + ciphertext.length);
  combined.set(iv, 0);
  combined.set(ciphertext, iv.length);
  return btoa(String.fromCharCode(...combined));
}
function unpackCiphertext(packed) {
  const combined = Uint8Array.from(atob(packed), (c)=>c.charCodeAt(0));
  return {
    iv: combined.slice(0, 12),
    ciphertext: combined.slice(12)
  };
}
function roundingStep(value) {
  if (value < 5000) return 500;
  if (value < 20000) return 1000;
  if (value < 100000) return 2500;
  return 5000;
}
function roundUp(value, step) {
  return Math.ceil(value / step) * step;
}
function roundDown(value, step) {
  return Math.floor(value / step) * step;
}
function determineOverlap(bandLow, bandHigh) {
  if (bandLow <= bandHigh) return 'yes';
  if (bandLow > 0 && bandHigh > 0 && bandLow - bandHigh < 0.15 * bandLow) return 'narrow';
  return 'none';
}
function categoryFrequency(prefs, field) {
  const counts = {};
  const total = prefs.length;
  for (const p of prefs){
    const cats = p[field] ?? [];
    for (const cat of cats){
      counts[cat] = (counts[cat] ?? 0) + 1;
    }
  }
  return Object.entries(counts).filter(([, count])=>count / total >= 0.6).map(([cat])=>cat);
}
async function computeAggregate(tripId, svc) {
  try {
    // Fetch all budget_preferences rows for this trip
    const { data: rows, error: fetchErr } = await svc.from('budget_preferences').select('member_id, ciphertext').eq('trip_id', tripId);
    if (fetchErr) {
      console.error('[budget-preferences] computeAggregate fetch error:', fetchErr);
      return;
    }
    const prefs = [];
    let decryptFailures = 0;
    for (const row of rows ?? []){
      try {
        const key = await deriveKey(tripId, row.member_id);
        // ciphertext stored as base64 string in BYTEA column
        const packed = typeof row.ciphertext === 'string' ? row.ciphertext : btoa(String.fromCharCode(...new Uint8Array(row.ciphertext)));
        const { iv, ciphertext } = unpackCiphertext(packed);
        const plaintext = await decrypt(ciphertext, iv, key);
        prefs.push(JSON.parse(plaintext));
      } catch (e) {
        decryptFailures++;
        console.error('[budget-preferences] computeAggregate decrypt error for member:', row.member_id, e);
      }
    }
    // A member whose preference could not be decrypted is NOT a member with no
    // opinion. Computing an intersection over the ones that did decrypt would
    // produce a band that excludes someone who did answer, and publish it as
    // the group's agreed range. Refuse instead.
    if (decryptFailures > 0) {
      console.error('[budget-preferences] computeAggregate aborted:', decryptFailures, 'preferences could not be decrypted for trip', tripId);
      return;
    }
    // Fetch base currency from trips (platform_trips was dropped and merged
    // into trips on 2026-09-17; same column name).
    //
    // DEFECT 2026-09-19 — this was `let baseCurrency = 'USD'` with the lookup
    // only able to overwrite it. An unknown currency was published as USD.
    let baseCurrency = null;
    const { data: tripRow, error: tripErr } = await svc.from('trips').select('base_currency').eq('id', tripId).maybeSingle();
    if (tripErr) {
      console.error('[budget-preferences] computeAggregate trip lookup failed:', tripErr.message);
    }
    if (tripRow?.base_currency) {
      baseCurrency = String(tripRow.base_currency).trim();
    } else {
      console.warn('[budget-preferences] computeAggregate: no base_currency for tripId:', tripId);
    }
    const respondentCount = prefs.length;
    if (respondentCount === 0) {
      const { error } = await svc.from('budget_aggregates').upsert({
        trip_id: tripId,
        respondent_count: 0,
        band: null,
        computed_at: new Date().toISOString()
      }, {
        onConflict: 'trip_id'
      });
      if (error) console.error('[budget-preferences] empty aggregate upsert failed:', error.code, error.message);
      return;
    }
    // DEFECT 2026-09-19 (fabricated data) — the block this replaces was:
    //   const convertedPrefs = prefs.map(p => {
    //     if (p.currency !== baseCurrency) console.warn('FX not implemented, using 1:1');
    //     return p;
    //   });
    // and the code then ran Math.max/Math.min across those raw numbers. Nothing
    // was converted; the warning was the whole of the handling. A band built
    // that way is arithmetic across incomparable units, and it was rounded to a
    // tidy figure and published to the group as the range they all agreed on.
    // Amounts are only produced when every respondent used the same currency.
    const prefCurrencies = Array.from(new Set(prefs.map((p)=>(p.currency || '').trim()).filter(Boolean)));
    const singleCurrency = prefCurrencies.length === 1 ? prefCurrencies[0] : null;
    const currencyMismatch = prefCurrencies.length > 1 ? `Members recorded budgets in different currencies (${prefCurrencies.join(', ')}) and no conversion is available, so no combined amounts can be shown.` : prefCurrencies.length === 0 ? 'No respondent recorded a currency, so no combined amounts can be shown.' : baseCurrency && singleCurrency !== baseCurrency ? `Members budgeted in ${singleCurrency} but this trip's base currency is ${baseCurrency}, and no conversion is available.` : null;
    const amountsAvailable = currencyMismatch === null;
    const bandCurrency = singleCurrency ?? baseCurrency ?? null;
    const commonSplurges = categoryFrequency(prefs, 'splurgeCategories');
    const commonSaves = categoryFrequency(prefs, 'saveCategories');
    let overlap = 'unknown';
    let bandLow = 0;
    let bandHigh = 0;
    let lodgingBand = null;
    if (amountsAvailable) {
      const allLows = prefs.map((p)=>p.comfortPerDay.low);
      const allHighs = prefs.map((p)=>p.comfortPerDay.high);
      const rawBandLow = Math.max(...allLows);
      const rawBandHigh = Math.min(...allHighs);
      overlap = determineOverlap(rawBandLow, rawBandHigh);
      const step = roundingStep(rawBandLow);
      bandLow = roundUp(rawBandLow, step);
      bandHigh = roundDown(rawBandHigh, step);
      // Lodging intersection
      const lodgingPrefs = prefs.filter((p)=>p.lodgingPerNight != null);
      if (lodgingPrefs.length === respondentCount) {
        const lodgeLows = lodgingPrefs.map((p)=>p.lodgingPerNight.low);
        const lodgeHighs = lodgingPrefs.map((p)=>p.lodgingPerNight.high);
        const rawLodgeLow = Math.max(...lodgeLows);
        const rawLodgeHigh = Math.min(...lodgeHighs);
        if (rawLodgeLow <= rawLodgeHigh) {
          const lodgeStep = roundingStep(rawLodgeLow);
          lodgingBand = {
            low: roundUp(rawLodgeLow, lodgeStep),
            high: roundDown(rawLodgeHigh, lodgeStep)
          };
        }
      }
    }
    let band = null;
    if (respondentCount === 1) {
      band = null;
    } else if (respondentCount === 2 || !amountsAvailable) {
      // releasable = false — overlap state and categories only, NO amounts
      band = {
        currency: bandCurrency,
        comfortPerDay: null,
        overlap,
        lodgingPerNight: null,
        commonSplurges,
        commonSaves,
        respondentCount,
        releasable: false,
        amountsUnavailableReason: currencyMismatch ?? 'Amounts are withheld until at least three members have answered.'
      };
    } else {
      // respondentCount >= 3 and one currency: full band
      band = {
        currency: bandCurrency,
        comfortPerDay: {
          low: bandLow,
          high: bandHigh
        },
        overlap,
        lodgingPerNight: lodgingBand,
        commonSplurges,
        commonSaves,
        respondentCount,
        releasable: true,
        amountsUnavailableReason: null
      };
    }
    // Fetch previous aggregate to check for material change
    const { data: prevAgg, error: prevErr } = await svc.from('budget_aggregates').select('band').eq('trip_id', tripId).maybeSingle();
    if (prevErr) {
      console.error('[budget-preferences] previous aggregate read failed:', prevErr.code, prevErr.message);
    }
    const prevBand = prevAgg?.band;
    let materialChange = false;
    if (!prevBand && band) {
      materialChange = true;
    } else if (prevBand && band) {
      if (prevBand.overlap !== band.overlap) {
        materialChange = true;
      } else if (band.releasable && prevBand.releasable && band.comfortPerDay && prevBand.comfortPerDay) {
        const s = roundingStep(band.comfortPerDay.low);
        if (Math.abs(band.comfortPerDay.low - prevBand.comfortPerDay.low) > s || Math.abs(band.comfortPerDay.high - prevBand.comfortPerDay.high) > s) {
          materialChange = true;
        }
      }
    }
    // Upsert aggregate. Previously the error was discarded, so a failed write
    // left a stale band in place while the log line below reported success.
    const { error: aggErr } = await svc.from('budget_aggregates').upsert({
      trip_id: tripId,
      respondent_count: respondentCount,
      band: band ? JSON.parse(JSON.stringify(band)) : null,
      computed_at: new Date().toISOString()
    }, {
      onConflict: 'trip_id'
    });
    if (aggErr) {
      console.error('[budget-preferences] aggregate upsert failed:', aggErr.code, aggErr.message);
      return;
    }
    // Queue notification if material change.
    //
    // DEFECT 2026-09-19 — this read
    //   .insert({...}).onConflict('trip_id').ignore()
    // `onConflict` is not a method on the builder that `.insert()` returns in
    // supabase-js v2 (it belongs on `.upsert()`'s options object), so the line
    // threw TypeError on every material change. The throw landed in this
    // function's own catch, was logged as a generic "computeAggregate error",
    // and no budget-change notification was ever queued for anybody. Replaced
    // with an explicit check-then-insert, which needs no unique constraint.
    if (materialChange) {
      const { data: pending, error: pendingErr } = await svc.from('budget_notification_queue').select('trip_id').eq('trip_id', tripId).is('sent_at', null).limit(1);
      if (pendingErr) {
        console.error('[budget-preferences] notification queue read failed:', pendingErr.code, pendingErr.message);
      } else if (!pending || pending.length === 0) {
        const scheduledFor = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
        const { error: queueErr } = await svc.from('budget_notification_queue').insert({
          trip_id: tripId,
          queued_at: new Date().toISOString(),
          scheduled_for: scheduledFor,
          sent_at: null
        });
        if (queueErr && queueErr.code !== '23505') {
          console.error('[budget-preferences] notification queue insert failed:', queueErr.code, queueErr.message);
        }
      }
    }
    console.log('[budget-preferences] computeAggregate complete tripId:', tripId, 'respondents:', respondentCount, 'overlap:', overlap, 'amounts:', amountsAvailable);
  } catch (e) {
    console.error('[budget-preferences] computeAggregate error:', e);
  }
}
/**
 * Does the stored aggregate still match the preferences it summarises?
 *
 * Deliberately decrypts nothing. The row count and the newest updated_at are
 * plain columns, and a current aggregate has to agree with both:
 * respondent_count is the number of preferences that were read successfully,
 * and computed_at is stamped now() at the end of every successful recompute,
 * so it is newer than every updated_at that fed it.
 *
 * Returns true (disagrees), false (agrees), or null when the comparison could
 * not be made at all — which is NOT the same as agreeing, and is not treated
 * as such by the caller.
 */ async function aggregateDisagreesWithSource(tripId, agg, svc) {
  const { data, error, count } = await svc.from('budget_preferences').select('updated_at', {
    count: 'exact'
  }).eq('trip_id', tripId).order('updated_at', {
    ascending: false
  }).limit(1);
  if (error || count === null || count === undefined) {
    console.error('[budget-preferences] freshness probe failed:', error?.code, error?.message);
    return null;
  }
  if (!agg) return count > 0;
  if (count !== agg.respondent_count) return true;
  const newest = data?.[0]?.updated_at;
  if (newest && new Date(newest).getTime() > new Date(agg.computed_at).getTime()) return true;
  return false;
}
/**
 * The one read path for budget_aggregates. Recomputes first when the stored
 * row can be shown to disagree with budget_preferences, and reports how old
 * the answer is either way.
 *
 * Returns a Response only when the aggregate row itself could not be read.
 */ async function readAggregate(tripId, svc) {
  const load = async ()=>{
    const { data, error } = await svc.from('budget_aggregates').select('*').eq('trip_id', tripId).maybeSingle();
    if (error) {
      console.error('[budget-preferences] aggregate read failed:', error.code, error.message);
      return {
        ok: false
      };
    }
    return {
      ok: true,
      row: data ?? null
    };
  };
  const first = await load();
  if (!first.ok) return jsonResponse({
    error: {
      code: 'INTERNAL',
      message: 'Database error'
    }
  }, 500);
  let row = first.row;
  let disagrees = await aggregateDisagreesWithSource(tripId, row, svc);
  if (disagrees === true) {
    console.log('[budget-preferences] aggregate out of date on read, recomputing tripId:', tripId);
    await computeAggregate(tripId, svc);
    const second = await load();
    if (!second.ok) return jsonResponse({
      error: {
        code: 'INTERNAL',
        message: 'Database error'
      }
    }, 500);
    row = second.row;
    // computeAggregate() returns without writing on a decrypt failure or a
    // failed upsert, so the recompute is re-checked rather than assumed. If it
    // did not take, the caller is told the figure is stale — not handed it as
    // though it were current.
    disagrees = await aggregateDisagreesWithSource(tripId, row, svc);
  }
  const computedAt = row?.computed_at ?? null;
  let freshness = 'fresh';
  let freshnessReason = null;
  if (disagrees === null) {
    freshness = 'unknown';
    freshnessReason = 'Whether this figure is up to date could not be checked, so it may be out of date.';
  } else if (disagrees) {
    freshness = 'stale';
    freshnessReason = computedAt ? `This figure was last computed at ${computedAt} and no longer matches the budget answers on file. Recomputing it did not succeed, so it is out of date.` : 'This figure no longer matches the budget answers on file and could not be recomputed.';
  }
  return {
    respondentCount: row?.respondent_count ?? 0,
    band: row?.band ?? null,
    computedAt,
    freshness,
    freshnessReason
  };
}
/**
 * Resolves the caller's trip_members.id. trip_members.user_id is TEXT (the
 * platform id space), never the raw Supabase auth uuid, so auth.uid() is
 * first bridged via resolvePlatformUserId(). Every failure path returns
 * null (not found) — there is no fallback that treats an unresolved caller
 * as a member.
 */ async function getMemberId(svc, authUserId, tripId) {
  const platformUserId = await resolvePlatformUserId(svc, authUserId);
  if (!platformUserId) return null;
  const { data, error } = await svc.from('trip_members').select('id').eq('user_id', platformUserId).eq('trip_id', tripId).is('removed_at', null).maybeSingle();
  if (error) {
    console.error('[budget-preferences] getMemberId error:', error);
    return null;
  }
  return data?.id ?? null;
}
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: CORS_HEADERS
  });
}
function background(p) {
  const rt = globalThis.EdgeRuntime;
  if (rt && typeof rt.waitUntil === 'function') rt.waitUntil(p);
  else void Promise.resolve(p).catch((e)=>console.error('[budget-preferences] background task failed:', e));
}
Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS
    });
  }
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/budget-preferences/, '');
  const svc = serviceClient();
  // ── GET /budget-preferences/me?tripId= ───────────────────────────────────
  if (req.method === 'GET' && path === '/me') {
    const tripId = url.searchParams.get('tripId');
    if (!tripId) return jsonResponse({
      error: {
        code: 'BAD_REQUEST',
        message: 'tripId required'
      }
    }, 400);
    const auth = await requireUser(req);
    if (auth instanceof Response) return auth;
    const memberId = await getMemberId(svc, auth.userId, tripId);
    if (!memberId) return jsonResponse({
      error: {
        code: 'NOT_FOUND',
        message: 'Trip not found'
      }
    }, 404);
    console.log('[budget-preferences] action: GET_ME tripId:', tripId, 'memberId:', memberId);
    const { data: row, error } = await svc.from('budget_preferences').select('ciphertext').eq('trip_id', tripId).eq('member_id', memberId).maybeSingle();
    if (error) {
      console.error('[budget-preferences] GET_ME fetch error:', error);
      return jsonResponse({
        error: {
          code: 'INTERNAL',
          message: 'Database error'
        }
      }, 500);
    }
    if (!row) return jsonResponse({
      data: null
    });
    try {
      const key = await deriveKey(tripId, memberId);
      const packed = typeof row.ciphertext === 'string' ? row.ciphertext : btoa(String.fromCharCode(...new Uint8Array(row.ciphertext)));
      const { iv, ciphertext } = unpackCiphertext(packed);
      const plaintext = await decrypt(ciphertext, iv, key);
      const preference = JSON.parse(plaintext);
      return jsonResponse({
        data: preference
      });
    } catch (e) {
      console.error('[budget-preferences] DECRYPT_FAILED:', e);
      return jsonResponse({
        error: {
          code: 'DECRYPT_FAILED',
          message: 'Could not read preference'
        }
      }, 500);
    }
  }
  // ── PUT /budget-preferences/me ─────────────────────────────────────────
  if (req.method === 'PUT' && path === '/me') {
    const auth = await requireUser(req);
    if (auth instanceof Response) return auth;
    let body;
    try {
      body = await req.json();
    } catch  {
      return jsonResponse({
        error: {
          code: 'BAD_REQUEST',
          message: 'Invalid JSON body'
        }
      }, 400);
    }
    const { tripId, preference } = body;
    if (!tripId || !preference) return jsonResponse({
      error: {
        code: 'BAD_REQUEST',
        message: 'tripId and preference required'
      }
    }, 400);
    // A preference with no currency cannot be compared with anyone else's, and
    // silently treating it as the trip's base currency is the defect this
    // function had at aggregate level. Require it at the point of entry.
    if (!preference.currency || String(preference.currency).trim().length === 0) {
      return jsonResponse({
        error: {
          code: 'BAD_REQUEST',
          message: 'preference.currency is required'
        }
      }, 400);
    }
    if (!preference.comfortPerDay || typeof preference.comfortPerDay.low !== 'number' || typeof preference.comfortPerDay.high !== 'number') {
      return jsonResponse({
        error: {
          code: 'BAD_REQUEST',
          message: 'preference.comfortPerDay must have numeric low and high'
        }
      }, 400);
    }
    const memberId = await getMemberId(svc, auth.userId, tripId);
    if (!memberId) return jsonResponse({
      error: {
        code: 'NOT_FOUND',
        message: 'Trip not found'
      }
    }, 404);
    console.log('[budget-preferences] action: PUT_ME tripId:', tripId, 'memberId:', memberId);
    const updatedAt = new Date().toISOString();
    const prefWithTs = {
      ...preference,
      updatedAt
    };
    try {
      const key = await deriveKey(tripId, memberId);
      const { ciphertext, iv } = await encrypt(JSON.stringify(prefWithTs), key);
      const packed = packCiphertext(iv, ciphertext);
      const { error: upsertErr } = await svc.from('budget_preferences').upsert({
        trip_id: tripId,
        member_id: memberId,
        ciphertext: packed,
        key_id: 'v1',
        updated_at: updatedAt
      }, {
        onConflict: 'trip_id,member_id'
      });
      if (upsertErr) {
        console.error('[budget-preferences] PUT_ME upsert error:', upsertErr);
        return jsonResponse({
          error: {
            code: 'INTERNAL',
            message: 'Database error'
          }
        }, 500);
      }
    } catch (e) {
      console.error('[budget-preferences] PUT_ME encrypt error:', e);
      return jsonResponse({
        error: {
          code: 'INTERNAL',
          message: 'Encryption failed'
        }
      }, 500);
    }
    // Aggregate with a 2-minute debounce.
    //
    // Previously a bare `(async () => {...})()` with nothing holding the
    // isolate open, so the recompute could be discarded when the response
    // returned and the group's band would silently not reflect this answer.
    background((async ()=>{
      try {
        const { data: agg, error: aggErr } = await svc.from('budget_aggregates').select('computed_at').eq('trip_id', tripId).maybeSingle();
        if (aggErr) {
          console.error('[budget-preferences] debounce read failed:', aggErr.code, aggErr.message);
        }
        if (agg?.computed_at) {
          const computedAt = new Date(agg.computed_at).getTime();
          if (Date.now() - computedAt < 2 * 60 * 1000) {
            console.log('[budget-preferences] skipping aggregate recompute (debounce) tripId:', tripId);
            return;
          }
        }
        await computeAggregate(tripId, svc);
      } catch (e) {
        console.error('[budget-preferences] background aggregate error:', e);
      }
    })());
    return jsonResponse({
      success: true,
      updatedAt
    });
  }
  // ── DELETE /budget-preferences/me?tripId= ─────────────────────────────────
  if (req.method === 'DELETE' && path === '/me') {
    const tripId = url.searchParams.get('tripId');
    if (!tripId) return jsonResponse({
      error: {
        code: 'BAD_REQUEST',
        message: 'tripId required'
      }
    }, 400);
    const auth = await requireUser(req);
    if (auth instanceof Response) return auth;
    const memberId = await getMemberId(svc, auth.userId, tripId);
    if (!memberId) return jsonResponse({
      error: {
        code: 'NOT_FOUND',
        message: 'Trip not found'
      }
    }, 404);
    console.log('[budget-preferences] action: DELETE_ME tripId:', tripId, 'memberId:', memberId);
    const { error: delErr } = await svc.from('budget_preferences').delete().eq('trip_id', tripId).eq('member_id', memberId);
    if (delErr) {
      console.error('[budget-preferences] DELETE_ME error:', delErr);
      return jsonResponse({
        error: {
          code: 'INTERNAL',
          message: 'Database error'
        }
      }, 500);
    }
    // Always recompute on deletion
    await computeAggregate(tripId, svc);
    return jsonResponse({
      success: true
    });
  }
  // ── GET /budget-preferences/band?tripId= ────────────────────────────────
  // Reachable both from an end user and from budget-forecast server-to-
  // server with the service-role key.
  if (req.method === 'GET' && path === '/band') {
    const tripId = url.searchParams.get('tripId');
    if (!tripId) return jsonResponse({
      error: {
        code: 'BAD_REQUEST',
        message: 'tripId required'
      }
    }, 400);
    const caller = await requireUserOrService(req);
    if (caller instanceof Response) return caller;
    if (caller.kind === 'user') {
      const memberId = await getMemberId(svc, caller.userId, tripId);
      if (!memberId) return jsonResponse({
        error: {
          code: 'NOT_FOUND',
          message: 'Trip not found'
        }
      }, 404);
      console.log('[budget-preferences] action: GET_BAND tripId:', tripId, 'memberId:', memberId);
    } else {
      console.log('[budget-preferences] action: GET_BAND (service) tripId:', tripId);
    }
    // Recomputes first if the cache can be shown to disagree with the
    // preferences on file (see the 2026-09-20 note at the top). A missing row
    // comes back as respondentCount 0 / band null, which the threshold below
    // already handles, so the old `if (!agg)` special case is gone.
    const aggRead = await readAggregate(tripId, svc);
    if (aggRead instanceof Response) return aggRead;
    const band = aggRead.band;
    const respondentCount = aggRead.respondentCount;
    // Carried on every shape below: a caller that cannot see how old a figure
    // is has no way to tell a fresh number from one computed weeks ago.
    const provenance = {
      computedAt: aggRead.computedAt,
      freshness: aggRead.freshness,
      ...aggRead.freshnessReason ? {
        freshnessReason: aggRead.freshnessReason
      } : {}
    };
    // Server-side privacy threshold enforcement — unchanged.
    if (respondentCount < 2 || !band) {
      return jsonResponse({
        releasable: false,
        respondentCount,
        overlap: null,
        ...provenance
      });
    }
    if (respondentCount === 2 || !band.releasable) {
      return jsonResponse({
        releasable: false,
        respondentCount,
        overlap: band.overlap,
        commonSplurges: band.commonSplurges,
        commonSaves: band.commonSaves,
        amountsUnavailableReason: band.amountsUnavailableReason ?? null,
        ...provenance
      });
    }
    // respondentCount >= 3 and releasable: full band
    return jsonResponse({
      ...band,
      ...provenance
    });
  }
  // ── POST /budget-preferences/check ───────────────────────────────────────
  if (req.method === 'POST' && path === '/check') {
    const auth = await requireUser(req);
    if (auth instanceof Response) return auth;
    let body;
    try {
      body = await req.json();
    } catch  {
      return jsonResponse({
        error: {
          code: 'BAD_REQUEST',
          message: 'Invalid JSON body'
        }
      }, 400);
    }
    const { tripId, costPerPerson } = body;
    if (!tripId || !costPerPerson) return jsonResponse({
      error: {
        code: 'BAD_REQUEST',
        message: 'tripId and costPerPerson required'
      }
    }, 400);
    const memberId = await getMemberId(svc, auth.userId, tripId);
    if (!memberId) return jsonResponse({
      error: {
        code: 'NOT_FOUND',
        message: 'Trip not found'
      }
    }, 404);
    console.log('[budget-preferences] action: CHECK tripId:', tripId, 'memberId:', memberId);
    // DEFECT 2026-09-19 (fabricated data) — this was `let tripDays = 1` with a
    // lookup that could only raise it. For a trip with no recorded dates, the
    // whole cost of the trip was then compared against ONE DAY of the member's
    // comfort range, and the boolean that came out was returned as a
    // considered verdict. Unknown duration now yields an explicit unknown.
    let tripDays = null;
    const { data: tripRow, error: tripErr } = await svc.from('trips').select('start_date, end_date').eq('id', tripId).maybeSingle();
    if (tripErr) {
      console.error('[budget-preferences] CHECK trip lookup failed:', tripErr.message);
      return jsonResponse({
        error: {
          code: 'INTERNAL',
          message: 'Failed to load trip'
        }
      }, 500);
    }
    if (tripRow?.start_date && tripRow?.end_date) {
      const start = new Date(tripRow.start_date).getTime();
      const end = new Date(tripRow.end_date).getTime();
      const days = Math.ceil((end - start) / (1000 * 60 * 60 * 24));
      if (days > 0) tripDays = days;
    }
    if (tripDays === null) {
      return jsonResponse({
        fitsMe: null,
        fitsBand: 'unknown',
        bandLabel: null,
        reason: 'This trip has no start and end date recorded, so a per-day budget cannot be turned into a trip total.'
      });
    }
    // Fetch member's own preference
    let myPref = null;
    const { data: prefRow, error: prefErr } = await svc.from('budget_preferences').select('ciphertext').eq('trip_id', tripId).eq('member_id', memberId).maybeSingle();
    if (prefErr) {
      console.error('[budget-preferences] CHECK preference read failed:', prefErr.code, prefErr.message);
      return jsonResponse({
        error: {
          code: 'INTERNAL',
          message: 'Failed to load your budget preference'
        }
      }, 500);
    }
    if (prefRow) {
      try {
        const key = await deriveKey(tripId, memberId);
        const packed = typeof prefRow.ciphertext === 'string' ? prefRow.ciphertext : btoa(String.fromCharCode(...new Uint8Array(prefRow.ciphertext)));
        const { iv, ciphertext } = unpackCiphertext(packed);
        const plaintext = await decrypt(ciphertext, iv, key);
        myPref = JSON.parse(plaintext);
      } catch (e) {
        console.error('[budget-preferences] CHECK decrypt error:', e);
        return jsonResponse({
          error: {
            code: 'DECRYPT_FAILED',
            message: 'Could not read preference'
          }
        }, 500);
      }
    }
    // Fetch band through the same freshness-checked path as /band. A verdict
    // is only as current as the band it was computed from.
    const aggRead = await readAggregate(tripId, svc);
    if (aggRead instanceof Response) {
      return jsonResponse({
        error: {
          code: 'INTERNAL',
          message: 'Failed to load the group band'
        }
      }, 500);
    }
    const band = aggRead.band;
    const bandComputedAt = aggRead.computedAt;
    const bandFreshness = aggRead.freshness;
    const bandFreshnessReason = aggRead.freshnessReason;
    const amount = costPerPerson.amountMinor;
    const costCurrency = (costPerPerson.currency || '').trim();
    // DEFECT 2026-09-19 (fabricated data) — `let fitsMe = false` meant a member
    // who had never recorded a budget was told the cost did NOT fit theirs.
    // "We don't know your budget" and "this is over your budget" are different
    // answers and only one of them was ever given. Also: costPerPerson.currency
    // was accepted and then completely ignored, so a cost in one currency was
    // compared against a comfort range in another and the comparison returned a
    // confident true/false.
    let fitsMe = null;
    let fitsMeReason = null;
    if (!myPref) {
      fitsMeReason = 'You have not recorded a budget preference for this trip.';
    } else if (costCurrency && myPref.currency && costCurrency !== myPref.currency) {
      fitsMeReason = `The cost is in ${costCurrency} but your budget is in ${myPref.currency}, and no conversion is available.`;
    } else {
      const myBudgetTotal = myPref.comfortPerDay.high * tripDays;
      fitsMe = amount <= myBudgetTotal;
    }
    // fitsBand
    let fitsBand = 'unknown';
    let bandLabel = null;
    let fitsBandReason = null;
    // A band we cannot show to be current produces no verdict. "Within the
    // group's comfort range", said of a band that no longer matches the
    // answers on file, is a wrong answer delivered confidently.
    if (bandFreshness !== 'fresh') {
      fitsBandReason = bandFreshnessReason ?? 'The group band could not be confirmed up to date, so it is not compared against.';
    } else if (band?.releasable && band.comfortPerDay) {
      if (costCurrency && band.currency && costCurrency !== band.currency) {
        fitsBandReason = `The cost is in ${costCurrency} but the group band is in ${band.currency}, and no conversion is available.`;
      } else {
        const bandTotal = {
          low: band.comfortPerDay.low * tripDays,
          high: band.comfortPerDay.high * tripDays
        };
        if (amount < bandTotal.low) {
          fitsBand = 'below';
          bandLabel = "Below the group's comfort range";
        } else if (amount > bandTotal.high) {
          fitsBand = 'above';
          bandLabel = "Above the group's comfort range";
        } else {
          fitsBand = 'within';
          bandLabel = "Within the group's comfort range";
        }
      }
    } else {
      fitsBandReason = band?.amountsUnavailableReason ?? 'The group band is not available yet.';
    }
    return jsonResponse({
      fitsMe,
      fitsMeReason,
      fitsBand,
      bandLabel,
      fitsBandReason,
      bandComputedAt,
      bandFreshness,
      tripDays
    });
  }
  return jsonResponse({
    error: {
      code: 'NOT_FOUND',
      message: 'Route not found'
    }
  }, 404);
});

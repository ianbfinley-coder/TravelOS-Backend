// SECURITY 2026-09-16 — Authorization fix (see SECURITY_AUDIT_2026-09-16).
//
// What was wrong:
//   - The `events` action performed no authentication check at all: any
//     caller, with no Authorization header and no service key, could pass
//     any `trip_id` and read that trip's monitoring events.
//   - The `acknowledge_event` action required *a* caller to be authenticated
//     (401 if no user), but never checked that the `event_id` in the
//     request body actually belonged to that caller. Any authenticated
//     user could mark ANY event on ANY trip as PROCESSED just by supplying
//     its id — an IDOR, not a missing-auth bug.
//
// What an attacker could do:
//   - Read another user's flight/hotel/disruption-day monitoring events
//     for any trip, with zero credentials, by calling
//     `?action=events&trip_id=<guessed-or-observed-id>`.
//   - Silently suppress another user's active monitoring alerts by
//     acknowledging their events out from under them, using nothing more
//     than their own valid login plus an enumerated/observed event_id.
//
// The gate now in place:
//   - `requireUserOrService` runs before any database work in this
//     action-based route group (the original monitoring-api routes below
//     the /api-opt/ and /qa/ groups, which already have their own gates
//     via checkApiOptAuth / checkServiceKey and are untouched here). A
//     caller must present either the service-role key as a Bearer token
//     (the monitoring pipeline — passed through unchanged) or a valid
//     Supabase user JWT (the dashboard client).
//   - For a JWT caller, `events` now requires ownership of `trip_id`
//     (`requireTripOwner`, checked against trips.user_id, a uuid compared
//     directly to auth.uid()) before the query runs.
//   - For a JWT caller, `acknowledge_event` now resolves the event's
//     `trip_id` first (monitoring_events.trip_id is a uuid referencing
//     trips.id) and confirms the caller owns that trip before the update
//     is issued. A missing event or one owned by someone else returns 404
//     (not 403), so event ids cannot be enumerated by status code.
//   - `add_entity`, `update_entity`, and `trip_monitoring` are unchanged in
//     behavior for an authenticated user (they already scoped by
//     `userId`); they now get that `userId` from the shared gate instead
//     of an ad hoc, unauthenticated-tolerant token check.
// ════════════════════════════════════════════════════════════════════════
// CROSS-FUNCTION CALLS + COLUMN AUDIT + ERROR LEAK — 2026-09-19
//
// A. THE CANARY SWEEP COULD NOT FAIL. (runCanarySweep, POST /qa/canary/run)
//    Four independent defects, and the combination meant it reported
//    `{passed: true}` on every run while testing nothing at all:
//      1. The canary trip was never created. The insert set `notes`, which is
//         not a column on `trips` (verified against information_schema: the
//         table has id, user_id, name, destination, start_date, end_date,
//         status, primary_tz, base_currency, version, archived_at, created_at,
//         updated_at). It also omitted `user_id`, which is `uuid NOT NULL`
//         with no default. Either one fails the insert. The result was
//         discarded by a bare `catch (_) {}` — and supabase-js RETURNS errors
//         rather than throwing, so even that catch never ran.
//      2. `/share-trip` is not a deployed function. Every probe of it 404'd.
//      3. No Authorization header was sent at all. `/generate-offline-pack`,
//         `/recommendations` and `/group-chat` all require auth, so every
//         probe of them was a 401.
//      4. A 401/404 body obviously never contains the canary string, so
//         `passed` stayed true. A monitor that cannot fail is worse than no
//         monitor: it manufactures assurance.
//    NOW: the route requires `user_id` in the body (same precedent as
//    /qa/fixtures/generate, which is also service-key-only and has no
//    authenticated user to attribute a trip to); the canary strings are
//    carried in `trips.name`, a column that exists; the insert error is
//    checked and aborts the sweep with a real error instead of sweeping
//    nothing; `/share-trip` is dropped because it does not exist; the
//    service-role key is sent as the Authorization bearer; and — critically —
//    each probe is classified three ways, not two:
//        2xx                      → the probe RAN. pass/fail on body contents.
//        401/403/404/other/timeout→ UNKNOWN. The probe did not run.
//    `canary_test_log.passed` is `boolean NOT NULL`, so an UNKNOWN cannot be
//    stored as a third value without a migration. It is therefore stored as
//    `passed: false` with `found_in` set to 'UNKNOWN: <reason>'. Read the log
//    as: found_in NULL → genuine pass; found_in starting 'UNKNOWN' → probe did
//    not run; anything else → the named endpoint leaked the canary. The HTTP
//    response carries the three lists separately and a top-level `status` of
//    'pass' | 'fail' | 'unknown'. It reports 'pass' only when at least one
//    probe actually ran and none leaked.
//
// B. THE SLO AVAILABILITY PROBE COULD NOT FAIL EITHER. (computeSLO)
//    `pingFns` included `trip-hub`, which is not a deployed function, and the
//    probes sent no Authorization header while counting any `status < 500` as
//    reachable. A 404 for a function that does not exist, and a 401 from the
//    platform gateway for a function whose body never even booted, both scored
//    as "available" — so api_availability_pct was pinned at 100 forever.
//    NOW: `trip-hub` is replaced with `unified-alerts` (deployed); the
//    service-role key is sent so requests reach the function body instead of
//    stopping at the platform JWT gate; 404 is counted as MISSING, not
//    reachable; 5xx and transport errors are counted as unreachable; and the
//    metric reports `missing` endpoints by name and breaches when any is
//    missing.
//
// C. FIXTURE TAGGING USED A COLUMN THAT DOES NOT EXIST. generateFixture's
//    existence check (`.eq('notes', tag)`) and cleanupFixture's
//    (`.like('notes', ...)`) both filtered `trips.notes`. A filter on a
//    missing column is a 42703 that PostgREST applies to the WHOLE query, so
//    the cache check silently never matched (re-generating fixtures instead of
//    returning the cached one) and `POST /qa/fixtures/cleanup` by fixture name
//    deleted nothing while reporting `{deleted: 0}`. Both now key off
//    `trips.name`, which already carries `[TEST] <fixture> #<seed>`.
//
// D. Q2.13 ERROR LEAK. Five sites returned raw internal error strings to the
//    caller: the /api-opt/ and /qa/ catch-alls put `err.message` in the
//    response body, and three action handlers returned `error.message` from
//    PostgREST. Those strings carry table names, column names, constraint
//    names and SQL snippets. All five now log the detail and return a generic
//    message plus a stable code.
//
// E. FABRICATED MONITORING STATE. `action=trip_monitoring` returned a
//    hard-coded `mockEntities` array (Flight AA123, Hotel Check-in, Car
//    Rental) and a hard-coded `providers` array whenever the real query
//    returned nothing — including when it returned nothing because the caller
//    was a service-role caller with no `userId`, which is the pipeline's
//    normal case. Callers could not tell invented monitoring from real
//    monitoring. Both are removed: the response now returns what is actually
//    in `monitored_entities`, an empty list when there is nothing, and
//    `overall_status: 'NOT_MONITORED'` rather than a hard-coded 'ACTIVE'.
//
// F. ERROR-VS-ABSENCE. The two /api-opt/alerts/* routes used
//    `if (error || !data) return 404`, reporting a broken query as "not
//    found". PostgREST signals "no rows" from `.single()` as PGRST116
//    specifically; every other error is now a 500.
// ════════════════════════════════════════════════════════════════════════
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { requireUserOrService, requireTripOwner } from './_shared/auth.ts';
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-service-key'
};
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const SERVICE_KEY = Deno.env.get('SERVICE_KEY') ?? SUPABASE_SERVICE_ROLE_KEY;
function getClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
}
function json(data, status = 200, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
      ...extraHeaders ?? {}
    }
  });
}
// Hoisted 2026-09-19 — previously declared inside the /qa/fixtures/generate
// block; the /qa/canary/run route needs it too.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * PostgREST reports "query returned no rows" for `.single()` as PGRST116.
 * Any other error is a genuine failure and must not be dressed up as a 404.
 */ function isNoRows(error) {
  return !!error && error.code === 'PGRST116';
}
// ── Seeded PRNG ───────────────────────────────────────────────────────────────────
function mulberry32(seed) {
  return function() {
    seed |= 0;
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function seededULID(rng, prefix) {
  const chars = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let id = prefix + '_';
  for(let i = 0; i < 16; i++)id += chars[Math.floor(rng() * 32)];
  return id;
}
function pick(arr, rng) {
  return arr[Math.floor(rng() * arr.length)];
}
function randInt(min, max, rng) {
  return Math.floor(rng() * (max - min + 1)) + min;
}
function randFloat(min, max, rng) {
  return parseFloat((rng() * (max - min) + min).toFixed(2));
}
function futureDate(daysFromNow) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().split('T')[0];
}
// ── Service-key guard ──────────────────────────────────────────────────────
function checkServiceKey(req) {
  const key = req.headers.get('x-service-key');
  if (!key || key !== SERVICE_KEY) {
    return json({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid or missing x-service-key header'
      }
    }, 401);
  }
  return null;
}
// ── Auth: service-key OR valid JWT ────────────────────────────────────────────
async function checkApiOptAuth(req, supabase) {
  const serviceKey = req.headers.get('x-service-key');
  if (serviceKey && serviceKey === SERVICE_KEY) return null;
  const authHeader = req.headers.get('Authorization');
  if (authHeader) {
    const token = authHeader.replace('Bearer ', '');
    const { data: { user } } = await supabase.auth.getUser(token);
    if (user) return null;
  }
  return json({
    error: {
      code: 'UNAUTHORIZED',
      message: 'Provide x-service-key header or valid JWT'
    }
  }, 401);
}
// ── ID generators ──────────────────────────────────────────────────────────
function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').toUpperCase()}`;
}
// ── API Optimization constants ──────────────────────────────────────────────
const CACHE_TTLS = {
  openaq: 3600,
  google_places: 86400,
  tripadvisor: 86400,
  flightaware: 1800,
  ticketmaster: 21600,
  mapbox: 604800
};
const SERVICE_COSTS = {
  openaq: 0.001,
  google_places: 0.017,
  tripadvisor: 0.005,
  flightaware: 0.010,
  ticketmaster: 0.002,
  mapbox: 0.005
};
const DAILY_THRESHOLDS = {
  openaq: 10,
  google_places: 100,
  flightaware: 200,
  mapbox: 50,
  tripadvisor: 10,
  ticketmaster: 10
};
const MONTHLY_BUDGET = 500;
const BUDGET_THRESHOLDS = {
  warning: 0.50,
  escalation: 0.75,
  strict: 0.90,
  disable: 1.00
};
const RATE_LIMITS = {
  global: {
    free: 100,
    premium: 300,
    windowMinutes: 15
  },
  strict: {
    perIp: 10,
    perUser: 50,
    windowMinutes: 1
  },
  quota: {
    free: 50,
    pro: 1000,
    enterprise: Infinity
  }
};
// ── Params hash helper ───────────────────────────────────────────────────────
async function hashParams(params) {
  const str = JSON.stringify(params ?? {});
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map((b)=>b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}
// ── Budget status helper ────────────────────────────────────────────────────
function getBudgetStatus(pct) {
  if (pct >= BUDGET_THRESHOLDS.disable) return 'exceeded';
  if (pct >= BUDGET_THRESHOLDS.strict) return 'strict';
  if (pct >= BUDGET_THRESHOLDS.escalation) return 'escalation';
  if (pct >= BUDGET_THRESHOLDS.warning) return 'warning';
  return 'ok';
}
// ── Fixture generator ────────────────────────────────────────────────────
async function generateFixture(supabase, fixture, seed, userId) {
  const rng = mulberry32(seed);
  // COLUMN FIX 2026-09-19 (C) — `trips.notes` does not exist, so the old
  // `.eq('notes', tag)` was a 42703 that voided this whole query and the cache
  // check never matched. `trips.name` already carries the fixture tag and is a
  // real column, so it is the key now. Kept byte-identical to the `name` the
  // insert below writes.
  const tripName = `[TEST] ${fixture} #${seed}`;
  const { data: existing, error: existingErr } = await supabase.from('trips').select('id').eq('name', tripName).maybeSingle();
  if (existingErr) {
    console.error('[monitoring-api] fixture cache lookup failed:', existingErr.message);
    return {
      error: 'fixture cache lookup failed',
      detail: existingErr.message
    };
  }
  if (existing) {
    return {
      tripId: existing.id,
      memberIds: [],
      stats: {
        items: 0,
        reservations: 0,
        expenses: 0,
        polls: 0
      },
      cached: true
    };
  }
  // trips.id is uuid (platform_trips was dropped and merged into trips on
  // 2026-09-17). seededULID() mints a `trip_<16 base32 chars>` TEXT id that
  // no longer fits the column, so the trip id alone is minted with
  // crypto.randomUUID() instead. Every other id below still comes from
  // seededULID() and stays deterministic from `seed`; only the trip id is
  // not reproducible run-to-run anymore.
  const tripId = crypto.randomUUID();
  const destinations = {
    solo_city_break: [
      {
        city: 'Lisbon',
        country: 'PT'
      }
    ],
    friends_multi_city: [
      {
        city: 'Lisbon',
        country: 'PT'
      },
      {
        city: 'Porto',
        country: 'PT'
      },
      {
        city: 'Madrid',
        country: 'ES'
      }
    ],
    family_long_haul: [
      {
        city: 'Tokyo',
        country: 'JP'
      },
      {
        city: 'Kyoto',
        country: 'JP'
      }
    ],
    disruption_day: [
      {
        city: 'Lisbon',
        country: 'PT'
      },
      {
        city: 'Porto',
        country: 'PT'
      },
      {
        city: 'Madrid',
        country: 'ES'
      }
    ],
    huge_trip: [
      {
        city: 'World Tour',
        country: 'XX'
      }
    ]
  };
  const dest = destinations[fixture] ?? destinations['solo_city_break'];
  const startOffset = randInt(10, 30, rng);
  const cfg = {
    solo_city_break: {
      memberCount: 1,
      days: 3,
      itemCount: 8,
      expenseCount: 12,
      pollCount: 0,
      resCount: 3
    },
    friends_multi_city: {
      memberCount: 6,
      days: 7,
      itemCount: 45,
      expenseCount: 120,
      pollCount: 6,
      resCount: 4
    },
    family_long_haul: {
      memberCount: 4,
      days: 14,
      itemCount: 30,
      expenseCount: 60,
      pollCount: 2,
      resCount: 3
    },
    disruption_day: {
      memberCount: 6,
      days: 7,
      itemCount: 45,
      expenseCount: 120,
      pollCount: 6,
      resCount: 4
    },
    huge_trip: {
      memberCount: 4,
      days: 60,
      itemCount: 1500,
      expenseCount: 800,
      pollCount: 10,
      resCount: 20
    }
  };
  const c = cfg[fixture] ?? cfg['solo_city_break'];
  // BUGFIX 2026-09-18 — trips.user_id is `uuid NOT NULL` with no default.
  // This insert never supplied it, so every fixture generation failed with
  // a not-null violation (and the error was discarded — see below — so the
  // route still returned 201 with fabricated stats). /qa/fixtures/generate
  // is service-role-only (checkServiceKey, above); there is no authenticated
  // user on this route to attribute the trip to, so the caller must supply
  // the owning user's auth uuid explicitly in the request body. See the
  // caller in the /qa/ route group for the validation.
  const { error: tripErr } = await supabase.from('trips').insert({
    id: tripId,
    user_id: userId,
    name: tripName,
    destination: dest[0].city,
    start_date: futureDate(startOffset),
    end_date: futureDate(startOffset + c.days),
    // COLUMN FIX 2026-09-19 (C) — `notes` removed: not a column on `trips`.
    // The tag lives in `name`.
    status: 'planning'
  });
  if (tripErr) return {
    error: 'fixture trip insert failed',
    detail: tripErr.message
  };
  const memberIds = [];
  const roles = [
    'owner',
    'organizer',
    'member',
    'member',
    'viewer',
    'guest'
  ];
  for(let i = 0; i < c.memberCount; i++){
    const memberId = seededULID(rng, 'mbr');
    memberIds.push(memberId);
    const isPlaceholder = i === c.memberCount - 1 && c.memberCount > 4;
    await supabase.from('trip_members').insert({
      id: memberId,
      trip_id: tripId,
      role: roles[Math.min(i, roles.length - 1)],
      display_name: isPlaceholder ? `Placeholder ${i}` : `TestUser${i}_${seed}`,
      is_placeholder: isPlaceholder,
      joined_at: new Date().toISOString()
    });
  }
  const itemTypes = [
    'flight',
    'hotel',
    'activity',
    'restaurant',
    'transport',
    'free_time'
  ];
  for(let i = 0; i < c.itemCount; i++){
    const dayOffset = i % c.days;
    const destIdx = Math.floor(i / c.itemCount * dest.length);
    // BUGFIX 2026-09-18 — itinerary_items.id is uuid (the table was created
    // fresh in the trip-identity migration and never existed before). The
    // prefixed TEXT id from seededULID() no longer fits the column, so this
    // axis mints with crypto.randomUUID() like the trip id above; every
    // other id in this function still comes from seededULID() and stays
    // deterministic from `seed`.
    const { error: itemErr } = await supabase.from('itinerary_items').insert({
      id: crypto.randomUUID(),
      trip_id: tripId,
      title: `${pick(itemTypes, rng)} item ${i + 1}`,
      type: pick(itemTypes, rng),
      start_time: new Date(Date.now() + (startOffset + dayOffset) * 86400000).toISOString(),
      location: dest[destIdx]?.city ?? dest[0].city,
      notes: `Auto-generated item ${i + 1} for fixture ${fixture}`,
      status: pick([
        'confirmed',
        'tentative',
        'pending'
      ], rng)
    });
    if (itemErr) console.error('[monitoring-api] itinerary_items insert failed', itemErr);
  }
  const resTypes = [
    'flight',
    'hotel',
    'car_rental',
    'activity'
  ];
  for(let i = 0; i < c.resCount; i++){
    const resType = i === 0 ? 'flight' : i === 1 ? 'hotel' : pick(resTypes, rng);
    await supabase.from('reservations').insert({
      id: seededULID(rng, 'res'),
      trip_id: tripId,
      type: resType,
      title: `${resType} reservation ${i + 1}`,
      confirmation_number: `CONF${seed}${i.toString().padStart(4, '0')}`,
      status: 'confirmed',
      check_in: futureDate(startOffset + i),
      check_out: futureDate(startOffset + i + 2),
      total_cost: randFloat(50, 2000, rng),
      currency: pick([
        'EUR',
        'USD',
        'JPY'
      ], rng)
    });
  }
  const expCats = [
    'transport',
    'accommodation',
    'food',
    'activities',
    'shopping',
    'other'
  ];
  for(let i = 0; i < c.expenseCount; i++){
    const payerId = memberIds[Math.floor(rng() * memberIds.length)];
    await supabase.from('expenses').insert({
      id: seededULID(rng, 'exp'),
      trip_id: tripId,
      paid_by: payerId,
      amount: randFloat(5, 500, rng),
      currency: pick([
        'EUR',
        'USD'
      ], rng),
      category: pick(expCats, rng),
      description: `Expense ${i + 1} - ${pick(expCats, rng)}`,
      expense_date: futureDate(startOffset + i % c.days),
      split_type: pick([
        'equal',
        'custom',
        'payer_only'
      ], rng)
    });
  }
  for(let i = 0; i < c.pollCount; i++){
    await supabase.from('polls_v2').insert({
      id: seededULID(rng, 'poll'),
      trip_id: tripId,
      question: `Test poll ${i + 1}: Which option do you prefer?`,
      kind: pick([
        'single',
        'multi',
        'ranked'
      ], rng),
      options: JSON.stringify([
        'Option A',
        'Option B',
        'Option C'
      ]),
      status: 'open',
      created_by: memberIds[0]
    });
  }
  if (fixture === 'disruption_day') {
    await supabase.from('disruption_cases').insert({
      id: seededULID(rng, 'dis'),
      trip_id: tripId,
      kind: 'flight_delay',
      confidence: 'predicted',
      title: 'Flight delay predicted',
      description: 'Outbound flight TP1234 predicted to be delayed by 2h due to ATC restrictions',
      severity: 'medium',
      status: 'open'
    });
  }
  if (fixture === 'family_long_haul') {
    for(let i = 2; i < 4; i++){
      if (memberIds[i]) {
        await supabase.from('trip_members').update({
          is_dependent: true
        }).eq('id', memberIds[i]);
      }
    }
  }
  return {
    tripId,
    memberIds,
    stats: {
      items: c.itemCount,
      reservations: c.resCount,
      expenses: c.expenseCount,
      polls: c.pollCount
    }
  };
}
async function cleanupFixture(supabase, tripId, fixture) {
  if (tripId) {
    await supabase.from('trips').delete().eq('id', tripId);
    return {
      deleted: 1
    };
  }
  if (fixture) {
    // COLUMN FIX 2026-09-19 (C) — was `.like('notes', ...)`, a 42703 on a
    // column `trips` does not have, so this matched nothing and reported
    // `{deleted: 0}` while leaving every fixture trip in place. Matches the
    // `[TEST] <fixture> #<seed>` name generateFixture writes.
    const { data, error } = await supabase.from('trips').select('id').like('name', `[TEST] ${fixture} #%`);
    if (error) {
      console.error('[monitoring-api] fixture cleanup lookup failed:', error.message);
      return {
        deleted: 0,
        error: 'fixture cleanup lookup failed'
      };
    }
    const ids = (data ?? []).map((r)=>r.id);
    if (ids.length > 0) await supabase.from('trips').delete().in('id', ids);
    return {
      deleted: ids.length
    };
  }
  return {
    deleted: 0
  };
}
// ── Canary sweep ──────────────────────────────────────────────────────────
const CANARY_VALUES = [
  {
    kind: 'budget_preference',
    value: 'CANARY_BUDGET_12345'
  },
  {
    kind: 'passport_number',
    value: 'CANARY_PASSPORT_AB123456'
  },
  {
    kind: 'private_note',
    value: 'CANARY_PRIVATE_NOTE_XYZ'
  },
  {
    kind: 'medical_info',
    value: 'CANARY_MEDICAL_CONDITION'
  },
  {
    kind: 'access_code',
    value: 'CANARY_WIFI_PASSWORD'
  }
];
// See CROSS-FUNCTION CALLS 2026-09-19 (A) at the top of this file. This sweep
// used to be incapable of failing: the canary trip was never created (bad
// column + missing NOT NULL user_id, both discarded), one probe target did not
// exist, and no probe carried a credential, so every request was a 401 or 404
// whose body could not possibly contain a canary string.
//
// `userId` is required now: `trips.user_id` is uuid NOT NULL and this route is
// service-key-only, so there is no authenticated user to attribute the canary
// trip to and the caller must name one.
async function runCanarySweep(supabase, userId) {
  const baseUrl = SUPABASE_URL + '/functions/v1';
  const failures = [];
  const unknowns = [];
  const logEntries = [];
  const canaryTripId = crypto.randomUUID();
  // The canary strings ride in `name`. `trips` has no `notes` column, which is
  // what the old code used, and a 42703 voids the whole insert.
  const { error: canaryInsertErr } = await supabase.from('trips').insert({
    id: canaryTripId,
    user_id: userId,
    name: `[CANARY] ${CANARY_VALUES.map((c)=>c.value).join(' ')}`,
    destination: 'Canary Island',
    start_date: futureDate(30),
    end_date: futureDate(37),
    status: 'planning'
  });
  if (canaryInsertErr) {
    // Without the trip there is nothing to leak, so every probe would
    // trivially "pass". Refuse to report a pass we did not earn.
    console.error('[monitoring-api] canary trip insert failed:', canaryInsertErr.message);
    return {
      status: 'unknown',
      passed: false,
      failures: [],
      unknowns: [
        'canary trip could not be created; no probe was meaningful'
      ],
      probes_run: 0,
      error: 'canary trip could not be created'
    };
  }
  // Only endpoints that are actually deployed. `/share-trip` was in this list
  // and has never existed in this project.
  const probeEndpoints = [
    {
      name: 'export_trip',
      path: '/generate-offline-pack'
    },
    {
      name: 'recommendations',
      path: '/recommendations'
    },
    {
      name: 'group_chat',
      path: '/group-chat'
    }
  ];
  let probesRun = 0;
  for (const canary of CANARY_VALUES){
    for (const endpoint of probeEndpoints){
      const testName = `${canary.kind}_via_${endpoint.name}`;
      let passed = true;
      let foundIn = null;
      try {
        const url = `${baseUrl}${endpoint.path}?trip_id=${canaryTripId}`;
        const resp = await fetch(url, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            // These endpoints all require auth. With no header the probe was a
            // 401 and the sweep learned nothing.
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
          },
          signal: AbortSignal.timeout(5000)
        });
        const text = await resp.text();
        if (!resp.ok) {
          // The probe did not run. This is NOT a pass. canary_test_log.passed
          // is boolean NOT NULL, so 'unknown' is encoded as passed=false with
          // an explicit UNKNOWN marker in found_in.
          passed = false;
          foundIn = `UNKNOWN: probe did not run (HTTP ${resp.status})`;
          unknowns.push(`${canary.kind} via ${endpoint.name}: HTTP ${resp.status}`);
        } else {
          probesRun++;
          if (text.includes(canary.value)) {
            passed = false;
            foundIn = endpoint.name;
            failures.push(`${canary.kind} leaked via ${endpoint.name}`);
          }
        }
      } catch (e) {
        // A timeout or transport error is not "safe" either — it is unknown.
        passed = false;
        const reason = e instanceof Error ? e.message : String(e);
        foundIn = `UNKNOWN: probe did not run (${reason.slice(0, 80)})`;
        unknowns.push(`${canary.kind} via ${endpoint.name}: ${reason.slice(0, 80)}`);
      }
      logEntries.push({
        id: `canary_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        test_name: testName,
        canary_kind: canary.kind,
        found_in: foundIn,
        passed
      });
    }
  }
  if (logEntries.length > 0) {
    const { error: logErr } = await supabase.from('canary_test_log').insert(logEntries);
    if (logErr) console.error('[monitoring-api] canary_test_log insert failed:', logErr.message);
  }
  const { error: cleanupErr } = await supabase.from('trips').delete().eq('id', canaryTripId);
  if (cleanupErr) console.error('[monitoring-api] canary trip cleanup failed:', cleanupErr.message);
  // 'pass' requires that at least one probe actually ran and none leaked.
  const status = failures.length > 0 ? 'fail' : probesRun === 0 ? 'unknown' : unknowns.length > 0 ? 'unknown' : 'pass';
  return {
    status,
    passed: status === 'pass',
    failures,
    unknowns,
    probes_run: probesRun
  };
}
const AUTH_MATRIX = {
  owner: {
    expectedOnWrite: 200,
    expectedOnRead: 200
  },
  organizer: {
    expectedOnWrite: 200,
    expectedOnRead: 200
  },
  member: {
    expectedOnWrite: 200,
    expectedOnRead: 200
  },
  viewer: {
    expectedOnWrite: 403,
    expectedOnRead: 200
  },
  guest: {
    expectedOnWrite: 403,
    expectedOnRead: 200
  },
  non_member: {
    expectedOnWrite: 404,
    expectedOnRead: 404
  },
  anonymous: {
    expectedOnWrite: 401,
    expectedOnRead: 401
  }
};
async function runAuthSweep(tripId, routes) {
  const failures = [];
  const actors = [
    'owner',
    'organizer',
    'member',
    'viewer',
    'guest',
    'non_member',
    'anonymous'
  ];
  const baseUrl = SUPABASE_URL + '/functions/v1';
  for (const route of routes){
    for (const actor of actors){
      const matrix = AUTH_MATRIX[actor];
      const isWrite = ![
        'GET',
        'HEAD',
        'OPTIONS'
      ].includes(route.method.toUpperCase());
      const expected = isWrite ? matrix.expectedOnWrite : matrix.expectedOnRead;
      const acceptable = actor === 'non_member' ? [
        404,
        401,
        403
      ] : actor === 'anonymous' ? [
        401,
        403
      ] : [
        expected,
        200,
        201,
        204
      ];
      try {
        const url = `${baseUrl}${route.path}`.replace(':tripId', tripId).replace('{tripId}', tripId);
        const headers = {
          'Content-Type': 'application/json'
        };
        if (actor !== 'anonymous') {
          headers['x-test-actor'] = actor;
          headers['x-test-trip-id'] = tripId;
        }
        const resp = await fetch(url, {
          method: route.method,
          headers,
          body: isWrite && route.body ? JSON.stringify(route.body) : undefined,
          signal: AbortSignal.timeout(5000)
        });
        if (!acceptable.includes(resp.status)) {
          failures.push({
            route: `${route.method} ${route.path}`,
            actor,
            expected,
            got: resp.status
          });
        }
      } catch (_) {}
    }
  }
  return {
    passed: failures.length === 0,
    failures
  };
}
// ── SLO computation ────────────────────────────────────────────────────────
async function computeSLO(supabase) {
  const metrics = [];
  const baseUrl = SUPABASE_URL + '/functions/v1';
  const { count: outboxDepth } = await supabase.from('outbox_items').select('*', {
    count: 'exact',
    head: true
  }).eq('status', 'pending');
  const qd = outboxDepth ?? 0;
  metrics.push({
    metric: 'outbox_queue_depth',
    value: qd,
    threshold: 500,
    status: qd < 100 ? 'ok' : qd < 500 ? 'warning' : 'breach'
  });
  const { count: flagCount } = await supabase.from('feature_flags').select('*', {
    count: 'exact',
    head: true
  }).eq('enabled', true);
  metrics.push({
    metric: 'feature_flags_enabled',
    value: flagCount ?? 0,
    threshold: 17,
    status: (flagCount ?? 0) >= 17 ? 'ok' : 'warning'
  });
  const { count: totalItems } = await supabase.from('release_checklist').select('*', {
    count: 'exact',
    head: true
  });
  const { count: passItems } = await supabase.from('release_checklist').select('*', {
    count: 'exact',
    head: true
  }).eq('status', 'pass');
  const pct = totalItems ? Math.round((passItems ?? 0) / totalItems * 100) : 0;
  metrics.push({
    metric: 'release_checklist_pct',
    value: pct,
    threshold: 100,
    status: pct === 100 ? 'ok' : pct >= 80 ? 'warning' : 'breach'
  });
  // See CROSS-FUNCTION CALLS 2026-09-19 (B) at the top of this file.
  // `trip-hub` was in this list and is not a deployed function, and the probes
  // carried no credential, so a 404 for a nonexistent function and a 401 from
  // the platform gateway (which the function body never even sees) both
  // counted as "reachable". This metric was pinned at 100 and could not fail.
  const pingFns = [
    'unified-alerts',
    'budget-forecast',
    'ai-copilot-v2',
    'safety-intelligence',
    'emergency-mode'
  ];
  let reachable = 0;
  const missing = [];
  const unreachable = [];
  for (const fn of pingFns){
    try {
      const r = await fetch(`${baseUrl}/${fn}`, {
        method: 'GET',
        // Sent so the request reaches the function body instead of stopping at
        // the platform's own JWT gate. A 401 from the function itself still
        // proves it booted and answered; a 404 does not.
        headers: {
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
        },
        signal: AbortSignal.timeout(3000)
      });
      if (r.status === 404) {
        missing.push(fn);
      } else if (r.status < 500) {
        reachable++;
      } else {
        unreachable.push(`${fn}:${r.status}`);
      }
    } catch (e) {
      unreachable.push(`${fn}:${e instanceof Error ? e.message.slice(0, 40) : 'error'}`);
    }
  }
  const avail = Math.round(reachable / pingFns.length * 100);
  metrics.push({
    metric: 'api_availability_pct',
    value: avail,
    threshold: 99,
    status: missing.length > 0 ? 'breach' : avail >= 99 ? 'ok' : avail >= 95 ? 'warning' : 'breach'
  });
  if (missing.length > 0) {
    console.error('[monitoring-api] SLO probe: these slugs are not deployed:', missing.join(', '));
  }
  if (unreachable.length > 0) {
    console.error('[monitoring-api] SLO probe: these slugs did not answer:', unreachable.join(', '));
  }
  const since = new Date(Date.now() - 86400000).toISOString();
  const { count: breachCount } = await supabase.from('slo_metrics').select('*', {
    count: 'exact',
    head: true
  }).eq('status', 'breach').gte('measured_at', since);
  metrics.push({
    metric: 'slo_breaches_24h',
    value: breachCount ?? 0,
    threshold: 0,
    status: (breachCount ?? 0) === 0 ? 'ok' : 'breach'
  });
  return {
    metrics,
    measured_at: new Date().toISOString(),
    probe_missing: missing,
    probe_unreachable: unreachable
  };
}
// ── API Optimization handlers ──────────────────────────────────────────────
async function handleCheckRateLimit(req, supabase) {
  const body = await req.json();
  const { ip, userId, service, tier = 'free' } = body;
  if (!ip) return json({
    error: {
      code: 'MISSING_PARAM',
      message: 'ip is required'
    }
  }, 400);
  const now = new Date();
  const isStrict = service && [
    'flightaware',
    'google_places'
  ].includes(service);
  const bucketType = isStrict ? 'strict' : 'global';
  const windowMinutes = isStrict ? RATE_LIMITS.strict.windowMinutes : RATE_LIMITS.global.windowMinutes;
  const windowMs = windowMinutes * 60 * 1000;
  const limit = isStrict ? userId ? RATE_LIMITS.strict.perUser : RATE_LIMITS.strict.perIp : tier === 'premium' ? RATE_LIMITS.global.premium : RATE_LIMITS.global.free;
  const bucketKey = userId ? `user:${userId}` : `ip:${ip}`;
  const windowEnd = new Date(Math.ceil(now.getTime() / windowMs) * windowMs);
  // Fetch existing bucket for this window
  const { data: existing } = await supabase.from('rate_limit_buckets').select('*').eq('bucket_key', bucketKey).eq('bucket_type', bucketType).gte('window_end', now.toISOString()).order('window_end', {
    ascending: true
  }).limit(1).maybeSingle();
  let requestCount;
  let bucketId;
  if (existing) {
    requestCount = existing.request_count + 1;
    bucketId = existing.id;
    await supabase.from('rate_limit_buckets').update({
      request_count: requestCount,
      updated_at: now.toISOString()
    }).eq('id', bucketId);
  } else {
    requestCount = 1;
    bucketId = newId('rl');
    await supabase.from('rate_limit_buckets').insert({
      id: bucketId,
      bucket_key: bucketKey,
      bucket_type: bucketType,
      service: service ?? null,
      request_count: requestCount,
      window_start: now.toISOString(),
      window_end: windowEnd.toISOString(),
      tier,
      created_at: now.toISOString(),
      updated_at: now.toISOString()
    });
  }
  const allowed = requestCount <= limit;
  const remaining = Math.max(0, limit - requestCount);
  const resetAt = (existing ? new Date(existing.window_end) : windowEnd).toISOString();
  const retryAfter = allowed ? undefined : Math.ceil(((existing ? new Date(existing.window_end) : windowEnd).getTime() - now.getTime()) / 1000);
  if (!allowed) {
    return json({
      error: {
        code: 'RATE_LIMITED',
        message: 'Rate limit exceeded'
      },
      allowed: false,
      remaining: 0,
      resetAt,
      retryAfter
    }, 429, {
      'RateLimit-Limit': String(limit),
      'RateLimit-Remaining': '0',
      'RateLimit-Reset': resetAt,
      'Retry-After': String(retryAfter)
    });
  }
  return json({
    allowed: true,
    remaining,
    resetAt
  });
}
async function handleCacheGet(service, endpoint, req, supabase) {
  const url = new URL(req.url);
  const paramsStr = url.searchParams.get('params');
  let params = {};
  try {
    params = paramsStr ? JSON.parse(paramsStr) : {};
  } catch  {
    params = {};
  }
  const paramsHash = await hashParams(params);
  const cacheKey = `${service}:${endpoint}:${paramsHash}`;
  const now = new Date().toISOString();
  const { data } = await supabase.from('api_cache_entries').select('*').eq('cache_key', cacheKey).gt('expires_at', now).maybeSingle();
  if (!data) {
    return json({
      hit: false
    });
  }
  // Increment hit count
  await supabase.from('api_cache_entries').update({
    hit_count: data.hit_count + 1,
    last_hit_at: now
  }).eq('cache_key', cacheKey);
  return json({
    hit: true,
    data: data.response_data,
    expiresAt: data.expires_at
  });
}
async function handleCacheSet(service, endpoint, req, supabase) {
  const body = await req.json();
  const { params, response } = body;
  if (response === undefined) {
    return json({
      error: {
        code: 'MISSING_PARAM',
        message: 'response is required'
      }
    }, 400);
  }
  const paramsHash = await hashParams(params);
  const cacheKey = `${service}:${endpoint}:${paramsHash}`;
  const ttlSeconds = CACHE_TTLS[service] ?? 3600;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
  await supabase.from('api_cache_entries').upsert({
    cache_key: cacheKey,
    service,
    endpoint,
    params_hash: paramsHash,
    response_data: response,
    expires_at: expiresAt,
    created_at: now.toISOString(),
    last_hit_at: null
  }, {
    onConflict: 'cache_key'
  });
  return json({
    cached: true,
    expiresAt,
    ttlSeconds
  }, 201);
}
async function handleCacheDelete(req, supabase) {
  const body = await req.json();
  const { service, cacheKey } = body;
  if (!service && !cacheKey) {
    return json({
      error: {
        code: 'MISSING_PARAM',
        message: 'Provide service or cacheKey'
      }
    }, 400);
  }
  let query = supabase.from('api_cache_entries').delete();
  if (cacheKey) {
    query = query.eq('cache_key', cacheKey);
  } else if (service) {
    query = query.eq('service', service);
  }
  const { count } = await query.select('*', {
    count: 'exact',
    head: true
  });
  await (service && !cacheKey ? supabase.from('api_cache_entries').delete().eq('service', service) : supabase.from('api_cache_entries').delete().eq('cache_key', cacheKey));
  return json({
    deleted: count ?? 0
  });
}
async function handleLogCall(req, supabase) {
  const body = await req.json();
  const { service, endpoint, userId, ipAddress, costUsd, responseStatus, cacheHit = false, errorKind, durationMs } = body;
  if (!service || !endpoint || responseStatus === undefined) {
    return json({
      error: {
        code: 'MISSING_PARAM',
        message: 'service, endpoint, responseStatus are required'
      }
    }, 400);
  }
  const cost = costUsd ?? SERVICE_COSTS[service] ?? 0;
  const logId = newId('cl');
  const now = new Date().toISOString();
  // Insert cost log
  await supabase.from('api_cost_log').insert({
    id: logId,
    service,
    endpoint,
    user_id: userId ?? null,
    ip_address: ipAddress ?? null,
    cost_usd: cost,
    response_status: responseStatus,
    cache_hit: cacheHit,
    error_kind: errorKind ?? null,
    duration_ms: durationMs ?? null,
    called_at: now
  });
  // Update service health
  const isSuccess = responseStatus >= 200 && responseStatus < 300;
  const isFailure = responseStatus >= 500 || errorKind === 'timeout';
  const { data: health } = await supabase.from('api_service_health').select('*').eq('service', service).maybeSingle();
  let consecutiveFailures = health?.consecutive_failures ?? 0;
  let newStatus = health?.status ?? 'healthy';
  if (isSuccess) {
    consecutiveFailures = 0;
    newStatus = 'healthy';
  } else if (isFailure) {
    consecutiveFailures += 1;
    newStatus = consecutiveFailures >= 5 ? 'down' : consecutiveFailures >= 2 ? 'degraded' : 'healthy';
  }
  await supabase.from('api_service_health').upsert({
    service,
    consecutive_failures: consecutiveFailures,
    last_failure_at: isFailure ? now : health?.last_failure_at ?? null,
    last_success_at: isSuccess ? now : health?.last_success_at ?? null,
    status: newStatus,
    updated_at: now
  }, {
    onConflict: 'service'
  });
  // Daily aggregation upsert
  const today = now.split('T')[0];
  const dailyId = newId('cd');
  await supabase.from('api_cost_daily').upsert({
    id: dailyId,
    service,
    date: today,
    total_calls: 1,
    cache_hits: cacheHit ? 1 : 0,
    total_cost_usd: cost,
    error_count: isFailure ? 1 : 0,
    avg_duration_ms: durationMs ?? null
  }, {
    onConflict: 'service,date',
    ignoreDuplicates: false
  });
  // Increment existing daily row
  await supabase.rpc('increment_daily_cost', {
    p_service: service,
    p_date: today,
    p_cost: cost,
    p_cache_hit: cacheHit,
    p_error: isFailure,
    p_duration: durationMs ?? null
  }).maybeSingle().catch(()=>null); // best-effort if RPC doesn't exist
  // Check for consecutive failure alert
  let alertResult = null;
  if (consecutiveFailures >= 3) {
    const alertId = newId('al');
    const message = `Service ${service} has ${consecutiveFailures} consecutive failures`;
    const { data: alert } = await supabase.from('api_alerts').insert({
      id: alertId,
      severity: 'critical',
      kind: 'consecutive_failures',
      service,
      message,
      details: {
        consecutiveFailures,
        lastStatus: responseStatus,
        errorKind
      },
      created_at: now
    }).select().single();
    if (alert) alertResult = {
      id: alert.id,
      message: alert.message
    };
  }
  return json({
    logged: true,
    ...alertResult ? {
      alert: alertResult
    } : {}
  });
}
async function handleGetCosts(req, supabase) {
  const url = new URL(req.url);
  const days = parseInt(url.searchParams.get('days') ?? '30', 10);
  const serviceFilter = url.searchParams.get('service');
  const since = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
  let dailyQuery = supabase.from('api_cost_daily').select('*').gte('date', since).order('date', {
    ascending: false
  });
  if (serviceFilter) dailyQuery = dailyQuery.eq('service', serviceFilter);
  const { data: dailyRows } = await dailyQuery;
  // Monthly total (last 30 days)
  const monthSince = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
  const { data: monthRows } = await supabase.from('api_cost_daily').select('total_cost_usd').gte('date', monthSince);
  const monthlyTotal = (monthRows ?? []).reduce((s, r)=>s + parseFloat(r.total_cost_usd ?? '0'), 0);
  const monthlyBudgetPct = monthlyTotal / MONTHLY_BUDGET;
  const budgetStatus = getBudgetStatus(monthlyBudgetPct);
  // Aggregate by service
  const byService = {};
  for (const row of dailyRows ?? []){
    if (!byService[row.service]) {
      byService[row.service] = {
        totalCost: 0,
        totalCalls: 0,
        cacheHits: 0,
        cacheHitRate: 0,
        avgDuration: null
      };
    }
    const s = byService[row.service];
    s.totalCost += parseFloat(row.total_cost_usd ?? '0');
    s.totalCalls += row.total_calls ?? 0;
    s.cacheHits += row.cache_hits ?? 0;
  }
  for (const s of Object.values(byService)){
    s.cacheHitRate = s.totalCalls > 0 ? s.cacheHits / s.totalCalls : 0;
  }
  // Open alerts
  const { data: alerts } = await supabase.from('api_alerts').select('id, severity, kind, service, message, created_at').is('resolved_at', null).order('created_at', {
    ascending: false
  }).limit(20);
  const daily = (dailyRows ?? []).map((r)=>({
      date: r.date,
      service: r.service,
      totalCalls: r.total_calls,
      cacheHits: r.cache_hits,
      totalCostUsd: parseFloat(r.total_cost_usd ?? '0'),
      errorCount: r.error_count,
      cacheHitRate: r.total_calls > 0 ? r.cache_hits / r.total_calls : 0
    }));
  return json({
    daily,
    byService,
    monthlyTotal: parseFloat(monthlyTotal.toFixed(4)),
    monthlyBudgetPct: parseFloat(monthlyBudgetPct.toFixed(4)),
    budgetStatus,
    alerts: (alerts ?? []).map((a)=>({
        id: a.id,
        severity: a.severity,
        kind: a.kind,
        service: a.service,
        message: a.message,
        createdAt: a.created_at
      }))
  });
}
async function handleGetHealth(supabase) {
  const { data: healthRows } = await supabase.from('api_service_health').select('*').order('service');
  const { data: openAlerts } = await supabase.from('api_alerts').select('id, severity, kind, service, message, created_at').is('resolved_at', null).order('created_at', {
    ascending: false
  }).limit(10);
  const monthSince = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
  const { data: monthRows } = await supabase.from('api_cost_daily').select('total_cost_usd').gte('date', monthSince);
  const monthlyTotal = (monthRows ?? []).reduce((s, r)=>s + parseFloat(r.total_cost_usd ?? '0'), 0);
  const monthlyBudgetPct = monthlyTotal / MONTHLY_BUDGET;
  return json({
    services: healthRows ?? [],
    openAlerts: openAlerts ?? [],
    budget: {
      monthlyTotal: parseFloat(monthlyTotal.toFixed(4)),
      monthlyBudget: MONTHLY_BUDGET,
      budgetPct: parseFloat(monthlyBudgetPct.toFixed(4)),
      status: getBudgetStatus(monthlyBudgetPct)
    },
    checkedAt: new Date().toISOString()
  });
}
async function handleGetStats(supabase) {
  const now = new Date();
  const last60s = new Date(now.getTime() - 60000).toISOString();
  const last24h = new Date(now.getTime() - 86400000).toISOString();
  const last1h = new Date(now.getTime() - 3600000).toISOString();
  const monthSince = new Date(now.getTime() - 30 * 86400000).toISOString().split('T')[0];
  // Req/sec by service (last 60s)
  const { data: recentCalls } = await supabase.from('api_cost_log').select('service, called_at').gte('called_at', last60s);
  const reqByService = {};
  for (const row of recentCalls ?? []){
    reqByService[row.service] = (reqByService[row.service] ?? 0) + 1;
  }
  const reqPerSec = {};
  for (const [svc, count] of Object.entries(reqByService)){
    reqPerSec[svc] = parseFloat((count / 60).toFixed(4));
  }
  // Cache hit rate last 24h
  const { data: cacheRows } = await supabase.from('api_cost_log').select('cache_hit').gte('called_at', last24h);
  const totalCalls24h = cacheRows?.length ?? 0;
  const cacheHits24h = cacheRows?.filter((r)=>r.cache_hit).length ?? 0;
  const cacheHitRate24h = totalCalls24h > 0 ? cacheHits24h / totalCalls24h : 0;
  // Error rate last 1h
  const { data: errorRows } = await supabase.from('api_cost_log').select('error_kind, response_status').gte('called_at', last1h);
  const totalCalls1h = errorRows?.length ?? 0;
  const errors1h = errorRows?.filter((r)=>r.error_kind || (r.response_status ?? 0) >= 500).length ?? 0;
  const errorRate1h = totalCalls1h > 0 ? errors1h / totalCalls1h : 0;
  // Monthly spend
  const { data: monthRows } = await supabase.from('api_cost_daily').select('total_cost_usd').gte('date', monthSince);
  const monthlyTotal = (monthRows ?? []).reduce((s, r)=>s + parseFloat(r.total_cost_usd ?? '0'), 0);
  // Open incidents
  const { count: openIncidents } = await supabase.from('api_alerts').select('*', {
    count: 'exact',
    head: true
  }).is('resolved_at', null);
  return json({
    reqPerSec,
    currentSpendUsd: parseFloat(monthlyTotal.toFixed(4)),
    monthlyBudget: MONTHLY_BUDGET,
    budgetPct: parseFloat((monthlyTotal / MONTHLY_BUDGET).toFixed(4)),
    budgetStatus: getBudgetStatus(monthlyTotal / MONTHLY_BUDGET),
    cacheHitRate24h: parseFloat(cacheHitRate24h.toFixed(4)),
    errorRate1h: parseFloat(errorRate1h.toFixed(4)),
    openIncidents: openIncidents ?? 0,
    measuredAt: now.toISOString()
  });
}
async function handleAggregateDaily(req, supabase) {
  const authErr = checkServiceKey(req);
  if (authErr) return authErr;
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  // Aggregate yesterday's cost log
  const { data: logs } = await supabase.from('api_cost_log').select('service, cost_usd, cache_hit, error_kind, response_status, duration_ms').gte('called_at', `${yesterday}T00:00:00Z`).lt('called_at', `${yesterday}T23:59:59Z`);
  const serviceMap = {};
  for (const row of logs ?? []){
    if (!serviceMap[row.service]) {
      serviceMap[row.service] = {
        calls: 0,
        cacheHits: 0,
        cost: 0,
        errors: 0,
        durations: []
      };
    }
    const s = serviceMap[row.service];
    s.calls++;
    if (row.cache_hit) s.cacheHits++;
    s.cost += parseFloat(row.cost_usd ?? '0');
    if (row.error_kind || (row.response_status ?? 0) >= 500) s.errors++;
    if (row.duration_ms != null) s.durations.push(row.duration_ms);
  }
  let aggregated = 0;
  let alertsCreated = 0;
  for (const [service, stats] of Object.entries(serviceMap)){
    const avgDuration = stats.durations.length > 0 ? Math.round(stats.durations.reduce((a, b)=>a + b, 0) / stats.durations.length) : null;
    await supabase.from('api_cost_daily').upsert({
      id: newId('cd'),
      service,
      date: yesterday,
      total_calls: stats.calls,
      cache_hits: stats.cacheHits,
      total_cost_usd: parseFloat(stats.cost.toFixed(4)),
      error_count: stats.errors,
      avg_duration_ms: avgDuration
    }, {
      onConflict: 'service,date'
    });
    aggregated++;
    // Check daily threshold
    const threshold = DAILY_THRESHOLDS[service];
    if (threshold && stats.cost > threshold) {
      const alertId = newId('al');
      await supabase.from('api_alerts').insert({
        id: alertId,
        severity: 'warning',
        kind: 'daily_threshold',
        service,
        message: `Service ${service} exceeded daily threshold: $${stats.cost.toFixed(4)} > $${threshold}`,
        details: {
          date: yesterday,
          cost: stats.cost,
          threshold
        },
        created_at: new Date().toISOString()
      });
      alertsCreated++;
    }
  }
  // Check monthly budget
  const monthSince = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
  const { data: monthRows } = await supabase.from('api_cost_daily').select('total_cost_usd').gte('date', monthSince);
  const monthlyTotal = (monthRows ?? []).reduce((s, r)=>s + parseFloat(r.total_cost_usd ?? '0'), 0);
  const pct = monthlyTotal / MONTHLY_BUDGET;
  const thresholdEntries = Object.entries(BUDGET_THRESHOLDS);
  for (const [level, threshold] of thresholdEntries){
    if (pct >= threshold) {
      const severity = level === 'disable' || level === 'strict' ? 'critical' : 'warning';
      const alertId = newId('al');
      await supabase.from('api_alerts').insert({
        id: alertId,
        severity,
        kind: 'budget_exceeded',
        service: null,
        message: `Monthly budget at ${Math.round(pct * 100)}% ($${monthlyTotal.toFixed(2)} / $${MONTHLY_BUDGET})`,
        details: {
          monthlyTotal,
          budget: MONTHLY_BUDGET,
          pct,
          level
        },
        created_at: new Date().toISOString()
      });
      alertsCreated++;
      break; // only create one budget alert per run
    }
  }
  return json({
    aggregated,
    alertsCreated
  });
}
// ── Main handler ────────────────────────────────────────────────────────────
Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: corsHeaders
    });
  }
  const url = new URL(req.url);
  const rawPath = url.pathname.replace(/^\/monitoring-api/, '');
  const method = req.method.toUpperCase();
  // ── API Optimization routes (/api-opt/*) ─────────────────────────────────
  if (rawPath.startsWith('/api-opt/')) {
    const supabase = getClient();
    const optPath = rawPath.replace(/^\/api-opt/, '');
    try {
      // GET /api-opt/health — public, no auth
      if (method === 'GET' && optPath === '/health') {
        return await handleGetHealth(supabase);
      }
      // Auth check for all other /api-opt routes
      const authErr = await checkApiOptAuth(req, supabase);
      if (authErr) return authErr;
      // POST /api-opt/check-rate-limit
      if (method === 'POST' && optPath === '/check-rate-limit') {
        return await handleCheckRateLimit(req, supabase);
      }
      // GET /api-opt/cache/:service/:endpoint
      const cacheGetMatch = optPath.match(/^\/cache\/([^/]+)\/([^/]+)$/);
      if (method === 'GET' && cacheGetMatch) {
        return await handleCacheGet(cacheGetMatch[1], cacheGetMatch[2], req, supabase);
      }
      // POST /api-opt/cache/:service/:endpoint
      if (method === 'POST' && cacheGetMatch) {
        return await handleCacheSet(cacheGetMatch[1], cacheGetMatch[2], req, supabase);
      }
      // POST /api-opt/cache/:service/:endpoint (re-match for POST)
      const cachePostMatch = optPath.match(/^\/cache\/([^/]+)\/([^/]+)$/);
      if (method === 'POST' && cachePostMatch) {
        return await handleCacheSet(cachePostMatch[1], cachePostMatch[2], req, supabase);
      }
      // DELETE /api-opt/cache
      if (method === 'DELETE' && optPath === '/cache') {
        return await handleCacheDelete(req, supabase);
      }
      // POST /api-opt/log-call
      if (method === 'POST' && optPath === '/log-call') {
        return await handleLogCall(req, supabase);
      }
      // GET /api-opt/costs
      if (method === 'GET' && optPath === '/costs') {
        return await handleGetCosts(req, supabase);
      }
      // GET /api-opt/stats
      if (method === 'GET' && optPath === '/stats') {
        return await handleGetStats(supabase);
      }
      // POST /api-opt/alerts/acknowledge/:id
      const ackMatch = optPath.match(/^\/alerts\/acknowledge\/(.+)$/);
      if (method === 'POST' && ackMatch) {
        const alertId = ackMatch[1];
        const { data, error } = await supabase.from('api_alerts').update({
          acknowledged_at: new Date().toISOString()
        }).eq('id', alertId).select().single();
        // ERROR-VS-ABSENCE 2026-09-19 (F): only PGRST116 ("no rows") is a 404.
        if (error && !isNoRows(error)) {
          console.error('[api-opt] api_alerts acknowledge failed:', error.message);
          return json({
            error: {
              code: 'INTERNAL_ERROR',
              message: 'Could not acknowledge alert'
            }
          }, 500);
        }
        if (!data) return json({
          error: {
            code: 'NOT_FOUND',
            message: 'Alert not found'
          }
        }, 404);
        return json({
          alert: data
        });
      }
      // POST /api-opt/alerts/resolve/:id
      const resolveMatch = optPath.match(/^\/alerts\/resolve\/(.+)$/);
      if (method === 'POST' && resolveMatch) {
        const alertId = resolveMatch[1];
        const { data, error } = await supabase.from('api_alerts').update({
          resolved_at: new Date().toISOString()
        }).eq('id', alertId).select().single();
        // ERROR-VS-ABSENCE 2026-09-19 (F).
        if (error && !isNoRows(error)) {
          console.error('[api-opt] api_alerts resolve failed:', error.message);
          return json({
            error: {
              code: 'INTERNAL_ERROR',
              message: 'Could not resolve alert'
            }
          }, 500);
        }
        if (!data) return json({
          error: {
            code: 'NOT_FOUND',
            message: 'Alert not found'
          }
        }, 404);
        return json({
          alert: data
        });
      }
      // POST /api-opt/aggregate-daily
      if (method === 'POST' && optPath === '/aggregate-daily') {
        return await handleAggregateDaily(req, supabase);
      }
      return json({
        error: {
          code: 'NOT_FOUND',
          message: `No api-opt route: ${method} ${optPath}`
        }
      }, 404);
    } catch (err) {
      // Q2.13 2026-09-19 — was `message` (the raw internal error) in the
      // response body. Log the detail, return a generic message.
      const message = err instanceof Error ? err.message : String(err);
      console.error('[api-opt]', message);
      return json({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Internal server error'
        }
      }, 500);
    }
  }
  // ── QA Harness routes (require x-service-key) ──────────────────────────────
  if (rawPath.startsWith('/qa/')) {
    const authErr = checkServiceKey(req);
    if (authErr) return authErr;
    const supabase = getClient();
    const qaPath = rawPath.replace(/^\/qa/, '');
    try {
      if (method === 'POST' && qaPath === '/fixtures/generate') {
        const body = await req.json();
        const { fixture, seed = 42, user_id } = body;
        const valid = [
          'solo_city_break',
          'friends_multi_city',
          'family_long_haul',
          'disruption_day',
          'huge_trip'
        ];
        if (!valid.includes(fixture)) {
          return json({
            error: {
              code: 'INVALID_FIXTURE',
              message: `fixture must be one of: ${valid.join(', ')}`
            }
          }, 400);
        }
        // This route only accepts the service-role key (checkServiceKey,
        // above) — there is no authenticated user to derive an id from, and
        // trips.user_id is uuid NOT NULL with no default. Require the
        // caller to pass the owning user's auth uuid explicitly and fail
        // loudly rather than silently violating the constraint.
        if (typeof user_id !== 'string' || !UUID_RE.test(user_id)) {
          return json({
            error: {
              code: 'MISSING_PARAM',
              message: 'user_id (a valid uuid) is required to attribute the fixture trip'
            }
          }, 400);
        }
        const result = await generateFixture(supabase, fixture, seed, user_id);
        if ('error' in result) {
          return json({
            error: {
              code: 'FIXTURE_INSERT_FAILED',
              message: result.error,
              detail: result.detail
            }
          }, 500);
        }
        return json(result, 201);
      }
      if (method === 'POST' && qaPath === '/fixtures/cleanup') {
        const body = await req.json();
        const { tripId, fixture } = body;
        if (!tripId && !fixture) return json({
          error: {
            code: 'MISSING_PARAM',
            message: 'Provide tripId or fixture'
          }
        }, 400);
        return json(await cleanupFixture(supabase, tripId, fixture));
      }
      if (method === 'POST' && qaPath === '/canary/run') {
        // CROSS-FUNCTION CALLS 2026-09-19 (A): the canary trip needs an owner.
        // `trips.user_id` is uuid NOT NULL and this route is service-key-only,
        // so there is no authenticated user to take it from. Same contract as
        // /qa/fixtures/generate.
        const body = await req.json().catch(()=>({}));
        const canaryUserId = body.user_id;
        if (typeof canaryUserId !== 'string' || !UUID_RE.test(canaryUserId)) {
          return json({
            error: {
              code: 'MISSING_PARAM',
              message: 'user_id (a valid uuid) is required to own the canary trip'
            }
          }, 400);
        }
        return json(await runCanarySweep(supabase, canaryUserId));
      }
      if (method === 'POST' && qaPath === '/auth-sweep/run') {
        const body = await req.json();
        const { tripId, routes } = body;
        if (!tripId || !Array.isArray(routes)) {
          return json({
            error: {
              code: 'MISSING_PARAM',
              message: 'Provide tripId and routes array'
            }
          }, 400);
        }
        return json(await runAuthSweep(tripId, routes));
      }
      if (method === 'GET' && qaPath === '/feature-flags') {
        const { data, error } = await supabase.from('feature_flags').select('*').order('series');
        if (error) throw error;
        return json({
          flags: data
        });
      }
      const flagMatch = qaPath.match(/^\/feature-flags\/(.+)$/);
      if (method === 'PATCH' && flagMatch) {
        const flag = decodeURIComponent(flagMatch[1]);
        const body = await req.json();
        const update = {
          updated_at: new Date().toISOString()
        };
        if (body.enabled !== undefined) update.enabled = body.enabled;
        if (body.rolloutPct !== undefined) update.rollout_pct = body.rolloutPct;
        const { data, error } = await supabase.from('feature_flags').update(update).eq('flag', flag).select().single();
        if (error) throw error;
        if (!data) return json({
          error: {
            code: 'NOT_FOUND',
            message: 'Flag not found'
          }
        }, 404);
        return json({
          flag: data
        });
      }
      if (method === 'GET' && qaPath === '/release-checklist') {
        const { data, error } = await supabase.from('release_checklist').select('*').order('category');
        if (error) throw error;
        const byCategory = {};
        for (const item of data ?? []){
          const cat = item.category;
          if (!byCategory[cat]) byCategory[cat] = [];
          byCategory[cat].push(item);
        }
        const total = data?.length ?? 0;
        const passed = data?.filter((i)=>i.status === 'pass').length ?? 0;
        const failed = data?.filter((i)=>i.status === 'fail').length ?? 0;
        return json({
          checklist: data,
          byCategory,
          summary: {
            total,
            passed,
            failed,
            pending: total - passed - failed
          }
        });
      }
      const clMatch = qaPath.match(/^\/release-checklist\/(.+)$/);
      if (method === 'PATCH' && clMatch) {
        const item = decodeURIComponent(clMatch[1]);
        const body = await req.json();
        const { status, notes, checkedBy } = body;
        const validStatuses = [
          'pending',
          'pass',
          'fail',
          'na'
        ];
        if (status && !validStatuses.includes(status)) {
          return json({
            error: {
              code: 'INVALID_STATUS',
              message: `status must be one of: ${validStatuses.join(', ')}`
            }
          }, 400);
        }
        const update = {};
        if (status) {
          update.status = status;
          update.checked_at = new Date().toISOString();
        }
        if (notes !== undefined) update.notes = notes;
        if (checkedBy !== undefined) update.checked_by = checkedBy;
        const { data, error } = await supabase.from('release_checklist').update(update).eq('item', item).select().single();
        if (error) throw error;
        if (!data) return json({
          error: {
            code: 'NOT_FOUND',
            message: 'Checklist item not found'
          }
        }, 404);
        return json({
          item: data
        });
      }
      if (method === 'GET' && qaPath === '/slo/current') {
        return json(await computeSLO(supabase));
      }
      if (method === 'POST' && qaPath === '/slo/record') {
        const body = await req.json();
        const { metric, value, threshold } = body;
        if (!metric || value === undefined || threshold === undefined) {
          return json({
            error: {
              code: 'MISSING_PARAM',
              message: 'Provide metric, value, threshold'
            }
          }, 400);
        }
        const status = value <= threshold ? 'ok' : value <= threshold * 1.1 ? 'warning' : 'breach';
        const id = `slo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const { data, error } = await supabase.from('slo_metrics').insert({
          id,
          metric,
          value,
          threshold,
          status
        }).select().single();
        if (error) throw error;
        return json({
          metric: data
        }, 201);
      }
      return json({
        error: {
          code: 'NOT_FOUND',
          message: `No QA route: ${method} ${qaPath}`
        }
      }, 404);
    } catch (err) {
      // Q2.13 2026-09-19 — see the /api-opt/ catch above. Raw PostgREST error
      // strings carry table, column and constraint names.
      const message = err instanceof Error ? err.message : String(err);
      console.error('[qa-harness]', message);
      return json({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Internal server error'
        }
      }, 500);
    }
  }
  // ── Original monitoring-api routes (action-based) ──────────────────────────
  const caller = await requireUserOrService(req);
  if (caller instanceof Response) return caller;
  const supabase = getClient();
  const userId = caller.kind === 'user' ? caller.userId : null;
  const respond = (data, status = 200)=>new Response(JSON.stringify(data), {
      status,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  let action = url.searchParams.get('action') ?? '';
  let params = {};
  url.searchParams.forEach((v, k)=>{
    if (k !== 'action') params[k] = v;
  });
  if (req.method === 'POST') {
    try {
      const body = await req.json();
      if (body.action) action = body.action;
      params = {
        ...params,
        ...body
      };
    } catch  {}
  }
  const now = new Date().toISOString();
  try {
    if (action === 'trip_monitoring') {
      // FABRICATION REMOVED 2026-09-19 (E) — this returned a hard-coded
      // `mockEntities` list ("Flight AA123", "Hotel Check-in", "Car Rental")
      // and a hard-coded `providers` list whenever the real query came back
      // empty. "Empty" included the pipeline's normal case (a service-role
      // caller, where `userId` is null and the query was skipped entirely), so
      // a caller had no way to tell invented monitoring from real monitoring,
      // and `overall_status` was the literal 'ACTIVE' regardless. Now: real
      // rows only, an empty list when there are none, and a status that says
      // when it is not known.
      const trip_id = params.trip_id;
      if (!trip_id) {
        return respond({
          error: 'trip_id is required'
        }, 400);
      }
      if (caller.kind === 'user') {
        const owns = await requireTripOwner(supabase, trip_id, userId);
        if (owns !== true) return owns;
      }
      const { data: entityRows, error: entityErr } = await supabase.from('monitored_entities').select('id, entity_type, entity_reference, monitoring_status, last_checked_at').eq('trip_id', trip_id);
      if (entityErr) {
        console.error('[monitoring-api] monitored_entities read failed:', entityErr.message);
        return respond({
          error: 'Could not read monitoring state'
        }, 500);
      }
      const monitored_entities = (entityRows ?? []).map((e)=>({
          id: e.id,
          entity_type: e.entity_type,
          entity_name: e.entity_reference ?? e.entity_type,
          monitoring_status: e.monitoring_status,
          last_checked_at: e.last_checked_at
        }));
      const overall_status = monitored_entities.length === 0 ? 'NOT_MONITORED' : monitored_entities.some((e)=>e.monitoring_status === 'ACTIVE') ? 'ACTIVE' : 'INACTIVE';
      return respond({
        overall_status,
        entity_count: monitored_entities.length,
        monitored_entities,
        // The provider list was two invented rows. There is no provider
        // registry read available on this route, so it reports nothing rather
        // than something made up.
        providers: [],
        providers_unavailable_reason: 'No provider registry is exposed on this route.',
        recent_events: []
      });
    }
    if (action === 'events') {
      const trip_id = params.trip_id;
      if (!trip_id) return respond({
        events: []
      });
      if (caller.kind === 'user') {
        const owns = await requireTripOwner(supabase, trip_id, userId);
        if (owns !== true) return owns;
      }
      const { data: events } = await supabase.from('monitoring_events').select('id, event_type, severity, detected_at, status, trip_id').eq('trip_id', trip_id).order('detected_at', {
        ascending: false
      }).limit(50);
      return respond({
        events: events ?? []
      });
    }
    if (action === 'add_entity') {
      if (!userId) return respond({
        error: 'Unauthorized'
      }, 401);
      const { trip_id, entity_type, entity_name, entity_ref } = params;
      const { data: entity, error } = await supabase.from('monitored_entities').insert({
        user_id: userId,
        trip_id,
        entity_type,
        entity_reference: entity_ref ?? entity_name,
        monitoring_status: 'ACTIVE',
        last_checked_at: now
      }).select().single();
      // Q2.13 2026-09-19 — was `error.message`, the raw PostgREST error.
      if (error) {
        console.error('[monitoring-api] add_entity insert failed:', error.message);
        return respond({
          error: 'Could not add monitored entity'
        }, 500);
      }
      return respond({
        success: true,
        entity: {
          id: entity.id,
          entity_type: entity.entity_type,
          entity_name: entity.entity_reference,
          monitoring_status: entity.monitoring_status,
          last_checked_at: entity.last_checked_at
        }
      });
    }
    if (action === 'update_entity') {
      if (!userId) return respond({
        error: 'Unauthorized'
      }, 401);
      const { entity_id, monitoring_status } = params;
      const { error } = await supabase.from('monitored_entities').update({
        monitoring_status,
        last_checked_at: now
      }).eq('id', entity_id).eq('user_id', userId);
      // Q2.13 2026-09-19 — was `error.message`.
      if (error) {
        console.error('[monitoring-api] update_entity failed:', error.message);
        return respond({
          error: 'Could not update monitored entity'
        }, 500);
      }
      return respond({
        success: true
      });
    }
    if (action === 'acknowledge_event') {
      if (!userId) return respond({
        error: 'Unauthorized'
      }, 401);
      const { event_id } = params;
      if (caller.kind === 'user') {
        const { data: owningEvent } = await supabase.from('monitoring_events').select('id, trip_id').eq('id', event_id).maybeSingle();
        if (!owningEvent) return respond({
          error: 'Not found'
        }, 404);
        const owns = await requireTripOwner(supabase, owningEvent.trip_id, userId);
        if (owns !== true) return owns;
      }
      const { error } = await supabase.from('monitoring_events').update({
        status: 'PROCESSED'
      }).eq('id', event_id);
      // Q2.13 2026-09-19 — was `error.message`.
      if (error) {
        console.error('[monitoring-api] acknowledge_event failed:', error.message);
        return respond({
          error: 'Could not acknowledge event'
        }, 500);
      }
      return respond({
        success: true
      });
    }
    return respond({
      error: 'Unknown action'
    }, 400);
  } catch (err) {
    console.error(err);
    return respond({
      error: 'Internal server error'
    }, 500);
  }
});

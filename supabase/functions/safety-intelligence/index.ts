// 2026-09-25 — own-country advisory sources are "not applicable" (wave 7).
// GET /briefings asked the US State Department for an advisory on 'US' and
// the UK FCDO for one on 'GB'. Neither government issues travel advice about
// its own country, so a domestic US trip showed a "US State Department" card
// reading "No advisory text was available." Those source/country pairs are no
// longer fetched; the briefing carries the source with
//   { status: 'not_applicable', level: null, headline: <note>, note: <note>,
//     advisoryUrl: null, ... }
// (headline repeats the note so clients that only render `headline` show it).
// Every fetched source now also carries status: 'ok'. A country whose only
// remaining source could not be fetched keeps status 'unavailable' at the
// briefing level and still lists the not-applicable source. GET /notes no
// longer reports 'US' as an advisory miss. Response shape: fields added only.
//
// 2026-09-25 — UK FCDO advisory slug fix (wave 6b).
// The UK branch of fetchAndCacheAdvisory asked provider-adapters for
// `countrySlug=${countryCode.toLowerCase()}` — e.g. 'fr', 'us'. FCDO slugs are
// country NAMES (gov.uk/foreign-travel-advice/france, /usa, /new-zealand), so
// every UK advisory lookup missed. fcdoSlug() now maps ISO2 -> FCDO slug:
// an explicit table for every country we hold emergency numbers for (AU BE BR
// CA CH DE ES FR GR IN IT JP MX NL NZ PT SG TH US) plus the known cases where
// the FCDO slug differs from the English region name (checked 2026-09-25
// against the live gov.uk/foreign-travel-advice index), then a generic
// fallback: Intl.DisplayNames('en',{type:'region'}) lowercased and hyphenated.
// GB has no FCDO advisory (it is the UK's own country) and returns null, as
// does any failure — in which case no UK advisory is fetched, exactly as a
// provider miss behaved before.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SERVICE_KEY = Deno.env.get('SAFETY_SERVICE_KEY') ?? '';
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-service-key',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS'
};
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json'
    }
  });
}
function err(code, message, status = 400) {
  return json({
    error: {
      code,
      message
    }
  }, status);
}
// ---------------------------------------------------------------------------
// Content guidelines
// ---------------------------------------------------------------------------
const BANNED_PHRASES = [
  'dangerous neighborhood',
  'bad area',
  'sketchy',
  'rough area',
  'ghetto',
  'unsafe neighborhood',
  'crime-ridden',
  'high crime area'
];
function checkContentGuidelines(text) {
  const lower = text.toLowerCase();
  for (const phrase of BANNED_PHRASES){
    if (lower.includes(phrase)) {
      throw new Error(`Content guideline violation: "${phrase}"`);
    }
  }
}
// ---------------------------------------------------------------------------
// ULID generator (prefixed)
// ---------------------------------------------------------------------------
function generateId(prefix) {
  const ts = Date.now().toString(36).toUpperCase().padStart(10, '0');
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(10))).map((b)=>'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[b % 32]).join('');
  return `${prefix}${ts}${rand}`;
}
// ---------------------------------------------------------------------------
// Haversine
// ---------------------------------------------------------------------------
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
// DEFECT 2026-09-19 (0 is a real coordinate) — every rule guarded its inputs
// with `if (!item.lat || !item.lng) return null`. Longitude 0 runs through
// Greenwich, Accra and eastern Spain, and latitude 0 is the equator; both are
// falsy, so any itinerary item sitting on the prime meridian silently had
// every location-based safety rule disabled. Checked by type now.
function hasCoords(i) {
  return !!i && typeof i.lat === 'number' && Number.isFinite(i.lat) && typeof i.lng === 'number' && Number.isFinite(i.lng);
}
// ---------------------------------------------------------------------------
// Local time
// ---------------------------------------------------------------------------
//
// DEFECT 2026-09-19 (wrong timezone — every hour-based rule fired at the
// wrong time of day) — all four time-of-day rules read the hour with
//     new Date(item.end_time).getHours()
// getHours() returns the hour in the RUNTIME's local zone, and a Supabase
// edge function runs on UTC. So the rules were evaluated against UTC, not
// against the time where the traveller actually is:
//   * S1 "late walk after 23:00" and S8 "walking alone after 22:00" never
//     fired for a traveller in Tokyo (23:30 local is 14:30 UTC) — the two
//     rules most likely to matter simply did not exist east of Europe;
//   * the same rules fired on a 15:00 stroll in Los Angeles (23:00 UTC),
//     telling someone walking in the afternoon that they were out late at
//     night.
// Hours are now read in the item's own timezone (itinerary_items.timezone),
// falling back to the trip's primary_tz. When neither is recorded the hour is
// unknown, and a rule that depends on it is SKIPPED and reported in the
// response rather than evaluated against an arbitrary zone.
function localHourIn(iso, tz) {
  if (!tz) return null;
  const t = new Date(iso);
  if (!Number.isFinite(t.getTime())) return null;
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      hour12: false
    });
    const h = parseInt(fmt.format(t), 10);
    return Number.isFinite(h) ? h : null;
  } catch  {
    return null;
  }
}
function formatTimeIn(d, tz) {
  try {
    if (tz) {
      return new Intl.DateTimeFormat('en-GB', {
        timeZone: tz,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      }).format(d);
    }
  } catch  {}
  return `${d.toISOString().slice(11, 16)} UTC`;
}
// ---------------------------------------------------------------------------
// Sunset
// ---------------------------------------------------------------------------
//
// DEFECT 2026-09-19 (fabricated data) — rule S6 renders the template
//     "Ends after sunset ({sunsetTime}). Bring a light or start earlier."
// and the code that filled it was:
//     // Approximate sunset at 20:00 if no weather data
//     const sunsetHour = 20;
//     if (endHour <= sunsetHour) return null;
//     return { vars: { sunsetTime: `${sunsetHour}:00` }, source: 'itinerary' };
// 20:00 was not an approximation of anything — it was a constant, quoted to
// the traveller as the sunset time for wherever they were. In Reykjavik in
// June the sun sets near midnight, so a hike ending at 21:00 was flagged as
// finishing after dark when it was broad daylight; in Quito sunset is 18:15
// all year, so a hike ending at 19:30 was NOT flagged when it genuinely ended
// in the dark. The note also always said "(20:00)", a specific wrong time.
//
// Sunset is now computed for the item's own latitude, longitude and date with
// the standard NOAA sunrise equation, and the comparison is made between two
// instants so no timezone is needed for the test itself. An item without
// coordinates cannot have a sunset computed and the rule is skipped rather
// than guessed at. Polar day and polar night are reported explicitly.
const DEG = Math.PI / 180;
function sunsetFor(instant, lat, lng) {
  if (!Number.isFinite(instant.getTime())) return {
    kind: 'unknown'
  };
  // Julian date at the given instant.
  const jd = instant.getTime() / 86400000 + 2440587.5;
  const lw = -lng; // the sunrise equation uses west-positive longitude
  const n = Math.round(jd - 2451545.0 - 0.0009 - lw / 360);
  const jStar = 2451545.0 + 0.0009 + lw / 360 + n; // mean solar noon
  const M = (357.5291 + 0.98560028 * (jStar - 2451545.0)) % 360; // solar mean anomaly
  const C = 1.9148 * Math.sin(M * DEG) + 0.02 * Math.sin(2 * M * DEG) + 0.0003 * Math.sin(3 * M * DEG);
  const lambda = (M + C + 180 + 102.9372) % 360; // ecliptic longitude
  const jTransit = jStar + 0.0053 * Math.sin(M * DEG) - 0.0069 * Math.sin(2 * lambda * DEG);
  const delta = Math.asin(Math.sin(lambda * DEG) * Math.sin(23.4397 * DEG)); // declination, radians
  const cosOmega = (Math.sin(-0.833 * DEG) - Math.sin(lat * DEG) * Math.sin(delta)) / (Math.cos(lat * DEG) * Math.cos(delta));
  if (!Number.isFinite(cosOmega)) return {
    kind: 'unknown'
  };
  if (cosOmega > 1) return {
    kind: 'polar_night'
  }; // the sun does not rise
  if (cosOmega < -1) return {
    kind: 'polar_day'
  }; // the sun does not set
  const omega = Math.acos(cosOmega) / DEG;
  const jSet = jTransit + omega / 360;
  return {
    kind: 'sunset',
    at: new Date((jSet - 2440587.5) * 86400000)
  };
}
// ---------------------------------------------------------------------------
// Tip level filter
// ---------------------------------------------------------------------------
const TIP_LEVEL_ORDER = {
  minimal: 0,
  standard: 1,
  detailed: 2
};
function tipLevelAllows(userLevel, ruleMin) {
  return (TIP_LEVEL_ORDER[userLevel] ?? 1) >= (TIP_LEVEL_ORDER[ruleMin] ?? 1);
}
// ---------------------------------------------------------------------------
// Template filler
// ---------------------------------------------------------------------------
function fillTemplate(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, key)=>vars[key] ?? `{${key}}`);
}
// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
async function authenticate(req) {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return null;
  return {
    userId: data.user.id
  };
}
// SECURITY 2026-09-17 — isServiceKey compared the caller's x-service-key
// header to SAFETY_SERVICE_KEY with `===`, a variable-time comparison that
// can leak the key one byte at a time via response timing. Switched to a
// constant-time compare.
function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for(let i = 0; i < len; i++)diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}
function isServiceKey(req) {
  const key = req.headers.get('x-service-key');
  return !!SERVICE_KEY && !!key && timingSafeEqual(key, SERVICE_KEY);
}
async function resolvePlatformUserId(authUserId) {
  const { data, error } = await supabase.from('auth_identities').select('user_id').eq('provider_subject', authUserId).maybeSingle();
  if (error) {
    console.error('[safety-intelligence] auth_identities lookup failed:', error.message);
    return {
      failed: error.message
    };
  }
  return {
    id: data?.user_id ?? null
  };
}
async function checkTripMember(tripId, authUserId) {
  const resolved = await resolvePlatformUserId(authUserId);
  if ('failed' in resolved) return {
    failed: resolved.failed
  };
  if (!resolved.id) return {
    member: false
  };
  const { data: member, error } = await supabase.from('trip_members').select('id').eq('trip_id', tripId).eq('user_id', resolved.id).is('removed_at', null).maybeSingle();
  if (error) {
    console.error('[safety-intelligence] trip_members lookup failed:', error.message);
    return {
      failed: error.message
    };
  }
  return member ? {
    member: true
  } : {
    member: false
  };
}
async function gate(tripId, authUserId) {
  const result = await checkTripMember(tripId, authUserId);
  if ('failed' in result) {
    return err('MEMBERSHIP_CHECK_FAILED', 'Could not verify your membership of this trip', 500);
  }
  if (!result.member) return err('FORBIDDEN', 'Not a member of this trip', 403);
  return null;
}
// ---------------------------------------------------------------------------
// Provider-adapters caller
// ---------------------------------------------------------------------------
//
// DEFECT 2026-09-19 (silent provider outage) — this returned null on a
// non-2xx with no logging and no signal to the caller. When the weather or
// earthquake provider was down, GET /notes came back with a clean, complete
// looking list that simply contained no weather and no earthquake warnings.
// On a safety feature, "we could not check" must never be rendered as
// "nothing to report". Failures are now logged and reported to the caller in
// a `sources` block.
async function callProviderAdapter(path, token) {
  const url = `${SUPABASE_URL}/functions/v1/provider-adapters${path}`;
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
    if (!res.ok) {
      const text = await res.text().catch(()=>'<unreadable>');
      console.error(`[safety-intelligence] provider-adapters${path} returned ${res.status}: ${text.slice(0, 300)}`);
      return {
        ok: false,
        reason: `provider returned ${res.status}`
      };
    }
    return {
      ok: true,
      body: await res.json()
    };
  } catch (e) {
    console.error(`[safety-intelligence] provider-adapters${path} threw:`, e);
    return {
      ok: false,
      reason: e instanceof Error ? e.message : String(e)
    };
  }
}
// ---------------------------------------------------------------------------
// Advisory fetching + caching
// ---------------------------------------------------------------------------
// 2026-09-25: ISO2 -> gov.uk FCDO travel-advice slug. See header.
const FCDO_SLUGS = {
  AU: 'australia',
  BE: 'belgium',
  BR: 'brazil',
  CA: 'canada',
  CH: 'switzerland',
  DE: 'germany',
  ES: 'spain',
  FR: 'france',
  GR: 'greece',
  IN: 'india',
  IT: 'italy',
  JP: 'japan',
  MX: 'mexico',
  NL: 'netherlands',
  NZ: 'new-zealand',
  PT: 'portugal',
  SG: 'singapore',
  TH: 'thailand',
  US: 'usa',
  // Names where the FCDO slug differs from the English region name.
  BL: 'st-martin-and-st-barthelemy',
  MF: 'st-martin-and-st-barthelemy',
  BQ: 'bonaire-st-eustatius-saba',
  CD: 'democratic-republic-of-the-congo',
  CG: 'congo',
  CK: 'cook-islands-tokelau-and-niue',
  NU: 'cook-islands-tokelau-and-niue',
  TK: 'cook-islands-tokelau-and-niue',
  CZ: 'czechia',
  FM: 'federated-states-of-micronesia',
  GM: 'the-gambia',
  HK: 'hong-kong',
  MO: 'macao',
  MM: 'myanmar',
  PN: 'pitcairn-island',
  PS: 'palestine',
  SH: 'st-helena-ascension-and-tristan-da-cunha',
  AC: 'st-helena-ascension-and-tristan-da-cunha',
  TA: 'st-helena-ascension-and-tristan-da-cunha',
  SX: 'st-maarten',
  TR: 'turkey',
  VC: 'st-vincent-and-the-grenadines',
  KR: 'south-korea',
  KP: 'north-korea',
  CI: 'cote-d-ivoire',
  CV: 'cape-verde',
  SZ: 'eswatini',
  TL: 'timor-leste',
  VN: 'vietnam',
  LA: 'laos',
  RU: 'russia',
  SY: 'syria',
  IR: 'iran',
  BN: 'brunei',
  BO: 'bolivia',
  VE: 'venezuela',
  TZ: 'tanzania',
  MD: 'moldova',
  MK: 'north-macedonia',
  KN: 'st-kitts-and-nevis',
  LC: 'st-lucia',
  PM: 'st-pierre-and-miquelon',
  AE: 'united-arab-emirates',
  BA: 'bosnia-and-herzegovina',
  XK: 'kosovo'
};
function fcdoSlug(countryCode) {
  try {
    const cc = (countryCode ?? '').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(cc)) return null;
    if (cc === 'GB' || cc === 'UK') return null; // no FCDO advisory for the UK itself
    if (FCDO_SLUGS[cc]) return FCDO_SLUGS[cc];
    const name = new Intl.DisplayNames('en', {
      type: 'region'
    }).of(cc);
    if (!name || name.toUpperCase() === cc) return null;
    const slug = name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return slug || null;
  } catch  {
    return null;
  }
}
async function fetchAndCacheAdvisory(countryCode, source, token) {
  try {
    let result = null;
    if (source === 'US') {
      const raw = await callProviderAdapter(`/advisory/us?iso2=${encodeURIComponent(countryCode)}`, token);
      const d = raw.ok ? raw.body?.data : undefined;
      if (d) {
        result = {
          country_code: countryCode,
          source: 'US',
          level: d.level ?? null,
          headline: d.summary ?? '',
          regions_json: [],
          common_issues: [],
          // DEFECT 2026-09-19 — `d.url ?? 'https://travel.state.gov'` put the
          // department's front page in a field the UI labels as this
          // country's advisory, so a traveller clicking through believing
          // they were opening the advisory for their destination landed on a
          // generic homepage. The generic fallback is kept because it is
          // still the right place to look, but it is marked so the caller
          // can word the link honestly.
          advisory_url: d.url ?? 'https://travel.state.gov',
          advisory_url_is_generic: !d.url,
          updated_at_source: d.updatedAt ?? null
        };
      }
    } else {
      // UK: FCDO slugs are country names, not ISO codes (2026-09-25 fix).
      const slug = fcdoSlug(countryCode);
      const raw = slug ? await callProviderAdapter(`/advisory/uk?countrySlug=${encodeURIComponent(slug)}`, token) : {
        ok: false,
        reason: 'no FCDO slug for ' + countryCode
      };
      const d = raw.ok ? raw.body?.data : undefined;
      if (d) {
        result = {
          country_code: countryCode,
          source: 'UK',
          level: d.level ?? null,
          headline: d.summary ?? '',
          regions_json: [],
          common_issues: [],
          advisory_url: d.url ?? 'https://www.gov.uk/foreign-travel-advice',
          advisory_url_is_generic: !d.url,
          updated_at_source: d.updatedAt ?? null
        };
      }
    }
    if (!result) return null;
    const fetchedAt = new Date().toISOString();
    // Cache in safety_advisories.
    //
    // NOTE 2026-09-19 — regions_json and common_issues are always written as
    // [] because nothing in this function populates them, so this upsert
    // erases anything another writer put there. Left as-is (the adapter does
    // not supply them today) but flagged: if a source of region detail is
    // added, this upsert must stop clobbering it.
    const { error: cacheErr } = await supabase.from('safety_advisories').upsert({
      country_code: countryCode,
      source,
      level: result.level,
      headline: result.headline,
      regions_json: result.regions_json,
      common_issues: result.common_issues,
      advisory_url: result.advisory_url,
      fetched_at: fetchedAt,
      updated_at_source: result.updated_at_source
    }, {
      onConflict: 'country_code,source'
    });
    if (cacheErr) {
      // Non-fatal: we still have the advisory in hand for this request.
      console.error('[safety-intelligence] advisory cache write failed:', cacheErr.message);
    }
    return {
      ...result,
      fetched_at: fetchedAt,
      stale: false
    };
  } catch (e) {
    console.error('[safety-intelligence] advisory fetch error:', e);
    return null;
  }
}
const ADVISORY_MAX_AGE_MS = 24 * 3600 * 1000;
// 2026-09-25 (wave 7) — a government does not issue travel advice for its own
// country: the US State Department has no advisory for the US, the UK FCDO
// none for the UK. Returns the explanatory note when the pair does not apply.
function ownCountryAdvisoryNote(countryCode, source) {
  const cc = (countryCode ?? '').trim().toUpperCase();
  if (source === 'US' && cc === 'US') {
    return "The US State Department doesn't issue advisories for travel within the US.";
  }
  if (source === 'UK' && (cc === 'GB' || cc === 'UK')) {
    return "The UK Foreign Office (FCDO) doesn't issue travel advice for travel within the UK.";
  }
  return null;
}
async function getAdvisory(countryCode, source, token) {
  // Check cache
  const { data: cached, error: cacheErr } = await supabase.from('safety_advisories').select('*').eq('country_code', countryCode).eq('source', source).maybeSingle();
  if (cacheErr) {
    console.error('[safety-intelligence] advisory cache read failed:', cacheErr.message);
  }
  const cachedAge = cached?.fetched_at ? Date.now() - new Date(cached.fetched_at).getTime() : null;
  if (cached && cachedAge !== null && Number.isFinite(cachedAge) && cachedAge < ADVISORY_MAX_AGE_MS) {
    return {
      ...cached,
      stale: false
    };
  }
  // Refresh
  const fresh = await fetchAndCacheAdvisory(countryCode, source, token);
  if (fresh) return fresh;
  // DEFECT 2026-09-19 (a stale advisory thrown away in favour of nothing) —
  // if the refresh failed this returned null, and handleBriefings then
  // reported the country as 'unavailable'. A government travel advisory that
  // was cached 25 hours ago is far better information than none at all; it
  // was being discarded because it had crossed a 24-hour line by an hour.
  // The cached copy is returned with its age so the caller can say how old
  // it is instead of saying nothing is known.
  if (cached) {
    return {
      ...cached,
      stale: true
    };
  }
  return null;
}
function isSkip(o) {
  return !!o && typeof o === 'object' && 'skipped' in o;
}
function evaluateCondition(rule, item, nextItem, context) {
  const p = rule.condition_params ?? {};
  const tz = item.timezone ?? context.tripTz;
  switch(rule.condition_type){
    case 'late_walk':
      {
        if (!item.end_time || !hasCoords(item)) return null;
        if (nextItem && !hasCoords(nextItem)) return null;
        const endHour = localHourIn(item.end_time, tz);
        if (endHour === null) {
          return {
            skipped: `${rule.id}: no timezone on this item or trip, so the local hour is unknown`
          };
        }
        const afterHour = p.afterHour ?? 23;
        if (endHour < afterHour) return null;
        // DEFECT 2026-09-19 (absence read as a walk) — this was
        //     const mode = item.transport_mode ?? nextItem?.transport_mode ?? '';
        //     if (mode && mode !== 'walk') return null;
        // so an item with NO transport mode recorded fell through the guard and
        // was treated as a walk. "Late walk back. Consider a ride." was shown
        // to people who had booked a taxi and to people who had recorded
        // nothing at all. The mode must now actually say walk.
        const mode = item.transport_mode ?? nextItem?.transport_mode ?? null;
        if (mode !== 'walk') return null;
        // DEFECT 2026-09-19 (fabricated party size) — `item.party_size ?? 1`
        // assumed anyone who had not recorded a party size was travelling
        // alone, which is the precise fact this rule keys on.
        if (typeof item.party_size !== 'number') {
          return {
            skipped: `${rule.id}: party size not recorded for this item`
          };
        }
        const maxParty = p.maxPartySize ?? 1;
        if (item.party_size > maxParty) return null;
        const distKm = hasCoords(nextItem) ? haversineKm(item.lat, item.lng, nextItem.lat, nextItem.lng) : 0;
        const minKm = p.minKm ?? 1.2;
        if (distKm < minKm) return null;
        return {
          vars: {
            km: distKm.toFixed(1)
          },
          source: 'itinerary'
        };
      }
    case 'very_late_walk':
      {
        // DEFECT 2026-09-19 (guard that can never fire) — this was
        //     const afterHour = p.afterHour ?? 1;                    // rule S2: 1
        //     if (startHour < afterHour && startHour >= 6) return null; // "daytime"
        // With afterHour = 1, `startHour < 1 && startHour >= 6` is a
        // contradiction and is never true, so the daytime guard NEVER ran and
        // the rule fired for every walking item at any hour of the day. A 10am
        // museum visit was captioned "Walking after 1 AM. Consider a ride."
        // The window is now expressed properly: the small hours, from afterHour
        // until 06:00.
        if (!item.start_time) return null;
        const startHour = localHourIn(item.start_time, tz);
        if (startHour === null) {
          return {
            skipped: `${rule.id}: no timezone on this item or trip, so the local hour is unknown`
          };
        }
        const afterHour = p.afterHour ?? 1;
        const inSmallHours = startHour >= afterHour && startHour < 6;
        if (!inSmallHours) return null;
        const requiredMode = p.mode ?? 'walk';
        if ((item.transport_mode ?? null) !== requiredMode) return null;
        return {
          vars: {},
          source: 'itinerary'
        };
      }
    case 'advisory_region':
      {
        if (!item.country_code) return null;
        const advisory = context.advisories[item.country_code];
        if (!advisory) return null;
        // DEFECT 2026-09-19 (unknown treated as safest) — `(advisory.level ?? 0)`
        // scored an advisory whose level could not be parsed as level 0, the
        // safest possible value, so a country with an unreadable advisory was
        // silently treated as carrying no advisory at all. An unknown level is
        // now reported as unknown.
        if (typeof advisory.level !== 'number') {
          return {
            skipped: `${rule.id}: advisory for ${item.country_code} has no readable level`
          };
        }
        const minLevel = p.minLevel ?? 3;
        if (advisory.level < minLevel) return null;
        const staleSuffix = advisory.stale && advisory.fetched_at ? ` (advisory last retrieved ${advisory.fetched_at.slice(0, 10)})` : '';
        return {
          vars: {
            regionText: (advisory.headline || `Level ${advisory.level} advisory`) + staleSuffix
          },
          source: `advisory:${advisory.source}`
        };
      }
    case 'weather_alert':
      {
        if (!context.weatherAlerts.length) return null;
        const severityOrder = {
          extreme: 4,
          severe: 3,
          moderate: 2,
          minor: 1,
          unknown: 0
        };
        const minSev = p.minSeverity ?? 'severe';
        const minSevVal = severityOrder[minSev] ?? 3;
        const matching = context.weatherAlerts.filter((a)=>{
          const sev = a.severity?.toLowerCase() ?? 'unknown';
          return (severityOrder[sev] ?? 0) >= minSevVal;
        });
        if (!matching.length) return null;
        const alert = matching[0];
        // NOTE 2026-09-19 — rule S4 carries a maxDistanceKm parameter (30) that
        // nothing here reads: the alerts are fetched for one point and applied
        // to every item on the day regardless of how far apart they are. Left
        // alone because the adapter returns no alert geometry to measure
        // against; flagged so the unused parameter is not mistaken for a filter
        // that is being applied.
        return {
          vars: {
            alertTitle: alert.headline || alert.event
          },
          source: 'weather.gov'
        };
      }
    case 'earthquake':
      {
        if (!hasCoords(item)) return null;
        const maxDist = p.maxDistanceKm ?? 150;
        const minMag = p.minMagnitude ?? 5.0;
        const maxAgeH = p.maxAgeHours ?? 24;
        const cutoff = Date.now() - maxAgeH * 3600 * 1000;
        const matching = context.earthquakes.filter((eq)=>{
          if (typeof eq.magnitude !== 'number' || eq.magnitude < minMag) return false;
          if (new Date(eq.time).getTime() < cutoff) return false;
          const dist = haversineKm(item.lat, item.lng, eq.lat, eq.lon);
          return dist <= maxDist;
        });
        if (!matching.length) return null;
        const eq = matching.slice().sort((a, b)=>b.magnitude - a.magnitude)[0];
        const dist = haversineKm(item.lat, item.lng, eq.lat, eq.lon);
        return {
          vars: {
            magnitude: eq.magnitude.toFixed(1),
            distanceKm: Math.round(dist).toString()
          },
          source: 'usgs'
        };
      }
    case 'outdoor_after_sunset':
      {
        const cats = p.categories ?? [];
        const itemCat = (item.category ?? '').toLowerCase();
        if (!cats.some((c)=>itemCat.includes(c))) return null;
        if (!item.end_time) return null;
        // See the sunsetFor() note above: this used a hardcoded 20:00.
        if (!hasCoords(item)) {
          return {
            skipped: `${rule.id}: no coordinates on this item, so sunset cannot be computed`
          };
        }
        const end = new Date(item.end_time);
        if (!Number.isFinite(end.getTime())) return null;
        const sunset = sunsetFor(end, item.lat, item.lng);
        if (sunset.kind === 'polar_day') return null; // the sun does not set here today
        if (sunset.kind === 'polar_night') {
          return {
            vars: {
              sunsetTime: 'the sun does not rise here today'
            },
            source: 'solar'
          };
        }
        if (sunset.kind === 'unknown') {
          return {
            skipped: `${rule.id}: sunset could not be computed for this location`
          };
        }
        if (end.getTime() <= sunset.at.getTime()) return null;
        return {
          vars: {
            sunsetTime: formatTimeIn(sunset.at, tz)
          },
          source: 'solar'
        };
      }
    case 'nightlife_transit':
      {
        // Same never-firing guard as very_late_walk: with S7's afterHour of 0,
        // `endHour < 0 && endHour >= 6` is a contradiction, so this rule told
        // travellers to "plan your ride home — transit may not run after
        // midnight" about a 2pm museum visit 3 km from their next stop.
        if (!item.end_time || !hasCoords(item)) return null;
        const endHour = localHourIn(item.end_time, tz);
        if (endHour === null) {
          return {
            skipped: `${rule.id}: no timezone on this item or trip, so the local hour is unknown`
          };
        }
        const afterHour = p.afterHour ?? 0;
        const inSmallHours = endHour >= afterHour && endHour < 6;
        if (!inSmallHours) return null;
        if (!hasCoords(nextItem)) return null;
        const dist = haversineKm(item.lat, item.lng, nextItem.lat, nextItem.lng);
        const minDist = p.minDistanceKm ?? 3;
        if (dist < minDist) return null;
        return {
          vars: {},
          source: 'itinerary'
        };
      }
    case 'solo_late_walk':
      {
        if (!item.end_time || !hasCoords(item)) return null;
        // DEFECT 2026-09-19 (fabricated party size) — `item.party_size ?? 1`
        // meant this rule asserted "Walking alone at night" to anyone whose
        // itinerary item simply had no party size recorded, including groups.
        // The note is a statement about the traveller's situation; it is not
        // made unless the situation is known.
        if (typeof item.party_size !== 'number') {
          return {
            skipped: `${rule.id}: party size not recorded, so we cannot say you are alone`
          };
        }
        if (item.party_size > 1) return null;
        const endHour = localHourIn(item.end_time, tz);
        if (endHour === null) {
          return {
            skipped: `${rule.id}: no timezone on this item or trip, so the local hour is unknown`
          };
        }
        const afterHour = p.afterHour ?? 22;
        if (endHour < afterHour) return null;
        const distKm = hasCoords(nextItem) ? haversineKm(item.lat, item.lng, nextItem.lat, nextItem.lng) : 0;
        const minKm = p.minKm ?? 0.5;
        if (distKm < minKm) return null;
        return {
          vars: {},
          source: 'itinerary'
        };
      }
    case 'user_report':
      {
        if (!hasCoords(item)) return null;
        const maxDistM = p.maxDistanceM ?? 500;
        const maxAgeH = p.maxAgeHours ?? 24;
        const cutoff = Date.now() - maxAgeH * 3600 * 1000;
        const nearby = context.userReports.filter((r)=>{
          if (new Date(r.created_at).getTime() < cutoff) return false;
          const distM = haversineKm(item.lat, item.lng, r.lat, r.lng) * 1000;
          return distM <= maxDistM;
        });
        if (!nearby.length) return null;
        const report = nearby[0];
        const ageMs = Date.now() - new Date(report.created_at).getTime();
        const ageH = Math.round(ageMs / 3600000);
        const ageText = ageH < 1 ? 'just now' : `${ageH}h ago`;
        return {
          vars: {
            ageText,
            reportText: report.text.slice(0, 100)
          },
          source: 'user_report'
        };
      }
    default:
      return null;
  }
}
function evaluateRules(item, nextItem, context, rules, prefs, tripId) {
  const notes = [];
  const skipped = [];
  for (const rule of rules.filter((r)=>r.enabled)){
    if (!tipLevelAllows(prefs.tip_level, rule.tip_level_min)) continue;
    if (rule.opt_in_topic && !(prefs.opt_in_topics ?? []).includes(rule.opt_in_topic)) continue;
    const outcome = evaluateCondition(rule, item, nextItem, context);
    if (isSkip(outcome)) {
      skipped.push(`${item.id}: ${outcome.skipped}`);
      continue;
    }
    if (outcome) {
      const text = fillTemplate(rule.note_template, outcome.vars);
      try {
        checkContentGuidelines(text);
      } catch (e) {
        // DEFECT 2026-09-19 (silent suppression) — this was a bare
        // `catch { continue; }`, so a rule template containing a banned
        // phrase produced no note and left no trace anywhere. A safety note
        // being dropped needs to be visible to whoever maintains the rules.
        console.error(`[safety-intelligence] rule ${rule.id} note suppressed by content guidelines:`, e instanceof Error ? e.message : String(e));
        skipped.push(`${item.id}: ${rule.id} suppressed by content guidelines`);
        continue;
      }
      notes.push({
        id: generateId('snt_'),
        trip_id: tripId,
        item_id: item.id,
        level: rule.note_level,
        text,
        source: outcome.source,
        actions: rule.actions,
        rule_id: rule.id,
        computed_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString()
      });
    }
  }
  return {
    notes,
    skipped
  };
}
// ---------------------------------------------------------------------------
// Route: GET /briefings
// ---------------------------------------------------------------------------
async function handleBriefings(req, userId) {
  const url = new URL(req.url);
  const tripId = url.searchParams.get('tripId');
  if (!tripId) return err('MISSING_PARAM', 'tripId is required');
  // Verify trip membership (see SECURITY note above checkTripMember)
  const denied = await gate(tripId, userId);
  if (denied) return denied;
  // Get country codes from itinerary items
  const { data: items, error: itemsErr } = await supabase.from('itinerary_items').select('country_code').eq('trip_id', tripId).not('country_code', 'is', null);
  // DEFECT 2026-09-19 (failure looks like absence) — the error was discarded
  // and a failed read produced "No destination country codes found in
  // itinerary", telling the traveller there was nothing to brief them on.
  if (itemsErr) return err('DB_ERROR', itemsErr.message, 500);
  const countryCodes = [
    ...new Set((items ?? []).map((i)=>i.country_code).filter(Boolean))
  ];
  if (!countryCodes.length) {
    return json({
      briefings: [],
      message: 'No destination country codes found in itinerary'
    });
  }
  const token = req.headers.get('Authorization')?.slice(7) ?? '';
  const briefings = [];
  for (const cc of countryCodes){
    // 2026-09-25 (wave 7): own-country pairs are not fetched at all.
    const usNote = ownCountryAdvisoryNote(cc, 'US');
    const ukNote = ownCountryAdvisoryNote(cc, 'UK');
    const [usAdvisory, ukAdvisory] = await Promise.all([
      usNote ? Promise.resolve(null) : getAdvisory(cc, 'US', token),
      ukNote ? Promise.resolve(null) : getAdvisory(cc, 'UK', token)
    ]);
    const notApplicable = [
      [
        'US',
        usNote
      ],
      [
        'UK',
        ukNote
      ]
    ].filter(([, note])=>!!note).map(([source, note])=>({
        source,
        status: 'not_applicable',
        note,
        level: null,
        headline: note,
        advisoryUrl: null,
        commonIssues: [],
        regions: [],
        fetchedAt: null,
        stale: null
      }));
    if (!usAdvisory && !ukAdvisory) {
      briefings.push({
        countryCode: cc,
        status: 'unavailable',
        ...notApplicable.length ? {
          sources: notApplicable
        } : {},
        // Made explicit: this is the department's general page, not this
        // country's advisory, because we could not retrieve that.
        officialUrl: 'https://travel.state.gov',
        officialUrlIsGeneric: true
      });
      continue;
    }
    const sources = [];
    for (const adv of [
      usAdvisory,
      ukAdvisory
    ]){
      if (!adv) continue;
      sources.push({
        source: adv.source,
        status: 'ok',
        level: adv.level,
        headline: adv.headline,
        advisoryUrl: adv.advisory_url,
        commonIssues: adv.common_issues,
        regions: adv.regions_json,
        // Age is surfaced so a stale advisory is never shown as current.
        fetchedAt: adv.fetched_at ?? null,
        stale: adv.stale ?? null
      });
    }
    // Keep US-then-UK order.
    const ordered = [
      ...sources,
      ...notApplicable
    ].sort((a, b)=>(a.source === 'US' ? 0 : 1) - (b.source === 'US' ? 0 : 1));
    briefings.push({
      countryCode: cc,
      status: 'ok',
      sources: ordered
    });
  }
  return json({
    briefings
  });
}
// ---------------------------------------------------------------------------
// Route: GET /notes
// ---------------------------------------------------------------------------
async function handleNotes(req, userId) {
  const url = new URL(req.url);
  const tripId = url.searchParams.get('tripId');
  if (!tripId) return err('MISSING_PARAM', 'tripId is required');
  const dateParam = url.searchParams.get('date');
  const targetDate = dateParam ?? new Date().toISOString().split('T')[0];
  // Verify trip membership (see SECURITY note above checkTripMember)
  const denied = await gate(tripId, userId);
  if (denied) return denied;
  const { data: trip, error: tripErr } = await supabase.from('trips').select('id, primary_tz').eq('id', tripId).maybeSingle();
  if (tripErr) return err('DB_ERROR', tripErr.message, 500);
  const tripTz = trip?.primary_tz ?? null;
  // DEFECT 2026-09-19 (wrong day) — the day was selected with
  //     .gte('start_time', `${targetDate}T00:00:00.000Z`)
  //     .lte('start_time', `${targetDate}T23:59:59.999Z`)
  // an explicitly UTC window compared against a timestamptz. For any trip not
  // on UTC that is not the traveller's day: in Tokyo it runs from 09:00 on
  // the requested date to 08:59 the next morning, so a late-evening item —
  // exactly the kind the late-walk rules exist for — fell into the NEXT day's
  // query and was never evaluated for the day it belongs to.
  // itinerary_items carries an explicit `date` column; use it.
  const { data: rawItems, error: itemsErr } = await supabase.from('itinerary_items').select('*').eq('trip_id', tripId).eq('date', targetDate).order('start_time', {
    ascending: true
  });
  if (itemsErr) return err('DB_ERROR', itemsErr.message, 500);
  const items = rawItems ?? [];
  if (!items.length) {
    return json({
      notes: [],
      date: targetDate,
      // Says why there are no notes, so an empty list is never read as
      // "we checked and everything is fine".
      reason: 'Nothing is scheduled on this day, so there was nothing to check.',
      sources: {},
      skipped: []
    });
  }
  // Get user preferences
  let prefs;
  const { data: existingPrefs, error: prefsErr } = await supabase.from('safety_preferences').select('*').eq('user_id', userId).maybeSingle();
  // A failed preferences read used to fall through to the 'standard'
  // defaults, which silently overrode a traveller's choice of 'detailed'
  // and withheld the extra notes they had asked for.
  if (prefsErr) return err('DB_ERROR', prefsErr.message, 500);
  if (existingPrefs) {
    prefs = existingPrefs;
  } else {
    prefs = {
      user_id: userId,
      tip_level: 'standard',
      opt_in_topics: []
    };
  }
  // Get all enabled rules.
  //
  // DEFECT 2026-09-19 (the most dangerous discarded error in this function) —
  // this was `const { data: rules }`. If the safety_rules read failed, the
  // rule list was empty, no rule could fire, and the route answered 200 with
  // `notes: []` — which the app renders as "no safety concerns for today".
  // A broken database query told travellers their day was safe. This now
  // fails the request loudly.
  const { data: rules, error: rulesErr } = await supabase.from('safety_rules').select('*').eq('enabled', true);
  if (rulesErr) {
    return err('RULES_UNAVAILABLE', `Safety checks could not be run: ${rulesErr.message}. This does not mean there is nothing to report.`, 503);
  }
  const safetyRules = rules ?? [];
  if (safetyRules.length === 0) {
    return err('RULES_UNAVAILABLE', 'No safety rules are configured, so nothing could be checked. This does not mean there is nothing to report.', 503);
  }
  // Fetch weather alerts and earthquakes for item locations
  const token = req.headers.get('Authorization')?.slice(7) ?? '';
  const locationItems = items.filter((i)=>hasCoords(i));
  let weatherAlerts = [];
  let earthquakes = [];
  const sources = {};
  if (locationItems.length > 0) {
    const firstItem = locationItems[0];
    const [weatherRes, earthquakeRes] = await Promise.allSettled([
      callProviderAdapter(`/weather-alerts?lat=${firstItem.lat}&lon=${firstItem.lng}`, token),
      callProviderAdapter(`/earthquakes?lat=${firstItem.lat}&lon=${firstItem.lng}`, token)
    ]);
    if (weatherRes.status === 'fulfilled' && weatherRes.value.ok) {
      const wr = weatherRes.value.body;
      weatherAlerts = wr?.data?.alerts ?? [];
      sources.weather = {
        available: true,
        note: 'Checked at the first located stop of the day only.'
      };
    } else {
      const reason = weatherRes.status === 'rejected' ? String(weatherRes.reason) : weatherRes.value.reason;
      sources.weather = {
        available: false,
        reason
      };
    }
    if (earthquakeRes.status === 'fulfilled' && earthquakeRes.value.ok) {
      const er = earthquakeRes.value.body;
      earthquakes = er?.data?.earthquakes ?? [];
      sources.earthquakes = {
        available: true,
        note: 'Checked at the first located stop of the day only.'
      };
    } else {
      const reason = earthquakeRes.status === 'rejected' ? String(earthquakeRes.reason) : earthquakeRes.value.reason;
      sources.earthquakes = {
        available: false,
        reason
      };
    }
  } else {
    sources.weather = {
      available: false,
      reason: 'No stop on this day has coordinates.'
    };
    sources.earthquakes = {
      available: false,
      reason: 'No stop on this day has coordinates.'
    };
  }
  // Fetch approved user reports near item locations
  const userReports = [];
  if (locationItems.length > 0) {
    const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { data: reports, error: reportsErr } = await supabase.from('safety_reports').select('id, lat, lng, topic, text, created_at').eq('status', 'approved').gte('created_at', cutoff).gt('expires_at', new Date().toISOString()).limit(1000);
    if (reportsErr) {
      // Non-fatal, but never silent: other rules still run and the caller is
      // told this input was missing.
      console.error('[safety-intelligence] safety_reports read failed:', reportsErr.message);
      sources.travellerReports = {
        available: false,
        reason: reportsErr.message
      };
    } else {
      userReports.push(...reports ?? []);
      sources.travellerReports = {
        available: true
      };
    }
  } else {
    sources.travellerReports = {
      available: false,
      reason: 'No stop on this day has coordinates.'
    };
  }
  // Fetch advisories for country codes
  const countryCodes = [
    ...new Set(items.map((i)=>i.country_code).filter(Boolean))
  ];
  const advisories = {};
  const advisoryMisses = [];
  for (const cc of countryCodes){
    // 2026-09-25 (wave 7): no State Department advisory exists for the US.
    if (ownCountryAdvisoryNote(cc, 'US')) continue;
    const advisory = await getAdvisory(cc, 'US', token);
    if (advisory) advisories[cc] = advisory;
    else advisoryMisses.push(cc);
  }
  sources.advisories = advisoryMisses.length === 0 ? {
    available: true
  } : {
    available: false,
    reason: `No advisory could be retrieved for: ${advisoryMisses.join(', ')}`
  };
  const context = {
    weatherAlerts,
    earthquakes,
    userReports,
    advisories,
    tripTz
  };
  // Evaluate rules for each item
  const allNotes = [];
  const allSkipped = [];
  for(let i = 0; i < items.length; i++){
    const item = items[i];
    const nextItem = items[i + 1] ?? null;
    const { notes, skipped } = evaluateRules(item, nextItem, context, safetyRules, prefs, tripId);
    allNotes.push(...notes);
    allSkipped.push(...skipped);
  }
  // Persist notes.
  //
  // DEFECT 2026-09-19 (discarded error) — the upsert's result was thrown
  // away, so notes could be returned to the caller and never stored; anything
  // reading safety_notes later (a digest, a push) would see none of them.
  let persisted = true;
  let persistError = null;
  if (allNotes.length > 0) {
    const { error: upsertErr } = await supabase.from('safety_notes').upsert(allNotes, {
      onConflict: 'id'
    });
    if (upsertErr) {
      persisted = false;
      persistError = upsertErr.message;
      console.error('[safety-intelligence] safety_notes upsert failed:', upsertErr.message);
    }
  }
  return json({
    notes: allNotes,
    date: targetDate,
    // Which inputs were actually consulted, and which rules could not be
    // evaluated. An empty `notes` list means "nothing triggered among the
    // checks listed here", never "you are safe".
    sources,
    skipped: allSkipped,
    persisted,
    ...persistError ? {
      persistError
    } : {}
  });
}
// ---------------------------------------------------------------------------
// Route: POST /reports
// ---------------------------------------------------------------------------
async function handleCreateReport(req, userId) {
  let body;
  try {
    body = await req.json();
  } catch  {
    return err('INVALID_JSON', 'Request body must be valid JSON');
  }
  const { tripId, lat, lng, topic, text } = body;
  if (!tripId || typeof tripId !== 'string') return err('MISSING_PARAM', 'tripId is required');
  if (typeof lat !== 'number' || !Number.isFinite(lat)) return err('MISSING_PARAM', 'lat must be a number');
  if (typeof lng !== 'number' || !Number.isFinite(lng)) return err('MISSING_PARAM', 'lng must be a number');
  if (lat < -90 || lat > 90) return err('VALIDATION', 'lat must be between -90 and 90');
  if (lng < -180 || lng > 180) return err('VALIDATION', 'lng must be between -180 and 180');
  if (!topic || typeof topic !== 'string') return err('MISSING_PARAM', 'topic is required');
  if (!text || typeof text !== 'string') return err('MISSING_PARAM', 'text is required');
  if (text.length > 500) return err('VALIDATION', 'text must be 500 characters or less');
  const validTopics = [
    'pickpocketing',
    'protest',
    'road_closure',
    'scam',
    'other'
  ];
  if (!validTopics.includes(topic)) {
    return err('VALIDATION', `topic must be one of: ${validTopics.join(', ')}`);
  }
  // Content guidelines check
  try {
    checkContentGuidelines(text);
  } catch (e) {
    return err('CONTENT_VIOLATION', e instanceof Error ? e.message : 'Content guideline violation');
  }
  // Verify trip membership (see SECURITY note above checkTripMember)
  const denied = await gate(tripId, userId);
  if (denied) return denied;
  // Rate limit: 5 reports per user per day.
  //
  // DEFECT 2026-09-19 (a limit that fails open) — `const { count }` discarded
  // the error and `(count ?? 0) >= 5` then read a failed count as zero, so
  // whenever the check broke the limit was not applied at all. These reports
  // are shown to other travellers as safety information; an unlimited posting
  // channel is the thing the limit exists to prevent. It now fails closed.
  //
  // The day boundary is also computed in UTC (setHours on the server clock is
  // UTC here); that is a deliberate, uniform 24-hour window for rate limiting
  // rather than a claim about the traveller's local day.
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const { count, error: countErr } = await supabase.from('safety_reports').select('id', {
    count: 'exact',
    head: true
  }).eq('reporter_id', userId).gte('created_at', dayStart.toISOString());
  if (countErr) {
    console.error('[safety-intelligence] rate limit count failed:', countErr.message);
    return err('RATE_LIMIT_CHECK_FAILED', 'Could not check your daily report limit, so the report was not filed', 503);
  }
  if ((count ?? 0) >= 5) {
    return err('RATE_LIMIT', 'Maximum 5 reports per day', 429);
  }
  const report = {
    id: generateId('rpt_'),
    trip_id: tripId,
    reporter_id: userId,
    lat,
    lng,
    topic,
    text,
    status: 'pending',
    expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    created_at: new Date().toISOString()
  };
  const { data, error } = await supabase.from('safety_reports').insert(report).select().single();
  if (error) {
    console.error('[safety-intelligence] insert report error:', error);
    return err('DB_ERROR', 'Failed to create report', 500);
  }
  return json({
    report: data
  }, 201);
}
// ---------------------------------------------------------------------------
// Route: GET /preferences
// ---------------------------------------------------------------------------
async function handleGetPreferences(_req, userId) {
  const { data, error } = await supabase.from('safety_preferences').select('*').eq('user_id', userId).maybeSingle();
  // DEFECT 2026-09-19 (failure looks like absence) — the error was discarded
  // and a failed read fell into the "create default" branch below, which
  // showed the traveller the default settings as though they were theirs and
  // would have overwritten their real ones on the next save.
  if (error) return err('DB_ERROR', error.message, 500);
  if (data) return json({
    preferences: data,
    isDefault: false
  });
  // Create default
  const defaults = {
    user_id: userId,
    tip_level: 'standard',
    opt_in_topics: []
  };
  const { error: insErr } = await supabase.from('safety_preferences').insert(defaults);
  if (insErr) {
    console.error('[safety-intelligence] default preferences insert failed:', insErr.message);
  }
  return json({
    preferences: defaults,
    isDefault: true,
    persisted: !insErr
  });
}
// ---------------------------------------------------------------------------
// Route: PUT /preferences
// ---------------------------------------------------------------------------
async function handleUpdatePreferences(req, userId) {
  let body;
  try {
    body = await req.json();
  } catch  {
    return err('INVALID_JSON', 'Request body must be valid JSON');
  }
  const updates = {
    user_id: userId
  };
  if (body.tipLevel !== undefined) {
    const validLevels = [
      'minimal',
      'standard',
      'detailed'
    ];
    if (!validLevels.includes(body.tipLevel)) {
      return err('VALIDATION', `tipLevel must be one of: ${validLevels.join(', ')}`);
    }
    updates.tip_level = body.tipLevel;
  }
  if (body.optInTopics !== undefined) {
    if (!Array.isArray(body.optInTopics)) {
      return err('VALIDATION', 'optInTopics must be an array');
    }
    if (!body.optInTopics.every((t)=>typeof t === 'string')) {
      return err('VALIDATION', 'optInTopics must be an array of strings');
    }
    updates.opt_in_topics = body.optInTopics;
  }
  if (Object.keys(updates).length === 1) {
    return err('VALIDATION', 'Provide tipLevel and/or optInTopics');
  }
  const { data, error } = await supabase.from('safety_preferences').upsert(updates, {
    onConflict: 'user_id'
  }).select().single();
  if (error) {
    console.error('[safety-intelligence] upsert preferences error:', error);
    return err('DB_ERROR', 'Failed to update preferences', 500);
  }
  return json({
    preferences: data
  });
}
// ---------------------------------------------------------------------------
// Route: GET /admin/reports
// ---------------------------------------------------------------------------
async function handleAdminListReports(req) {
  const url = new URL(req.url);
  const status = url.searchParams.get('status') ?? 'pending';
  const validStatuses = [
    'pending',
    'approved',
    'rejected'
  ];
  if (!validStatuses.includes(status)) {
    return err('VALIDATION', `status must be one of: ${validStatuses.join(', ')}`);
  }
  const { data, error } = await supabase.from('safety_reports').select('*').eq('status', status).order('created_at', {
    ascending: false
  });
  if (error) return err('DB_ERROR', 'Failed to fetch reports', 500);
  return json({
    reports: data ?? []
  });
}
// ---------------------------------------------------------------------------
// Route: POST /admin/reports/:id/approve and /reject
// ---------------------------------------------------------------------------
//
// DEFECT 2026-09-19 (failure looks like absence) — both handlers ended with
//     if (error || !data) return err('NOT_FOUND', 'Report not found', 404);
// so a moderator whose approval failed for any reason was told the report did
// not exist. A report sitting unapproved never reaches other travellers, and
// a moderator told "not found" has no reason to retry.
async function handleAdminSetReportStatus(reportId, status) {
  const { data, error } = await supabase.from('safety_reports').update({
    status
  }).eq('id', reportId).select().maybeSingle();
  if (error) return err('DB_ERROR', error.message, 500);
  if (!data) return err('NOT_FOUND', 'Report not found', 404);
  return json({
    report: data
  });
}
// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS
    });
  }
  const url = new URL(req.url);
  const rawPath = url.pathname.replace(/^\/safety-intelligence/, '').replace(/^\/?/, '/');
  // Admin routes — service key auth
  if (rawPath.startsWith('/admin/')) {
    if (!isServiceKey(req)) {
      return err('UNAUTHORIZED', 'Service key required', 401);
    }
    if (req.method === 'GET' && rawPath === '/admin/reports') {
      return handleAdminListReports(req);
    }
    const approveMatch = rawPath.match(/^\/admin\/reports\/([^/]+)\/approve$/);
    if (req.method === 'POST' && approveMatch) {
      return handleAdminSetReportStatus(approveMatch[1], 'approved');
    }
    const rejectMatch = rawPath.match(/^\/admin\/reports\/([^/]+)\/reject$/);
    if (req.method === 'POST' && rejectMatch) {
      return handleAdminSetReportStatus(rejectMatch[1], 'rejected');
    }
    return err('NOT_FOUND', 'Admin route not found', 404);
  }
  // JWT auth for all other routes
  const user = await authenticate(req);
  if (!user) return err('UNAUTHORIZED', 'Valid JWT required', 401);
  try {
    if (req.method === 'GET' && rawPath === '/briefings') {
      return handleBriefings(req, user.userId);
    }
    if (req.method === 'GET' && rawPath === '/notes') {
      return handleNotes(req, user.userId);
    }
    if (req.method === 'POST' && rawPath === '/reports') {
      return handleCreateReport(req, user.userId);
    }
    if (req.method === 'GET' && rawPath === '/preferences') {
      return handleGetPreferences(req, user.userId);
    }
    if (req.method === 'PUT' && rawPath === '/preferences') {
      return handleUpdatePreferences(req, user.userId);
    }
    return err('NOT_FOUND', 'Route not found', 404);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[safety-intelligence] unhandled error:', msg, e);
    return err('INTERNAL_ERROR', 'Internal server error', 500);
  }
});

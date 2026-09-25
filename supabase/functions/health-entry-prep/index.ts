// 2026-09-25 — domestic trips and overdue items (wave 7).
// Live test on a US traveller's Las Vegas trip: GET /prep/me listed
// "Check your passport validity — US", "Visa requirements — US" and a travel
// health clinic consultation for a domestic trip, and showed due dates that
// had already passed ("By Sep 2, 2026" on Sep 25) as if still upcoming.
//
// Home country. No table holds a traveller's country, nationality or
// citizenship (checked information_schema 2026-09-25: platform_users has
// only home_currency and home_tz; profiles, traveler_profiles and
// user_recommendation_profiles have nothing usable). platform_users.home_currency
// defaults to 'USD' and home_tz to 'UTC' for every account, so neither alone
// proves anything, and treating a default as a fact would silently drop a
// British traveller's ESTA / visa reminders for a US trip. The home country
// is therefore taken, in order, from:
//   1. ?homeCountry=XX on the request (explicit; ISO 3166-1 alpha-2), then
//   2. platform_users.home_currency mapped to the one country that uses it
//      (USD→US, GBP→GB, CAD→CA, AUD→AU, NZD→NZ, JPY→JP, CHF→CH, INR→IN,
//      SGD→SG, MXN→MX), accepted ONLY when corroborated by a timezone in
//      that country: the ?homeTz= the client sends (the browser's zone) or a
//      non-default platform_users.home_tz.
// Otherwise the home country is unknown and the checklist is unchanged.
//
// When the home country is known and equals a destination:
//   * passport_validity, authorization, visa_check and health_consult items
//     are not generated for that destination, and existing ones are left in
//     the table (statuses untouched) but omitted from the response;
//   * travel insurance, medications, emergency numbers, jet-lag and altitude
//     items stay.
// Every returned item gains `overdue` (true when status is 'todo' and its
// due_date is before today in the traveller's home zone — ?homeTz= or UTC);
// nothing is hidden for being late. The response gains `homeCountry`,
// `homeCountrySource`, `omittedAsDomestic` and `asOf`. Fields added only.
//
// 2026-09-25 — prep checklist follows the trip's countries (wave 6b).
// GET /prep/me built a member's checklist once and returned it unchanged
// forever: a country added to the trip afterwards got no passport / entry /
// vaccination / emergency-number items and nothing said so (see the NOTE that
// used to sit in handleGetMyPrep). Now, when prep items already exist, the
// trip's current countries are recomputed and items are generated and
// inserted ONLY for countries that have no items yet (by destination_code).
// Nothing is deleted or rewritten, so every status the member set is kept;
// items for a country that has since left the trip are left in place.
// Response adds `addedDestinations` when this happens. supabase-js import
// switched from jsr: to esm.sh (standing rule).
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
// CORS 2026-09-20 -- this file had no Access-Control-Allow-* headers
// anywhere and no OPTIONS handling at all. A preflight (sent by the browser
// whenever the real request carries Authorization/apikey) fell through to
// the JWT auth check with no Authorization header, got 401, and even a 2xx
// response here would have been blocked client-side for lacking CORS
// headers.
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS'
};
// SECURITY 2026-09-17 — Every trip-membership check in this file (prep/me,
// prep/summary, prep/destinations/:code, prep/changes) compared
// trip_members.user_id directly against the caller's Supabase auth.uid().
// trip_members.user_id is a foreign key to platform_users.id — a separate,
// prefixed TEXT id space, never equal to the auth uuid. The comparison could
// never match, so the check silently denied every real member (fail-closed:
// no cross-user data was ever returned, but the feature was fully broken).
// It also means the check gave no real ownership guarantee at all — had the
// two id spaces ever overlapped for a given deployment, or had this pattern
// been copied into a check that treats "no row" as "allow" instead of "deny"
// (that exact bug was live in agreement-engine), it would silently have let
// any caller into any trip. Fixed by bridging through
// auth_identities.provider_subject (which stores auth.uid() as text) to the
// caller's platform_users.id, then checking trip_members with that id.
//
// DEFECT 2026-09-19 (GET /prep/me has never once succeeded) — two separate
// causes, both invisible:
//
//  (a) every read and write below the membership gate used `supabase`, the
//      ANON client carrying the caller's JWT, so RLS applied to all of it:
//        * prep_items has RLS enabled with a SELECT policy and an UPDATE
//          policy and NO INSERT POLICY AT ALL, so the insert of freshly
//          generated prep items was refused with 42501 and the route
//          answered 500 for every user on every trip. prep_items is empty;
//        * trips' only policy is `auth.uid() = user_id`, so any trip MEMBER
//          who is not the trip's owner read `trip` as null and was told
//          'Trip not found' — on a trip they belong to.
//      All data access now goes through the service client, AFTER the
//      membership gate, which is what authorises it.
//
//  (b) prep_items.member_id was written as the caller's auth uuid, but the
//      table's own UPDATE policy is
//        member_id = private.current_platform_user_id()
//      i.e. the platform "usr_<hex>" id. So even had the insert succeeded,
//      PATCH /prep/me/:itemId would have matched zero rows and answered
//      'Prep item not found' forever. Unlike the other TEXT member_id
//      columns in this codebase, the database settles this one: member_id
//      holds the PLATFORM user id, and that is what is written now.
async function resolvePlatformUserId(service, authUserId) {
  const { data, error } = await service.from('auth_identities').select('user_id').eq('provider_subject', authUserId).maybeSingle();
  if (error) {
    console.error('[health-entry-prep] auth_identities lookup failed:', error.message);
    return {
      failed: error.message
    };
  }
  return {
    id: data?.user_id ?? null
  };
}
async function getTripMember(service, tripId, authUserId) {
  const resolved = await resolvePlatformUserId(service, authUserId);
  if ('failed' in resolved) return {
    failed: resolved.failed
  };
  if (!resolved.id) return {
    notMember: true
  };
  const { data: member, error } = await service.from('trip_members').select('id, role').eq('trip_id', tripId).eq('user_id', resolved.id).is('removed_at', null).maybeSingle();
  if (error) {
    console.error('[health-entry-prep] trip_members membership lookup failed:', error.message);
    return {
      failed: error.message
    };
  }
  if (!member) return {
    notMember: true
  };
  return {
    member: {
      id: member.id,
      role: member.role ?? null
    },
    platformUserId: resolved.id
  };
}
// SECURITY 2026-09-17 — the internal /prep/scan route compared the caller's
// x-service-key header to the real service-role key with `!==`, a
// variable-time comparison. Switched to a constant-time compare so response
// timing can't be used to recover the key byte-by-byte.
function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for(let i = 0; i < len; i++)diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}
// ─── ULID-like ID generator ──────────────────────────────────
// DEFECT 2026-09-19 — was `Math.random().toString(36).slice(2, 10)` on a
// millisecond timestamp: not a CSPRNG, and two rows created in the same
// millisecond collide on a primary key with ~8 base36 characters of entropy.
function makeId(prefix) {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return `${prefix}${Array.from(bytes).map((b)=>b.toString(16).padStart(2, '0')).join('')}`;
}
// ─── Simple SHA-256 hash ─────────────────────────────────────────
async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b)=>b.toString(16).padStart(2, '0')).join('');
}
// ─── Date helpers ──────────────────────────────────────────────
function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
function addMonths(dateStr, months) {
  const d = new Date(dateStr);
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}
function daysBetween(a, b) {
  return Math.floor((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
}
function isStale(reviewedAt, days = 365) {
  if (!reviewedAt) return null;
  const t = new Date(reviewedAt).getTime();
  if (!Number.isFinite(t)) return null;
  return Date.now() - t > days * 86400000;
}
// ─── Timezone offset diff (hours) ──────────────────────────────────
// DEFECT 2026-09-19 (failure returns a real-looking 0) — the catch returned
// 0, which generateJetlagPlan reads as "no time zones crossed" and therefore
// "no jet lag". An unparseable timezone silently removed the jet-lag plan.
// Returns null now.
function tzOffsetDiff(fromTz, toTz) {
  try {
    const now = new Date();
    const fmt = (tz)=>{
      const s = now.toLocaleString('en-US', {
        timeZone: tz,
        timeZoneName: 'shortOffset'
      });
      const m = s.match(/GMT([+-]\d+(?::\d+)?)/);
      if (!m) return s.includes('GMT') ? 0 : null;
      const parts = m[1].split(':');
      const hours = parseInt(parts[0]);
      if (!Number.isFinite(hours)) return null;
      return hours + (parts[1] ? parseInt(parts[1]) / 60 * Math.sign(hours || 1) : 0);
    };
    const a = fmt(fromTz);
    const b = fmt(toTz);
    if (a === null || b === null) return null;
    return b - a;
  } catch  {
    return null;
  }
}
function isValidTz(tz) {
  try {
    new Intl.DateTimeFormat('en-GB', {
      timeZone: tz
    });
    return true;
  } catch  {
    return false;
  }
}
// ─── Country centroid lookup (approximate) ────────────────────────
//
// NOTE 2026-09-19 — these are ONLY used as a last-resort location for the
// weather and air-quality panels on GET /prep/destinations, where the caller
// is explicitly told the reading is for the country centroid. They are no
// longer used for altitude (see checkAltitudeForItems) or for the jet-lag
// plan's destination timezone: a single centroid timezone is simply wrong for
// the US, Brazil, Australia, Russia, Canada and Indonesia, and a single
// centroid elevation is wrong for any country with mountains — Peru's
// centroid sits in the Amazon at ~200 m, so a traveller flying to Cusco at
// 3400 m got no altitude warning at all, while Chile's centroid sits in the
// Andes, so a traveller to Santiago at 500 m was warned about altitude
// sickness they were never going to have.
const COUNTRY_CENTROIDS = {
  US: {
    lat: 37.09,
    lng: -95.71,
    tz: 'America/New_York'
  },
  GB: {
    lat: 55.38,
    lng: -3.44,
    tz: 'Europe/London'
  },
  FR: {
    lat: 46.23,
    lng: 2.21,
    tz: 'Europe/Paris'
  },
  DE: {
    lat: 51.17,
    lng: 10.45,
    tz: 'Europe/Berlin'
  },
  ES: {
    lat: 40.46,
    lng: -3.75,
    tz: 'Europe/Madrid'
  },
  IT: {
    lat: 41.87,
    lng: 12.57,
    tz: 'Europe/Rome'
  },
  PT: {
    lat: 39.40,
    lng: -8.22,
    tz: 'Europe/Lisbon'
  },
  JP: {
    lat: 36.20,
    lng: 138.25,
    tz: 'Asia/Tokyo'
  },
  TH: {
    lat: 15.87,
    lng: 100.99,
    tz: 'Asia/Bangkok'
  },
  AU: {
    lat: -25.27,
    lng: 133.78,
    tz: 'Australia/Sydney'
  },
  NZ: {
    lat: -40.90,
    lng: 174.89,
    tz: 'Pacific/Auckland'
  },
  CA: {
    lat: 56.13,
    lng: -106.35,
    tz: 'America/Toronto'
  },
  MX: {
    lat: 23.63,
    lng: -102.55,
    tz: 'America/Mexico_City'
  },
  BR: {
    lat: -14.24,
    lng: -51.93,
    tz: 'America/Sao_Paulo'
  },
  IN: {
    lat: 20.59,
    lng: 78.96,
    tz: 'Asia/Kolkata'
  },
  SG: {
    lat: 1.35,
    lng: 103.82,
    tz: 'Asia/Singapore'
  },
  GR: {
    lat: 39.07,
    lng: 21.82,
    tz: 'Europe/Athens'
  },
  NL: {
    lat: 52.13,
    lng: 5.29,
    tz: 'Europe/Amsterdam'
  },
  BE: {
    lat: 50.50,
    lng: 4.47,
    tz: 'Europe/Brussels'
  },
  CH: {
    lat: 46.82,
    lng: 8.23,
    tz: 'Europe/Zurich'
  },
  NP: {
    lat: 28.39,
    lng: 84.12,
    tz: 'Asia/Kathmandu'
  },
  PE: {
    lat: -9.19,
    lng: -75.02,
    tz: 'America/Lima'
  },
  BO: {
    lat: -16.29,
    lng: -63.59,
    tz: 'America/La_Paz'
  },
  CN: {
    lat: 35.86,
    lng: 104.20,
    tz: 'Asia/Shanghai'
  },
  KR: {
    lat: 35.91,
    lng: 127.77,
    tz: 'Asia/Seoul'
  },
  ZA: {
    lat: -30.56,
    lng: 22.94,
    tz: 'Africa/Johannesburg'
  },
  KE: {
    lat: -0.02,
    lng: 37.91,
    tz: 'Africa/Nairobi'
  },
  MA: {
    lat: 31.79,
    lng: -7.09,
    tz: 'Africa/Casablanca'
  },
  EG: {
    lat: 26.82,
    lng: 30.80,
    tz: 'Africa/Cairo'
  },
  TR: {
    lat: 38.96,
    lng: 35.24,
    tz: 'Europe/Istanbul'
  },
  AE: {
    lat: 23.42,
    lng: 53.85,
    tz: 'Asia/Dubai'
  },
  ID: {
    lat: -0.79,
    lng: 113.92,
    tz: 'Asia/Jakarta'
  },
  VN: {
    lat: 14.06,
    lng: 108.28,
    tz: 'Asia/Ho_Chi_Minh'
  },
  PH: {
    lat: 12.88,
    lng: 121.77,
    tz: 'Asia/Manila'
  },
  MY: {
    lat: 4.21,
    lng: 101.98,
    tz: 'Asia/Kuala_Lumpur'
  },
  AR: {
    lat: -38.42,
    lng: -63.62,
    tz: 'America/Argentina/Buenos_Aires'
  },
  CL: {
    lat: -35.68,
    lng: -71.54,
    tz: 'America/Santiago'
  },
  CO: {
    lat: 4.57,
    lng: -74.30,
    tz: 'America/Bogota'
  }
};
const FALLBACK_URLS = {
  US: 'https://travel.state.gov',
  GB: 'https://www.gov.uk/foreign-travel-advice'
};
// ─── Entry requirements fetching ──────────────────────────
//
// NOTE 2026-09-19 (dead code) — fetchEntryRequirements() has no callers
// anywhere in this file. Nothing else writes entry_requirements either
// (handleScan only UPDATEs rows that already exist), so the table is empty
// and will stay empty: every prep item that reads it — the visa check, the
// travel-authorisation item, the source links — falls back to its generic
// text for every destination, forever. Left in place rather than deleted
// because it is the intended implementation, but see the warning on
// fetchGOVUK before wiring it up.
async function fetchEntryRequirements(nationality, destination, supabase) {
  // Check cache first (< 24h old)
  const { data: cached, error: cachedLookupError } = await supabase.from('entry_requirements').select('*').eq('nationality', nationality).eq('destination', destination).gte('fetched_at', new Date(Date.now() - 24 * 3600 * 1000).toISOString()).order('fetched_at', {
    ascending: false
  }).limit(1).maybeSingle();
  if (cachedLookupError) {
    console.error('[health-entry-prep] entry_requirements cache lookup failed:', cachedLookupError.message);
  }
  if (cached) {
    return {
      source: cached.source,
      summary: cached.summary,
      passportValidityRule: cached.passport_validity_rule,
      authorizationInfo: cached.authorization_info,
      visaNote: cached.visa_note,
      officialUrl: cached.official_url,
      updatedAtSource: cached.updated_at_source
    };
  }
  // Try live fetch via provider-adapters
  let entryData = null;
  try {
    if (nationality === 'GB') {
      entryData = await fetchGOVUK(destination);
    } else if (nationality === 'US') {
      entryData = await fetchUSDOS(destination);
    }
  } catch (e) {
    console.error('Entry requirements fetch error:', e);
  }
  if (!entryData) {
    entryData = {
      source: 'FALLBACK',
      summary: [],
      passportValidityRule: null,
      authorizationInfo: null,
      visaNote: null,
      officialUrl: FALLBACK_URLS[nationality] || 'https://www.iatatravelcentre.com',
      updatedAtSource: null
    };
  }
  // Cache result
  const hash = await sha256(JSON.stringify(entryData.summary));
  const id = makeId('er_');
  const { error: entryRequirementsUpsertError } = await supabase.from('entry_requirements').upsert({
    id,
    nationality,
    destination,
    source: entryData.source,
    summary: entryData.summary,
    passport_validity_rule: entryData.passportValidityRule,
    authorization_info: entryData.authorizationInfo,
    visa_note: entryData.visaNote,
    official_url: entryData.officialUrl,
    content_hash: hash,
    fetched_at: new Date().toISOString(),
    updated_at_source: entryData.updatedAtSource
  }, {
    onConflict: 'nationality,destination,source'
  });
  if (entryRequirementsUpsertError) {
    console.error('[health-entry-prep] entry_requirements cache upsert failed:', entryRequirementsUpsertError.message);
  }
  return entryData;
}
// WARNING 2026-09-19 — this strips the tags off a GOV.UK page, splits the
// remaining text on full stops, and keeps six fragments that happen to match
// /passport|visa|entry|valid|require|permit|authoris/. Those fragments are
// then stored and shown to the traveller as that country's entry
// requirements. Nothing distinguishes a genuine requirement from a cookie
// banner, a navigation label, a caveat, or half of a sentence whose negation
// fell on the other side of a full stop — "You do not need a visa" and "You
// need a visa" both match. Before this is wired to anything, the output must
// be labelled in the UI as an unverified extract shown beside the official
// link, or replaced with a parser that targets the page's actual structure.
async function fetchGOVUK(destination) {
  const countrySlug = destination.toLowerCase();
  const url = `https://www.gov.uk/foreign-travel-advice/${countrySlug}/entry-requirements`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'TravelOS/1.0'
    }
  });
  if (!res.ok) throw new Error(`GOV.UK ${res.status}`);
  const html = await res.text();
  // Extract key sentences from the page (simplified extraction)
  const textContent = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const sentences = textContent.split(/\.(?=\s)/).map((s)=>s.trim()).filter((s)=>s.length > 40 && s.length < 300).filter((s)=>/passport|visa|entry|valid|require|permit|authoris/i.test(s)).slice(0, 6);
  return {
    source: 'GOVUK',
    summary: sentences,
    passportValidityRule: null,
    authorizationInfo: null,
    visaNote: null,
    officialUrl: url,
    updatedAtSource: null
  };
}
async function fetchUSDOS(destination) {
  // US State Dept travel info page
  const countryMap = {
    GB: 'united-kingdom',
    FR: 'france',
    DE: 'germany',
    ES: 'spain',
    IT: 'italy',
    JP: 'japan',
    TH: 'thailand',
    AU: 'australia',
    MX: 'mexico',
    CA: 'canada',
    BR: 'brazil',
    IN: 'india',
    SG: 'singapore',
    GR: 'greece',
    NL: 'netherlands',
    PT: 'portugal',
    NZ: 'new-zealand',
    BE: 'belgium',
    CH: 'switzerland',
    AE: 'united-arab-emirates',
    TR: 'turkey',
    ZA: 'south-africa',
    KE: 'kenya',
    MA: 'morocco',
    EG: 'egypt',
    CN: 'china',
    KR: 'south-korea',
    VN: 'vietnam',
    ID: 'indonesia',
    PH: 'philippines',
    MY: 'malaysia'
  };
  const slug = countryMap[destination];
  if (!slug) throw new Error(`No USDOS slug for ${destination}`);
  const url = `https://travel.state.gov/content/travel/en/international-travel/International-Travel-Country-Information-Pages/${slug}.html`;
  return {
    source: 'USDOS',
    summary: [
      `Check the official US State Department page for ${destination} entry requirements.`
    ],
    passportValidityRule: null,
    authorizationInfo: null,
    visaNote: null,
    officialUrl: url,
    updatedAtSource: null
  };
}
// ─── Passport validity check ────────────────────────────────
function checkPassportValidity(expiryDate, departureDate, returnDate, rule) {
  if (!rule) {
    return {
      status: 'warning',
      detail: "Some countries require 6 months' validity beyond arrival — check the official page."
    };
  }
  const referenceDate = rule.monthsBeyond === 'return' && returnDate ? returnDate : departureDate;
  const requiredExpiry = addMonths(referenceDate, rule.months);
  if (new Date(expiryDate) < new Date(requiredExpiry)) {
    return {
      status: 'blocking',
      detail: `Passport expires before the required date (${requiredExpiry}). Rule: "${rule.sourceText}"`
    };
  }
  const daysUntilExpiry = daysBetween(new Date().toISOString().slice(0, 10), expiryDate);
  if (daysUntilExpiry < 180) {
    return {
      status: 'warning',
      detail: `Passport valid but expires in ${daysUntilExpiry} days. Rule: "${rule.sourceText}"`
    };
  }
  return {
    status: 'ok',
    detail: `Valid for ${rule.months} months beyond ${rule.monthsBeyond}. Rule: "${rule.sourceText}"`
  };
}
// ─── Altitude check ────────────────────────────────────────
// DEFECT 2026-09-19 (failure returns a real-looking 0) — this used to
// `return 0` from its catch and from a missing field. Zero metres is sea
// level, a perfectly plausible answer, and `elevation > 2500` is then false,
// so a failed elevation lookup silently meant "no altitude concern" — and
// GET /prep/destinations reported `altitudeMeters: 0, highAltitude: false` as
// though it had measured it. Returns null now, and every caller distinguishes
// "low" from "unknown".
async function checkAltitude(lat, lng) {
  try {
    const res = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lng}`);
    if (!res.ok) {
      console.error(`[health-entry-prep] elevation lookup returned ${res.status}`);
      return null;
    }
    const data = await res.json();
    const e = data?.elevation?.[0];
    return typeof e === 'number' && Number.isFinite(e) ? e : null;
  } catch (e) {
    console.error('[health-entry-prep] elevation lookup threw:', e);
    return null;
  }
}
// Highest elevation among the actual places on the itinerary for a country —
// see the note on COUNTRY_CENTROIDS for why the centroid is not used.
async function highestElevationForPoints(points) {
  const sample = points.slice(0, 12);
  const results = await Promise.all(sample.map((p)=>checkAltitude(p.lat, p.lng)));
  const measured = results.filter((r)=>r !== null);
  return {
    meters: measured.length ? Math.max(...measured) : null,
    measured: measured.length,
    total: points.length
  };
}
// ─── Jet-lag plan ────────────────────────────────────────
function generateJetlagPlan(departureTz, destinationTz) {
  const diff = tzOffsetDiff(departureTz, destinationTz);
  if (diff === null) return null;
  const shiftHours = Math.abs(diff);
  if (shiftHours < 3) return null;
  const direction = diff > 0 ? 'east' : 'west';
  const tips = [
    `You are crossing ~${shiftHours} time zones heading ${direction} (${departureTz} → ${destinationTz}).`
  ];
  if (direction === 'east') {
    tips.push(`3 days before departure, try sleeping 1 hour earlier each night.`, `On arrival, stay awake until local bedtime (10–11 pm).`, `Use bright light exposure in the morning at your destination.`, `Avoid naps longer than 20 minutes on arrival day.`);
  } else {
    tips.push(`3 days before departure, try sleeping 1 hour later each night.`, `On arrival, stay awake until local bedtime even if tired.`, `Use bright light exposure in the evening at your destination.`, `Short naps (20 min) in the early afternoon can help.`);
  }
  tips.push('These are general wellness tips, not medical advice. Consult your doctor if you have health concerns.');
  return {
    shiftHours,
    direction,
    tips
  };
}
// ─── Home country (2026-09-25, wave 7) ──────────────────────────────
// See the header note: explicit request param first, then home_currency
// corroborated by a timezone in the same country. Never a default alone.
const CURRENCY_HOME_COUNTRY = {
  USD: 'US',
  GBP: 'GB',
  CAD: 'CA',
  AUD: 'AU',
  NZD: 'NZ',
  JPY: 'JP',
  CHF: 'CH',
  INR: 'IN',
  SGD: 'SG',
  MXN: 'MX'
};
const US_TZ = /^(America\/(New_York|Detroit|Chicago|Denver|Boise|Phoenix|Los_Angeles|Anchorage|Juneau|Sitka|Metlakatla|Yakutat|Nome|Adak|Menominee|Indiana\/[A-Za-z_]+|Kentucky\/[A-Za-z_]+|North_Dakota\/[A-Za-z_]+)|Pacific\/Honolulu|US\/[A-Za-z_-]+)$/;
const CA_TZ = /^(America\/(Toronto|Vancouver|Edmonton|Winnipeg|Halifax|St_Johns|Regina|Swift_Current|Moncton|Glace_Bay|Goose_Bay|Whitehorse|Dawson|Dawson_Creek|Fort_Nelson|Creston|Iqaluit|Rankin_Inlet|Resolute|Cambridge_Bay|Inuvik|Atikokan|Blanc-Sablon)|Canada\/[A-Za-z_-]+)$/;
const TZ_COUNTRY_TESTS = {
  US: (tz)=>US_TZ.test(tz),
  CA: (tz)=>CA_TZ.test(tz),
  GB: (tz)=>tz === 'Europe/London' || tz === 'GB',
  AU: (tz)=>/^Australia\//.test(tz),
  NZ: (tz)=>tz === 'Pacific/Auckland' || tz === 'Pacific/Chatham' || tz === 'NZ',
  JP: (tz)=>tz === 'Asia/Tokyo' || tz === 'Japan',
  CH: (tz)=>tz === 'Europe/Zurich',
  IN: (tz)=>tz === 'Asia/Kolkata' || tz === 'Asia/Calcutta',
  SG: (tz)=>tz === 'Asia/Singapore' || tz === 'Singapore',
  MX: (tz)=>/^America\/(Mexico_City|Cancun|Merida|Monterrey|Matamoros|Chihuahua|Ciudad_Juarez|Ojinaga|Mazatlan|Bahia_Banderas|Hermosillo|Tijuana)$/.test(tz)
};
// Items that only make sense when crossing a border (or, for the clinic
// consultation, when travelling abroad).
const INTERNATIONAL_ONLY_KINDS = new Set([
  'passport_validity',
  'authorization',
  'visa_check',
  'health_consult'
]);
async function resolveHomeCountry(service, platformUserId, homeCountryParam, requestTz) {
  if (homeCountryParam) return {
    country: homeCountryParam,
    source: 'request'
  };
  const { data, error } = await service.from('platform_users').select('home_currency, home_tz').eq('id', platformUserId).maybeSingle();
  if (error) {
    console.error('[health-entry-prep] platform_users home lookup failed:', error.message);
    return {
      country: null,
      source: null
    };
  }
  const currency = String(data?.home_currency ?? '').trim().toUpperCase();
  const candidate = CURRENCY_HOME_COUNTRY[currency];
  if (!candidate) return {
    country: null,
    source: null
  };
  const test = TZ_COUNTRY_TESTS[candidate];
  const profileTz = typeof data?.home_tz === 'string' && data.home_tz !== 'UTC' ? data.home_tz : null;
  if (requestTz && test(requestTz)) return {
    country: candidate,
    source: 'home_currency+request_tz'
  };
  if (profileTz && test(profileTz)) return {
    country: candidate,
    source: 'home_currency+home_tz'
  };
  return {
    country: null,
    source: null
  };
}
function todayIn(tz) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz ?? 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date());
  } catch  {
    return new Date().toISOString().slice(0, 10);
  }
}
// ─── Prep item generation ────────────────────────────────
async function generatePrepItems(destinations, pointsByCountry, tzByCountry, departureDate, _returnDate, homeTz, service, homeCountry = null) {
  const allItems = [];
  const notes = [];
  for (const destCode of destinations){
    // 2026-09-25 (wave 7): a trip within the traveller's own country gets no
    // passport / authorisation / visa / travel-clinic items.
    const domestic = !!homeCountry && destCode.toUpperCase() === homeCountry;
    const items = [];
    // Fetch entry requirements (best-effort, nationality unknown without profile)
    let entryData = null;
    const { data: anyEntry, error: anyEntryError } = await service.from('entry_requirements').select('*').eq('destination', destCode).order('fetched_at', {
      ascending: false
    }).limit(1).maybeSingle();
    if (anyEntryError) {
      console.error(`[health-entry-prep] entry_requirements lookup failed for ${destCode}:`, anyEntryError.message);
      notes.push(`${destCode}: entry requirements could not be read (${anyEntryError.message}).`);
    }
    if (anyEntry) {
      entryData = {
        source: anyEntry.source,
        summary: anyEntry.summary,
        passportValidityRule: anyEntry.passport_validity_rule,
        authorizationInfo: anyEntry.authorization_info,
        visaNote: anyEntry.visa_note,
        officialUrl: anyEntry.official_url,
        updatedAtSource: anyEntry.updated_at_source
      };
    }
    // 1. Passport validity.
    //
    // DEFECT 2026-09-19 (a check that never checked anything) — this was:
    //     const passportCheck = checkPassportValidity('', departureDate, returnDate, null);
    // called with an EMPTY passport expiry date and a NULL validity rule, on
    // every destination for every traveller. With rule === null the function
    // returns the same fixed sentence every time, so the item rendered as
    // "Passport validity — FR" at severity `important` with a status derived
    // from nothing. Nobody's passport was ever looked at, and nothing in this
    // database holds a passport expiry date to look at (profiles has id,
    // email, name, avatar_url, phone and push token, and nothing else). The
    // item now says plainly that it is a reminder rather than a check, so a
    // traveller cannot read a green tick as "my passport has been verified".
    const passportRule = entryData?.passportValidityRule ?? null;
    items.push({
      kind: 'passport_validity',
      title: `Check your passport validity — ${destCode}`,
      detail: passportRule ? `Not checked for you — TravelOS does not hold your passport expiry date. ${destCode} requires ${passportRule.months} months' validity beyond ${passportRule.monthsBeyond}. Rule: "${passportRule.sourceText}". Compare that against your own passport.` : `Not checked for you — TravelOS does not hold your passport expiry date, and no validity rule has been retrieved for ${destCode}. Many countries require six months' validity beyond arrival; confirm on the official page.`,
      dueDate: addDays(departureDate, -60),
      sourceUrl: entryData?.officialUrl,
      severity: 'important',
      destinationCode: destCode
    });
    // 2. Authorization (e.g. ETA, ESTA)
    if (entryData?.authorizationInfo) {
      items.push({
        kind: 'authorization',
        title: `Travel authorisation required — ${destCode}`,
        detail: JSON.stringify(entryData.authorizationInfo),
        dueDate: addDays(departureDate, -30),
        sourceUrl: entryData.officialUrl,
        severity: 'important',
        destinationCode: destCode
      });
    }
    // 3. Visa check
    items.push({
      kind: 'visa_check',
      title: `Visa requirements — ${destCode}`,
      detail: entryData?.visaNote || `Not checked for you — verify visa requirements for ${destCode} on the official government page before booking.`,
      dueDate: addDays(departureDate, -90),
      sourceUrl: entryData?.officialUrl || `https://www.iatatravelcentre.com`,
      severity: 'info',
      destinationCode: destCode
    });
    // 4. Health consult
    items.push({
      kind: 'health_consult',
      title: `Travel health consultation — ${destCode}`,
      detail: 'Visit a travel health clinic 4–6 weeks before departure for destination-specific vaccinations and advice.',
      dueDate: addDays(departureDate, -42),
      sourceUrl: 'https://wwwnc.cdc.gov/travel/destinations/list',
      severity: 'important',
      destinationCode: destCode
    });
    // 5. Medications
    items.push({
      kind: 'medications',
      title: `Medications & prescriptions — ${destCode}`,
      detail: 'Carry prescriptions in original packaging with a doctor\'s letter. Check destination rules for controlled medicines. Bring enough supply plus extra for delays.',
      dueDate: addDays(departureDate, -14),
      severity: 'info',
      destinationCode: destCode
    });
    // 6. Altitude — measured at the places actually on the itinerary.
    const points = pointsByCountry[destCode] ?? [];
    if (points.length > 0) {
      const elev = await highestElevationForPoints(points);
      if (elev.meters === null) {
        notes.push(`${destCode}: elevation could not be measured, so no altitude advice was generated.`);
      } else if (elev.meters > 2500) {
        items.push({
          kind: 'altitude',
          title: `High altitude advisory — ${destCode}`,
          detail: `The highest stop on your itinerary in ${destCode} is about ${Math.round(elev.meters)} m (measured at ${elev.measured} of your ${elev.total} located stops). Allow 1–2 days to acclimatise. Symptoms of altitude sickness include headache, nausea, and fatigue. Consult your doctor about acetazolamide if travelling above 3000 m.`,
          dueDate: addDays(departureDate, -30),
          severity: 'important',
          destinationCode: destCode
        });
      }
    } else {
      notes.push(`${destCode}: no stop on your itinerary has coordinates, so altitude was not checked.`);
    }
    // 7. Jet-lag.
    //
    // DEFECT 2026-09-19 (wrong basis for every traveller) — the home timezone
    // was `Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'`, which
    // is the EDGE RUNTIME's timezone, i.e. UTC. It has nothing to do with
    // where the traveller lives. Every jet-lag plan was computed as a shift
    // from UTC to a country CENTROID timezone: a flight London → Paris
    // produced "crossing ~1 time zones" and none at all, while Tokyo → Sydney
    // (a one-hour shift) produced "crossing ~10 time zones heading east" with
    // a three-day pre-adaptation schedule. The home zone must now be supplied
    // by the caller (?homeTz=) and the destination zone comes from the
    // itinerary's own recorded timezone; when either is unknown no plan is
    // produced and the reason is returned.
    const destTz = tzByCountry[destCode] ?? null;
    if (!homeTz) {
      notes.push(`${destCode}: no jet-lag plan — your home timezone was not supplied (pass ?homeTz=Area/City).`);
    } else if (!destTz) {
      notes.push(`${destCode}: no jet-lag plan — no timezone is recorded on this trip or its stops in ${destCode}.`);
    } else {
      const jetlagPlan = generateJetlagPlan(homeTz, destTz);
      if (jetlagPlan) {
        items.push({
          kind: 'jetlag',
          title: `Jet-lag plan — ${destCode} (${jetlagPlan.shiftHours}h ${jetlagPlan.direction})`,
          detail: jetlagPlan.tips.join(' '),
          dueDate: addDays(departureDate, -3),
          severity: 'info',
          destinationCode: destCode
        });
      }
    }
    // 8. Emergency numbers
    const { data: emerg, error: emergLookupError } = await service.from('emergency_numbers').select('*').eq('country_code', destCode).maybeSingle();
    if (emergLookupError) {
      console.error(`[health-entry-prep] emergency_numbers lookup failed for ${destCode}:`, emergLookupError.message);
    }
    // DEFECT 2026-09-19 (null rendered as a phone number) — the detail was
    //     `Police: ${emerg.police} | Ambulance: ${emerg.ambulance} | ...`
    // with no null handling, so a row with a missing field printed
    // "Ambulance: null" — in an emergency-contacts card. Only the numbers
    // that exist are listed now, the review date is stated because these go
    // stale, and a country not in the table (only 20 are) says so rather than
    // leaving the traveller to assume the list is complete.
    let emergDetail;
    if (emergLookupError) {
      emergDetail = `Emergency numbers for ${destCode} could not be read from TravelOS. Look them up from an official source before you travel.`;
    } else if (!emerg) {
      emergDetail = `TravelOS does not hold emergency numbers for ${destCode}. Look them up from an official source before you travel.`;
    } else {
      const parts = [];
      if (emerg.police) parts.push(`Police: ${emerg.police}`);
      if (emerg.ambulance) parts.push(`Ambulance: ${emerg.ambulance}`);
      if (emerg.fire) parts.push(`Fire: ${emerg.fire}`);
      if (emerg.general) parts.push(`General: ${emerg.general}`);
      const stale = isStale(emerg.reviewed_at);
      emergDetail = parts.length ? `${parts.join(' | ')} (last reviewed ${emerg.reviewed_at}${stale ? ' — verify, this is over a year old' : ''})` : `TravelOS holds a record for ${destCode} but no numbers in it. Look them up from an official source before you travel.`;
    }
    items.push({
      kind: 'emergency_numbers',
      title: `Emergency numbers — ${destCode}`,
      detail: emergDetail,
      sourceUrl: emerg?.source_url,
      severity: 'info',
      destinationCode: destCode
    });
    // 9. Insurance coverage
    items.push({
      kind: 'insurance_coverage',
      title: `Travel insurance — ${destCode}`,
      detail: 'Confirm your policy covers medical evacuation, trip cancellation, and any planned activities (e.g. adventure sports). Carry your policy number and emergency contact.',
      dueDate: addDays(departureDate, -30),
      severity: 'info',
      destinationCode: destCode
    });
    for (const it of items){
      if (domestic && INTERNATIONAL_ONLY_KINDS.has(it.kind)) continue;
      allItems.push(it);
    }
  }
  return {
    items: allItems,
    notes
  };
}
// ─── Route helpers ────────────────────────────────────
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json'
    }
  });
}
function errorResponse(code, message, status = 400) {
  return jsonResponse({
    error: {
      code,
      message
    }
  }, status);
}
async function gate(service, tripId, userId) {
  const result = await getTripMember(service, tripId, userId);
  if ('failed' in result) {
    return errorResponse('MEMBERSHIP_CHECK_FAILED', 'Could not verify your membership of this trip', 500);
  }
  if ('notMember' in result) return errorResponse('FORBIDDEN', 'Not a member of this trip', 403);
  return {
    platformUserId: result.platformUserId,
    role: result.member.role
  };
}
// ─── Main handler ────────────────────────────────────
Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders
    });
  }
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/health-entry-prep/, '');
  const method = req.method;
  // Auth. The anon client exists ONLY to verify the caller's JWT; all data
  // access uses serviceSupabase after the membership gate — see the DEFECT
  // note at the top of this file.
  const authHeader = req.headers.get('Authorization') ?? '';
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: {
      headers: {
        Authorization: authHeader
      }
    }
  });
  const serviceSupabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  // Internal scan endpoint uses service key
  if (method === 'POST' && path === '/prep/scan') {
    const serviceKey = req.headers.get('x-service-key');
    if (!serviceKey || !timingSafeEqual(serviceKey, SUPABASE_SERVICE_KEY)) {
      return errorResponse('UNAUTHORIZED', 'Service key required', 401);
    }
    return handleScan(serviceSupabase);
  }
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return errorResponse('UNAUTHORIZED', 'Authentication required', 401);
  }
  // GET /prep/me?tripId=
  if (method === 'GET' && path === '/prep/me') {
    return handleGetMyPrep(url, user.id, serviceSupabase);
  }
  // PATCH /prep/me/:itemId?tripId=
  const patchMatch = path.match(/^\/prep\/me\/([^/?]+)$/);
  if (method === 'PATCH' && patchMatch) {
    return handlePatchPrepItem(url, patchMatch[1], user.id, req, serviceSupabase);
  }
  // GET /prep/summary?tripId=
  if (method === 'GET' && path === '/prep/summary') {
    return handleGetSummary(url, user.id, serviceSupabase);
  }
  // GET /prep/destinations/:code?tripId=
  const destMatch = path.match(/^\/prep\/destinations\/([A-Z]{2})$/);
  if (method === 'GET' && destMatch) {
    return handleGetDestination(url, destMatch[1], user.id, serviceSupabase);
  }
  // GET /prep/changes?tripId=
  if (method === 'GET' && path === '/prep/changes') {
    return handleGetChanges(url, user.id, serviceSupabase);
  }
  return errorResponse('NOT_FOUND', 'Route not found', 404);
});
// ─── GET /prep/me ─────────────────────────────────────
async function handleGetMyPrep(url, userId, service) {
  const tripId = url.searchParams.get('tripId');
  if (!tripId) return errorResponse('MISSING_PARAM', 'tripId is required');
  const homeTzParam = url.searchParams.get('homeTz');
  const homeTz = homeTzParam && isValidTz(homeTzParam) ? homeTzParam : null;
  if (homeTzParam && !homeTz) {
    return errorResponse('INVALID_PARAM', `homeTz "${homeTzParam}" is not a recognised IANA timezone`);
  }
  // Verify membership (see SECURITY note at top of file re: id-space bridge)
  const gated = await gate(service, tripId, userId);
  if (gated instanceof Response) return gated;
  const memberId = gated.platformUserId;
  // 2026-09-25 (wave 7): home country, domestic filtering and overdue flags.
  const homeCountryRaw = url.searchParams.get('homeCountry');
  const homeCountryParam = homeCountryRaw && /^[A-Za-z]{2}$/.test(homeCountryRaw.trim()) ? homeCountryRaw.trim().toUpperCase() : null;
  if (homeCountryRaw && !homeCountryParam) {
    return errorResponse('INVALID_PARAM', `homeCountry "${homeCountryRaw}" is not a two-letter country code`);
  }
  const home = await resolveHomeCountry(service, memberId, homeCountryParam, homeTz);
  const asOf = todayIn(homeTz);
  const respond = (body)=>{
    const raw = Array.isArray(body.items) ? body.items : [];
    let omitted = 0;
    const kept = raw.filter((i)=>{
      const isDomesticIntl = !!home.country && String(i.destination_code ?? '').toUpperCase() === home.country && INTERNATIONAL_ONLY_KINDS.has(String(i.kind ?? ''));
      if (isDomesticIntl) omitted++;
      return !isDomesticIntl;
    });
    const items = kept.map((i)=>({
        ...i,
        overdue: (i.status ?? 'todo') === 'todo' && typeof i.due_date === 'string' && i.due_date.slice(0, 10) < asOf
      }));
    return jsonResponse({
      ...body,
      items,
      homeCountry: home.country,
      homeCountrySource: home.source,
      omittedAsDomestic: omitted,
      asOf
    });
  };
  // Check existing items.
  //
  // DEFECT 2026-09-19 (discarded error) — a failed read fell through to the
  // generation branch, which would insert a duplicate full set of prep items
  // for the member, losing every "done" tick they had made.
  const { data: existing, error: existingLookupError } = await service.from('prep_items').select('*').eq('trip_id', tripId).eq('member_id', memberId).order('created_at', {
    ascending: true
  });
  if (existingLookupError) {
    return errorResponse('DB_ERROR', existingLookupError.message, 500);
  }
  // 2026-09-25: an existing checklist is no longer returned as-is — countries
  // added to the trip since it was built get their items appended below.
  const existingItems = existing ?? [];
  const hasExisting = existingItems.length > 0;
  // Generate items
  const { data: trip, error: tripLookupError } = await service.from('trips').select('id, start_date, end_date, destination, primary_tz').eq('id', tripId).maybeSingle();
  if (tripLookupError) {
    if (hasExisting) {
      console.error('[health-entry-prep] trip re-read for new countries failed:', tripLookupError.message);
      return respond({
        items: sortPrepItems(existingItems),
        generated: false
      });
    }
    return errorResponse('DB_ERROR', tripLookupError.message, 500);
  }
  if (!trip) return errorResponse('NOT_FOUND', 'Trip not found', 404);
  // Get destinations from itinerary items, with their coordinates and zones.
  const { data: itinerary, error: itineraryLookupError } = await service.from('itinerary_items').select('country_code, location, lat, lng, timezone').eq('trip_id', tripId);
  if (itineraryLookupError) {
    if (hasExisting) {
      console.error('[health-entry-prep] itinerary re-read for new countries failed:', itineraryLookupError.message);
      return respond({
        items: sortPrepItems(existingItems),
        generated: false
      });
    }
    return errorResponse('DB_ERROR', itineraryLookupError.message, 500);
  }
  const rows = itinerary ?? [];
  const destinations = [
    ...new Set(rows.map((i)=>i.country_code).filter(Boolean))
  ];
  const pointsByCountry = {};
  const tzByCountry = {};
  for (const r of rows){
    if (!r.country_code) continue;
    if (typeof r.lat === 'number' && typeof r.lng === 'number') {
      (pointsByCountry[r.country_code] ??= []).push({
        lat: r.lat,
        lng: r.lng
      });
    }
    if (!tzByCountry[r.country_code] && r.timezone) tzByCountry[r.country_code] = r.timezone;
  }
  for (const d of destinations){
    tzByCountry[d] ??= trip.primary_tz ?? null;
  }
  // DEFECT 2026-09-19 (nonexistent column) — the fallback here was
  //     if (destinations.length === 0 && trip.destination_country)
  //         destinations.push(trip.destination_country);
  // trips has no `destination_country` column (it has `destination`), and
  // select('*') made that undefined rather than an error, so the fallback
  // never once fired: a trip whose itinerary carries no country codes simply
  // returned an empty prep list with no explanation.
  let destinationSource = 'itinerary';
  if (destinations.length === 0 && typeof trip.destination === 'string' && /^[A-Za-z]{2}$/.test(trip.destination)) {
    destinations.push(trip.destination.toUpperCase());
    destinationSource = 'trip.destination';
  }
  // 2026-09-25: existing checklist — only countries with no items yet.
  if (hasExisting) {
    const covered = new Set(existingItems.map((i)=>String(i.destination_code ?? '').toUpperCase()).filter(Boolean));
    const newDestinations = destinations.filter((d)=>!covered.has(d.toUpperCase()));
    if (newDestinations.length === 0) {
      return respond({
        items: sortPrepItems(existingItems),
        generated: false
      });
    }
    destinations.splice(0, destinations.length, ...newDestinations);
  }
  if (destinations.length === 0) {
    return respond({
      items: [],
      generated: false,
      reason: trip.destination ? `No ISO country code is recorded on this trip's stops, and the trip's destination ("${trip.destination}") is not a two-letter country code, so no destination-specific preparation could be produced.` : 'No ISO country code is recorded on this trip’s stops, so no destination-specific preparation could be produced.'
    });
  }
  const departureDate = trip.start_date || new Date().toISOString().slice(0, 10);
  const returnDate = trip.end_date || null;
  const { items: prepInputs, notes } = await generatePrepItems(destinations, pointsByCountry, tzByCountry, departureDate, returnDate, homeTz, service, home.country);
  // Insert into DB. prep_items has no INSERT policy, so this must go through
  // the service client — see the DEFECT note at the top of this file.
  const now = new Date().toISOString();
  const rowsToInsert = prepInputs.map((item)=>({
      id: makeId('prp_'),
      trip_id: tripId,
      member_id: memberId,
      destination_code: item.destinationCode,
      kind: item.kind,
      title: item.title,
      detail: item.detail,
      due_date: item.dueDate || null,
      source_url: item.sourceUrl || null,
      status: 'todo',
      severity: item.severity,
      created_at: now,
      updated_at: now
    }));
  const { data: inserted, error: insertError } = await service.from('prep_items').insert(rowsToInsert).select();
  if (insertError) {
    if (hasExisting) {
      console.error('[health-entry-prep] inserting items for new countries failed:', insertError.message);
      return respond({
        items: sortPrepItems(existingItems),
        generated: false,
        notChecked: [
          `Items for newly added countries (${destinations.join(', ')}) could not be saved: ${insertError.message}`
        ]
      });
    }
    return errorResponse('DB_ERROR', insertError.message, 500);
  }
  if (hasExisting) {
    return respond({
      items: sortPrepItems([
        ...existingItems,
        ...inserted || []
      ]),
      generated: false,
      addedDestinations: destinations,
      destinationSource,
      notChecked: notes
    });
  }
  return respond({
    items: sortPrepItems(inserted || []),
    generated: true,
    destinations,
    destinationSource,
    // What could NOT be worked out, so a short list is never read as
    // "nothing else to prepare".
    notChecked: notes
  });
}
function sortPrepItems(items) {
  const severityOrder = {
    blocking: 0,
    important: 1,
    info: 2
  };
  return [
    ...items
  ].sort((a, b)=>{
    const sA = severityOrder[a.severity] ?? 2;
    const sB = severityOrder[b.severity] ?? 2;
    if (sA !== sB) return sA - sB;
    if (a.due_date && b.due_date) return a.due_date.localeCompare(b.due_date);
    if (a.due_date) return -1;
    if (b.due_date) return 1;
    return 0;
  });
}
// ─── PATCH /prep/me/:itemId ──────────────────────────────
async function handlePatchPrepItem(url, itemId, userId, req, service) {
  const tripId = url.searchParams.get('tripId');
  if (!tripId) return errorResponse('MISSING_PARAM', 'tripId is required');
  let body;
  try {
    body = await req.json();
  } catch  {
    return errorResponse('INVALID_BODY', 'Invalid JSON body');
  }
  const validStatuses = [
    'todo',
    'done',
    'not_applicable'
  ];
  if (!body?.status || !validStatuses.includes(body.status)) {
    return errorResponse('INVALID_STATUS', `status must be one of: ${validStatuses.join(', ')}`);
  }
  const gated = await gate(service, tripId, userId);
  if (gated instanceof Response) return gated;
  const { data: updated, error } = await service.from('prep_items').update({
    status: body.status,
    updated_at: new Date().toISOString()
  }).eq('id', itemId).eq('trip_id', tripId).eq('member_id', gated.platformUserId).select().maybeSingle();
  if (error) return errorResponse('DB_ERROR', error.message, 500);
  if (!updated) return errorResponse('NOT_FOUND', 'Prep item not found', 404);
  return jsonResponse(updated);
}
// ─── GET /prep/summary ───────────────────────────────────
async function handleGetSummary(url, userId, service) {
  const tripId = url.searchParams.get('tripId');
  if (!tripId) return errorResponse('MISSING_PARAM', 'tripId is required');
  // Check membership and role (see SECURITY note at top of file re: id-space bridge)
  const gated = await gate(service, tripId, userId);
  if (gated instanceof Response) return gated;
  const isOrganizer = gated.role === 'organizer' || gated.role === 'owner';
  // DEFECT 2026-09-19 (failure looks like readiness) — both branches
  // discarded the read error and fell back to `items = []`, producing
  // `{ total: 0, done: 0, blocking: 0 }`. An organiser reading "0 blocking"
  // on the eve of departure would take it as everyone being ready when in
  // fact nothing had been read at all.
  const query = isOrganizer ? service.from('prep_items').select('member_id, status, severity').eq('trip_id', tripId) : service.from('prep_items').select('member_id, status, severity').eq('trip_id', tripId).eq('member_id', gated.platformUserId);
  const { data: allItems, error } = await query;
  if (error) return errorResponse('DB_ERROR', error.message, 500);
  const items = allItems ?? [];
  const total = items.length;
  const done = items.filter((i)=>i.status === 'done').length;
  const blocking = items.filter((i)=>i.severity === 'blocking' && i.status !== 'done').length;
  const byMember = {};
  for (const item of items){
    const mid = item.member_id;
    if (!byMember[mid]) byMember[mid] = {
      total: 0,
      done: 0
    };
    byMember[mid].total++;
    if (item.status === 'done') byMember[mid].done++;
  }
  return jsonResponse({
    total,
    done,
    blocking,
    byMember,
    scope: isOrganizer ? 'trip' : 'own'
  });
}
// ─── GET /prep/destinations/:code ───────────────────────────────
async function handleGetDestination(url, code, userId, service) {
  const tripId = url.searchParams.get('tripId');
  if (!tripId) return errorResponse('MISSING_PARAM', 'tripId is required');
  // Verify membership (see SECURITY note at top of file re: id-space bridge)
  const gated = await gate(service, tripId, userId);
  if (gated instanceof Response) return gated;
  // Prefer the trip's own stops in this country over the country centroid.
  const { data: stops, error: stopsErr } = await service.from('itinerary_items').select('lat, lng, timezone').eq('trip_id', tripId).eq('country_code', code);
  if (stopsErr) return errorResponse('DB_ERROR', stopsErr.message, 500);
  const points = (stops ?? []).filter((s)=>typeof s.lat === 'number' && typeof s.lng === 'number').map((s)=>({
      lat: s.lat,
      lng: s.lng
    }));
  const stopTz = (stops ?? []).map((s)=>s.timezone).find(Boolean) ?? null;
  const centroid = COUNTRY_CENTROIDS[code];
  // Where the weather / air-quality reading is taken, stated to the caller.
  const readingPoint = points[0] ?? (centroid ? {
    lat: centroid.lat,
    lng: centroid.lng
  } : null);
  const readingBasis = points[0] ? 'first itinerary stop in this country' : centroid ? 'country centroid' : null;
  const [entryReqs, emergNumbers, outbreaks, weatherData, aqData, elevation] = await Promise.allSettled([
    service.from('entry_requirements').select('*').eq('destination', code).order('fetched_at', {
      ascending: false
    }).limit(1).maybeSingle(),
    service.from('emergency_numbers').select('*').eq('country_code', code).maybeSingle(),
    (async ()=>{
      const res = await fetch(`${SUPABASE_URL}/functions/v1/provider-adapters`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
        },
        body: JSON.stringify({
          adapter: 'DiseaseOutbreaks',
          params: {
            country: code,
            days: 60
          }
        })
      });
      if (!res.ok) {
        const text = await res.text().catch(()=>'<unreadable>');
        throw new Error(`provider-adapters returned ${res.status}: ${text.slice(0, 300)}`);
      }
      return res.json();
    })(),
    readingPoint ? (async ()=>{
      const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${readingPoint.lat}&longitude=${readingPoint.lng}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode&timezone=auto&forecast_days=7`);
      if (!res.ok) throw new Error(`open-meteo forecast returned ${res.status}`);
      return res.json();
    })() : Promise.reject(new Error('no coordinates for this country')),
    readingPoint ? (async ()=>{
      const res = await fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${readingPoint.lat}&longitude=${readingPoint.lng}&hourly=pm10,pm2_5,european_aqi&timezone=auto&forecast_days=1`);
      if (!res.ok) throw new Error(`open-meteo air quality returned ${res.status}`);
      return res.json();
    })() : Promise.reject(new Error('no coordinates for this country')),
    points.length > 0 ? highestElevationForPoints(points) : centroid ? checkAltitude(centroid.lat, centroid.lng).then((m)=>({
        meters: m,
        measured: m === null ? 0 : 1,
        total: 1
      })) : Promise.reject(new Error('no coordinates for this country'))
  ]);
  const unavailable = {};
  if (entryReqs.status === 'fulfilled' && entryReqs.value?.error) {
    console.error('[health-entry-prep] entry_requirements lookup failed:', entryReqs.value.error.message);
    unavailable.entryRequirements = entryReqs.value.error.message;
  }
  const entryData = entryReqs.status === 'fulfilled' ? entryReqs.value?.data : null;
  if (emergNumbers.status === 'fulfilled' && emergNumbers.value?.error) {
    console.error('[health-entry-prep] emergency_numbers lookup failed:', emergNumbers.value.error.message);
    unavailable.emergencyNumbers = emergNumbers.value.error.message;
  }
  const emergency = emergNumbers.status === 'fulfilled' ? emergNumbers.value?.data : null;
  const outbreakData = outbreaks.status === 'fulfilled' ? outbreaks.value : null;
  if (outbreaks.status === 'rejected') {
    console.error('[health-entry-prep] outbreak lookup failed:', outbreaks.reason);
    unavailable.outbreaks = String(outbreaks.reason);
  }
  const weather = weatherData.status === 'fulfilled' ? weatherData.value : null;
  if (weatherData.status === 'rejected') unavailable.weather = String(weatherData.reason);
  const aq = aqData.status === 'fulfilled' ? aqData.value : null;
  if (aqData.status === 'rejected') unavailable.airQuality = String(aqData.reason);
  const elev = elevation.status === 'fulfilled' ? elevation.value : null;
  if (elevation.status === 'rejected') unavailable.altitude = String(elevation.reason);
  else if (elev && elev.meters === null) unavailable.altitude = 'the elevation service did not answer';
  // Health links.
  //
  // DEFECT 2026-09-19 (a dead link presented as country guidance) — the CDC
  // link was built as
  //     https://wwwnc.cdc.gov/travel/destinations/traveler/none/${code.toLowerCase()}
  // but that path takes a country NAME slug ('france'), not an ISO code, so
  // every one of these links 404s. It was labelled "CDC Traveler Health" and
  // shown as the destination's health page. Replaced with the CDC destination
  // index, which is a page that exists.
  const healthLinks = [
    {
      name: 'CDC travel destinations (find ' + code + ')',
      url: 'https://wwwnc.cdc.gov/travel/destinations/list'
    },
    {
      name: 'NHS Fit for Travel',
      url: 'https://www.fitfortravel.nhs.uk/destinations'
    },
    {
      name: 'WHO Travel Advice',
      url: 'https://www.who.int/travel-advice'
    }
  ];
  // Weather summary
  let weatherSummary = null;
  if (weather?.daily?.temperature_2m_max) {
    const temps = weather.daily.temperature_2m_max.filter((v)=>typeof v === 'number' && Number.isFinite(v));
    const precip = (weather.daily.precipitation_sum ?? []).filter((v)=>typeof v === 'number' && Number.isFinite(v));
    if (temps.length > 0) {
      weatherSummary = {
        avgMaxTemp: Math.round(temps.reduce((a, b)=>a + b, 0) / temps.length),
        unit: '°C',
        forecastDays: temps.length,
        precipitationTotal: precip.length ? precip.reduce((a, b)=>a + b, 0).toFixed(1) : null,
        measuredAt: readingBasis
      };
    }
  }
  // AQ summary
  let aqSummary = null;
  if (aq?.hourly?.european_aqi) {
    const aqiValues = aq.hourly.european_aqi.filter((v)=>typeof v === 'number' && Number.isFinite(v));
    const avgAqi = aqiValues.length > 0 ? aqiValues.reduce((a, b)=>a + b, 0) / aqiValues.length : null;
    aqSummary = {
      averageEuropeanAqi: avgAqi === null ? null : Math.round(avgAqi),
      category: avgAqi === null ? 'unknown' : avgAqi < 20 ? 'Good' : avgAqi < 40 ? 'Fair' : avgAqi < 60 ? 'Moderate' : avgAqi < 80 ? 'Poor' : 'Very Poor',
      measuredAt: readingBasis
    };
  }
  return jsonResponse({
    countryCode: code,
    entryRequirements: entryData ? {
      source: entryData.source,
      summary: entryData.summary,
      passportValidityRule: entryData.passport_validity_rule,
      authorizationInfo: entryData.authorization_info,
      visaNote: entryData.visa_note,
      officialUrl: entryData.official_url,
      fetchedAt: entryData.fetched_at
    } : null,
    healthLinks,
    environment: {
      // null, never 0, when the elevation could not be measured.
      altitudeMeters: elev?.meters ?? null,
      altitudeBasis: points.length > 0 ? `highest of ${elev?.measured ?? 0} measured itinerary stops` : centroid ? 'country centroid' : null,
      highAltitude: typeof elev?.meters === 'number' ? elev.meters > 2500 : null,
      weather: weatherSummary,
      airQuality: aqSummary,
      // The trip's own recorded zone, not a country-wide guess.
      timezone: stopTz
    },
    emergencyNumbers: emergency ? {
      ...emergency,
      stale: isStale(emergency.reviewed_at)
    } : null,
    outbreakHeadlines: outbreakData?.outbreaks || outbreakData?.data || null,
    // Everything that could not be retrieved, with the reason — so a null
    // field is never read as "there is nothing to report here".
    unavailable
  });
}
// ─── GET /prep/changes ───────────────────────────────────
async function handleGetChanges(url, userId, service) {
  const tripId = url.searchParams.get('tripId');
  if (!tripId) return errorResponse('MISSING_PARAM', 'tripId is required');
  // Verify membership (see SECURITY note at top of file re: id-space bridge)
  const gated = await gate(service, tripId, userId);
  if (gated instanceof Response) return gated;
  // Get trip destinations
  const { data: itinerary, error: itineraryLookupError } = await service.from('itinerary_items').select('country_code').eq('trip_id', tripId);
  // DEFECT 2026-09-19 (discarded error) — a failed read produced an empty
  // destination list and the route answered [] , i.e. "no entry requirement
  // has changed for your trip", which is the opposite of what a traveller
  // needs to hear when the check did not run.
  if (itineraryLookupError) return errorResponse('DB_ERROR', itineraryLookupError.message, 500);
  const destinations = [
    ...new Set((itinerary ?? []).map((i)=>i.country_code).filter(Boolean))
  ];
  if (destinations.length === 0) {
    return jsonResponse({
      changes: [],
      reason: 'No ISO country code is recorded on this trip’s stops, so no entry requirements were monitored.'
    });
  }
  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const { data: changes, error } = await service.from('entry_requirement_changes').select('*').in('destination', destinations).gte('detected_at', since).order('detected_at', {
    ascending: false
  });
  if (error) return errorResponse('DB_ERROR', error.message, 500);
  return jsonResponse({
    changes: changes ?? [],
    destinations
  });
}
// ─── POST /prep/scan (internal) ──────────────────────────
async function handleScan(supabase) {
  // Get all active trips with upcoming departure
  const { data: trips, error: tripsLookupError } = await supabase.from('trips').select('id, start_date').gte('start_date', new Date().toISOString().slice(0, 10)).lte('start_date', addDays(new Date().toISOString().slice(0, 10), 90));
  // DEFECT 2026-09-19 (a failed scan reported as a clean scan) — the error
  // was logged and the route returned { scanned: 0, changes: 0 } with a 200,
  // which to the scheduler that calls it is indistinguishable from "no trips
  // needed checking". A monitoring job cannot alert on a success.
  if (tripsLookupError) {
    return errorResponse('DB_ERROR', `Scan could not start: ${tripsLookupError.message}`, 500);
  }
  if (!trips || trips.length === 0) return jsonResponse({
    scanned: 0,
    changes: 0,
    errors: []
  });
  let totalChanges = 0;
  const errors = [];
  for (const trip of trips){
    // Get destinations
    const { data: itinerary, error: itineraryLookupError } = await supabase.from('itinerary_items').select('country_code').eq('trip_id', trip.id);
    if (itineraryLookupError) {
      console.error(`[health-entry-prep] itinerary_items lookup failed for trip ${trip.id}:`, itineraryLookupError.message);
      errors.push(`trip ${trip.id}: ${itineraryLookupError.message}`);
      continue;
    }
    const destinations = [
      ...new Set((itinerary ?? []).map((i)=>i.country_code).filter(Boolean))
    ];
    for (const dest of destinations){
      // Get existing cached requirements
      const { data: existing, error: existingLookupError } = await supabase.from('entry_requirements').select('*').eq('destination', dest).order('fetched_at', {
        ascending: false
      }).limit(1).maybeSingle();
      if (existingLookupError) {
        console.error(`[health-entry-prep] entry_requirements lookup failed for ${dest}:`, existingLookupError.message);
        errors.push(`${dest}: ${existingLookupError.message}`);
        continue;
      }
      if (!existing) continue;
      // Re-fetch (force fresh by checking if > 12h old)
      const age = Date.now() - new Date(existing.fetched_at).getTime();
      if (age < 12 * 3600 * 1000) continue;
      try {
        let freshData = null;
        if (existing.source === 'GOVUK') {
          freshData = await fetchGOVUK(dest);
        } else if (existing.source === 'USDOS') {
          freshData = await fetchUSDOS(dest);
        }
        if (!freshData) continue;
        const newHash = await sha256(JSON.stringify(freshData.summary));
        if (newHash === existing.content_hash) continue;
        // Record change
        const diffSummary = [
          `Entry requirements for ${dest} updated from source ${existing.source}.`,
          ...freshData.summary.slice(0, 3)
        ];
        const { error: changeInsertError } = await supabase.from('entry_requirement_changes').insert({
          id: makeId('chg_'),
          nationality: existing.nationality,
          destination: dest,
          source: existing.source,
          old_hash: existing.content_hash,
          new_hash: newHash,
          diff_summary: diffSummary,
          detected_at: new Date().toISOString()
        });
        if (changeInsertError) {
          console.error(`[health-entry-prep] entry_requirement_changes insert failed for ${dest}:`, changeInsertError.message);
          errors.push(`${dest}: change not recorded (${changeInsertError.message})`);
          continue;
        }
        // Update cache
        const { error: cacheUpdateError } = await supabase.from('entry_requirements').update({
          summary: freshData.summary,
          content_hash: newHash,
          fetched_at: new Date().toISOString()
        }).eq('id', existing.id);
        if (cacheUpdateError) {
          console.error(`[health-entry-prep] entry_requirements cache update failed for ${dest}:`, cacheUpdateError.message);
          errors.push(`${dest}: cache not updated (${cacheUpdateError.message})`);
        }
        totalChanges++;
      } catch (e) {
        console.error(`Scan error for ${dest}:`, e);
        errors.push(`${dest}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return jsonResponse({
    scanned: trips.length,
    changes: totalChanges,
    errors
  });
}

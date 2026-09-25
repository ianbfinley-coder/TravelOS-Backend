// 2026-09-25 — EMERGENCY NUMBERS SCOPED TO THE TRIP (wave 6b).
// GET /itinerary.pdf printed `emergency_numbers.select('*').limit(10)` — the
// first ten countries in the table, whatever the trip — so a Japan trip's
// printout showed Australia, Belgium, Brazil... and not necessarily Japan. The
// SOS section (/sections/sos) had the same defect with limit(20). Both now
// filter to the trip's countries: distinct itinerary_items.country_code plus
// the country named in trips.destination when it can be recognised
// (tripCountryCodes below). No recognisable country -> no numbers, with an
// honest "no trip country known" line rather than another country's numbers.
// ITINERARY RECONCILIATION 2026-09-24 — the legacy POST / (v1 generate)
// route builds pack_data.itinerary from itinerary_items (days by date in the
// trip's primary_tz, local HH:MM times) plus the active itinerary_versions
// version_number, instead of the legacy generated_itineraries row. The old
// code also read `.days` off GI.itinerary, which is itself a days array, so
// the section was always empty. The section's shape is unchanged. All other
// routes are unchanged.
// ─────────────────────────────────────────────────────────────────────────────
// 2026-09-19 — column-name / missing-table fabrication sweep (v1 paths only).
//
// Every `.select()`, `.eq()` and `.order()` below was checked against
// information_schema.columns on this project. A column that does not exist
// makes PostgREST reject the WHOLE query with 42703, so these were not partial
// failures — they returned nothing, and the nothing was then presented as fact.
//
//  * itinerary_items has NO `starts_at`, `ends_at` or `tz`. It has `date`
//    (date), `start_time`/`end_time` (timestamptz) and `timezone` (text).
//    `.order('starts_at')` 500'd the /sections/plan route outright; the same
//    order in the calendar and PDF paths meant unordered or empty output, and
//    every read of `item.starts_at` was undefined — so ICS events carried no
//    DTSTART and the PDF grouped every item under the empty-string day.
//  * reservations has NO `starts_at`/`ends_at`. It has `start_date`/`end_date`
//    (date) and `start_time`/`end_time` (time).
//  * `expense_tracking` IS NOT A TABLE (42P01). The real table is `expenses`,
//    and its date column is `paid_at`, not `date`. All three call sites caught
//    the failure and answered with an empty list plus the note
//    "expense_tracking unavailable" — i.e. "this trip has no expenses".
//  * trips has NO `currency`; it has `base_currency`. `trip.currency ?? 'USD'`
//    therefore stamped every backup export as US dollars.
//  * emergency_numbers has NO `id`, `label`, `number`, `name` or `phone`. Its
//    columns are country_code/police/ambulance/fire/general. The manifest count
//    was always null and the PDF's "Emergency Numbers" box rendered a row of
//    empty strings for every country.
//  * playbooks has NO `id` (its key is `key`), so its manifest count was always
//    null — and the code then substituted a hardcoded `?? 12`, inventing a
//    playbook count out of a failed query.
//
// Nothing here defaults to a value that asserts a fact about the world any
// more, and a failed query is a 500 that says so instead of an empty section.
// The v2 `offline_trip_packs` path further down was audited clean and is
// untouched.
// ─────────────────────────────────────────────────────────────────────────────
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
// ─── Disruption guidance (preserved from v1) ──────────────────────────────
const DISRUPTION_GUIDANCE = {
  missed_flight: [
    "Check your reservation information in this pack.",
    "Contact the airline using the stored contact information.",
    "Ask about the next available flight on the same route.",
    "Check your travel insurance if applicable.",
    "Reconnect to TravelOS when possible to reassess your itinerary."
  ],
  hotel_problem: [
    "Contact the hotel using the stored phone number.",
    "Review your reservation confirmation number.",
    "Ask to speak with the manager if needed.",
    "Record the issue for future reference.",
    "Reconnect to TravelOS when possible."
  ],
  missed_train_bus: [
    "Review your confirmation in this pack.",
    "Contact the transportation provider using stored information.",
    "Ask about the next available departure.",
    "Reconnect to TravelOS when possible to update your plan."
  ],
  lost_connection: [
    "Use this Offline Trip Pack for your key information.",
    "Follow your next known trip step.",
    "Use stored reservation and contact information.",
    "Reconnect to TravelOS when service returns."
  ]
};
// ─── Helpers ────────────────────────────────────────────────────────
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
  };
}
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders()
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
function metadataOnly(pack) {
  const { pack_data: _pd, ...rest } = pack;
  return rest;
}
// Generate a prefixed job id (not security-sensitive: job ids are always
// looked up together with `user_id`, see GET /exports/:jobId below).
function generateId(prefix) {
  const ts = Date.now().toString(36).toUpperCase().padStart(10, '0');
  const rand = Math.random().toString(36).substring(2, 12).toUpperCase().padStart(10, '0');
  return `${prefix}${ts}${rand}`;
}
// SECURITY 2026-09-17 — `/download/:token` is deliberately unauthenticated
// (it is the link handed to a browser/email client), so the token itself is
// the only thing standing between a stranger and a full trip export —
// reservations, itinerary, emergency contacts, and for `kind: backup` every
// expense on the trip. The old token was `generateId('tok_')`: a
// Date.now() timestamp plus a Math.random() string, both guessable /
// brute-forceable, not a capability token. Fixed to a cryptographically
// random UUID, which is what actually makes a bearer token unguessable.
function generateDownloadToken() {
  return `tok_${crypto.randomUUID()}`;
}
// SECURITY 2026-09-17 — this was the real finding in this function: GET
// /manifest, GET /sections/:key, POST /exports (kind: backup / expenses /
// calendar / itinerary) and GET /itinerary.pdf all required a valid JWT
// (so the caller was authenticated) but never checked that the `tripId` in
// the query string or body belonged to that caller. Every one of those
// routes reads reservations (confirmation numbers, addresses), the full
// itinerary, emergency contacts, and — for a backup export — every expense
// on the trip, keyed on trip_id alone. Any signed-in user who knew or
// guessed another user's trip id could pull that trip's full offline pack,
// including a JSON "backup" containing another user's entire trip. The
// legacy v1 routes at the bottom of this file (GET/POST '/') already did
// this correctly with `.eq('user_id', user.id)`; the newer v2 routes above
// them did not. Fixed by requiring the caller to own the trip before any of
// these routes touch it.
async function requireTripOwner(supabase, tripId, userId) {
  const { data, error } = await supabase.from('trips').select('id').eq('id', tripId).eq('user_id', userId).maybeSingle();
  if (error) console.error('[generate-offline-pack] trips ownership lookup failed:', error.message);
  return !!data;
}
// ── itinerary_items → days (ITINERARY RECONCILIATION 2026-09-24) ─────────
// itinerary_items.start_time / end_time are timestamptz (stored UTC). Days
// are grouped by the item's `date` column (the trip-local calendar date);
// when that is missing the date is derived from start_time in the trip's
// primary_tz. Times are rendered as local "HH:MM" in the same zone. Items
// with neither a date nor a start_time are grouped under date null.
function validTz(tz) {
  if (!tz) return null;
  try {
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz
    });
    return tz;
  } catch  {
    return null;
  }
}
function localParts(ts, tz) {
  if (!ts) return null;
  const d = new Date(String(ts).trim().replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
  if (isNaN(d.getTime())) return null;
  const p = {};
  for (const part of new Intl.DateTimeFormat('en-US', {
    timeZone: tz ?? 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(d))p[part.type] = part.value;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${p.hour}:${p.minute}`
  };
}
function itemsToDays(items, tzRaw, tripStart) {
  const tz = validTz(tzRaw);
  const byDate = new Map();
  for (const it of items){
    const start = localParts(it.start_time, tz);
    const date = it.date ?? start?.date ?? '';
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(it);
  }
  const dates = [
    ...byDate.keys()
  ].sort((a, b)=>a === '' ? 1 : b === '' ? -1 : a.localeCompare(b));
  const startMs = tripStart ? Date.parse(`${tripStart}T00:00:00Z`) : NaN;
  return dates.map((date, i)=>{
    const rows = byDate.get(date).slice().sort((a, b)=>String(a.start_time ?? '￿').localeCompare(String(b.start_time ?? '￿')));
    let dayNumber = i + 1;
    if (date && !isNaN(startMs)) {
      const n = Math.round((Date.parse(`${date}T00:00:00Z`) - startMs) / 86400000) + 1;
      if (n >= 1) dayNumber = n;
    }
    return {
      day_number: dayNumber,
      date: date || null,
      items: rows
    };
  });
}
function itemLocalTime(it, tzRaw, field = 'start_time') {
  return localParts(it[field], validTz(tzRaw))?.time ?? null;
}
// ─── ICS helpers ─────────────────────────────────────────────────────
/**
 * itinerary_items records a day (`date`, a date) and absolute instants
 * (`start_time`/`end_time`, timestamptz). There is no `starts_at`/`ends_at`.
 * Returns the calendar date and the wall clock of the instant, each '' when
 * not recorded — an item with no time gets no time rather than a made-up one.
 */ function itemMoment(dateVal, timeVal) {
  const ts = typeof timeVal === 'string' && timeVal.length >= 19 ? timeVal : '';
  const date = ts ? ts.substring(0, 10) : typeof dateVal === 'string' ? dateVal.substring(0, 10) : '';
  const time = ts ? ts.substring(11, 19) : '';
  return {
    date,
    time
  };
}
/**
 * ICS value for a moment: a UTC timestamp when we have an instant, a VALUE=DATE
 * for a day with no time. `start_time` is timestamptz — an absolute instant —
 * so the UTC form is the correct and unambiguous one; tagging it TZID= with the
 * item's `timezone` would label a UTC wall-clock as local time.
 */ function icsStamp(m) {
  if (!m.date) return '';
  return m.time ? `:${formatICSDate(m.date, m.time, null)}` : `;VALUE=DATE:${m.date.replace(/-/g, '')}`;
}
/** `YYYY-MM-DD` + optional `HH:MM:SS` from a reservations row, or null. */ function reservationMoment(dateVal, timeVal) {
  const d = typeof dateVal === 'string' && dateVal ? dateVal.substring(0, 10) : '';
  if (!d) return null;
  const t = typeof timeVal === 'string' && timeVal ? timeVal.substring(0, 8) : '';
  return t ? `${d}T${t}` : d;
}
function formatICSDate(dateStr, timeStr, tz) {
  if (!dateStr) return '';
  const d = dateStr.replace(/-/g, '');
  if (!timeStr) return `${d}`;
  const t = timeStr.replace(/:/g, '').substring(0, 6).padEnd(6, '0');
  if (tz) return `TZID=${tz}:${d}T${t}`;
  return `${d}T${t}Z`;
}
function escapeICS(s) {
  return (s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}
// ─── HTML/Print helpers ──────────────────────────────────────────────────
// 2026-09-25: the trip's countries (ISO2, upper-case) — distinct
// itinerary_items.country_code plus the country named in trips.destination
// (last comma-separated segment first, e.g. "Paris, France" -> FR).
const COUNTRY_ALIASES = {
  'usa': 'US',
  'us': 'US',
  'u.s.': 'US',
  'u.s.a.': 'US',
  'united states of america': 'US',
  'america': 'US',
  'uk': 'GB',
  'u.k.': 'GB',
  'great britain': 'GB',
  'britain': 'GB',
  'england': 'GB',
  'scotland': 'GB',
  'wales': 'GB',
  'northern ireland': 'GB',
  'holland': 'NL',
  'the netherlands': 'NL',
  'czech republic': 'CZ',
  'turkey': 'TR',
  'south korea': 'KR',
  'korea': 'KR',
  'hong kong': 'HK',
  'macau': 'MO',
  'macao': 'MO'
};
// Legacy / pseudo / grouping codes ICU still names (DD='Germany', FX='France'...).
const NON_COUNTRY_CODES = new Set([
  'AN',
  'BU',
  'CS',
  'DD',
  'DY',
  'HV',
  'NH',
  'RH',
  'EU',
  'EZ',
  'FX',
  'NT',
  'QO',
  'SU',
  'TP',
  'UN',
  'XA',
  'XB',
  'VD',
  'YD',
  'YU',
  'ZR',
  'ZZ'
]);
let countryNameIndex = null;
function countryFromName(raw) {
  const name = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!name) return null;
  if (COUNTRY_ALIASES[name]) return COUNTRY_ALIASES[name];
  try {
    if (!countryNameIndex) {
      countryNameIndex = new Map();
      const dn = new Intl.DisplayNames('en', {
        type: 'region'
      });
      const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
      for (const a of A)for (const b of A){
        const code = a + b;
        if (NON_COUNTRY_CODES.has(code)) continue;
        let n;
        try {
          n = dn.of(code);
        } catch  {
          n = undefined;
        }
        if (n && n !== code && !countryNameIndex.has(n.toLowerCase())) countryNameIndex.set(n.toLowerCase(), code); // first (canonical) code wins, e.g. FR not FX
      }
    }
    return countryNameIndex.get(name) ?? null;
  } catch  {
    return null;
  }
}
async function tripCountryCodes(client, tripId, destination, items) {
  const codes = new Set();
  let rows = items;
  if (!rows) {
    const { data, error } = await client.from('itinerary_items').select('country_code').eq('trip_id', tripId);
    if (error) console.error('[generate-offline-pack] itinerary_items country lookup failed:', error.message);
    rows = data ?? [];
  }
  for (const r of rows){
    const cc = typeof r.country_code === 'string' ? r.country_code.trim().toUpperCase() : '';
    if (/^[A-Z]{2}$/.test(cc)) codes.add(cc);
  }
  if (destination) {
    const parts = destination.split(',').map((p)=>p.trim()).filter(Boolean).reverse();
    for (const part of parts){
      const cc = countryFromName(part);
      if (cc) {
        codes.add(cc);
        break;
      }
    }
  }
  return [
    ...codes
  ];
}
function htmlEscape(s) {
  return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function printCSS(paper) {
  const size = paper === 'a4' ? 'A4' : 'letter';
  return `
    @import url('https://fonts.googleapis.com/css2?family=Noto+Sans:wght@400;600;700&family=Noto+Sans+JP&family=Noto+Sans+SC&display=swap');
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Noto Sans', Arial, sans-serif; font-size: 11pt; color: #1a1a1a; background: #fff; }
    @page { size: ${size}; margin: 18mm 15mm 18mm 15mm; }
    @media print {
      .no-print { display: none !important; }
      .page-break { page-break-before: always; }
      a { color: inherit; text-decoration: none; }
    }
    h1 { font-size: 22pt; font-weight: 700; margin-bottom: 6pt; }
    h2 { font-size: 15pt; font-weight: 700; margin: 18pt 0 6pt; border-bottom: 2px solid #2563eb; padding-bottom: 3pt; color: #2563eb; }
    h3 { font-size: 12pt; font-weight: 600; margin: 10pt 0 4pt; }
    p { margin-bottom: 4pt; line-height: 1.5; }
    .cover { text-align: center; padding: 60pt 0 40pt; }
    .cover .subtitle { font-size: 13pt; color: #555; margin-top: 8pt; }
    .cover .dates { font-size: 11pt; color: #888; margin-top: 4pt; }
    .day-section { margin-bottom: 20pt; }
    .day-header { background: #f0f4ff; padding: 6pt 10pt; border-left: 4px solid #2563eb; margin-bottom: 8pt; }
    .day-header h2 { border: none; margin: 0; padding: 0; font-size: 13pt; color: #1e3a8a; }
    .item { display: flex; gap: 12pt; margin-bottom: 8pt; padding: 6pt 0; border-bottom: 1px solid #eee; }
    .item-time { min-width: 60pt; font-size: 10pt; color: #555; padding-top: 1pt; }
    .item-body { flex: 1; }
    .item-title { font-weight: 600; font-size: 11pt; }
    .item-meta { font-size: 9.5pt; color: #666; margin-top: 2pt; }
    .item-conf { font-size: 9pt; color: #2563eb; font-family: monospace; margin-top: 2pt; }
    .reservation-card { border: 1px solid #ddd; border-radius: 4pt; padding: 8pt 10pt; margin-bottom: 8pt; }
    .reservation-card .conf { font-family: monospace; font-size: 10pt; color: #2563eb; }
    .essentials-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12pt; margin-top: 10pt; }
    .essentials-box { border: 1px solid #ddd; border-radius: 4pt; padding: 8pt; }
    .essentials-box h3 { font-size: 10pt; color: #2563eb; margin-bottom: 4pt; }
    .essentials-box p { font-size: 9.5pt; }
    .qr-placeholder { display: inline-block; width: 60pt; height: 60pt; border: 2px dashed #ccc; text-align: center; line-height: 60pt; font-size: 8pt; color: #aaa; vertical-align: middle; margin-left: 8pt; }
    .badge { display: inline-block; padding: 1pt 5pt; border-radius: 3pt; font-size: 8.5pt; font-weight: 600; }
    .badge-flight { background: #dbeafe; color: #1e40af; }
    .badge-hotel { background: #d1fae5; color: #065f46; }
    .badge-train { background: #fef3c7; color: #92400e; }
    .badge-activity { background: #ede9fe; color: #5b21b6; }
    .badge-restaurant { background: #fee2e2; color: #991b1b; }
    .footer { margin-top: 30pt; padding-top: 8pt; border-top: 1px solid #eee; font-size: 8.5pt; color: #aaa; text-align: center; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 10pt; }
    th { background: #f0f4ff; font-size: 9.5pt; padding: 4pt 6pt; text-align: left; border-bottom: 2px solid #2563eb; }
    td { font-size: 9.5pt; padding: 4pt 6pt; border-bottom: 1px solid #eee; }
  `;
}
function badgeClass(type) {
  const t = (type ?? '').toLowerCase();
  if (t.includes('flight')) return 'badge-flight';
  if (t.includes('hotel') || t.includes('lodg')) return 'badge-hotel';
  if (t.includes('train') || t.includes('bus')) return 'badge-train';
  if (t.includes('restaurant') || t.includes('food') || t.includes('dining')) return 'badge-restaurant';
  return 'badge-activity';
}
// ─── Main handler ───────────────────────────────────────────────────────────
Deno.serve(async (req)=>{
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders()
    });
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const url = new URL(req.url);
  const pathname = url.pathname;
  // Strip function prefix: /generate-offline-pack or /functions/v1/generate-offline-pack
  const pathParts = pathname.replace(/^\/functions\/v1\/generate-offline-pack/, '').replace(/^\/generate-offline-pack/, '') || '/';
  // ── /download/:token — no JWT required ────────────────────────────
  const downloadMatch = pathParts.match(/^\/download\/([^/]+)$/);
  if (downloadMatch && req.method === 'GET') {
    const token = downloadMatch[1];
    const { data: job, error } = await supabase.from('export_jobs').select('*').eq('result_token', token).maybeSingle();
    // 2026-09-19: was `if (error || !job)` — a failed export_jobs read was
    // reported to the person following a download link as "Download not found",
    // i.e. their export had vanished. Only an absent row is a 404.
    if (error) {
      console.error('[generate-offline-pack] export_jobs download lookup failed:', error.message);
      return errorResponse('DB_ERROR', error.message, 500);
    }
    if (!job) return errorResponse('NOT_FOUND', 'Download not found', 404);
    if (job.status !== 'ready') return errorResponse('NOT_READY', 'Export not ready', 409);
    if (job.expires_at && new Date(job.expires_at) < new Date()) {
      const { error: expireUpdateError } = await supabase.from('export_jobs').update({
        status: 'expired'
      }).eq('id', job.id);
      if (expireUpdateError) {
        console.error('[generate-offline-pack] export_jobs expire update failed (non-fatal):', expireUpdateError.message);
      }
      return errorResponse('EXPIRED', 'Download link has expired', 410);
    }
    // Return stored result
    const opts = job.options;
    const kind = job.kind;
    let contentType = 'application/json';
    if (kind === 'expenses') contentType = 'text/csv';
    else if (kind === 'calendar') contentType = 'text/calendar';
    else if (kind === 'itinerary') contentType = 'text/html';
    return new Response(opts.result_data ?? '', {
      headers: {
        'Content-Type': contentType,
        ...corsHeaders()
      }
    });
  }
  // ── All other routes require JWT ────────────────────────────────
  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) return errorResponse('UNAUTHORIZED', 'Missing authorization', 401);
  const { data: { user }, error: authError } = await supabase.auth.getUser(jwt);
  if (authError || !user) return errorResponse('UNAUTHORIZED', 'Unauthorized', 401);
  // ── GET /manifest ───────────────────────────────────────────────────
  if (req.method === 'GET' && pathParts === '/manifest') {
    const tripId = url.searchParams.get('tripId');
    if (!tripId) return errorResponse('BAD_REQUEST', 'tripId is required');
    if (!await requireTripOwner(supabase, tripId, user.id)) {
      return errorResponse('NOT_FOUND', 'Trip not found', 404);
    }
    // Check cached manifest
    const { data: cached, error: cachedManifestError } = await supabase.from('offline_manifests').select('*').eq('trip_id', tripId).maybeSingle();
    if (cachedManifestError) {
      console.error('[generate-offline-pack] offline_manifests cache lookup failed:', cachedManifestError.message);
    }
    // If fresh (< 5 min), return cached
    if (cached && cached.built_at) {
      const age = Date.now() - new Date(cached.built_at).getTime();
      if (age < 5 * 60 * 1000) {
        return jsonResponse({
          manifest: cached
        });
      }
    }
    // Build manifest
    // emergency_numbers is keyed on country_code and playbooks on key — neither
    // has an `id` column, so `.select('id')` was a 42703 and both counts were
    // always null (2026-09-19). `expenses` replaces the nonexistent
    // `expense_tracking`, so the money section can report a real count instead
    // of the hardcoded 0 that kept it permanently empty.
    const [itemsRes, reservationsRes, prepRes, phrasesRes, emergencyRes, playbooksRes, expensesRes] = await Promise.all([
      supabase.from('itinerary_items').select('id', {
        count: 'exact',
        head: true
      }).eq('trip_id', tripId),
      supabase.from('reservations').select('id', {
        count: 'exact',
        head: true
      }).eq('trip_id', tripId),
      supabase.from('prep_items').select('id', {
        count: 'exact',
        head: true
      }).eq('trip_id', tripId),
      supabase.from('dietary_phrase_cards').select('id', {
        count: 'exact',
        head: true
      }),
      supabase.from('emergency_numbers').select('country_code', {
        count: 'exact',
        head: true
      }),
      supabase.from('playbooks').select('key', {
        count: 'exact',
        head: true
      }),
      supabase.from('expenses').select('id', {
        count: 'exact',
        head: true
      }).eq('trip_id', tripId)
    ]);
    if (itemsRes.error) console.error('[generate-offline-pack] itinerary_items count failed:', itemsRes.error.message);
    if (reservationsRes.error) console.error('[generate-offline-pack] reservations count failed:', reservationsRes.error.message);
    if (prepRes.error) console.error('[generate-offline-pack] prep_items count failed:', prepRes.error.message);
    if (phrasesRes.error) console.error('[generate-offline-pack] dietary_phrase_cards count failed:', phrasesRes.error.message);
    if (emergencyRes.error) console.error('[generate-offline-pack] emergency_numbers count failed:', emergencyRes.error.message);
    if (playbooksRes.error) console.error('[generate-offline-pack] playbooks count failed:', playbooksRes.error.message);
    if (expensesRes.error) console.error('[generate-offline-pack] expenses count failed:', expensesRes.error.message);
    const itemCount = itemsRes.count ?? 0;
    const resCount = reservationsRes.count ?? 0;
    const prepCount = prepRes.count ?? 0;
    const phraseCount = phrasesRes.count ?? 0;
    const emergencyCount = emergencyRes.count ?? 0;
    // Was `?? 12` — a hardcoded playbook count invented whenever the (always
    // failing) query returned no count. A count we do not have is 0, not 12.
    const playbookCount = playbooksRes.count ?? 0;
    const expenseCount = expensesRes.count ?? 0;
    const sections = [
      {
        key: 'plan',
        label: 'Itinerary',
        count: itemCount,
        bytes: itemCount * 800,
        required: true
      },
      {
        key: 'reservations',
        label: 'Reservations',
        count: resCount,
        bytes: resCount * 600,
        required: true
      },
      {
        key: 'documents',
        label: 'Documents (next 72h)',
        count: 0,
        bytes: 0,
        required: false
      },
      {
        key: 'search_index',
        label: 'Search Index',
        count: itemCount,
        bytes: itemCount * 200,
        required: false
      },
      {
        key: 'sos',
        label: 'SOS Card',
        count: 1,
        bytes: 2048,
        required: true
      },
      {
        key: 'prep',
        label: 'Pre-trip Checklist',
        count: prepCount,
        bytes: prepCount * 300,
        required: true
      },
      {
        key: 'phrases',
        label: 'Phrase Cards',
        count: phraseCount,
        bytes: phraseCount * 400,
        required: false
      },
      {
        key: 'contacts',
        label: 'Emergency Contacts',
        count: emergencyCount,
        bytes: emergencyCount * 300,
        required: true
      },
      {
        key: 'playbooks',
        label: 'Disruption Playbooks',
        count: playbookCount,
        bytes: playbookCount * 1200,
        required: true
      },
      {
        key: 'money',
        label: 'Expense Snapshot',
        count: expenseCount,
        bytes: expenseCount * 300,
        required: false
      }
    ];
    const totalBytes = sections.reduce((s, sec)=>s + sec.bytes, 0);
    const manifest = {
      trip_id: tripId,
      version: (cached?.version ?? 0) + 1,
      built_at: new Date().toISOString(),
      sections,
      total_bytes: totalBytes
    };
    const { error: manifestUpsertError } = await supabase.from('offline_manifests').upsert(manifest, {
      onConflict: 'trip_id'
    });
    if (manifestUpsertError) {
      console.error('[generate-offline-pack] offline_manifests cache upsert failed:', manifestUpsertError.message);
    }
    return jsonResponse({
      manifest
    });
  }
  // ── GET /sections/:key ──────────────────────────────────────────────────
  const sectionMatch = pathParts.match(/^\/sections\/([^/?]+)/);
  if (req.method === 'GET' && sectionMatch) {
    const key = sectionMatch[1];
    const tripId = url.searchParams.get('tripId');
    if (!tripId) return errorResponse('BAD_REQUEST', 'tripId is required');
    if (!await requireTripOwner(supabase, tripId, user.id)) {
      return errorResponse('NOT_FOUND', 'Trip not found', 404);
    }
    switch(key){
      case 'plan':
        {
          // `starts_at` does not exist on itinerary_items — this route returned a
          // hard 500 on every call until 2026-09-19.
          const { data, error } = await supabase.from('itinerary_items').select('*').eq('trip_id', tripId).order('date', {
            ascending: true
          }).order('start_time', {
            ascending: true
          });
          if (error) return errorResponse('DB_ERROR', error.message, 500);
          return jsonResponse({
            key,
            data: data ?? [],
            note: null
          });
        }
      case 'reservations':
        {
          // reservations orders on start_date + start_time; it has no `starts_at`.
          const { data, error } = await supabase.from('reservations').select('*').eq('trip_id', tripId).order('start_date', {
            ascending: true
          }).order('start_time', {
            ascending: true
          });
          if (error) return errorResponse('DB_ERROR', error.message, 500);
          return jsonResponse({
            key,
            data: data ?? [],
            note: null
          });
        }
      case 'sos':
        {
          // 2026-09-25: numbers for THIS trip's countries only (was limit(20) of any country).
          const { data: sosTrip } = await supabase.from('trips').select('destination').eq('id', tripId).maybeSingle();
          const sosCountries = await tripCountryCodes(supabase, tripId, sosTrip?.destination);
          const [emergencyRes, phrasesRes] = await Promise.all([
            sosCountries.length ? supabase.from('emergency_numbers').select('*').in('country_code', sosCountries) : Promise.resolve({
              data: [],
              error: null
            }),
            supabase.from('dietary_phrase_cards').select('*').limit(20)
          ]);
          if (emergencyRes.error) console.error('[generate-offline-pack] emergency_numbers lookup failed:', emergencyRes.error.message);
          if (phrasesRes.error) console.error('[generate-offline-pack] dietary_phrase_cards lookup failed:', phrasesRes.error.message);
          return jsonResponse({
            key,
            data: {
              emergency_numbers: emergencyRes.data ?? [],
              phrase_cards: phrasesRes.data ?? [],
              disruption_guidance: DISRUPTION_GUIDANCE
            },
            note: null
          });
        }
      case 'prep':
        {
          const { data, error } = await supabase.from('prep_items').select('*').eq('trip_id', tripId);
          if (error) return errorResponse('DB_ERROR', error.message, 500);
          return jsonResponse({
            key,
            data: data ?? [],
            note: null
          });
        }
      case 'phrases':
        {
          const { data, error } = await supabase.from('dietary_phrase_cards').select('*');
          if (error) return errorResponse('DB_ERROR', error.message, 500);
          return jsonResponse({
            key,
            data: data ?? [],
            note: null
          });
        }
      case 'contacts':
        {
          const { data, error } = await supabase.from('emergency_numbers').select('*');
          if (error) return errorResponse('DB_ERROR', error.message, 500);
          return jsonResponse({
            key,
            data: data ?? [],
            note: null
          });
        }
      case 'playbooks':
        {
          const { data, error } = await supabase.from('playbooks').select('*');
          if (error) return errorResponse('DB_ERROR', error.message, 500);
          return jsonResponse({
            key,
            data: data ?? [],
            note: null
          });
        }
      case 'money':
        {
          // `expense_tracking` is not a table (42P01) and `date` is not a column
          // of the real one. The table is `expenses` and its date is `paid_at`.
          // The old catch-and-return-[] turned both failures into "this trip has
          // no expenses", which is a claim, not a degradation.
          const { data, error } = await supabase.from('expenses').select('id, description, amount, currency, category, paid_by, paid_at').eq('trip_id', tripId);
          if (error) {
            console.error('[generate-offline-pack] expenses lookup failed:', error.message);
            return errorResponse('DB_ERROR', error.message, 500);
          }
          return jsonResponse({
            key,
            data: data ?? [],
            note: null
          });
        }
      case 'documents':
        {
          // Graceful degradation
          return jsonResponse({
            key,
            data: [],
            note: 'documents section requires traveler_documents table'
          });
        }
      case 'search_index':
        {
          const { data, error: searchIndexError } = await supabase.from('itinerary_items').select('id, title, category, notes').eq('trip_id', tripId);
          if (searchIndexError) {
            console.error('[generate-offline-pack] itinerary_items search_index lookup failed:', searchIndexError.message);
          }
          const index = (data ?? []).map((item)=>({
              id: item.id,
              text: [
                item.title,
                item.category,
                item.notes
              ].filter(Boolean).join(' ')
            }));
          return jsonResponse({
            key,
            data: index,
            note: null
          });
        }
      default:
        return errorResponse('NOT_FOUND', `Unknown section: ${key}`, 404);
    }
  }
  // ── POST /exports ──────────────────────────────────────────────────
  if (req.method === 'POST' && pathParts === '/exports') {
    let body;
    try {
      body = await req.json();
    } catch  {
      return errorResponse('BAD_REQUEST', 'Invalid JSON');
    }
    const kind = body.kind;
    if (![
      'backup',
      'expenses',
      'itinerary',
      'calendar'
    ].includes(kind)) {
      return errorResponse('BAD_REQUEST', 'kind must be backup, expenses, itinerary, or calendar');
    }
    const tripId = body.tripId;
    const options = body.options ?? {};
    if (tripId && !await requireTripOwner(supabase, tripId, user.id)) {
      return errorResponse('NOT_FOUND', 'Trip not found', 404);
    }
    // ── Expenses export (always synchronous) ───────────────────
    if (kind === 'expenses') {
      // Was `expense_tracking` (42P01) behind a try/catch that produced a CSV
      // containing only its header — a file that says the trip had no spending.
      // `expenses` columns (2026-09-19): id, group_id, trip_id, description,
      // amount, currency, category, paid_by, paid_at, split_method,
      // receipt_url, notes, deleted_at, created_at, updated_at. There is no
      // `date` and no `split_with`.
      const { data: expenseRows, error: expensesError } = await supabase.from('expenses').select('*').eq('trip_id', tripId ?? '');
      if (expensesError) {
        console.error('[generate-offline-pack] expenses lookup failed:', expensesError.message);
        return errorResponse('DB_ERROR', expensesError.message, 500);
      }
      const rows = expenseRows ?? [];
      const header = 'Paid At,Description,Amount,Currency,Category,Paid By,Split Method,Notes';
      const lines = rows.map((r)=>{
        const splits = r.split_method ?? '';
        return [
          r.paid_at ?? '',
          `"${String(r.description ?? '').replace(/"/g, '""')}"`,
          r.amount ?? '',
          r.currency ?? '',
          r.category ?? '',
          r.paid_by ?? '',
          `"${String(splits).replace(/"/g, '""')}"`,
          `"${String(r.notes ?? '').replace(/"/g, '""')}"`
        ].join(',');
      });
      const csv = [
        header,
        ...lines
      ].join('\n');
      const jobId = generateId('exp_');
      const token = generateDownloadToken();
      const now = new Date();
      const expires = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      const { error: exportJobInsertError } = await supabase.from('export_jobs').insert({
        id: jobId,
        trip_id: tripId ?? null,
        user_id: user.id,
        kind,
        options: {
          ...options,
          result_data: csv
        },
        status: 'ready',
        result_token: token,
        bytes: new TextEncoder().encode(csv).length,
        completed_at: now.toISOString(),
        expires_at: expires.toISOString()
      });
      if (exportJobInsertError) {
        // Non-fatal: the CSV below is the real, already-computed response;
        // only the ability to re-download it later via the job/token is lost.
        console.error('[generate-offline-pack] export_jobs insert failed (non-fatal):', exportJobInsertError.message);
      }
      return new Response(csv, {
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': `attachment; filename="expenses-${tripId ?? 'all'}.csv"`,
          ...corsHeaders()
        }
      });
    }
    // ── Calendar export (synchronous) ────────────────────────
    if (kind === 'calendar') {
      const { data: items, error: calendarItemsError } = await supabase.from('itinerary_items').select('*').eq('trip_id', tripId ?? '').order('date', {
        ascending: true
      }).order('start_time', {
        ascending: true
      });
      if (calendarItemsError) {
        console.error('[generate-offline-pack] itinerary_items lookup failed:', calendarItemsError.message);
        return errorResponse('DB_ERROR', calendarItemsError.message, 500);
      }
      const events = (items ?? []).map((item)=>{
        // `item.starts_at` / `ends_at` / `tz` were all undefined (no such
        // columns), so every VEVENT was emitted with no DTSTART and no DTEND —
        // an .ics of untimed, unplaceable events.
        const start = itemMoment(item.date, item.start_time);
        const end = itemMoment(item.date, item.end_time);
        const startStamp = icsStamp(start);
        const endStamp = icsStamp(end);
        const dtstart = startStamp ? `DTSTART${startStamp}` : '';
        const dtend = endStamp ? `DTEND${endStamp}` : '';
        return [
          'BEGIN:VEVENT',
          dtstart,
          dtend,
          `SUMMARY:${escapeICS(item.title ?? '')}`,
          `DESCRIPTION:${escapeICS(item.notes ?? item.category ?? '')}`,
          `LOCATION:${escapeICS(item.location ?? '')}`,
          `UID:${item.id}@travelos`,
          'END:VEVENT'
        ].filter((l)=>l && !l.endsWith(':') && !l.endsWith(';')).join('\r\n');
      });
      const ics = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//TravelOS//TravelOS//EN',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        ...events,
        'END:VCALENDAR'
      ].join('\r\n');
      const jobId = generateId('exp_');
      const token = generateDownloadToken();
      const now = new Date();
      const expires = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      const { error: exportJobInsertError } = await supabase.from('export_jobs').insert({
        id: jobId,
        trip_id: tripId ?? null,
        user_id: user.id,
        kind,
        options: {
          ...options,
          result_data: ics
        },
        status: 'ready',
        result_token: token,
        bytes: new TextEncoder().encode(ics).length,
        completed_at: now.toISOString(),
        expires_at: expires.toISOString()
      });
      if (exportJobInsertError) {
        // Non-fatal: the ICS below is the real, already-computed response;
        // only the ability to re-download it later via the job/token is lost.
        console.error('[generate-offline-pack] export_jobs insert failed (non-fatal):', exportJobInsertError.message);
      }
      return new Response(ics, {
        headers: {
          'Content-Type': 'text/calendar',
          'Content-Disposition': `attachment; filename="itinerary-${tripId ?? 'all'}.ics"`,
          ...corsHeaders()
        }
      });
    }
    // ── Itinerary PDF (async job) ────────────────────────
    if (kind === 'itinerary') {
      const jobId = generateId('exp_');
      const token = generateDownloadToken();
      const now = new Date();
      // FAIL CLOSED: unlike the expenses/calendar/backup exports above, this
      // response has no synchronous payload — it only promises the caller a
      // pending job they can poll for. If the insert silently failed, the
      // caller would be told a job exists that was never created.
      const { error: pendingJobInsertError } = await supabase.from('export_jobs').insert({
        id: jobId,
        trip_id: tripId ?? null,
        user_id: user.id,
        kind,
        options,
        status: 'pending',
        result_token: token,
        created_at: now.toISOString()
      });
      if (pendingJobInsertError) {
        return errorResponse('DB_ERROR', `Failed to create export job: ${pendingJobInsertError.message}`, 500);
      }
      return jsonResponse({
        jobId,
        status: 'pending',
        message: 'Export is being prepared. Use GET /itinerary.pdf for immediate HTML output.',
        pdfUrl: `${SUPABASE_URL}/functions/v1/generate-offline-pack/itinerary.pdf?tripId=${tripId ?? ''}`
      });
    }
    // ── Backup export ───────────────────────────────────
    if (kind === 'backup') {
      if (!tripId) return errorResponse('BAD_REQUEST', 'tripId is required for backup export');
      const [tripRes, itemsRes, reservationsRes, membersRes, prepRes] = await Promise.all([
        supabase.from('trips').select('*').eq('id', tripId).maybeSingle(),
        supabase.from('itinerary_items').select('*').eq('trip_id', tripId),
        supabase.from('reservations').select('*').eq('trip_id', tripId),
        supabase.from('trip_members').select('*').eq('trip_id', tripId),
        supabase.from('prep_items').select('*').eq('trip_id', tripId)
      ]);
      if (tripRes.error) console.error('[generate-offline-pack] trips lookup failed:', tripRes.error.message);
      if (itemsRes.error) console.error('[generate-offline-pack] itinerary_items lookup failed:', itemsRes.error.message);
      if (reservationsRes.error) console.error('[generate-offline-pack] reservations lookup failed:', reservationsRes.error.message);
      if (membersRes.error) console.error('[generate-offline-pack] trip_members lookup failed:', membersRes.error.message);
      if (prepRes.error) console.error('[generate-offline-pack] prep_items lookup failed:', prepRes.error.message);
      const trip = tripRes.data;
      if (!trip) return errorResponse('NOT_FOUND', 'Trip not found', 404);
      // Was `expense_tracking` (42P01) swallowed into an empty list, so every
      // backup ever taken claimed the trip had no expenses. A backup that
      // silently omits a whole table is worse than no backup, so a failure here
      // is now a 500.
      const { data: expenseRows, error: expensesError } = await supabase.from('expenses').select('*').eq('trip_id', tripId);
      if (expensesError) {
        console.error('[generate-offline-pack] expenses lookup failed:', expensesError.message);
        return errorResponse('DB_ERROR', `Backup aborted, expenses could not be read: ${expensesError.message}`, 500);
      }
      const expenses = expenseRows ?? [];
      const backup = {
        schemaVersion: 2,
        exportedAt: new Date().toISOString(),
        trip: {
          id: trip.id,
          title: trip.name ?? trip.title ?? '',
          destination: trip.destination ?? '',
          startDate: trip.start_date ?? '',
          endDate: trip.end_date ?? '',
          // trips has no `currency` column; it has `base_currency`. The old
          // `trip.currency ?? 'USD'` stamped every backup as US dollars.
          currency: trip.base_currency ?? null
        },
        items: (itemsRes.data ?? []).map((item)=>({
            id: item.id,
            title: item.title,
            category: item.category,
            date: item.date ?? null,
            startsAt: item.start_time ?? null,
            endsAt: item.end_time ?? null,
            tz: item.timezone ?? null,
            placeId: item.place_id ?? null,
            notes: item.notes ?? null,
            memberIds: item.member_ids ?? []
          })),
        reservations: (reservationsRes.data ?? []).map((r)=>({
            id: r.id,
            type: r.type ?? r.reservation_type ?? '',
            providerName: r.provider_name ?? '',
            confirmationNumber: r.confirmation_number ?? '',
            startsAt: reservationMoment(r.start_date, r.start_time),
            endsAt: reservationMoment(r.end_date, r.end_time),
            memberIds: r.member_ids ?? []
          })),
        // `amount_minor`, `paid_by_member_id`, `splits` and `date` are not
        // columns of `expenses`; only `amount`, `paid_by`, `split_method` and
        // `paid_at` are. An amount we do not have is null, not 0, and a
        // currency we do not have is null, not USD.
        expenses: expenses.map((e)=>({
            id: e.id,
            description: e.description ?? '',
            amount: e.amount ?? null,
            amountMinor: e.amount == null ? null : Math.round(Number(e.amount) * 100),
            currency: e.currency ?? null,
            category: e.category ?? '',
            paidBy: e.paid_by ?? null,
            splitMethod: e.split_method ?? null,
            paidAt: e.paid_at ?? null
          })),
        members: (membersRes.data ?? []).map((m)=>({
            id: m.id,
            displayName: m.display_name ?? m.name ?? '',
            role: m.role ?? 'member'
          }))
      };
      const json = JSON.stringify(backup, null, 2);
      const jobId = generateId('exp_');
      const token = generateDownloadToken();
      const now = new Date();
      const expires = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      const { error: exportJobInsertError } = await supabase.from('export_jobs').insert({
        id: jobId,
        trip_id: tripId,
        user_id: user.id,
        kind,
        options: {
          ...options,
          result_data: json
        },
        status: 'ready',
        result_token: token,
        bytes: new TextEncoder().encode(json).length,
        completed_at: now.toISOString(),
        expires_at: expires.toISOString()
      });
      if (exportJobInsertError) {
        // Non-fatal: the JSON backup below is the real, already-computed
        // response; only the ability to re-download it later via the
        // job/token is lost.
        console.error('[generate-offline-pack] export_jobs insert failed (non-fatal):', exportJobInsertError.message);
      }
      return new Response(json, {
        headers: {
          'Content-Type': 'application/json',
          'Content-Disposition': `attachment; filename="trip-backup-${tripId}.json"`,
          ...corsHeaders()
        }
      });
    }
    return errorResponse('BAD_REQUEST', 'Unsupported kind');
  }
  // ── GET /exports/:jobId ───────────────────────────────────────────
  const exportJobMatch = pathParts.match(/^\/exports\/([^/?]+)$/);
  if (req.method === 'GET' && exportJobMatch) {
    const jobId = exportJobMatch[1];
    const { data: job, error } = await supabase.from('export_jobs').select('id, trip_id, kind, status, bytes, created_at, completed_at, expires_at, error_message, result_token').eq('id', jobId).eq('user_id', user.id).maybeSingle();
    // 2026-09-19: was `if (error || !job)`. A polling client told "not found"
    // stops polling and loses the export; a failed read is a 500.
    if (error) {
      console.error('[generate-offline-pack] export_jobs status lookup failed:', error.message);
      return errorResponse('DB_ERROR', error.message, 500);
    }
    if (!job) return errorResponse('NOT_FOUND', 'Export job not found', 404);
    const baseUrl = `${SUPABASE_URL}/functions/v1/generate-offline-pack`;
    const signedUrl = job.status === 'ready' && job.result_token ? `${baseUrl}/download/${job.result_token}` : null;
    return jsonResponse({
      jobId: job.id,
      tripId: job.trip_id,
      kind: job.kind,
      status: job.status,
      bytes: job.bytes,
      createdAt: job.created_at,
      completedAt: job.completed_at,
      expiresAt: job.expires_at,
      errorMessage: job.error_message,
      downloadUrl: signedUrl
    });
  }
  // ── GET /itinerary.pdf ─────────────────────────────────────────────────
  if (req.method === 'GET' && pathParts.startsWith('/itinerary.pdf')) {
    const tripId = url.searchParams.get('tripId');
    const layout = url.searchParams.get('layout') ?? 'day_by_day';
    const paper = url.searchParams.get('paper') ?? 'a4';
    const fromDate = url.searchParams.get('from');
    const toDate = url.searchParams.get('to');
    const memberFilter = url.searchParams.get('member');
    if (!tripId) return errorResponse('BAD_REQUEST', 'tripId is required');
    const [tripRes, itemsRes, reservationsRes] = await Promise.all([
      supabase.from('trips').select('*').eq('id', tripId).eq('user_id', user.id).maybeSingle(),
      supabase.from('itinerary_items').select('*').eq('trip_id', tripId).order('date', {
        ascending: true
      }).order('start_time', {
        ascending: true
      }),
      supabase.from('reservations').select('*').eq('trip_id', tripId).order('start_date', {
        ascending: true
      }).order('start_time', {
        ascending: true
      })
    ]);
    if (tripRes.error) console.error('[generate-offline-pack] trips lookup failed:', tripRes.error.message);
    if (itemsRes.error) console.error('[generate-offline-pack] itinerary_items lookup failed:', itemsRes.error.message);
    if (reservationsRes.error) console.error('[generate-offline-pack] reservations lookup failed:', reservationsRes.error.message);
    const trip = tripRes.data;
    if (!trip) return errorResponse('NOT_FOUND', 'Trip not found', 404);
    let items = itemsRes.data ?? [];
    let reservations = reservationsRes.data ?? [];
    // 2026-09-25: emergency numbers for the trip's own countries only (computed
    // from ALL the trip's items, before any date/member filter below).
    const tripCountries = await tripCountryCodes(supabase, tripId, trip.destination, items);
    let emergency = [];
    if (tripCountries.length) {
      const emergencyRes = await supabase.from('emergency_numbers').select('*').in('country_code', tripCountries);
      if (emergencyRes.error) console.error('[generate-offline-pack] emergency_numbers lookup failed:', emergencyRes.error.message);
      emergency = emergencyRes.data ?? [];
    }
    // Apply date range filter
    // Filtered on `starts_at`, which is undefined on every row, so `'' >= from`
    // was false for all items and the PDF came back empty whenever a date range
    // was supplied. Both tables carry a plain date column; compare on that.
    if (fromDate) {
      items = items.filter((i)=>(i.date ?? '') >= fromDate);
      reservations = reservations.filter((r)=>(r.start_date ?? '') >= fromDate);
    }
    if (toDate) {
      items = items.filter((i)=>(i.date ?? '') <= toDate);
      reservations = reservations.filter((r)=>(r.start_date ?? '') <= toDate);
    }
    // Apply member filter
    if (memberFilter) {
      items = items.filter((i)=>{
        const ids = i.member_ids ?? [];
        return ids.length === 0 || ids.includes(memberFilter);
      });
    }
    const tripName = htmlEscape(trip.name ?? trip.title ?? 'Trip Itinerary');
    const tripDest = htmlEscape(trip.destination ?? '');
    const tripStart = trip.start_date ?? '';
    const tripEnd = trip.end_date ?? '';
    const generatedAt = new Date().toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
    let bodyHtml = '';
    if (layout === 'essentials') {
      // One-page essentials
      const lodging = reservations.filter((r)=>{
        const t = (r.type ?? r.reservation_type ?? '').toString().toLowerCase();
        return t.includes('hotel') || t.includes('lodg') || t.includes('airbnb');
      });
      bodyHtml = `
        <div class="cover">
          <h1>${tripName}</h1>
          <div class="subtitle">${tripDest}</div>
          <div class="dates">${tripStart} – ${tripEnd}</div>
        </div>
        <h2>Essential Information</h2>
        <div class="essentials-grid">
          <div class="essentials-box">
            <h3>🏨 Lodging</h3>
            ${lodging.map((r)=>`<p><strong>${htmlEscape(r.provider_name ?? '')}</strong><br>${htmlEscape(r.address ?? r.location_name ?? '')}<br><span class="conf">${htmlEscape(r.confirmation_number ?? '')}</span></p>`).join('') || '<p>No lodging added</p>'}
          </div>
          <div class="essentials-box">
            <h3>🚨 Emergency Numbers</h3>
            ${emergency.map((e)=>{
        const svcs = [
          [
            'Police',
            e.police
          ],
          [
            'Ambulance',
            e.ambulance
          ],
          [
            'Fire',
            e.fire
          ],
          [
            'General',
            e.general
          ]
        ].filter(([, v])=>typeof v === 'string' && v).map(([k, v])=>`${k}: ${htmlEscape(v)}`).join(' · ');
        return svcs ? `<p><strong>${htmlEscape(e.country_code ?? '')}</strong> ${svcs}</p>` : '';
      }).join('') || (tripCountries.length ? `<p>No verified emergency numbers on file for ${htmlEscape(tripCountries.join(', '))}</p>` : '<p>No trip country known — no emergency numbers shown</p>')}
          </div>
          <div class="essentials-box">
            <h3>✈️ Flights</h3>
            ${reservations.filter((r)=>(r.type ?? r.reservation_type ?? '').toString().toLowerCase().includes('flight')).map((r)=>`<p><strong>${htmlEscape(r.provider_name ?? '')}</strong> ${htmlEscape(r.confirmation_number ?? '')}<br>${htmlEscape(reservationMoment(r.start_date, r.start_time) ?? '')}</p>`).join('') || '<p>No flights added</p>'}
          </div>
          <div class="essentials-box">
            <h3>📋 Trip Info</h3>
            <p><strong>Destination:</strong> ${tripDest}</p>
            <p><strong>Dates:</strong> ${tripStart} – ${tripEnd}</p>
            <p><strong>Generated:</strong> ${generatedAt}</p>
          </div>
        </div>
      `;
    } else if (layout === 'bookings') {
      bodyHtml = `
        <div class="cover">
          <h1>${tripName}</h1>
          <div class="subtitle">All Reservations</div>
          <div class="dates">${tripStart} – ${tripEnd}</div>
        </div>
        <h2>Reservations</h2>
        <table>
          <thead><tr><th>Type</th><th>Provider</th><th>Confirmation #</th><th>Date</th><th>Location</th></tr></thead>
          <tbody>
            ${reservations.map((r)=>`
              <tr>
                <td><span class="badge ${badgeClass(r.type ?? r.reservation_type ?? '')}">${htmlEscape(r.type ?? r.reservation_type ?? '')}</span></td>
                <td>${htmlEscape(r.provider_name ?? '')}</td>
                <td class="conf">${htmlEscape(r.confirmation_number ?? '—')}</td>
                <td>${htmlEscape(reservationMoment(r.start_date, r.start_time) ?? '')}</td>
                <td>${htmlEscape(r.location_name ?? r.address ?? '')}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;
    } else if (layout === 'compact') {
      // Group by date, two days per page
      const dayMap = new Map();
      for (const item of items){
        const d = itemMoment(item.date, item.start_time).date;
        if (!dayMap.has(d)) dayMap.set(d, []);
        dayMap.get(d).push(item);
      }
      const days = Array.from(dayMap.entries()).sort(([a], [b])=>a.localeCompare(b));
      let dayIdx = 0;
      const daySections = days.map(([date, dayItems])=>{
        dayIdx++;
        const pageBreak = dayIdx > 1 && dayIdx % 2 === 1 ? '<div class="page-break"></div>' : '';
        return `${pageBreak}<div class="day-section"><div class="day-header"><h2>${htmlEscape(date)}</h2></div>
          ${dayItems.map((item)=>`
            <div class="item">
              <div class="item-time">${htmlEscape(itemMoment(item.date, item.start_time).time.substring(0, 5))}</div>
              <div class="item-body"><div class="item-title">${htmlEscape(item.title ?? '')}</div></div>
            </div>
          `).join('')}
        </div>`;
      }).join('');
      bodyHtml = `
        <div class="cover"><h1>${tripName}</h1><div class="subtitle">${tripDest}</div><div class="dates">${tripStart} – ${tripEnd}</div></div>
        ${daySections}
      `;
    } else {
      // day_by_day (default)
      const dayMap = new Map();
      for (const item of items){
        const d = itemMoment(item.date, item.start_time).date;
        if (!dayMap.has(d)) dayMap.set(d, []);
        dayMap.get(d).push(item);
      }
      const days = Array.from(dayMap.entries()).sort(([a], [b])=>a.localeCompare(b));
      const daySections = days.map(([date, dayItems], idx)=>{
        const pageBreak = idx > 0 ? '<div class="page-break"></div>' : '';
        const dayLabel = new Date(date + 'T12:00:00').toLocaleDateString('en-US', {
          weekday: 'long',
          month: 'long',
          day: 'numeric'
        });
        return `${pageBreak}<div class="day-section"><div class="day-header"><h2>Day ${idx + 1} — ${htmlEscape(dayLabel)}</h2></div>
          ${dayItems.map((item)=>{
          const time = itemMoment(item.date, item.start_time).time.substring(0, 5);
          const endTime = itemMoment(item.date, item.end_time).time.substring(0, 5);
          const timeRange = time ? endTime ? `${time} – ${endTime}` : time : '';
          const conf = item.confirmation_number ?? '';
          return `
              <div class="item">
                <div class="item-time">${htmlEscape(timeRange)}</div>
                <div class="item-body">
                  <div class="item-title">${htmlEscape(item.title ?? '')}</div>
                  ${item.location ? `<div class="item-meta">📍 ${htmlEscape(item.location)}</div>` : ''}
                  ${item.notes ? `<div class="item-meta">${htmlEscape(item.notes)}</div>` : ''}
                  ${conf ? `<div class="item-conf">Conf: ${htmlEscape(conf)}</div>` : ''}
                </div>
                <div class="qr-placeholder">QR</div>
              </div>
            `;
        }).join('')}
        </div>`;
      }).join('');
      bodyHtml = `
        <div class="cover">
          <h1>${tripName}</h1>
          <div class="subtitle">${tripDest}</div>
          <div class="dates">${tripStart} – ${tripEnd}</div>
          <p style="margin-top:20pt;font-size:9pt;color:#aaa;">Generated ${generatedAt} · TravelOS</p>
        </div>
        ${daySections}
        ${reservations.length > 0 ? `
          <div class="page-break"></div>
          <h2>All Reservations</h2>
          ${reservations.map((r)=>`
            <div class="reservation-card">
              <span class="badge ${badgeClass(r.type ?? r.reservation_type ?? '')}">${htmlEscape(r.type ?? r.reservation_type ?? '')}</span>
              <strong style="margin-left:6pt">${htmlEscape(r.provider_name ?? '')}</strong>
              ${r.confirmation_number ? `<span class="conf" style="margin-left:8pt">Conf: ${htmlEscape(r.confirmation_number)}</span>` : ''}
              <div class="item-meta" style="margin-top:4pt">${htmlEscape(reservationMoment(r.start_date, r.start_time) ?? '')} ${r.location_name ? '· ' + htmlEscape(r.location_name) : ''}</div>
            </div>
          `).join('')}
        ` : ''}
      `;
    }
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${tripName} — Itinerary</title>
  <style>${printCSS(paper)}</style>
</head>
<body>
  ${bodyHtml}
  <div class="footer no-print">TravelOS · Printed ${generatedAt} · For personal use only</div>
  <script class="no-print">
    // Auto-print hint
    window.addEventListener('load', () => {
      document.title = '${tripName} — Itinerary';
    });
  <\/script>
</body>
</html>`;
    return new Response(html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Disposition': `inline; filename="itinerary-${tripId}.html"`,
        ...corsHeaders()
      }
    });
  }
  // ── Legacy routes (v1 preserved) ────────────────────────────────────
  if (req.method === 'GET' && (pathParts === '/' || pathParts === '')) {
    const trip_id = url.searchParams.get('trip_id');
    if (!trip_id) return errorResponse('BAD_REQUEST', 'trip_id is required');
    const { data: pack, error } = await supabase.from('offline_trip_packs').select('id,trip_id,pack_status,generated_at,last_updated_at,data_version,pack_size_bytes,settings,selected_document_ids,selected_information_ids,error_message').eq('trip_id', trip_id).eq('user_id', user.id).maybeSingle();
    if (error) return errorResponse('DB_ERROR', error.message, 500);
    return jsonResponse({
      pack: pack ?? null
    });
  }
  if (req.method === 'POST' && (pathParts === '/' || pathParts === '')) {
    let body;
    try {
      body = await req.json();
    } catch  {
      return errorResponse('BAD_REQUEST', 'Invalid JSON');
    }
    const trip_id = body.trip_id;
    if (!trip_id) return errorResponse('BAD_REQUEST', 'trip_id is required');
    const action = body.action;
    if (action === 'update_settings') {
      const { data: updated, error } = await supabase.from('offline_trip_packs').update({
        settings: body.settings
      }).eq('trip_id', trip_id).eq('user_id', user.id).select().single();
      if (error) return errorResponse('DB_ERROR', error.message, 500);
      const { pack_data: _pd, ...rest } = updated;
      return jsonResponse({
        pack: rest
      });
    }
    if (action === 'mark_outdated') {
      const { error } = await supabase.from('offline_trip_packs').update({
        pack_status: 'OUTDATED'
      }).eq('trip_id', trip_id).eq('user_id', user.id).in('pack_status', [
        'READY'
      ]);
      if (error) return errorResponse('DB_ERROR', error.message, 500);
      return jsonResponse({
        success: true
      });
    }
    if (action === 'delete') {
      const { error } = await supabase.from('offline_trip_packs').delete().eq('trip_id', trip_id).eq('user_id', user.id);
      if (error) return errorResponse('DB_ERROR', error.message, 500);
      return jsonResponse({
        success: true
      });
    }
    // Legacy generate
    const selected_document_ids = body.selected_document_ids ?? null;
    const selected_information_ids = body.selected_information_ids ?? null;
    const settings = body.settings ?? null;
    const { data: trip, error: tripError } = await supabase.from('trips').select('*').eq('id', trip_id).eq('user_id', user.id).single();
    if (tripError || !trip) return errorResponse('NOT_FOUND', 'Trip not found', 404);
    const { data: existingPack, error: existingPackError } = await supabase.from('offline_trip_packs').select('id,pack_status,data_version,settings').eq('trip_id', trip_id).eq('user_id', user.id).maybeSingle();
    if (existingPackError) {
      console.error('[generate-offline-pack] offline_trip_packs existing-pack lookup failed:', existingPackError.message);
    }
    const currentVersion = existingPack?.data_version ?? 0;
    const mergedSettings = settings ?? existingPack?.settings ?? {
      include_documents: true,
      include_emergency_contacts: true,
      include_reservation_details: true,
      include_addresses: true,
      include_notes: true,
      auto_mark_stale: true
    };
    const upsertPayload = {
      user_id: user.id,
      trip_id,
      pack_status: 'PREPARING',
      settings: mergedSettings,
      ...selected_document_ids ? {
        selected_document_ids
      } : {},
      ...selected_information_ids ? {
        selected_information_ids
      } : {}
    };
    const { data: preparingPack, error: upsertError } = await supabase.from('offline_trip_packs').upsert(upsertPayload, {
      onConflict: 'trip_id'
    }).select().single();
    if (upsertError) return errorResponse('DB_ERROR', upsertError.message, 500);
    try {
      const [itineraryResult, activeVersionResult, reservationsResult, infoResult] = await Promise.all([
        supabase.from('itinerary_items').select('*').eq('trip_id', trip_id).order('date', {
          ascending: true,
          nullsFirst: false
        }).order('start_time', {
          ascending: true,
          nullsFirst: false
        }),
        supabase.from('itinerary_versions').select('id, version_number').eq('trip_id', trip_id).eq('is_active', true).order('version_number', {
          ascending: false
        }).limit(1).maybeSingle(),
        supabase.from('reservations').select('*').eq('trip_id', trip_id).eq('user_id', user.id).in('reservation_status', [
          'CONFIRMED',
          'PENDING'
        ]).order('start_date', {
          ascending: true,
          nullsFirst: false
        }),
        selected_information_ids && selected_information_ids.length > 0 ? supabase.from('important_information').select('*').eq('trip_id', trip_id).eq('user_id', user.id).in('id', selected_information_ids) : supabase.from('important_information').select('*').eq('trip_id', trip_id).eq('user_id', user.id)
      ]);
      if (itineraryResult.error) console.error('[generate-offline-pack] itinerary_items lookup failed:', itineraryResult.error.message);
      if (activeVersionResult.error) console.error('[generate-offline-pack] itinerary_versions active lookup failed:', activeVersionResult.error.message);
      if (reservationsResult.error) console.error('[generate-offline-pack] reservations lookup failed:', reservationsResult.error.message);
      if (infoResult.error) console.error('[generate-offline-pack] important_information lookup failed:', infoResult.error.message);
      const itineraryItems = itineraryResult.data ?? [];
      const reservations = reservationsResult.data ?? [];
      const importantInfo = infoResult.data ?? [];
      const now = new Date();
      const upcomingReservations = reservations.filter((r)=>r.start_date && new Date(r.start_date + 'T' + (r.start_time || '00:00')) > now).sort((a, b)=>new Date(a.start_date + 'T' + (a.start_time || '00:00')).getTime() - new Date(b.start_date + 'T' + (b.start_time || '00:00')).getTime());
      const nextReservation = upcomingReservations[0] ?? null;
      let whatIsNext = null;
      if (nextReservation) {
        whatIsNext = {
          type: 'RESERVATION',
          title: nextReservation.provider_name ?? nextReservation.reservation_type,
          provider: nextReservation.provider_name ?? null,
          date: nextReservation.start_date,
          time: nextReservation.start_time ?? null,
          location: nextReservation.location_name ?? nextReservation.city ?? null,
          confirmation_number: nextReservation.confirmation_number ?? null,
          reservation_id: nextReservation.id
        };
      }
      // itinerary_items → days (ITINERARY RECONCILIATION 2026-09-24). Section
      // stays null when the items could not be read or there are none, as
      // before when there was no active GI row.
      let itinerarySection = null;
      if (!itineraryResult.error && itineraryItems.length > 0) {
        const tripTz = trip.primary_tz ?? null;
        const days = itemsToDays(itineraryItems, tripTz, trip.start_date ?? null);
        itinerarySection = {
          version: activeVersionResult.data?.version_number ?? null,
          version_id: activeVersionResult.data?.id ?? null,
          timezone: tripTz,
          days: days.map((day)=>({
              day_number: day.day_number,
              date: day.date,
              label: null,
              activities: day.items.map((act)=>({
                  id: act.id,
                  name: act.title ?? null,
                  time: itemLocalTime(act, tripTz),
                  duration: act.duration_min ?? null,
                  location: act.location ?? null,
                  is_confirmed: act.fixed === true,
                  is_must_do: act.must_do === true,
                  // itinerary_items has no "optional" flag (droppable defaults to true
                  // for every item), so this is not inferred.
                  is_optional: false,
                  notes: act.notes ?? null
                }))
            }))
        };
      }
      const locationTypeMap = {
        HOTEL: 'HOTEL',
        FLIGHT: 'AIRPORT',
        TRAIN: 'TRAIN_STATION',
        BUS: 'TRAIN_STATION',
        RENTAL_CAR: 'RENTAL_CAR',
        RESTAURANT: 'RESTAURANT',
        TOUR: 'ACTIVITY',
        ACTIVITY: 'ACTIVITY',
        EVENT: 'ACTIVITY'
      };
      const locations = reservations.filter((r)=>r.location_name || r.address || r.city).map((r)=>({
          name: r.location_name ?? r.provider_name ?? r.reservation_type,
          address: r.address ?? null,
          latitude: r.latitude ?? null,
          longitude: r.longitude ?? null,
          location_type: locationTypeMap[r.reservation_type] ?? 'OTHER',
          reservation_id: r.id
        }));
      let duration_days = 0;
      if (trip.start_date && trip.end_date) {
        const start = new Date(trip.start_date);
        const end = new Date(trip.end_date);
        duration_days = Math.max(1, Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1);
      }
      const packData = {
        pack_version: '1.0',
        generated_at: now.toISOString(),
        trip: {
          id: trip.id,
          name: trip.name,
          destination: trip.destination ?? null,
          start_date: trip.start_date ?? null,
          end_date: trip.end_date ?? null,
          travelers: null,
          duration_days
        },
        what_is_next: whatIsNext,
        reservations: reservations.map((r)=>({
            id: r.id,
            reservation_type: r.reservation_type,
            provider_name: r.provider_name ?? null,
            confirmation_number: r.confirmation_number ?? null,
            reservation_status: r.reservation_status,
            start_date: r.start_date ?? null,
            start_time: r.start_time ?? null,
            end_date: r.end_date ?? null,
            end_time: r.end_time ?? null,
            timezone: r.timezone ?? null,
            location_name: r.location_name ?? null,
            address: r.address ?? null,
            city: r.city ?? null,
            country: r.country ?? null,
            details: r.details ?? {},
            notes: r.notes ?? null
          })),
        itinerary: itinerarySection,
        important_contacts: importantInfo.map((info)=>({
            id: info.id,
            information_type: info.information_type,
            title: info.title,
            contact_name: info.contact_name ?? null,
            organization: info.organization ?? null,
            phone: info.phone ?? null,
            email: info.email ?? null,
            address: info.address ?? null,
            notes: info.notes ?? null
          })),
        documents: [],
        critical_issues: [],
        disruption_guidance: DISRUPTION_GUIDANCE,
        locations
      };
      const packJson = JSON.stringify(packData);
      const pack_size_bytes = new TextEncoder().encode(packJson).length;
      const { data: readyPack, error: updateError } = await supabase.from('offline_trip_packs').update({
        pack_status: 'READY',
        pack_data: packData,
        pack_size_bytes,
        generated_at: now.toISOString(),
        last_updated_at: now.toISOString(),
        data_version: currentVersion + 1,
        error_message: null,
        ...selected_document_ids ? {
          selected_document_ids
        } : {},
        ...selected_information_ids ? {
          selected_information_ids
        } : {}
      }).eq('trip_id', trip_id).eq('user_id', user.id).select().single();
      if (updateError) return errorResponse('DB_ERROR', updateError.message, 500);
      const { pack_data: _pd, ...restPack } = readyPack;
      return jsonResponse({
        pack: restPack,
        pack_data: packData
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const prevStatus = existingPack?.pack_status;
      if (!prevStatus || prevStatus === 'NOT_CREATED' || prevStatus === 'ERROR' || prevStatus === 'PREPARING') {
        const { error: markErrorStatusError } = await supabase.from('offline_trip_packs').update({
          pack_status: 'ERROR',
          error_message: errMsg
        }).eq('trip_id', trip_id).eq('user_id', user.id);
        if (markErrorStatusError) {
          console.error('[generate-offline-pack] offline_trip_packs error-status update failed (non-fatal):', markErrorStatusError.message);
        }
      }
      return errorResponse('INTERNAL', errMsg, 500);
    }
  }
  return errorResponse('METHOD_NOT_ALLOWED', 'Method not allowed', 405);
});

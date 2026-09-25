import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { corsHeaders, json, fail, serviceClient, requireUser, requireTripOwner } from './_shared/auth.ts';
// MEMBER EXPORT 2026-09-25 — export was owner-only (requireTripOwner), so a
// trip member who was not the owner got 404 "Trip not found" from Export to
// calendar. generate_ics, generate_csv, sync_to_calendar and
// save_event_mapping now accept any active account member of the trip
// (trip_members kind 'account', removed_at IS NULL, any role including
// viewer), resolved from the JWT through auth_identities.provider_subject.
// Non-members still get 404.
//
// Reservations are private per row (RLS: auth.uid() = reservations.user_id),
// and the export carries confirmation numbers and notes. So the trip OWNER
// still exports every reservation on the trip, exactly as before, while any
// other member exports the shared itinerary plus only THEIR OWN reservations.
// create_share_link stays owner-only: minting a public link is the owner's
// call.
//
// The EMOJI_MAP literals are now written with String.fromCodePoint instead of
// backslash-u surrogate escapes. Same strings, byte for byte; the escapes
// were being rewritten in transit by the deploy tooling.
// SECURITY 2026-09-16 — this function previously had NO authentication at all.
//
// It built a service_role client on the first line of the handler and took
// `user_id` and `trip_id` straight from the POST body. Every action was
// reachable by anyone who knew the URL:
//
//   generate_ics      — returned any trip's full itinerary, including
//                       confirmation numbers and contact details
//   connect_calendar  — wrote OAuth access_token / refresh_token rows for any
//                       user_id. The worst of them: an attacker could plant
//                       their own calendar credentials on a victim's account,
//                       or overwrite a victim's.
//   create_share_link — minted a public share token for any trip
//
// Every action now derives the user from a verified JWT and checks trip
// ownership. `get_shared_trip` remains deliberately public: it is the
// share-token redemption endpoint and authenticates by token, by design.
//
// COLUMN FIX 2026-09-19 — this file was written against a schema that does not
// exist. Every query below named columns that are not on their table, so
// PostgREST rejected each whole statement with 42703 and the discarded error
// was reported to the caller as "no data":
//
//   shareable_calendars has NO `is_active`, `owner_id`, `is_public`,
//     `allow_edit`, `allow_comment` or `updated_at`. Its real columns are
//     id, trip_id, share_token, expires_at, access_level, created_by,
//     created_at, view_count — and `id` and `share_token` are NOT NULL with
//     no default, so both must be supplied on insert.
//     Consequences: `get_shared_trip` always answered "Share link not found or
//     inactive" (404); `create_share_link` always failed; `get_share_links`
//     always returned an error; `revoke_share_link` never revoked anything.
//   trips has NO `description` or `cover_image`.
//   reservations has NO `title`, `name`, `type`, `check_in`, `check_out`,
//     `location`, `venue`, `status`, `departure_time`, `arrival_time`, `date`
//     or `contact_info`. The real columns are `reservation_type`,
//     `provider_name`, `location_name`, `address`, `reservation_status`, and
//     a split `start_date`/`start_time` + `end_date`/`end_time`.
//   itinerary_items has NO `name`, `address`, `description`, `start_date` or
//     `end_date`. It has `title`, `location`, `notes`, and `date` +
//     `start_time`/`end_time`.
//
// The knock-on effect on generate_ics was total: even where `select('*')`
// meant no 42703 was raised, every date the event builder read
// (`r.check_in`, `r.departure_time`, `item.start_date`, ...) was `undefined`,
// so `dtstart` was empty and `if (!dtstart) continue` skipped EVERY event.
// The .ics this function returned contained no VEVENTs at all, for every
// trip, while still reporting a successful export.
//
// Dates are now built from the real split date/time columns and emitted as
// floating local times (or VALUE=DATE when only a date is known) rather than
// being forced to UTC, because the stored time has no offset attached and
// inventing one would move events by hours.
//
// ICS TIME FIX 2026-09-25 — itinerary_items.start_time / end_time are
// timestamptz, not 'HH:MM'. PostgREST returns them as ISO strings
// ('2026-11-02T05:00:00+00:00'), which icsTimePart() could never match, so
// EVERY itinerary item exported as an all-day event. Itinerary items with a
// start_time now export as timed events in UTC form (DTSTART:...Z), which is
// unambiguous because the stored value carries an offset. DTEND comes from
// end_time, else start + duration_min, else start + 1h. Items with only a
// `date` stay all-day. Reservations are unaffected: their start_time/end_time
// are `time without time zone` + a separate date, so the floating-local path
// above is still correct for them.
//
// ALL-DAY DTEND FIX 2026-09-25 — RFC 5545 DTEND;VALUE=DATE is exclusive. A
// single-day event (no end date, or end date == start date) was emitted with
// DTEND equal to DTSTART, a zero-length event that several clients drop or
// render on the wrong day; it now ends on start + 1 day. A multi-day event
// (end date > start date) keeps DTEND = the end date itself, so a hotel
// 11-02 -> 11-05 shows 11-02..11-04 and the checkout day is not blocked,
// which is how calendars show hotel stays.
//
// ICS FORMAT FIX 2026-09-25 — foldLine() counted UTF-16 code units, not
// octets, so a SUMMARY with an emoji or accented text produced lines over the
// 75-octet limit. It now folds by UTF-8 octets without splitting a character.
// escapeICS() now normalises CR/CRLF to \n (a bare CR previously leaked into
// the output), X-WR-CALNAME is folded, and the file ends with CRLF.
function escapeICS(str) {
  if (!str) return '';
  return str.replace(/\r\n?/g, '\n').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}
function formatICSStamp(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}
/** 'YYYY-MM-DD' (or an ISO timestamp) -> 'YYYYMMDD'. '' when unusable. */ function icsDatePart(date) {
  if (!date) return '';
  const s = String(date).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  return s.replace(/-/g, '');
}
/** 'HH:MM' or 'HH:MM:SS' -> 'HHMMSS'. '' when absent or unusable. */ function icsTimePart(time) {
  if (!time) return '';
  const s = String(time);
  const m = s.match(/^(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return '';
  return `${m[1]}${m[2]}${m[3] ?? '00'}`;
}
function icsMoment(date, time) {
  const d = icsDatePart(date);
  if (!d) return null;
  const t = icsTimePart(time);
  if (!t) return {
    value: d,
    allDay: true
  };
  return {
    value: `${d}T${t}`,
    allDay: false
  };
}
/** Folds at 75 octets (UTF-8), never splitting a character. RFC 5545 3.1. */ function foldLine(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out = [];
  let cur = '';
  let curLen = 0;
  let limit = 75; // first line 75; continuations 74 + leading space
  for (const ch of line){
    const n = enc.encode(ch).length;
    if (curLen + n > limit) {
      out.push(cur);
      cur = '';
      curLen = 0;
      limit = 74;
    }
    cur += ch;
    curLen += n;
  }
  out.push(cur);
  return out.map((l, i)=>i === 0 ? l : ' ' + l).join('\r\n');
}
/** 'YYYYMMDD' + n days -> 'YYYYMMDD'. */ function addDaysIcsDate(d, n) {
  const t = Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8)) + n * 86400000;
  return new Date(t).toISOString().slice(0, 10).replace(/-/g, '');
}
/** Parses a timestamptz ISO string to epoch ms; null unless it has a date part. */ function parseTimestamp(v) {
  if (!v) return null;
  const s = String(v);
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s)) return null;
  const ms = new Date(s).getTime();
  return isNaN(ms) ? null : ms;
}
/**
 * Start/end for an itinerary item. start_time/end_time are timestamptz, so a
 * timed item is emitted in UTC ('YYYYMMDDTHHMMSSZ'). Only an item with a date
 * but no start_time is all-day.
 */ function itineraryMoments(item) {
  const startMs = parseTimestamp(item.start_time);
  if (startMs === null) {
    // No timestamptz start. Keep the legacy 'HH:MM' path for any old row.
    return {
      start: icsMoment(item.date, item.start_time),
      end: icsMoment(item.date, item.end_time ?? item.start_time)
    };
  }
  let endMs = parseTimestamp(item.end_time);
  if (endMs === null || endMs <= startMs) {
    const dur = Number(item.duration_min);
    endMs = startMs + (Number.isFinite(dur) && dur > 0 ? dur : 60) * 60000;
  }
  return {
    start: {
      value: formatICSStamp(new Date(startMs).toISOString()),
      allDay: false
    },
    end: {
      value: formatICSStamp(new Date(endMs).toISOString()),
      allDay: false
    }
  };
}
const EMOJI_MAP = {
  FLIGHT: String.fromCodePoint(0x2708, 0xfe0f),
  HOTEL: String.fromCodePoint(0x1f3e8),
  DINING: String.fromCodePoint(0x1f37d, 0xfe0f),
  ACTIVITY: String.fromCodePoint(0x1f3ad),
  TRANSPORT: String.fromCodePoint(0x1f697)
};
function getEmoji(type) {
  return EMOJI_MAP[type?.toUpperCase()] ?? String.fromCodePoint(0x1f4c5);
}
function getCategory(type) {
  const t = type?.toUpperCase();
  if (t === 'FLIGHT') return 'FLIGHT';
  if (t === 'HOTEL' || t === 'ACCOMMODATION') return 'HOTEL';
  if (t === 'DINING' || t === 'RESTAURANT') return 'DINING';
  if (t === 'ACTIVITY') return 'ACTIVITY';
  if (t === 'TRANSPORT' || t === 'CAR' || t === 'TRAIN') return 'TRANSPORT';
  return 'ACTIVITY';
}
/**
 * Owner, or an active account member of the trip (any role). 404 otherwise,
 * so a caller cannot probe which trip ids exist.
 */ async function requireTripMember(service, tripId, authUid) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(tripId))) {
    return fail('Trip not found', 404);
  }
  const { data: trip, error: tripErr } = await service.from('trips').select('id, user_id').eq('id', tripId).maybeSingle();
  if (tripErr) return fail(`Trip lookup failed: ${tripErr.message}`, 500);
  if (!trip) return fail('Trip not found', 404);
  if (trip.user_id === authUid) return {
    isOwner: true
  };
  // One auth user can hold several auth_identities rows (one per sign-in
  // method), so this reads them all rather than .maybeSingle(), which errors
  // on a second row and would silently deny.
  const { data: idents, error: identErr } = await service.from('auth_identities').select('user_id').eq('provider_subject', authUid);
  if (identErr) return fail(`Identity lookup failed: ${identErr.message}`, 500);
  const platformIds = [
    ...new Set((idents ?? []).map((r)=>r.user_id).filter(Boolean))
  ];
  if (platformIds.length === 0) return fail('Trip not found', 404);
  const { data: members, error: memErr } = await service.from('trip_members').select('id').eq('trip_id', tripId).in('user_id', platformIds).eq('kind', 'account').is('removed_at', null).limit(1);
  if (memErr) return fail(`Membership lookup failed: ${memErr.message}`, 500);
  if (!members || members.length === 0) return fail('Trip not found', 404);
  return {
    isOwner: false
  };
}
function generateId() {
  return 'shc_' + crypto.randomUUID().replace(/-/g, '');
}
function generateShareToken() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 20);
}
Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: corsHeaders
    });
  }
  const supabase = serviceClient();
  let body;
  try {
    body = await req.json();
  } catch  {
    return fail('Invalid JSON body', 400);
  }
  const { action } = body;
  if (!action) return fail('Missing action', 400);
  try {
    // ── get_shared_trip — PUBLIC BY DESIGN ──────────────────────
    // Authenticates by unguessable share token. Handled before the auth gate.
    if (action === 'get_shared_trip') {
      const { share_token } = body;
      if (!share_token) return fail('Missing share_token', 400);
      // COLUMN FIX 2026-09-19 — dropped `.eq('is_active', true)`:
      // shareable_calendars has no is_active column, and that one filter made
      // this whole query 42703, so every share link resolved to 404.
      const { data: share, error: shareErr } = await supabase.from('shareable_calendars').select('*').eq('share_token', share_token).maybeSingle();
      if (shareErr) {
        console.error('[calendar-export] share lookup failed:', shareErr.message);
        return fail(`Share lookup failed: ${shareErr.message}`, 500);
      }
      if (!share) return fail('Share link not found', 404);
      if (share.expires_at && new Date(share.expires_at) < new Date()) {
        return fail('Share link has expired', 410);
      }
      const { error: viewErr } = await supabase.from('shareable_calendars').update({
        view_count: (share.view_count ?? 0) + 1
      }).eq('id', share.id);
      if (viewErr) console.error('[calendar-export] view_count update failed:', viewErr.message);
      // COLUMN FIX 2026-09-19 — `description` and `cover_image` are not columns
      // on trips; requesting them made this whole select 42703 and the shared
      // page received `trip: null`.
      const { data: trip, error: tripErr } = await supabase.from('trips').select('id, name, title, start_date, end_date, destination').eq('id', share.trip_id).maybeSingle();
      if (tripErr) {
        console.error('[calendar-export] shared trip lookup failed:', tripErr.message);
        return fail(`Trip lookup failed: ${tripErr.message}`, 500);
      }
      // COLUMN FIX 2026-09-19 — title/name/type/check_in/check_out/location/
      // venue/status are not columns on reservations.
      const { data: reservations, error: resErr } = await supabase.from('reservations').select('id, reservation_type, provider_name, location_name, address, city, country, start_date, start_time, end_date, end_time, timezone, reservation_status').eq('trip_id', share.trip_id);
      if (resErr) {
        console.error('[calendar-export] shared reservations lookup failed:', resErr.message);
        return fail(`Reservations lookup failed: ${resErr.message}`, 500);
      }
      // COLUMN FIX 2026-09-19 — name/address/description are not columns on
      // itinerary_items; the real ones are title, location and notes.
      const { data: itineraryItems, error: itemsErr } = await supabase.from('itinerary_items').select('id, title, type, category, start_time, end_time, date, location, notes').eq('trip_id', share.trip_id);
      if (itemsErr) {
        console.error('[calendar-export] shared itinerary_items lookup failed:', itemsErr.message);
        return fail(`Itinerary lookup failed: ${itemsErr.message}`, 500);
      }
      return json({
        trip,
        reservations: reservations ?? [],
        itinerary_items: itineraryItems ?? [],
        // COLUMN FIX 2026-09-19 — allow_edit / allow_comment / is_public are
        // not stored on shareable_calendars. The table records a single
        // `access_level`; reporting that instead of inventing three booleans.
        share_settings: {
          access_level: share.access_level,
          expires_at: share.expires_at
        }
      });
    }
    // ── AUTH GATE — everything below requires a verified user ──────────────
    const auth = await requireUser(req);
    if (auth instanceof Response) return auth;
    const userId = auth.userId; // from the JWT, never the body
    // ── generate_ics ──────────────────────────────
    if (action === 'generate_ics') {
      const { trip_id } = body;
      if (!trip_id) return fail('Missing trip_id', 400);
      const access = await requireTripMember(supabase, trip_id, userId);
      if (access instanceof Response) return access;
      const { data: trip, error: tripErr } = await supabase.from('trips').select('*').eq('id', trip_id).maybeSingle();
      if (tripErr) return fail(`Trip lookup failed: ${tripErr.message}`, 500);
      if (!trip) return fail('Trip not found', 404);
      let resQuery = supabase.from('reservations').select('*').eq('trip_id', trip_id);
      if (!access.isOwner) resQuery = resQuery.eq('user_id', userId); // members: own reservations only
      const { data: reservations, error: resErr } = await resQuery;
      if (resErr) return fail(`Reservations lookup failed: ${resErr.message}`, 500);
      const { data: itineraryItems, error: itemsErr } = await supabase.from('itinerary_items').select('*').eq('trip_id', trip_id);
      if (itemsErr) return fail(`Itinerary lookup failed: ${itemsErr.message}`, 500);
      const now = formatICSStamp(new Date().toISOString());
      const lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//TravelOS//TravelOS Calendar//EN',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        foldLine(`X-WR-CALNAME:${escapeICS(trip.name ?? trip.title ?? 'Trip')}`)
      ];
      const events = [];
      for (const r of reservations ?? []){
        const cat = getCategory(r.reservation_type ?? '');
        const desc = [
          r.confirmation_number ? `Confirmation: ${r.confirmation_number}` : '',
          r.notes ? `Notes: ${r.notes}` : ''
        ].filter(Boolean).join('\n');
        const resStatus = String(r.reservation_status ?? '').toUpperCase();
        events.push({
          id: `${trip_id}_${r.id}@travelos.app`,
          type: cat,
          title: `${getEmoji(cat)} ${r.location_name ?? r.provider_name ?? r.reservation_type ?? 'Reservation'}`,
          start: icsMoment(r.start_date, r.start_time),
          end: icsMoment(r.end_date ?? r.start_date, r.end_time ?? r.start_time),
          location: [
            r.location_name,
            r.address,
            r.city,
            r.country
          ].filter(Boolean).join(', '),
          description: desc,
          status: resStatus === 'CANCELLED' ? 'CANCELLED' : resStatus === 'PENDING' ? 'TENTATIVE' : 'CONFIRMED'
        });
      }
      for (const item of itineraryItems ?? []){
        const cat = getCategory(item.type ?? item.category ?? 'ACTIVITY');
        const desc = item.notes ? `Notes: ${item.notes}` : '';
        const m = itineraryMoments(item);
        events.push({
          id: `${trip_id}_${item.id}@travelos.app`,
          type: cat,
          title: `${getEmoji(cat)} ${item.title ?? 'Activity'}`,
          start: m.start,
          end: m.end,
          location: item.location ?? '',
          description: desc,
          status: String(item.status ?? '').toUpperCase() === 'CANCELLED' ? 'CANCELLED' : 'CONFIRMED'
        });
      }
      let emitted = 0;
      for (const ev of events){
        if (!ev.start) continue;
        const end = ev.end ?? ev.start;
        lines.push('BEGIN:VEVENT');
        // All-day: DTEND;VALUE=DATE is EXCLUSIVE (RFC 5545). Multi-day (end
        // date after start date): DTEND = end date, so the checkout day is not
        // blocked. Missing or same-day end: DTEND = start + 1 day.
        let dtend;
        if (ev.start.allDay) {
          const endDate = end.value.slice(0, 8);
          dtend = endDate > ev.start.value ? `DTEND;VALUE=DATE:${endDate}` : `DTEND;VALUE=DATE:${addDaysIcsDate(ev.start.value, 1)}`;
        } else {
          dtend = end.allDay ? `DTEND;VALUE=DATE:${end.value}` : `DTEND:${end.value}`;
        }
        lines.push(foldLine(`UID:${ev.id}`));
        lines.push(`DTSTAMP:${now}`);
        lines.push(ev.start.allDay ? `DTSTART;VALUE=DATE:${ev.start.value}` : `DTSTART:${ev.start.value}`);
        lines.push(dtend);
        lines.push(foldLine(`SUMMARY:${escapeICS(ev.title)}`));
        if (ev.description) lines.push(foldLine(`DESCRIPTION:${escapeICS(ev.description)}`));
        if (ev.location) lines.push(foldLine(`LOCATION:${escapeICS(ev.location)}`));
        lines.push(`CATEGORIES:${ev.type}`);
        lines.push(`STATUS:${ev.status}`);
        lines.push('SEQUENCE:0');
        lines.push('END:VEVENT');
        emitted++;
      }
      lines.push('END:VCALENDAR');
      const ics_content = lines.join('\r\n') + '\r\n';
      const filename = `${(trip.name ?? trip.title ?? 'trip').replace(/[^a-z0-9]/gi, '_')}.ics`;
      return json({
        ics_content,
        filename,
        event_count: emitted,
        // Reported honestly: entries with no usable date are skipped rather
        // than given an invented one.
        skipped_without_date: events.length - emitted
      });
    }
    // ── generate_csv ──────────────────────────────
    if (action === 'generate_csv') {
      const { trip_id } = body;
      if (!trip_id) return fail('Missing trip_id', 400);
      const access = await requireTripMember(supabase, trip_id, userId);
      if (access instanceof Response) return access;
      const { data: trip, error: tripErr } = await supabase.from('trips').select('name, title').eq('id', trip_id).maybeSingle();
      if (tripErr) return fail(`Trip lookup failed: ${tripErr.message}`, 500);
      let resQuery = supabase.from('reservations').select('*').eq('trip_id', trip_id);
      if (!access.isOwner) resQuery = resQuery.eq('user_id', userId); // members: own reservations only
      const { data: reservations, error: resErr } = await resQuery;
      if (resErr) return fail(`Reservations lookup failed: ${resErr.message}`, 500);
      const csvEscape = (v)=>{
        const s = String(v ?? '');
        if (s.includes(',') || s.includes('"') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`;
        return s;
      };
      const header = [
        'Date',
        'Time',
        'Type',
        'Title',
        'Location',
        'Confirmation',
        'Status',
        'Notes'
      ];
      const rows = [
        header
      ];
      // COLUMN FIX 2026-09-19 — every field here previously read a column that
      // does not exist on reservations, so each row was blank but for the
      // confirmation number and notes.
      for (const r of reservations ?? []){
        rows.push([
          String(r.start_date ?? ''),
          String(r.start_time ?? ''),
          String(r.reservation_type ?? ''),
          String(r.location_name ?? r.provider_name ?? ''),
          [
            r.location_name,
            r.address,
            r.city,
            r.country
          ].filter(Boolean).join(', '),
          String(r.confirmation_number ?? ''),
          String(r.reservation_status ?? ''),
          String(r.notes ?? '')
        ]);
      }
      const csv_content = rows.map((row)=>row.map(csvEscape).join(',')).join('\n');
      const filename = `${(trip?.name ?? trip?.title ?? 'trip').replace(/[^a-z0-9]/gi, '_')}_reservations.csv`;
      return json({
        csv_content,
        filename,
        row_count: rows.length - 1
      });
    }
    // ── get_connections ────────────────────────────
    if (action === 'get_connections') {
      const { data, error } = await supabase.from('calendar_connections').select('id, user_id, provider, provider_calendar_id, provider_email, sync_direction, conflict_resolution, last_sync_at, is_active, created_at, updated_at').eq('user_id', userId).eq('is_active', true);
      if (error) return fail(error.message, 500);
      return json({
        connections: data ?? []
      });
    }
    // ── connect_calendar ─────────────────────────
    // Writes OAuth tokens. `user_id` is now the JWT subject, so a caller can
    // only ever attach a calendar to their own account.
    if (action === 'connect_calendar') {
      const { provider, access_token, refresh_token, token_expires_at, provider_email, provider_calendar_id } = body;
      if (!provider) return fail('Missing provider', 400);
      const { data, error } = await supabase.from('calendar_connections').upsert({
        user_id: userId,
        provider,
        access_token,
        refresh_token,
        token_expires_at,
        provider_email,
        provider_calendar_id,
        is_active: true,
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'user_id,provider'
      }).select('id, provider, provider_email').single();
      if (error) return fail(error.message, 500);
      return json({
        connection_id: data.id,
        provider: data.provider,
        provider_email: data.provider_email
      });
    }
    // ── disconnect_calendar ───────────────────────
    if (action === 'disconnect_calendar') {
      const { provider } = body;
      if (!provider) return fail('Missing provider', 400);
      const { error } = await supabase.from('calendar_connections').update({
        is_active: false,
        updated_at: new Date().toISOString()
      }).eq('user_id', userId).eq('provider', provider);
      if (error) return fail(error.message, 500);
      return json({
        success: true
      });
    }
    // ── sync_to_calendar ─────────────────────────
    if (action === 'sync_to_calendar') {
      const { trip_id, provider } = body;
      if (!trip_id || !provider) return fail('Missing trip_id or provider', 400);
      const access = await requireTripMember(supabase, trip_id, userId);
      if (access instanceof Response) return access;
      // COLUMN FIX 2026-09-19 — `title`, `name` and `type` are not columns on
      // reservations, so this select was 42703 and the sync plan was built
      // from an empty reservation list: every existing booking looked like it
      // needed deleting from the connected calendar.
      let syncResQuery = supabase.from('reservations').select('id, location_name, provider_name, reservation_type').eq('trip_id', trip_id);
      if (!access.isOwner) syncResQuery = syncResQuery.eq('user_id', userId); // members: own reservations only
      const { data: reservations, error: resErr } = await syncResQuery;
      if (resErr) return fail(`Reservations lookup failed: ${resErr.message}`, 500);
      // COLUMN FIX 2026-09-19 — `name` is not a column on itinerary_items.
      const { data: itineraryItems, error: itemsErr } = await supabase.from('itinerary_items').select('id, title, type, category').eq('trip_id', trip_id);
      if (itemsErr) return fail(`Itinerary lookup failed: ${itemsErr.message}`, 500);
      const { data: existingMappings, error: mapErr } = await supabase.from('calendar_event_mappings').select('trip_event_id').eq('user_id', userId).eq('trip_id', trip_id).eq('provider', provider);
      if (mapErr) return fail(`Calendar mapping lookup failed: ${mapErr.message}`, 500);
      const mappedIds = new Set((existingMappings ?? []).map((m)=>m.trip_event_id));
      const syncPlan = [];
      let toCreate = 0, toUpdate = 0;
      for (const r of reservations ?? []){
        const id = String(r.id);
        const title = r.location_name ?? r.provider_name ?? r.reservation_type ?? 'Reservation';
        if (mappedIds.has(id)) {
          syncPlan.push({
            event_id: id,
            action: 'update',
            title
          });
          toUpdate++;
        } else {
          syncPlan.push({
            event_id: id,
            action: 'create',
            title
          });
          toCreate++;
        }
      }
      for (const item of itineraryItems ?? []){
        const id = String(item.id);
        const title = item.title ?? item.type ?? 'Activity';
        if (mappedIds.has(id)) {
          syncPlan.push({
            event_id: id,
            action: 'update',
            title
          });
          toUpdate++;
        } else {
          syncPlan.push({
            event_id: id,
            action: 'create',
            title
          });
          toCreate++;
        }
      }
      const currentIds = new Set([
        ...reservations ?? [],
        ...itineraryItems ?? []
      ].map((e)=>String(e.id)));
      let toDelete = 0;
      for (const mid of mappedIds){
        if (!currentIds.has(mid)) {
          syncPlan.push({
            event_id: mid,
            action: 'delete',
            title: '(removed)'
          });
          toDelete++;
        }
      }
      return json({
        events_to_create: toCreate,
        events_to_update: toUpdate,
        events_to_delete: toDelete,
        sync_plan: syncPlan
      });
    }
    // ── save_event_mapping ───────────────────────
    if (action === 'save_event_mapping') {
      const { trip_id, trip_event_id, trip_event_type, provider, calendar_id, calendar_event_id, sync_hash } = body;
      if (!trip_id || !trip_event_id || !provider || !calendar_id || !calendar_event_id) {
        return fail('Missing required fields', 400);
      }
      const access = await requireTripMember(supabase, trip_id, userId);
      if (access instanceof Response) return access;
      const { data, error } = await supabase.from('calendar_event_mappings').upsert({
        user_id: userId,
        trip_id,
        trip_event_id,
        trip_event_type,
        provider,
        calendar_id,
        calendar_event_id,
        sync_hash,
        last_synced_at: new Date().toISOString()
      }, {
        onConflict: 'user_id,trip_event_id,provider'
      }).select('id').single();
      if (error) return fail(error.message, 500);
      return json({
        mapping_id: data.id
      });
    }
    // ── create_share_link ────────────────────────
    // Mints a public token. Trip ownership is now required.
    if (action === 'create_share_link') {
      const { trip_id, allow_edit, expires_in_days } = body;
      if (!trip_id) return fail('Missing trip_id', 400);
      const owns = await requireTripOwner(supabase, trip_id, userId);
      if (owns instanceof Response) return owns;
      // COLUMN FIX 2026-09-19 — the previous insert wrote owner_id, is_public,
      // allow_edit and allow_comment, none of which exist on
      // shareable_calendars, and omitted `id` and `share_token`, which are
      // NOT NULL with no default. Every create_share_link call failed.
      // The table records the permission as a single `access_level`.
      const insertRow = {
        id: generateId(),
        trip_id,
        share_token: generateShareToken(),
        created_by: userId,
        access_level: allow_edit ? 'edit' : 'view'
      };
      if (expires_in_days && expires_in_days > 0) {
        const d = new Date();
        d.setDate(d.getDate() + expires_in_days);
        insertRow.expires_at = d.toISOString();
      }
      const { data, error } = await supabase.from('shareable_calendars').insert(insertRow).select('share_token, expires_at, access_level').single();
      if (error) return fail(error.message, 500);
      return json({
        share_token: data.share_token,
        share_url: `https://travelos.app/shared/${data.share_token}`,
        expires_at: data.expires_at,
        access_level: data.access_level
      });
    }
    // ── get_share_links ──────────────────────────
    if (action === 'get_share_links') {
      const { trip_id } = body;
      if (!trip_id) return fail('Missing trip_id', 400);
      // COLUMN FIX 2026-09-19 — was filtered on owner_id and is_active, neither
      // of which exists; the owner column is created_by and there is no active
      // flag, so unexpired links are listed instead.
      const { data, error } = await supabase.from('shareable_calendars').select('*').eq('created_by', userId).eq('trip_id', trip_id).gt('expires_at', new Date().toISOString()).order('created_at', {
        ascending: false
      });
      if (error) return fail(error.message, 500);
      return json({
        share_links: data ?? []
      });
    }
    // ── revoke_share_link ────────────────────────
    if (action === 'revoke_share_link') {
      const { share_id } = body;
      if (!share_id) return fail('Missing share_id', 400);
      // COLUMN FIX 2026-09-19 — this set is_active/updated_at and filtered on
      // owner_id; none of the three exists on shareable_calendars, so the
      // statement was rejected and nothing was ever revoked while the caller
      // was told `success: true`. Revocation is a delete, matching
      // calendar-share's revoke path.
      const { error } = await supabase.from('shareable_calendars').delete().eq('id', share_id).eq('created_by', userId);
      if (error) return fail(error.message, 500);
      return json({
        success: true
      });
    }
    // ── log_sync_error ─────────────────────────
    if (action === 'log_sync_error') {
      const { provider, operation, error_code, error_message, connection_id } = body;
      if (!provider || !operation) return fail('Missing required fields', 400);
      const { data, error } = await supabase.from('calendar_sync_errors').insert({
        user_id: userId,
        provider,
        operation,
        error_code,
        error_message,
        connection_id: connection_id ?? null
      }).select('id').single();
      if (error) return fail(error.message, 500);
      return json({
        error_id: data.id
      });
    }
    // ── get_sync_errors ─────────────────────────
    if (action === 'get_sync_errors') {
      const { data, error } = await supabase.from('calendar_sync_errors').select('*').eq('user_id', userId).eq('is_resolved', false).order('created_at', {
        ascending: false
      }).limit(20);
      if (error) return fail(error.message, 500);
      return json({
        errors: data ?? []
      });
    }
    return fail(`Unknown action: ${action}`, 400);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(message, 500);
  }
});

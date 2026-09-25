// FABRICATION REMOVED 2026-09-19 — this function invented its entire answer.
// ---------------------------------------------------------------------------
// If you are reading this with no other context: until today, every answer this
// function gave a traveller about whether their booking was still available,
// and whether it could still be cancelled for free, was made up. No provider
// was ever contacted. There is no availability provider in this project.
//
// What was here, verbatim:
//
//   function getAvailabilityStatus(reservation_id: string): 'AVAILABLE' | 'LIMITED' | 'UNAVAILABLE' {
//     const digits = reservation_id.replace(/\D/g, '').slice(0, 4);
//     const num = parseInt(digits || '5000', 10) % 10;
//     if (num < 7) return 'AVAILABLE';
//     if (num < 9) return 'LIMITED';
//     return 'UNAVAILABLE';
//   }
//
// That is the availability of a hotel room decided by the digits in a database
// id. It is deterministic, so the same booking always got the same confident
// answer and looked stable and real. ~70% of ids hashed to 'AVAILABLE'.
// `check_availability` and `monitor_all` both served it.
//
// `get_cancellation_policy` was the same defect with money attached:
//
//   const checkIn = new Date(reservation.check_in);
//   const freeCancellationUntil = new Date(checkIn.getTime() - 48 * 60 * 60 * 1000).toISOString();
//   return jsonResponse({ policy_type: 'Free cancellation', free_cancellation_until: freeCancellationUntil, checked_at });
//
// Every reservation that existed was reported as "Free cancellation" with a
// deadline of exactly 48 hours before check-in — a number that came from
// nowhere but arithmetic. Every reservation that did NOT exist (including one
// belonging to another user, or a typo'd id) was reported as "Non-refundable",
// with HTTP 200 and no indication that nothing had been found. A traveller
// could have skipped cancelling inside a deadline this function invented, or
// eaten a cancellation fee because it claimed a booking was non-refundable.
//
// WHAT IT DOES NOW
// No provider is contacted because none exists, and nothing is computed. The
// function reports only what is actually stored, and says where it came from:
//
//   * public.reservations carries real, provider-sourced columns —
//     availability_status, cancellation_policy_type, cancellation_deadline,
//     free_cancellation_until, current_price_amount, price_last_checked_at
//     (verified against information_schema.columns on 2026-09-19). Where a
//     stored value is present it is returned as-is with `source` naming the
//     exact column it came from.
//   * public.booking_reservations, the other reservation store and the one
//     this endpoint's text ids address, has NO availability or cancellation
//     columns at all (verified the same way: id, user_id, trip_id, provider,
//     provider_id, type, name, location, check_in, check_out, status,
//     total_price, currency, guests, confirmation_number, notes, raw_data,
//     last_updated, created_at). For a booking_reservations row the honest
//     answer is always "not recorded".
//   * Where the column is null, the response says it is not recorded. It never
//     guesses, and it never falls back to a policy name.
//
// Nothing is written to the database by this function, and nothing ever was.
//
// The unavailable responses use this project's ProviderResult envelope
// (`{ data: null, status: 'unavailable', ... }`, see PROMPT_5A2) plus a
// human-readable safeFailureMessage, so a UI that renders this cannot
// accidentally present absence as a reassuring answer.
//
// Two id spaces meet here: booking_reservations.id is TEXT and reservations.id
// is UUID. Passing a non-UUID text id to a uuid column makes PostgREST reject
// the whole query with 22P02, so the reservations lookup is attempted only for
// an id that is actually a UUID. Both stores are checked, and ownership is
// enforced against the verified caller in both.
// ---------------------------------------------------------------------------
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const NO_PROVIDER_REASON = 'no_availability_provider_configured';
const NO_PROVIDER_MESSAGE = 'TravelOS cannot check live availability or cancellation terms: no booking provider is connected. ' + 'Confirm directly with the provider or on your confirmation email.';
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json'
    }
  });
}
function getServiceClient() {
  return createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));
}
async function getAuthUser(req) {
  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const supabase = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_ANON_KEY'));
  const { data, error } = await supabase.auth.getUser(token);
  if (error) {
    console.error('[availability-monitor] auth.getUser failed:', error.message);
    return null;
  }
  if (!data.user) return null;
  return data.user;
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * Locates a reservation the caller owns, in whichever of the two stores holds
 * it. Returns a Response only for a real query failure (500) — a row that is
 * simply absent comes back as null so the caller can answer 404.
 */ async function findReservation(db, reservationId, userId) {
  if (UUID_RE.test(reservationId)) {
    const { data, error } = await db.from('reservations').select('id, reservation_type, provider_name, reservation_status, start_date, start_time, ' + 'end_date, end_time, location_name, availability_status, cancellation_policy_type, ' + 'cancellation_deadline, free_cancellation_until, current_price_amount, ' + 'current_price_currency, price_last_checked_at, last_synced_at, sync_source').eq('id', reservationId).eq('user_id', userId).maybeSingle();
    if (error) {
      console.error('[availability-monitor] reservations lookup failed:', error.message);
      return jsonResponse({
        error: 'reservation_lookup_failed',
        details: error.message
      }, 500);
    }
    if (data) return {
      table: 'reservations',
      row: data
    };
  }
  const { data, error } = await db.from('booking_reservations').select('id, provider, type, name, status, check_in, check_out, total_price, currency, last_updated').eq('id', reservationId).eq('user_id', userId).maybeSingle();
  if (error) {
    console.error('[availability-monitor] booking_reservations lookup failed:', error.message);
    return jsonResponse({
      error: 'reservation_lookup_failed',
      details: error.message
    }, 500);
  }
  if (data) return {
    table: 'booking_reservations',
    row: data
  };
  return null;
}
function notFound(reservationId) {
  return jsonResponse({
    data: null,
    status: 'unavailable',
    reason: 'reservation_not_found',
    safeFailureMessage: 'No reservation with that id belongs to you, so nothing can be reported about it.',
    reservation_id: reservationId
  }, 404);
}
// Action: check_availability
//
// Before today this returned a status derived from the digits of the id.
// It now reports the stored availability_status, or says it is not recorded.
async function handleCheckAvailability(userId, body) {
  const reservation_id = body.reservation_id;
  if (!reservation_id) return jsonResponse({
    error: 'reservation_id required'
  }, 400);
  const db = getServiceClient();
  const found = await findReservation(db, reservation_id, userId);
  if (found instanceof Response) return found;
  if (!found) return notFound(reservation_id);
  const checked_at = new Date().toISOString();
  if (found.table === 'reservations') {
    const stored = found.row.availability_status;
    if (stored != null && String(stored).trim() !== '') {
      return jsonResponse({
        data: {
          reservation_id,
          availability_status: stored,
          last_synced_at: found.row.last_synced_at ?? null,
          sync_source: found.row.sync_source ?? null
        },
        status: 'ok',
        source: 'stored: public.reservations.availability_status',
        // This value was written by whatever synced the reservation. It is not
        // a live check and this function makes no live check.
        live_check_performed: false,
        checked_at
      });
    }
  }
  return jsonResponse({
    data: null,
    status: 'unavailable',
    reason: found.table === 'reservations' ? 'availability_not_recorded' : 'availability_not_recorded_for_this_store',
    safeFailureMessage: found.table === 'reservations' ? 'No availability has been recorded for this reservation, and TravelOS cannot check it live: ' + 'no booking provider is connected. Confirm with the provider directly.' : 'This reservation is held in booking_reservations, which stores no availability information, ' + 'and TravelOS cannot check it live: no booking provider is connected. ' + 'Confirm with the provider directly.',
    provider_reason: NO_PROVIDER_REASON,
    reservation_id,
    source_table: found.table,
    live_check_performed: false,
    checked_at
  });
}
// Action: get_cancellation_policy
//
// Before today this returned a hard-coded 'Free cancellation' with a deadline
// of check_in minus 48 hours, or 'Non-refundable' when the reservation could
// not be found. Both were inventions. It now returns only stored policy fields.
async function handleGetCancellationPolicy(userId, body) {
  const reservation_id = body.reservation_id;
  if (!reservation_id) return jsonResponse({
    error: 'reservation_id required'
  }, 400);
  const db = getServiceClient();
  const found = await findReservation(db, reservation_id, userId);
  if (found instanceof Response) return found;
  if (!found) return notFound(reservation_id);
  const checked_at = new Date().toISOString();
  if (found.table === 'reservations') {
    const policyType = found.row.cancellation_policy_type;
    const deadline = found.row.cancellation_deadline;
    const freeUntil = found.row.free_cancellation_until;
    if (policyType != null || deadline != null || freeUntil != null) {
      return jsonResponse({
        data: {
          reservation_id,
          // Any of these may still be null; null means "not recorded", never
          // "none" and never "non-refundable".
          policy_type: policyType,
          policy_type_recorded: policyType != null,
          cancellation_deadline: deadline,
          cancellation_deadline_recorded: deadline != null,
          free_cancellation_until: freeUntil,
          free_cancellation_until_recorded: freeUntil != null,
          last_synced_at: found.row.last_synced_at ?? null,
          sync_source: found.row.sync_source ?? null
        },
        status: 'ok',
        source: 'stored: public.reservations.cancellation_policy_type / cancellation_deadline / free_cancellation_until',
        live_check_performed: false,
        checked_at
      });
    }
  }
  return jsonResponse({
    data: null,
    status: 'unavailable',
    reason: found.table === 'reservations' ? 'cancellation_policy_not_recorded' : 'cancellation_policy_not_recorded_for_this_store',
    safeFailureMessage: 'TravelOS has no cancellation terms recorded for this reservation and cannot check them live: ' + 'no booking provider is connected. Read the terms on your confirmation, or ask the provider. ' + 'Do not assume this booking is either refundable or non-refundable.',
    provider_reason: NO_PROVIDER_REASON,
    reservation_id,
    source_table: found.table,
    live_check_performed: false,
    checked_at
  });
}
// Action: monitor_all
//
// Before today this mapped every one of the caller's reservations through the
// id hash, producing a full page of invented statuses. It now lists each
// reservation with its stored status, or an explicit "not recorded".
async function handleMonitorAll(userId) {
  const db = getServiceClient();
  const checked_at = new Date().toISOString();
  const results = [];
  const { data: reservationRows, error: reservationsErr } = await db.from('reservations').select('id, availability_status, last_synced_at, sync_source').eq('user_id', userId);
  if (reservationsErr) {
    console.error('[availability-monitor] reservations sweep failed:', reservationsErr.message);
    return jsonResponse({
      error: 'reservation_lookup_failed',
      details: reservationsErr.message
    }, 500);
  }
  for (const r of reservationRows ?? []){
    const stored = r.availability_status;
    const recorded = stored != null && String(stored).trim() !== '';
    results.push({
      reservation_id: r.id,
      source_table: 'reservations',
      availability_status: recorded ? stored : null,
      availability_recorded: recorded,
      source: recorded ? 'stored: public.reservations.availability_status' : null,
      last_synced_at: r.last_synced_at ?? null,
      sync_source: r.sync_source ?? null
    });
  }
  const { data: bookingRows, error: bookingErr } = await db.from('booking_reservations').select('id, provider, status, last_updated').eq('user_id', userId);
  if (bookingErr) {
    console.error('[availability-monitor] booking_reservations sweep failed:', bookingErr.message);
    return jsonResponse({
      error: 'reservation_lookup_failed',
      details: bookingErr.message
    }, 500);
  }
  for (const r of bookingRows ?? []){
    results.push({
      reservation_id: r.id,
      source_table: 'booking_reservations',
      // booking_reservations has no availability column. `status` on that table
      // is the BOOKING's status (confirmed/cancelled), not room availability,
      // and is deliberately not passed off as one.
      availability_status: null,
      availability_recorded: false,
      booking_status: r.status ?? null,
      source: null,
      last_updated: r.last_updated ?? null
    });
  }
  const recordedCount = results.filter((r)=>r.availability_recorded === true).length;
  return jsonResponse({
    data: {
      results
    },
    status: recordedCount > 0 ? 'ok' : 'unavailable',
    reason: recordedCount > 0 ? null : NO_PROVIDER_REASON,
    safeFailureMessage: recordedCount > 0 ? null : NO_PROVIDER_MESSAGE,
    reservation_count: results.length,
    availability_recorded_count: recordedCount,
    live_check_performed: false,
    checked_at
  });
}
Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS
    });
  }
  if (req.method !== 'POST') {
    return jsonResponse({
      error: 'Method not allowed'
    }, 405);
  }
  let body = {};
  try {
    body = await req.json();
  } catch (_e) {
    return jsonResponse({
      error: 'Invalid JSON body'
    }, 400);
  }
  const action = body.action;
  if (!action) return jsonResponse({
    error: 'action required'
  }, 400);
  const user = await getAuthUser(req);
  if (!user) return jsonResponse({
    error: 'unauthorized'
  }, 401);
  try {
    if (action === 'check_availability') return await handleCheckAvailability(user.id, body);
    if (action === 'get_cancellation_policy') return await handleGetCancellationPolicy(user.id, body);
    if (action === 'monitor_all') return await handleMonitorAll(user.id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[availability-monitor] unhandled error:', msg);
    return jsonResponse({
      error: 'internal_error'
    }, 500);
  }
  return jsonResponse({
    error: 'Unknown action: ' + action
  }, 400);
});

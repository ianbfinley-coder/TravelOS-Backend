import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
// SECURITY 2026-09-16 — signature verification was optional in the worst way.
//
// The old gate was:
//
//     if (webhookSecret && signature) { ...verify... }
//
// Two ways past it, both trivial:
//   1. Omit the X-Webhook-Signature header entirely. `signature` is null, the
//      block is skipped, and the request is processed as genuine.
//   2. Never configure WEBHOOK_SECRET. Same outcome, silently, forever.
//
// With either, an anonymous caller could cancel any reservation by id, inject
// CRITICAL travel_alerts into any user's trip, fabricate price drops, and write
// arbitrary rows into reservation_price_history and availability_snapshots. The
// reservation_id is the only thing needed and it is not a secret.
//
// This endpoint MUST stay verify_jwt:false — external booking platforms send an
// HMAC signature, not a Supabase JWT — which is exactly why the in-code check
// has to fail CLOSED. It now does:
//
//   * No secret configured        -> 503, and the request is not processed.
//   * No signature header         -> 401.
//   * Signature mismatch          -> 401, compared in constant time.
//   * Per-platform secret support -> WEBHOOK_SECRET_<PLATFORM_ID>, so one
//                                    integrated platform cannot forge events
//                                    for another. Falls back to WEBHOOK_SECRET.
//
// KNOWN GAP: there is no replay protection. A captured valid request can be
// resent. Adding it needs a timestamp or nonce header, and enforcing one that
// senders may not send would reintroduce exactly the fail-open shape above. The
// handlers are close to idempotent (status writes and upsert-shaped updates),
// but `price_change` and `availability.low` INSERT history rows, so a replay
// duplicates those. Fix by agreeing a X-Webhook-Timestamp with each platform
// and rejecting anything outside a 5-minute window.
//
// DEFECT 2026-09-19 (42703 + 23514 — NO WEBHOOK ALERT HAS EVER BEEN CREATED).
//
// Every travel_alerts insert in this file was written against a table shape
// that does not exist. The inserts passed:
//
//     { trip_id, user_id, alert_type, severity, title, message, status }
//
// `travel_alerts` has no `severity` column and no `message` column. It has
// `priority` and `summary`. PostgREST rejects the whole statement when any
// inserted column is unknown (42703), so all five alert inserts — booking
// cancelled, price drop, flight delayed, flight cancelled, low availability —
// failed outright. The error was never captured (`await supabase.from(...)
// .insert({...})` with no destructuring), so the function went on to answer
// `{ received: true, processed: true, alert_created: true }` every time.
// Travellers were never told that a booking platform had cancelled their hotel
// or their flight, and the webhook reported success for every one.
//
// Two further problems were hiding behind the first, and would have kept the
// inserts failing even with the column names corrected:
//   - `summary` is NOT NULL with no default and was never supplied (23502);
//   - `alert_type` is CHECK-constrained to a fixed list, and NONE of the five
//     values used here ('BOOKING_CANCELLED', 'PRICE_DROP', 'FLIGHT_DELAY',
//     'FLIGHT_CANCELLED', 'AVAILABILITY_LOW') is in it (23514).
// Events are now mapped onto the permitted alert_type values, priority carries
// what `severity` was expressing, and every insert's error is checked so
// `alert_created` reports what actually happened.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-platform-id, x-webhook-signature',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS,
      'Content-Type': 'application/json'
    }
  });
}
/** Constant-time compare. `expected === signature` leaks position of first mismatch. */ function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for(let i = 0; i < len; i++)diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}
async function verifySignature(body, signature, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), {
    name: 'HMAC',
    hash: 'SHA-256'
  }, false, [
    'sign'
  ]);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  const expected = Array.from(new Uint8Array(sig)).map((b)=>b.toString(16).padStart(2, '0')).join('');
  // Several platforms prefix the hex digest with 'sha256='. Strip it, and
  // normalise case, before the constant-time compare.
  const provided = signature.replace(/^sha256=/i, '').trim().toLowerCase();
  return timingSafeEqual(expected, provided);
}
/**
 * Per-platform secret, falling back to the shared one.
 * X-Platform-ID: expedia  ->  WEBHOOK_SECRET_EXPEDIA
 * Non-alphanumerics are collapsed so the header cannot be used to probe
 * unrelated environment variables.
 */ function secretFor(platformId) {
  const slug = platformId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return Deno.env.get(`WEBHOOK_SECRET_${slug}`) ?? Deno.env.get('WEBHOOK_SECRET') ?? undefined;
}
async function insertAlert(supabase, alert) {
  const { error } = await supabase.from('travel_alerts').insert({
    trip_id: alert.trip_id,
    user_id: alert.user_id,
    alert_type: alert.alert_type,
    priority: alert.priority,
    urgency: alert.urgency,
    // The event comes from the booking platform itself, so the report is
    // first-hand rather than inferred.
    confidence: 'HIGH',
    alert_category: alert.alert_category,
    title: alert.title,
    summary: alert.summary,
    status: 'ACTIVE',
    context_data: alert.context_data ?? {}
  });
  if (error) {
    console.error('[booking-webhook] travel_alerts insert failed:', error.code, error.message);
    return {
      created: false,
      error: error.message
    };
  }
  return {
    created: true,
    error: null
  };
}
Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') return new Response(null, {
    headers: CORS
  });
  if (req.method !== 'POST') return json({
    error: 'Method not allowed'
  }, 405);
  const platformId = req.headers.get('X-Platform-ID') ?? 'unknown';
  const signature = req.headers.get('X-Webhook-Signature');
  const rawBody = await req.text();
  // ── SIGNATURE GATE — fails closed, runs before any database work ──────────
  const webhookSecret = secretFor(platformId);
  if (!webhookSecret) {
    // Refusing rather than processing. An unconfigured secret is a deployment
    // error, and treating it as "verification not required" is how this
    // endpoint was open in the first place.
    console.error(`booking-webhook: no signing secret configured for platform '${platformId}'`);
    return json({
      error: 'Webhook signing secret is not configured for this platform'
    }, 503);
  }
  if (!signature) {
    return json({
      error: 'Missing X-Webhook-Signature'
    }, 401);
  }
  if (!await verifySignature(rawBody, signature, webhookSecret)) {
    return json({
      error: 'Invalid signature'
    }, 401);
  }
  const supabase = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch  {
    return json({
      error: 'Invalid JSON'
    }, 400);
  }
  const { event_type, reservation_id, data } = body;
  if (!event_type || !reservation_id) {
    return json({
      error: 'event_type and reservation_id are required'
    }, 400);
  }
  // Fetch reservation to get user_id and trip_id.
  //
  // DEFECT 2026-09-19 (failure-looks-like-absence) — `if (resErr || !reservation)`
  // answered HTTP 200 with "Reservation not found" for BOTH cases. A 200 tells
  // the booking platform the event was accepted, so it never retries: a
  // transient database error meant the cancellation notice was dropped
  // permanently and silently. A genuine unknown reservation is still a 200 (the
  // platform should not retry that), but a failed lookup is now a 500 so the
  // platform redelivers.
  const { data: reservation, error: resErr } = await supabase.from('reservations').select('id, user_id, trip_id, provider_name, current_price_amount, current_price_currency, original_price_amount').eq('id', reservation_id).maybeSingle();
  if (resErr) {
    console.error('[booking-webhook] reservation lookup failed:', resErr.code, resErr.message);
    return json({
      received: true,
      processed: false,
      error: 'Reservation lookup failed'
    }, 500);
  }
  if (!reservation) {
    return json({
      received: true,
      processed: false,
      error: 'Reservation not found'
    });
  }
  const userId = reservation.user_id;
  const tripId = reservation.trip_id;
  const providerName = reservation.provider_name ?? null;
  const now = new Date().toISOString();
  // DEFECT 2026-09-19 — every reservations UPDATE below discarded its error and
  // the handler still answered processed: true. A failed status write meant the
  // reservation stayed CONFIRMED in the app after the platform had cancelled it.
  async function updateReservation(updates) {
    const { data: rows, error } = await supabase.from('reservations').update(updates).eq('id', reservation_id).select('id');
    if (error) {
      console.error('[booking-webhook] reservation update failed:', error.code, error.message);
      return error.message;
    }
    if (!rows || rows.length === 0) return 'reservation row was not updated';
    return null;
  }
  // ── Route by event_type ───────────────────────────────────────────────────────
  if (event_type === 'reservation.confirmed') {
    const failure = await updateReservation({
      reservation_status: 'CONFIRMED',
      last_synced_at: now,
      sync_source: 'webhook'
    });
    if (failure) return json({
      received: true,
      processed: false,
      event_type,
      error: failure
    }, 500);
    return json({
      received: true,
      processed: true,
      event_type
    });
  }
  if (event_type === 'reservation.modified') {
    const updates = {
      last_synced_at: now,
      sync_source: 'webhook'
    };
    if (data?.confirmation_number) updates.confirmation_number = data.confirmation_number;
    if (data?.start_date) updates.start_date = data.start_date;
    if (data?.end_date) updates.end_date = data.end_date;
    if (data?.notes) updates.notes = data.notes;
    const failure = await updateReservation(updates);
    if (failure) return json({
      received: true,
      processed: false,
      event_type,
      error: failure
    }, 500);
    return json({
      received: true,
      processed: true,
      event_type
    });
  }
  if (event_type === 'reservation.cancelled') {
    const failure = await updateReservation({
      reservation_status: 'CANCELLED',
      last_synced_at: now,
      sync_source: 'webhook'
    });
    if (failure) return json({
      received: true,
      processed: false,
      event_type,
      error: failure
    }, 500);
    const alert = await insertAlert(supabase, {
      trip_id: tripId,
      user_id: userId,
      alert_type: 'CANCELLATION',
      priority: 'CRITICAL',
      urgency: 'IMMEDIATE',
      alert_category: 'booking',
      title: `Reservation Cancelled: ${providerName ?? 'Booking'}`,
      summary: `Your reservation has been cancelled by ${platformId}. Please rebook immediately.`,
      context_data: {
        reservation_id,
        platform_id: platformId,
        source: 'webhook'
      }
    });
    return json({
      received: true,
      processed: true,
      event_type,
      alert_created: alert.created,
      alert_error: alert.error
    }, alert.created ? 200 : 500);
  }
  if (event_type === 'price_change') {
    // DEFECT 2026-09-19 (fabricated data) — `Number(data?.new_price ?? 0)`.
    // A webhook that omitted new_price produced a price of 0, which was written
    // to reservation_price_history and to reservations.current_price_amount,
    // computed as a -100% change, and raised a PRICE_DROP alert telling the
    // traveller their booking had fallen to $0.
    const rawNewPrice = data?.new_price;
    const newPrice = Number(rawNewPrice);
    if (rawNewPrice === undefined || rawNewPrice === null || !Number.isFinite(newPrice)) {
      return json({
        received: true,
        processed: false,
        event_type,
        error: 'price_change requires a numeric data.new_price'
      }, 400);
    }
    // DEFECT 2026-09-19 (fabricated data) — `(data?.currency as string) ?? 'USD'`
    // labelled every unlabelled price as US dollars. The column is NOT NULL, so
    // the reservation's own recorded currency is used when the webhook omits
    // one, and an event with no currency available anywhere is refused rather
    // than silently denominated in dollars.
    const currency = typeof data?.currency === 'string' && data.currency.trim() ? data.currency.trim() : reservation.current_price_currency ?? null;
    if (!currency) {
      return json({
        received: true,
        processed: false,
        event_type,
        error: 'price_change has no currency and the reservation has none recorded'
      }, 400);
    }
    const prevPriceRaw = reservation.current_price_amount ?? reservation.original_price_amount;
    const prevPrice = prevPriceRaw === null || prevPriceRaw === undefined ? null : Number(prevPriceRaw);
    const hasPrev = prevPrice !== null && Number.isFinite(prevPrice) && prevPrice > 0;
    // With no previous price there is no change to express. Previously this
    // fell back to `newPrice`, making delta 0 and deltaPct 0 — reported as a
    // measured "no change" rather than as an unknown.
    const delta = hasPrev ? Math.round((newPrice - prevPrice) * 100) / 100 : null;
    const deltaPct = hasPrev ? Math.round(delta / prevPrice * 10000) / 100 : null;
    const { error: historyError } = await supabase.from('reservation_price_history').insert({
      reservation_id,
      user_id: userId,
      platform_id: platformId,
      price_amount: newPrice,
      currency,
      source: 'webhook',
      price_delta: delta,
      price_delta_pct: deltaPct,
      raw_response: data
    });
    if (historyError) {
      console.error('[booking-webhook] reservation_price_history insert failed:', historyError.code, historyError.message);
      return json({
        received: true,
        processed: false,
        event_type,
        error: historyError.message
      }, 500);
    }
    const failure = await updateReservation({
      current_price_amount: newPrice,
      current_price_currency: currency,
      price_last_checked_at: now,
      last_synced_at: now,
      sync_source: 'webhook'
    });
    if (failure) return json({
      received: true,
      processed: false,
      event_type,
      error: failure
    }, 500);
    let alertCreated = false;
    let alertError = null;
    if (deltaPct !== null && deltaPct < -5) {
      const alert = await insertAlert(supabase, {
        trip_id: tripId,
        user_id: userId,
        alert_type: 'RESERVATION_CHANGE',
        priority: 'HIGH',
        urgency: 'SOON',
        alert_category: 'booking',
        title: `Price Drop: ${providerName ?? 'Reservation'}`,
        // Previously `$${newPrice}` — a dollar sign regardless of currency.
        summary: `Price dropped ${Math.abs(deltaPct).toFixed(1)}% to ${currency} ${newPrice} via ${platformId}.`,
        context_data: {
          reservation_id,
          platform_id: platformId,
          new_price: newPrice,
          currency,
          delta_pct: deltaPct
        }
      });
      alertCreated = alert.created;
      alertError = alert.error;
    }
    return json({
      received: true,
      processed: true,
      event_type,
      delta_pct: deltaPct,
      previous_price_known: hasPrev,
      alert_created: alertCreated,
      alert_error: alertError
    }, alertError ? 500 : 200);
  }
  if (event_type === 'flight.delayed') {
    // DEFECT 2026-09-19 (fabricated data) — `Number(data?.delay_minutes ?? 0)`
    // produced the alert text "Your flight is delayed by 0 minutes" whenever the
    // platform did not state a duration.
    const rawDelay = data?.delay_minutes;
    const delayMinutes = Number(rawDelay);
    const delayKnown = rawDelay !== undefined && rawDelay !== null && Number.isFinite(delayMinutes);
    // NOTE 2026-09-16: the previous version passed
    //   details: supabase.rpc ? undefined : undefined
    // which evaluates to undefined either way and updated nothing. Removed
    // rather than left in place looking like it does something.
    const failure = await updateReservation({
      last_synced_at: now,
      sync_source: 'webhook'
    });
    if (failure) return json({
      received: true,
      processed: false,
      event_type,
      error: failure
    }, 500);
    const newDeparture = typeof data?.new_departure_time === 'string' ? data.new_departure_time : null;
    const alert = await insertAlert(supabase, {
      trip_id: tripId,
      user_id: userId,
      alert_type: 'DELAY',
      priority: 'HIGH',
      urgency: 'TIME_SENSITIVE',
      alert_category: 'disruption',
      title: `Flight Delayed: ${providerName ?? 'Flight'}`,
      summary: delayKnown ? `Your flight is delayed by ${delayMinutes} minutes.${newDeparture ? ` New departure: ${newDeparture}.` : ' A new departure time has not been given.'}` : `Your flight is delayed. ${platformId} did not state by how long.${newDeparture ? ` New departure: ${newDeparture}.` : ' No new departure time has been given.'}`,
      context_data: {
        reservation_id,
        platform_id: platformId,
        delay_minutes: delayKnown ? delayMinutes : null,
        new_departure_time: newDeparture
      }
    });
    return json({
      received: true,
      processed: true,
      event_type,
      delay_minutes_known: delayKnown,
      alert_created: alert.created,
      alert_error: alert.error
    }, alert.created ? 200 : 500);
  }
  if (event_type === 'flight.cancelled') {
    const failure = await updateReservation({
      reservation_status: 'CANCELLED',
      last_synced_at: now,
      sync_source: 'webhook'
    });
    if (failure) return json({
      received: true,
      processed: false,
      event_type,
      error: failure
    }, 500);
    const alert = await insertAlert(supabase, {
      trip_id: tripId,
      user_id: userId,
      alert_type: 'CANCELLATION',
      priority: 'CRITICAL',
      urgency: 'IMMEDIATE',
      alert_category: 'disruption',
      title: `Flight Cancelled: ${providerName ?? 'Flight'}`,
      summary: `Your flight has been cancelled by ${platformId}. Please contact the airline or rebook.`,
      context_data: {
        reservation_id,
        platform_id: platformId,
        source: 'webhook'
      }
    });
    return json({
      received: true,
      processed: true,
      event_type,
      alert_created: alert.created,
      alert_error: alert.error
    }, alert.created ? 200 : 500);
  }
  if (event_type === 'availability.low') {
    // DEFECT 2026-09-19 (fabricated data) — `Number(data?.rooms_remaining ?? 1)`.
    // When the platform sent no count, the app asserted "Only 1 room(s)
    // remaining. Your booking may be at risk." That is an invented scarcity
    // claim, and it is the kind that makes people rebook in a hurry.
    const rawRooms = data?.rooms_remaining;
    const roomsRemaining = Number(rawRooms);
    const roomsKnown = rawRooms !== undefined && rawRooms !== null && Number.isFinite(roomsRemaining);
    const { error: snapshotError } = await supabase.from('availability_snapshots').insert({
      reservation_id,
      user_id: userId,
      platform_id: platformId,
      status: 'LIMITED',
      rooms_remaining: roomsKnown ? roomsRemaining : null,
      availability_pct: data?.availability_pct ?? null,
      notes: `Low availability alert from ${platformId}`,
      raw_response: data
    });
    if (snapshotError) {
      console.error('[booking-webhook] availability_snapshots insert failed:', snapshotError.code, snapshotError.message);
      return json({
        received: true,
        processed: false,
        event_type,
        error: snapshotError.message
      }, 500);
    }
    const failure = await updateReservation({
      availability_status: 'LIMITED',
      last_synced_at: now
    });
    if (failure) return json({
      received: true,
      processed: false,
      event_type,
      error: failure
    }, 500);
    const alert = await insertAlert(supabase, {
      trip_id: tripId,
      user_id: userId,
      alert_type: 'RESERVATION_CHANGE',
      priority: 'HIGH',
      urgency: 'SOON',
      alert_category: 'booking',
      title: `Low Availability: ${providerName ?? 'Reservation'}`,
      summary: roomsKnown ? `Only ${roomsRemaining} room(s) remaining. Your booking may be at risk.` : `${platformId} reports low availability for this booking but did not say how much is left. Your booking may be at risk.`,
      context_data: {
        reservation_id,
        platform_id: platformId,
        rooms_remaining: roomsKnown ? roomsRemaining : null
      }
    });
    return json({
      received: true,
      processed: true,
      event_type,
      rooms_remaining_known: roomsKnown,
      alert_created: alert.created,
      alert_error: alert.error
    }, alert.created ? 200 : 500);
  }
  // Unknown event type — acknowledge receipt but note unhandled
  return json({
    received: true,
    processed: false,
    event_type,
    note: 'Unrecognized event type'
  });
});

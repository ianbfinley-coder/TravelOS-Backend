// ITINERARY RECONCILIATION 2026-09-24 — no generated_itineraries read.
//   - current_version_id: the trip's active itinerary_versions id (new key).
//   - current_itinerary_version: that version's version_number (was GI.version).
//   - current_itinerary_id: kept as a key for old clients, always null.
//   - itinerary: the live itinerary from itinerary_items, grouped into days by
//     date in the trip's primary_tz, times as local HH:MM (new key; null on
//     the stale / not-found paths).
// Everything else is unchanged.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS'
};
const ACTIVE_STATUSES = [
  'ACTIVE'
];
const STALE_STATUSES = [
  'DISMISSED',
  'EXPIRED',
  'RESOLVED'
];
// COLUMN FIX 2026-09-19 — three of the four enrichment queries in this file
// named columns that do not exist, so PostgREST rejected each whole statement
// with 42703. Every one of those errors was only logged, and the null result
// was reported to the caller as "this data does not exist":
//   * generated_itineraries.version_number -> the real column is `version`.
//     `current_itinerary_id` and `current_itinerary_version` were therefore
//     ALWAYS null, for every alert, even with a live active itinerary.
//   * trip_health_analyses.overall_score / overall_status -> the real columns
//     are `health_score` and `health_status`. `trip_health` was ALWAYS null.
//   * reservations.type / title / status -> the real columns are
//     `reservation_type`, `location_name` and `reservation_status`.
//     `affected_reservations` was ALWAYS empty, so the copilot was never told
//     which bookings an alert actually touches.
// The outward response keys are unchanged; the real columns are mapped onto
// them below.
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
Deno.serve(async (req)=>{
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: corsHeaders
    });
  }
  if (req.method !== 'GET') {
    return new Response(JSON.stringify({
      error: 'Method not allowed'
    }), {
      status: 405,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    // Auth
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({
        error: 'Unauthorized'
      }), {
        status: 401,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    const jwt = authHeader.replace(/^Bearer\s+/i, '');
    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const { data: { user }, error: authError } = await supabase.auth.getUser(jwt);
    if (authError || !user) {
      return new Response(JSON.stringify({
        error: 'Unauthorized'
      }), {
        status: 401,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // Parse query params
    const url = new URL(req.url);
    const trip_id = url.searchParams.get('trip_id');
    const alert_id = url.searchParams.get('alert_id');
    if (!trip_id || !alert_id) {
      return new Response(JSON.stringify({
        error: 'trip_id and alert_id are required'
      }), {
        status: 400,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // Verify trip ownership
    // ERROR-HANDLING FIX 2026-09-19 — was `if (tripError || !trip) return 404`,
    // which reported a failed query as a trip that does not exist.
    const { data: trip, error: tripError } = await supabase.from('trips').select('id, user_id, primary_tz, start_date').eq('id', trip_id).maybeSingle();
    if (tripError) {
      console.error('[get-alert-copilot-context] trip lookup failed:', tripError.message);
      return new Response(JSON.stringify({
        error: 'Trip lookup failed',
        detail: tripError.message
      }), {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    if (!trip) {
      return new Response(JSON.stringify({
        error: 'Trip not found'
      }), {
        status: 404,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    if (trip.user_id !== user.id) {
      return new Response(JSON.stringify({
        error: 'Forbidden'
      }), {
        status: 403,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // 1. Fetch the alert
    // ERROR-HANDLING FIX 2026-09-19 — a failed alert query was reported to the
    // caller as "This alert is no longer active.", which is a claim about the
    // alert that the function had no evidence for.
    const { data: alert, error: alertError } = await supabase.from('travel_alerts').select('*').eq('id', alert_id).eq('trip_id', trip_id).maybeSingle();
    if (alertError) {
      console.error('[get-alert-copilot-context] alert lookup failed:', alertError.message);
      return new Response(JSON.stringify({
        error: 'Alert lookup failed',
        detail: alertError.message
      }), {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // Alert not found
    if (!alert) {
      return new Response(JSON.stringify({
        alert: null,
        stale: true,
        message: 'This alert is no longer active.',
        impact: null,
        current_itinerary_id: null,
        current_version_id: null,
        current_itinerary_version: null,
        itinerary: null,
        affected_reservations: [],
        trip_health: null,
        readiness_issues: []
      }), {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    const isStale = !ACTIVE_STATUSES.includes(alert.status) || STALE_STATUSES.includes(alert.status);
    if (isStale) {
      return new Response(JSON.stringify({
        alert,
        stale: true,
        message: 'This alert is no longer active.',
        impact: null,
        current_itinerary_id: null,
        current_version_id: null,
        current_itinerary_version: null,
        itinerary: null,
        affected_reservations: [],
        trip_health: null,
        readiness_issues: []
      }), {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // Mark alert as read (read_at = NOW(), unread = false) if not already read
    // Do this fire-and-forget style — don't block the response
    if (alert.read_at === null || alert.read_at === undefined) {
      supabase.from('travel_alerts').update({
        read_at: new Date().toISOString(),
        unread: false
      }).eq('id', alert_id).is('read_at', null) // Only update if still unread (avoid race conditions)
      .then(({ error: updateError })=>{
        if (updateError) {
          console.error('Failed to mark alert as read:', updateError);
        }
      });
    }
    // 2–7. Fetch all enrichment data in parallel
    const primaryImpactId = alert.primary_impact_id ?? null;
    const [impactResult, itineraryResult, itemsResult, healthResult, readinessResult] = await Promise.allSettled([
      // 2. Fetch linked impact
      primaryImpactId ? supabase.from('trip_impacts').select('*').eq('id', primaryImpactId).maybeSingle() : Promise.resolve({
        data: null,
        error: null
      }),
      // 4. Fetch the active itinerary version (ITINERARY RECONCILIATION
      //    2026-09-24 — replaces the generated_itineraries lookup).
      supabase.from('itinerary_versions').select('id, version_number, is_active').eq('trip_id', trip_id).eq('is_active', true).order('version_number', {
        ascending: false
      }).limit(1).maybeSingle(),
      // 4b. The live itinerary items.
      supabase.from('itinerary_items').select('id, title, type, category, status, date, start_time, end_time, location, fixed, must_do').eq('trip_id', trip_id).order('date', {
        ascending: true,
        nullsFirst: false
      }).order('start_time', {
        ascending: true,
        nullsFirst: false
      }),
      // 6. Fetch trip health summary
      // COLUMN FIX 2026-09-19 — `overall_score` / `overall_status` are not
      // columns on trip_health_analyses; they are `health_score` /
      // `health_status`.
      supabase.from('trip_health_analyses').select('health_score, health_status').eq('trip_id', trip_id).order('created_at', {
        ascending: false
      }).limit(1).maybeSingle(),
      // 7. Fetch relevant readiness issues
      supabase.from('readiness_items').select('id, title, priority, status').eq('trip_id', trip_id).neq('status', 'COMPLETE').in('priority', [
        'CRITICAL',
        'HIGH'
      ]).limit(5)
    ]);
    const impact = impactResult.status === 'fulfilled' ? impactResult.value.data ?? null : null;
    const itinerary = itineraryResult.status === 'fulfilled' ? itineraryResult.value.data ?? null : null;
    const itemRows = itemsResult.status === 'fulfilled' && !itemsResult.value.error ? itemsResult.value.data ?? [] : null;
    const health = healthResult.status === 'fulfilled' ? healthResult.value.data ?? null : null;
    const readinessItems = readinessResult.status === 'fulfilled' ? readinessResult.value.data ?? [] : [];
    if (impactResult.status === 'fulfilled' && impactResult.value.error) console.error('[get-alert-copilot-context] trip_impacts lookup failed:', impactResult.value.error.message);
    if (itineraryResult.status === 'fulfilled' && itineraryResult.value.error) console.error('[get-alert-copilot-context] itinerary_versions active lookup failed:', itineraryResult.value.error.message);
    if (itemsResult.status === 'fulfilled' && itemsResult.value.error) console.error('[get-alert-copilot-context] itinerary_items lookup failed:', itemsResult.value.error.message);
    if (healthResult.status === 'fulfilled' && healthResult.value.error) console.error('[get-alert-copilot-context] trip_health_analyses lookup failed:', healthResult.value.error.message);
    if (readinessResult.status === 'fulfilled' && readinessResult.value.error) console.error('[get-alert-copilot-context] readiness_items query failed:', readinessResult.value.error.message);
    // 5. Fetch affected reservations
    // Extract reservation IDs from affected_entities JSONB
    let affectedReservations = [];
    try {
      const affectedEntities = alert.affected_entities ?? [];
      const reservationIds = [];
      for (const entity of affectedEntities){
        if (entity.reservation_id && typeof entity.reservation_id === 'string') {
          reservationIds.push(entity.reservation_id);
        }
        // Also check entity_id if entity_type is reservation-like
        if (entity.entity_id && typeof entity.entity_id === 'string' && typeof entity.type === 'string' && [
          'FLIGHT',
          'HOTEL',
          'ACCOMMODATION',
          'RESERVATION',
          'TRANSPORT'
        ].includes(entity.type.toUpperCase())) {
          reservationIds.push(entity.entity_id);
        }
      }
      if (reservationIds.length > 0) {
        // COLUMN FIX 2026-09-19 — `type`, `title` and `status` are not columns
        // on reservations. The real columns are `reservation_type`,
        // `location_name` (with `provider_name` as the other human-readable
        // label) and `reservation_status`.
        const { data: resRows, error: resError } = await supabase.from('reservations').select('id, reservation_type, location_name, provider_name, reservation_status').in('id', reservationIds).eq('trip_id', trip_id);
        if (resError) console.error('[get-alert-copilot-context] reservations lookup for affected entities failed:', resError.message);
        if (resRows && resRows.length > 0) {
          affectedReservations = resRows.map((r)=>({
              id: r.id,
              type: r.reservation_type ?? 'reservation',
              title: r.location_name ?? r.provider_name ?? 'Untitled',
              status: r.reservation_status ?? 'UNKNOWN'
            }));
        }
      }
    } catch (resErr) {
      console.error('Failed to fetch affected reservations:', resErr);
    }
    // Build response
    const response = {
      alert,
      stale: false,
      impact: impact ?? null,
      current_itinerary_id: null,
      current_version_id: itinerary ? itinerary.id : null,
      current_itinerary_version: itinerary ? itinerary.version_number : null,
      // null = the items could not be read (logged above); [] = no items.
      itinerary: itemRows === null ? null : itemsToDays(itemRows, trip.primary_tz ?? null, trip.start_date ?? null).map((d)=>({
          day_number: d.day_number,
          date: d.date,
          items: d.items.map((it)=>({
              id: it.id,
              title: it.title ?? null,
              type: it.type ?? null,
              category: it.category ?? null,
              start: itemLocalTime(it, trip.primary_tz),
              end: itemLocalTime(it, trip.primary_tz, 'end_time'),
              location: it.location ?? null,
              fixed: it.fixed === true,
              must_do: it.must_do === true
            }))
        })),
      itinerary_timezone: trip.primary_tz ?? null,
      affected_reservations: affectedReservations,
      trip_health: health ? {
        overall_score: health.health_score,
        overall_status: health.health_status
      } : null,
      readiness_issues: readinessItems
    };
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  } catch (err) {
    console.error('get-alert-copilot-context error:', err);
    return new Response(JSON.stringify({
      error: 'Internal server error'
    }), {
      status: 500,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
});

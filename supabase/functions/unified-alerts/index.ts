// SECURITY 2026-09-16 — cross-tenant read and an identity fail-open fixed.
//
// What was wrong: get_unified_alerts and get_alert_counts read
// weather_forecasts, flight_disruptions, traffic_updates, safety_assessments,
// health_assessments, disaster_alerts and better_deals for a `trip_id` taken
// directly from the request body, through a service_role client that bypasses
// RLS, with no check that the caller owned that trip. Separately,
// dismiss_alert resolved the caller's identity with
// `supabase.auth.getUser(token)` and, when that lookup returned no user,
// inserted the dismissal record with `user_id: user?.id ?? null` instead of
// rejecting the request.
//
// What an attacker could do: this function runs with verify_jwt: false, so
// any caller who could reach it could pass an arbitrary trip_id and read
// another user's weather, flight, safety, health and disaster data, or
// dismiss another user's alert under a null/unattributed identity by sending
// a token that failed to resolve to a user.
//
// The gate now: every request is authenticated up front via
// requireUserOrService (a valid user JWT or the service-role key; anything
// else is rejected with 401 before any database work runs). For a caller of
// kind "user", every query against weather_forecasts, flight_disruptions,
// traffic_updates, safety_assessments, health_assessments, disaster_alerts
// and better_deals is additionally scoped with `.eq('user_id', caller.userId)`
// — each of those tables carries its own uuid user_id column, so this is a
// direct, row-level tenant check rather than a separate trip lookup.
// dismiss_alert no longer re-resolves identity from the token: it uses the
// already-verified `caller.userId` for a "user" caller and never falls back
// to null for that case.
//
// FOLLOW-UP FIX (same date) — dismiss_alert's DEAL branch was missed by the
// row-scoping pass above:
//   if (alert_type === 'DEAL') {
//     await supabase.from('better_deals').update({ dismissed: true }).eq('id', alert_id);
//   }
// This ran on the service_role client with only an `id` filter, so any
// authenticated caller could dismiss any other user's deal by guessing or
// enumerating alert_id. better_deals.user_id is uuid and matches auth.uid()
// directly. Fix: the update is now scoped with `.eq('user_id', caller.userId)`
// for a "user" caller (unscoped only for a genuine service caller). The other
// branch of this action (the `dismissed_alerts` insert) was already using
// caller.userId and needed no change.
// CORRECTNESS 2026-09-17 — better_deals was filtered by a column it doesn't
// have, so both alert-reading actions silently returned zero deals.
//
// get_unified_alerts and get_alert_counts both ran
// `.from('better_deals')....eq('trip_id', trip_id)`. Confirmed via
// information_schema.columns: better_deals has no trip_id column at all (its
// columns are id, user_id, reservation_id, platform, savings, savings_pct,
// total_price, currency, free_cancellation, url, dismissed, detected_at,
// expires_at). That `.eq` filtered on a column that doesn't exist, which
// PostgREST accepts and simply matches nothing — every deal for every trip
// was silently dropped from both endpoints.
//
// better_deals has no direct trip relationship, but it does have
// `reservation_id` (text), and `booking_reservations` (the table price-tracker
// looks the reservation up in before writing a deal) has both `id` (text —
// the same id space as better_deals.reservation_id, confirmed by
// price-tracker's own `detect_better_deals` handler, which inserts
// `reservation_id` straight from a `booking_reservations.id` lookup) and
// `trip_id` (uuid, the same trip id space as weather_forecasts.trip_id and
// the other tables this function already queries correctly). So a deal is
// scoped to a trip via: booking_reservations.trip_id = <trip_id> AND
// booking_reservations.id = better_deals.reservation_id.
//
// Fixed: both actions now first look up the caller's booking_reservations ids
// for the given trip_id, then filter better_deals with
// `.in('reservation_id', thoseIds)` instead of the nonexistent trip_id column.
// The existing `.eq('user_id', caller.userId)` scoping (today's security fix)
// is kept on both the reservation lookup and the deal query — not weakened.
// dismiss_alert's DEAL branch never referenced trip_id (it targets a single
// alert_id, already scoped by user_id) and needed no change here.
import { requireUserOrService, serviceClient } from './_shared/auth.ts';
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
/**
 * Scopes a query to the caller's own rows when the caller is an authenticated
 * user. A service caller (the service-role key) is left unscoped. Every table
 * this function reads carries a uuid `user_id` column, so this is a direct
 * row-level tenant check.
 */ function scopeToUser(query, caller) {
  return caller.kind === 'user' ? query.eq('user_id', caller.userId) : query;
}
/**
 * better_deals has no trip_id column. It is scoped to a trip only through
 * reservation_id -> booking_reservations.id, where booking_reservations.trip_id
 * is the real (uuid) trip id. Returns the reservation ids for this trip,
 * scoped to the caller the same way every other table in this function is.
 */ async function tripReservationIds(supabase, tripId, caller) {
  const { data } = await scopeToUser(supabase.from('booking_reservations').select('id').eq('trip_id', tripId), caller);
  return (data ?? []).map((r)=>r.id);
}
function severityBase(s) {
  switch(s){
    case 'critical':
      return 100;
    case 'high':
      return 75;
    case 'medium':
      return 50;
    case 'low':
      return 25;
    default:
      return 25;
  }
}
function recencyBonus(ts) {
  const ageMs = Date.now() - new Date(ts).getTime();
  const ageMin = ageMs / 60000;
  if (ageMin < 15) return 30;
  if (ageMin < 60) return 20;
  if (ageMin < 360) return 10;
  return 0;
}
function typeMultiplier(t) {
  switch(t){
    case 'NATURAL_DISASTER':
      return 1.5;
    case 'SAFETY':
      return 1.4;
    case 'HEALTH':
      return 1.3;
    case 'FLIGHT':
      return 1.2;
    case 'WEATHER':
      return 1.1;
    case 'TRAFFIC':
      return 1.0;
    case 'DEAL':
      return 0.5;
    default:
      return 1.0;
  }
}
function calcPriority(severity, timestamp, type) {
  return (severityBase(severity) + recencyBonus(timestamp)) * typeMultiplier(type);
}
function riskLevelToSeverity(level) {
  switch((level || '').toLowerCase()){
    case 'extreme':
      return 'critical';
    case 'high':
      return 'high';
    case 'moderate':
      return 'medium';
    default:
      return 'low';
  }
}
function weatherRiskToSeverity(maxRisk) {
  if (maxRisk >= 5) return 'critical';
  if (maxRisk >= 4) return 'high';
  if (maxRisk >= 2) return 'medium';
  return 'low';
}
function mapWeather(row) {
  const risks = Array.isArray(row.risks) ? row.risks : [];
  const maxRisk = risks.reduce((m, r)=>Math.max(m, Number(r.severity ?? 0)), 0);
  const severity = weatherRiskToSeverity(maxRisk);
  const actionItems = risks.flatMap((r)=>r.recommendations ?? []).filter(Boolean);
  const ts = String(row.fetched_at ?? row.created_at ?? new Date().toISOString());
  return {
    id: String(row.id),
    disruption_type: 'WEATHER',
    severity,
    title: `Weather: ${row.location ?? 'Unknown'}`,
    description: `${row.condition ?? ''}, ${row.temperature ?? ''}°C`,
    action_items: actionItems.length ? actionItems : [
      'Monitor conditions'
    ],
    timestamp: ts,
    source: 'weather_forecasts',
    dismissed: false,
    priority_score: calcPriority(severity, ts, 'WEATHER')
  };
}
function mapFlight(row) {
  const severity = row.severity ?? 'medium';
  const isCancellation = String(row.disruption_type ?? '').toLowerCase().includes('cancel');
  const actionItems = isCancellation ? [
    'Contact airline',
    'Check rebooking'
  ] : [
    'Monitor status'
  ];
  const delayInfo = row.delay_minutes ? ` — ${row.delay_minutes} min delay` : '';
  const ts = String(row.detected_at ?? row.created_at ?? new Date().toISOString());
  return {
    id: String(row.id),
    disruption_type: 'FLIGHT',
    severity,
    title: `Flight ${row.flight_number ?? ''}: ${row.disruption_type ?? ''}`,
    description: `${row.airline ?? ''}${delayInfo}`,
    action_items: actionItems,
    timestamp: ts,
    source: 'flight_disruptions',
    dismissed: false,
    priority_score: calcPriority(severity, ts, 'FLIGHT')
  };
}
function mapTraffic(row) {
  const severity = row.severity ?? 'low';
  const ts = String(row.created_at ?? new Date().toISOString());
  return {
    id: String(row.id),
    disruption_type: 'TRAFFIC',
    severity,
    title: `Traffic: ${row.from_location ?? row.origin ?? ''} → ${row.to_location ?? row.destination ?? ''}`,
    description: `${row.delay_minutes ?? 0} min delay (${row.congestion_level ?? 'unknown'})`,
    action_items: [
      row.recommendation
    ].filter(Boolean),
    timestamp: ts,
    source: 'traffic_updates',
    dismissed: false,
    priority_score: calcPriority(severity, ts, 'TRAFFIC')
  };
}
function mapSafety(row) {
  const severity = riskLevelToSeverity(String(row.risk_level ?? ''));
  const threats = Array.isArray(row.threats) ? row.threats : [];
  const recommendations = Array.isArray(row.recommendations) ? row.recommendations : [];
  const ts = String(row.assessed_at ?? row.created_at ?? new Date().toISOString());
  return {
    id: String(row.id),
    disruption_type: 'SAFETY',
    severity,
    title: `Safety: ${row.destination ?? 'Unknown'}`,
    description: threats.join(', ') || 'Safety advisory',
    action_items: recommendations.length ? recommendations : [
      'Review safety guidelines'
    ],
    timestamp: ts,
    source: 'safety_assessments',
    dismissed: false,
    priority_score: calcPriority(severity, ts, 'SAFETY')
  };
}
function mapHealth(row) {
  const severity = riskLevelToSeverity(String(row.overall_risk_level ?? row.risk_level ?? ''));
  const recommendations = Array.isArray(row.recommendations) ? row.recommendations : [];
  const ts = String(row.assessed_at ?? row.created_at ?? new Date().toISOString());
  return {
    id: String(row.id),
    disruption_type: 'HEALTH',
    severity,
    title: `Health: ${row.destination ?? 'Unknown'}`,
    description: `Medical: ${row.medical_facility_quality ?? 'Unknown'}`,
    action_items: recommendations.length ? recommendations : [
      'Consult travel health advisor'
    ],
    timestamp: ts,
    source: 'health_assessments',
    dismissed: false,
    priority_score: calcPriority(severity, ts, 'HEALTH')
  };
}
function mapDisaster(row) {
  const severity = riskLevelToSeverity(String(row.severity ?? row.risk_level ?? ''));
  const actionItems = [
    row.recommendation,
    row.evacuation_order ? 'EVACUATION ORDER' : null
  ].filter(Boolean);
  const ts = String(row.created_at ?? new Date().toISOString());
  return {
    id: String(row.id),
    disruption_type: 'NATURAL_DISASTER',
    severity,
    title: `${row.disaster_type ?? 'Disaster'}: ${row.location ?? 'Unknown'}`,
    description: String(row.description ?? ''),
    action_items: actionItems.length ? actionItems : [
      'Follow local authorities'
    ],
    timestamp: ts,
    source: 'disaster_alerts',
    dismissed: false,
    priority_score: calcPriority(severity, ts, 'NATURAL_DISASTER')
  };
}
function mapDeal(row) {
  const ts = String(row.created_at ?? new Date().toISOString());
  return {
    id: String(row.id),
    disruption_type: 'DEAL',
    severity: 'low',
    title: `Better Deal: ${row.alternative_provider ?? 'Unknown'}`,
    description: `Save ${row.savings_percent ?? 0}% (${row.currency ?? ''} ${row.savings ?? 0})`,
    action_items: [
      'View deal',
      'Compare options'
    ],
    timestamp: ts,
    source: 'better_deals',
    dismissed: Boolean(row.dismissed),
    priority_score: calcPriority('low', ts, 'DEAL')
  };
}
function buildCounts(alerts) {
  const by_type = {};
  let critical = 0, high = 0, medium = 0, low = 0;
  for (const a of alerts){
    by_type[a.disruption_type] = (by_type[a.disruption_type] ?? 0) + 1;
    if (a.severity === 'critical') critical++;
    else if (a.severity === 'high') high++;
    else if (a.severity === 'medium') medium++;
    else low++;
  }
  return {
    total: alerts.length,
    critical,
    high,
    medium,
    low,
    by_type
  };
}
Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: corsHeaders
    });
  }
  try {
    const caller = await requireUserOrService(req);
    if (caller instanceof Response) return caller;
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const supabase = serviceClient();
    let body;
    try {
      body = await req.json();
    } catch  {
      return new Response(JSON.stringify({
        error: 'invalid_json'
      }), {
        status: 400,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    const { action, ...params } = body;
    if (action === 'get_unified_alerts') {
      const { trip_id, filter_type, severity_filter } = params;
      const now = new Date().toISOString();
      // CORRECTNESS 2026-09-17: better_deals has no trip_id column — resolve
      // the caller's reservation ids for this trip first (see file-top note),
      // then filter better_deals by reservation_id instead of a trip_id that
      // doesn't exist on the table.
      const dealReservationIds = await tripReservationIds(supabase, trip_id, caller);
      const [weatherRes, flightRes, trafficRes, safetyRes, healthRes, disasterRes, dealRes] = await Promise.all([
        scopeToUser(supabase.from('weather_forecasts').select('*').eq('trip_id', trip_id).gt('fetched_at', new Date(Date.now() - 24 * 3600 * 1000).toISOString()), caller),
        scopeToUser(supabase.from('flight_disruptions').select('*').eq('trip_id', trip_id).gt('detected_at', new Date(Date.now() - 24 * 3600 * 1000).toISOString()), caller),
        scopeToUser(supabase.from('traffic_updates').select('*').eq('trip_id', trip_id).gt('created_at', new Date(Date.now() - 24 * 3600 * 1000).toISOString()), caller),
        scopeToUser(supabase.from('safety_assessments').select('*').eq('trip_id', trip_id).gt('assessed_at', new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()), caller),
        scopeToUser(supabase.from('health_assessments').select('*').eq('trip_id', trip_id).gt('assessed_at', new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()), caller),
        scopeToUser(supabase.from('disaster_alerts').select('*').eq('trip_id', trip_id).gt('created_at', new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()), caller),
        dealReservationIds.length > 0 ? scopeToUser(supabase.from('better_deals').select('*').in('reservation_id', dealReservationIds).gt('expires_at', now).eq('dismissed', false), caller) : Promise.resolve({
          data: []
        })
      ]);
      let alerts = [
        ...(weatherRes.data ?? []).map(mapWeather),
        ...(flightRes.data ?? []).map(mapFlight),
        ...(trafficRes.data ?? []).map(mapTraffic),
        ...(safetyRes.data ?? []).map(mapSafety),
        ...(healthRes.data ?? []).map(mapHealth),
        ...(disasterRes.data ?? []).map(mapDisaster),
        ...(dealRes.data ?? []).map(mapDeal)
      ];
      if (filter_type) {
        alerts = alerts.filter((a)=>a.disruption_type === filter_type);
      }
      if (severity_filter) {
        alerts = alerts.filter((a)=>a.severity === severity_filter);
      }
      alerts.sort((a, b)=>{
        if (b.priority_score !== a.priority_score) return b.priority_score - a.priority_score;
        return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
      });
      return new Response(JSON.stringify({
        alerts,
        counts: buildCounts(alerts),
        last_refreshed: now
      }), {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    if (action === 'dismiss_alert') {
      const { alert_id, alert_type, trip_id } = params;
      if (alert_type === 'DEAL') {
        // better_deals.user_id is uuid and matches auth.uid() directly.
        // Without this filter, any authenticated caller could dismiss any
        // other user's deal by id.
        await scopeToUser(supabase.from('better_deals').update({
          dismissed: true
        }).eq('id', alert_id), caller);
      } else {
        await supabase.from('dismissed_alerts').insert({
          user_id: caller.kind === 'user' ? caller.userId : null,
          trip_id: trip_id ?? null,
          alert_id,
          alert_type
        });
      }
      return new Response(JSON.stringify({
        success: true
      }), {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    if (action === 'get_alert_counts') {
      const { trip_id } = params;
      const now = new Date().toISOString();
      // CORRECTNESS 2026-09-17: same fix as get_unified_alerts above.
      const dealReservationIds = await tripReservationIds(supabase, trip_id, caller);
      const [weatherRes, flightRes, trafficRes, safetyRes, healthRes, disasterRes, dealRes] = await Promise.all([
        scopeToUser(supabase.from('weather_forecasts').select('id, risks').eq('trip_id', trip_id).gt('fetched_at', new Date(Date.now() - 24 * 3600 * 1000).toISOString()), caller),
        scopeToUser(supabase.from('flight_disruptions').select('id, severity').eq('trip_id', trip_id).gt('detected_at', new Date(Date.now() - 24 * 3600 * 1000).toISOString()), caller),
        scopeToUser(supabase.from('traffic_updates').select('id, severity').eq('trip_id', trip_id).gt('created_at', new Date(Date.now() - 24 * 3600 * 1000).toISOString()), caller),
        scopeToUser(supabase.from('safety_assessments').select('id, risk_level').eq('trip_id', trip_id).gt('assessed_at', new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()), caller),
        scopeToUser(supabase.from('health_assessments').select('id, overall_risk_level').eq('trip_id', trip_id).gt('assessed_at', new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()), caller),
        scopeToUser(supabase.from('disaster_alerts').select('id, severity').eq('trip_id', trip_id).gt('created_at', new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()), caller),
        dealReservationIds.length > 0 ? scopeToUser(supabase.from('better_deals').select('id').in('reservation_id', dealReservationIds).gt('expires_at', now).eq('dismissed', false), caller) : Promise.resolve({
          data: []
        })
      ]);
      const by_type = {
        WEATHER: (weatherRes.data ?? []).length,
        FLIGHT: (flightRes.data ?? []).length,
        TRAFFIC: (trafficRes.data ?? []).length,
        SAFETY: (safetyRes.data ?? []).length,
        HEALTH: (healthRes.data ?? []).length,
        NATURAL_DISASTER: (disasterRes.data ?? []).length,
        DEAL: (dealRes.data ?? []).length
      };
      const total = Object.values(by_type).reduce((s, v)=>s + v, 0);
      // Count critical/high from typed data
      let critical = 0, high = 0;
      for (const r of flightRes.data ?? []){
        if (r.severity === 'critical') critical++;
        else if (r.severity === 'high') high++;
      }
      for (const r of trafficRes.data ?? []){
        if (r.severity === 'critical') critical++;
        else if (r.severity === 'high') high++;
      }
      for (const r of safetyRes.data ?? []){
        const s = riskLevelToSeverity(r.risk_level);
        if (s === 'critical') critical++;
        else if (s === 'high') high++;
      }
      for (const r of healthRes.data ?? []){
        const s = riskLevelToSeverity(r.overall_risk_level);
        if (s === 'critical') critical++;
        else if (s === 'high') high++;
      }
      for (const r of disasterRes.data ?? []){
        const s = riskLevelToSeverity(r.severity);
        if (s === 'critical') critical++;
        else if (s === 'high') high++;
      }
      return new Response(JSON.stringify({
        total,
        critical,
        high,
        by_type
      }), {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    if (action === 'refresh_intelligence') {
      const { trip_id, token } = params;
      const authHeader = req.headers.get('Authorization') ?? `Bearer ${token}`;
      await Promise.all([
        fetch(`${supabaseUrl}/functions/v1/travel-intelligence`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: authHeader,
            apikey: serviceRoleKey
          },
          body: JSON.stringify({
            action: 'get_trip_intelligence',
            trip_id
          })
        }),
        fetch(`${supabaseUrl}/functions/v1/safety-health-intelligence`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: authHeader,
            apikey: serviceRoleKey
          },
          body: JSON.stringify({
            action: 'get_trip_safety_health',
            trip_id
          })
        })
      ]);
      return new Response(JSON.stringify({
        refreshed: true,
        timestamp: new Date().toISOString()
      }), {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    return new Response(JSON.stringify({
      error: `Unknown action: ${action}`
    }), {
      status: 400,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  } catch (err) {
    console.error('[unified-alerts] unhandled:', err instanceof Error ? err.message : String(err));
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

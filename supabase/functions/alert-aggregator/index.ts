import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
const SEVERITY_ORDER = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3
};
function mapRiskLevel(risk_level) {
  switch((risk_level || '').toLowerCase()){
    case 'extreme':
      return 'critical';
    case 'high':
      return 'high';
    case 'moderate':
      return 'medium';
    case 'low':
      return 'low';
    default:
      return 'low';
  }
}
function mapConflictSeverity(conflict_type) {
  switch((conflict_type || '').toLowerCase()){
    case 'date-overlap':
      return 'critical';
    case 'time-gap':
      return 'medium';
    case 'location-proximity':
      return 'low';
    default:
      return 'medium';
  }
}
function sortAlerts(alerts) {
  return alerts.sort((a, b)=>{
    const severityDiff = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (severityDiff !== 0) return severityDiff;
    return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
  });
}
function buildSummary(alerts) {
  const by_type = {};
  let critical_count = 0, high_count = 0, medium_count = 0, low_count = 0;
  for (const a of alerts){
    by_type[a.disruptionType] = (by_type[a.disruptionType] || 0) + 1;
    if (a.severity === 'critical') critical_count++;
    else if (a.severity === 'high') high_count++;
    else if (a.severity === 'medium') medium_count++;
    else low_count++;
  }
  return {
    total: alerts.length,
    critical_count,
    high_count,
    medium_count,
    low_count,
    by_type
  };
}
async function readSource(supabase, key, table, build, sources) {
  try {
    const { data, error } = await build(supabase.from(table).select('*'));
    if (error) {
      console.error(`[alert-aggregator] ${key} read of ${table} failed:`, error.message);
      sources[key] = {
        table,
        ok: false,
        rows: null,
        error: error.message
      };
      return [];
    }
    const rows = data ?? [];
    sources[key] = {
      table,
      ok: true,
      rows: rows.length
    };
    return rows;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[alert-aggregator] ${key} read of ${table} threw:`, message);
    sources[key] = {
      table,
      ok: false,
      rows: null,
      error: message
    };
    return [];
  }
}
async function getAggregatedAlerts(supabase, trip_id) {
  const alerts = [];
  const sources = {};
  // WEATHER
  {
    const rows = await readSource(supabase, 'WEATHER', 'weather_forecasts', (q)=>q.eq('trip_id', trip_id), sources);
    {
      for (const r of rows){
        alerts.push({
          id: r.id,
          disruptionType: 'WEATHER',
          severity: mapRiskLevel(r.risk_level),
          title: `Weather Alert: ${r.condition || 'Adverse conditions'} at ${r.location || 'destination'}`,
          description: `${r.condition || 'Weather conditions'} detected at ${r.location || 'your destination'}.`,
          actionItems: Array.isArray(r.risks) ? r.risks.map((risk)=>typeof risk === 'string' ? risk : JSON.stringify(risk)) : [],
          source: 'Weather Service',
          timestamp: r.created_at,
          dismissed: false,
          metadata: r
        });
      }
    }
  }
  // FLIGHT
  {
    const rows = await readSource(supabase, 'FLIGHT', 'flight_disruptions', (q)=>q.eq('trip_id', trip_id), sources);
    {
      for (const r of rows){
        alerts.push({
          id: r.id,
          disruptionType: 'FLIGHT',
          severity: r.severity || 'medium',
          title: `Flight Disruption: ${r.flight_number || 'Unknown flight'} — ${r.disruption_type || 'Disruption'}`,
          description: r.reason || `${r.airline || 'Airline'} flight ${r.flight_number || ''} is affected. ${r.delay_minutes ? `Delay: ${r.delay_minutes} min.` : ''}`,
          actionItems: r.reason ? [
            `Check with ${r.airline || 'airline'} for updates`
          ] : [],
          source: r.airline || 'Flight Service',
          timestamp: r.created_at,
          dismissed: false,
          metadata: r
        });
      }
    }
  }
  // TRAFFIC
  {
    const rows = await readSource(supabase, 'TRAFFIC', 'traffic_updates', (q)=>q.eq('trip_id', trip_id), sources);
    {
      for (const r of rows){
        alerts.push({
          id: r.id,
          disruptionType: 'TRAFFIC',
          severity: r.severity || 'low',
          title: `Traffic Update: ${r.from_location || 'Origin'} → ${r.to_location || 'Destination'}`,
          description: `${r.congestion_level || 'Traffic'} congestion detected. ${r.delay_minutes ? `Expected delay: ${r.delay_minutes} min.` : ''}`,
          actionItems: r.recommendation ? [
            r.recommendation
          ] : [],
          source: 'Traffic Service',
          timestamp: r.created_at,
          dismissed: false,
          metadata: r
        });
      }
    }
  }
  // SAFETY (skip low)
  {
    const rows = await readSource(supabase, 'SAFETY', 'safety_assessments', (q)=>q.eq('trip_id', trip_id), sources);
    {
      for (const r of rows){
        if ((r.risk_level || '').toLowerCase() === 'low') continue;
        alerts.push({
          id: r.id,
          disruptionType: 'SAFETY',
          severity: mapRiskLevel(r.risk_level),
          title: `Safety Alert: ${r.destination || 'Destination'}`,
          description: `Safety risk level is ${r.risk_level || 'elevated'} at ${r.destination || 'your destination'}.`,
          actionItems: Array.isArray(r.recommendations) ? r.recommendations.map((rec)=>typeof rec === 'string' ? rec : JSON.stringify(rec)) : [],
          source: 'Safety Intelligence',
          timestamp: r.created_at,
          dismissed: false,
          metadata: r
        });
      }
    }
  }
  // HEALTH (skip low)
  {
    const rows = await readSource(supabase, 'HEALTH', 'health_assessments', (q)=>q.eq('trip_id', trip_id), sources);
    {
      for (const r of rows){
        if ((r.overall_risk_level || '').toLowerCase() === 'low') continue;
        alerts.push({
          id: r.id,
          disruptionType: 'HEALTH',
          severity: mapRiskLevel(r.overall_risk_level),
          title: `Health Advisory: ${r.destination || 'Destination'}`,
          description: `Health risk level is ${r.overall_risk_level || 'elevated'} at ${r.destination || 'your destination'}. Medical facility quality: ${r.medical_facility_quality || 'unknown'}.`,
          actionItems: Array.isArray(r.recommendations) ? r.recommendations.map((rec)=>typeof rec === 'string' ? rec : JSON.stringify(rec)) : [],
          source: 'Health Intelligence',
          timestamp: r.created_at,
          dismissed: false,
          metadata: r
        });
      }
    }
  }
  // NATURAL DISASTER
  {
    const rows = await readSource(supabase, 'NATURAL_DISASTER', 'disaster_alerts', (q)=>q.eq('trip_id', trip_id), sources);
    {
      for (const r of rows){
        alerts.push({
          id: r.id,
          disruptionType: 'NATURAL_DISASTER',
          severity: r.severity || 'high',
          title: `${r.disaster_type || 'Disaster'} Alert: ${r.location || 'Affected area'}`,
          description: r.description || `${r.disaster_type || 'Natural disaster'} reported near ${r.location || 'your destination'}.`,
          actionItems: [
            ...r.evacuation_order ? [
              'Evacuation order in effect — follow local authorities'
            ] : [],
            ...r.recommendation ? [
              r.recommendation
            ] : []
          ],
          source: 'Disaster Monitoring',
          timestamp: r.created_at,
          dismissed: false,
          metadata: r
        });
      }
    }
  }
  // PRICE (better_deals, not dismissed, not expired)
  {
    const rows = await readSource(supabase, 'PRICE', 'better_deals', (q)=>q.eq('trip_id', trip_id).eq('dismissed', false).gt('expires_at', new Date().toISOString()), sources);
    {
      for (const r of rows){
        alerts.push({
          id: r.id,
          disruptionType: 'PRICE',
          severity: 'low',
          title: `Better Deal Available: Save ${r.savings_percent || 0}% with ${r.alternative_provider || 'alternative provider'}`,
          description: `You could save ${r.savings || 0} ${r.currency || 'USD'} by switching to ${r.alternative_provider || 'an alternative provider'}.`,
          actionItems: [
            'Review the alternative option',
            'Compare with current booking'
          ],
          source: 'Price Intelligence',
          timestamp: r.created_at,
          dismissed: r.dismissed || false,
          metadata: r
        });
      }
    }
  }
  // BOOKING (booking_conflicts, not resolved)
  {
    const rows = await readSource(supabase, 'BOOKING', 'booking_conflicts', (q)=>q.eq('trip_id', trip_id).eq('resolved', false), sources);
    {
      for (const r of rows){
        alerts.push({
          id: r.id,
          disruptionType: 'BOOKING',
          severity: mapConflictSeverity(r.conflict_type),
          title: `Booking Conflict: ${r.conflict_type || 'Conflict detected'}`,
          description: r.suggestion || `A ${r.conflict_type || 'booking'} conflict has been detected in your itinerary.`,
          actionItems: r.suggestion ? [
            r.suggestion
          ] : [
            'Review your bookings and resolve the conflict'
          ],
          source: 'Booking Monitor',
          timestamp: r.created_at,
          dismissed: r.resolved || false,
          metadata: r
        });
      }
    }
  }
  const unavailableSources = Object.entries(sources).filter(([, v])=>!v.ok).map(([k])=>k);
  if (unavailableSources.length > 0) {
    console.error('[alert-aggregator] trip', trip_id, '- alert list is PARTIAL; unreadable sources:', unavailableSources.join(', '));
  }
  return {
    alerts: sortAlerts(alerts),
    sources,
    complete: unavailableSources.length === 0,
    unavailableSources
  };
}
Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: corsHeaders
    });
  }
  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({
        error: 'Missing Authorization header'
      }), {
        status: 401,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    const token = authHeader.replace('Bearer ', '');
    const supabase = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_ANON_KEY'), {
      global: {
        headers: {
          Authorization: authHeader
        }
      }
    });
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
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
    const { action, trip_id, alert_id, user_id } = body;
    if (action === 'get_aggregated_alerts') {
      if (!trip_id) {
        return new Response(JSON.stringify({
          error: 'trip_id is required'
        }), {
          status: 400,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      // `sources`, `complete` and `unavailable_sources` are what let a caller
      // tell "no alerts" from "could not read the alert sources".
      const { alerts, sources, complete, unavailableSources } = await getAggregatedAlerts(supabase, trip_id);
      const summary = buildSummary(alerts);
      return new Response(JSON.stringify({
        alerts,
        summary,
        sources,
        complete,
        unavailable_sources: unavailableSources,
        last_updated: new Date().toISOString()
      }), {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    if (action === 'get_summary') {
      if (!trip_id) {
        return new Response(JSON.stringify({
          error: 'trip_id is required'
        }), {
          status: 400,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      // A summary of a partial read is a partial summary: say so rather than
      // let zero counts read as "all clear".
      const { alerts, sources, complete, unavailableSources } = await getAggregatedAlerts(supabase, trip_id);
      const summary = buildSummary(alerts);
      return new Response(JSON.stringify({
        summary,
        sources,
        complete,
        unavailable_sources: unavailableSources,
        last_updated: new Date().toISOString()
      }), {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    if (action === 'dismiss_alert') {
      const { disruptionType } = body;
      if (!alert_id || !disruptionType) {
        return new Response(JSON.stringify({
          error: 'alert_id and disruptionType are required'
        }), {
          status: 400,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      // ERROR-HANDLING FIX 2026-09-19 — the update sat in `try {} catch (_) {}`
      // with its error discarded, and the handler then returned
      // `{ success: true }` unconditionally. A write that was rejected (RLS,
      // constraint, wrong id) was reported to the caller as a successful
      // dismissal, and the alert came straight back on the next fetch with no
      // explanation. The update now reports what actually happened.
      if (disruptionType === 'PRICE' || disruptionType === 'BOOKING') {
        const table = disruptionType === 'PRICE' ? 'better_deals' : 'booking_conflicts';
        const patch = disruptionType === 'PRICE' ? {
          dismissed: true
        } : {
          resolved: true
        };
        const { data, error } = await supabase.from(table).update(patch).eq('id', alert_id).select('id');
        if (error) {
          console.error(`[alert-aggregator] dismiss_alert update of ${table} failed for`, alert_id, '-', error.message);
          return new Response(JSON.stringify({
            error: 'dismiss_failed',
            message: `Could not dismiss this alert: ${error.message}`
          }), {
            status: 500,
            headers: {
              ...corsHeaders,
              'Content-Type': 'application/json'
            }
          });
        }
        if (!data || data.length === 0) {
          // No row matched. Either the id does not exist, or this caller
          // cannot see it. Either way nothing was dismissed — do not claim it.
          return new Response(JSON.stringify({
            error: 'alert_not_found',
            message: `No ${disruptionType} alert with id ${alert_id} is visible to you, so nothing was dismissed.`
          }), {
            status: 404,
            headers: {
              ...corsHeaders,
              'Content-Type': 'application/json'
            }
          });
        }
        return new Response(JSON.stringify({
          success: true,
          dismissed: true,
          disruptionType,
          alert_id
        }), {
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      // WEATHER, FLIGHT, TRAFFIC, SAFETY, HEALTH, NATURAL_DISASTER are
      // informational and carry no dismiss state. The request succeeds, but
      // report plainly that nothing was persisted rather than implying it was.
      return new Response(JSON.stringify({
        success: true,
        dismissed: false,
        reason: 'informational_alert_has_no_dismiss_state',
        disruptionType,
        alert_id
      }), {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    if (action === 'refresh') {
      if (!trip_id) {
        return new Response(JSON.stringify({
          error: 'trip_id is required'
        }), {
          status: 400,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      const supabaseUrl = Deno.env.get('SUPABASE_URL');
      // ERROR-HANDLING FIX 2026-09-19 — both cross-function calls were awaited
      // but their responses were never inspected, and the whole call sat in
      // `try {} catch (_) {}`. travel-intelligence or safety-health-intelligence
      // could return 401/404/500, or the fetch could throw outright, and this
      // endpoint still answered `{ refreshed: true }`. The caller then polled
      // for alerts that were never regenerated. Each call's status is now
      // checked and reported, and `refreshed` is only true when both succeeded.
      const callFn = async (fnName, fnBody)=>{
        try {
          const res = await fetch(`${supabaseUrl}/functions/v1/${fnName}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: authHeader
            },
            body: JSON.stringify(fnBody)
          });
          if (!res.ok) {
            const detail = await res.text().catch(()=>'');
            console.error(`[alert-aggregator] refresh: ${fnName} returned HTTP ${res.status}`, detail.slice(0, 500));
            return {
              fn: fnName,
              ok: false,
              status: res.status,
              error: detail.slice(0, 500) || `HTTP ${res.status}`
            };
          }
          return {
            fn: fnName,
            ok: true,
            status: res.status
          };
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          console.error(`[alert-aggregator] refresh: ${fnName} call threw:`, message);
          return {
            fn: fnName,
            ok: false,
            status: null,
            error: message
          };
        }
      };
      const upstream = await Promise.all([
        callFn('travel-intelligence', {
          action: 'get_trip_intelligence',
          trip_id
        }),
        callFn('safety-health-intelligence', {
          action: 'get_trip_safety_health',
          trip_id
        })
      ]);
      const allRefreshed = upstream.every((u)=>u.ok);
      return new Response(JSON.stringify({
        refreshed: allRefreshed,
        upstream,
        failed_sources: upstream.filter((u)=>!u.ok).map((u)=>u.fn),
        timestamp: new Date().toISOString()
      }), {
        status: allRefreshed ? 200 : 502,
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
    console.error('[alert-aggregator] unhandled:', err instanceof Error ? err.message : String(err));
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

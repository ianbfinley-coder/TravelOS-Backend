// FAILURE-LOOKS-LIKE-A-FACT 2026-09-19 — this function is a diagnostic: its
// whole output is a set of CLAIMS about which links of the monitoring chain
// exist. Every one of those claims was derived from a query whose error was
// thrown away, so a broken or denied query produced the same answer as a
// genuinely absent row:
//
//   * `if (tripErr || !trip) return 404 'Trip not found'` (and the same shape
//     for alert_id and monitoring_event_id) reported a FAILED QUERY as a
//     record that does not exist. The caller cannot tell "no such trip" from
//     "the trips table could not be read".
//   * The `?trip_id` summary read travel_alerts as `const { data: alerts }` —
//     error discarded — and then published `total_alerts: alertList.length`.
//     A failed read therefore reported "0 alerts, 0 with impacts, 0
//     unresolved chains" for a trip that may have had many. That is an
//     invented number on a failure path, and it is the single most misleading
//     value this function can emit.
//   * The notification_eligibility read behind it was discarded the same way,
//     so `has_notification_eligibility` was reported false for every alert
//     whenever that query failed.
//   * Inside buildChain, all seven lookups were `const { data } = await ...`.
//     A failure made `monitoring_event` / `monitored_entity` / `reservation`
//     null and `impacts` empty, and `missing_links` then asserted those links
//     were MISSING — the exact opposite of the truth, which is that the
//     function did not find out.
//   * `const { data: trip } = ...` followed by `if (!trip || trip.user_id !==
//     user.id) return 403 Forbidden` turned a failed trips read into an
//     authorization denial against a user who may well own the trip.
//
// Every query below now separates the two outcomes. The single-row lookups
// are moved from `.single()` to `.maybeSingle()`, so an absent row is a plain
// null instead of a PGRST116 error indistinguishable from a real fault, and
// the error channel now carries only genuine faults. A fault is a 500 that
// names the query; only a null row is treated as "this link is not there".
//
// Second, related fix: the three single-row lookups in buildChain pushed
// their missing-link marker only when the foreign key was NULL. When the key
// was set but the row was gone, `.single()` raised PGRST116, the error was
// discarded, the value went null and NOTHING was pushed — so a dangling
// reference was reported as a complete chain. The marker is now pushed in
// that case too.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
/**
 * A query that failed is reported as a 500 that says which query failed. It is
 * never folded into 404, 403, an empty list or a zero count.
 */ function queryFailed(what, error) {
  console.error(`[get-monitoring-chain] ${what} failed:`, error.code, error.message);
  return new Response(JSON.stringify({
    error: `${what} failed`,
    detail: error.message
  }), {
    status: 500,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json'
    }
  });
}
Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS
    });
  }
  if (req.method !== 'GET') {
    return new Response(JSON.stringify({
      error: 'Method not allowed'
    }), {
      status: 405,
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'application/json'
      }
    });
  }
  const supabase = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));
  // Auth
  const authHeader = req.headers.get('Authorization') ?? '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '');
  if (!jwt) {
    return new Response(JSON.stringify({
      error: 'Missing authorization'
    }), {
      status: 401,
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'application/json'
      }
    });
  }
  const { data: { user }, error: authError } = await supabase.auth.getUser(jwt);
  if (authError || !user) {
    return new Response(JSON.stringify({
      error: 'Unauthorized'
    }), {
      status: 403,
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'application/json'
      }
    });
  }
  const url = new URL(req.url);
  const alert_id = url.searchParams.get('alert_id');
  const monitoring_event_id = url.searchParams.get('monitoring_event_id');
  const trip_id = url.searchParams.get('trip_id');
  // ── GET ?trip_id — summary of all chains ──────────────────────────────────
  if (trip_id) {
    // Verify trip ownership
    const { data: trip, error: tripErr } = await supabase.from('trips').select('id, user_id').eq('id', trip_id).maybeSingle();
    if (tripErr) return queryFailed('trips lookup', tripErr);
    if (!trip) {
      return new Response(JSON.stringify({
        error: 'Trip not found'
      }), {
        status: 404,
        headers: {
          ...CORS_HEADERS,
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
          ...CORS_HEADERS,
          'Content-Type': 'application/json'
        }
      });
    }
    const { data: alerts, error: alertsErr } = await supabase.from('travel_alerts').select('id, title, priority, status, monitoring_event_id, copilot_proposal_id, impact_ids').eq('trip_id', trip_id).eq('user_id', user.id);
    // Was discarded: a failed read published total_alerts: 0.
    if (alertsErr) return queryFailed('travel_alerts lookup', alertsErr);
    const alertList = alerts ?? [];
    // For each alert, check notification eligibility
    const alertIds = alertList.map((a)=>a.id);
    let eligibilityMap = {};
    if (alertIds.length > 0) {
      const { data: eligRows, error: eligErr } = await supabase.from('notification_eligibility').select('alert_id, eligible').in('alert_id', alertIds).eq('user_id', user.id);
      // Was discarded: a failed read reported every alert as having no
      // notification eligibility record.
      if (eligErr) return queryFailed('notification_eligibility lookup', eligErr);
      for (const row of eligRows ?? []){
        eligibilityMap[row.alert_id] = row.eligible;
      }
    }
    const chains = alertList.map((a)=>{
      const hasMonitoringEvent = !!a.monitoring_event_id;
      const hasImpacts = Array.isArray(a.impact_ids) && a.impact_ids.length > 0;
      const hasProposal = !!a.copilot_proposal_id;
      const hasNotificationEligibility = a.id in eligibilityMap;
      const chainComplete = hasMonitoringEvent && hasImpacts;
      return {
        alert_id: a.id,
        alert_title: a.title,
        priority: a.priority,
        has_monitoring_event: hasMonitoringEvent,
        has_impacts: hasImpacts,
        has_proposal: hasProposal,
        has_notification_eligibility: hasNotificationEligibility,
        chain_complete: chainComplete
      };
    });
    const summary = {
      total_alerts: alertList.length,
      alerts_with_impacts: chains.filter((c)=>c.has_impacts).length,
      alerts_with_proposals: chains.filter((c)=>c.has_proposal).length,
      alerts_with_notifications: chains.filter((c)=>c.has_notification_eligibility).length,
      unresolved_chains: alertList.filter((a)=>a.status === 'ACTIVE').length
    };
    return new Response(JSON.stringify({
      summary,
      chains
    }), {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'application/json'
      }
    });
  }
  // ── Shared chain traversal logic ──────────────────────────────────────────
  async function buildChain(alertRow) {
    const missingLinks = [];
    // 2. Fetch monitoring event
    let monitoringEvent = null;
    if (alertRow.monitoring_event_id) {
      const { data, error } = await supabase.from('monitoring_events').select('*').eq('id', alertRow.monitoring_event_id).maybeSingle();
      if (error) return queryFailed('monitoring_events lookup', error);
      monitoringEvent = data ?? null;
      // A set-but-dangling reference is a missing link too; this used to
      // report the chain as complete.
      if (!monitoringEvent) missingLinks.push('monitoring_event');
    } else {
      missingLinks.push('monitoring_event');
    }
    // 3. Fetch monitored entity
    let monitoredEntity = null;
    if (monitoringEvent?.monitored_entity_id) {
      const { data, error } = await supabase.from('monitored_entities').select('*').eq('id', monitoringEvent.monitored_entity_id).maybeSingle();
      if (error) return queryFailed('monitored_entities lookup', error);
      monitoredEntity = data ?? null;
      if (!monitoredEntity) missingLinks.push('monitored_entity');
    } else {
      missingLinks.push('monitored_entity');
    }
    // 4. Fetch reservation
    let reservation = null;
    const reservationId = monitoringEvent?.reservation_id ?? monitoredEntity?.reservation_id;
    if (reservationId) {
      const { data, error } = await supabase.from('reservations').select('id, reservation_type, provider_name, confirmation_number, start_date, start_time').eq('id', reservationId).maybeSingle();
      if (error) return queryFailed('reservations lookup', error);
      reservation = data ?? null;
      if (!reservation) missingLinks.push('reservation');
    } else {
      missingLinks.push('reservation');
    }
    // 5. Fetch trip impacts
    let impacts = [];
    if (alertRow.monitoring_event_id) {
      const { data, error } = await supabase.from('trip_impacts').select('*').eq('monitoring_event_id', alertRow.monitoring_event_id);
      // Was discarded: a failed read made missing_links assert 'impacts'.
      if (error) return queryFailed('trip_impacts lookup', error);
      impacts = data ?? [];
    }
    if (impacts.length === 0) missingLinks.push('impacts');
    // 6. Fetch recent snapshots (last 2)
    let recentSnapshots = [];
    if (monitoredEntity?.id) {
      const { data, error } = await supabase.from('monitoring_snapshots').select('*').eq('monitored_entity_id', monitoredEntity.id).order('captured_at', {
        ascending: false
      }).limit(2);
      if (error) return queryFailed('monitoring_snapshots lookup', error);
      recentSnapshots = data ?? [];
    }
    // 7. Fetch copilot proposal
    let copilotProposal = null;
    if (alertRow.copilot_proposal_id) {
      const { data, error } = await supabase.from('copilot_proposals').select('id, status, interpreted_goal, user_request').eq('id', alertRow.copilot_proposal_id).maybeSingle();
      if (error) return queryFailed('copilot_proposals lookup', error);
      copilotProposal = data ?? null;
    }
    // 8. Fetch notification eligibility
    let notificationEligibility = null;
    {
      const { data, error } = await supabase.from('notification_eligibility').select('eligible, suppressed, eligibility_reason').eq('alert_id', alertRow.id).eq('user_id', user.id).maybeSingle();
      // Was discarded: a failed read asserted 'notification_eligibility' was
      // a missing link.
      if (error) return queryFailed('notification_eligibility lookup', error);
      notificationEligibility = data ?? null;
    }
    if (!notificationEligibility) missingLinks.push('notification_eligibility');
    const chainComplete = missingLinks.length === 0;
    return new Response(JSON.stringify({
      chain: {
        alert: alertRow,
        monitoring_event: monitoringEvent,
        monitored_entity: monitoredEntity,
        reservation,
        impacts,
        recent_snapshots: recentSnapshots,
        copilot_proposal: copilotProposal,
        notification_eligibility: notificationEligibility
      },
      chain_complete: chainComplete,
      missing_links: missingLinks
    }), {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'application/json'
      }
    });
  }
  // ── GET ?alert_id ─────────────────────────────────────────────────────────
  if (alert_id) {
    const { data: alert, error: alertErr } = await supabase.from('travel_alerts').select('*').eq('id', alert_id).maybeSingle();
    if (alertErr) return queryFailed('travel_alerts lookup', alertErr);
    if (!alert) {
      return new Response(JSON.stringify({
        error: 'Alert not found'
      }), {
        status: 404,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'application/json'
        }
      });
    }
    if (alert.user_id !== user.id) {
      return new Response(JSON.stringify({
        error: 'Forbidden'
      }), {
        status: 403,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'application/json'
        }
      });
    }
    return buildChain(alert);
  }
  // ── GET ?monitoring_event_id ──────────────────────────────────────────────
  if (monitoring_event_id) {
    // Verify event belongs to user via trip ownership
    const { data: event, error: eventErr } = await supabase.from('monitoring_events').select('*').eq('id', monitoring_event_id).maybeSingle();
    if (eventErr) return queryFailed('monitoring_events lookup', eventErr);
    if (!event) {
      return new Response(JSON.stringify({
        error: 'Monitoring event not found'
      }), {
        status: 404,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'application/json'
        }
      });
    }
    // Verify trip ownership
    const { data: trip, error: tripErr } = await supabase.from('trips').select('id, user_id').eq('id', event.trip_id).maybeSingle();
    // Was discarded: a failed trips read became 403 Forbidden against a user
    // who may own the trip.
    if (tripErr) return queryFailed('trips lookup', tripErr);
    if (!trip || trip.user_id !== user.id) {
      return new Response(JSON.stringify({
        error: 'Forbidden'
      }), {
        status: 403,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'application/json'
        }
      });
    }
    // Find the alert for this event
    const { data: alert, error: alertErr } = await supabase.from('travel_alerts').select('*').eq('monitoring_event_id', monitoring_event_id).eq('user_id', user.id).maybeSingle();
    // Was discarded: a failed read produced the "no alert yet" partial chain,
    // which asserts five links are missing.
    if (alertErr) return queryFailed('travel_alerts lookup', alertErr);
    if (!alert) {
      // No alert yet — build partial chain from event
      return new Response(JSON.stringify({
        chain: {
          alert: null,
          monitoring_event: event,
          monitored_entity: null,
          reservation: null,
          impacts: [],
          recent_snapshots: [],
          copilot_proposal: null,
          notification_eligibility: null
        },
        chain_complete: false,
        missing_links: [
          'alert',
          'monitored_entity',
          'reservation',
          'impacts',
          'notification_eligibility'
        ]
      }), {
        status: 200,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'application/json'
        }
      });
    }
    return buildChain(alert);
  }
  return new Response(JSON.stringify({
    error: 'alert_id, monitoring_event_id, or trip_id is required'
  }), {
    status: 400,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json'
    }
  });
});

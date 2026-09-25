// SECURITY 2026-09-17 —
// Two separate problems, both in the single-event POST path
// ({ monitoring_event_id, trip_id }), which is the one path a signed-in user
// can reach directly (the frontend polls run-alert-pipeline for status and
// can retry generation for one event).
//
// 1. Hand-rolled auth duplicated the pre-audit pattern instead of using the
//    shared module: it decoded the caller's JWT itself and separately
//    string-compared the bearer to the service-role key (not constant-time)
//    to detect internal pipeline callers. Functionally close to correct, but
//    undocumented and inconsistent with every other function.
//
// 2. The real defect: trip ownership was verified for the `trip_id` in the
//    body, but `monitoring_event_id` was never checked to actually belong to
//    that trip before trip_impacts rows matching it were read AND MUTATED.
//    A signed-in user who owns Trip A could call this function with their
//    own trip_id=A (passes the ownership check) and a monitoring_event_id
//    belonging to a trip they do not own (Trip B). processOneEvent then
//    fetched and wrote to Trip B's trip_impacts rows (alert_generation_status,
//    generated_alert_id, failure fields) and could log a pipeline_recovery_log
//    entry against Trip B — all attributed to the attacker's own user id.
//    generate-alert's own compound filter (id + trip_id together) would have
//    rejected the mismatched combination before creating an alert, so this
//    could not plant an alert on a stranger's trip, but it let an
//    authenticated user corrupt another user's pipeline state, which is the
//    same missing-ownership-check class of bug.
//
// Fix: replaced the hand-rolled gate with requireUserOrService (service
// callers, e.g. run-impact-pipeline, pass through untouched). For a user
// caller, trip ownership is checked with requireTripOwner using
// caller.userId — never a body field — before any read, and
// processOneEvent now also verifies the monitoring event's own trip_id
// matches the trip_id it was called with before touching trip_impacts.
// Ownership and binding failures return 404, not 403.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { requireUserOrService, requireTripOwner, serviceClient } from './_shared/auth.ts';
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json'
    }
  });
}
function err(msg, status = 400) {
  return json({
    error: msg
  }, status);
}
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
// ── Safe failure logger — never throws ───────────────────────────────────────────────
async function logRecovery(params) {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/pipeline-recovery`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`
      },
      body: JSON.stringify({
        action: 'log_failure',
        ...params
      })
    });
    if (res.ok) {
      const data = await res.json();
      return data.recovery_log_id ?? null;
    }
    return null;
  } catch  {
    return null;
  }
}
async function processOneEvent(serviceClientInst, monitoringEventId, tripId, pipelineRunId, userId) {
  // 1. Fetch the monitoring event
  const { data: monEvent, error: evErr } = await serviceClientInst.from('monitoring_events').select('*').eq('id', monitoringEventId).single();
  if (evErr || !monEvent) throw new Error('Monitoring event not found');
  // Bind the event to the trip it was called with. Without this check a
  // caller who owns `tripId` but not the trip the event actually belongs to
  // could still read and mutate that other trip's trip_impacts below.
  if (monEvent.trip_id !== tripId) throw new Error('Monitoring event not found');
  // Verify ownership via trip
  const { data: trip, error: tripErr } = await serviceClientInst.from('trips').select('id, user_id').eq('id', tripId).single();
  if (tripErr || !trip) throw new Error('Trip not found');
  if (trip.user_id !== userId) throw new Error('Access denied');
  // 2. Fetch all ACTIVE TripImpacts for this monitoring_event_id
  const { data: impacts, error: impactsErr } = await serviceClientInst.from('trip_impacts').select('*').eq('monitoring_event_id', monitoringEventId).eq('status', 'ACTIVE');
  if (impactsErr) throw new Error('Failed to fetch impacts');
  const activeImpacts = impacts ?? [];
  // 3. If no impacts or all impacts have impact_level='NONE': mark all as NOT_APPLICABLE
  const meaningfulImpacts = activeImpacts.filter((i)=>i.impact_level !== 'NONE');
  if (activeImpacts.length === 0 || meaningfulImpacts.length === 0) {
    if (activeImpacts.length > 0) {
      await serviceClientInst.from('trip_impacts').update({
        alert_generation_status: 'NOT_APPLICABLE',
        alert_generation_completed_at: new Date().toISOString()
      }).eq('monitoring_event_id', monitoringEventId).eq('status', 'ACTIVE');
    }
    return {
      monitoring_event_id: monitoringEventId,
      pipeline_run_id: pipelineRunId,
      result: 'NOT_APPLICABLE',
      alert_id: null,
      was_duplicate: false,
      impacts_processed: activeImpacts.length
    };
  }
  // 4. Check if an alert already exists for this monitoring_event_id (status=ACTIVE)
  const { data: existingAlert } = await serviceClientInst.from('travel_alerts').select('id, status').eq('monitoring_event_id', monitoringEventId).eq('status', 'ACTIVE').maybeSingle();
  // 5. Mark the primary impact as PROCESSING
  // Primary = highest impact level
  const IMPACT_LEVEL_ORDER = {
    CRITICAL: 0,
    HIGH: 1,
    MODERATE: 2,
    LOW: 3,
    POSSIBLE: 4,
    NONE: 5,
    UNKNOWN: 6
  };
  const primaryImpact = meaningfulImpacts.reduce((best, cur)=>(IMPACT_LEVEL_ORDER[cur.impact_level] ?? 6) < (IMPACT_LEVEL_ORDER[best.impact_level] ?? 6) ? cur : best);
  await serviceClientInst.from('trip_impacts').update({
    alert_generation_status: 'PROCESSING',
    alert_generation_started_at: new Date().toISOString()
  }).eq('id', primaryImpact.id);
  // 6. Call the existing generate-alert function
  let alertData = {};
  let alertRes;
  let alertOk = false;
  try {
    alertRes = await fetch(`${SUPABASE_URL}/functions/v1/generate-alert`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`
      },
      body: JSON.stringify({
        monitoring_event_id: monitoringEventId,
        trip_id: tripId
      })
    });
    alertData = await alertRes.json();
    alertOk = alertRes.ok;
  } catch (fetchErr) {
    alertData = {
      error: fetchErr instanceof Error ? fetchErr.message : 'Network error calling generate-alert'
    };
    alertOk = false;
  }
  // 7. Handle the result
  if (!alertOk || alertData.error) {
    const errorMsg = alertData.error ?? 'Alert generation could not be completed';
    // Mark primary impact as FAILED — do NOT create a partial alert
    await serviceClientInst.from('trip_impacts').update({
      alert_generation_status: 'FAILED',
      alert_generation_completed_at: new Date().toISOString(),
      alert_generation_error: errorMsg,
      failure_type: 'PROCESSING_FAILED',
      failure_message: 'Alert generation could not be completed'
    }).eq('id', primaryImpact.id);
    // Log to pipeline_recovery_log
    const recoveryLogId = await logRecovery({
      user_id: userId,
      trip_id: tripId,
      operation: 'ALERT_GENERATION',
      related_object_type: 'trip_impact',
      related_object_id: primaryImpact.id,
      failure_type: 'PROCESSING_FAILED',
      failure_message: 'Alert generation could not be completed',
      failure_detail: {
        error: errorMsg,
        monitoring_event_id: monitoringEventId,
        pipeline_run_id: pipelineRunId
      }
    });
    if (recoveryLogId) {
      await serviceClientInst.from('trip_impacts').update({
        recovery_log_id: recoveryLogId
      }).eq('id', primaryImpact.id);
    }
    return {
      monitoring_event_id: monitoringEventId,
      pipeline_run_id: pipelineRunId,
      result: 'FAILED',
      alert_id: null,
      was_duplicate: false,
      impacts_processed: activeImpacts.length,
      recovery_log_id: recoveryLogId
    };
  }
  const alertRecord = alertData.alert;
  const wasDuplicate = alertData.was_duplicate ?? false;
  const alertId = alertRecord?.id;
  // 7b. Check for scoring failure — alert without valid priority/impact_score
  if (alertId && alertRecord) {
    const priority = alertRecord.priority;
    const impactScore = alertRecord.impact_score;
    const validPriorities = [
      'INFO',
      'LOW',
      'HIGH',
      'CRITICAL'
    ];
    if (!priority || !validPriorities.includes(priority) || impactScore === undefined || impactScore === null) {
      // Scoring failed — keep alert as DRAFT, do NOT activate
      console.warn('[run-alert-pipeline] Alert scoring incomplete, keeping as DRAFT:', alertId);
      await serviceClientInst.from('travel_alerts').update({
        status: 'UNKNOWN',
        failure_type: 'VALIDATION_FAILED',
        failure_message: 'Alert scoring could not be completed'
      }).eq('id', alertId);
      await serviceClientInst.from('trip_impacts').update({
        alert_generation_status: 'FAILED',
        alert_generation_completed_at: new Date().toISOString(),
        alert_generation_error: 'Alert scoring incomplete',
        failure_type: 'VALIDATION_FAILED',
        failure_message: 'Alert scoring could not be completed'
      }).eq('id', primaryImpact.id);
      const recoveryLogId = await logRecovery({
        user_id: userId,
        trip_id: tripId,
        operation: 'ALERT_SCORING',
        related_object_type: 'trip_impact',
        related_object_id: primaryImpact.id,
        failure_type: 'VALIDATION_FAILED',
        failure_message: 'Alert scoring could not be completed',
        failure_detail: {
          alert_id: alertId,
          priority,
          impact_score: impactScore
        }
      });
      return {
        monitoring_event_id: monitoringEventId,
        pipeline_run_id: pipelineRunId,
        result: 'FAILED',
        alert_id: alertId,
        was_duplicate: false,
        impacts_processed: activeImpacts.length,
        recovery_log_id: recoveryLogId
      };
    }
  }
  if (alertId) {
    const impactIds = activeImpacts.map((i)=>i.id).filter(Boolean);
    // Mark ALL impacts for this event as COMPLETE
    await serviceClientInst.from('trip_impacts').update({
      alert_generation_status: 'COMPLETE',
      alert_generation_completed_at: new Date().toISOString(),
      generated_alert_id: alertId
    }).eq('monitoring_event_id', monitoringEventId).eq('status', 'ACTIVE');
    // Update travel_alerts.impact_ids to include all impact IDs for this event
    if (impactIds.length > 0) {
      await serviceClientInst.from('travel_alerts').update({
        impact_ids: impactIds
      }).eq('id', alertId);
    }
    const result = wasDuplicate ? 'ALERT_UPDATED' : existingAlert ? 'ALERT_UPDATED' : 'ALERT_CREATED';
    return {
      monitoring_event_id: monitoringEventId,
      pipeline_run_id: pipelineRunId,
      result,
      alert_id: alertId,
      was_duplicate: wasDuplicate,
      impacts_processed: activeImpacts.length
    };
  }
  // generate-alert returned ok but no alert (e.g. was_duplicate with no alert object)
  if (wasDuplicate) {
    await serviceClientInst.from('trip_impacts').update({
      alert_generation_status: 'COMPLETE',
      alert_generation_completed_at: new Date().toISOString()
    }).eq('monitoring_event_id', monitoringEventId).eq('status', 'ACTIVE');
    return {
      monitoring_event_id: monitoringEventId,
      pipeline_run_id: pipelineRunId,
      result: 'ALERT_UPDATED',
      alert_id: existingAlert?.id ?? null,
      was_duplicate: true,
      impacts_processed: activeImpacts.length
    };
  }
  // Unexpected: ok response but no alert and not duplicate
  const unexpectedErrorMsg = 'Alert generation returned an unexpected response';
  await serviceClientInst.from('trip_impacts').update({
    alert_generation_status: 'FAILED',
    alert_generation_completed_at: new Date().toISOString(),
    alert_generation_error: unexpectedErrorMsg,
    failure_type: 'PROCESSING_FAILED',
    failure_message: 'Alert generation could not be completed'
  }).eq('id', primaryImpact.id);
  const recoveryLogId = await logRecovery({
    user_id: userId,
    trip_id: tripId,
    operation: 'ALERT_GENERATION',
    related_object_type: 'trip_impact',
    related_object_id: primaryImpact.id,
    failure_type: 'PROCESSING_FAILED',
    failure_message: 'Alert generation could not be completed',
    failure_detail: {
      error: unexpectedErrorMsg,
      monitoring_event_id: monitoringEventId
    }
  });
  return {
    monitoring_event_id: monitoringEventId,
    pipeline_run_id: pipelineRunId,
    result: 'FAILED',
    alert_id: null,
    was_duplicate: false,
    impacts_processed: activeImpacts.length,
    recovery_log_id: recoveryLogId
  };
}
Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: corsHeaders
    });
  }
  const caller = await requireUserOrService(req);
  if (caller instanceof Response) return caller;
  const service = serviceClient();
  const url = new URL(req.url);
  // ── GET: alert generation status for an event (user-only) ─────────────
  if (req.method === 'GET') {
    if (caller.kind !== 'user') return err('Unauthorized', 401);
    const userId = caller.userId;
    const monitoringEventId = url.searchParams.get('monitoring_event_id');
    if (!monitoringEventId) return err('monitoring_event_id required');
    const { data: monEvent, error: evErr } = await service.from('monitoring_events').select('*').eq('id', monitoringEventId).single();
    if (evErr || !monEvent) return err('Monitoring event not found', 404);
    // Verify ownership via trip
    const ownerCheck = await requireTripOwner(service, monEvent.trip_id, userId);
    if (ownerCheck instanceof Response) return ownerCheck;
    // Fetch impacts with alert generation fields
    const { data: impacts } = await service.from('trip_impacts').select('id, impact_type, impact_level, status, alert_generation_status, alert_generation_started_at, alert_generation_completed_at, alert_generation_error, generated_alert_id, failure_type, failure_message, recovery_log_id').eq('monitoring_event_id', monitoringEventId).eq('status', 'ACTIVE');
    return json({
      monitoring_event_id: monitoringEventId,
      impacts: impacts ?? [],
      impacts_count: (impacts ?? []).length
    });
  }
  // ── POST ─────────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    let body;
    try {
      body = await req.json();
    } catch  {
      return err('Invalid JSON body');
    }
    // POST { action: "process_pending" } — batch process PENDING alert generations (user-only)
    if (body.action === 'process_pending') {
      if (caller.kind !== 'user') return err('Unauthorized', 401);
      const userId = caller.userId;
      // Fetch up to 20 trip_impacts with PENDING alert generation
      const { data: pendingImpacts, error: fetchErr } = await service.from('trip_impacts').select('id, monitoring_event_id, trip_id, user_id, pipeline_run_id').eq('alert_generation_status', 'PENDING').neq('impact_level', 'NONE').eq('status', 'ACTIVE').limit(20);
      if (fetchErr) return err('Failed to fetch pending impacts');
      const impacts = pendingImpacts ?? [];
      // Group by monitoring_event_id — process one alert per event
      const eventGroups = new Map();
      for (const impact of impacts){
        if (impact.monitoring_event_id && !eventGroups.has(impact.monitoring_event_id)) {
          eventGroups.set(impact.monitoring_event_id, impact);
        }
      }
      let processed = 0;
      let alertsCreated = 0;
      let failed = 0;
      let notApplicable = 0;
      for (const [eventId, impact] of eventGroups){
        if (!impact.trip_id) {
          notApplicable++;
          continue;
        }
        // Verify ownership — trip_id here comes from the trip_impacts row
        // itself (already correctly associated with its event), not from
        // caller input.
        const { data: trip } = await service.from('trips').select('user_id').eq('id', impact.trip_id).single();
        if (!trip || trip.user_id !== userId) continue;
        const runId = impact.pipeline_run_id ?? `pipe_${Date.now()}`;
        try {
          const result = await processOneEvent(service, eventId, impact.trip_id, runId, userId);
          processed++;
          if (result.result === 'ALERT_CREATED') alertsCreated++;
          if (result.result === 'FAILED') failed++;
          if (result.result === 'NOT_APPLICABLE') notApplicable++;
        } catch  {
          failed++;
        }
      }
      return json({
        processed,
        alerts_created: alertsCreated,
        failed,
        not_applicable: notApplicable
      });
    }
    // POST { monitoring_event_id, trip_id, pipeline_run_id? } — generate alert for one event
    if (body.monitoring_event_id && body.trip_id) {
      const monitoringEventId = body.monitoring_event_id;
      const tripId = body.trip_id;
      const pipelineRunId = body.pipeline_run_id ?? `pipe_${Date.now()}`;
      // Resolve the acting identity. A user caller may only act on a trip
      // they own — checked here with caller.userId, never a body field. A
      // service caller (the pipeline) is trusted and acts as the trip's
      // owner.
      let resolvedUserId;
      if (caller.kind === 'user') {
        const ownerCheck = await requireTripOwner(service, tripId, caller.userId);
        if (ownerCheck instanceof Response) return ownerCheck;
        resolvedUserId = caller.userId;
      } else {
        const { data: trip } = await service.from('trips').select('user_id').eq('id', tripId).maybeSingle();
        if (!trip) return err('Trip not found', 404);
        resolvedUserId = trip.user_id;
      }
      try {
        const result = await processOneEvent(service, monitoringEventId, tripId, pipelineRunId, resolvedUserId);
        return json(result);
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Unknown error';
        if (message === 'Access denied') return err('Access denied', 404);
        if (message === 'Trip not found') return err('Trip not found', 404);
        if (message === 'Monitoring event not found') return err('Monitoring event not found', 404);
        return err(message, 500);
      }
    }
    return err('Unknown action or missing required fields');
  }
  return err('Method not allowed', 405);
});

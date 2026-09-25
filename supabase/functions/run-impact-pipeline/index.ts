// SECURITY 2026-09-17 — The service-call detection compared the bearer token
// to SUPABASE_SERVICE_ROLE_KEY with `jwt === SERVICE_ROLE_KEY`, a
// variable-time string comparison against secret material (timing side
// channel). Replaced with the shared module's `requireUserOrService`, which
// uses a constant-time compare. Behavior for real users and for the
// service-role caller (used by process-snapshot-pipeline) is unchanged.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { requireUserOrService, serviceClient, SUPABASE_URL, SERVICE_ROLE_KEY } from './_shared/auth.ts';
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
// ── Safe failure logger — never throws ─────────────────────────────────────────────
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
async function processOneEvent(serviceClientInstance, monitoringEventId, tripId, pipelineRunId, userId) {
  // 1. Fetch the monitoring event
  const { data: monEvent, error: evErr } = await serviceClientInstance.from('monitoring_events').select('*').eq('id', monitoringEventId).single();
  if (evErr || !monEvent) {
    throw new Error('Monitoring event not found');
  }
  // Verify ownership via trip
  const { data: trip, error: tripErr } = await serviceClientInstance.from('trips').select('id, user_id').eq('id', tripId).single();
  if (tripErr || !trip) throw new Error('Trip not found');
  if (trip.user_id !== userId) throw new Error('Access denied');
  // 2. Check if already processed (idempotency)
  if (monEvent.impact_analysis_status === 'COMPLETE' || monEvent.impact_analysis_status === 'PROCESSING') {
    return {
      monitoring_event_id: monitoringEventId,
      pipeline_run_id: pipelineRunId,
      result: 'COMPLETE',
      overall_impact_level: null,
      impacts_created: monEvent.impacts_created ?? 0,
      impact_analysis_status: monEvent.impact_analysis_status
    };
  }
  // 3. Check if duplicate — mark NOT_APPLICABLE
  if (monEvent.is_duplicate === true) {
    await serviceClientInstance.from('monitoring_events').update({
      impact_analysis_status: 'NOT_APPLICABLE',
      impact_analysis_completed_at: new Date().toISOString()
    }).eq('id', monitoringEventId);
    return {
      monitoring_event_id: monitoringEventId,
      pipeline_run_id: pipelineRunId,
      result: 'NOT_APPLICABLE',
      overall_impact_level: null,
      impacts_created: 0,
      impact_analysis_status: 'NOT_APPLICABLE'
    };
  }
  // 4. Check if NON_CHANGE — mark NOT_APPLICABLE
  if (monEvent.change_category === 'NON_CHANGE') {
    await serviceClientInstance.from('monitoring_events').update({
      impact_analysis_status: 'NOT_APPLICABLE',
      impact_analysis_completed_at: new Date().toISOString()
    }).eq('id', monitoringEventId);
    return {
      monitoring_event_id: monitoringEventId,
      pipeline_run_id: pipelineRunId,
      result: 'NOT_APPLICABLE',
      overall_impact_level: null,
      impacts_created: 0,
      impact_analysis_status: 'NOT_APPLICABLE'
    };
  }
  // 5. Mark as PROCESSING
  await serviceClientInstance.from('monitoring_events').update({
    impact_analysis_status: 'PROCESSING',
    impact_analysis_started_at: new Date().toISOString()
  }).eq('id', monitoringEventId);
  // 6. Call analyze-impact
  let impactData = {};
  let impactOk = false;
  try {
    const impactRes = await fetch(`${SUPABASE_URL}/functions/v1/analyze-impact`, {
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
    impactData = await impactRes.json();
    impactOk = impactRes.ok;
  } catch (fetchErr) {
    impactData = {
      error: fetchErr instanceof Error ? fetchErr.message : 'Network error calling analyze-impact'
    };
    impactOk = false;
  }
  // 7. Handle result
  if (!impactOk || impactData.error) {
    // Mark FAILED — do NOT interpret as no impact, do NOT create fabricated data
    const errorMsg = impactData.error ?? 'Impact analysis could not be completed';
    const failureType = !impactOk ? 'PROCESSING_FAILED' : 'CHECK_FAILED';
    await serviceClientInstance.from('monitoring_events').update({
      impact_analysis_status: 'FAILED',
      impact_analysis_completed_at: new Date().toISOString(),
      impact_analysis_error: errorMsg,
      failure_type: failureType,
      failure_message: 'Impact analysis could not be completed'
    }).eq('id', monitoringEventId);
    // Log to pipeline_recovery_log
    const recoveryLogId = await logRecovery({
      user_id: userId,
      trip_id: tripId,
      operation: 'IMPACT_ANALYSIS',
      related_object_type: 'monitoring_event',
      related_object_id: monitoringEventId,
      failure_type: failureType,
      failure_message: 'Impact analysis could not be completed',
      failure_detail: {
        error: errorMsg,
        pipeline_run_id: pipelineRunId
      }
    });
    // Update monitoring_event with recovery_log_id
    if (recoveryLogId) {
      await serviceClientInstance.from('monitoring_events').update({
        recovery_log_id: recoveryLogId
      }).eq('id', monitoringEventId);
    }
    return {
      monitoring_event_id: monitoringEventId,
      pipeline_run_id: pipelineRunId,
      result: 'FAILED',
      overall_impact_level: null,
      impacts_created: 0,
      impact_analysis_status: 'FAILED',
      recovery_log_id: recoveryLogId
    };
  }
  // Count created impacts
  const impactsCreated = Array.isArray(impactData.impacts) ? impactData.impacts.length : 0;
  const overallLevel = impactData.overall_impact_level ?? 'UNKNOWN';
  // 8. Mark COMPLETE on the monitoring event
  await serviceClientInstance.from('monitoring_events').update({
    impact_analysis_status: 'COMPLETE',
    impact_analysis_completed_at: new Date().toISOString(),
    impacts_created: impactsCreated
  }).eq('id', monitoringEventId);
  // 9. Stamp pipeline_run_id and analysis_triggered_by on the newly created impacts
  if (impactsCreated > 0 && pipelineRunId) {
    const impactIds = (impactData.impacts ?? []).map((i)=>i.id).filter(Boolean);
    if (impactIds.length > 0) {
      await serviceClientInstance.from('trip_impacts').update({
        pipeline_run_id: pipelineRunId,
        analysis_triggered_by: 'PIPELINE'
      }).in('id', impactIds);
    } else {
      // Fallback: stamp by monitoring_event_id if IDs not returned
      await serviceClientInstance.from('trip_impacts').update({
        pipeline_run_id: pipelineRunId,
        analysis_triggered_by: 'PIPELINE'
      }).eq('monitoring_event_id', monitoringEventId).eq('status', 'ACTIVE');
    }
  }
  // 10. Fire-and-forget alert generation if impacts were created and are meaningful
  if (impactsCreated > 0 && overallLevel !== 'NONE') {
    fetch(`${SUPABASE_URL}/functions/v1/run-alert-pipeline`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`
      },
      body: JSON.stringify({
        monitoring_event_id: monitoringEventId,
        trip_id: tripId,
        pipeline_run_id: pipelineRunId ?? `pipe_${Date.now()}`
      })
    }).catch(()=>{});
  }
  return {
    monitoring_event_id: monitoringEventId,
    pipeline_run_id: pipelineRunId,
    result: 'COMPLETE',
    overall_impact_level: overallLevel,
    impacts_created: impactsCreated,
    impact_analysis_status: 'COMPLETE'
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
  const supabase = serviceClient();
  const url = new URL(req.url);
  // ── GET: impact analysis status for an event (client-facing only) ─────────
  if (req.method === 'GET') {
    if (caller.kind !== 'user') return err('Unauthorized', 403);
    const userId = caller.userId;
    const monitoringEventId = url.searchParams.get('monitoring_event_id');
    if (!monitoringEventId) return err('monitoring_event_id required');
    const { data: monEvent, error: evErr } = await supabase.from('monitoring_events').select('*').eq('id', monitoringEventId).single();
    if (evErr || !monEvent) return err('Monitoring event not found', 404);
    // Verify ownership via trip
    if (monEvent.trip_id) {
      const { data: trip } = await supabase.from('trips').select('user_id').eq('id', monEvent.trip_id).single();
      if (!trip || trip.user_id !== userId) return err('Access denied', 403);
    } else {
      return err('Access denied', 403);
    }
    // Count created impacts
    const { count } = await supabase.from('trip_impacts').select('id', {
      count: 'exact',
      head: true
    }).eq('monitoring_event_id', monitoringEventId).eq('status', 'ACTIVE');
    return json({
      monitoring_event_id: monitoringEventId,
      impact_analysis_status: monEvent.impact_analysis_status,
      impact_analysis_started_at: monEvent.impact_analysis_started_at,
      impact_analysis_completed_at: monEvent.impact_analysis_completed_at,
      impact_analysis_error: monEvent.impact_analysis_error,
      failure_type: monEvent.failure_type,
      failure_message: monEvent.failure_message,
      recovery_log_id: monEvent.recovery_log_id,
      impacts_created: monEvent.impacts_created ?? 0,
      active_impacts_count: count ?? 0
    });
  }
  // ── POST ────────────────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    let body;
    try {
      body = await req.json();
    } catch  {
      return err('Invalid JSON body');
    }
    // POST { action: "process_pending" } — batch process all PENDING events
    // (client-facing only: a user asking to process their own pending events)
    if (body.action === 'process_pending') {
      if (caller.kind !== 'user') return err('Unauthorized', 403);
      const userId = caller.userId;
      // Fetch up to 20 PENDING events (non-duplicate, non-NON_CHANGE) owned by this user
      const { data: pendingEvents, error: fetchErr } = await supabase.from('monitoring_events').select('id, trip_id, pipeline_run_id').eq('impact_analysis_status', 'PENDING').eq('is_duplicate', false).neq('change_category', 'NON_CHANGE').limit(20);
      if (fetchErr) return err('Failed to fetch pending events');
      const events = pendingEvents ?? [];
      let processed = 0;
      let impactsCreated = 0;
      let failed = 0;
      let notApplicable = 0;
      for (const event of events){
        // Verify ownership
        if (!event.trip_id) {
          notApplicable++;
          continue;
        }
        const { data: trip } = await supabase.from('trips').select('user_id').eq('id', event.trip_id).single();
        if (!trip || trip.user_id !== userId) continue;
        try {
          const result = await processOneEvent(supabase, event.id, event.trip_id, event.pipeline_run_id ?? null, userId);
          processed++;
          if (result.result === 'COMPLETE') impactsCreated += result.impacts_created;
          if (result.result === 'FAILED') failed++;
          if (result.result === 'NOT_APPLICABLE') notApplicable++;
        } catch  {
          failed++;
        }
      }
      return json({
        processed,
        impacts_created: impactsCreated,
        failed,
        not_applicable: notApplicable
      });
    }
    // POST { monitoring_event_id, trip_id, pipeline_run_id? } — process one event
    // (client or pipeline — process-snapshot-pipeline calls this with the
    // service-role key)
    if (body.monitoring_event_id && body.trip_id) {
      const monitoringEventId = body.monitoring_event_id;
      const tripId = body.trip_id;
      const pipelineRunId = body.pipeline_run_id ?? null;
      // For a service caller, resolve the effective user from trip ownership
      // (there is no user token to resolve one from).
      let resolvedUserId = null;
      if (caller.kind === 'user') {
        resolvedUserId = caller.userId;
      } else {
        const { data: trip } = await supabase.from('trips').select('user_id').eq('id', tripId).single();
        resolvedUserId = trip?.user_id ?? null;
      }
      if (!resolvedUserId) return err('Unauthorized', 403);
      try {
        const result = await processOneEvent(supabase, monitoringEventId, tripId, pipelineRunId, resolvedUserId);
        return json(result);
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Unknown error';
        if (message === 'Access denied') return err('Access denied', 403);
        if (message === 'Trip not found') return err('Trip not found', 404);
        if (message === 'Monitoring event not found') return err('Monitoring event not found', 404);
        return err(message, 500);
      }
    }
    return err('Unknown action or missing required fields');
  }
  return err('Method not allowed', 405);
});

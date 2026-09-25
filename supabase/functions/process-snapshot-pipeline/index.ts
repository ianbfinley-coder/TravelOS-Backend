// process-snapshot-pipeline
//
// PIPELINE AUTH 2026-09-19 — this function could not be called by the pipeline
// it belongs to.
//
// The gate here was hand-rolled: build an anon client from the incoming bearer
// and call `supabase.auth.getUser(jwt)`. That resolves a bearer to a row in
// `auth.users`. The service-role key is not a user token — it carries
// `role: service_role` and no `sub`, so there is no user to resolve and
// `getUser` always fails. Every service-to-service call therefore got a denial,
// and it was `403`, not the `401` the rest of the fleet returns for a bad
// credential.
//
// Who was calling with the service-role key: `pipeline-recovery`. Its retry
// path for the `SNAPSHOT_PROCESSING` and `CHANGE_DETECTION` operations POSTs
// here with `Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}`. That retry
// has therefore never once succeeded — every retry was recorded as attempted
// and bounced at the door. A snapshot that failed processing stayed failed
// forever while the recovery log said it was being retried.
//
// The fix is the house pattern: `requireUserOrService` from `_shared/auth.ts`,
// which accepts either a real user JWT or the service-role key (compared in
// constant time) and returns `{kind:'service'}` or `{kind:'user', userId, …}`.
//
// THE USER PATH IS UNCHANGED. A user caller still has every ownership check
// applied exactly as before:
//   * POST { snapshot_id }        — monitoredEntity.user_id must equal the
//                                   caller, or 403 Access denied.
//   * POST { action:'process_pending' }
//                                 — the queue is still filtered to snapshots
//                                   whose monitored_entities.user_id is the
//                                   caller.
//   * GET  ?snapshot_id=          — the entity's user_id must equal the
//                                   caller, or 403 Access denied.
// Only the service path skips those comparisons, and it does NOT take an
// identity from the request body: the owning user is read from the data, out
// of `monitored_entities.user_id`, and that is what gets recorded on the
// recovery log.
//
// Two adjacent defects fixed in the same pass:
//   * `if (snapErr || !snapshot) -> 'Snapshot not found'` collapsed a failed
//     query into a 404. A broken query is a 500 that says so; only an absent
//     row is a 404. PGRST116 is PostgREST's no-rows code.
//   * `if (fetchErr) return err('Failed to fetch pending snapshots')` returned
//     400 and threw the reason away. It now returns 500 with the message and
//     logs it.
//
// Every column named below was checked against information_schema.columns on
// 2026-09-19: monitoring_snapshots(id, monitored_entity_id, pipeline_status,
// pipeline_started_at, pipeline_completed_at, pipeline_error, events_created,
// events_deduplicated, failure_type, failure_message, recovery_log_id,
// check_result), monitored_entities(user_id, trip_id),
// monitoring_events(pipeline_run_id). The embed
// `monitored_entities!inner(...)` is backed by
// monitoring_snapshots_monitored_entity_id_fkey.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { requireUserOrService, serviceClient as makeServiceClient } from './_shared/auth.ts';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
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
// ── Safe failure logger — never throws ───────────────────────────────────────
async function logRecovery(serviceClient, params) {
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
    console.error(`[process-snapshot-pipeline] pipeline-recovery log_failure returned ${res.status}`);
    return null;
  } catch (e) {
    console.error('[process-snapshot-pipeline] pipeline-recovery unreachable:', e instanceof Error ? e.message : String(e));
    return null;
  }
}
/**
 * `callerUserId` is the authenticated user for a user caller, or `null` for a
 * service caller. It is ONLY ever used for the ownership comparison. The user
 * id recorded against the work is always the entity's own
 * `monitored_entities.user_id`, read from the row — never from the request.
 */ async function processOneSnapshot(serviceClient, snapshotId, callerUserId) {
  // 1. Fetch snapshot and verify ownership via monitored_entity
  const { data: snapshot, error: snapErr } = await serviceClient.from('monitoring_snapshots').select('*, monitored_entities!inner(user_id, trip_id)').eq('id', snapshotId).single();
  if (snapErr) {
    // PGRST116 is "no rows returned" — an absent row, i.e. a genuine 404.
    // Anything else is a broken query and must not masquerade as one.
    if (snapErr.code === 'PGRST116') throw new Error('Snapshot not found');
    console.error('[process-snapshot-pipeline] snapshot lookup failed:', snapErr.code, snapErr.message);
    throw new Error(`Snapshot lookup failed: ${snapErr.message}`);
  }
  if (!snapshot) throw new Error('Snapshot not found');
  const monitoredEntity = snapshot.monitored_entities;
  // Ownership. A user caller must own the entity — unchanged. A service caller
  // (pipeline-recovery, the pending-queue drain) has no user to compare, so the
  // comparison is skipped and the owner is taken from the row itself.
  if (callerUserId !== null && monitoredEntity.user_id !== callerUserId) {
    throw new Error('Access denied');
  }
  const ownerUserId = monitoredEntity.user_id;
  // 2. Check if already processed
  if (snapshot.pipeline_status === 'COMPLETE' || snapshot.pipeline_status === 'PROCESSING') {
    return {
      snapshot_id: snapshotId,
      pipeline_run_id: '',
      result: snapshot.check_result ?? 'UNKNOWN',
      events_created: snapshot.events_created ?? 0,
      events_deduplicated: snapshot.events_deduplicated ?? 0,
      pipeline_status: snapshot.pipeline_status
    };
  }
  // 3. Mark as PROCESSING
  const pipeline_run_id = `pipe_${Date.now()}_${snapshotId.slice(0, 8)}`;
  {
    const { error } = await serviceClient.from('monitoring_snapshots').update({
      pipeline_status: 'PROCESSING',
      pipeline_started_at: new Date().toISOString()
    }).eq('id', snapshotId);
    if (error) console.error('[process-snapshot-pipeline] could not mark PROCESSING:', error.message);
  }
  // 4. Call detect-changes
  let detectData = {};
  let detectOk = false;
  try {
    const detectRes = await fetch(`${SUPABASE_URL}/functions/v1/detect-changes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`
      },
      body: JSON.stringify({
        monitored_entity_id: snapshot.monitored_entity_id,
        new_snapshot_id: snapshotId
      })
    });
    detectData = await detectRes.json();
    detectOk = detectRes.ok;
  } catch (fetchErr) {
    detectData = {
      error: fetchErr instanceof Error ? fetchErr.message : 'Network error calling detect-changes'
    };
    detectOk = false;
  }
  // 5. Handle result
  const result = detectData.result ?? 'CHECK_FAILED';
  const eventsCreated = detectData.events_created ?? 0;
  const eventsDeduplicated = detectData.events_deduplicated ?? 0;
  let pipelineStatus;
  let pipelineError = null;
  let failureType = null;
  let recoveryLogId = null;
  if (!detectOk || result === 'CHECK_FAILED') {
    // CHECK_FAILED: mark as FAILED, log recovery, preserve snapshot
    pipelineStatus = 'FAILED';
    failureType = 'CHECK_FAILED';
    pipelineError = detectData.error ?? 'Monitoring check could not be completed';
    // Update snapshot with failure info (do NOT overwrite normalized_state)
    {
      const { error } = await serviceClient.from('monitoring_snapshots').update({
        pipeline_status: 'FAILED',
        pipeline_completed_at: new Date().toISOString(),
        pipeline_error: pipelineError,
        failure_type: failureType,
        failure_message: 'Monitoring check could not be completed'
      }).eq('id', snapshotId);
      if (error) console.error('[process-snapshot-pipeline] could not record CHECK_FAILED:', error.message);
    }
    // Log to pipeline_recovery_log
    recoveryLogId = await logRecovery(serviceClient, {
      user_id: ownerUserId,
      trip_id: monitoredEntity.trip_id,
      operation: 'SNAPSHOT_PROCESSING',
      related_object_type: 'monitoring_snapshot',
      related_object_id: snapshotId,
      failure_type: 'CHECK_FAILED',
      failure_message: 'Monitoring check could not be completed',
      failure_detail: {
        detect_error: pipelineError,
        result
      }
    });
    // Update snapshot with recovery_log_id
    if (recoveryLogId) {
      const { error } = await serviceClient.from('monitoring_snapshots').update({
        recovery_log_id: recoveryLogId
      }).eq('id', snapshotId);
      if (error) console.error('[process-snapshot-pipeline] could not stamp recovery_log_id:', error.message);
    }
    return {
      snapshot_id: snapshotId,
      pipeline_run_id,
      result,
      events_created: 0,
      events_deduplicated: 0,
      pipeline_status: 'FAILED',
      failure_type: failureType,
      recovery_log_id: recoveryLogId
    };
  } else if (result === 'SOURCE_UNAVAILABLE') {
    // SOURCE_UNAVAILABLE: mark as FAILED, log recovery
    pipelineStatus = 'FAILED';
    failureType = 'SOURCE_UNAVAILABLE';
    pipelineError = 'Monitoring source is temporarily unavailable';
    {
      const { error } = await serviceClient.from('monitoring_snapshots').update({
        pipeline_status: 'FAILED',
        pipeline_completed_at: new Date().toISOString(),
        pipeline_error: pipelineError,
        failure_type: failureType,
        failure_message: 'Monitoring source is temporarily unavailable'
      }).eq('id', snapshotId);
      if (error) console.error('[process-snapshot-pipeline] could not record SOURCE_UNAVAILABLE:', error.message);
    }
    recoveryLogId = await logRecovery(serviceClient, {
      user_id: ownerUserId,
      trip_id: monitoredEntity.trip_id,
      operation: 'SNAPSHOT_PROCESSING',
      related_object_type: 'monitoring_snapshot',
      related_object_id: snapshotId,
      failure_type: 'SOURCE_UNAVAILABLE',
      failure_message: 'Monitoring source is temporarily unavailable',
      failure_detail: {
        result
      }
    });
    if (recoveryLogId) {
      const { error } = await serviceClient.from('monitoring_snapshots').update({
        recovery_log_id: recoveryLogId
      }).eq('id', snapshotId);
      if (error) console.error('[process-snapshot-pipeline] could not stamp recovery_log_id:', error.message);
    }
    return {
      snapshot_id: snapshotId,
      pipeline_run_id,
      result,
      events_created: 0,
      events_deduplicated: 0,
      pipeline_status: 'FAILED',
      failure_type: failureType,
      recovery_log_id: recoveryLogId
    };
  } else if (result === 'STALE') {
    // STALE: expected behavior, mark as SKIPPED — do NOT log as failure
    pipelineStatus = 'SKIPPED';
    {
      const { error } = await serviceClient.from('monitoring_snapshots').update({
        pipeline_status: 'SKIPPED',
        pipeline_completed_at: new Date().toISOString(),
        events_created: 0,
        events_deduplicated: 0
      }).eq('id', snapshotId);
      if (error) console.error('[process-snapshot-pipeline] could not record SKIPPED:', error.message);
    }
    return {
      snapshot_id: snapshotId,
      pipeline_run_id,
      result,
      events_created: 0,
      events_deduplicated: 0,
      pipeline_status: 'SKIPPED'
    };
  } else if (result === 'CHANGE_DETECTED') {
    pipelineStatus = 'COMPLETE';
  } else if (result === 'NO_CHANGE') {
    pipelineStatus = 'COMPLETE';
  } else if (result === 'FIRST_SNAPSHOT') {
    pipelineStatus = 'COMPLETE';
  } else {
    // Unexpected result — treat as failure
    pipelineStatus = 'FAILED';
    failureType = 'PROCESSING_FAILED';
    pipelineError = `Unexpected result: ${result}`;
    {
      const { error } = await serviceClient.from('monitoring_snapshots').update({
        pipeline_status: 'FAILED',
        pipeline_completed_at: new Date().toISOString(),
        pipeline_error: pipelineError,
        failure_type: failureType,
        failure_message: 'Monitoring check returned an unexpected result'
      }).eq('id', snapshotId);
      if (error) console.error('[process-snapshot-pipeline] could not record PROCESSING_FAILED:', error.message);
    }
    recoveryLogId = await logRecovery(serviceClient, {
      user_id: ownerUserId,
      trip_id: monitoredEntity.trip_id,
      operation: 'SNAPSHOT_PROCESSING',
      related_object_type: 'monitoring_snapshot',
      related_object_id: snapshotId,
      failure_type: 'PROCESSING_FAILED',
      failure_message: 'Monitoring check returned an unexpected result',
      failure_detail: {
        result,
        error: pipelineError
      }
    });
    return {
      snapshot_id: snapshotId,
      pipeline_run_id,
      result,
      events_created: 0,
      events_deduplicated: 0,
      pipeline_status: 'FAILED',
      failure_type: failureType ?? undefined,
      recovery_log_id: recoveryLogId
    };
  }
  // 6. Update snapshot with final pipeline state (success path)
  {
    const { error } = await serviceClient.from('monitoring_snapshots').update({
      pipeline_status: pipelineStatus,
      pipeline_completed_at: new Date().toISOString(),
      events_created: eventsCreated,
      events_deduplicated: eventsDeduplicated,
      pipeline_error: pipelineError
    }).eq('id', snapshotId);
    if (error) console.error('[process-snapshot-pipeline] could not record final state:', error.message);
  }
  // 7. If events were created, stamp them with pipeline_run_id
  if (eventsCreated > 0 && detectData.events && detectData.events.length > 0) {
    const eventIds = detectData.events.filter((e)=>e.id && !e.is_duplicate).map((e)=>e.id);
    if (eventIds.length > 0) {
      const { error } = await serviceClient.from('monitoring_events').update({
        pipeline_run_id
      }).in('id', eventIds);
      if (error) console.error('[process-snapshot-pipeline] could not stamp pipeline_run_id on events:', error.message);
    }
  }
  // 8. Fire-and-forget impact analysis for each non-duplicate event
  if (result === 'CHANGE_DETECTED' && detectData.events && detectData.events.length > 0) {
    const tripId = monitoredEntity.trip_id;
    for (const event of detectData.events){
      if (!event.is_duplicate && event.id) {
        fetch(`${SUPABASE_URL}/functions/v1/run-impact-pipeline`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${SERVICE_ROLE_KEY}`
          },
          body: JSON.stringify({
            monitoring_event_id: event.id,
            trip_id: tripId,
            pipeline_run_id
          })
        }).catch((e)=>console.error('[process-snapshot-pipeline] run-impact-pipeline unreachable:', e instanceof Error ? e.message : String(e)));
      }
    }
  }
  return {
    snapshot_id: snapshotId,
    pipeline_run_id,
    result,
    events_created: eventsCreated,
    events_deduplicated: eventsDeduplicated,
    pipeline_status: pipelineStatus
  };
}
Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: corsHeaders
    });
  }
  // Accepts either a real user's JWT (the client watching its own snapshots)
  // or the service-role key (pipeline-recovery's SNAPSHOT_PROCESSING and
  // CHANGE_DETECTION retries). A bad credential is 401, matching the fleet —
  // this used to be 403, which said "you are known and refused" about a caller
  // that was never identified at all.
  const caller = await requireUserOrService(req);
  if (caller instanceof Response) return caller;
  // null for a service caller. Used ONLY for ownership comparisons.
  const callerUserId = caller.kind === 'user' ? caller.userId : null;
  // Service client for all DB operations
  const serviceClient = makeServiceClient();
  const url = new URL(req.url);
  // ── GET: pipeline status for a snapshot ──────────────────────────────────
  if (req.method === 'GET') {
    const snapshotId = url.searchParams.get('snapshot_id');
    if (!snapshotId) return err('snapshot_id required');
    const { data: snapshot, error: snapErr } = await serviceClient.from('monitoring_snapshots').select('*, monitored_entities!inner(user_id)').eq('id', snapshotId).single();
    if (snapErr) {
      if (snapErr.code === 'PGRST116') return err('Snapshot not found', 404);
      console.error('[process-snapshot-pipeline] GET snapshot lookup failed:', snapErr.code, snapErr.message);
      return err(`Snapshot lookup failed: ${snapErr.message}`, 500);
    }
    if (!snapshot) return err('Snapshot not found', 404);
    // Unchanged for a user caller. A service caller has no user id to compare,
    // so the check is skipped rather than failed.
    if (callerUserId !== null) {
      const entityUserId = snapshot.monitored_entities.user_id;
      if (entityUserId !== callerUserId) return err('Access denied', 403);
    }
    return json({
      snapshot_id: snapshotId,
      pipeline_status: snapshot.pipeline_status,
      pipeline_started_at: snapshot.pipeline_started_at,
      pipeline_completed_at: snapshot.pipeline_completed_at,
      pipeline_error: snapshot.pipeline_error,
      failure_type: snapshot.failure_type,
      failure_message: snapshot.failure_message,
      recovery_log_id: snapshot.recovery_log_id,
      events_created: snapshot.events_created,
      events_deduplicated: snapshot.events_deduplicated,
      check_result: snapshot.check_result
    });
  }
  // ── POST ──────────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    let body;
    try {
      body = await req.json();
    } catch  {
      return err('Invalid JSON body');
    }
    // POST { snapshot_id } — process one snapshot
    if (body.snapshot_id) {
      const snapshotId = body.snapshot_id;
      try {
        const result = await processOneSnapshot(serviceClient, snapshotId, callerUserId);
        // Check if it was already processed (idempotency)
        if (result.pipeline_run_id === '') {
          return json({
            ...result,
            already_processed: true
          });
        }
        return json(result);
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Unknown error';
        if (message === 'Access denied') return err('Access denied', 403);
        if (message === 'Snapshot not found') return err('Snapshot not found', 404);
        return err(message, 500);
      }
    }
    // POST { action: "process_pending", trip_id? } — batch process
    if (body.action === 'process_pending') {
      const tripId = body.trip_id;
      // Fetch up to 20 PENDING snapshots.
      //
      // A user caller still sees only their own queue — the
      // monitored_entities.user_id filter is applied exactly as before. A
      // service caller (the worker draining the queue) has no user to filter
      // by; dropping the filter is the whole point of the worker path. The
      // optional trip_id filter still applies to both.
      let query = serviceClient.from('monitoring_snapshots').select('id, monitored_entities!inner(user_id, trip_id)').eq('pipeline_status', 'PENDING').limit(20);
      if (callerUserId !== null) {
        query = query.eq('monitored_entities.user_id', callerUserId);
      }
      if (tripId) {
        query = query.eq('monitored_entities.trip_id', tripId);
      }
      const { data: pendingSnapshots, error: fetchErr } = await query;
      if (fetchErr) {
        console.error('[process-snapshot-pipeline] pending queue query failed:', fetchErr.code, fetchErr.message);
        return err(`Failed to fetch pending snapshots: ${fetchErr.message}`, 500);
      }
      const snapshots = pendingSnapshots ?? [];
      let processed = 0;
      let changesDetected = 0;
      let failed = 0;
      let skipped = 0;
      // Process sequentially to avoid race conditions on the same entity
      for (const snap of snapshots){
        try {
          const result = await processOneSnapshot(serviceClient, snap.id, callerUserId);
          processed++;
          if (result.result === 'CHANGE_DETECTED') changesDetected++;
          if (result.pipeline_status === 'FAILED') failed++;
          if (result.pipeline_status === 'SKIPPED') skipped++;
        } catch (e) {
          console.error(`[process-snapshot-pipeline] snapshot ${snap.id} threw:`, e instanceof Error ? e.message : String(e));
          failed++;
        }
      }
      return json({
        processed,
        changes_detected: changesDetected,
        failed,
        skipped
      });
    }
    return err('Unknown action or missing snapshot_id');
  }
  return err('Method not allowed', 405);
});

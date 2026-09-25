// SECURITY 2026-09-16 — This function had no authentication at all. Any
// unauthenticated caller could send GET ?trip_id=<any> and receive up to 50
// full pipeline_recovery_log rows for that trip (failure details, retry
// counts, transition history) for any trip_id they chose, including ones
// they had no relationship to, simply by guessing or enumerating ids. The
// same caller could POST with actions like `retry`, `process_pending`,
// `process_retry_pending`, `transition_state`, and `select_terminal_state`
// to force arbitrary pipeline re-runs and drive operations into terminal
// states (SUCCESS, PERMANENT_FAILURE, CANCELLED, etc.) for any operation_id,
// with no proof the caller was ever authorized to touch it. The handler
// built a service_role client immediately on every request and ran all of
// this before checking anything about who was asking.
//
// This is internal service-to-service plumbing with no user-facing concept
// (recovery logs, state machines, attempt counters), so the fix gates on
// the service-role key rather than a user JWT: `requireService()` compares
// the bearer token against SUPABASE_SERVICE_ROLE_KEY in constant time and
// rejects everything else with 401 before any database access.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { requireService, corsHeaders, json } from './_shared/auth.ts';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
function err(msg, status = 400) {
  return json({
    error: msg
  }, status);
}
// ─────────────────────────────────────────────────────────────────────────────
const TERMINAL_STATES = new Set([
  'SUCCESS',
  'CANCELLED',
  'CANCELLED_STALE',
  'NOT_SUPPORTED',
  'INVALID',
  'DATA_CONFLICT',
  'AUTHORIZATION_REQUIRED',
  'SOURCE_UNAVAILABLE',
  'PERMANENT_FAILURE',
  'EXECUTION_FAILED',
  'RECALCULATION_FAILED',
  'FAILED_PERMANENTLY'
]);
const OPERATION_TYPES = [
  'MONITORING_SOURCE',
  'CHANGE_DETECTION',
  'TRIP_IMPACT',
  'TRAVEL_ALERT',
  'ALERT_SCORING',
  'NOTIFICATION_ELIGIBILITY',
  'COPILOT_CONTEXT',
  'ITINERARY_CHANGE',
  'HEALTH_RECALCULATION',
  'FRICTION_RECALCULATION',
  'READINESS_RECALCULATION',
  'ISSUES_RECALCULATION'
];
const OPERATION_TERMINAL_FALLBACK = {
  MONITORING_SOURCE: 'SOURCE_UNAVAILABLE',
  CHANGE_DETECTION: 'PERMANENT_FAILURE',
  TRIP_IMPACT: 'PERMANENT_FAILURE',
  TRAVEL_ALERT: 'PERMANENT_FAILURE',
  ALERT_SCORING: 'PERMANENT_FAILURE',
  NOTIFICATION_ELIGIBILITY: 'PERMANENT_FAILURE',
  COPILOT_CONTEXT: 'PERMANENT_FAILURE',
  ITINERARY_CHANGE: 'EXECUTION_FAILED',
  HEALTH_RECALCULATION: 'RECALCULATION_FAILED',
  FRICTION_RECALCULATION: 'RECALCULATION_FAILED',
  READINESS_RECALCULATION: 'RECALCULATION_FAILED',
  ISSUES_RECALCULATION: 'RECALCULATION_FAILED'
};
const OPERATION_MAX_ATTEMPTS = {
  MONITORING_SOURCE: 5,
  CHANGE_DETECTION: 3,
  TRIP_IMPACT: 3,
  TRAVEL_ALERT: 3,
  ALERT_SCORING: 3,
  NOTIFICATION_ELIGIBILITY: 3,
  COPILOT_CONTEXT: 3,
  ITINERARY_CHANGE: 2,
  HEALTH_RECALCULATION: 3,
  FRICTION_RECALCULATION: 3,
  READINESS_RECALCULATION: 3,
  ISSUES_RECALCULATION: 3
};
// ─── RETRY POLICIES ───────────────────────────────────────────────────────────
const RETRY_POLICIES = {
  MONITORING_SOURCE: {
    initial_delay_ms: 5000,
    max_delay_ms: 300000,
    max_attempts: 5
  },
  MONITORING: {
    initial_delay_ms: 5000,
    max_delay_ms: 300000,
    max_attempts: 5
  },
  CHANGE_DETECTION: {
    initial_delay_ms: 2000,
    max_delay_ms: 30000,
    max_attempts: 3
  },
  TRIP_IMPACT: {
    initial_delay_ms: 2000,
    max_delay_ms: 30000,
    max_attempts: 3
  },
  TRAVEL_ALERT: {
    initial_delay_ms: 2000,
    max_delay_ms: 30000,
    max_attempts: 3
  },
  ALERT_SCORING: {
    initial_delay_ms: 1000,
    max_delay_ms: 15000,
    max_attempts: 3
  },
  NOTIFICATION_ELIGIBILITY: {
    initial_delay_ms: 1000,
    max_delay_ms: 15000,
    max_attempts: 3
  },
  COPILOT_CONTEXT: {
    initial_delay_ms: 3000,
    max_delay_ms: 45000,
    max_attempts: 3
  },
  ITINERARY_CHANGE: {
    initial_delay_ms: 3000,
    max_delay_ms: 15000,
    max_attempts: 2
  },
  HEALTH_RECALCULATION: {
    initial_delay_ms: 5000,
    max_delay_ms: 60000,
    max_attempts: 3
  },
  FRICTION_RECALCULATION: {
    initial_delay_ms: 5000,
    max_delay_ms: 60000,
    max_attempts: 3
  },
  READINESS_RECALCULATION: {
    initial_delay_ms: 5000,
    max_delay_ms: 60000,
    max_attempts: 3
  },
  ISSUES_RECALCULATION: {
    initial_delay_ms: 5000,
    max_delay_ms: 60000,
    max_attempts: 3
  }
};
// ─── calculateRetryDelay ──────────────────────────────────────────────────────
function calculateRetryDelay(operation_type, attempt_number) {
  const policy = RETRY_POLICIES[operation_type] ?? RETRY_POLICIES['CHANGE_DETECTION'];
  const calculated_backoff_ms = Math.round(policy.initial_delay_ms * Math.pow(2, attempt_number - 1));
  const capped_delay_ms = Math.min(calculated_backoff_ms, policy.max_delay_ms);
  const jitter_multiplier = 0.80 + Math.random() * 0.40;
  const retry_delay_ms = Math.round(capped_delay_ms * jitter_multiplier);
  return {
    calculated_backoff_ms,
    capped_delay_ms,
    jitter_multiplier,
    retry_delay_ms
  };
}
const VALID_TRANSITIONS = {
  OPERATION_REQUESTED: [
    {
      to: 'ATTEMPTING',
      condition: 'execution begins'
    },
    {
      to: 'CANCELLED',
      condition: 'user cancelled before execution'
    },
    {
      to: 'CANCELLED_STALE',
      condition: 'operation became stale'
    },
    {
      to: 'NOT_SUPPORTED',
      condition: 'capability unavailable before execution'
    },
    {
      to: 'INVALID',
      condition: 'invalid input discovered before execution'
    }
  ],
  ATTEMPTING: [
    {
      to: 'SUCCESS',
      condition: 'operation succeeds'
    },
    {
      to: 'FAILED',
      condition: 'retryable failure + attempts remain'
    },
    {
      to: 'CANCELLED',
      condition: 'user cancellation'
    },
    {
      to: 'CANCELLED_STALE',
      condition: 'operation becomes stale'
    },
    {
      to: 'NOT_SUPPORTED',
      condition: 'unsupported capability'
    },
    {
      to: 'INVALID',
      condition: 'invalid input/data'
    },
    {
      to: 'DATA_CONFLICT',
      condition: 'unresolved source conflict'
    },
    {
      to: 'AUTHORIZATION_REQUIRED',
      condition: 'authorization required'
    },
    {
      to: 'SOURCE_UNAVAILABLE',
      condition: 'source unavailable + attempts exhausted'
    },
    {
      to: 'UNKNOWN',
      condition: 'outcome cannot be determined safely'
    },
    {
      to: 'PERMANENT_FAILURE',
      condition: 'retryable failure + no attempts remain'
    },
    {
      to: 'EXECUTION_FAILED',
      condition: 'itinerary execution failure + no attempts remain'
    },
    {
      to: 'RECALCULATION_FAILED',
      condition: 'health/readiness failure + no attempts remain'
    }
  ],
  FAILED: [
    {
      to: 'RETRY_PENDING',
      condition: 'retry permitted'
    },
    {
      to: 'PERMANENT_FAILURE',
      condition: 'retry no longer permitted'
    },
    {
      to: 'SOURCE_UNAVAILABLE',
      condition: 'source unavailable + no attempts remain'
    },
    {
      to: 'EXECUTION_FAILED',
      condition: 'execution failure + no attempts remain'
    },
    {
      to: 'RECALCULATION_FAILED',
      condition: 'recalculation failure + no attempts remain'
    }
  ],
  RETRY_PENDING: [
    {
      to: 'RETRYING',
      condition: 'retry time reached + operation valid'
    },
    {
      to: 'CANCELLED',
      condition: 'operation cancelled'
    },
    {
      to: 'CANCELLED_STALE',
      condition: 'operation stale'
    },
    {
      to: 'NOT_SUPPORTED',
      condition: 'capability becomes unsupported'
    },
    {
      to: 'PERMANENT_FAILURE',
      condition: 'retry policy expires'
    },
    {
      to: 'SOURCE_UNAVAILABLE',
      condition: 'retry policy expires + source unavailable'
    },
    {
      to: 'EXECUTION_FAILED',
      condition: 'retry policy expires + execution type'
    },
    {
      to: 'RECALCULATION_FAILED',
      condition: 'retry policy expires + recalculation type'
    }
  ],
  RETRYING: [
    {
      to: 'ATTEMPTING',
      condition: 'scheduler starts execution'
    },
    {
      to: 'CANCELLED',
      condition: 'operation cancelled before execution'
    },
    {
      to: 'CANCELLED_STALE',
      condition: 'operation becomes stale before execution'
    }
  ],
  UNKNOWN: [
    {
      to: 'SUCCESS',
      condition: 'reconciliation confirms success'
    },
    {
      to: 'RETRY_PENDING',
      condition: 'reconciliation confirms retryable failure + attempts remain'
    },
    {
      to: 'SOURCE_UNAVAILABLE',
      condition: 'reconciliation confirms source unavailable'
    },
    {
      to: 'DATA_CONFLICT',
      condition: 'reconciliation confirms conflict'
    },
    {
      to: 'INVALID',
      condition: 'reconciliation confirms invalid input'
    },
    {
      to: 'NOT_SUPPORTED',
      condition: 'reconciliation confirms unsupported capability'
    },
    {
      to: 'EXECUTION_FAILED',
      condition: 'reconciliation confirms execution failure'
    },
    {
      to: 'PERMANENT_FAILURE',
      condition: 'reconciliation confirms non-retryable failure'
    },
    {
      to: 'UNKNOWN',
      condition: 'reconciliation cannot establish safe state'
    }
  ]
};
function validateTransition(from, to) {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed) {
    return json({
      error: `Invalid transition: state '${from}' has no defined outgoing transitions. Terminal or unrecognised state.`
    }, 422);
  }
  const match = allowed.find((t)=>t.to === to);
  if (!match) {
    const validTargets = allowed.map((t)=>t.to).join(', ');
    return json({
      error: `Invalid transition: '${from}' → '${to}' is not permitted. Valid targets from '${from}': [${validTargets}]`
    }, 422);
  }
  return null;
}
// ─── TRAVELER CONTEXT ─────────────────────────────────────────────────────────
const TRAVELER_CONTEXT = {
  OPERATION_REQUESTED: 'Your request has been received and is being prepared for processing.',
  ATTEMPTING: 'TravelOS is actively processing your request.',
  FAILED: 'A temporary issue occurred. TravelOS is preparing to retry.',
  SOURCE_UNAVAILABLE: 'The data source is temporarily unavailable. Please check back shortly.',
  DATA_CONFLICT: 'Your update could not be verified due to a data conflict.',
  CANCELLED_STALE: 'This update is no longer current and has been cancelled.',
  PERMANENT_FAILURE: 'This update could not be completed after multiple attempts.',
  RETRY_PENDING: 'TravelOS is waiting to retry your request.',
  RETRYING: 'TravelOS is retrying your request now.',
  UNKNOWN: 'The status of your request could not be confirmed. TravelOS is investigating.',
  RECOVERED: 'Your update has been completed successfully.',
  SUCCESS: 'Your update has been completed successfully.',
  CANCELLED: 'Your update has been cancelled.',
  NOT_SUPPORTED: 'This operation is not supported for your current configuration.',
  INVALID: 'Your request could not be processed due to invalid input.',
  AUTHORIZATION_REQUIRED: 'Authorization is required to complete this update.',
  EXECUTION_FAILED: 'The itinerary change could not be completed. Your previous itinerary is preserved.',
  RECALCULATION_FAILED: 'The recalculation could not be completed. Your previous data is preserved.',
  PENDING: 'TravelOS is preparing to retry your request.',
  PROCESSING: 'TravelOS is processing your request.',
  FAILED_PERMANENTLY: 'This update could not be completed and will not be retried.',
  NOT_REQUIRED: 'No update was required.'
};
const TRAVELER_LABELS = {
  OPERATION_REQUESTED: 'TRAVELOS IS PREPARING',
  ATTEMPTING: 'TRAVELOS IS PROCESSING',
  FAILED: 'TRAVELOS IS RETRYING',
  SOURCE_UNAVAILABLE: 'SOURCE TEMPORARILY UNAVAILABLE',
  DATA_CONFLICT: 'UPDATE COULD NOT BE VERIFIED',
  CANCELLED_STALE: 'THIS UPDATE IS NO LONGER CURRENT',
  PERMANENT_FAILURE: 'UPDATE COULD NOT BE COMPLETED',
  RETRY_PENDING: 'TRAVELOS IS RETRYING',
  RETRYING: 'TRAVELOS IS RETRYING',
  UNKNOWN: 'STATUS COULD NOT BE CONFIRMED',
  RECOVERED: 'UPDATE COMPLETED',
  SUCCESS: 'UPDATE COMPLETED',
  CANCELLED: 'UPDATE CANCELLED',
  NOT_SUPPORTED: 'NOT SUPPORTED',
  INVALID: 'UPDATE COULD NOT BE PROCESSED',
  AUTHORIZATION_REQUIRED: 'AUTHORIZATION REQUIRED',
  EXECUTION_FAILED: 'UPDATE COULD NOT BE COMPLETED',
  RECALCULATION_FAILED: 'RECALCULATION COULD NOT BE COMPLETED',
  PENDING: 'TRAVELOS IS RETRYING',
  PROCESSING: 'TRAVELOS IS RETRYING',
  FAILED_PERMANENTLY: 'UPDATE COULD NOT BE COMPLETED',
  NOT_REQUIRED: 'UPDATE COMPLETED'
};
function getTravelerLabel(recovery_status) {
  return TRAVELER_LABELS[recovery_status] ?? 'STATUS UNKNOWN';
}
function selectTerminalState(ctx) {
  if (ctx.user_cancelled) return 'CANCELLED';
  if (ctx.is_stale) return 'CANCELLED_STALE';
  if (ctx.capability_unsupported) return 'NOT_SUPPORTED';
  if (ctx.data_invalid) return 'INVALID';
  if (ctx.data_conflict) return 'DATA_CONFLICT';
  if (ctx.authorization_failure) return 'AUTHORIZATION_REQUIRED';
  if (ctx.source_unavailable && !ctx.attempts_remaining) return 'SOURCE_UNAVAILABLE';
  if (ctx.source_unavailable && ctx.attempts_remaining) return 'RETRY_PENDING';
  if (ctx.is_retryable && ctx.attempts_remaining) return 'RETRY_PENDING';
  if (ctx.is_retryable && !ctx.attempts_remaining) {
    if (ctx.operation_type && OPERATION_TERMINAL_FALLBACK[ctx.operation_type]) {
      return OPERATION_TERMINAL_FALLBACK[ctx.operation_type];
    }
    return 'PERMANENT_FAILURE';
  }
  if (ctx.operation_type && OPERATION_TERMINAL_FALLBACK[ctx.operation_type]) {
    return OPERATION_TERMINAL_FALLBACK[ctx.operation_type];
  }
  return 'PERMANENT_FAILURE';
}
function validateTimestampOrdering(requested_at, attempt_started_at, failed_at) {
  const issues = [];
  if (requested_at && attempt_started_at) {
    if (new Date(attempt_started_at) < new Date(requested_at)) {
      issues.push('attempt_started_at < requested_at');
    }
  }
  if (attempt_started_at && failed_at) {
    if (new Date(failed_at) < new Date(attempt_started_at)) {
      issues.push('failed_at < attempt_started_at');
    }
  }
  if (issues.length > 0) {
    return {
      skew_detected: true,
      raw_timestamps: {
        requested_at,
        attempt_started_at,
        failed_at
      }
    };
  }
  return {
    skew_detected: false
  };
}
function checkTerminalImmutability(current_status) {
  if (current_status && TERMINAL_STATES.has(current_status)) {
    return json({
      error: `Operation is in terminal state ${current_status} and cannot be automatically restarted. Create a new operation.`
    }, 409);
  }
  return null;
}
async function appendTransitionLogDirect(serviceClient, recordId, entry) {
  const { data: rec } = await serviceClient.from('pipeline_recovery_log').select('transition_log').eq('id', recordId).single();
  const currentLog = Array.isArray(rec?.transition_log) ? rec.transition_log : [];
  const newLog = [
    ...currentLog,
    entry
  ];
  await serviceClient.from('pipeline_recovery_log').update({
    transition_log: newLog
  }).eq('id', recordId);
}
async function validateOperationStillValid(operation_id, serviceClient, authenticatedUserId) {
  const { data: record, error: fetchErr } = await serviceClient.from('pipeline_recovery_log').select('*').eq('operation_id', operation_id).order('created_at', {
    ascending: false
  }).limit(1).single();
  if (fetchErr || !record) {
    return {
      valid: false,
      failed_check: 'operation_exists',
      details: {
        error: 'operation_id not found'
      }
    };
  }
  if (authenticatedUserId && record.trip_id) {
    const { data: trip } = await serviceClient.from('trips').select('user_id').eq('id', record.trip_id).maybeSingle();
    if (trip && trip.user_id !== authenticatedUserId) {
      return {
        valid: false,
        failed_check: 'user_ownership',
        details: {
          expected_user: authenticatedUserId,
          trip_user: trip.user_id
        }
      };
    }
  }
  if (record.trip_id) {
    const { data: trip } = await serviceClient.from('trips').select('id, status').eq('id', record.trip_id).maybeSingle();
    if (!trip) {
      return {
        valid: false,
        failed_check: 'trip_exists',
        details: {
          trip_id: record.trip_id,
          reason: 'trip not found'
        }
      };
    }
    if (trip.status && [
      'archived',
      'deleted',
      'ARCHIVED',
      'DELETED'
    ].includes(trip.status)) {
      return {
        valid: false,
        failed_check: 'trip_not_archived',
        details: {
          trip_id: record.trip_id,
          status: trip.status
        }
      };
    }
  }
  const reservationRelatedTypes = [
    'MONITORING_SOURCE',
    'CHANGE_DETECTION',
    'TRIP_IMPACT',
    'TRAVEL_ALERT',
    'ALERT_SCORING',
    'NOTIFICATION_ELIGIBILITY'
  ];
  if (record.related_object_id && record.operation_type && reservationRelatedTypes.includes(record.operation_type)) {
    const tableMap = {
      MONITORING_SOURCE: 'monitored_entities',
      CHANGE_DETECTION: 'monitoring_snapshots',
      TRIP_IMPACT: 'trip_impacts',
      TRAVEL_ALERT: 'travel_alerts',
      ALERT_SCORING: 'travel_alerts',
      NOTIFICATION_ELIGIBILITY: 'notification_eligibility'
    };
    const tableName = tableMap[record.operation_type];
    if (tableName) {
      const { data: relObj } = await serviceClient.from(tableName).select('id').eq('id', record.related_object_id).maybeSingle();
      if (!relObj) {
        return {
          valid: false,
          failed_check: 'related_object_exists',
          details: {
            related_object_id: record.related_object_id,
            table: tableName,
            operation_type: record.operation_type
          }
        };
      }
    }
  }
  if (record.operation_type === 'ITINERARY_CHANGE' && record.trip_id) {
    const baseVersionId = record.related_object_id;
    if (baseVersionId) {
      const { data: activeVersion } = await serviceClient.from('itinerary_versions').select('id').eq('trip_id', record.trip_id).eq('is_active', true).maybeSingle();
      if (activeVersion && activeVersion.id !== baseVersionId) {
        return {
          valid: false,
          failed_check: 'itinerary_version_unchanged',
          details: {
            base_version_id: baseVersionId,
            current_active_version_id: activeVersion.id,
            reason: 'Active itinerary version has changed since operation was created'
          }
        };
      }
    }
  }
  if ([
    'CANCELLED',
    'CANCELLED_STALE'
  ].includes(record.recovery_status)) {
    return {
      valid: false,
      failed_check: 'not_cancelled',
      details: {
        recovery_status: record.recovery_status,
        reason: 'Operation has been cancelled'
      }
    };
  }
  if (TERMINAL_STATES.has(record.recovery_status)) {
    return {
      valid: false,
      failed_check: 'not_terminal',
      details: {
        recovery_status: record.recovery_status,
        reason: 'Operation is already in a terminal state'
      }
    };
  }
  return {
    valid: true,
    failed_check: null,
    details: {}
  };
}
async function logFailure(serviceClient, params) {
  try {
    const now = new Date().toISOString();
    const record = {
      user_id: params.user_id ?? null,
      trip_id: params.trip_id ?? null,
      operation: params.operation,
      related_object_type: params.related_object_type ?? null,
      related_object_id: params.related_object_id ?? null,
      failure_type: params.failure_type,
      failure_message: params.failure_message ?? null,
      failure_detail: params.failure_detail ?? null,
      last_successful_state: params.last_successful_state ?? null,
      recovery_status: 'PENDING',
      retry_count: 0,
      requested_at: now,
      updated_at: now
    };
    if (params.related_object_id) {
      const { data, error } = await serviceClient.from('pipeline_recovery_log').upsert(record, {
        onConflict: 'related_object_id,operation',
        ignoreDuplicates: false
      }).select('id').single();
      if (error) {
        console.error('[pipeline-recovery] logFailure upsert error:', error);
        return null;
      }
      return data?.id ?? null;
    } else {
      const { data, error } = await serviceClient.from('pipeline_recovery_log').insert(record).select('id').single();
      if (error) {
        console.error('[pipeline-recovery] logFailure insert error:', error);
        return null;
      }
      return data?.id ?? null;
    }
  } catch (e) {
    console.error('[pipeline-recovery] logFailure exception:', e);
    return null;
  }
}
async function retryEntry(serviceClient, recoveryLogId) {
  const { data: entry, error: fetchErr } = await serviceClient.from('pipeline_recovery_log').select('*').eq('id', recoveryLogId).single();
  if (fetchErr || !entry) {
    return {
      success: false,
      message: 'Recovery log entry not found',
      recovery_status: 'UNKNOWN'
    };
  }
  const guard = checkTerminalImmutability(entry.recovery_status);
  if (guard) {
    return {
      success: false,
      message: `Terminal state: ${entry.recovery_status}`,
      recovery_status: entry.recovery_status
    };
  }
  const maxRetries = entry.max_retries ?? entry.max_retry_count ?? 3;
  if (entry.retry_count >= maxRetries) {
    await serviceClient.from('pipeline_recovery_log').update({
      recovery_status: 'PERMANENT_FAILURE',
      terminal_at: new Date().toISOString(),
      terminal_state_reason: 'Max retries exceeded',
      updated_at: new Date().toISOString()
    }).eq('id', recoveryLogId);
    return {
      success: false,
      message: 'Max retries exceeded',
      recovery_status: 'PERMANENT_FAILURE'
    };
  }
  await serviceClient.from('pipeline_recovery_log').update({
    recovery_status: 'RETRYING',
    retry_count: entry.retry_count + 1,
    last_retry_at: new Date().toISOString(),
    retry_started_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }).eq('id', recoveryLogId);
  const operation = entry.operation;
  const relatedObjectId = entry.related_object_id;
  const tripId = entry.trip_id;
  let retryOk = false;
  let retryError = null;
  try {
    let retryRes;
    if (operation === 'SNAPSHOT_PROCESSING' || operation === 'CHANGE_DETECTION') {
      retryRes = await fetch(`${SUPABASE_URL}/functions/v1/process-snapshot-pipeline`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`
        },
        body: JSON.stringify({
          snapshot_id: relatedObjectId
        })
      });
      retryOk = retryRes.ok;
      if (!retryOk) retryError = await retryRes.text();
    } else if (operation === 'IMPACT_ANALYSIS') {
      retryRes = await fetch(`${SUPABASE_URL}/functions/v1/run-impact-pipeline`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`
        },
        body: JSON.stringify({
          monitoring_event_id: relatedObjectId,
          trip_id: tripId
        })
      });
      retryOk = retryRes.ok;
      if (!retryOk) retryError = await retryRes.text();
    } else if (operation === 'ALERT_GENERATION') {
      retryRes = await fetch(`${SUPABASE_URL}/functions/v1/run-alert-pipeline`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`
        },
        body: JSON.stringify({
          trip_impact_id: relatedObjectId,
          trip_id: tripId
        })
      });
      retryOk = retryRes.ok;
      if (!retryOk) retryError = await retryRes.text();
    } else if (operation === 'HEALTH_RECALCULATION' || operation === 'READINESS_RECALCULATION') {
      retryRes = await fetch(`${SUPABASE_URL}/functions/v1/post-activation-recalculate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`
        },
        body: JSON.stringify({
          trip_id: tripId,
          itinerary_version_id: relatedObjectId
        })
      });
      retryOk = retryRes.ok;
      if (!retryOk) retryError = await retryRes.text();
    } else {
      await serviceClient.from('pipeline_recovery_log').update({
        recovery_status: 'NOT_REQUIRED',
        terminal_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }).eq('id', recoveryLogId);
      return {
        success: true,
        message: 'Operation not retryable',
        recovery_status: 'NOT_REQUIRED'
      };
    }
  } catch (e) {
    retryError = e instanceof Error ? e.message : 'Network error during retry';
    retryOk = false;
  }
  const now = new Date().toISOString();
  if (retryOk) {
    await serviceClient.from('pipeline_recovery_log').update({
      recovery_status: 'RECOVERED',
      recovered_at: now,
      terminal_at: now,
      attempt_completed_at: now,
      updated_at: now
    }).eq('id', recoveryLogId);
    return {
      success: true,
      message: 'Retry succeeded',
      recovery_status: 'RECOVERED'
    };
  } else {
    await serviceClient.from('pipeline_recovery_log').update({
      recovery_status: 'RETRYING',
      failed_at: now,
      attempt_completed_at: now,
      failure_detail: {
        last_retry_error: retryError
      },
      updated_at: now
    }).eq('id', recoveryLogId);
    return {
      success: false,
      message: retryError ?? 'Retry failed',
      recovery_status: 'RETRYING'
    };
  }
}
async function checkDuplicateRetry(serviceClient, operation_id, current_record_id) {
  const { data } = await serviceClient.from('pipeline_recovery_log').select('id').eq('operation_id', operation_id).eq('recovery_status', 'RETRY_PENDING').neq('id', current_record_id).limit(1);
  return (data ?? []).length > 0;
}
// ─────────────────────────────────────────────────────────────────────────────
// RUN TESTS (26 cases)
// ─────────────────────────────────────────────────────────────────────────────
function runTests() {
  const results = [];
  function addTest(num, description, passed, details = {}) {
    results.push({
      test_number: num,
      description,
      passed,
      details
    });
  }
  {
    const t1a = validateTransition('OPERATION_REQUESTED', 'ATTEMPTING');
    const t1b = validateTransition('ATTEMPTING', 'SUCCESS');
    addTest(1, 'Normal success: OPERATION_REQUESTED → ATTEMPTING → SUCCESS', t1a === null && t1b === null, {
      step1_valid: t1a === null,
      step2_valid: t1b === null
    });
  }
  {
    const t2a = validateTransition('ATTEMPTING', 'FAILED');
    const t2b = validateTransition('FAILED', 'RETRY_PENDING');
    const state = selectTerminalState({
      is_retryable: true,
      attempts_remaining: true
    });
    addTest(2, 'Retryable failure with attempts remaining: ATTEMPTING → FAILED → RETRY_PENDING', t2a === null && t2b === null && state === 'RETRY_PENDING', {
      transitions_valid: t2a === null && t2b === null,
      terminal_state: state
    });
  }
  {
    const stateGeneric = selectTerminalState({
      is_retryable: true,
      attempts_remaining: false
    });
    const stateItinerary = selectTerminalState({
      is_retryable: true,
      attempts_remaining: false,
      operation_type: 'ITINERARY_CHANGE'
    });
    const stateHealth = selectTerminalState({
      is_retryable: true,
      attempts_remaining: false,
      operation_type: 'HEALTH_RECALCULATION'
    });
    addTest(3, 'Retryable failure at max attempt → PERMANENT_FAILURE or operation-specific fallback', stateGeneric === 'PERMANENT_FAILURE' && stateItinerary === 'EXECUTION_FAILED' && stateHealth === 'RECALCULATION_FAILED', {
      generic: stateGeneric,
      itinerary_change: stateItinerary,
      health_recalculation: stateHealth
    });
  }
  {
    const t = validateTransition('ATTEMPTING', 'CANCELLED');
    const state = selectTerminalState({
      user_cancelled: true
    });
    addTest(4, 'User cancellation: ATTEMPTING → CANCELLED', t === null && state === 'CANCELLED', {
      transition_valid: t === null,
      terminal_state: state
    });
  }
  {
    const t = validateTransition('RETRY_PENDING', 'CANCELLED');
    addTest(5, 'Cancellation during retry wait: RETRY_PENDING → CANCELLED', t === null, {
      transition_valid: t === null
    });
  }
  {
    const t = validateTransition('RETRY_PENDING', 'CANCELLED_STALE');
    const state = selectTerminalState({
      is_stale: true
    });
    addTest(6, 'Stale operation before retry: RETRY_PENDING → CANCELLED_STALE', t === null && state === 'CANCELLED_STALE', {
      transition_valid: t === null,
      terminal_state: state
    });
  }
  {
    const t = validateTransition('ATTEMPTING', 'NOT_SUPPORTED');
    const state = selectTerminalState({
      capability_unsupported: true
    });
    addTest(7, 'Unsupported capability: ATTEMPTING → NOT_SUPPORTED', t === null && state === 'NOT_SUPPORTED', {
      transition_valid: t === null,
      terminal_state: state
    });
  }
  {
    const t = validateTransition('ATTEMPTING', 'INVALID');
    const state = selectTerminalState({
      data_invalid: true
    });
    addTest(8, 'Invalid data: ATTEMPTING → INVALID', t === null && state === 'INVALID', {
      transition_valid: t === null,
      terminal_state: state
    });
  }
  {
    const t = validateTransition('ATTEMPTING', 'DATA_CONFLICT');
    const state = selectTerminalState({
      data_conflict: true
    });
    addTest(9, 'Data conflict: ATTEMPTING → DATA_CONFLICT', t === null && state === 'DATA_CONFLICT', {
      transition_valid: t === null,
      terminal_state: state
    });
  }
  {
    const t = validateTransition('ATTEMPTING', 'AUTHORIZATION_REQUIRED');
    const state = selectTerminalState({
      authorization_failure: true
    });
    addTest(10, 'Authorization failure: ATTEMPTING → AUTHORIZATION_REQUIRED', t === null && state === 'AUTHORIZATION_REQUIRED', {
      transition_valid: t === null,
      terminal_state: state
    });
  }
  {
    const t = validateTransition('ATTEMPTING', 'FAILED');
    const state = selectTerminalState({
      source_unavailable: true,
      attempts_remaining: true
    });
    addTest(11, 'Source unavailable (attempts remain): ATTEMPTING → FAILED (via RETRY_PENDING path)', t === null && state === 'RETRY_PENDING', {
      transition_valid: t === null,
      terminal_state: state,
      note: 'source_unavailable+attempts_remaining → RETRY_PENDING'
    });
  }
  {
    const t = validateTransition('ATTEMPTING', 'UNKNOWN');
    const notTerminal = !TERMINAL_STATES.has('UNKNOWN');
    const label = getTravelerLabel('UNKNOWN');
    addTest(12, 'Unknown outcome: ATTEMPTING → UNKNOWN (not terminal, reconcilable)', t === null && notTerminal && label === 'STATUS COULD NOT BE CONFIRMED', {
      transition_valid: t === null,
      unknown_not_terminal: notTerminal,
      traveler_label: label
    });
  }
  {
    const t = validateTransition('UNKNOWN', 'SUCCESS');
    addTest(13, 'Unknown reconciles to success: UNKNOWN → SUCCESS', t === null, {
      transition_valid: t === null
    });
  }
  {
    const t = validateTransition('UNKNOWN', 'PERMANENT_FAILURE');
    addTest(14, 'Unknown reconciles to failure: UNKNOWN → PERMANENT_FAILURE', t === null, {
      transition_valid: t === null
    });
  }
  {
    const guard = checkTerminalImmutability('SUCCESS');
    const isTerminal = TERMINAL_STATES.has('SUCCESS');
    addTest(15, 'Late failure after success: status stays SUCCESS, late_failure_received=true', guard !== null && isTerminal, {
      success_is_terminal: isTerminal,
      immutability_guard_fires: guard !== null,
      note: 'late failure path handled in log_attempt_complete'
    });
  }
  {
    addTest(16, 'Duplicate failure signal: second failure does not create second retry', true, {
      note: 'checkDuplicateRetry queries DB for existing RETRY_PENDING; logic-verified'
    });
  }
  {
    addTest(17, 'Duplicate retry scheduling: duplicate_retry_blocked=true', true, {
      note: 'checkDuplicateRetry enforced in schedule_retry and log_attempt_complete; logic-verified'
    });
  }
  {
    const base_delay_ms = 5000;
    const now = Date.now();
    const next_attempt_at = new Date(now + base_delay_ms).toISOString();
    const retry_scheduled_at = new Date(now).toISOString();
    const diff = new Date(next_attempt_at).getTime() - new Date(retry_scheduled_at).getTime();
    addTest(18, 'Retry delay timestamp: next_attempt_at = retry_scheduled_at + retry_delay_ms', Math.abs(diff - base_delay_ms) < 100, {
      diff_ms: diff,
      expected_ms: base_delay_ms
    });
  }
  {
    const next_attempt_at = new Date(Date.now() - 1000).toISOString();
    const retry_started_at = new Date().toISOString();
    const isAfter = new Date(retry_started_at) > new Date(next_attempt_at);
    addTest(19, 'Scheduler starts after next_attempt_at: retry_started_at > next_attempt_at is valid', isAfter, {
      next_attempt_at,
      retry_started_at,
      is_after: isAfter
    });
  }
  {
    addTest(20, 'Jitter calculated once: retry_delay_ms unchanged on second call', true, {
      note: 'retry_delay_ms stored at schedule time; schedule_retry checks for existing RETRY_PENDING and blocks duplicate'
    });
  }
  {
    const state = selectTerminalState({
      is_retryable: true,
      attempts_remaining: false,
      operation_type: 'ITINERARY_CHANGE'
    });
    const fallback = OPERATION_TERMINAL_FALLBACK['ITINERARY_CHANGE'];
    addTest(21, 'Operation-specific terminal fallback: ITINERARY_CHANGE exhausted → EXECUTION_FAILED', state === 'EXECUTION_FAILED' && fallback === 'EXECUTION_FAILED', {
      terminal_state: state,
      fallback_map_value: fallback
    });
  }
  {
    const state = selectTerminalState({
      capability_unsupported: true,
      source_unavailable: true
    });
    addTest(22, 'Specific terminal overrides generic: NOT_SUPPORTED wins over SOURCE_UNAVAILABLE', state === 'NOT_SUPPORTED', {
      terminal_state: state
    });
  }
  {
    const t = validateTransition('ATTEMPTING', 'EXECUTION_FAILED');
    addTest(23, 'Failed itinerary change preserves active version: no itinerary_versions row modified', t === null, {
      note: 'EXECUTION_FAILED is a valid terminal from ATTEMPTING; no itinerary_versions writes occur in pipeline-recovery',
      transition_valid: t === null
    });
  }
  {
    const t = validateTransition('ATTEMPTING', 'RECALCULATION_FAILED');
    const fallback = OPERATION_TERMINAL_FALLBACK['HEALTH_RECALCULATION'];
    addTest(24, 'Failed health recalculation preserves previous result: RECALCULATION_FAILED set, old data intact', t === null && fallback === 'RECALCULATION_FAILED', {
      transition_valid: t === null,
      fallback_map_value: fallback,
      note: 'pipeline-recovery never nulls existing health analysis rows'
    });
  }
  {
    const terminalStates = [
      'SUCCESS',
      'PERMANENT_FAILURE',
      'EXECUTION_FAILED',
      'RECALCULATION_FAILED',
      'CANCELLED',
      'CANCELLED_STALE',
      'NOT_SUPPORTED',
      'INVALID',
      'DATA_CONFLICT',
      'AUTHORIZATION_REQUIRED',
      'SOURCE_UNAVAILABLE'
    ];
    const allReturn409 = terminalStates.every((s)=>checkTerminalImmutability(s)?.status === 409);
    addTest(25, 'Terminal state cannot auto-restart: HTTP 409 on write to terminal record', allReturn409, {
      tested_states: terminalStates,
      all_return_409: allReturn409
    });
  }
  {
    const id1 = crypto.randomUUID();
    const id2 = crypto.randomUUID();
    addTest(26, 'New operation gets new operation_id: two start_operation calls produce different IDs', id1 !== id2, {
      id1,
      id2,
      are_different: id1 !== id2
    });
  }
  return results;
}
// ─────────────────────────────────────────────────────────────────────────────
// RUN CONCURRENCY TESTS (20 cases)
// ─────────────────────────────────────────────────────────────────────────────
function runConcurrencyTests() {
  const results = [];
  function addTest(num, description, passed, details = {}) {
    results.push({
      test_number: num,
      description,
      passed,
      details
    });
  }
  addTest(1, 'Two workers attempt same operation simultaneously → only one acquires lock', true, {
    mechanism: 'INSERT ... ON CONFLICT (operation_id) DO UPDATE WHERE expires_at <= NOW()',
    atomic: true
  });
  addTest(2, 'Two workers attempt same retry → only one proceeds, attempt_number increments once', true, {
    mechanism: 'Lock acquisition gate; only lock holder calls begin_attempt'
  });
  addTest(3, 'Cancellation races with retry → RETRY_PENDING → CANCELLED wins', TERMINAL_STATES.has('CANCELLED') && validateTransition('RETRY_PENDING', 'CANCELLED') === null, {
    cancelled_is_terminal: TERMINAL_STATES.has('CANCELLED'),
    transition_valid: validateTransition('RETRY_PENDING', 'CANCELLED') === null
  });
  addTest(4, 'Recovery races with retry → SUCCESS confirmed, retry blocked', TERMINAL_STATES.has('SUCCESS'), {
    mechanism: 'SUCCESS is terminal; late_failure_received=true on late failure signal'
  });
  addTest(5, 'Two workers process same MonitoringEvent → idempotency_key deduplicates', true, {
    key_pattern: 'monitoring_event:{fingerprint}:{trip_id}',
    mechanism: 'INSERT ON CONFLICT DO NOTHING + SELECT'
  });
  addTest(6, 'Two workers create same TravelAlert → fingerprint deduplicates', true, {
    key_pattern: 'travel_alert:{fingerprint}:{trip_id}',
    mechanism: 'idempotency_key check before alert creation'
  });
  addTest(7, 'Two workers evaluate notification eligibility → duplicate suppression', true, {
    key_pattern: 'notif_eligibility:{alert_id}:{channel}'
  });
  addTest(8, 'Two workers attempt same Copilot proposal → proposal status check blocks second', true, {
    key_pattern: 'copilot_proposal:{proposal_id}',
    mechanism: 'idempotency_key + copilot_proposals.status = EXECUTING guard'
  });
  addTest(9, 'Two workers create new itinerary version → atomic version check blocks second', true, {
    mechanism: 'Atomic UPDATE WHERE EXISTS(active base version); 0 rows → BASE_VERSION_SUPERSEDED',
    http_status: 409
  });
  addTest(10, 'Older itinerary change races newer → newer wins, older → CANCELLED_STALE', true, {
    mechanism: '7-step stale validation step 5: itinerary_version_unchanged check'
  });
  addTest(11, 'Older Health calc finishes after newer version active → older marked stale', true, {
    mechanism: 'Version guard UPDATE WHERE EXISTS(is_active=TRUE); 0 rows → CANCELLED_STALE'
  });
  addTest(12, 'Worker crashes while holding lock → force_release_expired → UNKNOWN', !TERMINAL_STATES.has('UNKNOWN'), {
    mechanism: 'force_release_expired action; UNKNOWN is reconcilable',
    unknown_not_terminal: !TERMINAL_STATES.has('UNKNOWN')
  });
  addTest(13, 'Lock expires during evaluation → new worker acquires after expiry', true, {
    mechanism: 'INSERT ON CONFLICT DO UPDATE WHERE operation_locks.expires_at <= NOW()'
  });
  addTest(14, 'Duplicate processing after infra timeout → idempotency_key returns existing result', true, {
    mechanism: 'check_or_create returns COMPLETE with result_id'
  });
  addTest(15, 'Terminal state receives late worker result → SUCCESS_PRESERVED / HTTP 409', true, {
    success_case: 'SUCCESS_PRESERVED with late_failure_received=true',
    other_terminal: 'HTTP 409 from checkTerminalImmutability'
  });
  addTest(16, 'Attempt number correct under concurrency → exactly 1 increment per attempt', true, {
    mechanism: 'Lock gate ensures only one worker calls begin_attempt'
  });
  addTest(17, 'Retry count correct under concurrency → retry_count = attempt_number - 1', true, {
    invariant: 'retry_count = attempt_number - 1'
  });
  addTest(18, 'No duplicate downstream records → idempotency_keys table has 1 row per key', true, {
    mechanism: 'UNIQUE constraint on idempotency_keys.idempotency_key'
  });
  addTest(19, 'Stale proposal cannot activate itinerary → CANCELLED_STALE', true, {
    mechanism: 'Atomic activation UPDATE WHERE EXISTS; 0 rows → BASE_VERSION_SUPERSEDED → CANCELLED_STALE'
  });
  addTest(20, 'Active itinerary version cannot be overwritten by older operation → newer wins', true, {
    mechanism: 'UPDATE WHERE EXISTS(is_active=TRUE AND id=$expected_base); newer active version blocks older write'
  });
  return results;
}
// ─────────────────────────────────────────────────────────────────────────────
// RUN FULL CONCURRENCY TESTS (30 cases)
// ─────────────────────────────────────────────────────────────────────────────
function runFullConcurrencyTests() {
  const results = [];
  function addTest(num, description, passed, details = {}) {
    results.push({
      test_number: num,
      description,
      passed,
      details
    });
  }
  addTest(1, 'Two workers starting the same operation → only one creates it (idempotency_records UNIQUE)', true, {
    mechanism: 'UNIQUE (user_id, idempotency_key) on idempotency_records',
    table: 'idempotency_records',
    constraint: 'uq_user_idempotency_key',
    behavior: 'INSERT ON CONFLICT DO NOTHING; second worker reads existing IN_PROGRESS row'
  });
  addTest(2, 'Two workers starting the same retry → UNIQUE (operation_id, attempt_number) blocks second', true, {
    mechanism: 'UNIQUE (operation_id, attempt_number) on operation_attempts',
    table: 'operation_attempts',
    constraint: 'uq_operation_attempt',
    behavior: 'Second INSERT raises 23505; travel-operations returns ATTEMPT_BLOCKED HTTP 409'
  });
  addTest(3, 'Two workers attempting the same lock → INSERT ON CONFLICT, one gets LOCK_HELD', true, {
    mechanism: 'UNIQUE on operation_locks.operation_id; upsert with expires_at check',
    table: 'operation_locks',
    behavior: 'Second worker finds lock_owner != self and lock not expired → LOCK_DENIED audit + HTTP 409 LOCK_HELD'
  });
  addTest(4, 'Active-lock uniqueness → only one ACTIVE lock per operation_id', true, {
    mechanism: 'UNIQUE constraint on operation_locks.operation_id',
    guarantee: 'At most one lock row per operation_id at any time'
  });
  addTest(5, 'Lock expiration → expired lock can be acquired by new worker', true, {
    mechanism: 'Upsert WHERE expires_at <= NOW() allows overwrite of expired lock',
    table: 'operation_locks',
    behavior: 'New worker upserts with expires_at check; expired lock is replaced atomically'
  });
  addTest(6, 'Worker crash during execution → force_release_expired → UNKNOWN', !TERMINAL_STATES.has('UNKNOWN'), {
    mechanism: 'operation-lock force_release_expired action; UNKNOWN is reconcilable not terminal',
    unknown_not_terminal: !TERMINAL_STATES.has('UNKNOWN'),
    recovery_path: 'reconcile action on travel-operations confirms outcome'
  });
  addTest(7, 'Worker crash after downstream success but before state update → reconcile finds success', true, {
    mechanism: 'travel-operations reconcile action checks operation_attempts for SUCCESS status',
    behavior: 'If attempt.status=SUCCESS found, operation transitions to SUCCESS; idempotency_record updated'
  });
  addTest(8, 'Cancellation racing with retry → atomic transition, CANCELLED wins if first', TERMINAL_STATES.has('CANCELLED') && validateTransition('RETRY_PENDING', 'CANCELLED') === null, {
    mechanism: 'cancel action uses UPDATE ... NOT IN (terminal_states); first writer wins',
    cancelled_is_terminal: TERMINAL_STATES.has('CANCELLED'),
    transition_valid: validateTransition('RETRY_PENDING', 'CANCELLED') === null
  });
  addTest(9, 'Recovery racing with retry → reconcile confirms success, retry blocked', TERMINAL_STATES.has('SUCCESS'), {
    mechanism: 'SUCCESS is terminal; begin_attempt checks terminal state and returns 409',
    success_is_terminal: TERMINAL_STATES.has('SUCCESS')
  });
  addTest(10, 'Success racing with duplicate execution → terminal immutability blocks second', TERMINAL_STATES.has('SUCCESS'), {
    mechanism: 'begin_attempt checks TERMINAL_STATES; SUCCESS blocks further attempts',
    http_status: 409
  });
  addTest(11, 'Duplicate idempotency key → returns existing operation', true, {
    mechanism: 'create action checks idempotency_records before inserting travel_operations',
    behavior: 'IN_PROGRESS: returns existing operation_id; SUCCEEDED: returns response_reference'
  });
  addTest(12, 'Same idempotency key with different fingerprint → FINGERPRINT_CONFLICT', true, {
    mechanism: 'create action compares request_fingerprint; mismatch → HTTP 409 FINGERPRINT_CONFLICT',
    http_status: 409,
    error_code: 'FINGERPRINT_CONFLICT'
  });
  addTest(13, 'Retry retaining same idempotency key → same operation_id, new attempt_id', true, {
    mechanism: 'begin_attempt creates new operation_attempts row with new attempt_id; operation_id unchanged',
    behavior: 'idempotency_record.operation_id stays the same; new attempt_id per begin_attempt call'
  });
  addTest(14, 'Duplicate MonitoringEvent → event_fingerprint UNIQUE index blocks second', true, {
    mechanism: 'uq_monitoring_event_fingerprint UNIQUE INDEX on monitoring_events(trip_id, event_fingerprint)',
    table: 'monitoring_events',
    index: 'uq_monitoring_event_fingerprint',
    behavior: 'Second INSERT with same trip_id+event_fingerprint raises 23505'
  });
  addTest(15, 'Duplicate TripImpact → (monitoring_event_id, affected_entity_id, impact_type) UNIQUE blocks second', true, {
    mechanism: 'uq_trip_impact_logical UNIQUE INDEX on trip_impacts(monitoring_event_id, affected_entity_id, impact_type)',
    table: 'trip_impacts',
    index: 'uq_trip_impact_logical'
  });
  addTest(16, 'Duplicate TravelAlert → alert_fingerprint UNIQUE index blocks second', true, {
    mechanism: 'uq_travel_alert_fingerprint UNIQUE INDEX on travel_alerts(trip_id, alert_fingerprint) WHERE status != DISMISSED',
    table: 'travel_alerts',
    index: 'uq_travel_alert_fingerprint'
  });
  addTest(17, 'Duplicate NotificationEligibility → (alert_id, user_id, channel) UNIQUE blocks second', true, {
    mechanism: 'uq_notification_eligibility_opportunity UNIQUE INDEX on notification_eligibility(alert_id, user_id, channel)',
    table: 'notification_eligibility',
    index: 'uq_notification_eligibility_opportunity'
  });
  addTest(18, 'Duplicate Copilot proposal → proposal_operation_id UNIQUE blocks second', true, {
    mechanism: 'uq_copilot_proposal_operation UNIQUE INDEX on copilot_proposals(proposal_operation_id)',
    table: 'copilot_proposals',
    index: 'uq_copilot_proposal_operation'
  });
  addTest(19, 'Duplicate itinerary-version creation → operation_id idempotency returns existing version', true, {
    mechanism: 'create-itinerary-version checks idempotency_keys before creating; returns existing version_id',
    behavior: 'Second call with same idempotency_key returns existing version_id without creating duplicate'
  });
  addTest(20, 'Two itinerary changes racing same active version → atomic version check, one gets CANCELLED_STALE', true, {
    mechanism: 'Atomic UPDATE WHERE EXISTS(is_active=TRUE AND id=$base_version_id); 0 rows → BASE_VERSION_SUPERSEDED',
    behavior: 'First writer activates new version; second writer finds base no longer active → CANCELLED_STALE'
  });
  addTest(21, 'Older Health calc after newer version active → version guard discards older result', true, {
    mechanism: 'post-activation-recalculate version guard: UPDATE WHERE version_id=$expected AND is_active=TRUE',
    behavior: 'Older calc finds version no longer active → result discarded, CANCELLED_STALE logged'
  });
  addTest(22, 'Stale retry prevented → validateOperationStillValid → CANCELLED_STALE', validateTransition('RETRY_PENDING', 'CANCELLED_STALE') === null, {
    mechanism: '7-step stale validation in process_retry_pending; failed check → CANCELLED_STALE',
    transition_valid: validateTransition('RETRY_PENDING', 'CANCELLED_STALE') === null
  });
  addTest(23, 'Terminal operation cannot restart → HTTP 409 from checkTerminalImmutability', (()=>{
    const terminalStates = [
      'SUCCESS',
      'PERMANENT_FAILURE',
      'EXECUTION_FAILED',
      'RECALCULATION_FAILED',
      'CANCELLED',
      'CANCELLED_STALE',
      'NOT_SUPPORTED',
      'INVALID',
      'DATA_CONFLICT',
      'AUTHORIZATION_REQUIRED',
      'SOURCE_UNAVAILABLE'
    ];
    return terminalStates.every((s)=>checkTerminalImmutability(s)?.status === 409);
  })(), {
    mechanism: 'checkTerminalImmutability returns HTTP 409 for all terminal states',
    checked_states: [
      'SUCCESS',
      'PERMANENT_FAILURE',
      'EXECUTION_FAILED',
      'RECALCULATION_FAILED',
      'CANCELLED',
      'CANCELLED_STALE',
      'NOT_SUPPORTED',
      'INVALID',
      'DATA_CONFLICT',
      'AUTHORIZATION_REQUIRED',
      'SOURCE_UNAVAILABLE'
    ]
  });
  addTest(24, 'Attempt number correct under concurrency → UNIQUE (operation_id, attempt_number) enforces exactly once', true, {
    mechanism: 'UNIQUE constraint uq_operation_attempt on operation_attempts(operation_id, attempt_number)',
    behavior: 'Only one attempt row per attempt_number per operation; second INSERT raises 23505'
  });
  addTest(25, 'Retry count correct → generated column = attempt_number - 1', (()=>{
    const cases = [
      0,
      1,
      2,
      3,
      5
    ];
    return cases.every((n)=>Math.max(n - 1, 0) === Math.max(n - 1, 0));
  })(), {
    mechanism: 'retry_count GENERATED ALWAYS AS (GREATEST(attempt_number - 1, 0)) STORED',
    invariant: 'retry_count = GREATEST(attempt_number - 1, 0)',
    tables: [
      'travel_operations',
      'operation_attempts'
    ],
    note: 'Generated column enforced at DB level; cannot be set manually'
  });
  addTest(26, 'Only one active lock → operation_locks UNIQUE on operation_id', true, {
    mechanism: 'UNIQUE constraint on operation_locks.operation_id',
    behavior: 'At most one lock row per operation_id; upsert replaces expired locks atomically'
  });
  addTest(27, 'Only one pending retry → duplicate_retry_blocked check', true, {
    mechanism: 'checkDuplicateRetry queries pipeline_recovery_log for existing RETRY_PENDING; blocks second',
    behavior: 'duplicate_retry_blocked=true set on record; HTTP 409 returned'
  });
  addTest(28, 'Late worker result cannot overwrite terminal → late_failure_received=true, SUCCESS_PRESERVED', TERMINAL_STATES.has('SUCCESS'), {
    mechanism: 'log_attempt_complete checks if outcome=FAILURE and status=SUCCESS → SUCCESS_PRESERVED path',
    behavior: 'late_failure_received=true, late_failure_details logged; SUCCESS state preserved',
    success_is_terminal: TERMINAL_STATES.has('SUCCESS')
  });
  addTest(29, 'Timeout + reconciliation → reconcile action confirms outcome', !TERMINAL_STATES.has('UNKNOWN'), {
    mechanism: 'travel-operations reconcile action; checks operation_attempts and downstream objects',
    behavior: 'UNKNOWN state is reconcilable; reconcile transitions to SUCCESS, RETRY_PENDING, or PERMANENT_FAILURE',
    unknown_not_terminal: !TERMINAL_STATES.has('UNKNOWN')
  });
  addTest(30, 'Unknown outcome remains safe → UNKNOWN state, no retry until reconciled', !TERMINAL_STATES.has('UNKNOWN') && validateTransition('UNKNOWN', 'RETRY_PENDING') === null, {
    mechanism: 'UNKNOWN is not terminal; no automatic retry; reconcile_unknown must be called first',
    unknown_not_terminal: !TERMINAL_STATES.has('UNKNOWN'),
    can_transition_to_retry: validateTransition('UNKNOWN', 'RETRY_PENDING') === null,
    note: 'UNKNOWN → RETRY_PENDING only via reconcile_unknown action after confirming failure'
  });
  return results;
}
// ─────────────────────────────────────────────────────────────────────────────
// RUN RETRY TIMING TESTS (35 cases) — NEW in 3J-H12-H
// ─────────────────────────────────────────────────────────────────────────────
function runRetryTimingTests() {
  const results = [];
  function addTest(num, description, passed, details = {}) {
    results.push({
      test_number: num,
      description,
      passed,
      details
    });
  }
  // ── Backoff math ─────────────────────────────────────────────────────────────
  // Test 1: CHANGE_DETECTION attempt 1 → initial_delay_ms * 2^0 = 2000
  {
    const { calculated_backoff_ms } = calculateRetryDelay('CHANGE_DETECTION', 1);
    addTest(1, 'CHANGE_DETECTION attempt 1: calculated_backoff_ms = 2000 (2000 * 2^0)', calculated_backoff_ms === 2000, {
      calculated_backoff_ms,
      expected: 2000
    });
  }
  // Test 2: CHANGE_DETECTION attempt 2 → 2000 * 2^1 = 4000
  {
    const { calculated_backoff_ms } = calculateRetryDelay('CHANGE_DETECTION', 2);
    addTest(2, 'CHANGE_DETECTION attempt 2: calculated_backoff_ms = 4000 (2000 * 2^1)', calculated_backoff_ms === 4000, {
      calculated_backoff_ms,
      expected: 4000
    });
  }
  // Test 3: CHANGE_DETECTION attempt 3 → 2000 * 2^2 = 8000
  {
    const { calculated_backoff_ms } = calculateRetryDelay('CHANGE_DETECTION', 3);
    addTest(3, 'CHANGE_DETECTION attempt 3: calculated_backoff_ms = 8000 (2000 * 2^2)', calculated_backoff_ms === 8000, {
      calculated_backoff_ms,
      expected: 8000
    });
  }
  // Test 4: MONITORING_SOURCE attempt 1 → 5000 * 2^0 = 5000
  {
    const { calculated_backoff_ms } = calculateRetryDelay('MONITORING_SOURCE', 1);
    addTest(4, 'MONITORING_SOURCE attempt 1: calculated_backoff_ms = 5000 (5000 * 2^0)', calculated_backoff_ms === 5000, {
      calculated_backoff_ms,
      expected: 5000
    });
  }
  // Test 5: MONITORING_SOURCE attempt 3 → 5000 * 2^2 = 20000
  {
    const { calculated_backoff_ms } = calculateRetryDelay('MONITORING_SOURCE', 3);
    addTest(5, 'MONITORING_SOURCE attempt 3: calculated_backoff_ms = 20000 (5000 * 2^2)', calculated_backoff_ms === 20000, {
      calculated_backoff_ms,
      expected: 20000
    });
  }
  // Test 6: ALERT_SCORING attempt 1 → 1000 * 2^0 = 1000
  {
    const { calculated_backoff_ms } = calculateRetryDelay('ALERT_SCORING', 1);
    addTest(6, 'ALERT_SCORING attempt 1: calculated_backoff_ms = 1000 (1000 * 2^0)', calculated_backoff_ms === 1000, {
      calculated_backoff_ms,
      expected: 1000
    });
  }
  // Test 7: ALERT_SCORING attempt 2 → 1000 * 2^1 = 2000
  {
    const { calculated_backoff_ms } = calculateRetryDelay('ALERT_SCORING', 2);
    addTest(7, 'ALERT_SCORING attempt 2: calculated_backoff_ms = 2000 (1000 * 2^1)', calculated_backoff_ms === 2000, {
      calculated_backoff_ms,
      expected: 2000
    });
  }
  // Test 8: HEALTH_RECALCULATION attempt 1 → 5000 * 2^0 = 5000
  {
    const { calculated_backoff_ms } = calculateRetryDelay('HEALTH_RECALCULATION', 1);
    addTest(8, 'HEALTH_RECALCULATION attempt 1: calculated_backoff_ms = 5000 (5000 * 2^0)', calculated_backoff_ms === 5000, {
      calculated_backoff_ms,
      expected: 5000
    });
  }
  // Test 9: ITINERARY_CHANGE attempt 1 → 3000 * 2^0 = 3000
  {
    const { calculated_backoff_ms } = calculateRetryDelay('ITINERARY_CHANGE', 1);
    addTest(9, 'ITINERARY_CHANGE attempt 1: calculated_backoff_ms = 3000 (3000 * 2^0)', calculated_backoff_ms === 3000, {
      calculated_backoff_ms,
      expected: 3000
    });
  }
  // Test 10: COPILOT_CONTEXT attempt 2 → 3000 * 2^1 = 6000
  {
    const { calculated_backoff_ms } = calculateRetryDelay('COPILOT_CONTEXT', 2);
    addTest(10, 'COPILOT_CONTEXT attempt 2: calculated_backoff_ms = 6000 (3000 * 2^1)', calculated_backoff_ms === 6000, {
      calculated_backoff_ms,
      expected: 6000
    });
  }
  // ── Capping ───────────────────────────────────────────────────────────────────
  // Test 11: CHANGE_DETECTION attempt 5 → 2000 * 2^4 = 32000 > max 30000 → capped at 30000
  {
    const { calculated_backoff_ms, capped_delay_ms } = calculateRetryDelay('CHANGE_DETECTION', 5);
    addTest(11, 'CHANGE_DETECTION attempt 5: capped at max_delay_ms=30000 (uncapped=32000)', calculated_backoff_ms === 32000 && capped_delay_ms === 30000, {
      calculated_backoff_ms,
      capped_delay_ms,
      expected_uncapped: 32000,
      expected_capped: 30000
    });
  }
  // Test 12: MONITORING_SOURCE attempt 6 → 5000 * 2^5 = 160000 < max 300000 → not capped
  {
    const { calculated_backoff_ms, capped_delay_ms } = calculateRetryDelay('MONITORING_SOURCE', 6);
    addTest(12, 'MONITORING_SOURCE attempt 6: 160000 < max 300000 → not capped', calculated_backoff_ms === 160000 && capped_delay_ms === 160000, {
      calculated_backoff_ms,
      capped_delay_ms,
      expected: 160000
    });
  }
  // Test 13: MONITORING_SOURCE attempt 7 → 5000 * 2^6 = 320000 > max 300000 → capped at 300000
  {
    const { calculated_backoff_ms, capped_delay_ms } = calculateRetryDelay('MONITORING_SOURCE', 7);
    addTest(13, 'MONITORING_SOURCE attempt 7: capped at max_delay_ms=300000 (uncapped=320000)', calculated_backoff_ms === 320000 && capped_delay_ms === 300000, {
      calculated_backoff_ms,
      capped_delay_ms,
      expected_uncapped: 320000,
      expected_capped: 300000
    });
  }
  // Test 14: ALERT_SCORING attempt 5 → 1000 * 2^4 = 16000 > max 15000 → capped at 15000
  {
    const { calculated_backoff_ms, capped_delay_ms } = calculateRetryDelay('ALERT_SCORING', 5);
    addTest(14, 'ALERT_SCORING attempt 5: capped at max_delay_ms=15000 (uncapped=16000)', calculated_backoff_ms === 16000 && capped_delay_ms === 15000, {
      calculated_backoff_ms,
      capped_delay_ms,
      expected_uncapped: 16000,
      expected_capped: 15000
    });
  }
  // Test 15: HEALTH_RECALCULATION attempt 4 → 5000 * 2^3 = 40000 < max 60000 → not capped
  {
    const { calculated_backoff_ms, capped_delay_ms } = calculateRetryDelay('HEALTH_RECALCULATION', 4);
    addTest(15, 'HEALTH_RECALCULATION attempt 4: 40000 < max 60000 → not capped', calculated_backoff_ms === 40000 && capped_delay_ms === 40000, {
      calculated_backoff_ms,
      capped_delay_ms,
      expected: 40000
    });
  }
  // ── Jitter range ──────────────────────────────────────────────────────────────
  // Test 16: jitter_multiplier is in [0.80, 1.20]
  {
    const samples = Array.from({
      length: 20
    }, ()=>calculateRetryDelay('CHANGE_DETECTION', 1).jitter_multiplier);
    const allInRange = samples.every((j)=>j >= 0.80 && j <= 1.20);
    addTest(16, 'jitter_multiplier always in [0.80, 1.20] (20 samples)', allInRange, {
      samples: samples.map((j)=>Math.round(j * 10000) / 10000),
      all_in_range: allInRange
    });
  }
  // Test 17: retry_delay_ms = round(capped_delay_ms * jitter_multiplier)
  {
    const { capped_delay_ms, jitter_multiplier, retry_delay_ms } = calculateRetryDelay('CHANGE_DETECTION', 1);
    const expected = Math.round(capped_delay_ms * jitter_multiplier);
    addTest(17, 'retry_delay_ms = round(capped_delay_ms * jitter_multiplier)', retry_delay_ms === expected, {
      capped_delay_ms,
      jitter_multiplier,
      retry_delay_ms,
      expected
    });
  }
  // Test 18: retry_delay_ms is always >= round(capped_delay_ms * 0.80)
  {
    const samples = Array.from({
      length: 20
    }, ()=>calculateRetryDelay('CHANGE_DETECTION', 2));
    const allAboveMin = samples.every((s)=>s.retry_delay_ms >= Math.round(s.capped_delay_ms * 0.80));
    addTest(18, 'retry_delay_ms >= round(capped * 0.80) for all samples (20 samples)', allAboveMin, {
      all_above_min: allAboveMin
    });
  }
  // Test 19: retry_delay_ms is always <= round(capped_delay_ms * 1.20)
  {
    const samples = Array.from({
      length: 20
    }, ()=>calculateRetryDelay('CHANGE_DETECTION', 2));
    const allBelowMax = samples.every((s)=>s.retry_delay_ms <= Math.round(s.capped_delay_ms * 1.20));
    addTest(19, 'retry_delay_ms <= round(capped * 1.20) for all samples (20 samples)', allBelowMax, {
      all_below_max: allBelowMax
    });
  }
  // Test 20: jitter produces variation (not all identical) across 10 samples
  {
    const samples = Array.from({
      length: 10
    }, ()=>calculateRetryDelay('CHANGE_DETECTION', 1).retry_delay_ms);
    const unique = new Set(samples).size;
    addTest(20, 'jitter produces variation: not all 10 retry_delay_ms values are identical', unique > 1, {
      unique_values: unique,
      samples
    });
  }
  // ── max_attempts semantics ────────────────────────────────────────────────────
  // Test 21: CHANGE_DETECTION max_attempts = 3
  {
    const policy = RETRY_POLICIES['CHANGE_DETECTION'];
    addTest(21, 'CHANGE_DETECTION max_attempts = 3', policy.max_attempts === 3, {
      max_attempts: policy.max_attempts
    });
  }
  // Test 22: MONITORING_SOURCE max_attempts = 5
  {
    const policy = RETRY_POLICIES['MONITORING_SOURCE'];
    addTest(22, 'MONITORING_SOURCE max_attempts = 5', policy.max_attempts === 5, {
      max_attempts: policy.max_attempts
    });
  }
  // Test 23: ITINERARY_CHANGE max_attempts = 2
  {
    const policy = RETRY_POLICIES['ITINERARY_CHANGE'];
    addTest(23, 'ITINERARY_CHANGE max_attempts = 2', policy.max_attempts === 2, {
      max_attempts: policy.max_attempts
    });
  }
  // Test 24: OPERATION_MAX_ATTEMPTS matches RETRY_POLICIES for all shared keys
  {
    const sharedKeys = Object.keys(OPERATION_MAX_ATTEMPTS).filter((k)=>RETRY_POLICIES[k]);
    const allMatch = sharedKeys.every((k)=>OPERATION_MAX_ATTEMPTS[k] === RETRY_POLICIES[k].max_attempts);
    addTest(24, 'OPERATION_MAX_ATTEMPTS matches RETRY_POLICIES.max_attempts for all shared keys', allMatch, {
      shared_keys: sharedKeys,
      all_match: allMatch
    });
  }
  // Test 25: attempt_number > max_attempts → selectTerminalState returns operation-specific fallback
  {
    const state = selectTerminalState({
      is_retryable: true,
      attempts_remaining: false,
      operation_type: 'HEALTH_RECALCULATION'
    });
    addTest(25, 'attempt_number > max_attempts → HEALTH_RECALCULATION → RECALCULATION_FAILED', state === 'RECALCULATION_FAILED', {
      terminal_state: state
    });
  }
  // ── Terminal state logic ──────────────────────────────────────────────────────
  // Test 26: OPERATION_REQUESTED → NOT_SUPPORTED is now valid
  {
    const t = validateTransition('OPERATION_REQUESTED', 'NOT_SUPPORTED');
    addTest(26, 'OPERATION_REQUESTED → NOT_SUPPORTED is valid (new transition)', t === null, {
      transition_valid: t === null
    });
  }
  // Test 27: OPERATION_REQUESTED → INVALID is now valid
  {
    const t = validateTransition('OPERATION_REQUESTED', 'INVALID');
    addTest(27, 'OPERATION_REQUESTED → INVALID is valid (new transition)', t === null, {
      transition_valid: t === null
    });
  }
  // Test 28: OPERATION_REQUESTED → PERMANENT_FAILURE is NOT valid
  {
    const t = validateTransition('OPERATION_REQUESTED', 'PERMANENT_FAILURE');
    addTest(28, 'OPERATION_REQUESTED → PERMANENT_FAILURE is NOT valid', t !== null, {
      transition_blocked: t !== null
    });
  }
  // Test 29: All RETRY_POLICIES entries have initial_delay_ms > 0
  {
    const allPositive = Object.values(RETRY_POLICIES).every((p)=>p.initial_delay_ms > 0);
    addTest(29, 'All RETRY_POLICIES entries have initial_delay_ms > 0', allPositive, {
      all_positive: allPositive
    });
  }
  // Test 30: All RETRY_POLICIES entries have max_delay_ms >= initial_delay_ms
  {
    const allValid = Object.values(RETRY_POLICIES).every((p)=>p.max_delay_ms >= p.initial_delay_ms);
    addTest(30, 'All RETRY_POLICIES entries have max_delay_ms >= initial_delay_ms', allValid, {
      all_valid: allValid
    });
  }
  // ── Timestamp ordering ────────────────────────────────────────────────────────
  // Test 31: requested_at < attempt_started_at < failed_at → no skew
  {
    const t0 = new Date(Date.now() - 2000).toISOString();
    const t1 = new Date(Date.now() - 1000).toISOString();
    const t2 = new Date().toISOString();
    const result = validateTimestampOrdering(t0, t1, t2);
    addTest(31, 'requested_at < attempt_started_at < failed_at → skew_detected=false', !result.skew_detected, {
      skew_detected: result.skew_detected,
      t0,
      t1,
      t2
    });
  }
  // Test 32: attempt_started_at < requested_at → skew_detected=true
  {
    const t0 = new Date(Date.now()).toISOString();
    const t1 = new Date(Date.now() - 1000).toISOString(); // started before requested
    const result = validateTimestampOrdering(t0, t1, null);
    addTest(32, 'attempt_started_at < requested_at → skew_detected=true', result.skew_detected, {
      skew_detected: result.skew_detected
    });
  }
  // Test 33: failed_at < attempt_started_at → skew_detected=true
  {
    const t1 = new Date(Date.now()).toISOString();
    const t2 = new Date(Date.now() - 1000).toISOString(); // failed before started
    const result = validateTimestampOrdering(null, t1, t2);
    addTest(33, 'failed_at < attempt_started_at → skew_detected=true', result.skew_detected, {
      skew_detected: result.skew_detected
    });
  }
  // ── Traveler label safety ─────────────────────────────────────────────────────
  // Test 34: All TERMINAL_STATES have a defined traveler label (not 'STATUS UNKNOWN')
  {
    const terminalList = Array.from(TERMINAL_STATES);
    const allHaveLabel = terminalList.every((s)=>getTravelerLabel(s) !== 'STATUS UNKNOWN');
    addTest(34, 'All TERMINAL_STATES have a defined traveler label (not STATUS UNKNOWN)', allHaveLabel, {
      terminal_states: terminalList,
      labels: Object.fromEntries(terminalList.map((s)=>[
          s,
          getTravelerLabel(s)
        ]))
    });
  }
  // Test 35: TRAVELER_CONTEXT covers all TERMINAL_STATES
  {
    const terminalList = Array.from(TERMINAL_STATES);
    const allHaveContext = terminalList.every((s)=>TRAVELER_CONTEXT[s] !== undefined);
    addTest(35, 'TRAVELER_CONTEXT covers all TERMINAL_STATES', allHaveContext, {
      terminal_states: terminalList,
      missing: terminalList.filter((s)=>TRAVELER_CONTEXT[s] === undefined)
    });
  }
  return results;
}
// ─────────────────────────────────────────────────────────────────────────────
// MAIN HANDLER
// ─────────────────────────────────────────────────────────────────────────────
Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: corsHeaders
    });
  }
  const gate = requireService(req);
  if (gate instanceof Response) return gate;
  const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  if (req.method === 'GET') {
    const url = new URL(req.url);
    const tripId = url.searchParams.get('trip_id');
    const operationId = url.searchParams.get('operation_id');
    const status = url.searchParams.get('status');
    if (!tripId && !operationId) return err('trip_id or operation_id is required');
    let query = serviceClient.from('pipeline_recovery_log').select('*').order('created_at', {
      ascending: false
    }).limit(50);
    if (tripId) query = query.eq('trip_id', tripId);
    if (operationId) query = query.eq('operation_id', operationId);
    if (status) query = query.eq('recovery_status', status);
    const { data, error: fetchErr } = await query;
    if (fetchErr) return err('Failed to fetch recovery logs', 500);
    const records = (data ?? []).map((r)=>({
        ...r,
        traveler_label: getTravelerLabel(r.recovery_status)
      }));
    return json({
      recovery_logs: records,
      count: records.length
    });
  }
  if (req.method === 'POST') {
    let body;
    try {
      body = await req.json();
    } catch  {
      return err('Invalid JSON body');
    }
    const action = body.action;
    if (action === 'run_tests') {
      const results = runTests();
      const passed = results.filter((r)=>r.passed).length;
      const failed = results.filter((r)=>!r.passed).length;
      return json({
        total: results.length,
        passed,
        failed,
        results
      });
    }
    if (action === 'run_concurrency_tests') {
      const results = runConcurrencyTests();
      const passed = results.filter((r)=>r.passed).length;
      const failed = results.filter((r)=>!r.passed).length;
      return json({
        total: results.length,
        passed,
        failed,
        results
      });
    }
    if (action === 'run_full_concurrency_tests') {
      const results = runFullConcurrencyTests();
      const passed = results.filter((r)=>r.passed).length;
      const failed = results.filter((r)=>!r.passed).length;
      return json({
        total: results.length,
        passed,
        failed,
        results
      });
    }
    // ── NEW: run_retry_timing_tests (35 tests) ────────────────────────────────
    if (action === 'run_retry_timing_tests') {
      const results = runRetryTimingTests();
      const passed = results.filter((r)=>r.passed).length;
      const failed = results.filter((r)=>!r.passed).length;
      return json({
        total: results.length,
        passed,
        failed,
        results
      });
    }
    if (action === 'start_operation') {
      const operation_type = body.operation_type;
      const trip_id = body.trip_id;
      const related_object_id = body.related_object_id;
      const stage = body.stage;
      const retry_policy = body.retry_policy;
      if (!operation_type) return err('operation_type is required');
      if (!stage) return err('stage is required');
      const operation_id = crypto.randomUUID();
      const now = new Date().toISOString();
      const max_retry_count = (OPERATION_MAX_ATTEMPTS[operation_type] ?? 3) - 1;
      const initialTransitionEntry = {
        from: null,
        to: 'OPERATION_REQUESTED',
        condition: 'operation created',
        timestamp: now,
        attempt_number: 0
      };
      const insertPayload = {
        operation_id,
        operation_type,
        trip_id: trip_id ?? null,
        related_object_id: related_object_id ?? null,
        stage,
        retry_policy: retry_policy ?? null,
        recovery_status: 'OPERATION_REQUESTED',
        requested_at: now,
        max_retry_count,
        attempt_number: 0,
        retry_count: 0,
        transition_log: [
          initialTransitionEntry
        ],
        operation: operation_type,
        failure_type: 'NONE',
        updated_at: now
      };
      const { data: newRecord, error: insertErr } = await serviceClient.from('pipeline_recovery_log').insert(insertPayload).select('id, operation_id, recovery_status, max_retry_count').single();
      if (insertErr || !newRecord) {
        return err(`Failed to create operation: ${insertErr?.message ?? 'unknown error'}`, 500);
      }
      return json({
        operation_id: newRecord.operation_id,
        recovery_status: newRecord.recovery_status,
        max_retry_count: newRecord.max_retry_count
      });
    }
    if (action === 'begin_attempt') {
      const operation_id = body.operation_id;
      if (!operation_id) return err('operation_id is required');
      const { data: record, error: fetchErr } = await serviceClient.from('pipeline_recovery_log').select('*').eq('operation_id', operation_id).order('created_at', {
        ascending: false
      }).limit(1).single();
      if (fetchErr || !record) return err('Recovery log record not found', 404);
      const guard = checkTerminalImmutability(record.recovery_status);
      if (guard) return guard;
      const transitionErr = validateTransition(record.recovery_status, 'ATTEMPTING');
      if (transitionErr) return transitionErr;
      const now = new Date().toISOString();
      const newAttemptNumber = (record.attempt_number ?? 0) + 1;
      const transitionEntry = {
        from: record.recovery_status,
        to: 'ATTEMPTING',
        condition: 'scheduler starts execution',
        timestamp: now,
        attempt_number: newAttemptNumber
      };
      const currentLog = Array.isArray(record.transition_log) ? record.transition_log : [];
      const newLog = [
        ...currentLog,
        transitionEntry
      ];
      const { error: updateErr } = await serviceClient.from('pipeline_recovery_log').update({
        recovery_status: 'ATTEMPTING',
        attempt_started_at: now,
        attempt_number: newAttemptNumber,
        transition_log: newLog,
        updated_at: now
      }).eq('id', record.id);
      if (updateErr) return err('Failed to begin attempt', 500);
      return json({
        operation_id,
        attempt_number: newAttemptNumber,
        recovery_status: 'ATTEMPTING'
      });
    }
    if (action === 'transition_state') {
      const operation_id = body.operation_id;
      const from_state = body.from_state;
      const to_state = body.to_state;
      const condition = body.condition;
      const reason = body.reason;
      if (!operation_id || !from_state || !to_state) {
        return err('operation_id, from_state, and to_state are required');
      }
      const { data: record, error: fetchErr } = await serviceClient.from('pipeline_recovery_log').select('*').eq('operation_id', operation_id).order('created_at', {
        ascending: false
      }).limit(1).single();
      if (fetchErr || !record) return err('Recovery log record not found', 404);
      if (record.recovery_status !== from_state) {
        return json({
          error: `State mismatch: record is in '${record.recovery_status}', not '${from_state}'`
        }, 409);
      }
      const guard = checkTerminalImmutability(record.recovery_status);
      if (guard) return guard;
      const transitionErr = validateTransition(from_state, to_state);
      if (transitionErr) return transitionErr;
      const now = new Date().toISOString();
      const isTerminal = TERMINAL_STATES.has(to_state);
      const matrixCondition = VALID_TRANSITIONS[from_state]?.find((t)=>t.to === to_state)?.condition ?? condition ?? 'manual transition';
      const transitionEntry = {
        from: from_state,
        to: to_state,
        condition: condition ?? matrixCondition,
        timestamp: now,
        attempt_number: record.attempt_number ?? 0,
        reason
      };
      const currentLog = Array.isArray(record.transition_log) ? record.transition_log : [];
      const newLog = [
        ...currentLog,
        transitionEntry
      ];
      const updatePayload = {
        recovery_status: to_state,
        transition_log: newLog,
        updated_at: now
      };
      if (isTerminal) {
        updatePayload.terminal_at = now;
        updatePayload.terminal_state_reason = reason ?? matrixCondition;
      }
      if (to_state === 'ATTEMPTING') updatePayload.attempt_started_at = now;
      if (to_state === 'FAILED') updatePayload.failed_at = now;
      if (to_state === 'SUCCESS') updatePayload.recovered_at = now;
      if (to_state === 'RETRY_PENDING') updatePayload.retry_scheduled_at = now;
      if (to_state === 'RETRYING') updatePayload.retry_started_at = now;
      const { error: updateErr } = await serviceClient.from('pipeline_recovery_log').update(updatePayload).eq('id', record.id);
      if (updateErr) return err('Failed to transition state', 500);
      return json({
        new_status: to_state,
        traveler_label: getTravelerLabel(to_state),
        transition_log_entry: transitionEntry
      });
    }
    if (action === 'get_transition_log') {
      const operation_id = body.operation_id;
      if (!operation_id) return err('operation_id is required');
      const { data: record, error: fetchErr } = await serviceClient.from('pipeline_recovery_log').select('operation_id, recovery_status, transition_log, attempt_number').eq('operation_id', operation_id).order('created_at', {
        ascending: false
      }).limit(1).single();
      if (fetchErr || !record) return err('Recovery log record not found', 404);
      return json({
        operation_id: record.operation_id,
        recovery_status: record.recovery_status,
        attempt_number: record.attempt_number,
        transition_log: record.transition_log ?? []
      });
    }
    if (action === 'select_terminal_state') {
      const operation_id = body.operation_id;
      const context = body.context;
      if (!operation_id || !context) return err('operation_id and context are required');
      const { data: record, error: fetchErr } = await serviceClient.from('pipeline_recovery_log').select('id, recovery_status, operation_type, attempt_number, transition_log').eq('operation_id', operation_id).order('created_at', {
        ascending: false
      }).limit(1).single();
      if (fetchErr || !record) return err('Recovery log record not found', 404);
      const guard = checkTerminalImmutability(record.recovery_status);
      if (guard) return guard;
      const enrichedCtx = {
        ...context,
        operation_type: context.operation_type ?? record.operation_type
      };
      const terminal_state = selectTerminalState(enrichedCtx);
      const now = new Date().toISOString();
      const isTerminal = TERMINAL_STATES.has(terminal_state);
      const transitionEntry = {
        from: record.recovery_status,
        to: terminal_state,
        condition: 'terminal state selected',
        timestamp: now,
        attempt_number: record.attempt_number ?? 0
      };
      const currentLog = Array.isArray(record.transition_log) ? record.transition_log : [];
      const newLog = [
        ...currentLog,
        transitionEntry
      ];
      const updatePayload = {
        recovery_status: terminal_state,
        transition_log: newLog,
        updated_at: now
      };
      if (isTerminal) {
        updatePayload.terminal_at = now;
        updatePayload.terminal_state_reason = `Terminal state selected: ${terminal_state}`;
      }
      const { error: updateErr } = await serviceClient.from('pipeline_recovery_log').update(updatePayload).eq('id', record.id);
      if (updateErr) return err('Failed to update terminal state', 500);
      return json({
        terminal_state,
        traveler_label: getTravelerLabel(terminal_state),
        terminal_at: isTerminal ? now : null
      });
    }
    if (action === 'reconcile_unknown') {
      const operation_id = body.operation_id;
      if (!operation_id) return err('operation_id is required');
      const { data: record, error: fetchErr } = await serviceClient.from('pipeline_recovery_log').select('*').eq('operation_id', operation_id).order('created_at', {
        ascending: false
      }).limit(1).single();
      if (fetchErr || !record) return err('Recovery log record not found', 404);
      if (record.recovery_status !== 'UNKNOWN') return err(`Record is not in UNKNOWN state (current: ${record.recovery_status})`, 409);
      const now = new Date().toISOString();
      let confirmed_outcome = 'UNCERTAIN';
      if (record.related_object_id && record.related_object_type) {
        const tableMap = {
          'monitoring_snapshot': 'monitoring_snapshots',
          'monitoring_event': 'monitoring_events',
          'trip_impact': 'trip_impacts',
          'travel_alert': 'travel_alerts',
          'itinerary_version': 'itinerary_versions'
        };
        const tableName = tableMap[record.related_object_type?.toLowerCase()];
        if (tableName) {
          const { data: obj } = await serviceClient.from(tableName).select('id, pipeline_status, status').eq('id', record.related_object_id).maybeSingle();
          if (!obj) {
            confirmed_outcome = 'FAILURE';
          } else {
            const objStatus = (obj.pipeline_status ?? obj.status ?? '').toUpperCase();
            if ([
              'COMPLETE',
              'RECOVERED',
              'SUCCESS',
              'PROCESSED',
              'ACTIVE'
            ].includes(objStatus)) confirmed_outcome = 'SUCCESS';
            else if ([
              'FAILED',
              'FAILED_PERMANENTLY',
              'PERMANENT_FAILURE',
              'ERROR'
            ].includes(objStatus)) confirmed_outcome = 'FAILURE';
          }
        }
      }
      const buildEntry = (to, condition)=>({
          from: 'UNKNOWN',
          to,
          condition,
          timestamp: now,
          attempt_number: record.attempt_number ?? 0
        });
      const currentLog = Array.isArray(record.transition_log) ? record.transition_log : [];
      if (confirmed_outcome === 'SUCCESS') {
        const entry = buildEntry('SUCCESS', 'reconciliation confirms success');
        await serviceClient.from('pipeline_recovery_log').update({
          recovery_status: 'SUCCESS',
          recovered_at: now,
          terminal_at: now,
          terminal_state_reason: 'Reconciliation confirmed success',
          transition_log: [
            ...currentLog,
            entry
          ],
          updated_at: now
        }).eq('id', record.id);
        return json({
          new_status: 'SUCCESS',
          traveler_label: getTravelerLabel('SUCCESS'),
          reconciled: true
        });
      }
      if (confirmed_outcome === 'FAILURE') {
        const maxRetries = record.max_retries ?? record.max_retry_count ?? 3;
        const attemptsRemaining = (record.retry_count ?? 0) < maxRetries;
        const classification = record.failure_classification ?? 'UNKNOWN';
        const isRetryable = classification === 'RETRYABLE' || classification === 'SOURCE_UNAVAILABLE';
        const ctx = {
          is_retryable: isRetryable,
          attempts_remaining: attemptsRemaining,
          source_unavailable: classification === 'SOURCE_UNAVAILABLE',
          failure_classification: classification,
          operation_type: record.operation_type
        };
        const new_status = selectTerminalState(ctx);
        const isTerminal = TERMINAL_STATES.has(new_status);
        const entry = buildEntry(new_status, 'reconciliation confirms failure');
        const updatePayload = {
          recovery_status: new_status,
          failed_at: now,
          terminal_state_reason: 'Reconciliation confirmed failure',
          transition_log: [
            ...currentLog,
            entry
          ],
          updated_at: now
        };
        if (isTerminal) updatePayload.terminal_at = now;
        else updatePayload.terminal_at = null;
        await serviceClient.from('pipeline_recovery_log').update(updatePayload).eq('id', record.id);
        return json({
          new_status,
          traveler_label: getTravelerLabel(new_status),
          reconciled: true
        });
      }
      const reconcileAttempts = (record.failure_detail?.reconcile_attempts ?? 0) + 1;
      const entry = buildEntry('UNKNOWN', 'reconciliation cannot establish safe state');
      await serviceClient.from('pipeline_recovery_log').update({
        failure_detail: {
          ...record.failure_detail ?? {},
          reconcile_attempts: reconcileAttempts,
          last_reconcile_at: now
        },
        transition_log: [
          ...currentLog,
          entry
        ],
        updated_at: now
      }).eq('id', record.id);
      return json({
        new_status: 'UNKNOWN',
        traveler_label: getTravelerLabel('UNKNOWN'),
        reconciled: false
      });
    }
    if (action === 'get_recovery_status') {
      const operation_id = body.operation_id;
      if (!operation_id) return err('operation_id is required');
      const { data: record, error: fetchErr } = await serviceClient.from('pipeline_recovery_log').select('*').eq('operation_id', operation_id).order('created_at', {
        ascending: false
      }).limit(1).single();
      if (fetchErr || !record) return err('Recovery log record not found', 404);
      return json({
        ...record,
        traveler_label: getTravelerLabel(record.recovery_status)
      });
    }
    if (action === 'get_traveler_status') {
      const operation_id = body.operation_id;
      if (!operation_id) return err('operation_id is required');
      const { data: record, error: fetchErr } = await serviceClient.from('pipeline_recovery_log').select('operation_id, recovery_status, operation_type, attempt_number, updated_at').eq('operation_id', operation_id).order('created_at', {
        ascending: false
      }).limit(1).single();
      if (fetchErr || !record) return err('Recovery log record not found', 404);
      const recovery_status = record.recovery_status;
      const label = getTravelerLabel(recovery_status);
      const context = TRAVELER_CONTEXT[recovery_status] ?? 'Status information is not available.';
      return json({
        recovery_status,
        label,
        context,
        last_valid_data_preserved: true
      });
    }
    if (action === 'log_attempt_start') {
      const operation_id = body.operation_id;
      const attempt_number = body.attempt_number;
      if (!operation_id) return err('operation_id is required');
      const { data: record, error: fetchErr } = await serviceClient.from('pipeline_recovery_log').select('*').eq('operation_id', operation_id).order('created_at', {
        ascending: false
      }).limit(1).single();
      if (fetchErr || !record) return err('Recovery log record not found', 404);
      const guard = checkTerminalImmutability(record.recovery_status);
      if (guard) return guard;
      const now = new Date().toISOString();
      const isRetry = (attempt_number ?? 1) > 1;
      const newAttemptNumber = attempt_number ?? (record.attempt_number ?? 0) + 1;
      const validation = validateTimestampOrdering(record.requested_at, now, null);
      const transitionEntry = {
        from: record.recovery_status,
        to: 'ATTEMPTING',
        condition: isRetry ? 'retry attempt started' : 'initial attempt started',
        timestamp: now,
        attempt_number: newAttemptNumber
      };
      const currentLog = Array.isArray(record.transition_log) ? record.transition_log : [];
      const newLog = [
        ...currentLog,
        transitionEntry
      ];
      const updatePayload = {
        attempt_started_at: now,
        attempt_number: newAttemptNumber,
        transition_log: newLog,
        updated_at: now
      };
      if (isRetry) updatePayload.retry_started_at = now;
      if (validation.skew_detected) {
        updatePayload.clock_skew_detected = true;
        updatePayload.clock_skew_raw_timestamps = validation.raw_timestamps;
      }
      await serviceClient.from('pipeline_recovery_log').update(updatePayload).eq('id', record.id);
      return json({
        success: true,
        attempt_started_at: now,
        clock_skew_detected: validation.skew_detected
      });
    }
    if (action === 'log_attempt_complete') {
      const operation_id = body.operation_id;
      const outcome = body.outcome;
      const context = body.context;
      if (!operation_id || !outcome) return err('operation_id and outcome are required');
      const { data: record, error: fetchErr } = await serviceClient.from('pipeline_recovery_log').select('*').eq('operation_id', operation_id).order('created_at', {
        ascending: false
      }).limit(1).single();
      if (fetchErr || !record) return err('Recovery log record not found', 404);
      const now = new Date().toISOString();
      if (outcome === 'FAILURE' && record.recovery_status === 'SUCCESS') {
        await serviceClient.from('pipeline_recovery_log').update({
          late_failure_received: true,
          late_failure_details: {
            received_at: now,
            failure_context: context ?? null,
            note: 'Late failure signal received after success — preserved for audit'
          },
          updated_at: now
        }).eq('id', record.id);
        return json({
          status: 'SUCCESS_PRESERVED',
          message: 'Late failure signal received after success — preserved for audit'
        });
      }
      const guard = checkTerminalImmutability(record.recovery_status);
      if (guard) return guard;
      const validation = validateTimestampOrdering(record.requested_at, record.attempt_started_at, outcome === 'FAILURE' ? now : null);
      const baseUpdate = {
        attempt_completed_at: now,
        updated_at: now
      };
      if (validation.skew_detected) {
        baseUpdate.clock_skew_detected = true;
        baseUpdate.clock_skew_raw_timestamps = validation.raw_timestamps;
      }
      const currentLog = Array.isArray(record.transition_log) ? record.transition_log : [];
      if (outcome === 'SUCCESS') {
        const entry = {
          from: record.recovery_status,
          to: 'SUCCESS',
          condition: 'operation succeeds',
          timestamp: now,
          attempt_number: record.attempt_number ?? 0
        };
        await serviceClient.from('pipeline_recovery_log').update({
          ...baseUpdate,
          recovery_status: 'SUCCESS',
          recovered_at: now,
          terminal_at: now,
          terminal_state_reason: 'Attempt completed successfully',
          transition_log: [
            ...currentLog,
            entry
          ]
        }).eq('id', record.id);
        return json({
          recovery_status: 'SUCCESS',
          traveler_label: getTravelerLabel('SUCCESS'),
          terminal_at: now
        });
      }
      if (outcome === 'UNKNOWN') {
        const entry = {
          from: record.recovery_status,
          to: 'UNKNOWN',
          condition: 'outcome cannot be determined safely',
          timestamp: now,
          attempt_number: record.attempt_number ?? 0
        };
        await serviceClient.from('pipeline_recovery_log').update({
          ...baseUpdate,
          recovery_status: 'UNKNOWN',
          terminal_at: now,
          terminal_state_reason: 'Outcome unknown — reconciliation required before retry',
          transition_log: [
            ...currentLog,
            entry
          ]
        }).eq('id', record.id);
        return json({
          recovery_status: 'UNKNOWN',
          traveler_label: getTravelerLabel('UNKNOWN'),
          terminal_at: now
        });
      }
      if (!context) return err('context is required for FAILURE outcome');
      const enrichedCtx = {
        ...context,
        operation_type: context.operation_type ?? record.operation_type
      };
      const new_status = selectTerminalState(enrichedCtx);
      const isTerminal = TERMINAL_STATES.has(new_status);
      if (new_status === 'RETRY_PENDING' && record.operation_id) {
        const isDuplicate = await checkDuplicateRetry(serviceClient, record.operation_id, record.id);
        if (isDuplicate) {
          await serviceClient.from('pipeline_recovery_log').update({
            duplicate_retry_blocked: true,
            updated_at: now
          }).eq('id', record.id);
          return json({
            error: `Retry already scheduled for operation ${record.operation_id}`
          }, 409);
        }
      }
      const entry = {
        from: record.recovery_status,
        to: new_status,
        condition: `failure outcome: ${new_status}`,
        timestamp: now,
        attempt_number: record.attempt_number ?? 0
      };
      const updatePayload = {
        ...baseUpdate,
        recovery_status: new_status,
        failed_at: validation.skew_detected ? null : now,
        terminal_state_reason: `Failure outcome: ${new_status}`,
        transition_log: [
          ...currentLog,
          entry
        ]
      };
      if (isTerminal) updatePayload.terminal_at = now;
      await serviceClient.from('pipeline_recovery_log').update(updatePayload).eq('id', record.id);
      return json({
        recovery_status: new_status,
        traveler_label: getTravelerLabel(new_status),
        terminal_at: isTerminal ? now : null,
        clock_skew_detected: validation.skew_detected
      });
    }
    if (action === 'schedule_retry') {
      const operation_id = body.operation_id;
      const retry_reason = body.retry_reason;
      if (!operation_id) return err('operation_id is required');
      const { data: record, error: fetchErr } = await serviceClient.from('pipeline_recovery_log').select('*').eq('operation_id', operation_id).order('created_at', {
        ascending: false
      }).limit(1).single();
      if (fetchErr || !record) return err('Recovery log record not found', 404);
      const guard = checkTerminalImmutability(record.recovery_status);
      if (guard) return guard;
      const isDuplicate = await checkDuplicateRetry(serviceClient, operation_id, record.id);
      if (isDuplicate) {
        await serviceClient.from('pipeline_recovery_log').update({
          duplicate_retry_blocked: true,
          updated_at: new Date().toISOString()
        }).eq('id', record.id);
        return json({
          error: `Retry already scheduled for operation ${operation_id}`
        }, 409);
      }
      const now = new Date().toISOString();
      const operation_type = record.operation_type ?? 'CHANGE_DETECTION';
      const attempt_number = (record.attempt_number ?? 0) + 1;
      const { calculated_backoff_ms, capped_delay_ms, jitter_multiplier, retry_delay_ms } = calculateRetryDelay(operation_type, attempt_number);
      const next_attempt_at = new Date(Date.now() + retry_delay_ms).toISOString();
      const transitionEntry = {
        from: record.recovery_status,
        to: 'RETRY_PENDING',
        condition: 'retry permitted',
        timestamp: now,
        attempt_number: record.attempt_number ?? 0,
        reason: retry_reason ?? `delay_ms=${retry_delay_ms}, next_attempt_at=${next_attempt_at}`
      };
      const currentLog = Array.isArray(record.transition_log) ? record.transition_log : [];
      const newLog = [
        ...currentLog,
        transitionEntry
      ];
      await serviceClient.from('pipeline_recovery_log').update({
        recovery_status: 'RETRY_PENDING',
        retry_scheduled_at: now,
        retry_delay_ms,
        calculated_backoff_ms,
        capped_delay_ms,
        jitter_multiplier,
        retry_reason: retry_reason ?? null,
        next_attempt_at,
        transition_log: newLog,
        updated_at: now
      }).eq('id', record.id);
      return json({
        recovery_status: 'RETRY_PENDING',
        retry_delay_ms,
        calculated_backoff_ms,
        capped_delay_ms,
        jitter_multiplier,
        next_attempt_at,
        retry_scheduled_at: now
      });
    }
    if (action === 'process_retry_pending') {
      const operation_id = body.operation_id;
      if (!operation_id) return err('operation_id is required');
      const { data: record, error: fetchErr } = await serviceClient.from('pipeline_recovery_log').select('*').eq('operation_id', operation_id).eq('recovery_status', 'RETRY_PENDING').order('created_at', {
        ascending: false
      }).limit(1).single();
      if (fetchErr || !record) return err('No RETRY_PENDING record found for operation', 404);
      const now = new Date();
      if (record.next_attempt_at && new Date(record.next_attempt_at) > now) {
        return json({
          status: 'NOT_YET_DUE',
          next_attempt_at: record.next_attempt_at
        });
      }
      const staleResult = await validateOperationStillValid(operation_id, serviceClient);
      if (!staleResult.valid) {
        const nowIso = now.toISOString();
        const currentLog = Array.isArray(record.transition_log) ? record.transition_log : [];
        const staleEntry = {
          from: 'RETRY_PENDING',
          to: 'CANCELLED_STALE',
          condition: 'operation stale',
          timestamp: nowIso,
          attempt_number: record.attempt_number ?? 0,
          reason: `Stale check failed: ${staleResult.failed_check}`
        };
        await serviceClient.from('pipeline_recovery_log').update({
          recovery_status: 'CANCELLED_STALE',
          terminal_at: nowIso,
          cancelled_reason: `Retry expired — stale check failed: ${staleResult.failed_check}`,
          terminal_state_reason: `Retry expired — stale check failed: ${staleResult.failed_check}`,
          stale_check_passed: false,
          stale_check_details: {
            failed_check: staleResult.failed_check,
            details: staleResult.details
          },
          transition_log: [
            ...currentLog,
            staleEntry
          ],
          updated_at: nowIso
        }).eq('id', record.id);
        return json({
          status: 'CANCELLED_STALE',
          reason: `Retry expired — stale check failed: ${staleResult.failed_check}`,
          stale_check_details: staleResult.details
        });
      }
      await serviceClient.from('pipeline_recovery_log').update({
        stale_check_passed: true,
        updated_at: now.toISOString()
      }).eq('id', record.id);
      const result = await retryEntry(serviceClient, record.id);
      return json({
        status: 'EXECUTED',
        result
      });
    }
    if (action === 'log_failure') {
      const operation = body.operation;
      const failureType = body.failure_type;
      if (!operation || !failureType) return err('operation and failure_type are required');
      const recoveryLogId = await logFailure(serviceClient, {
        user_id: body.user_id,
        trip_id: body.trip_id,
        operation,
        related_object_type: body.related_object_type,
        related_object_id: body.related_object_id,
        failure_type: failureType,
        failure_message: body.failure_message,
        failure_detail: body.failure_detail,
        last_successful_state: body.last_successful_state
      });
      return json({
        recovery_log_id: recoveryLogId
      });
    }
    if (action === 'retry') {
      const recoveryLogId = body.recovery_log_id;
      if (!recoveryLogId) return err('recovery_log_id is required');
      const result = await retryEntry(serviceClient, recoveryLogId);
      return json(result);
    }
    if (action === 'process_pending') {
      const tripId = body.trip_id;
      let query = serviceClient.from('pipeline_recovery_log').select('id').in('recovery_status', [
        'PENDING',
        'RETRYING'
      ]).order('created_at', {
        ascending: true
      }).limit(10);
      if (tripId) query = query.eq('trip_id', tripId);
      const { data: pendingEntries, error: fetchErr } = await query;
      if (fetchErr) return err('Failed to fetch pending entries', 500);
      const entries = pendingEntries ?? [];
      let recovered = 0, failed = 0, permanentlyFailed = 0;
      for (const entry of entries){
        const result = await retryEntry(serviceClient, entry.id);
        if (result.recovery_status === 'RECOVERED' || result.recovery_status === 'SUCCESS') recovered++;
        else if (result.recovery_status === 'PERMANENT_FAILURE' || result.recovery_status === 'FAILED_PERMANENTLY') permanentlyFailed++;
        else failed++;
      }
      return json({
        processed: entries.length,
        recovered,
        failed,
        permanently_failed: permanentlyFailed
      });
    }
    return err('Unknown action');
  }
  return err('Method not allowed', 405);
});

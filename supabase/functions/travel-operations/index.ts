import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');
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
/** Length-independent constant-time compare. Avoids leaking the key by timing. */ function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for(let i = 0; i < len; i++){
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}
async function authenticateCaller(req) {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return err('Missing or invalid Authorization header', 401);
  }
  const token = authHeader.slice(7).trim();
  if (!token) return err('Missing or invalid Authorization header', 401);
  if (timingSafeEqual(token, SERVICE_ROLE_KEY)) {
    return {
      kind: 'service'
    };
  }
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: {
      headers: {
        Authorization: `Bearer ${token}`
      }
    }
  });
  const { data: { user }, error } = await userClient.auth.getUser();
  if (error || !user) return err('Invalid token', 401);
  return {
    kind: 'user',
    userId: user.id
  };
}
/**
 * Ownership gate for operation-keyed actions. Returns a Response to send, or
 * null to continue. Service callers always pass. User callers must own the
 * operation. Returns 404 rather than 403 so a caller cannot probe which
 * operation ids exist.
 */ function denyIfNotOwner(caller, opUserId) {
  if (caller.kind === 'service') return null;
  if (!opUserId || opUserId !== caller.userId) return err('Operation not found', 404);
  return null;
}
/** Resolve the acting user_id: bound to the JWT for user callers, body for service. */ function resolveUserId(caller, body) {
  if (caller.kind === 'user') return caller.userId;
  return body.user_id;
}
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
  'RECALCULATION_FAILED'
]);
async function auditLog(serviceClient, params) {
  try {
    const { error } = await serviceClient.from('concurrency_audit_log').insert({
      operation_id: params.operation_id ?? null,
      attempt_id: params.attempt_id ?? null,
      owner_id: params.owner_id ?? null,
      event_type: params.event_type,
      previous_state: params.previous_state ?? null,
      requested_state: params.requested_state ?? null,
      resulting_state: params.resulting_state ?? null,
      reason: params.reason ?? null,
      metadata: params.metadata ?? null
    });
    if (error) console.error('[travel-operations] auditLog insert failed:', error.code, error.message);
  } catch (e) {
    console.error('[travel-operations] auditLog error:', e);
  }
}
/** Loads an operation and enforces ownership. Returns the op or a Response. */ async function loadOwnedOperation(serviceClient, caller, operation_id) {
  const { data: op, error: opErr } = await serviceClient.from('travel_operations').select('*').eq('operation_id', operation_id).maybeSingle();
  if (opErr) return err(`Failed to load operation: ${opErr.message}`, 500);
  if (!op) return err('Operation not found', 404);
  const denied = denyIfNotOwner(caller, op.user_id);
  if (denied) return denied;
  return op;
}
// ─────────────────────────────────────────────────────────────────────────────────────
// ACTION: create
// ─────────────────────────────────────────────────────────────────────────────────────
async function actionCreate(serviceClient, caller, body) {
  // SECURITY: for user callers this is the JWT subject, never the body value.
  const user_id = resolveUserId(caller, body);
  const trip_id = body.trip_id;
  const operation_type = body.operation_type;
  const idempotency_key = body.idempotency_key;
  const request_fingerprint = body.request_fingerprint;
  const request_hash = body.request_hash;
  const expected_version_id = body.expected_version_id;
  const parent_operation_id = body.parent_operation_id;
  if (!user_id) return err('user_id is required');
  if (!operation_type) return err('operation_type is required');
  if (idempotency_key) {
    const { data: existing, error: checkErr } = await serviceClient.from('idempotency_records').select('*').eq('user_id', user_id).eq('idempotency_key', idempotency_key).maybeSingle();
    if (checkErr) return err(`Idempotency check failed: ${checkErr.message}`, 500);
    if (existing) {
      if (request_fingerprint && existing.request_fingerprint && existing.request_fingerprint !== request_fingerprint) {
        return json({
          error: 'FINGERPRINT_CONFLICT',
          message: 'Same key, different request'
        }, 409);
      }
      if (existing.status === 'IN_PROGRESS') {
        return json({
          status: 'IN_PROGRESS',
          operation_id: existing.operation_id
        });
      }
      if (existing.status === 'SUCCEEDED') {
        return json({
          status: 'SUCCEEDED',
          response_reference: existing.response_reference,
          operation_id: existing.operation_id
        });
      }
      if (existing.status === 'CANCELLED' || existing.status === 'STALE') {
        return json({
          error: 'IDEMPOTENCY_KEY_TERMINAL',
          status: existing.status
        }, 409);
      }
    }
  }
  const { data: op, error: opErr } = await serviceClient.from('travel_operations').insert({
    user_id,
    trip_id: trip_id ?? null,
    operation_type,
    parent_operation_id: parent_operation_id ?? null,
    idempotency_key: idempotency_key ?? null,
    request_fingerprint: request_fingerprint ?? null,
    request_hash: request_hash ?? null,
    expected_version_id: expected_version_id ?? null,
    current_state: 'OPERATION_REQUESTED',
    attempt_number: 0
  }).select('operation_id, current_state, attempt_number').single();
  if (opErr || !op) return err(`Failed to create operation: ${opErr?.message}`, 500);
  if (idempotency_key) {
    const { error: irErr } = await serviceClient.from('idempotency_records').insert({
      idempotency_key,
      user_id,
      trip_id: trip_id ?? null,
      operation_id: op.operation_id,
      operation_type,
      request_fingerprint: request_fingerprint ?? null,
      request_hash: request_hash ?? null,
      status: 'IN_PROGRESS'
    });
    if (irErr && irErr.code !== '23505') {
      console.error('[travel-operations] idempotency_records insert error:', irErr);
    }
    await auditLog(serviceClient, {
      operation_id: op.operation_id,
      owner_id: user_id,
      event_type: 'IDEMPOTENCY_KEY_CLAIMED',
      resulting_state: 'OPERATION_REQUESTED',
      metadata: {
        idempotency_key,
        operation_type
      }
    });
  }
  return json({
    operation_id: op.operation_id,
    current_state: op.current_state,
    attempt_number: op.attempt_number
  });
}
// ─────────────────────────────────────────────────────────────────────────────────────
// ACTION: begin_attempt
// ─────────────────────────────────────────────────────────────────────────────────────
async function actionBeginAttempt(serviceClient, caller, body) {
  const operation_id = body.operation_id;
  const execution_owner_id = body.execution_owner_id;
  if (!operation_id) return err('operation_id is required');
  if (!execution_owner_id) return err('execution_owner_id is required');
  const loaded = await loadOwnedOperation(serviceClient, caller, operation_id);
  if (loaded instanceof Response) return loaded;
  const op = loaded;
  if (TERMINAL_STATES.has(op.current_state)) {
    return json({
      error: `Operation is in terminal state ${op.current_state}`
    }, 409);
  }
  const now = new Date().toISOString();
  const lockExpiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const attemptId = crypto.randomUUID();
  // DEFECT 2026-09-19 — THE LOCK GATE DID NOT GATE.
  //
  // This used to be:
  //   await ...from('operation_locks').upsert({...}, { onConflict: 'operation_id' })
  //   const { data: existingLock } = await ...select('lock_owner, expires_at')
  //   if (existingLock && existingLock.lock_owner !== execution_owner_id) { ... }
  //
  // PostgREST's upsert emits INSERT ... ON CONFLICT DO UPDATE with no WHERE
  // clause, so it overwrote any live lock unconditionally. The read that
  // followed then returned the row this very call had just written — so
  // `existingLock.lock_owner` was always `execution_owner_id`, the comparison
  // was always false, and LOCK_HELD could never be returned. Every worker that
  // called begin_attempt acquired the lock, whoever already held it. Two
  // workers could then be executing the same ITINERARY_CHANGE at once, each
  // holding what it believed was an exclusive lock — the exact failure the
  // operations framework exists to prevent.
  //
  // Acquisition is now conditional, using UNIQUE(operation_locks.operation_id):
  // a plain INSERT wins when no lock exists; on 23505 a takeover is attempted
  // ONLY where expires_at <= now(), which Postgres re-evaluates after taking
  // the row lock under READ COMMITTED so exactly one of two racing workers can
  // win; and if that matches nothing, the live holder is reported.
  const lockRow = {
    operation_id,
    attempt_id: attemptId,
    lock_owner: execution_owner_id,
    acquired_at: now,
    expires_at: lockExpiresAt,
    last_renewed_at: now,
    trip_id: op.trip_id ?? null,
    operation_type: op.operation_type,
    attempt_number: (op.attempt_number ?? 0) + 1,
    current_state: 'ATTEMPTING'
  };
  let lockAcquired = false;
  const inserted = await serviceClient.from('operation_locks').insert(lockRow);
  if (!inserted.error) {
    lockAcquired = true;
  } else if (inserted.error.code === '23505') {
    const stolen = await serviceClient.from('operation_locks').update(lockRow).eq('operation_id', operation_id).lte('expires_at', now).select('operation_id');
    if (stolen.error) {
      return err(`Failed to acquire operation lock: ${stolen.error.message}`, 500);
    }
    lockAcquired = !!stolen.data && stolen.data.length > 0;
  } else {
    return err(`Failed to acquire operation lock: ${inserted.error.message}`, 500);
  }
  if (!lockAcquired) {
    const { data: holder, error: holderErr } = await serviceClient.from('operation_locks').select('lock_owner, expires_at').eq('operation_id', operation_id).maybeSingle();
    if (holderErr) {
      return err(`Failed to read operation lock: ${holderErr.message}`, 500);
    }
    // Same owner re-entering is not a conflict.
    if (holder && holder.lock_owner === execution_owner_id) {
      lockAcquired = true;
    } else {
      await auditLog(serviceClient, {
        operation_id,
        attempt_id: attemptId,
        owner_id: execution_owner_id,
        event_type: 'LOCK_DENIED',
        reason: `Lock held by ${holder?.lock_owner ?? 'unknown owner'}`
      });
      return json({
        error: 'LOCK_HELD',
        lock_owner: holder?.lock_owner ?? null
      }, 409);
    }
  }
  const terminalList = Array.from(TERMINAL_STATES);
  const { data: updatedOp, error: updateErr } = await serviceClient.from('travel_operations').update({
    attempt_number: (op.attempt_number ?? 0) + 1,
    current_state: 'ATTEMPTING',
    last_attempt_started_at: now,
    lock_status: 'LOCKED',
    lock_owner_id: execution_owner_id,
    lock_acquired_at: now,
    lock_expires_at: lockExpiresAt,
    updated_at: now
  }).eq('operation_id', operation_id).not('current_state', 'in', `(${terminalList.map((s)=>`"${s}"`).join(',')})`).select('operation_id, attempt_number, current_state').maybeSingle();
  if (updateErr || !updatedOp) {
    // Release the lock we just took — previously it was left behind, so a
    // blocked attempt held the operation hostage for the full 5-minute lease.
    await serviceClient.from('operation_locks').delete().eq('operation_id', operation_id).eq('lock_owner', execution_owner_id).eq('attempt_id', attemptId);
    await auditLog(serviceClient, {
      operation_id,
      owner_id: execution_owner_id,
      event_type: 'ATTEMPT_BLOCKED',
      reason: updateErr ? `Operation update failed: ${updateErr.message}` : 'Operation in terminal state or update conflict'
    });
    return json({
      error: 'ATTEMPT_BLOCKED',
      reason: 'Operation may be in terminal state'
    }, 409);
  }
  const { data: attempt, error: attemptErr } = await serviceClient.from('operation_attempts').insert({
    attempt_id: attemptId,
    operation_id,
    attempt_number: updatedOp.attempt_number,
    execution_owner_id,
    status: 'IN_PROGRESS',
    started_at: now
  }).select('attempt_id, attempt_number').single();
  if (attemptErr) {
    if (attemptErr.code === '23505') {
      await auditLog(serviceClient, {
        operation_id,
        owner_id: execution_owner_id,
        event_type: 'ATTEMPT_BLOCKED',
        reason: 'Duplicate attempt_number — another worker already created this attempt'
      });
      return json({
        error: 'ATTEMPT_BLOCKED',
        reason: 'Duplicate attempt'
      }, 409);
    }
    return err(`Failed to create attempt: ${attemptErr.message}`, 500);
  }
  await auditLog(serviceClient, {
    operation_id,
    attempt_id: attempt.attempt_id,
    owner_id: execution_owner_id,
    event_type: 'LOCK_ACQUIRED',
    resulting_state: 'ATTEMPTING',
    metadata: {
      attempt_number: updatedOp.attempt_number
    }
  });
  await auditLog(serviceClient, {
    operation_id,
    attempt_id: attempt.attempt_id,
    owner_id: execution_owner_id,
    event_type: 'ATTEMPT_CREATED',
    resulting_state: 'ATTEMPTING',
    metadata: {
      attempt_number: updatedOp.attempt_number
    }
  });
  return json({
    attempt_id: attempt.attempt_id,
    attempt_number: updatedOp.attempt_number,
    current_state: 'ATTEMPTING'
  });
}
// ─────────────────────────────────────────────────────────────────────────────────────
// ACTION: complete_attempt
// ─────────────────────────────────────────────────────────────────────────────────────
async function actionCompleteAttempt(serviceClient, caller, body) {
  const operation_id = body.operation_id;
  const attempt_id = body.attempt_id;
  const execution_owner_id = body.execution_owner_id;
  const outcome = body.outcome;
  const new_state = body.new_state;
  const terminal_reason = body.terminal_reason;
  const failure_classification = body.failure_classification;
  const error_code = body.error_code;
  if (!operation_id) return err('operation_id is required');
  if (!attempt_id) return err('attempt_id is required');
  if (!execution_owner_id) return err('execution_owner_id is required');
  if (!outcome) return err('outcome is required');
  if (!new_state) return err('new_state is required');
  const loaded = await loadOwnedOperation(serviceClient, caller, operation_id);
  if (loaded instanceof Response) return loaded;
  const op = loaded;
  const now = new Date().toISOString();
  // SECURITY: this lock lookup gates whether the caller is allowed to
  // complete this attempt. A discarded error here used to be indistinguishable
  // from "no lock exists", which would silently skip the ownership check
  // below and let the caller proceed. Now a lookup failure fails closed.
  const { data: lock, error: lockErr } = await serviceClient.from('operation_locks').select('lock_owner').eq('operation_id', operation_id).maybeSingle();
  if (lockErr) {
    console.error('[travel-operations] lock lookup failed for complete_attempt (denying):', lockErr.message);
    return err('Failed to verify lock ownership', 500);
  }
  if (lock && lock.lock_owner !== execution_owner_id) {
    return json({
      error: 'LOCK_OWNERSHIP_MISMATCH',
      message: 'You do not own the lock for this operation'
    }, 403);
  }
  const attemptStatus = outcome === 'SUCCESS' ? 'SUCCESS' : outcome === 'FAILURE' ? 'FAILED' : 'UNKNOWN';
  // DEFECT 2026-09-19 (failure-looks-like-success) — every write below used to
  // be `if (err) console.error(...)` and the handler returned
  // `{ operation_id, new_state, attempt_id }` regardless. So when the
  // travel_operations update failed, the worker was told its operation had
  // reached `new_state` — SUCCESS, PERMANENT_FAILURE, whatever it reported —
  // while the row was still sitting in ATTEMPTING, and the lock below was then
  // deleted anyway. The operation was left permanently mid-flight with nothing
  // holding it and nobody aware. The two writes that determine the operation's
  // recorded outcome now fail the request.
  const { data: attemptUpdated, error: attemptUpdateErr } = await serviceClient.from('operation_attempts').update({
    status: attemptStatus,
    completed_at: now,
    failure_classification: failure_classification ?? null,
    error_code: error_code ?? null
  }).eq('attempt_id', attempt_id).eq('operation_id', operation_id).select('attempt_id');
  if (attemptUpdateErr) {
    return err(`Failed to record attempt outcome: ${attemptUpdateErr.message}`, 500);
  }
  if (!attemptUpdated || attemptUpdated.length === 0) {
    // A zero-row update here means the attempt_id does not belong to this
    // operation. Previously silent.
    return err('Attempt not found for this operation', 404);
  }
  const isTerminal = TERMINAL_STATES.has(new_state);
  const opUpdate = {
    current_state: new_state,
    last_attempt_completed_at: now,
    lock_status: 'UNLOCKED',
    lock_owner_id: null,
    updated_at: now
  };
  if (isTerminal) {
    opUpdate.terminal_at = now;
    opUpdate.terminal_reason = terminal_reason ?? `Completed with outcome: ${outcome}`;
  }
  if (outcome === 'FAILURE') opUpdate.last_failure_at = now;
  const { data: opUpdated, error: opUpdateErr } = await serviceClient.from('travel_operations').update(opUpdate).eq('operation_id', operation_id).select('operation_id');
  if (opUpdateErr) {
    return err(`Failed to record operation outcome: ${opUpdateErr.message}`, 500);
  }
  if (!opUpdated || opUpdated.length === 0) {
    return err('Operation not found while recording outcome', 404);
  }
  if (outcome === 'SUCCESS' && op.idempotency_key) {
    const { error: idemUpdateErr } = await serviceClient.from('idempotency_records').update({
      status: 'SUCCEEDED',
      completed_at: now
    }).eq('user_id', op.user_id).eq('idempotency_key', op.idempotency_key);
    if (idemUpdateErr) console.error('[travel-operations] idempotency_records update failed:', idemUpdateErr.message);
  }
  // Scoped to this owner so a completing worker cannot delete a lock that a
  // different worker legitimately took over after this one's lease expired.
  const { error: lockDeleteErr } = await serviceClient.from('operation_locks').delete().eq('operation_id', operation_id).eq('lock_owner', execution_owner_id);
  if (lockDeleteErr) console.error('[travel-operations] operation_locks delete failed:', lockDeleteErr.message);
  await auditLog(serviceClient, {
    operation_id,
    attempt_id,
    owner_id: execution_owner_id,
    event_type: 'STATE_TRANSITION_SUCCEEDED',
    resulting_state: new_state,
    reason: terminal_reason
  });
  await auditLog(serviceClient, {
    operation_id,
    attempt_id,
    owner_id: execution_owner_id,
    event_type: 'LOCK_RELEASED',
    resulting_state: new_state
  });
  return json({
    operation_id,
    new_state,
    attempt_id
  });
}
// ─────────────────────────────────────────────────────────────────────────────────────
// ACTION: cancel
// ─────────────────────────────────────────────────────────────────────────────────────
async function actionCancel(serviceClient, caller, body) {
  const operation_id = body.operation_id;
  const user_id = resolveUserId(caller, body);
  const reason = body.reason;
  if (!operation_id) return err('operation_id is required');
  if (!user_id) return err('user_id is required');
  // DEFECT 2026-09-19 (failure-looks-like-absence) — `if (opErr || !op)`
  // reported a failed query as "Operation not found or access denied", so a
  // user trying to cancel their own operation was told it did not exist or was
  // not theirs whenever the read failed.
  const { data: op, error: opErr } = await serviceClient.from('travel_operations').select('*').eq('operation_id', operation_id).eq('user_id', user_id).maybeSingle();
  if (opErr) {
    console.error('[travel-operations] cancel: operation lookup failed:', opErr.code, opErr.message);
    return err(`Failed to load operation: ${opErr.message}`, 500);
  }
  if (!op) return err('Operation not found or access denied', 404);
  if (TERMINAL_STATES.has(op.current_state)) {
    return json({
      error: 'ALREADY_TERMINAL',
      current_state: op.current_state
    }, 409);
  }
  const now = new Date().toISOString();
  const terminalList = Array.from(TERMINAL_STATES);
  const { data: updated, error: updateErr } = await serviceClient.from('travel_operations').update({
    current_state: 'CANCELLED',
    terminal_at: now,
    terminal_reason: reason ?? 'User cancelled',
    updated_at: now
  }).eq('operation_id', operation_id).not('current_state', 'in', `(${terminalList.map((s)=>`"${s}"`).join(',')})`).select('operation_id').maybeSingle();
  if (updateErr) {
    console.error('[travel-operations] cancel: update failed:', updateErr.code, updateErr.message);
    return err(`Failed to cancel operation: ${updateErr.message}`, 500);
  }
  if (!updated) {
    // Zero rows means it became terminal between the read and the write — a
    // genuine race, not a failure.
    return json({
      error: 'ALREADY_TERMINAL',
      current_state: op.current_state
    }, 409);
  }
  if (op.idempotency_key) {
    const { error: idemCancelErr } = await serviceClient.from('idempotency_records').update({
      status: 'CANCELLED',
      completed_at: now
    }).eq('user_id', user_id).eq('idempotency_key', op.idempotency_key);
    if (idemCancelErr) console.error('[travel-operations] idempotency_records cancel update failed:', idemCancelErr.message);
  }
  await auditLog(serviceClient, {
    operation_id,
    owner_id: user_id,
    event_type: 'STATE_TRANSITION_SUCCEEDED',
    previous_state: op.current_state,
    resulting_state: 'CANCELLED',
    reason: reason ?? 'User cancelled'
  });
  return json({
    cancelled: true,
    operation_id
  });
}
// ─────────────────────────────────────────────────────────────────────────────────────
// ACTION: get
// ─────────────────────────────────────────────────────────────────────────────────────
async function actionGet(serviceClient, caller, body) {
  const operation_id = body.operation_id;
  if (!operation_id) return err('operation_id is required');
  // SECURITY: previously select('*') with no ownership check, unauthenticated.
  const loaded = await loadOwnedOperation(serviceClient, caller, operation_id);
  if (loaded instanceof Response) return loaded;
  // DEFECT 2026-09-19 — a failed attempts query was logged and then rendered as
  // `attempts: []`, i.e. "this operation has never been attempted", which is
  // the opposite of what a stuck operation's history usually shows.
  const { data: attempts, error: attemptsErr } = await serviceClient.from('operation_attempts').select('*').eq('operation_id', operation_id).order('attempt_number', {
    ascending: true
  });
  if (attemptsErr) {
    console.error('[travel-operations] get: attempts lookup failed:', attemptsErr.code, attemptsErr.message);
    return err(`Failed to load operation attempts: ${attemptsErr.message}`, 500);
  }
  return json({
    ...loaded,
    attempts: attempts ?? []
  });
}
// ─────────────────────────────────────────────────────────────────────────────────────
// ACTION: get_attempts
// ─────────────────────────────────────────────────────────────────────────────────────
async function actionGetAttempts(serviceClient, caller, body) {
  const operation_id = body.operation_id;
  if (!operation_id) return err('operation_id is required');
  const loaded = await loadOwnedOperation(serviceClient, caller, operation_id);
  if (loaded instanceof Response) return loaded;
  const { data: attempts, error: attErr } = await serviceClient.from('operation_attempts').select('*').eq('operation_id', operation_id).order('attempt_number', {
    ascending: true
  });
  if (attErr) return err(`Failed to fetch attempts: ${attErr.message}`, 500);
  return json({
    operation_id,
    attempts: attempts ?? []
  });
}
// ─────────────────────────────────────────────────────────────────────────────────────
// ACTION: reconcile
// ─────────────────────────────────────────────────────────────────────────────────────
async function actionReconcile(serviceClient, caller, body) {
  const operation_id = body.operation_id;
  if (!operation_id) return err('operation_id is required');
  // SECURITY: reconcile can drive an operation to SUCCESS and mark its
  // idempotency record SUCCEEDED. Ownership is enforced before anything runs.
  const loaded = await loadOwnedOperation(serviceClient, caller, operation_id);
  if (loaded instanceof Response) return loaded;
  const op = loaded;
  const now = new Date().toISOString();
  await auditLog(serviceClient, {
    operation_id,
    event_type: 'RECOVERY_STARTED',
    metadata: {
      triggered_at: now
    }
  });
  // DEFECT 2026-09-19 — a failed attempts read was logged and then treated as
  // an empty attempt history, which sends reconciliation straight down the
  // "No conclusive evidence found" path and can mark a genuinely successful
  // operation UNKNOWN. Reconciliation must not run on data it failed to read.
  const { data: attempts, error: attemptsErr } = await serviceClient.from('operation_attempts').select('*').eq('operation_id', operation_id).order('attempt_number', {
    ascending: true
  });
  if (attemptsErr) {
    console.error('[travel-operations] reconcile: attempts lookup failed:', attemptsErr.code, attemptsErr.message);
    return err(`Cannot reconcile: failed to read attempt history (${attemptsErr.message})`, 500);
  }
  const allAttempts = attempts ?? [];
  let new_state = op.current_state;
  let reconciled = false;
  const evidence = {};
  const successAttempt = allAttempts.find((a)=>a.status === 'SUCCESS');
  if (successAttempt) {
    new_state = 'SUCCESS';
    reconciled = true;
    evidence.success_attempt_id = successAttempt.attempt_id;
    evidence.source = 'attempt_record';
  } else {
    if (op.operation_type === 'ITINERARY_CHANGE' && op.trip_id) {
      // Note: a trip can legitimately have more than one active version row,
      // in which case maybeSingle() errors rather than returning a row. That is
      // reported as "not determined" below rather than as "no active version".
      const { data: versions, error: versionsErr } = await serviceClient.from('itinerary_versions').select('id, is_active, created_at').eq('trip_id', op.trip_id).eq('is_active', true).maybeSingle();
      if (versionsErr) {
        console.error('[travel-operations] reconcile: active version lookup failed:', versionsErr.code, versionsErr.message);
        evidence.active_version_lookup_failed = versionsErr.message;
      }
      if (versions) {
        evidence.active_version_found = versions.id;
        evidence.source = 'itinerary_versions';
      }
    }
    const failedAttempts = allAttempts.filter((a)=>a.status === 'FAILED' || a.status === 'CANCELLED');
    const inProgressAttempts = allAttempts.filter((a)=>a.status === 'IN_PROGRESS');
    const maxAttempts = typeof op.max_attempts === 'number' ? op.max_attempts : null;
    if (inProgressAttempts.length > 0) {
      new_state = 'UNKNOWN';
      evidence.stale_in_progress = inProgressAttempts.length;
    } else if (failedAttempts.length > 0 && maxAttempts !== null && allAttempts.length >= maxAttempts) {
      new_state = 'PERMANENT_FAILURE';
      reconciled = true;
      evidence.exhausted_attempts = allAttempts.length;
    } else if (failedAttempts.length > 0) {
      new_state = 'RETRY_PENDING';
      reconciled = true;
      evidence.failed_attempts = failedAttempts.length;
      // Previously `op.max_attempts - allAttempts.length`, which is NaN when
      // max_attempts is null and was reported to the caller as a number.
      evidence.remaining_attempts = maxAttempts !== null ? maxAttempts - allAttempts.length : null;
    } else {
      new_state = 'UNKNOWN';
      evidence.reason = 'No conclusive evidence found';
    }
  }
  if (new_state !== op.current_state) {
    const isTerminal = TERMINAL_STATES.has(new_state);
    const updatePayload = {
      current_state: new_state,
      updated_at: now
    };
    if (isTerminal) {
      updatePayload.terminal_at = now;
      updatePayload.terminal_reason = 'Reconciliation';
    }
    // DEFECT 2026-09-19 (failure-looks-like-success) — this update's error was
    // logged and the response still reported `{ reconciled, new_state }`. An
    // operation that reconciliation failed to move was reported as reconciled,
    // so nothing ever looked at it again and it stayed stuck forever. The
    // operation state is now written BEFORE the idempotency record (so a
    // failure cannot leave the key marked SUCCEEDED against an operation still
    // in flight) and a failed write is returned as a failure.
    const { data: opUpdated, error: opReconcileErr } = await serviceClient.from('travel_operations').update(updatePayload).eq('operation_id', operation_id).select('operation_id');
    if (opReconcileErr) {
      console.error('[travel-operations] reconcile: travel_operations update failed:', opReconcileErr.code, opReconcileErr.message);
      return err(`Reconciliation could not record state ${new_state}: ${opReconcileErr.message}`, 500);
    }
    if (!opUpdated || opUpdated.length === 0) {
      return err('Reconciliation could not record state: operation not found', 404);
    }
    if (new_state === 'SUCCESS' && op.idempotency_key) {
      const { error: idemReconcileErr } = await serviceClient.from('idempotency_records').update({
        status: 'SUCCEEDED',
        completed_at: now
      }).eq('user_id', op.user_id).eq('idempotency_key', op.idempotency_key);
      if (idemReconcileErr) console.error('[travel-operations] reconcile: idempotency_records update failed:', idemReconcileErr.message);
    }
  }
  await auditLog(serviceClient, {
    operation_id,
    event_type: 'RECOVERY_COMPLETED',
    previous_state: op.current_state,
    resulting_state: new_state,
    metadata: {
      reconciled,
      evidence
    }
  });
  return json({
    reconciled,
    new_state,
    evidence
  });
}
// ─────────────────────────────────────────────────────────────────────────────────────
// MAIN HANDLER
// ─────────────────────────────────────────────────────────────────────────────────────
Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: corsHeaders
    });
  }
  if (req.method !== 'POST') return err('Method not allowed', 405);
  // SECURITY GATE — must run before any database work.
  const caller = await authenticateCaller(req);
  if (caller instanceof Response) return caller;
  const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  let body;
  try {
    body = await req.json();
  } catch  {
    return err('Invalid JSON body');
  }
  const action = body.action;
  if (!action) return err('action is required');
  switch(action){
    case 'create':
      return actionCreate(serviceClient, caller, body);
    case 'begin_attempt':
      return actionBeginAttempt(serviceClient, caller, body);
    case 'complete_attempt':
      return actionCompleteAttempt(serviceClient, caller, body);
    case 'cancel':
      return actionCancel(serviceClient, caller, body);
    case 'get':
      return actionGet(serviceClient, caller, body);
    case 'get_attempts':
      return actionGetAttempts(serviceClient, caller, body);
    case 'reconcile':
      return actionReconcile(serviceClient, caller, body);
    default:
      return err('Unknown action');
  }
});

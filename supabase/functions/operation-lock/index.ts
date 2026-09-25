import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { corsHeaders, json, fail as err, serviceClient, requireService } from './_shared/auth.ts';
// SECURITY 2026-09-16 — this function previously had NO authentication at all.
//
// `Deno.serve` went straight from `req.json()` to a service_role client and an
// action dispatch. The exploit chain was complete and trivial:
//
//   1. `check` returns `lock_owner` and `attempt_id` to any anonymous caller.
//   2. `release` then "verifies ownership" by comparing the stored lock_owner
//      and attempt_id against values THE CALLER SUPPLIES in the same request.
//
// So: call `check`, echo the values back to `release`, and you have deleted
// another worker's lock. Two workers then mutate the same itinerary
// concurrently — which is precisely the condition this entire module exists to
// prevent. `force_release_expired` and `record_conflict` were equally open.
//
// This is a pure service-to-service endpoint. There is no user concept in it at
// all, so it now requires the service-role key, compared in constant time.
// `verify_jwt` stays false at the platform level so service-role callers are
// not rejected before reaching this code.
//
// DEFECT 2026-09-19 — THE LOCK DID NOT LOCK.
//
// `acquire` used a PostgREST upsert:
//   .upsert({...}, { onConflict: 'operation_id', ignoreDuplicates: false })
// which emits INSERT ... ON CONFLICT (operation_id) DO UPDATE SET ... with NO
// WHERE clause. PostgREST cannot express a conditional DO UPDATE, so the
// documented mechanism — "DO UPDATE ... WHERE operation_locks.expires_at <=
// NOW()", quoted in this file's own test list — was never actually emitted.
// The upsert therefore overwrote any existing lock unconditionally, expired or
// not. Every check that followed then read the row AFTER that overwrite:
//   - `lockRow.lock_owner !== lock_owner` compared the caller's own freshly
//     written owner against itself, so LOCK_HELD could never be returned;
//   - `lockRow.attempt_id !== attempt_id` likewise compared the just-written
//     attempt_id against itself, so `idempotent` could never be returned.
// The net effect: EVERY caller always won the lock, silently evicting whoever
// held it, and got `{ acquired: true }`. Two workers could hold "the" lock on
// the same operation at the same time and each believed it held it exclusively
// — the exact concurrent-mutation scenario this module exists to prevent, on
// itinerary changes, health recalculation and alert scoring alike.
//
// Acquisition is now genuinely conditional:
//   1. A plain INSERT. UNIQUE(operation_id) makes this the atomic "no lock
//      exists" path; a 23505 means somebody already holds one.
//   2. On 23505, a conditional UPDATE ... WHERE operation_id = $1 AND
//      expires_at <= now(). Under READ COMMITTED Postgres re-evaluates that
//      predicate after taking the row lock, so of two workers racing to steal
//      the same expired lock exactly one sees it as still expired and the
//      other sees the winner's future expires_at and matches zero rows.
//   3. If zero rows were updated the lock is live: the holder is read back and
//      returned as LOCK_HELD (409), or as an idempotent success if the holder
//      is the same lock_owner asking again.
const LOCK_LEASE_DURATION_MS = {
  MONITORING_SOURCE: 60_000,
  CHANGE_DETECTION: 30_000,
  TRIP_IMPACT: 30_000,
  TRAVEL_ALERT: 30_000,
  ALERT_SCORING: 15_000,
  NOTIFICATION_ELIGIBILITY: 15_000,
  COPILOT_CONTEXT: 45_000,
  ITINERARY_CHANGE: 120_000,
  HEALTH_RECALCULATION: 60_000,
  FRICTION_RECALCULATION: 60_000,
  READINESS_RECALCULATION: 60_000,
  ISSUES_RECALCULATION: 60_000,
  DEFAULT: 30_000
};
function getLeaseDuration(operation_type) {
  if (!operation_type) return LOCK_LEASE_DURATION_MS.DEFAULT;
  return LOCK_LEASE_DURATION_MS[operation_type] ?? LOCK_LEASE_DURATION_MS.DEFAULT;
}
// NOTE 2026-09-16: every "test" below returns a hardcoded `true`. Nothing is
// executed or asserted — these are descriptions of intended behaviour formatted
// to look like a passing suite, and `run_concurrency_tests` will report 20/20
// passing on a completely broken system. Preserved verbatim so the endpoint's
// response shape does not change, but do not treat its output as evidence.
//
// 2026-09-19: this is not hypothetical. Tests 1, 12, 13 and 16 all asserted
// "passed" about the conditional lock acquisition described above, which was
// never actually implemented. The suite reported 20/20 for months while the
// lock granted itself to everyone.
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
    mechanism: 'INSERT ... ON CONFLICT (operation_id) DO UPDATE SET ... WHERE operation_locks.expires_at <= NOW()',
    atomic: true
  });
  addTest(2, 'Two workers attempt same retry → only one proceeds, attempt_number increments once', true, {
    mechanism: 'Lock acquisition gate; only lock holder calls begin_attempt',
    note: 'attempt_number incremented exactly once per lock acquisition'
  });
  addTest(3, 'Cancellation races with retry → RETRY_PENDING → CANCELLED wins', true, {
    cancelled_is_terminal: true,
    transition_valid: true,
    note: 'First writer to set CANCELLED wins; immutability guard blocks retry'
  });
  addTest(4, 'Recovery races with retry → SUCCESS confirmed, retry blocked', true, {
    mechanism: 'SUCCESS is terminal; late_failure_received=true on late failure signal',
    note: 'Immutability guard returns HTTP 409 for any write to SUCCESS record'
  });
  addTest(5, 'Two workers process same MonitoringEvent → idempotency_key deduplicates', true, {
    key_pattern: 'monitoring_event:{fingerprint}:{trip_id}',
    mechanism: 'INSERT ON CONFLICT DO NOTHING + SELECT; second worker sees COMPLETE or IN_PROGRESS'
  });
  addTest(6, 'Two workers create same TravelAlert → fingerprint deduplicates', true, {
    key_pattern: 'travel_alert:{fingerprint}:{trip_id}',
    mechanism: 'idempotency_key check before alert creation; second worker returns existing result_id'
  });
  addTest(7, 'Two workers evaluate notification eligibility → duplicate suppression', true, {
    key_pattern: 'notif_eligibility:{alert_id}:{channel}',
    mechanism: 'idempotency_key check; second worker sees IN_PROGRESS or COMPLETE'
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
    mechanism: '7-step stale validation step 5: itinerary_version_unchanged check',
    outcome: 'CANCELLED_STALE for older operation'
  });
  addTest(11, 'Older Health calc finishes after newer version active → older marked stale', true, {
    mechanism: 'Version guard UPDATE WHERE EXISTS(is_active=TRUE); 0 rows → CANCELLED_STALE on recovery log'
  });
  addTest(12, 'Worker crashes while holding lock → force_release_expired → UNKNOWN', true, {
    mechanism: 'force_release_expired action; UNKNOWN is reconcilable (not terminal)',
    note: 'Worker crash → outcome uncertain → UNKNOWN state'
  });
  addTest(13, 'Lock expires during evaluation → new worker acquires after expiry', true, {
    mechanism: 'INSERT ON CONFLICT DO UPDATE WHERE operation_locks.expires_at <= NOW()',
    note: 'Expired lock treated as no lock; new worker acquires atomically'
  });
  addTest(14, 'Duplicate processing after infra timeout → idempotency_key returns existing result', true, {
    mechanism: 'check_or_create returns COMPLETE with result_id; caller uses existing result without reprocessing'
  });
  addTest(15, 'Terminal state receives late worker result → SUCCESS_PRESERVED / HTTP 409', true, {
    success_case: 'SUCCESS_PRESERVED with late_failure_received=true',
    other_terminal: 'HTTP 409 from checkTerminalImmutability'
  });
  addTest(16, 'Attempt number correct under concurrency → exactly 1 increment per attempt', true, {
    mechanism: 'Lock gate ensures only one worker calls begin_attempt; attempt_number = previous + 1'
  });
  addTest(17, 'Retry count correct under concurrency → retry_count = attempt_number - 1', true, {
    invariant: 'retry_count = attempt_number - 1 (attempt 1 = initial, no retry)',
    mechanism: 'Lock gate + single-writer guarantee'
  });
  addTest(18, 'No duplicate downstream records → idempotency_keys table has 1 row per key', true, {
    mechanism: 'UNIQUE constraint on idempotency_keys.idempotency_key; INSERT ON CONFLICT DO NOTHING'
  });
  addTest(19, 'Stale proposal cannot activate itinerary → CANCELLED_STALE', true, {
    mechanism: 'Atomic activation UPDATE WHERE EXISTS; 0 rows → BASE_VERSION_SUPERSEDED → CANCELLED_STALE'
  });
  addTest(20, 'Active itinerary version cannot be overwritten by older operation → newer wins', true, {
    mechanism: 'UPDATE WHERE EXISTS(is_active=TRUE AND id=$expected_base); newer active version blocks older write',
    note: 'Newer version wins; older operation → CANCELLED_STALE'
  });
  return results;
}
Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: corsHeaders
    });
  }
  if (req.method !== 'POST') return err('Method not allowed', 405);
  // SECURITY GATE — must run before any database work.
  const gate = requireService(req);
  if (gate instanceof Response) return gate;
  const service = serviceClient();
  let body;
  try {
    body = await req.json();
  } catch  {
    return err('Invalid JSON body');
  }
  const action = body.action;
  if (!action) return err('action is required');
  if (action === 'run_concurrency_tests') {
    const results = runConcurrencyTests();
    const passed = results.filter((r)=>r.passed).length;
    const failed = results.filter((r)=>!r.passed).length;
    return json({
      total: results.length,
      passed,
      failed,
      results,
      warning: 'These assertions are hardcoded and execute nothing. Do not treat this output as evidence of correctness.'
    });
  }
  // ── acquire ────────────────────────────────────────────────
  if (action === 'acquire') {
    const operation_id = body.operation_id;
    const operation_type = body.operation_type;
    const trip_id = body.trip_id;
    const attempt_number = body.attempt_number ?? 1;
    const lock_owner = body.lock_owner;
    if (!operation_id) return err('operation_id is required');
    if (!lock_owner) return err('lock_owner is required');
    const lease_ms = getLeaseDuration(operation_type);
    // Bounded retry: the only way round this loop is the narrow race where the
    // existing lock is deleted between our failed INSERT and our read-back.
    for(let attempt = 0; attempt < 3; attempt++){
      const attempt_id = crypto.randomUUID();
      const now = new Date();
      const now_iso = now.toISOString();
      const expires_at = new Date(now.getTime() + lease_ms).toISOString();
      // 1. No lock exists — atomic on UNIQUE(operation_id).
      const inserted = await service.from('operation_locks').insert({
        operation_id,
        attempt_id,
        lock_owner,
        acquired_at: now_iso,
        expires_at,
        trip_id: trip_id ?? null,
        operation_type: operation_type ?? null,
        attempt_number,
        current_state: 'ATTEMPTING',
        created_at: now_iso
      }).select().single();
      if (!inserted.error) {
        const { error: logError } = await service.from('pipeline_recovery_log').update({
          lock_acquired_at: now_iso,
          lock_owner,
          attempt_id,
          updated_at: now_iso
        }).eq('operation_id', operation_id);
        if (logError) {
          console.error('[operation-lock] recovery log update failed:', logError.code, logError.message);
        }
        return json({
          acquired: true,
          attempt_id,
          lock_owner,
          expires_at
        });
      }
      // 23505 = unique_violation: a lock row already exists.
      if (inserted.error.code !== '23505') {
        return err(`Lock acquisition failed: ${inserted.error.message}`, 500);
      }
      // 2. Take over ONLY if the existing lease has expired.
      const stolen = await service.from('operation_locks').update({
        attempt_id,
        lock_owner,
        acquired_at: now_iso,
        expires_at,
        last_renewed_at: null,
        trip_id: trip_id ?? null,
        operation_type: operation_type ?? null,
        attempt_number,
        current_state: 'ATTEMPTING'
      }).eq('operation_id', operation_id).lte('expires_at', now_iso).select();
      if (stolen.error) {
        return err(`Lock acquisition failed: ${stolen.error.message}`, 500);
      }
      if (stolen.data && stolen.data.length > 0) {
        const { error: logError } = await service.from('pipeline_recovery_log').update({
          lock_acquired_at: now_iso,
          lock_owner,
          attempt_id,
          updated_at: now_iso
        }).eq('operation_id', operation_id);
        if (logError) {
          console.error('[operation-lock] recovery log update failed:', logError.code, logError.message);
        }
        return json({
          acquired: true,
          attempt_id,
          lock_owner,
          expires_at,
          took_over_expired_lock: true
        });
      }
      // 3. The lock is live. Report who holds it.
      const current = await service.from('operation_locks').select('lock_owner, expires_at, attempt_id').eq('operation_id', operation_id).maybeSingle();
      if (current.error) {
        return err(`Lock acquisition failed: ${current.error.message}`, 500);
      }
      // Released between our INSERT and this read — go round again.
      if (!current.data) continue;
      if (current.data.lock_owner === lock_owner) {
        // Same owner asking again: idempotent success, returning the lock they
        // already hold rather than a second, conflicting attempt_id.
        return json({
          acquired: true,
          idempotent: true,
          attempt_id: current.data.attempt_id,
          lock_owner: current.data.lock_owner,
          expires_at: current.data.expires_at
        });
      }
      return json({
        error: 'LOCK_HELD',
        lock_owner: current.data.lock_owner,
        expires_at: current.data.expires_at,
        attempt_id: null
      }, 409);
    }
    return json({
      error: 'LOCK_CONTENTION',
      message: 'Could not settle lock state after repeated attempts; treat the lock as held.',
      attempt_id: null
    }, 409);
  }
  // ── release ────────────────────────────────────────────────
  if (action === 'release') {
    const operation_id = body.operation_id;
    const attempt_id = body.attempt_id;
    const lock_owner = body.lock_owner;
    const outcome = body.outcome;
    if (!operation_id) return err('operation_id is required');
    if (!attempt_id) return err('attempt_id is required');
    if (!lock_owner) return err('lock_owner is required');
    // DEFECT 2026-09-19 — the error was discarded, so a failed read reported
    // LOCK_NOT_OWNED ("Lock not found"), telling a worker that genuinely held
    // the lock that it did not.
    const { data: lockRow, error: readError } = await service.from('operation_locks').select('*').eq('operation_id', operation_id).maybeSingle();
    if (readError) return err(`Lock read failed: ${readError.message}`, 500);
    if (!lockRow) {
      return json({
        error: 'LOCK_NOT_OWNED',
        message: 'Lock not found'
      }, 409);
    }
    if (lockRow.lock_owner !== lock_owner || lockRow.attempt_id !== attempt_id) {
      return json({
        error: 'LOCK_NOT_OWNED',
        message: 'Lock belongs to different owner or attempt'
      }, 409);
    }
    // DEFECT 2026-09-19 — this delete's error was discarded and `{ released:
    // true }` was returned regardless. A failed delete left the lock in place
    // for its full remaining lease while the holder moved on believing it had
    // let go, blocking every subsequent worker for that whole window.
    // The delete is re-scoped to the owner/attempt so it cannot race with a
    // concurrent takeover of an expired lease.
    const { data: deleted, error: deleteError } = await service.from('operation_locks').delete().eq('operation_id', operation_id).eq('lock_owner', lock_owner).eq('attempt_id', attempt_id).select('operation_id');
    if (deleteError) return err(`Lock release failed: ${deleteError.message}`, 500);
    if (!deleted || deleted.length === 0) {
      return json({
        error: 'LOCK_NOT_OWNED',
        message: 'Lock was taken over by another owner before release'
      }, 409);
    }
    const now_iso = new Date().toISOString();
    const { error: logError } = await service.from('pipeline_recovery_log').update({
      lock_released_at: now_iso,
      updated_at: now_iso
    }).eq('operation_id', operation_id);
    if (logError) {
      console.error('[operation-lock] recovery log update failed:', logError.code, logError.message);
    }
    return json({
      released: true,
      outcome: outcome ?? null
    });
  }
  // ── renew ──────────────────────────────────────────────────
  if (action === 'renew') {
    const operation_id = body.operation_id;
    const attempt_id = body.attempt_id;
    const lock_owner = body.lock_owner;
    if (!operation_id) return err('operation_id is required');
    if (!attempt_id) return err('attempt_id is required');
    if (!lock_owner) return err('lock_owner is required');
    const { data: lockRow, error: readError } = await service.from('operation_locks').select('*').eq('operation_id', operation_id).maybeSingle();
    if (readError) return err(`Lock read failed: ${readError.message}`, 500);
    if (!lockRow) {
      return json({
        error: 'LOCK_NOT_OWNED',
        message: 'Lock not found'
      }, 409);
    }
    if (lockRow.lock_owner !== lock_owner || lockRow.attempt_id !== attempt_id) {
      return json({
        error: 'LOCK_NOT_OWNED',
        message: 'Lock belongs to different owner or attempt'
      }, 409);
    }
    const lease_ms = getLeaseDuration(lockRow.operation_type ?? undefined);
    const now = new Date();
    const new_expires_at = new Date(now.getTime() + lease_ms).toISOString();
    // DEFECT 2026-09-19 — the error and the affected-row count were both
    // discarded and `{ renewed: true, expires_at }` was returned regardless.
    // A holder whose renewal silently failed carried on working against a lease
    // that had already lapsed, and another worker took the lock out from under
    // it — producing exactly the concurrent mutation the lease exists to stop.
    // Now re-scoped to owner/attempt and verified.
    const { data: renewed, error: renewError } = await service.from('operation_locks').update({
      expires_at: new_expires_at,
      last_renewed_at: now.toISOString()
    }).eq('operation_id', operation_id).eq('lock_owner', lock_owner).eq('attempt_id', attempt_id).select('operation_id');
    if (renewError) return err(`Lock renewal failed: ${renewError.message}`, 500);
    if (!renewed || renewed.length === 0) {
      return json({
        error: 'LOCK_NOT_OWNED',
        message: 'Lock was taken over by another owner before renewal'
      }, 409);
    }
    return json({
      renewed: true,
      expires_at: new_expires_at
    });
  }
  // ── check ──────────────────────────────────────────────────
  if (action === 'check') {
    const operation_id = body.operation_id;
    if (!operation_id) return err('operation_id is required');
    // DEFECT 2026-09-19 — the most dangerous discarded error in this file. On a
    // failed read, `lockRow` was null and this returned `{ locked: false }`,
    // i.e. it told the caller the operation was free to run. A caller acting on
    // that starts work that something else is already doing.
    const { data: lockRow, error: readError } = await service.from('operation_locks').select('*').eq('operation_id', operation_id).maybeSingle();
    if (readError) return err(`Lock read failed: ${readError.message}`, 500);
    if (!lockRow) return json({
      locked: false,
      is_expired: false
    });
    const is_expired = new Date(lockRow.expires_at) <= new Date();
    return json({
      locked: !is_expired,
      lock_owner: lockRow.lock_owner,
      expires_at: lockRow.expires_at,
      attempt_id: lockRow.attempt_id,
      is_expired
    });
  }
  // ── force_release_expired ────────────────────────────────────────
  if (action === 'force_release_expired') {
    const operation_id = body.operation_id;
    if (!operation_id) return err('operation_id is required');
    const { data: lockRow, error: readError } = await service.from('operation_locks').select('*').eq('operation_id', operation_id).maybeSingle();
    if (readError) return err(`Lock read failed: ${readError.message}`, 500);
    if (!lockRow) {
      return json({
        error: 'LOCK_NOT_FOUND',
        message: 'No lock found for this operation_id'
      }, 404);
    }
    const now = new Date();
    const now_iso = now.toISOString();
    const is_expired = new Date(lockRow.expires_at) <= now;
    if (!is_expired) {
      return json({
        error: 'LOCK_NOT_EXPIRED',
        message: 'Lock is still valid and has not expired'
      }, 409);
    }
    // Re-assert expiry in the delete itself so this cannot remove a lock that a
    // legitimate worker acquired in the moment between the read and the write.
    const { data: deleted, error: deleteError } = await service.from('operation_locks').delete().eq('operation_id', operation_id).lte('expires_at', now_iso).select('operation_id');
    if (deleteError) return err(`Force release failed: ${deleteError.message}`, 500);
    if (!deleted || deleted.length === 0) {
      return json({
        error: 'LOCK_NOT_EXPIRED',
        message: 'Lock was re-acquired before it could be force released'
      }, 409);
    }
    const { data: recoveryRecord, error: recoveryError } = await service.from('pipeline_recovery_log').select('id, recovery_status, transition_log, attempt_number').eq('operation_id', operation_id).order('created_at', {
      ascending: false
    }).limit(1).maybeSingle();
    if (recoveryError) {
      console.error('[operation-lock] recovery log read failed:', recoveryError.code, recoveryError.message);
    }
    const previous_state = recoveryRecord?.recovery_status ?? null;
    let recovery_state_recorded = false;
    if (recoveryRecord) {
      const currentLog = Array.isArray(recoveryRecord.transition_log) ? recoveryRecord.transition_log : [];
      const transitionEntry = {
        from: previous_state,
        to: 'UNKNOWN',
        condition: 'lock expired — worker crash assumed, outcome uncertain',
        timestamp: now_iso,
        attempt_number: recoveryRecord.attempt_number ?? 0,
        reason: 'force_release_expired: lock TTL exceeded without release'
      };
      // DEFECT 2026-09-19 — this error was discarded and the response claimed
      // new_state: 'UNKNOWN' regardless. The recovery log could still read
      // IN_PROGRESS while the response asserted the operation had been marked
      // uncertain, so reconciliation never ran on it.
      const { error: updateError } = await service.from('pipeline_recovery_log').update({
        recovery_status: 'UNKNOWN',
        lock_released_at: now_iso,
        transition_log: [
          ...currentLog,
          transitionEntry
        ],
        updated_at: now_iso
      }).eq('id', recoveryRecord.id);
      if (updateError) {
        console.error('[operation-lock] recovery status update failed:', updateError.code, updateError.message);
      } else {
        recovery_state_recorded = true;
      }
    }
    return json({
      released: true,
      previous_state,
      new_state: recovery_state_recorded ? 'UNKNOWN' : null,
      recovery_state_recorded,
      note: recovery_state_recorded ? 'Lock expired — outcome uncertain. Reconciliation required before retry.' : 'Lock expired and was released, but the recovery log was NOT updated to UNKNOWN. Reconcile manually.'
    });
  }
  // ── record_conflict ───────────────────────────────────────────
  if (action === 'record_conflict') {
    const operation_id = body.operation_id;
    const blocked_owner = body.blocked_owner;
    const blocked_attempt_id = body.blocked_attempt_id;
    const reason = body.reason;
    if (!operation_id) return err('operation_id is required');
    const { data: recoveryRecord, error: readError } = await service.from('pipeline_recovery_log').select('id, concurrency_conflict_count, concurrency_conflict_log').eq('operation_id', operation_id).order('created_at', {
      ascending: false
    }).limit(1).maybeSingle();
    if (readError) return err(`Recovery log read failed: ${readError.message}`, 500);
    if (!recoveryRecord) return err('Recovery log record not found for operation_id', 404);
    const now_iso = new Date().toISOString();
    const currentLog = Array.isArray(recoveryRecord.concurrency_conflict_log) ? recoveryRecord.concurrency_conflict_log : [];
    const conflictEntry = {
      blocked_owner: blocked_owner ?? null,
      blocked_attempt_id: blocked_attempt_id ?? null,
      reason: reason ?? 'LOCK_HELD',
      recorded_at: now_iso
    };
    const nextCount = (recoveryRecord.concurrency_conflict_count ?? 0) + 1;
    // Previously the error was discarded and the new count was returned as if
    // stored — conflict telemetry that looked recorded and was not.
    const { error: updateError } = await service.from('pipeline_recovery_log').update({
      concurrency_conflict_count: nextCount,
      concurrency_conflict_log: [
        ...currentLog,
        conflictEntry
      ],
      updated_at: now_iso
    }).eq('id', recoveryRecord.id);
    if (updateError) return err(`Failed to record conflict: ${updateError.message}`, 500);
    return json({
      recorded: true,
      conflict_count: nextCount
    });
  }
  return err('Unknown action');
});

// SECURITY 2026-09-16 — This function had no authentication of any kind: the
// handler went straight from the OPTIONS/method check into building a
// service_role Supabase client and processing the request body, with no check
// of the Authorization header anywhere. Any anonymous caller on the internet
// could invoke every action, including:
//   - `fail_record`, which flips an idempotency_records row back to FAILED
//     and thereby re-permits a replay of work that had already succeeded, and
//   - `complete`, which marks an idempotency_keys row COMPLETE without the
//     work ever having run, causing the real job to be silently dropped
//     while every future check_or_create call reports it as already done.
// An attacker (or a buggy unauthenticated client) needed only the function's
// URL to corrupt pipeline dedup state for any operation_id/idempotency_key it
// could guess or observe.
//
// This endpoint is pure service-to-service plumbing for pipeline workers —
// there is no end-user identity concept anywhere in it. The gate below now
// requires the caller to present the Supabase service-role key (compared in
// constant time), the same treatment already deployed on `operation-lock`.
// verify_jwt stays false at the platform level so a service-role bearer token
// (which is not a user JWT) reaches this code instead of being rejected first.
//
// DEFECT 2026-09-19 (failure-looks-like-success) — all four mutating actions
// (`complete`, `fail`, `complete_record`, `fail_record`) issued a PostgREST
// UPDATE and checked only `updateErr`. An UPDATE that matches ZERO rows is not
// an error in PostgREST — it succeeds and changes nothing. So when the key did
// not exist (never created, cleaned up, or misspelled by the caller), every one
// of these returned `{ completed: true }` / `{ failed: true }` while writing
// nothing at all. The consequence is precisely the thing this module exists to
// prevent: a worker finishes real work, calls `complete`, is told the key is
// recorded as COMPLETE, and the next `check_or_create` for that key finds no
// row, creates a fresh PENDING one, and the whole operation runs a second time
// — a duplicate alert, a duplicate itinerary version, a duplicate notification.
// Every mutation now returns the rows it touched and a zero-row result is
// reported as a 404 instead of a success.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { requireService, serviceClient, corsHeaders, json, fail } from './_shared/auth.ts';
function err(msg, status = 400) {
  return fail(msg, status);
}
// ──────────────────────────────────────────────────────────────────────
// IDEMPOTENCY KEY PATTERNS
// ──────────────────────────────────────────────────────────────────────
export const IDEMPOTENCY_KEY_PATTERNS = {
  monitoring_event: (fingerprint, trip_id)=>`monitoring_event:${fingerprint}:${trip_id}`,
  trip_impact: (event_id, entity_id)=>`trip_impact:${event_id}:${entity_id}`,
  travel_alert: (fingerprint, trip_id)=>`travel_alert:${fingerprint}:${trip_id}`,
  notification_eligibility: (alert_id, channel)=>`notif_eligibility:${alert_id}:${channel}`,
  copilot_proposal: (proposal_id)=>`copilot_proposal:${proposal_id}`,
  itinerary_version: (trip_id, base_version_id, proposal_id)=>`itinerary_version:${trip_id}:${base_version_id}:${proposal_id}`,
  health_recalculation: (trip_id, version_id)=>`health_recalc:${trip_id}:${version_id}`,
  readiness_recalculation: (trip_id, version_id)=>`readiness_recalc:${trip_id}:${version_id}`
};
// ──────────────────────────────────────────────────────────────────────
// MAIN HANDLER
// ──────────────────────────────────────────────────────────────────────
Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: corsHeaders
    });
  }
  const gate = requireService(req);
  if (gate instanceof Response) return gate;
  if (req.method !== 'POST') return err('Method not allowed', 405);
  const client = serviceClient();
  let body;
  try {
    body = await req.json();
  } catch  {
    return err('Invalid JSON body');
  }
  const action = body.action;
  if (!action) return err('action is required');
  // ── check_or_create ───────────────────────────────────────────────────
  if (action === 'check_or_create') {
    const idempotency_key = body.idempotency_key;
    const operation_id = body.operation_id;
    const result_type = body.result_type;
    const ttl_seconds = body.ttl_seconds;
    if (!idempotency_key) return err('idempotency_key is required');
    if (!operation_id) return err('operation_id is required');
    const now = new Date();
    const expires_at = ttl_seconds ? new Date(now.getTime() + ttl_seconds * 1000).toISOString() : null;
    const { error: insertErr } = await client.from('idempotency_keys').insert({
      idempotency_key,
      operation_id,
      result_type: result_type ?? null,
      status: 'PENDING',
      expires_at
    });
    const wasInserted = !insertErr;
    const isConflict = insertErr?.code === '23505';
    if (insertErr && !isConflict) {
      return err(`Failed to create idempotency key: ${insertErr.message}`, 500);
    }
    const { data: row, error: selectErr } = await client.from('idempotency_keys').select('*').eq('idempotency_key', idempotency_key).maybeSingle();
    if (selectErr) {
      console.error('[idempotency-guard] key read failed:', selectErr.code, selectErr.message);
      return err(`Failed to fetch idempotency key record: ${selectErr.message}`, 500);
    }
    if (!row) {
      // The row was deleted between our insert/conflict and this read. Say so
      // rather than reporting a state we did not observe.
      return err('Idempotency key disappeared between create and read; retry', 409);
    }
    // NOTE 2026-09-19: `expires_at` is written on create but has never gated
    // anything here — only the `check` action ever computed is_expired. A
    // COMPLETE key therefore suppresses its operation forever, regardless of
    // the ttl_seconds the caller asked for. That is the safe direction (no
    // duplicate work), so the gating is deliberately left as-is, but the flag
    // is now surfaced so a caller can see that the TTL it requested is not
    // being honoured instead of assuming it is.
    const is_expired = row.expires_at ? new Date(row.expires_at) <= now : false;
    if (row.status === 'COMPLETE') {
      return json({
        exists: true,
        result_id: row.result_id,
        result_type: row.result_type,
        status: 'COMPLETE',
        completed_at: row.completed_at,
        is_expired,
        ttl_enforced: false
      });
    }
    if (row.status === 'FAILED') {
      return json({
        exists: false,
        status: 'FAILED',
        is_expired,
        note: 'Previous attempt failed — caller may retry'
      });
    }
    if (row.status === 'PENDING') {
      if (wasInserted) {
        return json({
          exists: false,
          status: 'PENDING',
          note: 'Caller may proceed with processing'
        });
      } else {
        return json({
          exists: true,
          status: 'IN_PROGRESS',
          is_expired,
          note: 'Another worker is processing this key — caller must wait or exit'
        });
      }
    }
    return json({
      exists: true,
      status: row.status,
      is_expired
    });
  }
  // ── complete ──────────────────────────────────────────────────────────
  if (action === 'complete') {
    const idempotency_key = body.idempotency_key;
    const result_id = body.result_id;
    const result_type = body.result_type;
    if (!idempotency_key) return err('idempotency_key is required');
    const now_iso = new Date().toISOString();
    const { data: updated, error: updateErr } = await client.from('idempotency_keys').update({
      status: 'COMPLETE',
      result_id: result_id ?? null,
      result_type: result_type ?? null,
      completed_at: now_iso
    }).eq('idempotency_key', idempotency_key).select('idempotency_key');
    if (updateErr) {
      return err(`Failed to complete idempotency key: ${updateErr.message}`, 500);
    }
    // See the header note: a zero-row UPDATE used to be reported as success,
    // which let the same operation run again on the next pass.
    if (!updated || updated.length === 0) {
      return err('Idempotency key not found — nothing was marked COMPLETE', 404);
    }
    return json({
      completed: true,
      idempotency_key,
      result_id: result_id ?? null
    });
  }
  // ── fail ─────────────────────────────────────────────────────────────
  if (action === 'fail') {
    const idempotency_key = body.idempotency_key;
    if (!idempotency_key) return err('idempotency_key is required');
    const now_iso = new Date().toISOString();
    const { data: updated, error: updateErr } = await client.from('idempotency_keys').update({
      status: 'FAILED',
      completed_at: now_iso
    }).eq('idempotency_key', idempotency_key).select('idempotency_key');
    if (updateErr) {
      return err(`Failed to mark idempotency key as failed: ${updateErr.message}`, 500);
    }
    if (!updated || updated.length === 0) {
      return err('Idempotency key not found — nothing was marked FAILED', 404);
    }
    return json({
      failed: true,
      idempotency_key,
      note: 'Status set to FAILED — retry is permitted on next attempt'
    });
  }
  // ── check ───────────────────────────────────────────────────────────
  if (action === 'check') {
    const idempotency_key = body.idempotency_key;
    if (!idempotency_key) return err('idempotency_key is required');
    const { data: row, error: selectErr } = await client.from('idempotency_keys').select('*').eq('idempotency_key', idempotency_key).maybeSingle();
    if (selectErr) {
      return err(`Failed to check idempotency key: ${selectErr.message}`, 500);
    }
    if (!row) {
      return json({
        exists: false,
        idempotency_key
      });
    }
    const now = new Date();
    const is_expired = row.expires_at ? new Date(row.expires_at) <= now : false;
    return json({
      exists: true,
      idempotency_key: row.idempotency_key,
      operation_id: row.operation_id,
      result_id: row.result_id,
      result_type: row.result_type,
      status: row.status,
      created_at: row.created_at,
      completed_at: row.completed_at,
      expires_at: row.expires_at,
      is_expired
    });
  }
  // ── get_patterns ────────────────────────────────────────────────────
  if (action === 'get_patterns') {
    return json({
      patterns: {
        monitoring_event: 'monitoring_event:{fingerprint}:{trip_id}',
        trip_impact: 'trip_impact:{event_id}:{entity_id}',
        travel_alert: 'travel_alert:{fingerprint}:{trip_id}',
        notification_eligibility: 'notif_eligibility:{alert_id}:{channel}',
        copilot_proposal: 'copilot_proposal:{proposal_id}',
        itinerary_version: 'itinerary_version:{trip_id}:{base_version_id}:{proposal_id}',
        health_recalculation: 'health_recalc:{trip_id}:{version_id}',
        readiness_recalculation: 'readiness_recalc:{trip_id}:{version_id}'
      }
    });
  }
  // ── check_or_create_record ────────────────────────────────────────────
  // Uses idempotency_records (new canonical table) with user-scoped UNIQUE key
  if (action === 'check_or_create_record') {
    const idempotency_key = body.idempotency_key;
    const user_id = body.user_id;
    const trip_id = body.trip_id;
    const operation_type = body.operation_type;
    const request_fingerprint = body.request_fingerprint;
    const request_hash = body.request_hash;
    const ttl_seconds = body.ttl_seconds;
    if (!idempotency_key) return err('idempotency_key is required');
    if (!user_id) return err('user_id is required');
    const now = new Date();
    const expires_at = ttl_seconds ? new Date(now.getTime() + ttl_seconds * 1000).toISOString() : null;
    // Step 1: Attempt atomic INSERT ... ON CONFLICT DO NOTHING
    const { error: insertErr } = await client.from('idempotency_records').insert({
      idempotency_key,
      user_id,
      trip_id: trip_id ?? null,
      operation_type: operation_type ?? null,
      request_fingerprint: request_fingerprint ?? null,
      request_hash: request_hash ?? null,
      status: 'IN_PROGRESS',
      expires_at
    });
    const wasInserted = !insertErr;
    const isConflict = insertErr?.code === '23505';
    if (insertErr && !isConflict) {
      return err(`Failed to create idempotency record: ${insertErr.message}`, 500);
    }
    // Step 2: SELECT the row
    const { data: row, error: selectErr } = await client.from('idempotency_records').select('*').eq('user_id', user_id).eq('idempotency_key', idempotency_key).maybeSingle();
    if (selectErr) {
      console.error('[idempotency-guard] record read failed:', selectErr.code, selectErr.message);
      return err(`Failed to fetch idempotency record: ${selectErr.message}`, 500);
    }
    if (!row) {
      return err('Idempotency record disappeared between create and read; retry', 409);
    }
    // Step 3: Fingerprint mismatch check.
    //
    // DEFECT 2026-09-19 — this returned HTTP 200. A caller doing the normal
    // `if (!response.ok) throw` saw success and carried straight on to perform
    // a DIFFERENT request under a key that already belongs to another one —
    // the exact collision the fingerprint exists to catch. It is a conflict, so
    // it now answers 409. The response body is unchanged for callers that
    // switch on `status`.
    if (!wasInserted && request_fingerprint && row.request_fingerprint && row.request_fingerprint !== request_fingerprint) {
      return json({
        exists: true,
        status: 'FINGERPRINT_CONFLICT',
        error: 'FINGERPRINT_CONFLICT',
        message: 'Same key, different request fingerprint'
      }, 409);
    }
    // Step 4: Determine response based on status
    if (wasInserted) {
      return json({
        exists: false,
        status: 'IN_PROGRESS',
        note: 'Caller may proceed'
      });
    }
    if (row.status === 'IN_PROGRESS') {
      return json({
        exists: true,
        status: 'IN_PROGRESS',
        note: 'Another worker is processing'
      });
    }
    if (row.status === 'SUCCEEDED') {
      return json({
        exists: true,
        status: 'SUCCEEDED',
        response_reference: row.response_reference,
        operation_id: row.operation_id
      });
    }
    // Also previously a 200: a terminal key is a refusal to proceed, not a
    // green light.
    if (row.status === 'CANCELLED' || row.status === 'STALE') {
      return json({
        exists: true,
        status: row.status,
        error: 'IDEMPOTENCY_KEY_TERMINAL'
      }, 409);
    }
    return json({
      exists: true,
      status: row.status
    });
  }
  // ── complete_record ──────────────────────────────────────────────────
  if (action === 'complete_record') {
    const idempotency_key = body.idempotency_key;
    const user_id = body.user_id;
    const response_reference = body.response_reference;
    if (!idempotency_key) return err('idempotency_key is required');
    if (!user_id) return err('user_id is required');
    const now_iso = new Date().toISOString();
    const { data: updated, error: updateErr } = await client.from('idempotency_records').update({
      status: 'SUCCEEDED',
      response_reference: response_reference ?? null,
      completed_at: now_iso
    }).eq('user_id', user_id).eq('idempotency_key', idempotency_key).select('idempotency_key');
    if (updateErr) {
      return err(`Failed to complete idempotency record: ${updateErr.message}`, 500);
    }
    if (!updated || updated.length === 0) {
      return err('Idempotency record not found for this user and key — nothing was marked SUCCEEDED', 404);
    }
    return json({
      completed: true,
      idempotency_key,
      response_reference: response_reference ?? null
    });
  }
  // ── fail_record ──────────────────────────────────────────────────────
  if (action === 'fail_record') {
    const idempotency_key = body.idempotency_key;
    const user_id = body.user_id;
    if (!idempotency_key) return err('idempotency_key is required');
    if (!user_id) return err('user_id is required');
    const now_iso = new Date().toISOString();
    const { data: updated, error: updateErr } = await client.from('idempotency_records').update({
      status: 'FAILED',
      completed_at: now_iso
    }).eq('user_id', user_id).eq('idempotency_key', idempotency_key).select('idempotency_key');
    if (updateErr) {
      return err(`Failed to mark idempotency record as failed: ${updateErr.message}`, 500);
    }
    if (!updated || updated.length === 0) {
      return err('Idempotency record not found for this user and key — nothing was marked FAILED', 404);
    }
    return json({
      failed: true,
      idempotency_key
    });
  }
  return err('Unknown action');
});

// PROPOSAL STATUS PATCH 2026-09-25 — PATCH validated against the real CHECK set.
//   copilot_proposals.status is CHECK (DRAFT, READY_FOR_REVIEW, APPROVED,
//   EXECUTING, EXECUTED, FAILED, CANCELLED, STALE, COMPLETE). The PATCH
//   allow-list carried REQUIRES_CLARIFICATION and NOT_FEASIBLE, which the
//   CHECK rejects (23514 → a generic 500), and it let a user move a proposal
//   from any status to any listed one — e.g. reopen a COMPLETE proposal as
//   APPROVED and execute it again. PATCH now:
//     - 400 INVALID_STATUS for anything outside the CHECK set;
//     - 400 STATUS_NOT_USER_SETTABLE for EXECUTING/EXECUTED/FAILED/STALE/COMPLETE
//       (only execute, change-plan and the stale checks write those);
//     - 400 INVALID_TRANSITION unless the move is in USER_TRANSITIONS below;
//     - same status → 200 no-op; the update is conditional on the status read,
//       so a proposal that changed meanwhile answers 409 STATUS_CHANGED.
//   GET and POST execute are unchanged. supabase-js import moved to esm.sh.
// ITINERARY RECONCILIATION 2026-09-24 — the POST execute path no longer reads
// the legacy generated_itineraries table.
//   - Base version: the proposal's base_itinerary_version_id (uuid, FK to
//     itinerary_versions), falling back to its text itinerary_version_id —
//     the two fields the proposal writers actually fill (source_itinerary_id
//     is null on every live row). Stale check = that base vs the trip's active
//     itinerary_versions row. A proposal with no recorded base is not treated
//     as stale.
//   - change-plan (v32 contract) is called with { trip_id, user_request,
//     confirmed: true, proposed_changes, proposal_id, alert_id,
//     itinerary_version_id: <active version id> }. The caller's own
//     Authorization header is forwarded (not the service-role key + a body
//     user_id), so change-plan's membership/role check applies to the real
//     caller. change-plan's 409 STALE_VERSION marks the proposal STALE.
//   - Success is change-plan status "applied" with new_version_id. The proposal
//     is marked COMPLETE (the status change-plan itself writes) with
//     result_itinerary_version_id; "already executed" accepts EXECUTED and
//     COMPLETE. The response carries new_version_id / previous_version_id;
//     new_itinerary_id is kept as a key but is always null.
//   - Health delta: get-trip-health is called with { trip_id, version_id }
//     (new analyzer contract). health_after is usually null right after an
//     edit, because the analysis for the new version has not run yet; nothing
//     is invented in that case.
//   - GET and PATCH are unchanged.
//
// CROSS-FUNCTION CALLS 2026-09-19 — the health-delta enrichment in the POST
// /execute path had never run, and could not report that it had not run.
//
// WHAT WAS WRONG
//   1. WRONG METHOD AND WRONG PLACE FOR THE ARGUMENT.
//      The call was
//        fetch(`${supabaseUrl}/functions/v1/get-trip-health?itinerary_id=${id}`,
//              { headers: { Authorization: `Bearer ${serviceRoleKey}` } })
//      i.e. a GET with the id in the query string and no body. `get-trip-health`
//      accepts POST only and reads its argument from `await req.json()`. A GET
//      carries no body, so that `req.json()` threw and the function returned
//      400 {"error":"invalid_json"} — on every call, every time, for both the
//      before and the after probe.
//      Fixed: POST with `{ itinerary_id }` as a JSON body and the
//      Content-Type header the target needs.
//
//   2. WRONG RESPONSE SHAPE.
//      The code read `healthBefore?.score` and `healthBefore?.friction_score`.
//      get-trip-health returns `{ analysis: <trip_health_analyses row> | null }`,
//      and that row's column is `health_score`, not `score`. So even if the
//      request had been well-formed, both reads were undefined and nothing was
//      ever written. Fixed: read `.analysis.health_score`.
//
//   3. NO SCALAR FRICTION EXISTS — friction_before / friction_after ARE NOT SET.
//      `trip_health_analyses` has no trip-level friction score. It has
//      `daily_friction`, a jsonb array of per-day `{day_number, friction_score,
//      friction_label, ...}` objects. Collapsing that to one number (mean? max?
//      weighted?) would be a metric invented here and comparable to nothing
//      else in the system. Rather than write a made-up value into
//      copilot_proposals.friction_before/after, they are left null and the
//      reason is recorded here. To populate them, first define the scalar in
//      the health engine (analyze-trip-health) and store it on the analysis row.
//
//   4. THE CREDENTIAL WAS ALREADY CORRECT.
//      get-trip-health gates with `requireUserOrService`, which accepts the
//      service-role key, so that part of the original call was fine. It is kept.
//
//   5. FLOATING PROMISE — NOBODY READ THE ANSWER.
//      The whole block was a bare `;(async () => { ... })()` with no await and
//      no waitUntil. A 400 is a *successful* fetch, so the inner try/catch
//      never fired; and an un-registered background promise can be killed when
//      the isolate is torn down after the response is returned, so in many runs
//      the requests were not even sent. Now registered with
//      `EdgeRuntime.waitUntil(...)` (guarded, with a `.catch` fallback), and a
//      non-2xx from either probe logs the status plus the first 300 characters
//      of the body.
//
//   6. The call to `change-plan` in the same handler was already awaited, with
//      its status and body captured into `execution_error`, and change-plan
//      gates with `requireUserOrService`, so the service-role key is correct
//      there. It is unchanged.
//
// ERROR-VS-ABSENCE 2026-09-19 — four sites used `if (error || !data) return
// 404`, which reports a broken query (a connection failure, a 42703 bad column,
// an RLS refusal) as "not found". PostgREST's `.single()` signals "no rows"
// with code PGRST116 specifically; anything else is a real failure and now
// returns 500 with a generic message, while the detail goes to the log.
//
// COLUMN AUDIT 2026-09-19 — every column referenced here was checked against
// information_schema.columns: copilot_proposals has id, user_id, trip_id,
// status, source_itinerary_id, result_itinerary_id, result_itinerary_version_id,
// change_summary, execution_error, approved_at, executed_at, updated_at,
// health_before, health_after, friction_before, friction_after;
// generated_itineraries has id, trip_id, is_active. All present.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
/**
 * PostgREST reports "query returned no rows" for `.single()` as PGRST116.
 * Any other error is a genuine failure and must not be dressed up as a 404.
 */ function isNoRows(error) {
  return !!error && error.code === 'PGRST116';
}
function buildUserRequest(proposal) {
  const parts = [];
  // (2026-09-24) Null-safe: interpreted_goal / user_request can be null on
  // live rows, and "Goal: null" used to reach the model verbatim.
  if (proposal.interpreted_goal) parts.push(`Goal: ${proposal.interpreted_goal}`);
  if (proposal.user_request) parts.push(`Original request: ${proposal.user_request}`);
  if (proposal.what_will_change) parts.push(`What will change: ${proposal.what_will_change}`);
  if (Array.isArray(proposal.proposed_changes) && proposal.proposed_changes.length > 0) {
    parts.push('Specific changes:');
    for (const change of proposal.proposed_changes){
      const text = typeof change === 'string' ? change : change?.description ?? change?.activity_name ?? null;
      if (text) parts.push(`- ${text}`);
    }
  }
  if (Array.isArray(proposal.preserved_constraints) && proposal.preserved_constraints.length > 0) {
    parts.push('Must preserve:');
    for (const constraint of proposal.preserved_constraints){
      parts.push(`- ${typeof constraint === 'string' ? constraint : JSON.stringify(constraint)}`);
    }
  }
  parts.push('Do not modify confirmed reservations unless explicitly listed above.');
  parts.push('Do not remove must-do activities unless explicitly listed above.');
  return parts.join('\n');
}
/**
 * Fetches one itinerary version's health analysis from get-trip-health.
 *
 * (2026-09-24) Body is now { trip_id, version_id } — the re-keyed analyzer
 * contract — instead of the retired { itinerary_id }.
 *
 * See CROSS-FUNCTION CALLS 2026-09-19 (1)(2)(4) at the top of this file:
 * POST + JSON body (not GET + query string), service-role key (accepted by
 * that function's requireUserOrService gate), and the score lives at
 * `analysis.health_score`.
 *
 * Returns null when the analysis is genuinely absent OR when the call failed.
 * A failure is logged with its status and body prefix; it is never turned into
 * a zero, a default or any other invented number.
 */ async function fetchHealthScore(supabaseUrl, serviceRoleKey, tripId, versionId, label) {
  try {
    const resp = await fetch(`${supabaseUrl}/functions/v1/get-trip-health`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${serviceRoleKey}`
      },
      body: JSON.stringify(versionId ? {
        trip_id: tripId,
        version_id: versionId
      } : {
        trip_id: tripId
      })
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(()=>'<unreadable body>');
      console.error(`[copilot-proposals] get-trip-health (${label}) failed: HTTP ${resp.status} ${detail.slice(0, 300)}`);
      return null;
    }
    const payload = await resp.json();
    const analysis = payload?.analysis ?? null;
    if (!analysis) {
      console.warn(`[copilot-proposals] get-trip-health (${label}): no ready analysis for trip ${tripId} version ${versionId ?? '(active)'}`);
      return null;
    }
    return typeof analysis.health_score === 'number' ? analysis.health_score : null;
  } catch (e) {
    console.error(`[copilot-proposals] get-trip-health (${label}) threw:`, e instanceof Error ? e.message : String(e));
    return null;
  }
}
Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: corsHeaders
    });
  }
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    // Auth
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
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
    const jwt = authHeader.replace('Bearer ', '');
    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const { data: { user }, error: authError } = await supabase.auth.getUser(jwt);
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
    const userId = user.id;
    // --- GET ---
    if (req.method === 'GET') {
      const url = new URL(req.url);
      const proposalId = url.searchParams.get('proposal_id');
      const tripId = url.searchParams.get('trip_id');
      const status = url.searchParams.get('status');
      // GET single proposal
      if (proposalId) {
        const { data, error } = await supabase.from('copilot_proposals').select('*').eq('id', proposalId).eq('user_id', userId).single();
        // ERROR-VS-ABSENCE 2026-09-19: only "no rows" is a 404.
        if (error && !isNoRows(error)) {
          console.error('[copilot-proposals] proposal read failed:', error.message);
          return new Response(JSON.stringify({
            error: 'Failed to fetch proposal'
          }), {
            status: 500,
            headers: {
              ...corsHeaders,
              'Content-Type': 'application/json'
            }
          });
        }
        if (!data) {
          return new Response(JSON.stringify({
            error: 'Proposal not found'
          }), {
            status: 404,
            headers: {
              ...corsHeaders,
              'Content-Type': 'application/json'
            }
          });
        }
        return new Response(JSON.stringify({
          proposal: data
        }), {
          status: 200,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      // GET list by trip_id
      if (tripId) {
        let query = supabase.from('copilot_proposals').select('*').eq('trip_id', tripId).eq('user_id', userId).order('created_at', {
          ascending: false
        });
        if (status) {
          query = query.eq('status', status);
        }
        const { data, error } = await query;
        if (error) {
          console.error('List proposals error:', error);
          return new Response(JSON.stringify({
            error: 'Failed to fetch proposals'
          }), {
            status: 500,
            headers: {
              ...corsHeaders,
              'Content-Type': 'application/json'
            }
          });
        }
        return new Response(JSON.stringify({
          proposals: data ?? []
        }), {
          status: 200,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      return new Response(JSON.stringify({
        error: 'proposal_id or trip_id is required'
      }), {
        status: 400,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // --- PATCH ---
    if (req.method === 'PATCH') {
      const body = await req.json();
      const { proposal_id, status } = body;
      if (!proposal_id || !status) {
        return new Response(JSON.stringify({
          error: 'proposal_id and status are required'
        }), {
          status: 400,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      // 2026-09-25 — see header. Status set = copilot_proposals.status CHECK.
      const ALL_STATUSES = [
        'DRAFT',
        'READY_FOR_REVIEW',
        'APPROVED',
        'EXECUTING',
        'EXECUTED',
        'FAILED',
        'CANCELLED',
        'STALE',
        'COMPLETE'
      ];
      const USER_SETTABLE = [
        'DRAFT',
        'READY_FOR_REVIEW',
        'APPROVED',
        'CANCELLED'
      ];
      const USER_TRANSITIONS = {
        DRAFT: [
          'READY_FOR_REVIEW',
          'CANCELLED'
        ],
        READY_FOR_REVIEW: [
          'APPROVED',
          'DRAFT',
          'CANCELLED'
        ],
        APPROVED: [
          'READY_FOR_REVIEW',
          'CANCELLED'
        ],
        STALE: [
          'CANCELLED'
        ],
        FAILED: [
          'CANCELLED'
        ]
      };
      const patchError = (error, message, code = 400)=>new Response(JSON.stringify({
          error,
          message
        }), {
          status: code,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      if (typeof status !== 'string' || !ALL_STATUSES.includes(status)) {
        return patchError('INVALID_STATUS', `status must be one of ${ALL_STATUSES.join(', ')}.`);
      }
      if (!USER_SETTABLE.includes(status)) {
        return patchError('STATUS_NOT_USER_SETTABLE', `${status} is set by the system when a proposal runs or goes stale; you can set ${USER_SETTABLE.join(', ')}.`);
      }
      // Verify ownership then update
      const { data: existing, error: fetchError } = await supabase.from('copilot_proposals').select('id, user_id, status').eq('id', proposal_id).eq('user_id', userId).single();
      // ERROR-VS-ABSENCE 2026-09-19.
      if (fetchError && !isNoRows(fetchError)) {
        console.error('[copilot-proposals] proposal ownership read failed:', fetchError.message);
        return new Response(JSON.stringify({
          error: 'Failed to read proposal'
        }), {
          status: 500,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      if (!existing) {
        return new Response(JSON.stringify({
          error: 'Proposal not found'
        }), {
          status: 404,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      if (existing.status === status) {
        return new Response(JSON.stringify({
          success: true,
          status,
          unchanged: true
        }), {
          status: 200,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      const allowedNext = USER_TRANSITIONS[existing.status] ?? [];
      if (!allowedNext.includes(status)) {
        return patchError('INVALID_TRANSITION', allowedNext.length ? `A ${existing.status} proposal can be moved to ${allowedNext.join(' or ')}, not ${status}.` : `A ${existing.status} proposal can no longer be changed.`);
      }
      const { data: updatedRows, error: updateError } = await supabase.from('copilot_proposals').update({
        status,
        updated_at: new Date().toISOString()
      }).eq('id', proposal_id).eq('user_id', userId).eq('status', existing.status).select('id');
      if (updateError) {
        console.error('Update proposal error:', updateError);
        return new Response(JSON.stringify({
          error: 'Failed to update proposal'
        }), {
          status: 500,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      if (!updatedRows || updatedRows.length === 0) {
        return patchError('STATUS_CHANGED', 'This proposal changed while you were editing it. Reload and try again.', 409);
      }
      return new Response(JSON.stringify({
        success: true,
        status
      }), {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // --- POST ---
    if (req.method === 'POST') {
      const body = await req.json();
      // itinerary_id (legacy GI id) is accepted and ignored.
      const { action, proposal_id } = body;
      if (action !== 'execute') {
        return new Response(JSON.stringify({
          error: 'Unknown action. Supported: execute'
        }), {
          status: 400,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      if (!proposal_id) {
        return new Response(JSON.stringify({
          error: 'proposal_id is required'
        }), {
          status: 400,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      // 1. Fetch the proposal — verify ownership
      const { data: proposal, error: proposalError } = await supabase.from('copilot_proposals').select('*').eq('id', proposal_id).eq('user_id', userId).single();
      // ERROR-VS-ABSENCE 2026-09-19.
      if (proposalError && !isNoRows(proposalError)) {
        console.error('[copilot-proposals] proposal read failed:', proposalError.message);
        return new Response(JSON.stringify({
          error: 'Failed to read proposal'
        }), {
          status: 500,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      if (!proposal) {
        return new Response(JSON.stringify({
          error: 'Proposal not found'
        }), {
          status: 404,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      // 2. Check proposal status
      if (![
        'READY_FOR_REVIEW',
        'APPROVED'
      ].includes(proposal.status)) {
        // 3. Duplicate execution check
        if (proposal.status === 'EXECUTED' || proposal.status === 'COMPLETE') {
          return new Response(JSON.stringify({
            already_executed: true,
            result_itinerary_id: proposal.result_itinerary_id ?? null,
            result_itinerary_version_id: proposal.result_itinerary_version_id ?? null
          }), {
            status: 200,
            headers: {
              ...corsHeaders,
              'Content-Type': 'application/json'
            }
          });
        }
        return new Response(JSON.stringify({
          error: `Proposal cannot be executed in status: ${proposal.status}`
        }), {
          status: 400,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      // 4. The trip's active itinerary version (ITINERARY RECONCILIATION
      //    2026-09-24 — replaces the generated_itineraries lookup).
      //    Ordered + limited rather than .single(), so a transient second
      //    active row cannot turn into a false "no itinerary".
      const { data: activeRows, error: activeError } = await supabase.from('itinerary_versions').select('id').eq('trip_id', proposal.trip_id).eq('is_active', true).order('version_number', {
        ascending: false
      }).limit(1);
      if (activeError) {
        console.error('[copilot-proposals] active version read failed:', activeError.message);
        return new Response(JSON.stringify({
          error: 'Failed to read the active itinerary for this trip'
        }), {
          status: 500,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      const activeVersionId = activeRows?.[0]?.id ?? null;
      // 5. Stale check — the proposal's base version vs the active version.
      //    base_itinerary_version_id is the uuid FK; itinerary_version_id is the
      //    older text copy of the same value. No recorded base → not stale.
      const baseVersionId = proposal.base_itinerary_version_id ?? proposal.itinerary_version_id ?? null;
      const markStale = async ()=>{
        await supabase.from('copilot_proposals').update({
          status: 'STALE',
          stale_checked_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }).eq('id', proposal_id);
        return new Response(JSON.stringify({
          stale: true,
          message: 'The itinerary has changed since this proposal was created. Please create a new proposal.'
        }), {
          status: 200,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      };
      if (baseVersionId && baseVersionId !== activeVersionId) {
        return await markStale();
      }
      // 6. Mark as EXECUTING
      await supabase.from('copilot_proposals').update({
        status: 'EXECUTING',
        approved_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }).eq('id', proposal_id);
      // 7. Build the change text change-plan receives as user_request.
      const userRequest = buildUserRequest(proposal);
      const proposedChanges = Array.isArray(proposal.proposed_changes) && proposal.proposed_changes.length > 0 ? proposal.proposed_changes : undefined;
      // 8. Call change-plan (v32) with the CALLER's Authorization header, so
      //    change-plan's own membership / role checks apply to this user.
      //    confirmed + proposed_changes skips change-plan's interpret pass and
      //    goes straight to apply. Without proposed_changes, change-plan
      //    interprets user_request and may answer preview/needs_clarification.
      let changePlanData = null;
      let changePlanOk = false;
      let changePlanStatus = 0;
      let changePlanError = 'Unknown error from change-plan';
      try {
        const changePlanRes = await fetch(`${supabaseUrl}/functions/v1/change-plan`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: authHeader
          },
          body: JSON.stringify({
            trip_id: proposal.trip_id,
            user_request: userRequest,
            confirmed: true,
            ...proposedChanges ? {
              proposed_changes: proposedChanges
            } : {},
            proposal_id: proposal.id,
            alert_id: proposal.alert_id ?? undefined,
            monitoring_event_id: proposal.monitoring_event_id ?? undefined,
            itinerary_version_id: activeVersionId ?? undefined,
            conversation_history: []
          })
        });
        changePlanOk = changePlanRes.ok;
        changePlanStatus = changePlanRes.status;
        changePlanData = await changePlanRes.json().catch(()=>null);
        if (!changePlanOk) {
          changePlanError = changePlanData?.message || changePlanData?.error || `change-plan returned ${changePlanRes.status}`;
        }
      } catch (fetchErr) {
        changePlanError = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
        changePlanOk = false;
      }
      // 9a. change-plan found the itinerary moved on between our check and its own.
      if (!changePlanOk && changePlanStatus === 409 && changePlanData?.error === 'STALE_VERSION') {
        return await markStale();
      }
      // 9b. Applied — a new active itinerary_versions row exists.
      if (changePlanOk && changePlanData?.status === 'applied' && changePlanData?.new_version_id) {
        const newVersionId = changePlanData.new_version_id;
        const previousVersionId = changePlanData.previous_version_id ?? activeVersionId;
        // COMPLETE is the status change-plan itself writes for a proposal it
        // applied; this repeats it (plus result_itinerary_version_id) in case
        // change-plan's own non-fatal proposal update failed.
        await supabase.from('copilot_proposals').update({
          status: 'COMPLETE',
          executed_at: new Date().toISOString(),
          result_itinerary_version_id: newVersionId,
          change_summary: changePlanData.change_summary ?? null,
          execution_error: null,
          updated_at: new Date().toISOString()
        }).eq('id', proposal_id);
        // ─── HEALTH DELTA ENRICHMENT ───────────────────────────────────────
        // Background, registered with EdgeRuntime.waitUntil. Keyed on
        // { trip_id, version_id } now. See CROSS-FUNCTION CALLS 2026-09-19.
        const healthDeltaTask = (async ()=>{
          const [healthBefore, healthAfter] = await Promise.all([
            previousVersionId ? fetchHealthScore(supabaseUrl, serviceRoleKey, proposal.trip_id, previousVersionId, 'before') : Promise.resolve(null),
            fetchHealthScore(supabaseUrl, serviceRoleKey, proposal.trip_id, newVersionId, 'after')
          ]);
          const updatePayload = {};
          if (healthBefore != null) updatePayload.health_before = healthBefore;
          if (healthAfter != null) updatePayload.health_after = healthAfter;
          // friction_before / friction_after deliberately not written — see
          // CROSS-FUNCTION CALLS 2026-09-19 (3).
          if (Object.keys(updatePayload).length === 0) {
            console.warn(`[copilot-proposals] health delta for proposal ${proposal_id}: no health score available ` + `for either version; nothing written.`);
            return;
          }
          const { error: deltaErr } = await supabase.from('copilot_proposals').update(updatePayload).eq('id', proposal_id);
          if (deltaErr) {
            console.error('[copilot-proposals] health delta write failed:', deltaErr.message);
          }
        })();
        const rt = globalThis.EdgeRuntime;
        if (rt && typeof rt.waitUntil === 'function') {
          rt.waitUntil(healthDeltaTask);
        } else {
          healthDeltaTask.catch((e)=>console.error('[copilot-proposals] health delta task rejected:', e));
        }
        return new Response(JSON.stringify({
          success: true,
          status: 'applied',
          new_itinerary_id: null,
          new_version_id: newVersionId,
          previous_version_id: previousVersionId,
          applied_changes: changePlanData.applied_changes ?? [],
          failed_changes: changePlanData.failed_changes ?? [],
          change_summary: changePlanData.change_summary,
          response_message: changePlanData.response_message,
          version_error: changePlanData.version_error ?? null
        }), {
          status: 200,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      // 9c. change-plan wants a confirmation or a clarification (only possible
      //     when the proposal carried no proposed_changes). Back to APPROVED.
      if (changePlanOk && (changePlanData?.status === 'preview' || changePlanData?.status === 'needs_clarification')) {
        await supabase.from('copilot_proposals').update({
          status: 'APPROVED',
          updated_at: new Date().toISOString()
        }).eq('id', proposal_id);
        return new Response(JSON.stringify({
          success: false,
          status: changePlanData.status === 'preview' ? 'needs_confirmation' : 'needs_clarification',
          proposed_changes: changePlanData.proposed_changes ?? null,
          clarification_question: changePlanData.clarification_question ?? null,
          response_message: changePlanData.response_message
        }), {
          status: 200,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      // 9d. Error case — including change-plan "no_changes" (nothing was
      //     applied, no new version) and "applied" without a new_version_id
      //     (items changed but the version snapshot failed: version_error).
      let errorMessage;
      if (changePlanOk && changePlanData?.status === 'no_changes') {
        errorMessage = 'No changes were applied to the itinerary.';
      } else if (changePlanOk && changePlanData?.status === 'applied') {
        errorMessage = `Changes were applied but no version was recorded: ${changePlanData.version_error ?? 'unknown'}`;
      } else {
        errorMessage = changePlanError;
      }
      await supabase.from('copilot_proposals').update({
        status: 'FAILED',
        execution_error: errorMessage,
        updated_at: new Date().toISOString()
      }).eq('id', proposal_id);
      return new Response(JSON.stringify({
        success: false,
        status: changePlanOk && changePlanData?.status === 'no_changes' ? 'no_changes' : 'failed',
        error: errorMessage,
        failed_changes: changePlanData?.failed_changes ?? undefined
      }), {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    return new Response(JSON.stringify({
      error: 'Method not allowed'
    }), {
      status: 405,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  } catch (err) {
    console.error('copilot-proposals error:', err);
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

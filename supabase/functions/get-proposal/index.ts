import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
// ITINERARY RECONCILIATION 2026-09-25 — staleness now matches copilot-proposals execute.
//   - The active version is itinerary_versions.is_active = true. The old
//     lookup filtered status = 'ACTIVE', a value no row carries (live rows are
//     status 'ready' with is_active true/false), so currentActiveVersionId was
//     always null and the staleness check never ran.
//   - The check ran only for status 'PENDING', which is not in the
//     copilot_proposals.status CHECK set, so it could never fire either. It
//     now covers the pre-execution statuses DRAFT, READY_FOR_REVIEW and
//     APPROVED, the same proposals execute would refuse as stale.
//   - Rule, as in execute: a recorded base (base_itinerary_version_id ??
//     itinerary_version_id) that differs from the active version id is stale;
//     no recorded base is never stale. No generated_itineraries usage here.
//   - supabase-js import moved from jsr: to esm.sh.
const STALE_CHECKABLE = [
  'DRAFT',
  'READY_FOR_REVIEW',
  'APPROVED'
];
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
// COLUMN FIX 2026-09-19 — this select named `source`, which is not a column on
// public.itinerary_versions (the closest real column is `creation_method`).
// PostgREST rejected the whole query with 42703, the error was DISCARDED
// (`const { data } = ...`), and the function read null. That made
// `currentActiveVersionId` permanently null, which in turn made the staleness
// check below unreachable: a proposal built against a superseded itinerary
// version was never marked STALE and was always reported to the caller as
// `stale: false`, so a user could act on a proposal for a plan that had since
// changed underneath it.
async function getActiveItineraryVersion(supabase, tripId) {
  const { data, error } = await supabase.from('itinerary_versions').select('id, version_number, status, is_active, creation_method, created_at').eq('trip_id', tripId).eq('is_active', true).order('version_number', {
    ascending: false
  }).limit(1).maybeSingle();
  if (error) {
    // Never swallow this again: a failed lookup is not "there is no active
    // version", and the two must not produce the same staleness verdict.
    console.error('[get-proposal] active itinerary version lookup failed:', error.message);
    throw new Error(`Active itinerary version lookup failed: ${error.message}`);
  }
  return data ?? null;
}
Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: corsHeaders
    });
  }
  if (req.method !== 'GET') {
    return new Response(JSON.stringify({
      error: 'Method not allowed'
    }), {
      status: 405,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
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
    // Parse query params
    const url = new URL(req.url);
    const proposalId = url.searchParams.get('proposal_id');
    const tripId = url.searchParams.get('trip_id');
    if (!proposalId) {
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
    // Fetch proposal — user_id must match for security
    let query = supabase.from('copilot_proposals').select('*').eq('id', proposalId).eq('user_id', user.id);
    if (tripId) {
      query = query.eq('trip_id', tripId);
    }
    // ERROR-HANDLING FIX 2026-09-19 — was `if (fetchErr || !proposal) return
    // 404`, which reported a failed query as a proposal that does not exist.
    const { data: proposal, error: fetchErr } = await query.maybeSingle();
    if (fetchErr) {
      console.error('[get-proposal] proposal lookup failed:', fetchErr.message);
      return new Response(JSON.stringify({
        error: 'Proposal lookup failed',
        detail: fetchErr.message
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
    // Staleness check
    const effectiveTripId = tripId ?? proposal.trip_id;
    const activeVersion = await getActiveItineraryVersion(supabase, effectiveTripId);
    const currentActiveVersionId = activeVersion?.id ?? null;
    const baseVersionId = proposal.base_itinerary_version_id ?? proposal.itinerary_version_id ?? null;
    let isStale = proposal.status === 'STALE';
    // Check if itinerary has drifted since proposal was created (pre-execution
    // proposals only; same rule as copilot-proposals execute — 2026-09-25)
    if (!isStale && STALE_CHECKABLE.includes(proposal.status) && baseVersionId) {
      if (currentActiveVersionId !== baseVersionId) {
        isStale = true;
        // Update stale_checked_at and mark as STALE
        const { error: staleUpdateError } = await supabase.from('copilot_proposals').update({
          status: 'STALE',
          stale_checked_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }).eq('id', proposalId);
        if (staleUpdateError) console.error('[get-proposal] marking proposal STALE failed:', staleUpdateError.message);
        proposal.status = 'STALE';
      } else {
        // Update stale_checked_at to record we verified it
        const { error: checkedUpdateError } = await supabase.from('copilot_proposals').update({
          stale_checked_at: new Date().toISOString()
        }).eq('id', proposalId);
        if (checkedUpdateError) console.error('[get-proposal] recording stale_checked_at failed:', checkedUpdateError.message);
      }
    }
    // COLUMN FIX 2026-09-19 — the payload below read five properties that are
    // not columns on copilot_proposals. The row comes from `select('*')`, so
    // these raised nothing and simply read `undefined`, and JSON.stringify
    // then dropped the keys entirely — the client silently never received
    // them. Mapped to the real columns:
    //   goal            -> interpreted_goal
    //   protected_items -> preserved_constraints
    //   expected_result -> expected_effects
    // `trade_offs` and `pipeline_run_id` have no counterpart on this table at
    // all, so they are reported as explicitly null rather than invented.
    return new Response(JSON.stringify({
      proposal: {
        id: proposal.id,
        user_id: proposal.user_id,
        trip_id: proposal.trip_id,
        alert_id: proposal.alert_id,
        monitoring_event_id: proposal.monitoring_event_id,
        impact_id: proposal.impact_id,
        itinerary_version_id: proposal.itinerary_version_id,
        base_itinerary_version_id: proposal.base_itinerary_version_id,
        goal: proposal.interpreted_goal ?? null,
        proposed_changes: proposal.proposed_changes,
        protected_items: proposal.preserved_constraints ?? null,
        trade_offs: null,
        expected_result: proposal.expected_effects ?? null,
        confidence: proposal.confidence,
        what_will_change: proposal.what_will_change,
        what_will_stay: proposal.what_will_stay,
        why_recommended: proposal.why_recommended,
        affected_items: proposal.affected_items,
        status: proposal.status,
        created_at: proposal.created_at,
        updated_at: proposal.updated_at,
        executed_at: proposal.executed_at,
        result_itinerary_version_id: proposal.result_itinerary_version_id,
        failure_reason: proposal.failure_reason,
        pipeline_run_id: null,
        stale_checked_at: proposal.stale_checked_at
      },
      stale: isStale,
      current_itinerary_version_id: currentActiveVersionId,
      base_itinerary_version_id: baseVersionId
    }), {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  } catch (err) {
    console.error('get-proposal error:', err);
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

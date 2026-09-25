// SECURITY 2026-09-16 — Authentication was a presence check, not verification.
//
// The entire auth gate was:
//   const authHeader = req.headers.get("Authorization");
//   if (!authHeader) {
//     return new Response(JSON.stringify({ error: "Missing authorization header" }), { status: 401, ... });
//   }
// The header was never decoded, so `Authorization: x` passed. The function
// then used a service_role client (bypasses RLS) to fetch and update
// whatever trip_health_analyses row matched the analysis_id in the body —
// any caller could dismiss (mutate) another user's health issues just by
// guessing/enumerating an analysis_id.
//
// Fixed: requireUserOrService() verifies the bearer token (user JWT, or the
// service_role key for internal pipeline callers). The analysis row is
// still fetched first (as before), but for a user caller its user_id is now
// checked against the verified token before the update is allowed to
// proceed. A mismatch or missing row returns 404, not 403, so ids can't be
// enumerated.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { requireUserOrService, serviceClient } from "./_shared/auth.ts";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};
serve(async (req)=>{
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: CORS_HEADERS
    });
  }
  const supabase = serviceClient();
  try {
    // SECURITY 2026-09-16: verify the caller (user JWT or service_role key).
    const caller = await requireUserOrService(req);
    if (caller instanceof Response) return caller;
    let body;
    try {
      body = await req.json();
    } catch  {
      return new Response(JSON.stringify({
        error: "invalid_json"
      }), {
        status: 400,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/json"
        }
      });
    }
    const { analysis_id, issue_id, dismiss_type } = body;
    if (!analysis_id || !issue_id || !dismiss_type) {
      return new Response(JSON.stringify({
        error: "analysis_id, issue_id, and dismiss_type are required"
      }), {
        status: 400,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/json"
        }
      });
    }
    if (![
      'once',
      'always'
    ].includes(dismiss_type)) {
      return new Response(JSON.stringify({
        error: "dismiss_type must be 'once' or 'always'"
      }), {
        status: 400,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/json"
        }
      });
    }
    // Fetch the analysis row
    const { data: analysis, error: fetchError } = await supabase.from("trip_health_analyses").select("id, dismissed_issue_ids, user_id").eq("id", analysis_id).single();
    if (fetchError || !analysis) {
      return new Response(JSON.stringify({
        error: "Analysis not found"
      }), {
        status: 404,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/json"
        }
      });
    }
    if (caller.kind === "user" && analysis.user_id !== caller.userId) {
      return new Response(JSON.stringify({
        error: "Analysis not found"
      }), {
        status: 404,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/json"
        }
      });
    }
    // Add issue_id to dismissed_issue_ids (avoid duplicates)
    const currentDismissed = analysis.dismissed_issue_ids || [];
    if (!currentDismissed.includes(issue_id)) {
      currentDismissed.push(issue_id);
    }
    // Update the row
    const { error: updateError } = await supabase.from("trip_health_analyses").update({
      dismissed_issue_ids: currentDismissed
    }).eq("id", analysis_id);
    if (updateError) {
      throw new Error(`Failed to update analysis: ${updateError.message}`);
    }
    return new Response(JSON.stringify({
      success: true,
      dismissed_issue_ids: currentDismissed
    }), {
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/json"
      }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[dismiss-health-issue] Error:", msg);
    return new Response(JSON.stringify({
      error: "Internal server error"
    }), {
      status: 500,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/json"
      }
    });
  }
});

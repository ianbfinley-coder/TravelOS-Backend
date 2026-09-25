// ITINERARY RECONCILIATION 2026-09-24 — POST (restore) is now a thin wrapper
// around the itinerary_restore_version RPC. It no longer writes
// itinerary_versions directly, no longer reads or writes the legacy
// generated_itineraries table, and no longer fires validate-itinerary (retired)
// or the old-contract post-activation-recalculate call.
//
//   POST request (unchanged field names): { trip_id, version_id_to_restore,
//     expect_active_version_id? }. `version_id` is accepted as an alias.
//     trip_id must match the version's trip (else 404).
//   Auth: the verified caller's JWT; the RPC runs through an anon-key client
//     carrying their Authorization header and does its own membership-role
//     (owner / organizer / member) and MFA checks — so any editing member can
//     restore now, not only the trip owner.
//   Response 200: { ok, new_version_id, previous_version_id, version_number,
//     restored_from_version_id, restored_from_version_number, new_itinerary_id:
//     null, change_summary, removed, restored }.
//   Refusals: 409 STALE / LEGACY_SNAPSHOT, 404 NOT_FOUND, 403 FORBIDDEN /
//     MFA_REQUIRED, 401 UNAUTHORIZED — body { error: CODE, code, message }.
//   The new version row has post_activation_status SKIPPED.
//   GET (version history) is unchanged.
//
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// SECURITY 2026-09-17 — POST here restores an itinerary version, which
// activates it as the trip's live plan. It previously accepted an optional
// `user_id` in the request body and used it in place of the verified
// caller's id for every write in the restore path:
//   const effectiveUserId = bodyUserId || user.id;
// Trip ownership was still checked against the real caller (user.id), so
// this was not a cross-trip takeover, but effectiveUserId was then used as
// the user_id on the new itinerary_versions row, the new
// generated_itineraries row, and the lookups used to find which
// generated_itineraries row to deactivate. A caller who owns a trip could
// supply an arbitrary user_id (including a real other user's uuid) in the
// body and have the restored version and itinerary attributed to it, and
// the deactivation lookup (filtered by trip_id + that same wrong user_id)
// would then miss the actual active row, leaving two "active" itineraries
// for the trip and breaking the version-numbering logic that depends on it.
// This is the same shape fixed yesterday in the sibling function
// restore-version (`const effectiveUserId = user_id || user.id;`). The gate
// now: effectiveUserId is always user.id, the id from the verified JWT — no
// identity is ever accepted from the request body.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};
// ── RPC result → HTTP (ITINERARY RECONCILIATION 2026-09-24) ──────────────
// The itinerary_* RPCs answer HTTP 200 with { ok:false, code, message } for
// refusals. These map them onto honest status codes.
const RPC_STATUS = {
  STALE: 409,
  LEGACY_SNAPSHOT: 409,
  NO_PREVIOUS_VERSION: 409,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  MFA_REQUIRED: 403,
  UNAUTHORIZED: 401
};
const RPC_MESSAGE = {
  STALE: "The itinerary has changed since then. Refresh and try again.",
  LEGACY_SNAPSHOT: "This older version was saved in a format that can't be restored.",
  NO_PREVIOUS_VERSION: "There is no earlier version to go back to.",
  NOT_FOUND: "Version not found",
  FORBIDDEN: "You don't have permission to change this itinerary.",
  MFA_REQUIRED: "Two-factor verification is required for this action.",
  UNAUTHORIZED: "Sign in again to continue."
};
function rpcJson(data, status) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json"
    }
  });
}
/**
 * Turns a supabase-js rpc() result into a Response for the failure cases, or
 * returns the ok payload. A PostgREST error (network, 42501 permission, bad
 * JWT) is logged and reported as 401 for auth-shaped errors, 500 otherwise.
 */ function rpcOutcome(tag, result) {
  if (result.error) {
    console.error(`[${tag}] rpc failed:`, result.error.code ?? "", result.error.message);
    const authish = result.error.code === "42501" || result.error.code === "PGRST301" || /jwt/i.test(result.error.message);
    return {
      ok: false,
      response: rpcJson(authish ? {
        error: "UNAUTHORIZED",
        message: RPC_MESSAGE.UNAUTHORIZED
      } : {
        error: "INTERNAL",
        message: "Internal server error"
      }, authish ? 401 : 500)
    };
  }
  const payload = result.data ?? {};
  if (payload.ok !== true) {
    const code = typeof payload.code === "string" ? payload.code : "UNKNOWN";
    const status = RPC_STATUS[code] ?? 400;
    return {
      ok: false,
      response: rpcJson({
        error: code,
        code,
        message: payload.message ?? RPC_MESSAGE[code] ?? "Request refused"
      }, status)
    };
  }
  return {
    ok: true,
    payload
  };
}
serve(async (req)=>{
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: CORS_HEADERS
    });
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  // Auth check
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return new Response(JSON.stringify({
      error: "Missing authorization header"
    }), {
      status: 401,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/json"
      }
    });
  }
  const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY") || SUPABASE_SERVICE_ROLE_KEY, {
    global: {
      headers: {
        Authorization: authHeader
      }
    }
  });
  const { data: { user }, error: authError } = await userClient.auth.getUser();
  if (authError || !user) {
    return new Response(JSON.stringify({
      error: "Unauthorized"
    }), {
      status: 401,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/json"
      }
    });
  }
  try {
    // ─── GET: Version history with restore metadata ───────────────────────────────────────────────────────────
    if (req.method === "GET") {
      const url = new URL(req.url);
      const trip_id = url.searchParams.get("trip_id");
      if (!trip_id) {
        return new Response(JSON.stringify({
          error: "trip_id query parameter is required"
        }), {
          status: 400,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "application/json"
          }
        });
      }
      // Verify user owns the trip
      const { data: trip, error: tripLookupError } = await supabase.from("trips").select("id, user_id").eq("id", trip_id).single();
      if (tripLookupError) {
        console.error("[restore-itinerary-version] trips ownership lookup failed:", tripLookupError.message);
      }
      if (!trip || trip.user_id !== user.id) {
        return new Response(JSON.stringify({
          error: "Trip not found or access denied"
        }), {
          status: 403,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "application/json"
          }
        });
      }
      // Fetch all versions for this trip
      const { data: versions, error: versionsError } = await supabase.from("itinerary_versions").select("id, version_number, is_active, status, creation_method, version_name, user_request, change_summary, change_request, alert_id, monitoring_event_id, proposal_id, impact_id, parent_version_id, health_snapshot, post_activation_status, health_recalculated_at, readiness_recalculated_at, created_at, updated_at").eq("trip_id", trip_id).eq("user_id", user.id).order("version_number", {
        ascending: false
      });
      if (versionsError) {
        throw new Error(`Failed to fetch versions: ${versionsError.message}`);
      }
      // Collect unique alert_ids to join alert titles
      const alertIds = [
        ...new Set((versions || []).map((v)=>v.alert_id).filter(Boolean))
      ];
      const alertTitleMap = {};
      if (alertIds.length > 0) {
        const { data: alerts, error: alertsError } = await supabase.from("travel_alerts").select("id, title").in("id", alertIds);
        if (alertsError) {
          console.error("[restore-itinerary-version] travel_alerts lookup failed:", alertsError.message);
        }
        for (const alert of alerts || []){
          alertTitleMap[alert.id] = alert.title;
        }
      }
      const enrichedVersions = (versions || []).map((v)=>({
          id: v.id,
          version_number: v.version_number,
          status: v.is_active ? "ACTIVE" : "ARCHIVED",
          source: v.creation_method,
          change_summary: Array.isArray(v.change_summary) ? v.change_summary.join("; ") : v.change_summary || v.change_request || v.user_request || null,
          alert_id: v.alert_id || null,
          alert_title: v.alert_id ? alertTitleMap[v.alert_id] || null : null,
          proposal_id: v.proposal_id || null,
          monitoring_event_id: v.monitoring_event_id || null,
          impact_id: v.impact_id || null,
          previous_version_id: v.parent_version_id || null,
          health_snapshot: v.health_snapshot || null,
          post_activation_status: v.post_activation_status,
          health_recalculated_at: v.health_recalculated_at,
          readiness_recalculated_at: v.readiness_recalculated_at,
          created_at: v.created_at,
          can_restore: !v.is_active
        }));
      return new Response(JSON.stringify({
        versions: enrichedVersions
      }), {
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/json"
        }
      });
    }
    // ─── POST: Restore a version (itinerary_restore_version RPC) ───────────
    if (req.method === "POST") {
      let body;
      try {
        body = await req.json();
      } catch  {
        return rpcJson({
          error: "invalid_json"
        }, 400);
      }
      const trip_id = body.trip_id;
      const version_id_to_restore = body.version_id_to_restore ?? body.version_id;
      const expectActive = body.expect_active_version_id ?? null;
      if (!trip_id || !version_id_to_restore) {
        return new Response(JSON.stringify({
          error: "trip_id and version_id_to_restore are required"
        }), {
          status: 400,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "application/json"
          }
        });
      }
      // The version must belong to trip_id. Service-role read of two
      // columns; a mismatch is the same 404 as an unknown id.
      const { data: target, error: targetError } = await supabase.from("itinerary_versions").select("trip_id, version_number").eq("id", version_id_to_restore).maybeSingle();
      if (targetError) {
        console.error("[restore-itinerary-version] version lookup failed:", targetError.message);
        return rpcJson({
          error: "INTERNAL",
          message: "Internal server error"
        }, 500);
      }
      if (!target || target.trip_id !== trip_id) {
        return rpcJson({
          error: "NOT_FOUND",
          code: "NOT_FOUND",
          message: RPC_MESSAGE.NOT_FOUND
        }, 404);
      }
      // Anon-key client carrying the caller's own Authorization header, so
      // the SECURITY DEFINER RPC sees auth.uid() = the caller.
      const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
      if (!anonKey) {
        console.error("[restore-itinerary-version] SUPABASE_ANON_KEY is not set");
        return rpcJson({
          error: "INTERNAL",
          message: "Internal server error"
        }, 500);
      }
      const rpcClient = createClient(SUPABASE_URL, anonKey, {
        global: {
          headers: {
            Authorization: authHeader
          }
        }
      });
      const outcome = rpcOutcome("restore-itinerary-version", await rpcClient.rpc("itinerary_restore_version", {
        p_version_id: version_id_to_restore,
        p_expect_active: expectActive
      }));
      if (!outcome.ok) return outcome.response;
      return rpcJson({
        ...outcome.payload,
        restored_from_version_id: version_id_to_restore,
        restored_from_version_number: target.version_number ?? null,
        new_itinerary_id: null,
        change_summary: `Restored version ${target.version_number ?? ""}`.trim()
      }, 200);
    }
    return new Response(JSON.stringify({
      error: "Method not allowed"
    }), {
      status: 405,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/json"
      }
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[restore-itinerary-version] Error:", message);
    return new Response(JSON.stringify({
      error: message
    }), {
      status: 500,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/json"
      }
    });
  }
});

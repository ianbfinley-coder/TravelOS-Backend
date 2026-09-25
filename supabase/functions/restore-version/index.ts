// ITINERARY RECONCILIATION 2026-09-24 — restore-version is now a thin wrapper
// around the itinerary_restore_version RPC. It no longer reads or writes the
// legacy generated_itineraries table, no longer calls create-itinerary-version
// (retired) or validate-itinerary (retired), and no longer fires the old
// un-awaited analyze-trip-health / analyze-daily-friction / detect-trip-issues
// calls keyed on a GI id.
//
//   Request (unchanged field names): { version_id, trip_id?, expect_active_version_id? }
//     - trip_id is optional now; when given it must match the version's trip
//       (else 404, as before).
//     - expect_active_version_id (optional, new) → p_expect_active: refuse
//       with 409 STALE if the trip's active version has moved on.
//   Auth: the caller's own JWT. The RPC runs as that user through an anon-key
//     client carrying their Authorization header, and does its own
//     signed-in / membership-role (owner, organizer, member) / MFA checks.
//     A service-role caller has no auth.uid(), so it now gets 401 — there is
//     no longer a service path (change-plan v32 does not call this function).
//   Response 200: { ok, new_version_id, previous_version_id, version_number,
//     restored_from, removed, restored, new_itinerary_id: null, message }.
//   Refusals: 409 STALE / LEGACY_SNAPSHOT, 404 NOT_FOUND, 403 FORBIDDEN /
//     MFA_REQUIRED, 401 UNAUTHORIZED — body { error: CODE, code, message }.
//     Note: the RPC reports a viewer (or non-member) as NOT_FOUND, not
//     FORBIDDEN.
//   The new version row has post_activation_status SKIPPED; health / friction
//   / issues are not recalculated here.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { requireUser, serviceClient } from "./_shared/auth.ts";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
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
  if (req.method !== "POST") {
    return rpcJson({
      error: "Method not allowed"
    }, 405);
  }
  try {
    // Verified user JWT → anon-key client carrying the caller's Authorization.
    const caller = await requireUser(req);
    if (caller instanceof Response) {
      return rpcJson({
        error: "UNAUTHORIZED",
        message: RPC_MESSAGE.UNAUTHORIZED
      }, 401);
    }
    let body;
    try {
      body = await req.json();
    } catch  {
      return rpcJson({
        error: "invalid_json"
      }, 400);
    }
    const version_id = body.version_id ?? body.version_id_to_restore;
    const trip_id = body.trip_id;
    const expectActive = body.expect_active_version_id ?? null;
    if (!version_id) {
      return rpcJson({
        error: "version_id is required"
      }, 400);
    }
    // Optional trip_id cross-check. Service-role read of one column; a
    // mismatch is the same 404 as an unknown version, so nothing is revealed.
    if (trip_id) {
      const { data: v, error: vErr } = await serviceClient().from("itinerary_versions").select("trip_id").eq("id", version_id).maybeSingle();
      if (vErr) {
        console.error("[restore-version] version lookup failed:", vErr.message);
        return rpcJson({
          error: "INTERNAL",
          message: "Internal server error"
        }, 500);
      }
      if (!v || v.trip_id !== trip_id) {
        return rpcJson({
          error: "NOT_FOUND",
          code: "NOT_FOUND",
          message: RPC_MESSAGE.NOT_FOUND
        }, 404);
      }
    }
    const outcome = rpcOutcome("restore-version", await caller.client.rpc("itinerary_restore_version", {
      p_version_id: version_id,
      p_expect_active: expectActive
    }));
    if (!outcome.ok) return outcome.response;
    return rpcJson({
      ...outcome.payload,
      new_itinerary_id: null,
      message: "Version restored successfully"
    }, 200);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[restore-version] Error:", message);
    return rpcJson({
      error: "Internal server error"
    }, 500);
  }
});

// ITINERARY RECONCILIATION 2026-09-24 — change-plan-undo is now a thin wrapper
// around the itinerary_undo_change RPC (restores the parent of the given
// version, refusing with STALE if that version is no longer active).
//
// The old path patched a single item back into a version SNAPSHOT (or, as a
// fallback, into the legacy generated_itineraries row) from a trip_change_log
// entry. Editing a snapshot never changed the live itinerary (itinerary_items),
// so that "undo" did not undo anything a traveler could see; trip_change_log
// also has zero rows. That path is removed.
//
//   Request: { versionId } — the new_version_id change-plan returned. Today's
//     body uses camelCase (changeId / tripId), so the version field is
//     `versionId`; `version_id` and `new_version_id` are accepted as aliases.
//     tripId (optional) must match the version's trip (else 409 TRIP_MISMATCH,
//     as before).
//   A request with only the old `changeId` (a trip_change_log id) gets
//     410 GONE — there is no version to undo from it.
//   Auth: the caller's JWT, sent to the RPC through an anon-key client; the
//     RPC does its own signed-in / membership-role / MFA checks.
//   Response 200: { success: true, undone: true, new_version_id,
//     previous_version_id, version_number, restored_from, removed, restored }.
//   Refusals: 409 STALE / LEGACY_SNAPSHOT / NO_PREVIOUS_VERSION, 404 NOT_FOUND,
//     403 FORBIDDEN / MFA_REQUIRED, 401 UNAUTHORIZED.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
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
Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS
    });
  }
  if (req.method !== 'POST') {
    return rpcJson({
      error: 'Method not allowed'
    }, 405);
  }
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return rpcJson({
      error: 'UNAUTHORIZED',
      message: RPC_MESSAGE.UNAUTHORIZED
    }, 401);
    let body;
    try {
      body = await req.json();
    } catch  {
      return rpcJson({
        error: 'invalid_json'
      }, 400);
    }
    const versionId = body.versionId ?? body.version_id ?? body.new_version_id;
    if (!versionId) {
      return rpcJson({
        error: 'GONE',
        message: 'Undo by changeId was retired 2026-09-24. Send { versionId: <new_version_id from change-plan> }.'
      }, 410);
    }
    const userClient = createClient(supabaseUrl, anonKey, {
      global: {
        headers: {
          Authorization: authHeader
        }
      }
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) return rpcJson({
      error: 'UNAUTHORIZED',
      message: RPC_MESSAGE.UNAUTHORIZED
    }, 401);
    // Optional tripId cross-check (same TRIP_MISMATCH contract as before).
    if (body.tripId !== undefined) {
      const { data: v, error: vErr } = await createClient(supabaseUrl, serviceRoleKey).from('itinerary_versions').select('trip_id').eq('id', versionId).maybeSingle();
      if (vErr) {
        console.error('[change-plan-undo] version lookup failed:', vErr.code, vErr.message);
        return rpcJson({
          error: 'INTERNAL',
          message: 'Internal server error'
        }, 500);
      }
      if (v && v.trip_id !== body.tripId) {
        return rpcJson({
          error: 'TRIP_MISMATCH',
          message: 'tripId does not match the trip this version belongs to'
        }, 409);
      }
    }
    const outcome = rpcOutcome('change-plan-undo', await userClient.rpc('itinerary_undo_change', {
      p_version_id: versionId
    }));
    if (!outcome.ok) return outcome.response;
    return rpcJson({
      success: true,
      undone: true,
      ...outcome.payload
    }, 200);
  } catch (err) {
    console.error('[change-plan-undo] unhandled:', err instanceof Error ? err.message : String(err));
    return rpcJson({
      error: 'Internal server error'
    }, 500);
  }
});

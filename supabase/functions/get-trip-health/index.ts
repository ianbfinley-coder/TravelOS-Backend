// GENERATED_ITINERARIES DROP 2026-09-25 — itinerary_id is no longer accepted.
// ---------------------------------------------------------------------------
// generated_itineraries was dropped on 2026-09-25. The legacy path below mapped
// an itinerary_id-only body to its trip through generated_itineraries.trip_id;
// with the table gone that lookup errors and the caller got a 500. A body that
// sends itinerary_id without trip_id now gets a plain 400
//   { error: "TRIP_ID_REQUIRED", message: "Send trip_id; itinerary_id is no longer supported." }
// and reconTripIdFromBody no longer touches generated_itineraries. The
// "legacy: mapped to its trip" contract line in the header below is superseded.
// ---------------------------------------------------------------------------
// ITINERARY RECONCILIATION 2026-09-24 — read by trip, authorize by membership.
// ---------------------------------------------------------------------------
// This reader required a generated_itineraries id and returned the analysis
// stored against it. analyze-trip-health now writes rows keyed by trip_id +
// version_id (itinerary_id null), so reads by itinerary_id found nothing for
// any current trip.
//
// CONTRACT NOW
//   POST { trip_id, version_id? }   — trip_id preferred
//   POST { itinerary_id }           — legacy: mapped to its trip through
//                                     generated_itineraries.trip_id
//   → { analysis: <latest ready trip_health_analyses row> | null,
//       trip_id, version_id, matched_version }
//   The row for the requested version (default: the trip's active version) is
//   preferred; otherwise the newest ready row for the trip. matched_version
//   says which one was returned.
//
// AUTHORIZATION NOW
//   User callers must be an active trip member (trip_members via
//   auth_identities, removed_at IS NULL); otherwise 404 "Trip not found".
//   The generated_itineraries ownership check described below is REPLACED.
//   Service callers as before.
// ---------------------------------------------------------------------------
// SECURITY 2026-09-16 — Authentication was a presence check, not verification.
//
// The entire auth gate was:
//   const authHeader = req.headers.get("Authorization");
//   if (!authHeader) {
//     return new Response(JSON.stringify({ error: "Missing authorization header" }), { status: 401, ... });
//   }
// The header was never decoded, so `Authorization: x` passed. The function
// then used a service_role client (bypasses RLS) to return the latest
// trip_health_analyses row for whatever itinerary_id was in the body — any
// caller could read another user's trip health analysis, including its
// full issues list and overall assessment, just by guessing/enumerating an
// itinerary_id.
//
// Fixed: requireUserOrService() verifies the bearer token (user JWT, or the
// service_role key for internal pipeline callers). For a user caller, the
// itinerary must belong to that caller (generated_itineraries.user_id,
// checked against the verified token, never anything from the body) before
// the analysis is read. An itinerary that doesn't belong to the caller
// returns 404, not 403, so ids can't be enumerated.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { requireUserOrService, serviceClient } from "./_shared/auth.ts";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};
const RECON_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECON_TRIP_COLUMNS = "id, user_id, name, title, destination, start_date, end_date, primary_tz, base_currency";
function reconIsUuid(v) {
  return typeof v === "string" && RECON_UUID_RE.test(v);
}
/** The trip row, or null when absent. A query failure throws — it is not "not found". */ async function reconLoadTrip(db, tripId) {
  const { data, error } = await db.from("trips").select(RECON_TRIP_COLUMNS).eq("id", tripId).maybeSingle();
  if (error) throw new Error(`trip lookup failed: ${error.message}`);
  return data ?? null;
}
/** True when the auth user is an active member (removed_at IS NULL) of the trip. */ async function reconIsActiveMember(db, tripId, authUid) {
  const { data: idents, error: identErr } = await db.from("auth_identities").select("user_id").eq("provider_subject", authUid);
  if (identErr) throw new Error(`identity lookup failed: ${identErr.message}`);
  const platformIds = [
    ...new Set((idents ?? []).map((r)=>r.user_id).filter(Boolean))
  ];
  if (platformIds.length === 0) return false;
  const { data: members, error: memberErr } = await db.from("trip_members").select("id").eq("trip_id", tripId).in("user_id", platformIds).is("removed_at", null).limit(1);
  if (memberErr) throw new Error(`membership lookup failed: ${memberErr.message}`);
  return (members ?? []).length > 0;
}
/**
 * Resolves the itinerary_versions row an analysis is keyed to. With an explicit
 * version_id it must belong to the trip ("not_found" otherwise). Without one it
 * is the trip's active version, or { id: null } when the trip has none.
 */ async function reconResolveVersion(db, tripId, requested) {
  if (requested !== undefined && requested !== null && requested !== "") {
    if (!reconIsUuid(requested)) return "not_found";
    const { data, error } = await db.from("itinerary_versions").select("id, is_active").eq("id", requested).eq("trip_id", tripId).maybeSingle();
    if (error) throw new Error(`version lookup failed: ${error.message}`);
    if (!data) return "not_found";
    return {
      id: data.id,
      is_active: data.is_active === true
    };
  }
  const { data, error } = await db.from("itinerary_versions").select("id").eq("trip_id", tripId).eq("is_active", true).order("created_at", {
    ascending: false
  }).limit(1).maybeSingle();
  if (error) throw new Error(`active version lookup failed: ${error.message}`);
  return {
    id: data?.id ?? null,
    is_active: !!data
  };
}
/**
 * Resolves the trip for a reader call from trip_id. (2026-09-25: the legacy
 * itinerary_id → generated_itineraries.trip_id mapping is gone with the table;
 * an itinerary_id-only body is refused with TRIP_ID_REQUIRED before this runs.)
 */ // deno-lint-ignore require-await
async function reconTripIdFromBody(_db, body) {
  if (reconIsUuid(body.trip_id)) return body.trip_id;
  return null;
}
/**
 * Latest row of a per-trip analysis table: the newest row for the requested /
 * active version when one exists, else the newest row for the trip.
 */ async function reconLatestForTrip(db, table, tripId, versionId, orderColumn) {
  if (versionId) {
    const { data, error } = await db.from(table).select("*").eq("trip_id", tripId).eq("version_id", versionId).eq("status", "ready").order(orderColumn, {
      ascending: false
    }).limit(1).maybeSingle();
    if (error) throw new Error(`${table} lookup failed: ${error.message}`);
    if (data) return {
      row: data,
      matched_version: true
    };
  }
  const { data, error } = await db.from(table).select("*").eq("trip_id", tripId).eq("status", "ready").order(orderColumn, {
    ascending: false
  }).limit(1).maybeSingle();
  if (error) throw new Error(`${table} lookup failed: ${error.message}`);
  return {
    row: data ?? null,
    matched_version: false
  };
}
// ─── end ITINERARY RECONCILIATION helpers ───
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
    if (!body.trip_id && !body.itinerary_id) {
      return new Response(JSON.stringify({
        error: "trip_id is required"
      }), {
        status: 400,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/json"
        }
      });
    }
    // 2026-09-25: itinerary_id-only bodies are no longer mapped (generated_itineraries dropped).
    if (!body.trip_id && body.itinerary_id) {
      return new Response(JSON.stringify({
        error: "TRIP_ID_REQUIRED",
        message: "Send trip_id; itinerary_id is no longer supported."
      }), {
        status: 400,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/json"
        }
      });
    }
    // trip_id only (2026-09-25; see the guard above). Unresolvable ids
    // and non-membership both answer 404 so ids cannot be enumerated.
    const trip_id = await reconTripIdFromBody(supabase, body);
    const trip = trip_id ? await reconLoadTrip(supabase, trip_id) : null;
    if (!trip_id || !trip || caller.kind === "user" && !await reconIsActiveMember(supabase, trip_id, caller.userId)) {
      return new Response(JSON.stringify({
        error: "Trip not found"
      }), {
        status: 404,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/json"
        }
      });
    }
    const version = await reconResolveVersion(supabase, trip_id, body.version_id);
    if (version === "not_found") {
      return new Response(JSON.stringify({
        error: "Version not found"
      }), {
        status: 404,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/json"
        }
      });
    }
    // Most recent ready analysis for the version, else for the trip
    const { row: analysis, matched_version } = await reconLatestForTrip(supabase, "trip_health_analyses", trip_id, version.id, "analyzed_at");
    return new Response(JSON.stringify({
      analysis: analysis || null,
      trip_id,
      version_id: version.id,
      matched_version
    }), {
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/json"
      }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[get-trip-health] Error:", msg);
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

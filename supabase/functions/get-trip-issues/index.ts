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
// This reader required a generated_itineraries id and read trip_issues by
// itinerary_id. detect-trip-issues now keeps the issue lifecycle per trip
// (one living row per trip + issue_key, version_id re-stamped to the version
// it was last detected on, itinerary_id null), so reads by itinerary_id found
// nothing for any current trip.
//
// CONTRACT NOW
//   POST { trip_id, version_id?, include_resolved?, include_dismissed? }
//   POST { itinerary_id, ... }  — legacy: mapped to its trip through
//                                 generated_itineraries.trip_id
//   → { issues, total_count, critical_count, high_count, medium_count,
//       low_count, trip_id, version_id, active_version_count }
//   Issues are returned for the whole trip. Because detect-trip-issues resolves
//   every OPEN/ACKNOWLEDGED issue it no longer sees, the OPEN set is always the
//   latest detection; filtering it to one version would hide a still-open issue
//   whose version stamp predates an activation that has not been re-analyzed
//   yet. active_version_count reports how many returned rows carry the
//   requested / active version, and rows carrying it sort first within equal
//   priority.
//
// AUTHORIZATION NOW
//   User callers must be an active trip member (trip_members via
//   auth_identities, removed_at IS NULL); otherwise 404 "Trip not found". The
//   generated_itineraries ownership check and the user_id-scoped read described
//   below are REPLACED: issues are trip-level and visible to every active
//   member. Service callers as before.
// ---------------------------------------------------------------------------
// SECURITY 2026-09-16 —
// This function's entire authentication was a presence check:
//   const authHeader = req.headers.get("Authorization");
//   if (!authHeader) { return new Response(..., { status: 401 }); }
// The token was never decoded or verified, so `Authorization: x` passed.
// The function then ran on a service_role client (bypasses RLS) and returned
// every trip_issues row for whatever `itinerary_id` was supplied in the
// request body, with no ownership check at all — any caller could read any
// other user's trip issues (schedule conflicts, budget pressure, itinerary
// contents) just by guessing or enumerating itinerary_id values.
// Fix: replaced the presence check with requireUserOrService (./_shared/auth.ts)
// so a real bearer token is verified via auth.getUser(); a service_role
// caller (the internal pipeline) is still admitted for consistency with the
// other trip_issues functions. For a user caller, we now confirm the
// itinerary belongs to them (generated_itineraries.id + .user_id, both uuid)
// before reading anything, returning 404 rather than 403 so itinerary ids
// cannot be enumerated by the response code, and the trip_issues read itself
// is additionally scoped with .eq("user_id", caller.userId) since
// trip_issues.user_id is a uuid that compares directly to auth.uid().
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { requireUserOrService, serviceClient, fail } from "./_shared/auth.ts";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};
const SEVERITY_ORDER = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
  INFO: 4
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
    // Auth check
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
    const { include_resolved = false, include_dismissed = false } = body;
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
    // trip_id only (2026-09-25; see the guard above). Membership is
    // checked before reading anything; unresolvable ids and non-membership
    // both answer 404 so ids cannot be enumerated by the response code.
    const trip_id = await reconTripIdFromBody(supabase, body);
    const trip = trip_id ? await reconLoadTrip(supabase, trip_id) : null;
    if (!trip_id || !trip || caller.kind === "user" && !await reconIsActiveMember(supabase, trip_id, caller.userId)) {
      return fail("Trip not found", 404);
    }
    const version = await reconResolveVersion(supabase, trip_id, body.version_id);
    if (version === "not_found") return fail("Version not found", 404);
    const version_id = version.id;
    // Build status filter
    const statuses = [
      "OPEN",
      "ACKNOWLEDGED"
    ];
    if (include_resolved) statuses.push("RESOLVED");
    if (include_dismissed) statuses.push("DISMISSED");
    const { data: issues, error } = await supabase.from("trip_issues").select("*").eq("trip_id", trip_id).in("status", statuses);
    if (error) throw error;
    // Sort: priority_rank ASC (nulls last), then current version first, then
    // severity, then created_at
    const sorted = (issues || []).sort((a, b)=>{
      // priority_rank: nulls go last
      const aPriority = a.priority_rank ?? 9999;
      const bPriority = b.priority_rank ?? 9999;
      if (aPriority !== bPriority) return aPriority - bPriority;
      // rows stamped with the requested / active version first
      if (version_id) {
        const aCur = a.version_id === version_id ? 0 : 1;
        const bCur = b.version_id === version_id ? 0 : 1;
        if (aCur !== bCur) return aCur - bCur;
      }
      // severity
      const aSev = SEVERITY_ORDER[a.severity] ?? 99;
      const bSev = SEVERITY_ORDER[b.severity] ?? 99;
      if (aSev !== bSev) return aSev - bSev;
      // created_at
      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    });
    const criticalCount = sorted.filter((i)=>i.severity === "CRITICAL").length;
    const highCount = sorted.filter((i)=>i.severity === "HIGH").length;
    const mediumCount = sorted.filter((i)=>i.severity === "MEDIUM").length;
    const lowCount = sorted.filter((i)=>i.severity === "LOW").length;
    return new Response(JSON.stringify({
      issues: sorted,
      total_count: sorted.length,
      critical_count: criticalCount,
      high_count: highCount,
      medium_count: mediumCount,
      low_count: lowCount,
      trip_id,
      version_id,
      active_version_count: version_id ? sorted.filter((i)=>i.version_id === version_id).length : 0
    }), {
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/json"
      }
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[get-trip-issues] Error:", message);
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

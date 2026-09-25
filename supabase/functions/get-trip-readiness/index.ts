// COPY FIX 2026-09-25 — count strings agree with their number.
//   * "1 reservation need review" -> "1 reservation needs review" /
//     "2 reservations need review".
//   * "1 reservation added but none confirmed" -> "1 reservation added but not
//     confirmed yet." (plural wording unchanged).
//   Other count strings here ("N itinerary item(s) planned", "N confirmed
//   reservation(s)", "N of M reservation(s) confirmed", "... has/have not been
//   completed") already agree. No logic, query, or response-shape change.
// ITINERARY RECONCILIATION 2026-09-24 — readiness from itinerary_items.
// ---------------------------------------------------------------------------
// This function read the trip's active generated_itineraries (GI) row. GI is
// being retired; current trips keep their live plan in itinerary_items, so
// every current trip reported "No itinerary has been generated yet." and an
// overall readiness of UNKNOWN.
//
// WHAT CHANGED
//   * The itinerary is the trip's live itinerary_items (cancelled/removed
//     statuses excluded). `itinerary_id` in the query string is legacy and is
//     ignored; the response keeps an `itinerary_id` key (always null) and adds
//     `version_id` (active itinerary_versions row) and `itinerary_item_count`.
//   * Planning: validation status comes from the active itinerary_versions row
//     (validation_status). Items carry no geo/pace status. When items exist but
//     no validation has been recorded, planning is MOSTLY_READY with a detail
//     that says so — not NEEDS_ATTENTION "not validated", which described a GI
//     pipeline these trips never went through.
//   * Transportation: the arrival/departure heuristic read `itinerary_data.days`,
//     but GI.itinerary is a bare days ARRAY, so `.days` was always undefined and
//     hasArrivalDeparture was always false. It now scans itinerary_items: the
//     same title keywords, plus type flight/train/transportation/transfer or a
//     non-null transport_mode.
//   * Issue categories: hasIssue() compared "Schedule"/"Pace"/"Reservations"/
//     "Transportation" against trip_issues.category, which a CHECK constraint
//     restricts to UPPER-CASE values, so it never matched. Now case-insensitive.
//   * Health: the latest ready trip_health_analyses row for the active version,
//     else the latest ready row for the trip (was: filtered by GI id).
//   * Authorization: the caller must be an active trip member (trip_members via
//     auth_identities, removed_at IS NULL); otherwise 404 "Trip not found".
//     The trips.user_id owner-only 403 is replaced. verify_jwt stays true and
//     the user is still verified with auth.getUser(jwt).
//   * Reservations are still read for the calling user only (user_id = caller),
//     as before.
// ---------------------------------------------------------------------------
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
// COLUMN FIX 2026-09-18 — the generated_itineraries lookups that used to live
// here selected columns that did not exist and had their errors discarded.
// ITINERARY RECONCILIATION 2026-09-24 removed those lookups entirely; every
// query in this function still captures its error instead of silently turning
// it into "nothing found".
const ITEM_COLUMNS = "id, title, type, category, status, transport_mode, date, start_time";
const EXCLUDED_ITEM_STATUSES = new Set([
  "cancelled",
  "canceled",
  "removed",
  "deleted"
]);
const TRANSPORT_TYPES = new Set([
  "transportation",
  "transport",
  "flight",
  "train",
  "transfer"
]);
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
 * Resolves the trip for a reader call. trip_id is preferred; a legacy caller
 * that still sends only itinerary_id is mapped to its trip through
 * generated_itineraries.trip_id (TEXT, so it is validated as a uuid first).
 */ async function reconTripIdFromBody(db, body) {
  if (reconIsUuid(body.trip_id)) return body.trip_id;
  if (body.trip_id !== undefined && body.trip_id !== null && body.trip_id !== "") return null;
  if (!reconIsUuid(body.itinerary_id)) return null;
  const { data, error } = await db.from("generated_itineraries").select("trip_id").eq("id", body.itinerary_id).maybeSingle();
  if (error) throw new Error(`legacy itinerary lookup failed: ${error.message}`);
  const t = data?.trip_id;
  return reconIsUuid(t) ? t : null;
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
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS'
};
Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders
    });
  }
  if (req.method !== "GET") {
    return new Response(JSON.stringify({
      error: "Method not allowed"
    }), {
      status: 405,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      }
    });
  }
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return new Response(JSON.stringify({
      error: "Missing Authorization header"
    }), {
      status: 401,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      }
    });
  }
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  // Verify user
  const { data: { user }, error: userError } = await supabase.auth.getUser(jwt);
  if (userError || !user) {
    return new Response(JSON.stringify({
      error: "Unauthorized"
    }), {
      status: 401,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      }
    });
  }
  const url = new URL(req.url);
  const trip_id = url.searchParams.get("trip_id");
  const itinerary_id_param = url.searchParams.get("itinerary_id");
  if (!trip_id) {
    return new Response(JSON.stringify({
      error: "trip_id is required"
    }), {
      status: 400,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      }
    });
  }
  try {
    // 1. Fetch trip
    const { data: trip, error: tripError } = await supabase.from("trips").select("id, user_id, name, title, destination, start_date, end_date, status, primary_tz, base_currency").eq("id", trip_id).maybeSingle();
    if (tripError) {
      console.error('[get-trip-readiness] trip lookup failed:', tripError.message);
      return new Response(JSON.stringify({
        error: 'Trip lookup failed',
        detail: tripError.message
      }), {
        status: 500,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      });
    }
    if (!trip) {
      return new Response(JSON.stringify({
        error: "Trip not found"
      }), {
        status: 404,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      });
    }
    // ITINERARY RECONCILIATION 2026-09-24: active trip membership, not
    // trips.user_id ownership. 404 (not 403) so trip ids cannot be probed.
    if (!await reconIsActiveMember(supabase, trip_id, user.id)) {
      return new Response(JSON.stringify({
        error: "Trip not found"
      }), {
        status: 404,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      });
    }
    if (itinerary_id_param) {
      console.log('[get-trip-readiness] legacy itinerary_id query param ignored:', itinerary_id_param);
    }
    // 2. Fetch the live itinerary (itinerary_items) and the active version.
    const { data: itemRows, error: itemsErr } = await supabase.from("itinerary_items").select(ITEM_COLUMNS).eq("trip_id", trip_id);
    if (itemsErr) {
      console.error('[get-trip-readiness] itinerary_items lookup failed:', itemsErr.message);
      return new Response(JSON.stringify({
        error: 'Itinerary lookup failed',
        detail: itemsErr.message
      }), {
        status: 500,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      });
    }
    const items = (itemRows ?? []).filter((it)=>!EXCLUDED_ITEM_STATUSES.has(String(it.status ?? "").toLowerCase()));
    const hasItinerary = items.length > 0;
    const { data: activeVersion, error: versionErr } = await supabase.from("itinerary_versions").select("id, validation_status").eq("trip_id", trip_id).eq("is_active", true).order("created_at", {
      ascending: false
    }).limit(1).maybeSingle();
    if (versionErr) {
      console.error('[get-trip-readiness] active version lookup failed:', versionErr.message);
      return new Response(JSON.stringify({
        error: 'Itinerary version lookup failed',
        detail: versionErr.message
      }), {
        status: 500,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      });
    }
    const active_version_id = activeVersion?.id ?? null;
    // 3. Fetch reservations — new schema
    const { data: reservations, error: reservationsErr } = await supabase.from("reservations").select("id, reservation_status, reservation_type, confirmation_number, needs_review").eq("trip_id", trip_id).eq("user_id", user.id);
    if (reservationsErr) {
      console.error('[get-trip-readiness] reservations lookup failed:', reservationsErr.message);
      return new Response(JSON.stringify({
        error: 'Reservations lookup failed',
        detail: reservationsErr.message
      }), {
        status: 500,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      });
    }
    const reservationList = reservations ?? [];
    const totalCount = reservationList.length;
    const confirmedCount = reservationList.filter((r)=>r.reservation_status === "CONFIRMED").length;
    const needsReviewCount = reservationList.filter((r)=>r.needs_review === true).length;
    // 4. Fetch latest budget analysis
    const { data: budgetAnalysis, error: budgetErr } = await supabase.from("budget_analyses").select("id, trip_id, itinerary_id, budget_status, total_projected_cost, total_budget, remaining_budget").eq("trip_id", trip_id).order("created_at", {
      ascending: false
    }).limit(1).maybeSingle();
    if (budgetErr) {
      console.error('[get-trip-readiness] budget analysis lookup failed:', budgetErr.message);
      return new Response(JSON.stringify({
        error: 'Budget analysis lookup failed',
        detail: budgetErr.message
      }), {
        status: 500,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      });
    }
    // 5. Fetch latest trip health analysis
    // COLUMN FIX 2026-09-19 — this select named three columns that do not exist
    // on public.trip_health_analyses: `itinerary_version_id` (the generated
    // itinerary is recorded in `itinerary_id`, the version in `version_id`),
    // `overall_score` (the real column is `health_score`) and `confidence`
    // (no such column). PostgREST rejected the whole statement with 42703 and
    // the error was only logged, so `healthAnalysis` was permanently null.
    // The `.eq()` used the same non-existent column and would have failed too.
    // ITINERARY RECONCILIATION 2026-09-24: analyses are keyed by trip +
    // version now (itinerary_id is null on new rows), so the active version's
    // latest ready row is preferred, else the trip's latest ready row.
    let healthAnalysis = null;
    try {
      healthAnalysis = (await reconLatestForTrip(supabase, "trip_health_analyses", trip_id, active_version_id, "created_at")).row;
    } catch (healthErr) {
      const detail = healthErr instanceof Error ? healthErr.message : String(healthErr);
      console.error('[get-trip-readiness] health analysis lookup failed:', detail);
      return new Response(JSON.stringify({
        error: 'Trip health lookup failed',
        detail
      }), {
        status: 500,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      });
    }
    // 6. Fetch open/acknowledged issues
    // COLUMN FIX 2026-09-19 — this select named `itinerary_version_id`, which
    // does not exist on public.trip_issues (the real column is `version_id`).
    // PostgREST rejected the whole query with 42703; the error was only logged
    // and `issues` was null, so `issueList` was ALWAYS empty. Every consumer
    // below — hasIssue(), active_issue_count, critical_issue_count, and the
    // planning / reservations / transportation statuses that depend on them —
    // behaved as though the trip had no issues at all, for every trip.
    const { data: issues, error: issuesErr } = await supabase.from("trip_issues").select("id, trip_id, version_id, severity, category, status, title, short_description").eq("trip_id", trip_id).in("status", [
      "OPEN",
      "ACKNOWLEDGED"
    ]);
    if (issuesErr) {
      console.error('[get-trip-readiness] issues lookup failed:', issuesErr.message);
      return new Response(JSON.stringify({
        error: 'Trip issues lookup failed',
        detail: issuesErr.message
      }), {
        status: 500,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      });
    }
    const issueList = issues ?? [];
    const activeIssueCount = issueList.length;
    const criticalIssueCount = issueList.filter((i)=>i.severity === "CRITICAL").length;
    // trip_issues.category is UPPER-CASE (CHECK constraint); compare
    // case-insensitively so "Schedule" matches "SCHEDULE".
    const hasIssue = (category, severities)=>issueList.some((i)=>String(i.category ?? "").toUpperCase() === category.toUpperCase() && severities.includes(i.severity));
    // --- PLANNING area ---
    let planningStatus;
    let planningDetail;
    if (!hasItinerary) {
      planningStatus = "UNKNOWN";
      planningDetail = "No itinerary items have been added yet.";
    } else {
      // Items carry no geo/pace status; validation is read from the active
      // itinerary version when one has been recorded.
      const vs = activeVersion?.validation_status ?? null;
      const gs = null;
      const ps = null;
      const validationOk = vs === "READY" || vs === "READY_WITH_NOTES";
      const geoOk = gs === "OPTIMIZED" || gs === "ALREADY_OPTIMIZED";
      const paceOk = ps === "READY" || ps === "READY_WITH_WARNINGS";
      const hasCriticalSchedule = hasIssue("Schedule", [
        "CRITICAL",
        "HIGH"
      ]) || hasIssue("Pace", [
        "CRITICAL",
        "HIGH"
      ]);
      if (vs === "NEEDS_REVIEW" || hasCriticalSchedule) {
        planningStatus = "NEEDS_ATTENTION";
        planningDetail = vs === "NEEDS_REVIEW" ? "Your itinerary needs review before it is ready." : "There are high-priority scheduling or pace issues that need attention.";
      } else if (validationOk && geoOk && paceOk) {
        planningStatus = "READY";
        planningDetail = "Your itinerary is validated, geographically optimized, and well-paced.";
      } else if (validationOk) {
        planningStatus = "MOSTLY_READY";
        const missing = [];
        if (!geoOk) missing.push("route optimization");
        if (!paceOk) missing.push("pace analysis");
        planningDetail = `Itinerary is validated but ${missing.join(" and ")} ${missing.length > 1 ? "have" : "has"} not been completed.`;
      } else if (vs === null) {
        planningStatus = "MOSTLY_READY";
        planningDetail = `${items.length} itinerary item${items.length !== 1 ? "s" : ""} planned. No automated validation has been recorded for this itinerary.`;
      } else {
        planningStatus = "NEEDS_ATTENTION";
        planningDetail = "Your itinerary has not been validated yet.";
      }
    }
    // --- RESERVATIONS area — new schema logic ---
    let reservationsStatus;
    let reservationsDetail;
    const hasCriticalReservationIssue = hasIssue("Reservations", [
      "CRITICAL"
    ]);
    if (totalCount === 0) {
      reservationsStatus = "UNKNOWN";
      reservationsDetail = "No reservations added yet.";
    } else if (hasCriticalReservationIssue || needsReviewCount > 0) {
      reservationsStatus = "NEEDS_ATTENTION";
      if (hasCriticalReservationIssue) {
        reservationsDetail = "There are critical issues with your reservations.";
      } else {
        reservationsDetail = `${needsReviewCount} reservation${needsReviewCount !== 1 ? "s need" : " needs"} review.`;
      }
    } else if (confirmedCount === totalCount && totalCount > 0) {
      reservationsStatus = "READY";
      reservationsDetail = `${confirmedCount} confirmed reservation${confirmedCount !== 1 ? "s" : ""}.`;
    } else if (confirmedCount > 0) {
      reservationsStatus = "MOSTLY_READY";
      reservationsDetail = `${confirmedCount} of ${totalCount} reservation${totalCount !== 1 ? "s" : ""} confirmed.`;
    } else {
      reservationsStatus = "NEEDS_ATTENTION";
      reservationsDetail = totalCount === 1 ? "1 reservation added but not confirmed yet." : `${totalCount} reservations added but none confirmed.`;
    }
    // --- TRANSPORTATION area ---
    let transportationStatus;
    let transportationDetail;
    const hasCriticalTransportIssue = hasIssue("Transportation", [
      "CRITICAL",
      "HIGH"
    ]);
    // `trips` has no `transportation_preference` column. There is nothing to read
    // here, so this is always treated as not-set rather than crashing on a
    // missing field.
    const transportationPreference = null;
    // ITINERARY RECONCILIATION 2026-09-24: this used to read
    // `itinerary_data.days`, but GI.itinerary is a bare days ARRAY, so `.days`
    // was undefined and this was always false. It now scans itinerary_items.
    const hasArrivalDeparture = items.some((a)=>{
      const title = String(a.title ?? "").toLowerCase();
      const type = String(a.type ?? "").toLowerCase();
      return TRANSPORT_TYPES.has(type) || a.transport_mode !== null && a.transport_mode !== undefined && a.transport_mode !== "" || title.includes("arrival") || title.includes("departure") || title.includes("flight") || title.includes("train") || title.includes("airport");
    });
    if (hasCriticalTransportIssue) {
      transportationStatus = "NEEDS_ATTENTION";
      transportationDetail = "There are high-priority transportation issues that need attention.";
    } else if (!transportationPreference && !hasArrivalDeparture) {
      transportationStatus = "UNKNOWN";
      transportationDetail = "No transportation information has been added yet.";
    } else if (transportationPreference && hasArrivalDeparture) {
      transportationStatus = "READY";
      transportationDetail = "Transportation preference is set and arrival/departure details are in your itinerary.";
    } else {
      transportationStatus = "MOSTLY_READY";
      transportationDetail = transportationPreference ? "Transportation preference is set but arrival/departure details are not yet in your itinerary." : "Arrival/departure details found in itinerary but no transportation preference has been set.";
    }
    // --- BUDGET area ---
    let budgetStatus;
    let budgetDetail;
    const projectedTotal = budgetAnalysis ? budgetAnalysis.total_projected_cost : null;
    // `trips` has no `budget` column; there is no budget target to read, so this
    // always falls into the "no budget set" branch below instead of crashing on
    // a missing field.
    const budgetTarget = null;
    if (!budgetTarget) {
      budgetStatus = "UNKNOWN";
      budgetDetail = "No budget has been set for this trip.";
    } else if (!budgetAnalysis) {
      budgetStatus = "MOSTLY_READY";
      budgetDetail = "Budget is set but no analysis has been run yet.";
    } else {
      const bs = budgetAnalysis.budget_status;
      if (bs === "UNDER_BUDGET" || bs === "ON_TRACK") {
        budgetStatus = "READY";
        budgetDetail = bs === "UNDER_BUDGET" ? "Budget is under target — looking good." : "Budget is on track.";
      } else if (bs === "BUDGET_PRESSURE") {
        budgetStatus = "NEEDS_ATTENTION";
        budgetDetail = "Projected spending is approaching your budget limit.";
      } else if (bs === "OVER_BUDGET") {
        budgetStatus = "NEEDS_ATTENTION";
        budgetDetail = "Projected spending exceeds your target.";
      } else {
        budgetStatus = "MOSTLY_READY";
        budgetDetail = "Budget analysis is available.";
      }
    }
    // --- DOCUMENTS area ---
    const documentsStatus = "UNKNOWN";
    const documentsDetail = "Document tracking will be available in a future update.";
    // --- Assemble areas ---
    const areas = [
      {
        key: "planning",
        label: "Planning",
        status: planningStatus,
        detail: planningDetail,
        confirmed_count: null,
        total_count: null,
        projected_total: null,
        budget_target: null
      },
      {
        key: "reservations",
        label: "Reservations",
        status: reservationsStatus,
        detail: reservationsDetail,
        confirmed_count: confirmedCount,
        total_count: totalCount,
        projected_total: null,
        budget_target: null
      },
      {
        key: "transportation",
        label: "Transportation",
        status: transportationStatus,
        detail: transportationDetail,
        confirmed_count: null,
        total_count: null,
        projected_total: null,
        budget_target: null
      },
      {
        key: "budget",
        label: "Budget",
        status: budgetStatus,
        detail: budgetDetail,
        confirmed_count: null,
        total_count: null,
        projected_total: projectedTotal,
        budget_target: budgetTarget
      },
      {
        key: "documents",
        label: "Documents",
        status: documentsStatus,
        detail: documentsDetail,
        confirmed_count: null,
        total_count: null,
        projected_total: null,
        budget_target: null
      }
    ];
    // --- Overall readiness ---
    const nonUnknownAreas = areas.filter((a)=>a.status !== "UNKNOWN");
    let overallReadiness;
    if (!hasItinerary) {
      overallReadiness = "UNKNOWN";
    } else if (criticalIssueCount > 0 || areas.some((a)=>a.status === "NEEDS_ATTENTION")) {
      overallReadiness = "NEEDS_ATTENTION";
    } else if (nonUnknownAreas.some((a)=>a.status === "MOSTLY_READY")) {
      overallReadiness = "MOSTLY_READY";
    } else if (nonUnknownAreas.length > 0 && nonUnknownAreas.every((a)=>a.status === "READY")) {
      overallReadiness = "READY";
    } else {
      overallReadiness = "MOSTLY_READY";
    }
    return new Response(JSON.stringify({
      trip_id,
      // Legacy key kept for old clients; GI ids are no longer resolved.
      itinerary_id: null,
      version_id: active_version_id,
      itinerary_item_count: items.length,
      health_analysis_id: healthAnalysis ? healthAnalysis.id : null,
      calculated_at: new Date().toISOString(),
      overall_readiness: overallReadiness,
      areas,
      active_issue_count: activeIssueCount,
      critical_issue_count: criticalIssueCount
    }), {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      }
    });
  } catch (err) {
    console.error("get-trip-readiness error:", err);
    return new Response(JSON.stringify({
      error: "Internal server error"
    }), {
      status: 500,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      }
    });
  }
});

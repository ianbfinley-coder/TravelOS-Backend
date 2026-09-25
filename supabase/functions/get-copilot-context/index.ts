import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SEVERITY_ORDER: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4 };
const IMPACT_LEVEL_ORDER: Record<string, number> = { CRITICAL: 0, HIGH: 1, MODERATE: 2, LOW: 3, POSSIBLE: 4, NONE: 5, UNKNOWN: 6 };
const ALERT_PRIORITY_ORDER: Record<string, number> = { CRITICAL: 0, HIGH: 1, LOW: 2, INFO: 3 };

// SCHEMA NOTE 2026-09-19 — columns this function used that do not exist.
// Four separate reads in this file named columns that are not on their table.
// Two of them were inside `.order()`, which makes PostgREST reject the WHOLE
// query with 42703; those errors were only logged, so the rows came back null
// and the caller was told the data simply did not exist:
//   * trip_health_analyses.calculated_at  -> real column is `analyzed_at`.
//     `health` was ALWAYS null, so health_section reported
//     "Health not yet calculated" for every trip that had a ready analysis.
//   * budget_analyses.calculated_at       -> real column is `analyzed_at`.
//     `budget` was ALWAYS null, so budget_section reported no budget status.
// The other two are plain property reads on a `select('*')` row, which raise
// nothing at all and silently read `undefined`:
//   * generated_itineraries.itinerary_data -> real column is `itinerary`.
//     `rawDays` was ALWAYS `[]`, so `itinerary.days` — the day-by-day plan,
//     the single most important part of this payload — was empty in every
//     copilot context ever produced, for every trip.
//   * trip_health_analyses.overall_score   -> real column is `health_score`.
// `trips` has no `budget`, `currency`, `travelers`, `traveler_type`,
// `travel_style`, `pace_preference`, `walking_preference`,
// `transportation_preference`, `accommodation`, `interests`,
// `must_do_items`, `avoid_items` or `notes` column either; the currency is
// `base_currency`, and the rest are genuinely not stored on the trip, so they
// are reported as null / "not specified" rather than invented.
const NOT_SPECIFIED = "not specified";

// ─────────────────────────────────────────────────────────────────────────
// MVP REWRITE 2026-09-22 — build the itinerary section from itinerary_items,
// not generated_itineraries.
//
// Found while verifying the 2026-09-21 change-plan rewrite: change-plan now
// reads and writes itinerary_items exclusively, but this function — the one
// that tells the copilot "here's what's on the trip" — was still reading
// generated_itineraries, a legacy table the real app has never written to.
// For every trip created since the itinerary_items migration,
// generated_itineraries has ZERO rows, so `itinerary` was always null,
// `days` was always [], and the copilot told travelers their itinerary was
// empty regardless of what was actually scheduled. Confirmed live: a test
// trip with one real itinerary_items row ("Visit 9/11 Memorial") returned an
// empty itinerary from this function, and the copilot told the traveler that
// item didn't exist.
//
// What changed:
//   1. The itinerary_id query param (which selected a specific
//      generated_itineraries row by id) is no longer meaningful — there is
//      no per-version itinerary_id in the itinerary_items world. It is still
//      accepted on the URL for backward compatibility with existing callers
//      but is not used for anything.
//   2. `itinerary` is no longer a generated_itineraries row. Items are read
//      directly from itinerary_items (trip_id-scoped), and `days` is built
//      by grouping those items by a day_number computed from
//      trips.start_date — the same computation change-plan.v28 already uses
//      (dayNumberFor), so the two functions agree on what "day 3" means.
//   3. Per-activity fields are read from the real itinerary_items columns.
//      The old activity shape had `estimated_cost` / `is_confirmed` /
//      `is_must_do` / `is_optional`, none of which exist on itinerary_items
//      (there is no per-item cost column at all) — those are dropped rather
//      than invented. `must_do`, `fixed`, `starred`, `critical`, `outdoor`
//      map directly to real boolean columns.
//   4. `pace_report` / `geo_report` lived only on the old
//      generated_itineraries.itinerary jsonb blob and have no equivalent on
//      itinerary_items. There IS a `pace_analyses` table in the schema, but
//      wiring it in is a separate, real change (different shape, needs its
//      own verification) — out of scope for this pass. pace_summary /
//      geo_summary now explicitly report data_available: false instead of
//      silently returning stale/empty data that looks like a real "no pace
//      issues" result.
//   5. `computeReadiness`'s itinerary check and `itinerarySection` no longer
//      reference generated_itineraries fields (id, version, is_active,
//      validation_status, geo_status, pace_status) that don't exist in this
//      model. Readiness is now based on whether the trip has any
//      itinerary_items at all.
//
// NOT changed: reservations, trip_health_analyses, daily_friction_scores,
// trip_issues, budget_analyses, trip_assemblies, pre_trip_readiness,
// secure_documents, important_information, trip_impacts, travel_alerts —
// none of those tables were ever tied to generated_itineraries, so their
// 2026-09-19 fixes stand unchanged.

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function durationDays(start: string, end: string): number {
  try {
    const s = new Date(start);
    const e = new Date(end);
    const diff = Math.round((e.getTime() - s.getTime()) / (1000 * 60 * 60 * 24));
    return diff >= 0 ? diff + 1 : 0;
  } catch { return 0; }
}

// Day 1 = trips.start_date. Matches change-plan.v28's dayNumberFor exactly,
// so both functions agree on what day a given item falls on.
function dayNumberFor(itemDate: string | null, tripStartDate: string | null): number | null {
  if (!itemDate || !tripStartDate) return null;
  const d = new Date(`${itemDate}T00:00:00Z`).getTime();
  const s = new Date(`${tripStartDate}T00:00:00Z`).getTime();
  if (Number.isNaN(d) || Number.isNaN(s)) return null;
  return Math.floor((d - s) / 86400000) + 1;
}

function computeReadiness(
  trip: Record<string, unknown>,
  hasItinerary: boolean,
  itemCount: number,
  health: Record<string, unknown> | null,
  issues: Record<string, unknown>[],
  reservations: Record<string, unknown>[],
  budget: Record<string, unknown> | null
): { overall: string; areas: { key: string; label: string; status: string; detail: string }[] } {
  const areas: { key: string; label: string; status: string; detail: string }[] = [];

  if (hasItinerary) {
    areas.push({ key: "itinerary", label: "Itinerary", status: "ready", detail: `${itemCount} item(s) scheduled` });
  } else {
    areas.push({ key: "itinerary", label: "Itinerary", status: "missing", detail: "No itinerary items yet" });
  }

  if (health) {
    // COLUMN FIX 2026-09-19 — was `health.overall_score`, which is not a
    // column on trip_health_analyses; the score lives in `health_score`.
    const score = health.health_score as number;
    const status = score >= 80 ? "good" : score >= 60 ? "fair" : "poor";
    areas.push({ key: "health", label: "Trip Health", status, detail: `Score: ${score}` });
  } else {
    areas.push({ key: "health", label: "Trip Health", status: "unknown", detail: "Health not yet calculated" });
  }

  const criticalCount = issues.filter((i) => i.severity === "CRITICAL").length;
  const highCount = issues.filter((i) => i.severity === "HIGH").length;
  if (criticalCount > 0) {
    areas.push({ key: "issues", label: "Issues", status: "critical", detail: `${criticalCount} critical issue(s)` });
  } else if (highCount > 0) {
    areas.push({ key: "issues", label: "Issues", status: "warning", detail: `${highCount} high-priority issue(s)` });
  } else if (issues.length > 0) {
    areas.push({ key: "issues", label: "Issues", status: "info", detail: `${issues.length} minor issue(s)` });
  } else {
    areas.push({ key: "issues", label: "Issues", status: "good", detail: "No open issues" });
  }

  const confirmedRes = reservations.filter((r) => r.reservation_status === "CONFIRMED").length;
  const needsReviewRes = reservations.filter((r) => r.needs_review === true).length;
  if (reservations.length === 0) {
    areas.push({ key: "reservations", label: "Reservations", status: "unknown", detail: "No reservations added" });
  } else if (needsReviewRes > 0) {
    areas.push({ key: "reservations", label: "Reservations", status: "warning", detail: `${needsReviewRes} reservation(s) need review` });
  } else {
    areas.push({ key: "reservations", label: "Reservations", status: "ready", detail: `${confirmedRes}/${reservations.length} confirmed` });
  }

  if (budget) {
    const bStatus = budget.budget_status as string;
    const uiStatus = bStatus === "OVER_BUDGET" ? "warning" : bStatus === "ON_TRACK" ? "good" : "info";
    areas.push({ key: "budget", label: "Budget", status: uiStatus, detail: `Status: ${bStatus}` });
  } else {
    // COLUMN FIX 2026-09-19 — the removed branch here was `else if
    // (trip.budget)`, and `trips` has no `budget` column, so it was always
    // falsy and unreachable. There is no budget target stored on a trip.
    areas.push({ key: "budget", label: "Budget", status: "unknown", detail: "No budget target is recorded for this trip" });
  }

  const statusPriority: Record<string, number> = { critical: 0, poor: 1, warning: 2, fair: 3, info: 4, unknown: 5, good: 6, ready: 7 };
  const worstStatus = areas.reduce((worst, a) => {
    return (statusPriority[a.status] ?? 5) < (statusPriority[worst] ?? 5) ? a.status : worst;
  }, "good");

  let overall: string;
  if (["critical", "poor"].includes(worstStatus)) overall = "NEEDS_ATTENTION";
  else if (["warning", "fair"].includes(worstStatus)) overall = "MOSTLY_READY";
  else if (["good", "ready"].includes(worstStatus)) overall = "READY";
  else overall = "UNKNOWN";

  return { overall, areas };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) {
    return new Response(JSON.stringify({ error: "Missing authorization" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const { data: { user }, error: authError } = await supabase.auth.getUser(jwt);
  if (authError || !user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const url = new URL(req.url);
  const trip_id = url.searchParams.get("trip_id");
  // itinerary_id is accepted but unused — see the MVP REWRITE 2026-09-22
  // header comment. There is no per-version itinerary_id in the
  // itinerary_items model.

  if (!trip_id) {
    return new Response(JSON.stringify({ error: "trip_id is required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  // ERROR-HANDLING FIX 2026-09-19 — was `if (tripError || !trip) return 404`,
  // which reported a failed query as a trip that does not exist.
  const { data: trip, error: tripError } = await supabase.from("trips").select("*").eq("id", trip_id).maybeSingle();
  if (tripError) {
    console.error('[get-copilot-context] trip lookup failed:', tripError.message);
    return new Response(JSON.stringify({ error: "Trip lookup failed", detail: tripError.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  if (!trip) {
    return new Response(JSON.stringify({ error: "Trip not found" }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  if (trip.user_id !== user.id) {
    return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  // ─── ITINERARY ITEMS (replaces the generated_itineraries lookup) ─────────
  // MVP REWRITE 2026-09-22: itinerary_items is the real, live source of the
  // itinerary. No version concept, no jsonb blob — a flat per-activity table
  // scoped by trip_id.
  let itemRows: Record<string, unknown>[] = [];
  try {
    const { data, error: itemsErr } = await supabase
      .from("itinerary_items")
      .select("*")
      .eq("trip_id", trip_id)
      .order("date", { ascending: true })
      .order("start_time", { ascending: true });
    if (itemsErr) console.error('[get-copilot-context] itinerary_items lookup failed:', itemsErr.message);
    itemRows = data ?? [];
  } catch (itemsLookupError) {
    console.error('[get-copilot-context] itinerary_items lookup threw:', itemsLookupError);
    itemRows = [];
  }

  const userId = user.id;

  const [
    reservationsResult, healthResult, frictionResult, issuesResult,
    budgetResult, assemblyResult, readinessResult, readinessItemsResult,
    docsResult, infoResult, impactsResult, alertsResult,
  ] = await Promise.allSettled([
    supabase.from("reservations").select("id, reservation_type, provider_name, confirmation_number, reservation_status, start_date, start_time, end_date, end_time, timezone, location_name, city, country, details, notes, confidence, data_completeness, needs_review, source_type").eq("trip_id", trip_id).eq("user_id", userId).order("start_date", { ascending: true, nullsFirst: false }),
    // COLUMN FIX 2026-09-19 — `.order("calculated_at")`: trip_health_analyses
    // has no such column (it has `analyzed_at`). 42703 rejected the whole
    // query, the error was only logged, and `health` was always null.
    supabase.from("trip_health_analyses").select("*").eq("trip_id", trip_id).eq("status", "ready").order("analyzed_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("daily_friction_scores").select("*").eq("trip_id", trip_id).eq("status", "ready").order("calculated_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("trip_issues").select("*").eq("trip_id", trip_id).in("status", ["OPEN", "ACKNOWLEDGED"]).order("created_at", { ascending: false }).limit(20),
    // COLUMN FIX 2026-09-19 — `.order("calculated_at")`: budget_analyses has
    // no such column (it has `analyzed_at`). Same 42703, same silent null.
    supabase.from("budget_analyses").select("*").eq("trip_id", trip_id).eq("status", "ready").order("analyzed_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("trip_assemblies").select("*").eq("trip_id", trip_id).maybeSingle(),
    supabase.from("pre_trip_readiness").select("*").eq("trip_id", trip_id).maybeSingle(),
    supabase.from("readiness_items").select("title, description, severity, category, recommendation, priority").eq("trip_id", trip_id).in("status", ["OPEN"]).order("priority", { ascending: true }).limit(10),
    supabase.from("secure_documents").select("id, document_type, document_name, expiration_date, status, scope, trip_id, reservation_id, extraction_confidence").eq("user_id", userId).eq("is_active", true).order("created_at", { ascending: false }).limit(20),
    supabase.from("important_information").select("id, information_type, title, organization, phone, email, trip_id, reservation_id").eq("user_id", userId).order("information_type").limit(20),
    supabase.from("trip_impacts").select("id, impact_type, impact_level, affected_entity_type, affected_entity_id, explanation, confidence, status, created_at").eq("trip_id", trip_id).eq("status", "ACTIVE").order("impact_level", { ascending: true }).limit(10),
    supabase.from("travel_alerts").select("id, alert_type, priority, urgency, title, summary, confidence, time_to_impact, status, created_at").eq("trip_id", trip_id).eq("status", "ACTIVE").order("created_at", { ascending: false }).limit(5),
  ]);

  const reservations: Record<string, unknown>[] = reservationsResult.status === "fulfilled" ? (reservationsResult.value.data ?? []) : [];
  const health: Record<string, unknown> | null = healthResult.status === "fulfilled" ? (healthResult.value.data ?? null) : null;
  const friction: Record<string, unknown> | null = frictionResult.status === "fulfilled" ? (frictionResult.value.data ?? null) : null;
  const rawIssues: Record<string, unknown>[] = issuesResult.status === "fulfilled" ? (issuesResult.value.data ?? []) : [];
  const budget: Record<string, unknown> | null = budgetResult.status === "fulfilled" ? (budgetResult.value.data ?? null) : null;
  const assembly: Record<string, unknown> | null = assemblyResult.status === "fulfilled" ? (assemblyResult.value.data ?? null) : null;
  const preReadiness: Record<string, unknown> | null = readinessResult.status === "fulfilled" ? (readinessResult.value.data ?? null) : null;
  const readinessItems: Record<string, unknown>[] = readinessItemsResult.status === "fulfilled" ? (readinessItemsResult.value.data ?? []) : [];
  const vaultDocs: Record<string, unknown>[] = docsResult.status === "fulfilled" ? (docsResult.value.data ?? []) : [];
  const vaultInfo: Record<string, unknown>[] = infoResult.status === "fulfilled" ? (infoResult.value.data ?? []) : [];
  const rawImpacts: Record<string, unknown>[] = impactsResult.status === "fulfilled" ? (impactsResult.value.data ?? []) : [];
  const rawAlerts: Record<string, unknown>[] = alertsResult.status === "fulfilled" ? (alertsResult.value.data ?? []) : [];

  if (reservationsResult.status === "fulfilled" && reservationsResult.value.error) console.error('[get-copilot-context] reservations query failed:', reservationsResult.value.error.message);
  if (healthResult.status === "fulfilled" && healthResult.value.error) console.error('[get-copilot-context] trip_health_analyses query failed:', healthResult.value.error.message);
  if (frictionResult.status === "fulfilled" && frictionResult.value.error) console.error('[get-copilot-context] daily_friction_scores query failed:', frictionResult.value.error.message);
  if (issuesResult.status === "fulfilled" && issuesResult.value.error) console.error('[get-copilot-context] trip_issues query failed:', issuesResult.value.error.message);
  if (budgetResult.status === "fulfilled" && budgetResult.value.error) console.error('[get-copilot-context] budget_analyses query failed:', budgetResult.value.error.message);
  if (assemblyResult.status === "fulfilled" && assemblyResult.value.error) console.error('[get-copilot-context] trip_assemblies query failed:', assemblyResult.value.error.message);
  if (readinessResult.status === "fulfilled" && readinessResult.value.error) console.error('[get-copilot-context] pre_trip_readiness query failed:', readinessResult.value.error.message);
  if (readinessItemsResult.status === "fulfilled" && readinessItemsResult.value.error) console.error('[get-copilot-context] readiness_items query failed:', readinessItemsResult.value.error.message);
  if (docsResult.status === "fulfilled" && docsResult.value.error) console.error('[get-copilot-context] secure_documents query failed:', docsResult.value.error.message);
  if (infoResult.status === "fulfilled" && infoResult.value.error) console.error('[get-copilot-context] important_information query failed:', infoResult.value.error.message);
  if (impactsResult.status === "fulfilled" && impactsResult.value.error) console.error('[get-copilot-context] trip_impacts query failed:', impactsResult.value.error.message);
  if (alertsResult.status === "fulfilled" && alertsResult.value.error) console.error('[get-copilot-context] travel_alerts query failed:', alertsResult.value.error.message);

  const issues = [...rawIssues].sort((a, b) => (SEVERITY_ORDER[a.severity as string] ?? 99) - (SEVERITY_ORDER[b.severity as string] ?? 99));

  // Build trip_impacts section
  const highestImpactLevel = rawImpacts.length > 0
    ? rawImpacts.reduce((best: string, cur: Record<string, unknown>) => {
        const curLevel = cur.impact_level as string;
        return (IMPACT_LEVEL_ORDER[curLevel] ?? 6) < (IMPACT_LEVEL_ORDER[best] ?? 6) ? curLevel : best;
      }, 'UNKNOWN')
    : null;

  const tripImpactsSection = {
    active_count: rawImpacts.length,
    highest_level: highestImpactLevel,
    impacts: rawImpacts.map((i) => ({
      id: i.id,
      impact_type: i.impact_type,
      impact_level: i.impact_level,
      affected_entity_type: i.affected_entity_type ?? null,
      affected_entity_id: i.affected_entity_id ?? null,
      explanation: i.explanation,
      confidence: i.confidence,
      status: i.status,
      created_at: i.created_at,
    })),
    data_available: rawImpacts.length > 0 || impactsResult.status === "fulfilled",
  };

  // Build travel_alerts section
  const sortedAlerts = [...rawAlerts].sort((a, b) => {
    const pDiff = (ALERT_PRIORITY_ORDER[a.priority as string] ?? 99) - (ALERT_PRIORITY_ORDER[b.priority as string] ?? 99);
    if (pDiff !== 0) return pDiff;
    return new Date(b.created_at as string).getTime() - new Date(a.created_at as string).getTime();
  });

  const travelAlertsSection = {
    active_count: sortedAlerts.length,
    critical_count: sortedAlerts.filter((a) => a.priority === 'CRITICAL').length,
    high_count: sortedAlerts.filter((a) => a.priority === 'HIGH').length,
    alerts: sortedAlerts.map((a) => ({
      id: a.id,
      alert_type: a.alert_type,
      priority: a.priority,
      urgency: a.urgency,
      title: a.title,
      summary: a.summary,
      confidence: a.confidence,
      time_to_impact: a.time_to_impact,
      status: a.status,
      created_at: a.created_at,
    })),
    data_available: rawAlerts.length > 0 || alertsResult.status === "fulfilled",
  };

  const frictionByDay: Record<number, Record<string, unknown>> = {};
  if (friction?.scores && Array.isArray(friction.scores)) {
    for (const s of friction.scores as Record<string, unknown>[]) {
      if (s.day_number != null) frictionByDay[s.day_number as number] = s;
    }
  }

  const issuesByDay: Record<number, Record<string, unknown>[]> = {};
  for (const issue of issues) {
    const dn = issue.day_number as number | null;
    if (dn != null) {
      if (!issuesByDay[dn]) issuesByDay[dn] = [];
      issuesByDay[dn].push(issue);
    }
  }

  const reservationsByDate: Record<string, Record<string, unknown>[]> = {};
  for (const r of reservations) {
    const d = r.start_date as string | null;
    if (d) {
      const dateKey = d.split("T")[0];
      if (!reservationsByDate[dateKey]) reservationsByDate[dateKey] = [];
      reservationsByDate[dateKey].push(r);
    }
  }

  // ─── DAYS (replaces reading generated_itineraries.itinerary.days) ────────
  // MVP REWRITE 2026-09-22: group itinerary_items by a computed day_number
  // instead of reading a pre-shaped `days` array off a jsonb blob that was
  // never populated for real trips. Per-activity fields come straight off
  // the real itinerary_items columns; there is no cost/estimated_cost or
  // is_confirmed/is_optional column on this table, so those are dropped
  // rather than invented (see the FABRICATION FIX precedent elsewhere in
  // this file).
  const itemsByDay: Record<number, Record<string, unknown>[]> = {};
  const unscheduledItems: Record<string, unknown>[] = [];
  for (const it of itemRows) {
    const dn = dayNumberFor(it.date as string | null, trip.start_date as string | null);
    if (dn == null) {
      unscheduledItems.push(it);
      continue;
    }
    if (!itemsByDay[dn]) itemsByDay[dn] = [];
    itemsByDay[dn].push(it);
  }

  const dayNumbers = Object.keys(itemsByDay).map(Number).sort((a, b) => a - b);
  const days = dayNumbers.map((dn) => {
    const dayItems = itemsByDay[dn];
    const dayDate = (dayItems[0]?.date as string | null) ?? null;
    const activities = dayItems.map((it) => ({
      id: it.id ?? null,
      name: it.title ?? "",
      time: it.start_time ?? null,
      end_time: it.end_time ?? null,
      duration: it.duration_min ?? null,
      type: it.type ?? null,
      category: it.category ?? null,
      location: it.location ?? null,
      notes: it.notes ?? null,
      status: it.status ?? null,
      fixed: Boolean(it.fixed),
      must_do: Boolean(it.must_do),
      starred: Boolean(it.starred),
      critical: Boolean(it.critical),
      outdoor: Boolean(it.outdoor),
    }));
    const frictionDay = frictionByDay[dn] ?? null;
    const dayIssues = issuesByDay[dn] ?? [];
    const dayReservations = dayDate ? (reservationsByDate[dayDate] ?? []) : [];
    return {
      day_number: dn, date: dayDate, title: null, activities,
      // COMPAT ALIAS 2026-09-22 — copilot-chat.ts's formatContextForPrompt()
      // reads `day.items` with fields `title`/`start_time`/`location`/
      // `category`/`cost`, not `day.activities` with `name`/`time`. Rather
      // than change that consumer (separate function, separate approval),
      // expose the same day content under both shapes so the prompt the
      // model actually sees includes real items instead of silently
      // rendering an empty day. `cost` has no source on itinerary_items and
      // is left undefined rather than invented.
      items: activities.map((a) => ({ id: a.id, title: a.name, category: a.category, start_time: a.time, location: a.location, notes: a.notes })),
      friction: { score: frictionDay?.friction_score ?? null, status: frictionDay?.friction_status ?? null, top_factors: (frictionDay?.top_factors as unknown[]) ?? [], explanation: frictionDay?.explanation ?? null, confidence: frictionDay?.confidence ?? null },
      issues: dayIssues.map((i) => ({ issue_id: i.issue_id ?? i.id, severity: i.severity, category: i.category, title: i.title, short_description: i.short_description, recommended_action: i.recommended_action, fixable_by: i.fixable_by })),
      reservations: dayReservations.map((r) => ({ id: r.id, reservation_type: r.reservation_type, provider_name: r.provider_name ?? null, confirmation_number: r.confirmation_number ?? null, reservation_status: r.reservation_status ?? "UNKNOWN", start_time: r.start_time ?? null, location_name: r.location_name ?? null, city: r.city ?? null, country: r.country ?? null, confidence: r.confidence ?? null, needs_review: r.needs_review ?? false })),
    };
  });

  // MVP REWRITE 2026-09-22 — pace_report / geo_report had no source other
  // than the old generated_itineraries jsonb blob, which no path writes to
  // anymore. Reporting real-looking-but-empty summaries here would read as
  // "no pace/geo problems found" rather than "not computed" — report
  // unavailable honestly instead. A `pace_analyses` table exists in the
  // schema; wiring it in is a follow-up, not part of this fix.
  const geoSummary = { efficiency_score: null, backtracking_detected: false, high_friction_days: [] as number[], data_available: false };
  const paceSummary = { overall_pace: null, overloaded_days: [] as number[], relaxed_days: [] as number[], highest_intensity_day: null, data_available: false };

  const frictionAvailable = !!friction;
  const frictionSummary = {
    average_score: friction?.average_friction ?? null,
    highest_day: friction?.highest_friction_day ?? null,
    highest_day_score: friction?.highest_friction_score ?? null,
    lowest_day: friction?.lowest_friction_day ?? null,
    lowest_day_score: friction?.lowest_friction_score ?? null,
    high_friction_days: (friction?.high_friction_days as number[]) ?? [], data_available: frictionAvailable,
  };

  const healthAvailable = !!health;
  // COLUMN FIX 2026-09-19 — `overall_score`, `primary_factors` and
  // `calculated_at` are not columns on trip_health_analyses. The score is
  // `health_score` and the timestamp is `analyzed_at`; there is no
  // primary-factors column at all, and `confidence` does not exist either, so
  // both are reported as unavailable rather than invented.
  const healthSection = { overall_score: health?.health_score ?? null, status: health?.health_status ?? null, confidence: null, schedule_score: health?.schedule_score ?? null, geography_score: health?.geography_score ?? null, pace_score: health?.pace_score ?? null, budget_score: health?.budget_score ?? null, completeness_score: health?.completeness_score ?? null, primary_factors: [], overall_assessment: health?.overall_assessment ?? null, calculated_at: health?.analyzed_at ?? null, data_available: healthAvailable };

  const criticalCount = issues.filter((i) => i.severity === "CRITICAL").length;
  const highCount = issues.filter((i) => i.severity === "HIGH").length;
  const issuesSection = { active_count: issues.length, critical_count: criticalCount, high_count: highCount, items: issues.map((i) => ({ issue_id: i.issue_id ?? i.id, severity: i.severity, category: i.category, issue_type: i.issue_type, title: i.title, short_description: i.short_description, detailed_explanation: i.detailed_explanation, impact: i.impact, recommended_action: i.recommended_action, fixable_by: i.fixable_by, confidence: i.confidence, change_plan_prompt: i.change_plan_prompt ?? null, day_number: i.day_number ?? null })) };

  const confirmedCount = reservations.filter((r) => r.reservation_status === "CONFIRMED").length;
  const needsReviewCount = reservations.filter((r) => r.needs_review === true).length;
  const reservationsSection = { total_count: reservations.length, confirmed_count: confirmedCount, needs_review_count: needsReviewCount, items: reservations.map((r) => ({ id: r.id, reservation_type: r.reservation_type, provider_name: r.provider_name ?? null, confirmation_number: r.confirmation_number ?? null, reservation_status: r.reservation_status, start_date: r.start_date ?? null, start_time: r.start_time ?? null, end_date: r.end_date ?? null, end_time: r.end_time ?? null, timezone: r.timezone ?? null, location_name: r.location_name ?? null, city: r.city ?? null, country: r.country ?? null, details: r.details ?? {}, notes: r.notes ?? null, confidence: r.confidence, data_completeness: r.data_completeness, needs_review: r.needs_review, source_type: r.source_type })) };

  const budgetAvailable = !!budget;
  // FABRICATION FIX 2026-09-19 — `target` read `trip.budget` (no such column)
  // and `currency` was `trip.currency ?? "USD"`, which told the copilot every
  // trip was priced in US dollars. `trips` stores the currency in
  // `base_currency`; when that is unset it is reported as not specified.
  const budgetSection = { target: null, target_note: "no budget target is recorded on the trip", currency: (trip.base_currency as string | null) ?? NOT_SPECIFIED, status: budget?.budget_status ?? null, total_projected: budget?.total_projected_cost ?? null, remaining: budget?.remaining_budget ?? null, cost_drivers: (budget?.cost_drivers as unknown[]) ?? [], data_available: budgetAvailable, calculated_at: budget?.analyzed_at ?? null };

  const assemblyAvailable = !!assembly;
  const tripAssemblySection = { assembly_status: (assembly?.assembly_status as string | null) ?? null, confidence: (assembly?.confidence as string | null) ?? null, assembly_notes: (assembly?.assembly_notes as string | null) ?? null, destination_count: (assembly?.destination_count as number) ?? 0, destinations: (assembly?.destinations as unknown[]) ?? [], travel_segments: (assembly?.travel_segments as unknown[]) ?? [], open_windows: (assembly?.open_windows as unknown[]) ?? [], conflicts: (assembly?.conflicts as unknown[]) ?? [], possible_gaps: (assembly?.possible_gaps as unknown[]) ?? [], next_actions: (assembly?.next_actions as unknown[]) ?? [], data_available: assemblyAvailable };

  const readinessDataAvailable = !!preReadiness;
  const topReadinessItems = readinessItems.slice(0, 5).map((item) => ({ title: item.title, description: item.description ?? null, severity: item.severity, category: item.category, recommendation: item.recommendation ?? null }));
  const preTripReadinessSection = { overall_status: (preReadiness?.overall_status as string | null) ?? null, summary_message: (preReadiness?.summary_message as string | null) ?? null, days_until_trip: (preReadiness?.days_until_trip as number | null) ?? null, trip_phase: (preReadiness?.trip_phase as string | null) ?? null, open_item_count: (preReadiness?.open_item_count as number) ?? 0, critical_item_count: (preReadiness?.critical_item_count as number) ?? 0, top_items: topReadinessItems, data_available: readinessDataAvailable };

  const itineraryAvailable = itemRows.length > 0;
  const readiness = computeReadiness(trip, itineraryAvailable, itemRows.length, health, issues, reservations, budget);

  // Document vault section
  const needsReviewDocs = vaultDocs.filter((d) => d.status === 'NEEDS_REVIEW').length;
  const expiringSoonDocs = vaultDocs.filter((d) => d.status === 'EXPIRING_SOON').length;
  const documentVaultSection = {
    document_count: vaultDocs.length,
    documents: vaultDocs.map((d) => ({
      id: d.id,
      document_type: d.document_type,
      document_name: d.document_name,
      expiration_date: d.expiration_date ?? null,
      status: d.status,
      scope: d.scope,
      trip_id: d.trip_id ?? null,
      extraction_confidence: d.extraction_confidence,
    })),
    important_information: vaultInfo.map((i) => ({
      id: i.id,
      information_type: i.information_type,
      title: i.title,
      organization: i.organization ?? null,
      phone: i.phone ?? null,
      email: i.email ?? null,
      trip_id: i.trip_id ?? null,
    })),
    needs_review_count: needsReviewDocs,
    expiring_soon_count: expiringSoonDocs,
    data_available: vaultDocs.length > 0 || vaultInfo.length > 0,
  };

  const issuesAvailable = issues.length > 0 || issuesResult.status === "fulfilled";
  const reservationsAvailable = reservations.length > 0 || reservationsResult.status === "fulfilled";
  let overallConfidence: string;
  if (itineraryAvailable && healthAvailable && frictionAvailable) overallConfidence = "HIGH";
  else if (itineraryAvailable) overallConfidence = "MEDIUM";
  else overallConfidence = "LOW";

  const dataQuality = { itinerary_available: itineraryAvailable, health_available: healthAvailable, friction_available: frictionAvailable, issues_available: issuesAvailable, reservations_available: reservationsAvailable, budget_available: budgetAvailable, pace_available: false, geo_available: false, trip_assembly_available: assemblyAvailable, pre_trip_readiness_available: readinessDataAvailable, overall_confidence: overallConfidence };

  // FABRICATION FIX 2026-09-19 — `traveler_count` was `trip.travelers ?? 1`
  // and `currency` was `trip.currency ?? "USD"`. Neither column exists on
  // `trips`, so both reads were `undefined` and the copilot was told, for
  // every trip, that one person was travelling and spending US dollars. The
  // party size is not stored on a trip, so it is now "not specified"; the
  // currency comes from the real column, `base_currency`. The remaining
  // fields below are likewise not columns on `trips` and stay null.
  const tripSection = { id: trip.id, name: trip.name ?? trip.title ?? null, destination: trip.destination, start_date: trip.start_date, end_date: trip.end_date, duration_days: durationDays(trip.start_date as string, trip.end_date as string), traveler_count: NOT_SPECIFIED, traveler_type: null, travel_style: null, budget_target: null, currency: (trip.base_currency as string | null) ?? NOT_SPECIFIED, timezone: trip.primary_tz ?? null, pace_preference: null, walking_preference: null, transportation_preference: null, accommodation: null, interests: [], must_do_items: [], avoid_items: [], notes: null };

  // MVP REWRITE 2026-09-22 — itinerarySection now describes the flat
  // itinerary_items model directly: no id/version/validation_status/
  // geo_status/pace_status, because none of those concepts exist here.
  // `days` moved up to the top level too (see the response object below) —
  // copilot-chat.ts's formatContextForPrompt() reads `context.days`, not
  // `context.itinerary.days`, so this also fixes that the days were being
  // nested somewhere the caller never looked, independent of the
  // generated_itineraries bug above. Kept `itinerary.days` as well for any
  // other caller that might read the nested path.
  const itinerarySection = { item_count: itemRows.length, unscheduled_item_count: unscheduledItems.length, days };

  const response = { context_version: "2.0", generated_at: new Date().toISOString(), trip: tripSection, itinerary: itinerarySection, days, health: healthSection, issues: issuesSection, reservations: reservationsSection, budget: budgetSection, trip_assembly: tripAssemblySection, pre_trip_readiness: preTripReadinessSection, readiness, friction_summary: frictionSummary, pace_summary: paceSummary, geo_summary: geoSummary, document_vault: documentVaultSection, trip_impacts: tripImpactsSection, travel_alerts: travelAlertsSection, data_quality: dataQuality };

  return new Response(JSON.stringify(response), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
});

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { requireUserOrService, serviceClient } from "./_shared/auth.ts";

// SECURITY 2026-09-16 — read, tamper and destroy, in one anonymous call.
//
// This function had no authentication whatsoever. `serve()` went straight to
// `req.json()`, took `user_id` and `itinerary_id` from the POST body, and built
// a service_role client that bypasses RLS. With nothing but an itinerary uuid,
// an anonymous caller could read/tamper/destroy another traveler's itinerary.
// The gate is dual-accept, matching create-itinerary-version and
// travel-operations: service_role callers pass through; a user's JWT is
// verified and auth.uid() overrides any body user_id. 404, not 403, so uuids
// cannot be probed. (See the 2026-09-21 note below for how "the target" is
// now identified.)
//
// CORRECTNESS 2026-09-17 — undo / version history / stale-version check fixed
// to require an explicit `trip_id` in the body rather than falling back to
// generated_itineraries.trip_id (a different, TEXT id space than
// itinerary_versions.trip_id). Also fixed the issue-lifecycle update, which
// filtered trip_issues on a nonexistent `itinerary_version_id` column.
//
// CROSS-FUNCTION CALLS 2026-09-19 — four outbound calls to sibling edge
// functions were un-awaited `fetch(...).catch(...)`, so a 401/404/500 from
// the target was invisible and indistinguishable from success. Introduced
// `backgroundCall()` to await inside EdgeRuntime.waitUntil and log failures.
// One of the four (POST /analyze-pace) was found to be calling a slug that no
// longer hosts a pace analyser at all (it now hosts the "calm-ux" router) and
// was deleted rather than repaired — there is no pace-analysis endpoint left
// in the fleet to repoint it at.
//
// ─────────────────────────────────────────────────────────────────────────
// MVP REWRITE 2026-09-21 — operate on itinerary_items, not generated_itineraries.
//
// Root problem this fixes: copilot-chat's "approve this change" flow
// (executeProposal()) has never worked. It sends change-plan a request
// missing `itinerary_id` (previously hard-required) and using the wrong
// field name (`change_request` instead of `user_request`) — guaranteed 400
// on every attempt. Chasing that down surfaced a deeper issue: this
// function's entire read/write path ran against `generated_itineraries`, a
// legacy table holding a nested {days, trip_summary} jsonb blob that the
// real app has never written to (5 stale rows total, none from real usage).
// The real app reads and writes `itinerary_items` — a flat, per-activity
// table with no version concept of its own — exclusively.
//
// `itinerary_versions` turned out NOT to be a standalone modern replacement:
// create-itinerary-version (the function that used to populate it) hard-
// required an `itinerary_id` pointing at a generated_itineraries row and
// copied that row's `itinerary` blob into `itinerary_versions.itinerary_snapshot`.
// So there was no existing versioning mechanism for itinerary_items at all.
//
// What changed, by design, after discussing scope trade-offs directly:
//   1. Request contract: `trip_id` + `user_id` + `user_request` required.
//      `itinerary_id` is gone — there is no itinerary_id in this flow anymore.
//   2. Ownership check moved from generated_itineraries.user_id to
//      trips.user_id (still 404-not-403 on mismatch, same probing protection).
//   3. Trip context is now built by querying itinerary_items directly
//      (grouped/annotated with a computed day_number from trips.start_date),
//      not by reading a jsonb blob off generated_itineraries.
//   4. The old trip-level "preferences" fields (travel_style, pace,
//      walking_tolerance_minutes, must_do, avoid, budget, interests) are
//      DROPPED from the prompt context — nothing in the real schema stores
//      them; the old prompt was reading fields that were always undefined
//      outside the 5 legacy test rows.
//   5. PASS 2 (apply) no longer asks the model to rewrite a full `days`
//      array. It now asks for a list of concrete operations
//      (create/update/delete) against itinerary_items, which this function
//      then executes directly, one row at a time, through a column
//      whitelist (sanitizeItemFields) so the model cannot write arbitrary
//      columns.
//   6. Versioning: this function now INSERTs itinerary_versions rows
//      directly — a full flat snapshot of itinerary_items after the writes
//      — instead of calling create-itinerary-version (which still expects a
//      generated_itineraries-shaped itinerary_id and was not touched here).
//   7. Undo is intentionally NOT wired up in this pass. The old undo path
//      called restore-version, which restores a generated_itineraries-shaped
//      snapshot; that function has not been adapted to restore a flat
//      itinerary_items snapshot, so calling it here would either fail or
//      write something it doesn't expect. Undo now returns a plain
//      "not supported yet" message instead of attempting it. Version
//      history (a read-only listing) is UNCHANGED and keeps working, since
//      itinerary_versions was already trip_id/uuid-native.
//   8. validate-itinerary, post-activation-recalculate and detect-trip-issues
//      are NOT called from this MVP. All three key off an `itinerary_id`
//      pointing at a generated_itineraries row, which this function no
//      longer creates. Calling them with a fabricated or absent id would be
//      worse than not calling them. `revalidation_triggered` and
//      `health_recalculating` are now returned as false with a
//      `pipeline_note` explaining why, mirroring the existing
//      `pace_reanalysis_unavailable_reason` pattern below. Restoring these
//      requires adapting each of those three functions to read
//      itinerary_items directly — out of scope here.
//   9. The trip_issues lifecycle update (marking OPEN/ACKNOWLEDGED issues
//      RESOLVED after a successful change) is KEPT, adapted to filter by
//      `trip_id` instead of `itinerary_id` — trip_issues.trip_id is a
//      NOT NULL uuid column, confirmed against the live schema, so this is a
//      safe, direct substitution rather than a guess.
//  10. copilot_proposals / travel_alerts post-version bookkeeping is
//      UNCHANGED — both only ever needed `newVersionId`, `proposal_id` and
//      `alert_id`, none of which are affected by this migration.
//  11. plan_changes still gets a row per call for audit purposes, but
//      `itinerary_id` / `previous_itinerary_id` are now always null (both are
//      nullable uuid columns) — there is nothing meaningful to put there
//      anymore now that this function doesn't create generated_itineraries
//      rows. The version ids live on itinerary_versions itself.
//
// See also: the corresponding caller-side fix in copilot-chat.ts
// (executeProposal's request body, and getActiveItineraryVersion's use of a
// nonexistent `source` column and a `status = 'ACTIVE'` check that should
// have been `is_active = true`).

const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Columns on itinerary_items the model is allowed to set via an
// apply-pass operation. Anything else in a "fields" object is dropped
// silently rather than passed through to the insert/update — this is the
// same anonymous-tamper-class concern the 2026-09-16 SECURITY note above was
// written about, just applied to the new flat-item write path.
const ITEM_WRITABLE_FIELDS = new Set([
  "title", "type", "category", "status", "date", "start_time", "end_time",
  "timezone", "duration_min", "location", "notes", "country_code",
  "transport_mode", "party_size", "place_id", "lat", "lng",
  "fixed", "outdoor", "must_do", "starred", "suggested", "droppable", "critical",
  "hold_minutes", "energy_cost",
]);

function sanitizeItemFields(fields: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!fields) return out;
  for (const [k, v] of Object.entries(fields)) {
    if (ITEM_WRITABLE_FIELDS.has(k) && v !== undefined) out[k] = v;
  }
  return out;
}

// ─── PASS 1: INTERPRET ─────────────────────────────────────────────────────────
const INTERPRET_PROMPT = `You are a travel planning assistant. Interpret the traveler's change request and determine what modifications to make to their itinerary.

The itinerary is a flat list of items (not a single "days" object) — each item has its own id, date and times. When you reference an existing item, use its real "id" from the CURRENT ITEMS list given to you; never invent one.

CRITICAL RULES:
1. Return ONLY valid JSON — no markdown, no explanation, no code blocks.
2. NEVER invent prices, availability, opening hours, travel times, or reservations.
3. NEVER automatically move, cancel, or modify items whose "fixed" flag is true.
4. NEVER remove items whose "must_do" flag is true without explicit user instruction.
5. If the request is ambiguous in a way that could materially alter the trip, set requires_clarification: true.
6. For minor, clearly safe changes, set requires_clarification: false.
7. Understand relative time references using the trip's actual dates.
8. Understand references to existing items by name, description, day number, or position.
9. Be concise and natural in your response_message — avoid technical language.
10. If a request conflicts with a fixed or must_do item, explain the conflict clearly.

SCOPE VALUES: "one_activity" | "one_day" | "multiple_days" | "entire_trip"
CHANGE TYPES: "MOVE" | "REMOVE" | "ADD" | "REPLACE" | "ADJUST_TIME" | "ADJUST_PACE" | "ADJUST_WALKING" | "ADJUST_BUDGET" | "ADJUST_FOOD" | "ADD_FREE_TIME" | "REDUCE_DENSITY" | "INCREASE_DENSITY"

OUTPUT FORMAT:
{
  "understood_request": "string (plain English summary of what was understood)",
  "scope": "one_activity"|"one_day"|"multiple_days"|"entire_trip",
  "requires_clarification": boolean,
  "clarification_question": "string|null (only if requires_clarification is true)",
  "is_safe_to_apply_directly": boolean,
  "conflicts_with_confirmed": boolean,
  "conflict_explanation": "string|null",
  "proposed_changes": [
    {
      "id": "string (unique, e.g. 'c1')",
      "type": "MOVE"|"REMOVE"|"ADD"|"REPLACE"|"ADJUST_TIME"|"ADJUST_PACE"|"ADJUST_WALKING"|"ADJUST_BUDGET"|"ADJUST_FOOD"|"ADD_FREE_TIME"|"REDUCE_DENSITY"|"INCREASE_DENSITY",
      "day_number": number|null,
      "target_day_number": number|null,
      "item_id": "string|null (real id from CURRENT ITEMS, or null for a new item)",
      "item_title": "string|null",
      "new_time": "string|null (HH:MM)",
      "description": "string (what will be done)",
      "impact": "string (what effect this has)",
      "affects_fixed": boolean,
      "affects_must_do": boolean
    }
  ],
  "trade_offs": ["string"],
  "response_message": "string (natural, friendly response to show the user — 1-3 sentences)",
  "preview_required": boolean
}`;

// ─── PASS 2: APPLY ──────────────────────────────────────────────────────────
// MVP REWRITE 2026-09-21 — this used to ask the model to return a complete
// rewritten `days` array. There is no such array anymore: itinerary_items is
// a flat table, so this asks for a list of concrete create/update/delete
// operations instead, which are then executed directly against the table.
const APPLY_PROMPT = `You are a travel itinerary editor. The itinerary is a flat list of items, not a single "days" object. Apply the specified changes by producing a list of concrete operations against that item list.

CRITICAL RULES:
1. Return ONLY valid JSON — no markdown, no explanation, no code blocks.
2. NEVER modify or delete an item whose "fixed" or "must_do" flag is true, unless the user explicitly asked to change or remove that specific item.
3. Apply ONLY the specified changes — do not touch items that were not part of the request.
4. Every "update" or "delete" operation MUST target a real "item_id" from the CURRENT ITEMS list given to you. Every "create" operation must have item_id: null.
5. Dates are "YYYY-MM-DD". Times are ISO 8601 timestamps (e.g. "2026-11-03T09:00:00Z").
6. If a change cannot be safely applied, add it to "failed_changes" with a reason instead of guessing.
7. Do not create new time conflicts on the same day.
8. Be natural and friendly in the response_message.

OUTPUT FORMAT:
{
  "operations": [
    {
      "op": "create"|"update"|"delete",
      "item_id": "string|null (required for update/delete, null for create)",
      "fields": {
        "title": "string", "type": "string|null", "category": "string|null",
        "date": "YYYY-MM-DD|null", "start_time": "ISO timestamp|null", "end_time": "ISO timestamp|null",
        "location": "string|null", "notes": "string|null"
        /* only include fields that are being set or changed; omit the rest */
      }
    }
  ],
  "applied_changes": [
    { "change_id": "string", "type": "string", "item_id": "string|null", "item_title": "string", "day_number": number|null, "description": "string (what was done)" }
  ],
  "failed_changes": [
    { "change_id": "string", "reason": "string" }
  ],
  "response_message": "string (natural, friendly summary of what was done — 2-4 sentences)",
  "change_summary": {
    "headline": "string",
    "bullets": ["string"],
    "impact_notes": ["string"]
  }
}`;

// ─── UNDO INTENT DETECTION ────────────────────────────────────────────────
function detectUndoIntent(userRequest: string): boolean {
  const lower = userRequest.toLowerCase().trim();
  const undoPatterns = [
    /^undo$/,
    /^undo that$/,
    /go back/,
    /previous version/,
    /revert/,
    /restore previous/,
    /use the previous plan/,
    /keep the old/,
    /bring back the old/,
    /undo (the )?last change/,
  ];
  return undoPatterns.some(p => p.test(lower));
}

function detectHistoryIntent(userRequest: string): boolean {
  const lower = userRequest.toLowerCase();
  return lower.includes("version history") || lower.includes("what versions") || lower.includes("show versions") || lower.includes("list versions");
}

// ─── HEALTH-AWARE INTENT DETECTION ─────────────────────────────────────────
function detectHealthQueryIntent(userRequest: string): boolean {
  const lower = userRequest.toLowerCase();
  return (
    lower.includes("what should i fix") ||
    lower.includes("biggest problems") ||
    lower.includes("what are the problems") ||
    lower.includes("what's wrong") ||
    lower.includes("whats wrong") ||
    lower.includes("top issues") ||
    lower.includes("health issues") ||
    lower.includes("trip health") ||
    lower.includes("what needs attention") ||
    lower.includes("what needs fixing") ||
    lower.includes("improve my trip") ||
    lower.includes("fix my trip")
  );
}

function detectDayFrictionIntent(userRequest: string): { detected: boolean; dayNumber: number | null } {
  const lower = userRequest.toLowerCase();
  const frictionPatterns = [
    /day (\d+) is too busy/,
    /day (\d+) has too much/,
    /day (\d+) is overwhelming/,
    /day (\d+) is too packed/,
    /too much friction on day (\d+)/,
    /day (\d+) friction/,
    /lighten day (\d+)/,
    /simplify day (\d+)/,
  ];
  for (const pattern of frictionPatterns) {
    const match = lower.match(pattern);
    if (match) {
      return { detected: true, dayNumber: parseInt(match[1], 10) };
    }
  }
  return { detected: false, dayNumber: null };
}

function generateVersionName(userRequest: string): string {
  const cleaned = userRequest.replace(/[^a-zA-Z0-9 ,!?]/g, "").trim();
  if (cleaned.length <= 50) return cleaned || "Custom change";
  return cleaned.substring(0, 47).trim() + "...";
}

// Day 1 = trips.start_date. Returns null when either date is missing.
function dayNumberFor(itemDate: string | null, tripStartDate: string | null): number | null {
  if (!itemDate || !tripStartDate) return null;
  const d = new Date(`${itemDate}T00:00:00Z`).getTime();
  const s = new Date(`${tripStartDate}T00:00:00Z`).getTime();
  if (Number.isNaN(d) || Number.isNaN(s)) return null;
  return Math.floor((d - s) / 86400000) + 1;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  // ── SECURITY GATE — before the body is parsed, before the database is
  // touched, and before a single OpenRouter token is spent. ──────────────────
  const caller = await requireUserOrService(req);
  if (caller instanceof Response) return caller;

  const supabase = serviceClient();

  try {
    let body: Record<string, any>;
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: "invalid_json" }), {
        status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }
    const {
      user_request,
      trip_id,
      conversation_history = [],
      confirmed = false,
      proposed_changes,
      itinerary_version_id,
      proposal_id,
      alert_id,
      monitoring_event_id,
      impact_id,
      change_summary: requestChangeSummary,
    } = body;

    // Identity comes from the verified token for user callers. `user_id` is
    // no longer read from the body for them.
    const user_id = caller.kind === "user" ? caller.userId : body.user_id;

    if (!trip_id || !user_id || !user_request) {
      return new Response(JSON.stringify({ error: "trip_id and user_request are required" }), {
        status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // Fetch the trip (replaces the old generated_itineraries fetch).
    const { data: tripRow } = await supabase
      .from("trips")
      .select("id, user_id, destination, title, start_date, end_date")
      .eq("id", trip_id)
      .maybeSingle();
    if (!tripRow) return new Response(JSON.stringify({ error: "Trip not found" }), { status: 404, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });

    // OWNERSHIP — trips.user_id is a uuid and compares directly with
    // auth.uid(). Same 404 as the not-found path above, so a caller cannot
    // tell "exists but not yours" from "does not exist".
    if (caller.kind === "user" && tripRow.user_id !== caller.userId) {
      return new Response(JSON.stringify({ error: "Trip not found" }), { status: 404, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    // ─── STALE VERSION PROTECTION ──────────────────────────────────────────────
    // If itinerary_version_id is provided, verify it is still the active version.
    if (itinerary_version_id) {
      const { data: activeVersion } = await supabase
        .from("itinerary_versions")
        .select("id")
        .eq("trip_id", trip_id)
        .eq("is_active", true)
        .maybeSingle();

      if (activeVersion && activeVersion.id !== itinerary_version_id) {
        return new Response(
          JSON.stringify({
            error: "STALE_VERSION",
            message: "The itinerary has changed since this proposal was based on it. Please refresh and try again.",
          }),
          { status: 409, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
        );
      }
    }

    // ─── UNDO INTENT ─────────────────────────────────────────────────────────
    // MVP REWRITE 2026-09-21: intentionally not wired up. See the header
    // comment block for why (restore-version restores a generated_itineraries
    // shaped snapshot, and hasn't been adapted for a flat itinerary_items one).
    if (detectUndoIntent(user_request)) {
      return new Response(JSON.stringify({
        status: "info",
        action: "undo_unsupported",
        response_message: "Undo isn't available yet for changes made this way — it's on the list, just not built. I can make the specific changes back for you if you tell me what to restore, or you can say \"show version history\" to see what changed.",
      }), { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    // ─── HISTORY INTENT ──────────────────────────────────────────────────────
    // Unaffected by the itinerary_items migration — itinerary_versions was
    // already trip_id/uuid-native. This will now return real entries once
    // this function starts writing them (see the versioning section below).
    if (detectHistoryIntent(user_request)) {
      const { data: versions } = await supabase
        .from("itinerary_versions")
        .select("id, version_number, version_name, status, is_active, creation_method, created_at")
        .eq("trip_id", trip_id)
        .eq("user_id", user_id)
        .order("version_number", { ascending: false });

      const versionList = (versions || []).map(v =>
        `Version ${v.version_number}: "${v.version_name}" (${v.creation_method?.replace(/_/g, " ").toLowerCase()})${v.is_active ? " ← current" : ""}`
      ).join("\n");

      return new Response(JSON.stringify({
        status: "info",
        action: "version_history",
        versions: versions || [],
        response_message: versions && versions.length > 0
          ? `Here are your itinerary versions:\n\n${versionList}`
          : "No version history found for this trip yet.",
      }), { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    // ─── LOAD CURRENT ITEMS (replaces reading generated_itineraries.itinerary) ──
    const { data: itemRows, error: itemsErr } = await supabase
      .from("itinerary_items")
      .select("id, title, type, category, status, date, start_time, end_time, location, notes, fixed, outdoor, must_do, starred, critical, droppable, suggested")
      .eq("trip_id", trip_id)
      .order("date", { ascending: true })
      .order("start_time", { ascending: true });
    if (itemsErr) console.error("[change-plan] itinerary_items read failed:", itemsErr.message);
    const allItems = itemRows || [];
    const currentItemIds = new Set(allItems.map((it: any) => it.id));

    // ─── HEALTH QUERY INTENT ─────────────────────────────────────────────────
    // Adapted from `.eq("itinerary_id", itinerary_id)` to `.eq("trip_id", trip_id)`
    // — trip_health_analyses has both columns; itinerary_id is the legacy one.
    if (detectHealthQueryIntent(user_request)) {
      let healthContext = "";
      try {
        const { data: healthAnalysis } = await supabase
          .from("trip_health_analyses")
          .select("health_score, health_status, issues, overall_assessment, top_issue_title, top_issue_severity, daily_friction")
          .eq("trip_id", trip_id)
          .eq("status", "ready")
          .order("analyzed_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (healthAnalysis) {
          const issues = (healthAnalysis.issues as Array<Record<string, unknown>>) || [];
          const topIssues = issues
            .filter(i => i.severity === "CRITICAL" || i.severity === "HIGH" || i.severity === "MEDIUM")
            .slice(0, 5);

          healthContext = `

TRIP HEALTH CONTEXT (current health score: ${healthAnalysis.health_score}/100, status: ${healthAnalysis.health_status}):
Overall assessment: ${healthAnalysis.overall_assessment || "Not available"}

Top issues to address:
${topIssues.map((issue, i) => `${i + 1}. [${issue.severity}] ${issue.title}: ${issue.description}\n   Recommended action: ${issue.recommended_action}`).join("\n") || "No significant issues found."}

The user is asking about trip health issues. Use this context to give a specific, actionable response about what to fix.`;
        }
      } catch (e) {
        console.error("[change-plan] Health context fetch failed (non-fatal):", e);
      }

      const destinationLabel = tripRow.destination || tripRow.title || "Unknown";
      const healthQueryMsg = `TRIP CONTEXT:
- Destination: ${destinationLabel}
- Items: ${allItems.length}
${healthContext}

USER REQUEST: "${user_request}"

Respond helpfully about the trip health issues. Be specific, actionable, and friendly. If there are issues, explain the top 2-3 most important ones and suggest concrete fixes. If the trip looks good, say so. Keep response to 3-5 sentences.`;

      const healthResp = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://travelos.app",
          "X-Title": "TravelOS",
        },
        body: JSON.stringify({
          model: "google/gemini-3.5-flash",
          messages: [
            { role: "system", content: "You are a helpful travel planning assistant. Give concise, actionable advice about trip health issues." },
            { role: "user", content: healthQueryMsg },
          ],
          temperature: 0.3,
          max_tokens: 500,
        }),
      });

      const healthRespData = await healthResp.json();
      const healthResponseMessage = healthRespData.choices?.[0]?.message?.content || "I couldn't retrieve your trip health details right now. Try running a health analysis first.";

      return new Response(JSON.stringify({
        status: "info",
        action: "health_query",
        response_message: healthResponseMessage,
      }), { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    // ─── DAY FRICTION INTENT ─────────────────────────────────────────────────
    const frictionIntent = detectDayFrictionIntent(user_request);

    let frictionContext = "";
    if (frictionIntent.detected && frictionIntent.dayNumber !== null) {
      try {
        const { data: healthAnalysis } = await supabase
          .from("trip_health_analyses")
          .select("daily_friction, issues")
          .eq("trip_id", trip_id)
          .eq("status", "ready")
          .order("analyzed_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (healthAnalysis) {
          const dailyFriction = (healthAnalysis.daily_friction as Array<Record<string, unknown>>) || [];
          const dayFriction = dailyFriction.find(d => d.day_number === frictionIntent.dayNumber);
          const dayIssues = ((healthAnalysis.issues as Array<Record<string, unknown>>) || [])
            .filter(i => Array.isArray(i.affected_days) && (i.affected_days as number[]).includes(frictionIntent.dayNumber!));

          if (dayFriction || dayIssues.length > 0) {
            frictionContext = `

HEALTH CONTEXT FOR DAY ${frictionIntent.dayNumber}:
Friction score: ${dayFriction?.friction_score ?? "unknown"}/100 (${dayFriction?.friction_label ?? "unknown"})
Primary issue: ${dayFriction?.primary_issue ?? "none identified"}
Friction factors: ${Array.isArray(dayFriction?.factors) ? (dayFriction.factors as string[]).join("; ") : "none"}

Issues affecting this day:
${dayIssues.map(i => `- [${i.severity}] ${i.title}: ${i.recommended_action}`).join("\n") || "No specific issues found for this day."}

Use this context to make targeted improvements to Day ${frictionIntent.dayNumber}.`;
          }
        }
      } catch (e) {
        console.error("[change-plan] Day friction context fetch failed (non-fatal):", e);
      }
    }

    // ─── TRIP CONTEXT (replaces reading the generated_itineraries jsonb blob) ──
    // MVP REWRITE 2026-09-21: the old "preferences" block (travel_style, pace,
    // walking_tolerance_minutes, must_do, avoid, budget, interests) is dropped
    // — nothing in the real schema stores any of it.
    const destinationLabel = tripRow.destination || tripRow.title || "Unknown";
    const itemsForPrompt = allItems.map((it: any) => ({
      id: it.id,
      day_number: dayNumberFor(it.date, tripRow.start_date),
      date: it.date,
      start_time: it.start_time,
      end_time: it.end_time,
      title: it.title,
      type: it.type,
      category: it.category,
      location: it.location,
      notes: it.notes,
      fixed: it.fixed,
      must_do: it.must_do,
      starred: it.starred,
      critical: it.critical,
    }));

    const tripContext = `TRIP CONTEXT:
- Destination: ${destinationLabel}
- Trip dates: ${tripRow.start_date || "unknown"} to ${tripRow.end_date || "unknown"}
- Item count: ${itemsForPrompt.length}
${frictionContext}

CURRENT ITEMS:
${JSON.stringify(itemsForPrompt, null, 2)}`;

    // ─── PASS 1: INTERPRET ─────────────────────────────────────────────────
    let interpretation: Record<string, unknown>;

    if (confirmed && proposed_changes) {
      interpretation = {
        understood_request: user_request,
        scope: "one_day",
        requires_clarification: false,
        is_safe_to_apply_directly: true,
        conflicts_with_confirmed: false,
        proposed_changes: Array.isArray(proposed_changes) ? proposed_changes : [proposed_changes],
        trade_offs: [],
        response_message: "Applying your changes now...",
        preview_required: false,
      };
    } else {
      const conversationContext = conversation_history.length > 0
        ? `\nCONVERSATION HISTORY:\n${conversation_history.map((m: Record<string, string>) => `${m.role.toUpperCase()}: ${m.content}`).join("\n")}\n`
        : "";

      const interpretMsg = `${tripContext}${conversationContext}

USER REQUEST: "${user_request}"

Interpret this request. Identify what changes to make, check for conflicts with fixed or must-do items, and determine if clarification is needed.`;

      const pass1Resp = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json", "HTTP-Referer": "https://travelos.app", "X-Title": "TravelOS" },
        body: JSON.stringify({ model: "google/gemini-3.5-flash", messages: [{ role: "system", content: INTERPRET_PROMPT }, { role: "user", content: interpretMsg }], response_format: { type: "json_object" }, temperature: 0.2, max_tokens: 3000 }),
      });
      if (!pass1Resp.ok) throw new Error(`Interpret error: ${await pass1Resp.text()}`);
      const pass1Data = await pass1Resp.json();
      try { interpretation = JSON.parse(pass1Data.choices?.[0]?.message?.content); }
      catch { throw new Error("Failed to parse interpretation response"); }
    }

    // If clarification needed, return early
    if (interpretation.requires_clarification && !confirmed) {
      await supabase.from("plan_changes").insert({
        trip_id, itinerary_id: null, user_id,
        user_request, conversation_history,
        interpretation, status: "needs_clarification",
        requires_clarification: true,
        clarification_question: interpretation.clarification_question,
        response_message: interpretation.clarification_question,
      });
      return new Response(JSON.stringify({
        status: "needs_clarification",
        clarification_question: interpretation.clarification_question,
        understood_request: interpretation.understood_request,
        response_message: interpretation.clarification_question,
      }), { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    // If preview required and not yet confirmed, return proposed changes for preview
    if (interpretation.preview_required && !confirmed) {
      await supabase.from("plan_changes").insert({
        trip_id, itinerary_id: null, user_id,
        user_request, conversation_history,
        interpretation, proposed_changes: interpretation.proposed_changes,
        status: "awaiting_confirmation",
        response_message: interpretation.response_message,
      });
      return new Response(JSON.stringify({
        status: "preview",
        understood_request: interpretation.understood_request,
        proposed_changes: interpretation.proposed_changes,
        trade_offs: interpretation.trade_offs,
        response_message: interpretation.response_message,
        conflicts_with_confirmed: interpretation.conflicts_with_confirmed,
        conflict_explanation: interpretation.conflict_explanation,
      }), { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    // ─── PASS 2: APPLY ─────────────────────────────────────────────────────
    const applyMsg = `${tripContext}

CHANGES TO APPLY:
${JSON.stringify(interpretation.proposed_changes, null, 2)}

USER REQUEST: "${user_request}"

Apply these changes by producing create/update/delete operations against the item list. Protect fixed and must-do items.`;

    const pass2Resp = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json", "HTTP-Referer": "https://travelos.app", "X-Title": "TravelOS" },
      body: JSON.stringify({ model: "google/gemini-3.5-flash", messages: [{ role: "system", content: APPLY_PROMPT }, { role: "user", content: applyMsg }], response_format: { type: "json_object" }, temperature: 0.2, max_tokens: 8000 }),
    });
    if (!pass2Resp.ok) throw new Error(`Apply error: ${await pass2Resp.text()}`);
    const pass2Data = await pass2Resp.json();
    let applyResult: Record<string, unknown>;
    try { applyResult = JSON.parse(pass2Data.choices?.[0]?.message?.content); }
    catch { throw new Error("Failed to parse apply response"); }

    const operations = (applyResult.operations as Array<Record<string, unknown>>) || [];
    const appliedChanges = (applyResult.applied_changes as Array<Record<string, unknown>>) || [];
    const failedChanges: Array<Record<string, unknown>> = [...((applyResult.failed_changes as Array<Record<string, unknown>>) || [])];

    // ─── EXECUTE OPERATIONS AGAINST itinerary_items ─────────────────────────
    // MVP REWRITE 2026-09-21: direct row-level CRUD, scoped to trip_id on
    // every statement, through the ITEM_WRITABLE_FIELDS whitelist above.
    let appliedOpCount = 0;
    for (const rawOp of operations) {
      const op = rawOp.op as string;
      const itemId = (rawOp.item_id as string) || null;
      const fields = sanitizeItemFields(rawOp.fields as Record<string, unknown>);
      try {
        if (op === "create") {
          if (!fields.title || !fields.date) throw new Error("create requires at least title and date");
          const { error } = await supabase.from("itinerary_items").insert({ trip_id, ...fields });
          if (error) throw error;
          appliedOpCount++;
        } else if (op === "update") {
          if (!itemId || !currentItemIds.has(itemId)) throw new Error("unknown item_id");
          const { error } = await supabase.from("itinerary_items").update(fields).eq("id", itemId).eq("trip_id", trip_id);
          if (error) throw error;
          appliedOpCount++;
        } else if (op === "delete") {
          if (!itemId || !currentItemIds.has(itemId)) throw new Error("unknown item_id");
          const { error } = await supabase.from("itinerary_items").delete().eq("id", itemId).eq("trip_id", trip_id);
          if (error) throw error;
          appliedOpCount++;
        } else {
          throw new Error(`unknown op: ${op}`);
        }
      } catch (e) {
        failedChanges.push({
          change_id: itemId || "unknown",
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }

    let newVersionId: string | null = null;
    let versionError: string | null = null;

    if (appliedOpCount > 0) {
      // ─── VERSIONING ────────────────────────────────────────────────────────
      // MVP REWRITE 2026-09-21: INSERT itinerary_versions directly, with a
      // full flat snapshot of itinerary_items taken AFTER the writes above,
      // instead of calling create-itinerary-version (which still expects a
      // generated_itineraries-shaped itinerary_id and was not touched here).
      const { data: lastVersionRows } = await supabase
        .from("itinerary_versions")
        .select("version_number")
        .eq("trip_id", trip_id)
        .order("version_number", { ascending: false })
        .limit(1);
      const nextVersionNumber = lastVersionRows?.[0]?.version_number ? lastVersionRows[0].version_number + 1 : 1;

      const { data: activeVersionRow } = await supabase
        .from("itinerary_versions")
        .select("id")
        .eq("trip_id", trip_id)
        .eq("is_active", true)
        .maybeSingle();
      const previousVersionId = activeVersionRow?.id ?? null;

      if (previousVersionId) {
        await supabase.from("itinerary_versions").update({ is_active: false }).eq("id", previousVersionId);
      }

      const { data: snapshotItems } = await supabase
        .from("itinerary_items")
        .select("*")
        .eq("trip_id", trip_id)
        .order("date", { ascending: true })
        .order("start_time", { ascending: true });

      const creationMethod = alert_id ? "ALERT_FIX" : "CONVERSATIONAL_CHANGE";
      const changeSummaryBullets: string[] = requestChangeSummary
        ? [requestChangeSummary]
        : ((applyResult.change_summary as Record<string, unknown>)?.bullets as string[] ||
           appliedChanges.map(c => (c.description as string) || (c.type as string)).filter(Boolean));

      try {
        const { data: newVersionRow, error: versionInsertErr } = await supabase
          .from("itinerary_versions")
          .insert({
            trip_id,
            user_id,
            version_number: nextVersionNumber,
            parent_version_id: previousVersionId,
            is_active: true,
            status: "ready",
            creation_method: creationMethod,
            version_name: generateVersionName(user_request),
            user_request,
            change_summary: changeSummaryBullets.slice(0, 5),
            itinerary_snapshot: snapshotItems || [],
            alert_id: alert_id || null,
            monitoring_event_id: monitoring_event_id || null,
            proposal_id: proposal_id || null,
            impact_id: impact_id || null,
            change_request: user_request,
          })
          .select("id")
          .single();

        if (versionInsertErr) throw versionInsertErr;
        newVersionId = newVersionRow.id;
      } catch (e) {
        console.error("[change-plan] itinerary_versions insert failed:", e);
        versionError = e instanceof Error ? e.message : String(e);
        // The item writes above already happened — don't leave the trip with
        // no active version because the snapshot insert failed.
        if (previousVersionId) {
          await supabase.from("itinerary_versions").update({ is_active: true }).eq("id", previousVersionId);
        }
      }

      // ─── POST-VERSION: Update copilot_proposals if proposal_id provided ────
      // Unchanged — only ever needed newVersionId + proposal_id.
      if (proposal_id && newVersionId) {
        try {
          const changeSummaryText = requestChangeSummary ||
            ((applyResult.change_summary as Record<string, unknown>)?.headline as string) ||
            `Applied: ${user_request}`;
          await supabase
            .from("copilot_proposals")
            .update({
              result_itinerary_version_id: newVersionId,
              result_version_change_summary: changeSummaryText,
              status: "COMPLETE",
              executed_at: new Date().toISOString(),
            })
            .eq("id", proposal_id);
        } catch (e) {
          console.error("[change-plan] Failed to update copilot_proposals (non-fatal):", e);
        }
      }

      // ─── POST-VERSION: Update travel_alerts if alert_id + proposal_id ──────
      if (alert_id && proposal_id) {
        try {
          await supabase
            .from("travel_alerts")
            .update({ copilot_proposal_id: proposal_id })
            .eq("id", alert_id);
        } catch (e) {
          console.error("[change-plan] Failed to update travel_alerts (non-fatal):", e);
        }
      }

      // ─── ISSUE LIFECYCLE ─────────────────────────────────────────────────
      // MVP REWRITE 2026-09-21: adapted from `.eq("itinerary_id", oldItineraryId)`
      // to `.eq("trip_id", trip_id)` — trip_issues.trip_id is a NOT NULL uuid
      // column, confirmed against the live schema.
      try {
        await supabase
          .from("trip_issues")
          .update({ status: "RESOLVED", updated_at: new Date().toISOString() })
          .eq("trip_id", trip_id)
          .in("status", ["OPEN", "ACKNOWLEDGED"]);
      } catch (e) {
        console.error("[change-plan] Failed to resolve old issues (non-fatal):", e);
      }
    }

    // Save to plan_changes (audit row). itinerary_id / previous_itinerary_id
    // are always null now — see point 11 in the header comment.
    await supabase.from("plan_changes").insert({
      trip_id,
      itinerary_id: null,
      previous_itinerary_id: null,
      user_id,
      user_request,
      conversation_history,
      interpretation,
      proposed_changes: interpretation.proposed_changes,
      applied_changes: appliedChanges,
      status: appliedOpCount > 0 ? "applied" : "no_changes",
      response_message: applyResult.response_message,
      change_summary: applyResult.change_summary,
    });

    return new Response(JSON.stringify({
      status: appliedOpCount > 0 ? "applied" : "no_changes",
      new_version_id: newVersionId,
      version_error: versionError,
      applied_changes: appliedChanges,
      failed_changes: failedChanges,
      response_message: applyResult.response_message,
      change_summary: applyResult.change_summary,
      trade_offs: interpretation.trade_offs,
      // MVP REWRITE 2026-09-21 — see point 8 in the header comment. These
      // three functions all key off a generated_itineraries-shaped
      // itinerary_id, which this function no longer creates.
      revalidation_triggered: false,
      health_recalculating: false,
      pipeline_note: appliedOpCount > 0
        ? "validate-itinerary / post-activation-recalculate / detect-trip-issues are not wired up for itinerary_items yet."
        : null,
    }), { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[change-plan] Error:", msg);
    return new Response(JSON.stringify({ error: "Internal server error" }), { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  }
});

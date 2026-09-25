// VIEWER GATE 2026-09-25 — viewers cannot run a budget analysis.
//   Every call here is a billed AI run plus a budget_analyses write, and there
//   is no cache to serve, so a user caller whose best active account role on
//   the trip is viewer now gets 403 { error: "FORBIDDEN", message: "Viewers
//   can see this trip's budget but can't run a new analysis." }.
//   owner/organizer/member are unchanged; non-members still get 404; service
//   callers are unchanged. The role read now takes every active account row
//   (best role wins) instead of an arbitrary one via limit(1).
// ITINERARY RECONCILIATION 2026-09-24 — no generated_itineraries access.
//   - body.itinerary_id is accepted and ignored; budget_analyses.itinerary_id
//     is always stored as null (the column is a GI foreign key).
//   - The GI ownership lookup is replaced by a trip membership check for user
//     callers: an active account member of the trip (any role) — the same
//     404 for "no such trip" and "not your trip". Previously a user caller who
//     sent no itinerary_id got no trip check at all.
//   - When the caller sends no itinerary_days, the days are built from the
//     live itinerary_items (grouped by date in trips.primary_tz, local HH:MM
//     times). Supplied itinerary_days are used as before.
// Service callers are unchanged.
// SECURITY 2026-09-17 — This function had verify_jwt:false and no
// authentication in code at all. It read trip_id, itinerary_id, and user_id
// straight out of the POST body, built a service_role client (bypasses
// RLS), inserted a budget_analyses row under any caller-chosen user_id, and
// called OpenRouter (google/gemini-2.0-flash-001, max_tokens 8000) with no
// gate whatsoever — an unauthenticated, uncapped LLM spend channel. It also
// accepted an arbitrary itinerary_id with no ownership check, so the
// resulting budget_analyses.itinerary_id could point at a stranger's
// itinerary.
// Fixed by requiring a verified Supabase JWT or the service-role key
// (requireUserOrService) before any database work or LLM call, deriving
// user_id from the verified token for user callers rather than the request
// body, and — when itinerary_id is supplied — confirming it belongs to that
// user before the analysis is tied to it. A mismatch returns 404, not 403,
// so itinerary ids cannot be enumerated. Service callers (the pipeline,
// with the service-role key) pass through unchanged and keep supplying
// user_id in the body as before.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { requireUserOrService, resolvePlatformUserId, serviceClient, fail } from "./_shared/auth.ts";
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY");
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};
// ── itinerary_items → days (ITINERARY RECONCILIATION 2026-09-24) ─────────
// itinerary_items.start_time / end_time are timestamptz (stored UTC). Days
// are grouped by the item's `date` column (the trip-local calendar date);
// when that is missing the date is derived from start_time in the trip's
// primary_tz. Times are rendered as local "HH:MM" in the same zone. Items
// with neither a date nor a start_time are grouped under date null.
function validTz(tz) {
  if (!tz) return null;
  try {
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz
    });
    return tz;
  } catch  {
    return null;
  }
}
function localParts(ts, tz) {
  if (!ts) return null;
  const d = new Date(String(ts).trim().replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
  if (isNaN(d.getTime())) return null;
  const p = {};
  for (const part of new Intl.DateTimeFormat('en-US', {
    timeZone: tz ?? 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(d))p[part.type] = part.value;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${p.hour}:${p.minute}`
  };
}
function itemsToDays(items, tzRaw, tripStart) {
  const tz = validTz(tzRaw);
  const byDate = new Map();
  for (const it of items){
    const start = localParts(it.start_time, tz);
    const date = it.date ?? start?.date ?? '';
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(it);
  }
  const dates = [
    ...byDate.keys()
  ].sort((a, b)=>a === '' ? 1 : b === '' ? -1 : a.localeCompare(b));
  const startMs = tripStart ? Date.parse(`${tripStart}T00:00:00Z`) : NaN;
  return dates.map((date, i)=>{
    const rows = byDate.get(date).slice().sort((a, b)=>String(a.start_time ?? '￿').localeCompare(String(b.start_time ?? '￿')));
    let dayNumber = i + 1;
    if (date && !isNaN(startMs)) {
      const n = Math.round((Date.parse(`${date}T00:00:00Z`) - startMs) / 86400000) + 1;
      if (n >= 1) dayNumber = n;
    }
    return {
      day_number: dayNumber,
      date: date || null,
      items: rows
    };
  });
}
function itemLocalTime(it, tzRaw, field = 'start_time') {
  return localParts(it[field], validTz(tzRaw))?.time ?? null;
}
const ANALYSIS_SYSTEM_PROMPT = `You are a travel budget analyst. Analyze the trip itinerary and provide a comprehensive budget breakdown.

CRITICAL RULES:
1. Return ONLY valid JSON — no markdown, no explanation, no code blocks.
2. NEVER invent prices, hotel rates, restaurant prices, attraction fees, or exchange rates.
3. Use ONLY costs from confirmed reservations (status: "confirmed") or activity estimated_cost fields.
4. For unknown costs, use null and label them "UNKNOWN".
5. Label all non-confirmed costs as "ESTIMATE".
6. Do NOT present estimates as facts.
7. If total budget is unknown, do not assume one — set budget_status to "NO_BUDGET_SET".
8. If the number of travelers is not stated, set cost_per_traveler to null. Do NOT assume one traveler.
9. If the currency is not stated, do NOT assume one — report amounts without a currency symbol and say so.
10. Be practical — identify real cost drivers, not theoretical ones.

COST STATUS VALUES:
- "CONFIRMED": from a confirmed reservation with a known cost
- "ESTIMATE": reasonable estimate from activity data
- "UNKNOWN": no reliable cost information

BUDGET STATUS VALUES:
- "UNDER_BUDGET": comfortable margin remains (>15% buffer)
- "ON_TRACK": spending reasonably aligned (5-15% buffer)
- "BUDGET_PRESSURE": approaching or exceeding target (<5% buffer or slightly over)
- "OVER_BUDGET": projected spending exceeds target
- "NO_BUDGET_SET": no budget was provided

OUTPUT FORMAT — return exactly this JSON:
{
  "total_projected_cost": number | null,
  "confirmed_cost": number,
  "estimated_cost": number,
  "cost_per_traveler": number | null,
  "average_daily_cost": number | null,
  "remaining_budget": number | null,
  "budget_status": "UNDER_BUDGET" | "ON_TRACK" | "BUDGET_PRESSURE" | "OVER_BUDGET" | "NO_BUDGET_SET",
  "budget_status_explanation": "string",
  "cost_by_category": {
    "transportation": { "amount": number | null, "status": "CONFIRMED"|"ESTIMATE"|"UNKNOWN", "percentage": number | null },
    "lodging": { "amount": number | null, "status": "CONFIRMED"|"ESTIMATE"|"UNKNOWN", "percentage": number | null },
    "food": { "amount": number | null, "status": "CONFIRMED"|"ESTIMATE"|"UNKNOWN", "percentage": number | null },
    "activities": { "amount": number | null, "status": "CONFIRMED"|"ESTIMATE"|"UNKNOWN", "percentage": number | null },
    "entertainment": { "amount": number | null, "status": "CONFIRMED"|"ESTIMATE"|"UNKNOWN", "percentage": number | null },
    "shopping": { "amount": number | null, "status": "CONFIRMED"|"ESTIMATE"|"UNKNOWN", "percentage": number | null },
    "miscellaneous": { "amount": number | null, "status": "CONFIRMED"|"ESTIMATE"|"UNKNOWN", "percentage": number | null }
  },
  "cost_drivers": [
    {
      "rank": number,
      "category": "string",
      "amount": number | null,
      "percentage": number | null,
      "status": "CONFIRMED"|"ESTIMATE"|"UNKNOWN",
      "description": "string"
    }
  ],
  "daily_analysis": [
    {
      "day_number": number,
      "date": "string | null",
      "city": "string",
      "estimated_total": number | null,
      "daily_budget": number | null,
      "remaining_daily": number | null,
      "budget_status": "UNDER_BUDGET"|"ON_TRACK"|"BUDGET_PRESSURE"|"OVER_BUDGET"|"NO_BUDGET_SET",
      "main_cost_drivers": ["string"],
      "cost_breakdown": {
        "food": number | null,
        "activities": number | null,
        "transport": number | null,
        "other": number | null
      },
      "notes": "string"
    }
  ],
  "savings_opportunities": [
    {
      "id": "string",
      "rank": number,
      "title": "string",
      "description": "string",
      "potential_savings_min": number | null,
      "potential_savings_max": number | null,
      "savings_label": "string (e.g. 'Estimated $40-$60' or 'VERIFY CURRENT PRICE')",
      "traveler_impact": "LOW" | "MODERATE" | "HIGH",
      "impact_explanation": "string",
      "why_recommended": "string",
      "activity_ids": ["string"],
      "day_numbers": [number],
      "category": "optional_activity" | "dining" | "transportation" | "entertainment" | "shopping" | "hotel_upgrade" | "duplicate_experience" | "other",
      "protects_must_do": boolean,
      "auto_applicable": boolean
    }
  ],
  "budget_scenarios": {
    "current": {
      "label": "Current Plan",
      "estimated_total": number | null,
      "daily_average": number | null,
      "description": "string",
      "experiences_note": "string"
    },
    "lower_cost": {
      "label": "Lower Cost",
      "estimated_total": number | null,
      "daily_average": number | null,
      "description": "string",
      "major_changes": ["string"],
      "experiences_lost": ["string"],
      "experiences_kept": ["string"]
    },
    "comfortable": {
      "label": "Comfortable",
      "estimated_total": number | null,
      "daily_average": number | null,
      "description": "string",
      "major_changes": ["string"],
      "experiences_gained": ["string"]
    },
    "splurge": {
      "label": "Splurge",
      "estimated_total": number | null,
      "daily_average": number | null,
      "description": "string",
      "major_changes": ["string"],
      "experiences_gained": ["string"]
    }
  },
  "hidden_costs": [
    {
      "title": "string",
      "description": "string",
      "estimated_amount": number | null,
      "label": "POSSIBLE ADDITIONAL COST — VERIFY",
      "category": "string"
    }
  ],
  "budget_buffer_recommendation": "string",
  "user_summary": {
    "headline": "string (e.g. 'Your trip is on track')",
    "subheadline": "string",
    "savings_count": number,
    "potential_savings_range": "string"
  },
  "cost_confidence": "HIGH" | "MEDIUM" | "LOW",
  "cost_note": "string (e.g. 'All costs are estimates unless marked CONFIRMED. Verify before booking.')"
}`;
serve(async (req)=>{
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: CORS_HEADERS
    });
  }
  const caller = await requireUserOrService(req);
  if (caller instanceof Response) return caller;
  const supabase = serviceClient();
  let analysisId = null;
  try {
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
    // itinerary_id (legacy GI id) is accepted and ignored — see the header.
    const { trip_id, trip_data, preferences } = body;
    let itinerary_days = body.itinerary_days;
    const user_id = caller.kind === "user" ? caller.userId : body.user_id;
    if (!trip_id || !user_id) {
      return new Response(JSON.stringify({
        error: "trip_id and user_id are required"
      }), {
        status: 400,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/json"
        }
      });
    }
    // Trip membership (ITINERARY RECONCILIATION 2026-09-24) — replaces the
    // old generated_itineraries ownership lookup. trip_members.user_id is the
    // platform TEXT id space, bridged from auth.uid(). 404 either way.
    if (caller.kind === "user") {
      const platformUserId = await resolvePlatformUserId(supabase, caller.userId);
      const { data: member, error: memberError } = platformUserId ? await supabase.from("trip_members").select("role").eq("trip_id", trip_id).eq("user_id", platformUserId).eq("kind", "account").is("removed_at", null) : {
        data: null,
        error: null
      };
      if (memberError) {
        console.error("[analyze-budget] trip_members lookup failed:", memberError.code, memberError.message);
        return fail("Trip lookup failed", 500);
      }
      const roles = (member ?? []).map((m)=>m.role ?? "");
      if (roles.length === 0) return fail("Trip not found", 404);
      // VIEWER GATE 2026-09-25 — see header.
      if (!roles.some((r)=>r === "owner" || r === "organizer" || r === "member")) {
        return new Response(JSON.stringify({
          error: "FORBIDDEN",
          message: "Viewers can see this trip's budget but can't run a new analysis."
        }), {
          status: 403,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "application/json"
          }
        });
      }
    }
    // No itinerary_days from the caller → build them from itinerary_items.
    if (!Array.isArray(itinerary_days) || itinerary_days.length === 0) {
      const [{ data: tripRowForDays }, { data: itemRows, error: itemsError }] = await Promise.all([
        supabase.from("trips").select("primary_tz, start_date").eq("id", trip_id).maybeSingle(),
        supabase.from("itinerary_items").select("id, title, type, category, date, start_time, end_time, duration_min, location, notes, fixed, must_do").eq("trip_id", trip_id).order("date", {
          ascending: true,
          nullsFirst: false
        }).order("start_time", {
          ascending: true,
          nullsFirst: false
        })
      ]);
      if (itemsError) {
        console.error("[analyze-budget] itinerary_items lookup failed:", itemsError.code, itemsError.message);
      }
      const tz = tripRowForDays?.primary_tz ?? null;
      itinerary_days = itemsToDays(itemRows ?? [], tz, tripRowForDays?.start_date ?? null).map((d)=>({
          day_number: d.day_number,
          date: d.date,
          activities: d.items.map((it)=>({
              id: it.id,
              title: it.title ?? null,
              category: it.category ?? it.type ?? null,
              time: itemLocalTime(it, tz),
              duration_minutes: it.duration_min ?? null,
              location: it.location ?? null,
              notes: it.notes ?? null,
              status: it.fixed === true ? "CONFIRMED" : "SUGGESTED",
              must_do: it.must_do === true,
              // itinerary_items carries no cost field; nothing is invented here.
              estimated_cost: null
            }))
        }));
    }
    // DEFECT 2026-09-19 (fabricated data) — the currency written to
    // budget_analyses.currency was `trip_data?.currency || "USD"`. When the
    // caller did not supply a currency, every figure in the analysis was
    // labelled and stored as US dollars, regardless of where the traveller was
    // going or what currency they actually budget in. A Japanese trip budgeted
    // in yen came back reading "USD 480,000". The trip's real currency lives in
    // trips.base_currency, so that is consulted before giving up; if neither is
    // known the column is set to an explicit NULL (which also overrides the
    // column's own 'USD' default) and the prompt tells the model the currency
    // is unknown.
    let currency = trip_data?.currency ?? null;
    if (!currency) {
      const { data: tripRow, error: tripError } = await supabase.from("trips").select("base_currency").eq("id", trip_id).maybeSingle();
      if (tripError) {
        console.error("[analyze-budget] trips.base_currency lookup failed:", tripError.code, tripError.message);
      }
      currency = tripRow?.base_currency ?? null;
    }
    const currencyLabel = currency ?? "(currency not specified)";
    // Create placeholder record
    const { data: record, error: insertError } = await supabase.from("budget_analyses").insert({
      trip_id,
      itinerary_id: null,
      user_id,
      status: "analyzing",
      total_budget: trip_data?.budget ?? null,
      currency,
      preferences_snapshot: preferences || null
    }).select().single();
    if (insertError || !record) throw new Error(`Failed to create analysis record: ${insertError?.message}`);
    analysisId = record.id;
    // DEFECT 2026-09-19 (fabricated data) — this was
    // `(trip_data?.travelers || []).length || preferences?.traveler_count || 1`.
    // A trip with no traveller list and no stated traveller count silently
    // became a solo trip, and the model then divided the whole budget by one
    // and reported a cost_per_traveler that was simply the trip total. For a
    // family of four that understates per-person cost by 4x in the other
    // direction — and nothing in the stored analysis recorded that the figure
    // rested on an invented headcount. Unknown now stays unknown.
    const travelerCountRaw = (trip_data?.travelers || []).length || preferences?.traveler_count;
    const travelerCount = typeof travelerCountRaw === "number" && travelerCountRaw > 0 ? travelerCountRaw : null;
    const totalDays = itinerary_days?.length || 0;
    const confirmedReservations = (trip_data?.reservations || []).filter((r)=>r.status === "confirmed");
    const confirmedCost = confirmedReservations.reduce((sum, r)=>sum + (Number(r.cost) || 0), 0);
    const existingExpenses = trip_data?.expenses || [];
    const totalExpenses = existingExpenses.reduce((sum, e)=>sum + (Number(e.amount) || 0), 0);
    const userMessage = `Analyze the budget for this trip.

TRIP DETAILS:
- Destination: ${trip_data?.destination || preferences?.destination || "Unknown"}
- Dates: ${trip_data?.startDate || ""} to ${trip_data?.endDate || ""}
- Duration: ${totalDays} days
- Travelers: ${travelerCount ?? "NOT SPECIFIED — do not assume a number; set cost_per_traveler to null"}
- Currency: ${currency ?? "NOT SPECIFIED — do not assume one"}
- Total Budget: ${trip_data?.budget ? `${currencyLabel} ${trip_data.budget}` : "NOT SET"}
- Travel Style: ${trip_data?.travelStyle || preferences?.travel_style || "Not specified"}
- Traveler Priorities: ${(preferences?.interests || []).join(", ") || "Not specified"}
- Must-do items: ${(preferences?.must_do || []).join(", ") || "None specified"}

CONFIRMED RESERVATIONS (treat costs as CONFIRMED):
${JSON.stringify(confirmedReservations, null, 2)}
Total confirmed cost: ${currencyLabel} ${confirmedCost}

EXISTING EXPENSES (already spent):
${JSON.stringify(existingExpenses, null, 2)}
Total expenses: ${currencyLabel} ${totalExpenses}

ITINERARY (${totalDays} days with estimated activity costs):
${JSON.stringify(itinerary_days, null, 2)}

TRAVELER PREFERENCES:
${JSON.stringify(preferences, null, 2)}

Analyze the complete budget. Use ONLY costs from confirmed reservations and activity estimated_cost fields. Do NOT invent prices. For unknown costs, use null.`;
    const orResponse = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://travelos.app",
        "X-Title": "TravelOS"
      },
      body: JSON.stringify({
        model: "google/gemini-3.5-flash",
        messages: [
          {
            role: "system",
            content: ANALYSIS_SYSTEM_PROMPT
          },
          {
            role: "user",
            content: userMessage
          }
        ],
        response_format: {
          type: "json_object"
        },
        temperature: 0.1,
        max_tokens: 8000
      })
    });
    if (!orResponse.ok) throw new Error(`OpenRouter error: ${await orResponse.text()}`);
    const orData = await orResponse.json();
    let analysis;
    try {
      analysis = JSON.parse(orData.choices?.[0]?.message?.content);
    } catch  {
      throw new Error("Failed to parse AI budget analysis response");
    }
    // DEFECT 2026-09-19 — `estimated_cost: analysis.estimated_cost || 0` wrote a
    // hard zero whenever the model reported the estimated cost as unknown
    // (null) — and also whenever it genuinely was zero, which `||` cannot tell
    // apart. "We could not estimate the uncommitted cost of this trip" and
    // "this trip has no uncommitted cost" are opposite statements and the
    // column stored the same 0 for both. Unknown is now NULL.
    const estimatedCost = typeof analysis.estimated_cost === "number" ? analysis.estimated_cost : null;
    const confirmedCostOut = typeof analysis.confirmed_cost === "number" ? analysis.confirmed_cost : confirmedCost;
    // DEFECT 2026-09-19 (failure-looks-like-success) — the error from this
    // update was discarded. If the save failed, the row stayed at status
    // "analyzing" forever while this function returned status "ready" plus the
    // full analysis, so the client showed results that were never persisted and
    // the next page load found a budget analysis stuck mid-run.
    const { error: saveError } = await supabase.from("budget_analyses").update({
      status: "ready",
      total_projected_cost: analysis.total_projected_cost,
      confirmed_cost: confirmedCostOut,
      estimated_cost: estimatedCost,
      cost_per_traveler: analysis.cost_per_traveler,
      average_daily_cost: analysis.average_daily_cost,
      remaining_budget: analysis.remaining_budget,
      budget_status: analysis.budget_status,
      cost_by_category: analysis.cost_by_category,
      daily_analysis: analysis.daily_analysis,
      cost_drivers: analysis.cost_drivers,
      savings_opportunities: analysis.savings_opportunities,
      budget_scenarios: analysis.budget_scenarios,
      hidden_costs: analysis.hidden_costs,
      user_summary: analysis.user_summary,
      analyzed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }).eq("id", analysisId);
    if (saveError) {
      throw new Error(`Failed to save budget analysis: ${saveError.message}`);
    }
    return new Response(JSON.stringify({
      analysis_id: analysisId,
      status: "ready",
      currency,
      traveler_count: travelerCount,
      ...analysis
    }), {
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/json"
      }
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[analyze-budget] Error:", message);
    if (analysisId) {
      await supabase.from("budget_analyses").update({
        status: "failed"
      }).eq("id", analysisId);
    }
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

// PLAN_TOO_LONG 2026-09-25 — a 15-day trip failed after ~90s with "Failed to
// parse AI response as JSON" (500): the JSON was cut off at max_tokens 16000.
//   - max_tokens 16000 -> 48000 (google/gemini-3.5-flash: 65,536 max output).
//   - Trips longer than 7 days (from trips.start_date/end_date, else the
//     preferences) ask the model for one-sentence activity descriptions and
//     short notes, so the plan fits.
//   - finish_reason "length", unparseable JSON, or no `days` array now returns
//     422 { error: "PLAN_TOO_LONG", message: "That trip is too long to plan in
//     one go. Try again, or plan a shorter stretch." } instead of a 500.
//   Auth, membership check, prompt rules, and the success response are
//   unchanged. OpenRouter HTTP errors and other failures are still 500.
//
// ITINERARY RECONCILIATION 2026-09-24 — this function no longer touches the
// legacy generated_itineraries table (being retired; the live itinerary is
// itinerary_items, history is itinerary_versions).
//   - No GI insert/update: no placeholder row, no "ready"/"failed" update, no
//     regeneration deactivation of an old GI row (body.itinerary_id is now
//     accepted and ignored).
//   - The background calls to validate-itinerary, analyze-pace and
//     create-itinerary-version are removed. All three were keyed on a GI
//     itinerary_id; validate-itinerary and create-itinerary-version are retired
//     (410), and analyze-pace cannot read a plan that was never stored.
//   - The response shape is unchanged except that itinerary_id is always null:
//     { itinerary_id: null, status: "ready", trip_summary, days }. The plan is
//     a draft the client shows; "Add to my trip" goes through the
//     itinerary_add_items RPC, which writes itinerary_items + a version.
//   - The trip membership check is unchanged.
//
// SECURITY 2026-09-17 — This function had verify_jwt:false and did nothing
// in code to make up for it: there was no Authorization check at all. It
// read trip_id and user_id straight out of the POST body, built a
// service_role client (bypasses RLS), inserted a generated_itineraries row
// under any caller-chosen user_id, and then called OpenRouter
// (google/gemini-2.0-flash-001, max_tokens 16000) with no gate whatsoever —
// an unauthenticated, uncapped LLM spend channel. Worse, when `itinerary_id`
// was supplied (the regeneration path) it deactivated that itinerary
// (`is_active = false`) with no ownership filter at all, so any caller could
// silently deactivate a stranger's active itinerary by guessing/enumerating
// its uuid.
// Fixed by requiring a verified Supabase JWT or the service-role key
// (requireUserOrService) before any database work or LLM call, deriving
// user_id from the verified token for user callers rather than the request
// body, confirming the caller is an active member of the trip
// (trip_members, bridged from auth.uid() via resolvePlatformUserId —
// trip_members.user_id is the platform TEXT id space, never comparable to
// auth.uid()) before generating anything for that trip, and scoping the
// regeneration's deactivation update to the resolved user_id so it can only
// ever touch that user's own itinerary rows. A mismatch returns 404, not
// 403, so trip/itinerary ids cannot be enumerated. Service callers (the
// pipeline, with the service-role key) pass through unchanged and keep
// supplying user_id/trip_id in the body as before.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { requireUserOrService, resolvePlatformUserId, serviceClient, fail } from "./_shared/auth.ts";
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY");
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};
// (2026-09-24) callFunction()/background() removed together with the three
// downstream calls they served — see the header.
// PLAN_TOO_LONG 2026-09-25 — see the header.
const MAX_OUTPUT_TOKENS = 48000; // google/gemini-3.5-flash allows 65,536 output tokens (OpenRouter)
const LONG_TRIP_DAYS = 7;
const PLAN_TOO_LONG_MESSAGE = "That trip is too long to plan in one go. Try again, or plan a shorter stretch.";
function planTooLong() {
  return new Response(JSON.stringify({
    error: "PLAN_TOO_LONG",
    message: PLAN_TOO_LONG_MESSAGE
  }), {
    status: 422,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json"
    }
  });
}
function daysBetween(start, end) {
  if (typeof start !== "string" || typeof end !== "string") return null;
  const a = Date.parse(start.slice(0, 10));
  const b = Date.parse(end.slice(0, 10));
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return Math.round((b - a) / 86400000) + 1;
}
/** Trip length in days from the trip row, else from preferences; null when unknown. Never throws. */ // deno-lint-ignore no-explicit-any
async function tripLengthDays(supabase, tripId, preferences) {
  try {
    const { data } = await supabase.from("trips").select("start_date, end_date").eq("id", tripId).maybeSingle();
    const fromTrip = daysBetween(data?.start_date, data?.end_date);
    if (fromTrip !== null) return fromTrip;
  } catch (_) {}
  const fromPrefs = daysBetween(preferences?.start_date, preferences?.end_date);
  if (fromPrefs !== null) return fromPrefs;
  for (const k of [
    "total_days",
    "trip_length_days",
    "duration_days",
    "days",
    "num_days"
  ]){
    const n = Number(preferences?.[k]);
    if (Number.isInteger(n) && n > 0 && n < 400) return n;
  }
  return null;
}
const SYSTEM_PROMPT = `You are an expert travel planner. Generate a complete, realistic, day-by-day itinerary based on the traveler's confirmed preferences.

CRITICAL RULES:
1. NEVER invent reservation numbers, confirmed prices, opening hours, flight info, hotel availability, or addresses.
2. Label ALL cost estimates as "ESTIMATE" and all timing as "APPROXIMATE".
3. Label ALL suggested items as "SUGGESTED" and confirmed reservations as "CONFIRMED".
4. Create a REALISTIC, ACHIEVABLE schedule — not a wishlist. Consider travel time between locations.
5. Respect geographic logic: don't schedule activities on opposite sides of a city back-to-back.
6. Handle arrival/departure days differently: lighter schedule, account for travel time.
7. Include meals (breakfast, lunch, dinner) every day.
8. Include rest periods appropriate to the pace preference.
9. Respect walking tolerance — if max 20 minutes walking, don't schedule long walking tours.
10. Respect must-do items and avoid items strictly.
11. Return ONLY valid JSON — no markdown, no explanation, no code blocks.

OUTPUT FORMAT — return exactly this JSON structure:

{
  "trip_summary": {
    "destination": "string",
    "total_days": number,
    "total_activities": number,
    "estimated_total_cost": number | null,
    "estimated_daily_average": number | null,
    "currency": "string",
    "overall_pace": "relaxed" | "balanced" | "busy",
    "walking_intensity": "light" | "moderate" | "heavy",
    "confirmed_reservations_count": number,
    "suggested_activities_count": number,
    "cost_note": "All costs are estimates. Verify before booking.",
    "cities_covered": ["string"],
    "travel_style_summary": "string"
  },
  "days": [
    {
      "day_number": number,
      "date": "YYYY-MM-DD or null if dates unknown",
      "day_label": "string (e.g. 'Day 1 — Arrival in Rome')",
      "city": "string",
      "is_arrival_day": boolean,
      "is_departure_day": boolean,
      "theme": "string (e.g. 'Ancient Rome')",
      "pace": "relaxed" | "balanced" | "busy",
      "estimated_walking_minutes": number,
      "activities": [
        {
          "id": "string (unique, e.g. 'd1-a1')",
          "time": "HH:MM (approximate)",
          "title": "string",
          "description": "string (2-3 sentences, why it fits this traveler)",
          "duration_minutes": number,
          "location": "string (neighborhood or area, NOT a specific address)",
          "category": "arrival" | "departure" | "hotel" | "meal" | "attraction" | "activity" | "transport" | "rest" | "free-time",
          "status": "CONFIRMED" | "SUGGESTED" | "OPTIONAL",
          "estimated_cost": number | null,
          "cost_label": "ESTIMATE" | "CONFIRMED" | "FREE" | "VERIFY",
          "walking_from_previous_minutes": number | null,
          "transport_suggestion": "string | null",
          "reservation_required": "YES" | "NO" | "RECOMMENDED" | "UNKNOWN",
          "notes": "string | null",
          "why_it_fits": "string (1 sentence connecting to traveler preferences)"
        }
      ],
      "meals": {
        "breakfast": "string (brief suggestion)",
        "lunch": "string (brief suggestion)",
        "dinner": "string (brief suggestion)"
      },
      "daily_summary": {
        "activity_count": number,
        "estimated_walking_minutes": number,
        "estimated_transport_cost": number | null,
        "estimated_food_cost": number | null,
        "estimated_activity_cost": number | null,
        "estimated_total_cost": number | null,
        "free_time_minutes": number,
        "pace_label": "RELAXED" | "BALANCED" | "BUSY",
        "notes": "string"
      }
    }
  ]
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
    // itinerary_id (the old GI regeneration target) is accepted and ignored.
    const { trip_id, preferences, existing_reservations, regeneration_reason } = body;
    const user_id = caller.kind === "user" ? caller.userId : body.user_id;
    if (!trip_id || !user_id || !preferences) {
      return new Response(JSON.stringify({
        error: "trip_id, user_id, and preferences are required"
      }), {
        status: 400,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/json"
        }
      });
    }
    // Confirm the caller is an active member of this trip before generating
    // anything for it. trip_members.user_id is the platform TEXT id space, so
    // we bridge auth.uid() -> platform user id rather than comparing directly.
    if (caller.kind === "user") {
      const platformUserId = await resolvePlatformUserId(supabase, caller.userId);
      const { data: member } = platformUserId ? await supabase.from("trip_members").select("id").eq("trip_id", trip_id).eq("user_id", platformUserId).is("removed_at", null).maybeSingle() : {
        data: null
      };
      if (!member) return fail("Trip not found", 404);
    }
    // Build the user message
    let userMessage = `Generate a complete day-by-day itinerary for this trip:\n\n`;
    userMessage += `CONFIRMED PREFERENCES:\n${JSON.stringify(preferences, null, 2)}\n\n`;
    if (existing_reservations && existing_reservations.length > 0) {
      userMessage += `EXISTING CONFIRMED RESERVATIONS (treat as fixed constraints, do NOT move or replace):\n${JSON.stringify(existing_reservations, null, 2)}\n\n`;
    }
    if (regeneration_reason) {
      userMessage += `REGENERATION ADJUSTMENT REQUESTED: ${regeneration_reason}\nPlease adjust the itinerary accordingly while keeping the same destination and dates.\n\n`;
    }
    // DEFECT 2026-09-19 (fabricated data) — these reminder lines used to read
    // `preferences.walking_tolerance_minutes || 30` and `preferences.pace ||
    // "balanced"`. When the traveler had never stated a walking tolerance or a
    // pace, the prompt asserted to the model that they had: it was told, as
    // fact, "walking tolerance of 30 minutes maximum" and "Pace preference:
    // balanced". The itinerary that came back was then built around two
    // preferences the user never expressed, and nothing downstream could tell
    // the invented values apart from real ones. Unstated preferences are now
    // reported to the model as unstated, so it can plan conservatively and say
    // so, rather than being handed a confident default.
    const walkingTolerance = preferences.walking_tolerance_minutes;
    const pace = preferences.pace;
    userMessage += `Important reminders:
- Label ALL costs as ESTIMATE unless from confirmed reservations
- Label ALL activities as SUGGESTED unless from confirmed reservations  
- Handle arrival day (Day 1) and departure day (last day) with lighter schedules
- ${typeof walkingTolerance === "number" ? `Respect the walking tolerance of ${walkingTolerance} minutes maximum` : `The traveler has NOT stated a walking tolerance. Do not assume one — keep walking legs modest and note in each day's summary that walking tolerance was not specified.`}
- ${pace ? `Pace preference: ${pace}` : `The traveler has NOT stated a pace preference. Do not assume one — choose a defensible pace from the rest of the preferences and say in trip_summary.travel_style_summary that pace was not specified.`}
- Must include: ${(preferences.must_do || []).join(", ") || "no specific must-dos"}
- Must avoid: ${(preferences.avoid || []).join(", ") || "nothing specific"}`;
    // PLAN_TOO_LONG 2026-09-25: long trips ask for one-sentence descriptions so
    // the whole plan fits in one response.
    const tripDays = await tripLengthDays(supabase, trip_id, preferences);
    if (tripDays !== null && tripDays > LONG_TRIP_DAYS) {
      userMessage += `
- This is a ${tripDays}-day trip. Keep it compact so the whole plan fits: each activity's "description" is ONE short sentence, "why_it_fits" and "notes" are short (or null), and meals/daily_summary notes are brief.`;
    }
    // Call OpenRouter
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
            content: SYSTEM_PROMPT
          },
          {
            role: "user",
            content: userMessage
          }
        ],
        response_format: {
          type: "json_object"
        },
        temperature: 0.4,
        max_tokens: MAX_OUTPUT_TOKENS
      })
    });
    if (!orResponse.ok) {
      const errText = await orResponse.text();
      throw new Error(`OpenRouter error: ${errText}`);
    }
    const orData = await orResponse.json();
    const content = orData.choices?.[0]?.message?.content;
    const finishReason = orData.choices?.[0]?.finish_reason ?? orData.choices?.[0]?.native_finish_reason ?? null;
    // PLAN_TOO_LONG 2026-09-25: a truncated (finish_reason "length") or
    // unparseable response is a 422 the client can show, not a 500.
    if (finishReason === "length") {
      console.error("[generate-itinerary] output truncated at max_tokens", {
        tripDays,
        max_tokens: MAX_OUTPUT_TOKENS
      });
      return planTooLong();
    }
    let itinerary;
    try {
      itinerary = JSON.parse(content);
    } catch  {
      console.error("[generate-itinerary] Failed to parse AI response as JSON", {
        finishReason,
        tripDays,
        length: typeof content === "string" ? content.length : null
      });
      return planTooLong();
    }
    if (!itinerary || typeof itinerary !== "object" || !Array.isArray(itinerary.days)) {
      console.error("[generate-itinerary] AI response has no days array", {
        finishReason,
        tripDays
      });
      return planTooLong();
    }
    // Nothing is persisted here (ITINERARY RECONCILIATION 2026-09-24). The
    // client adds the plan to the trip via the itinerary_add_items RPC.
    return new Response(JSON.stringify({
      itinerary_id: null,
      status: "ready",
      trip_summary: itinerary.trip_summary,
      days: itinerary.days
    }), {
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/json"
      }
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[generate-itinerary] Error:", message);
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

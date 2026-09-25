import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY");
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};
const SYSTEM_PROMPT = `You are a travel planning assistant. Extract structured trip preferences from the user's natural language input.

CRITICAL RULES:
1. Only extract information EXPLICITLY stated by the user. Never invent, assume, or fill in gaps.
2. If a piece of information is not mentioned, omit that field entirely from your response.
3. Return ONLY valid JSON — no markdown, no explanation, no code blocks.
4. In the "missing_required" array, list any of these fields that are needed to build an itinerary but were NOT provided: destination, duration (either dates or number of days).
5. Clearly distinguish user-provided facts from anything inferred.

Return a JSON object with only the fields that were explicitly mentioned. Available fields:
- destination (string)
- cities (string[])
- duration_days (number)
- start_date (string, ISO date)
- end_date (string, ISO date)
- traveler_count (number)
- traveler_ages (number[]) — ages of ALL travelers
- child_ages (number[]) — ages of children specifically
- budget (number)
- currency (string, default "USD")
- budget_excludes_flights (boolean)
- travel_style (string)
- pace (string: "relaxed" | "balanced" | "fast-paced")
- walking_tolerance_minutes (number)
- interests (string[])
- food_preferences (string[])
- transportation_preferences (string[])
- hotel_preferences (string[])
- max_hotel_changes (number)
- must_do (string[])
- avoid (string[])
- additional_constraints (string[])
- missing_required (string[]) — fields REQUIRED to build an itinerary but NOT provided
- confidence_notes (string) — brief note about what was clear vs. ambiguous`;
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS
    }
  });
}
serve(async (req)=>{
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: CORS
    });
  }
  if (req.method !== "POST") {
    return json({
      error: "Method not allowed"
    }, 405);
  }
  // ---------------------------------------------------------------------------
  // AUTH GATE — must run BEFORE the body is parsed and before any upstream call.
  //
  // verify_jwt: true is NOT an authorization check. The project's publishable
  // (anon) key is itself a valid JWT, ships in every client bundle, and passes
  // the platform gate. Without this in-code check anyone on the internet could
  // call this function and bill the project's OpenRouter account. That was the
  // state of this function until 2026-09-18; do not remove this block.
  // ---------------------------------------------------------------------------
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    return json({
      error: "Unauthorized"
    }, 401);
  }
  const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: {
      headers: {
        Authorization: `Bearer ${token}`
      }
    }
  });
  const { data: userData, error: authErr } = await anonClient.auth.getUser();
  if (authErr || !userData?.user) {
    if (authErr) console.error("[extract-trip-preferences] auth failed:", authErr.message);
    return json({
      error: "Invalid token"
    }, 401);
  }
  if (!OPENROUTER_API_KEY) {
    console.error("[extract-trip-preferences] OPENROUTER_API_KEY is not configured");
    return json({
      error: "AI extraction is not configured"
    }, 503);
  }
  let body;
  try {
    body = await req.json();
  } catch  {
    return json({
      error: "invalid_json"
    }, 400);
  }
  const user_input = body?.user_input;
  const trip_context = body?.trip_context;
  if (!user_input || typeof user_input !== "string") {
    return json({
      error: "user_input is required"
    }, 400);
  }
  let userMessage = user_input;
  if (trip_context) {
    userMessage = `Existing trip context (already known — do not ask user to re-enter):\n` + `${JSON.stringify(trip_context, null, 2)}\n\nUser's additional input:\n${user_input}`;
  }
  try {
    const response = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
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
        temperature: 0.1
      })
    });
    if (!response.ok) {
      const err = await response.text().catch(()=>"<unreadable>");
      // Log the upstream body; do not return it — it can echo key material.
      console.error("[extract-trip-preferences] openrouter failed", response.status, err.slice(0, 500));
      return json({
        error: "AI extraction failed",
        status: response.status
      }, 502);
    }
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    let extracted;
    try {
      extracted = JSON.parse(content);
    } catch  {
      console.error("[extract-trip-preferences] model returned non-JSON:", String(content).slice(0, 500));
      return json({
        error: "Failed to parse AI response"
      }, 502);
    }
    return json({
      extracted
    });
  } catch (err) {
    console.error("[extract-trip-preferences] unhandled:", err instanceof Error ? err.message : String(err));
    return json({
      error: "Internal error"
    }, 500);
  }
});

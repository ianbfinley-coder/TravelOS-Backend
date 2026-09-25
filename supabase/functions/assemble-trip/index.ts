import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY");
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
  };
}
function countByType(reservations, type) {
  return reservations.filter((r)=>r.reservation_type === type).length;
}
async function callAI(trip, reservations) {
  const reservationPayload = reservations.map((r)=>({
      id: r.id,
      reservation_type: r.reservation_type,
      provider_name: r.provider_name ?? null,
      confirmation_number: r.confirmation_number ?? null,
      reservation_status: r.reservation_status,
      start_date: r.start_date ?? null,
      start_time: r.start_time ?? null,
      end_date: r.end_date ?? null,
      end_time: r.end_time ?? null,
      timezone: r.timezone ?? null,
      location_name: r.location_name ?? null,
      city: r.city ?? null,
      country: r.country ?? null,
      details: r.details ?? {}
    }));
  const systemPrompt = `You are a travel intelligence engine for TravelOS. Your job is to analyze a traveler's confirmed reservations and produce a structured trip assembly.

CRITICAL RULES:
1. Only use information from the provided reservations — never invent facts
2. If information is missing or unclear, mark it as UNKNOWN
3. Do not infer travel times, distances, or connections unless explicitly supported by reservation data
4. Distinguish between KNOWN facts and POSSIBLE inferences
5. A missing hotel does not automatically mean a problem — the traveler may have other arrangements
6. Use cautious language for gaps and conflicts
7. Respond with ONLY valid JSON`;
  // FABRICATION FIX 2026-09-19 — this prompt previously read `trip.travelers`
  // and, because public.trips has no `travelers` column, the property was
  // always `undefined` and `?? 1` silently told the model every trip had
  // exactly one traveler. No 42703 is raised for a property read on a
  // `select('*')` row, so nothing surfaced. The party size is not stored on
  // trips, so it is now reported honestly as not specified.
  const travelersLine = "not specified";
  const userPrompt = `Analyze these travel reservations and produce a structured trip assembly.

TRIP:
- Destination: ${trip.destination ?? "Unknown"}
- Start: ${trip.start_date ?? "Unknown"}
- End: ${trip.end_date ?? "Unknown"}
- Travelers: ${travelersLine}

RESERVATIONS:
${JSON.stringify(reservationPayload, null, 2)}

Produce this exact JSON structure:
{
  "trip_start": "YYYY-MM-DD or null",
  "trip_end": "YYYY-MM-DD or null",
  "duration_days": "number or null",
  "assembly_status": "COMPLETE | MOSTLY_COMPLETE | NEEDS_REVIEW | UNKNOWN",
  "confidence": "HIGH | MEDIUM | LOW",
  "assembly_notes": "brief plain-language summary of the trip structure",
  "destinations": [
    {
      "city": "string",
      "country": "string or null",
      "arrival_date": "YYYY-MM-DD or null",
      "departure_date": "YYYY-MM-DD or null",
      "nights": "number or null",
      "hotel_reservation_id": "uuid or null",
      "confidence": "HIGH | MEDIUM | LOW"
    }
  ],
  "travel_segments": [
    {
      "segment_id": "string (e.g. seg-1)",
      "type": "FLIGHT | TRAIN | BUS | RENTAL_CAR | TRANSFER | OTHER",
      "from_location": "string or null",
      "to_location": "string or null",
      "departure_date": "YYYY-MM-DD or null",
      "departure_time": "HH:MM or null",
      "arrival_date": "YYYY-MM-DD or null",
      "arrival_time": "HH:MM or null",
      "carrier": "string or null",
      "reservation_id": "uuid matching an actual reservation id",
      "confidence": "HIGH | MEDIUM | LOW"
    }
  ],
  "accommodation_periods": [
    {
      "location": "string",
      "check_in_date": "YYYY-MM-DD or null",
      "check_out_date": "YYYY-MM-DD or null",
      "nights": "number or null",
      "hotel_name": "string or null",
      "reservation_id": "uuid or null",
      "confidence": "HIGH | MEDIUM | LOW"
    }
  ],
  "reservation_anchors": [
    {
      "reservation_id": "uuid matching an actual reservation id",
      "anchor_level": "PRIMARY | SECONDARY | NORMAL",
      "anchor_type": "string (e.g. OUTBOUND_FLIGHT, RETURN_FLIGHT, HOTEL_CHECKIN)",
      "description": "string",
      "date": "YYYY-MM-DD or null",
      "time": "HH:MM or null"
    }
  ],
  "open_windows": [
    {
      "date": "YYYY-MM-DD",
      "start_time": "HH:MM or null",
      "end_time": "HH:MM or null",
      "duration_hours": "number or null",
      "description": "string",
      "location": "string or null",
      "window_type": "ARRIVAL_GAP | DEPARTURE_GAP | BETWEEN_RESERVATIONS | FREE_DAY | OTHER"
    }
  ],
  "conflicts": [
    {
      "conflict_id": "string",
      "severity": "CRITICAL | HIGH | MEDIUM | LOW",
      "type": "OVERLAP | TIMING_CONFLICT | IMPOSSIBLE_SEQUENCE | LOCATION_CONFLICT | OTHER",
      "description": "plain language description",
      "reservation_ids": ["uuid"],
      "confidence": "HIGH | MEDIUM | LOW",
      "can_verify": true
    }
  ],
  "possible_gaps": [
    {
      "gap_id": "string",
      "gap_type": "ACCOMMODATION_GAP | TRANSPORTATION_GAP | UNCOVERED_PERIOD | OTHER",
      "description": "plain language description using cautious language",
      "start_date": "YYYY-MM-DD or null",
      "end_date": "YYYY-MM-DD or null",
      "severity": "HIGH | MEDIUM | LOW",
      "confidence": "HIGH | MEDIUM | LOW"
    }
  ],
  "reservation_density": {
    "YYYY-MM-DD": "OPEN | MODERATE | BUSY | VERY_BUSY"
  },
  "next_actions": [
    {
      "priority": 1,
      "action_type": "REVIEW_CONFLICT | FILL_GAP | VERIFY_TIMING | ADD_RESERVATION | OTHER",
      "description": "plain language suggestion",
      "related_reservation_ids": ["uuid"],
      "urgency": "HIGH | MEDIUM | LOW"
    }
  ]
}`;
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "google/gemini-3.5-flash",
      max_tokens: 3000,
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: userPrompt
        }
      ]
    })
  });
  if (!response.ok) return null;
  const json = await response.json();
  const content = json?.choices?.[0]?.message?.content ?? "";
  // Strip markdown code fences if present
  const cleaned = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch  {
    return null;
  }
}
Deno.serve(async (req)=>{
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders()
    });
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  // Auth
  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) {
    return new Response(JSON.stringify({
      error: "Missing authorization"
    }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders()
      }
    });
  }
  const { data: { user }, error: authError } = await supabase.auth.getUser(jwt);
  if (authError || !user) {
    return new Response(JSON.stringify({
      error: "Unauthorized"
    }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders()
      }
    });
  }
  const url = new URL(req.url);
  // ── GET: return existing assembly ────────────────────────────────────────
  if (req.method === "GET") {
    const trip_id = url.searchParams.get("trip_id");
    if (!trip_id) {
      return new Response(JSON.stringify({
        error: "trip_id is required"
      }), {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders()
        }
      });
    }
    // Verify trip ownership
    // ERROR-HANDLING FIX 2026-09-19 — this used `.single()` and discarded the
    // error, so a failed lookup and an absent trip were both reported as
    // "Trip not found" (404). A failed query is now a 500 that says so.
    const { data: trip, error: tripError } = await supabase.from("trips").select("id, user_id").eq("id", trip_id).maybeSingle();
    if (tripError) {
      console.error("[assemble-trip] trip lookup failed:", tripError.message);
      return new Response(JSON.stringify({
        error: "Trip lookup failed",
        detail: tripError.message
      }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders()
        }
      });
    }
    if (!trip) {
      return new Response(JSON.stringify({
        error: "Trip not found"
      }), {
        status: 404,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders()
        }
      });
    }
    if (trip.user_id !== user.id) {
      return new Response(JSON.stringify({
        error: "Forbidden"
      }), {
        status: 403,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders()
        }
      });
    }
    // ERROR-HANDLING FIX 2026-09-19 — `.single()` with a discarded error turned
    // "no assembly yet" and "query failed" into the same `assembly: null`.
    const { data: assembly, error: assemblyError } = await supabase.from("trip_assemblies").select("*").eq("trip_id", trip_id).maybeSingle();
    if (assemblyError) {
      console.error("[assemble-trip] assembly lookup failed:", assemblyError.message);
      return new Response(JSON.stringify({
        error: "Assembly lookup failed",
        detail: assemblyError.message
      }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders()
        }
      });
    }
    return new Response(JSON.stringify({
      assembly: assembly ?? null
    }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders()
      }
    });
  }
  // ── POST: calculate assembly ────────────────────────────────
  if (req.method === "POST") {
    let body;
    try {
      body = await req.json();
    } catch  {
      return new Response(JSON.stringify({
        error: "Invalid JSON"
      }), {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders()
        }
      });
    }
    const trip_id = body.trip_id;
    if (!trip_id) {
      return new Response(JSON.stringify({
        error: "trip_id is required"
      }), {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders()
        }
      });
    }
    // Fetch trip and verify ownership
    // ERROR-HANDLING FIX 2026-09-19 — was `if (tripError || !trip) return 404`.
    const { data: trip, error: tripError } = await supabase.from("trips").select("*").eq("id", trip_id).maybeSingle();
    if (tripError) {
      console.error("[assemble-trip] trip lookup failed:", tripError.message);
      return new Response(JSON.stringify({
        error: "Trip lookup failed",
        detail: tripError.message
      }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders()
        }
      });
    }
    if (!trip) {
      return new Response(JSON.stringify({
        error: "Trip not found"
      }), {
        status: 404,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders()
        }
      });
    }
    if (trip.user_id !== user.id) {
      return new Response(JSON.stringify({
        error: "Forbidden"
      }), {
        status: 403,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders()
        }
      });
    }
    // Fetch reservations
    // ERROR-HANDLING FIX 2026-09-19 — the discarded error here made a failed
    // reservations query indistinguishable from a trip with no reservations,
    // which would have been written to trip_assemblies as a confident
    // "No reservations found for this trip."
    const { data: reservations, error: reservationsError } = await supabase.from("reservations").select("id, reservation_type, provider_name, confirmation_number, reservation_status, start_date, start_time, end_date, end_time, timezone, location_name, city, country, details").eq("trip_id", trip_id).order("start_date", {
      ascending: true,
      nullsFirst: false
    }).order("start_time", {
      ascending: true,
      nullsFirst: false
    });
    if (reservationsError) {
      console.error("[assemble-trip] reservations lookup failed:", reservationsError.message);
      return new Response(JSON.stringify({
        error: "Reservations lookup failed",
        detail: reservationsError.message
      }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders()
        }
      });
    }
    const resList = reservations ?? [];
    // No reservations — upsert UNKNOWN assembly
    if (resList.length === 0) {
      const emptyAssembly = {
        user_id: user.id,
        trip_id,
        assembly_status: "UNKNOWN",
        confidence: "LOW",
        assembly_notes: "No reservations found for this trip.",
        destinations: [],
        travel_segments: [],
        accommodation_periods: [],
        reservation_anchors: [],
        open_windows: [],
        conflicts: [],
        possible_gaps: [],
        reservation_density: {},
        next_actions: [],
        destination_count: 0,
        flight_count: 0,
        hotel_count: 0,
        rental_car_count: 0,
        restaurant_count: 0,
        activity_count: 0,
        other_reservation_count: 0,
        open_window_count: 0,
        conflict_count: 0,
        gap_count: 0,
        reservation_ids: [],
        calculated_at: new Date().toISOString()
      };
      const { data: upserted, error: emptyUpsertError } = await supabase.from("trip_assemblies").upsert(emptyAssembly, {
        onConflict: "trip_id"
      }).select().single();
      if (emptyUpsertError) {
        console.error("[assemble-trip] empty assembly upsert failed:", emptyUpsertError.message);
        return new Response(JSON.stringify({
          error: "Assembly write failed",
          detail: emptyUpsertError.message
        }), {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders()
          }
        });
      }
      return new Response(JSON.stringify({
        assembly: upserted,
        reservation_count: 0
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders()
        }
      });
    }
    // Call AI
    let aiResult = null;
    try {
      aiResult = await callAI(trip, resList);
    } catch (aiError) {
      console.error("[assemble-trip] AI assembly call failed:", aiError);
      aiResult = null;
    }
    // Build assembly from AI result or fallback
    const destinations = aiResult?.destinations ?? [];
    const travelSegments = aiResult?.travel_segments ?? [];
    const accommodationPeriods = aiResult?.accommodation_periods ?? [];
    const reservationAnchors = aiResult?.reservation_anchors ?? [];
    const openWindows = aiResult?.open_windows ?? [];
    const conflicts = aiResult?.conflicts ?? [];
    const possibleGaps = aiResult?.possible_gaps ?? [];
    const reservationDensity = aiResult?.reservation_density ?? {};
    const nextActions = aiResult?.next_actions ?? [];
    const assemblyPayload = {
      user_id: user.id,
      trip_id,
      trip_start: aiResult?.trip_start ?? trip.start_date ?? null,
      trip_end: aiResult?.trip_end ?? trip.end_date ?? null,
      duration_days: aiResult?.duration_days ?? null,
      assembly_status: aiResult?.assembly_status ?? "UNKNOWN",
      confidence: aiResult?.confidence ?? "LOW",
      assembly_notes: aiResult?.assembly_notes ?? null,
      destinations,
      travel_segments: travelSegments,
      accommodation_periods: accommodationPeriods,
      reservation_anchors: reservationAnchors,
      open_windows: openWindows,
      conflicts,
      possible_gaps: possibleGaps,
      reservation_density: reservationDensity,
      next_actions: nextActions,
      // Summary counts
      destination_count: destinations.length,
      flight_count: countByType(resList, "FLIGHT"),
      hotel_count: countByType(resList, "HOTEL"),
      rental_car_count: countByType(resList, "RENTAL_CAR"),
      restaurant_count: countByType(resList, "RESTAURANT"),
      activity_count: countByType(resList, "ACTIVITY"),
      other_reservation_count: resList.filter((r)=>![
          "FLIGHT",
          "HOTEL",
          "RENTAL_CAR",
          "RESTAURANT",
          "ACTIVITY"
        ].includes(r.reservation_type)).length,
      open_window_count: openWindows.length,
      conflict_count: conflicts.length,
      gap_count: possibleGaps.length,
      reservation_ids: resList.map((r)=>r.id),
      calculated_at: new Date().toISOString()
    };
    const { data: upserted, error: upsertError } = await supabase.from("trip_assemblies").upsert(assemblyPayload, {
      onConflict: "trip_id"
    }).select().single();
    if (upsertError) {
      return new Response(JSON.stringify({
        error: upsertError.message
      }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders()
        }
      });
    }
    return new Response(JSON.stringify({
      assembly: upserted,
      reservation_count: resList.length
    }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders()
      }
    });
  }
  return new Response(JSON.stringify({
    error: "Method not allowed"
  }), {
    status: 405,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders()
    }
  });
});

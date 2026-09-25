// analyze-readiness
//
// 2026-09-19 — three defects, one of which made this function unreachable from
// the pipeline and one of which had silently lobotomised its own analysis.
//
// ─── 1. It accepted only a user JWT ──────────────────────────────────────
// The gate was `supabase.auth.getUser(jwt)` against a service-role client.
// `getUser` resolves a bearer to a row in `auth.users`; the service-role key
// carries `role: service_role` and no `sub`, so there is nothing to resolve and
// it always fails. Every service-to-service caller got 401. `reservations-api`
// fires this function after every reservation write, which is how a trip's
// readiness is supposed to stay current — so for service-key callers it never
// ran once.
//
// Now: `requireUserOrService` from `_shared/auth.ts`, the house pattern for an
// endpoint that serves both a client and a worker.
//
// THE USER PATH'S AUTHORIZATION IS UNCHANGED. For a user caller:
//   * GET  — `trips.user_id` must equal the caller or the response is 404
//            (404 not 403, deliberately, so trip ids cannot be probed — the
//            2026-09-17 SECURITY note below still stands, verbatim in intent).
//   * POST — `trip.user_id !== user.id` is still 403 Forbidden.
// Only a service caller skips those comparisons. It does NOT take an identity
// from the request body: the owning user is read out of `trips.user_id` for
// the supplied `trip_id`, and that owner is what gets written into
// `readiness_items.user_id` and `pre_trip_readiness.user_id` and what scopes
// the `secure_documents` and `pre_trip_tasks` reads.
//
// ─── 2. A 42703 that degraded the analysis in silence ─────────────────────
// The trip-health read was:
//
//   supabase.from("trip_health_analyses")
//     .select("overall_score, health_status, primary_factors")
//     .eq("trip_id", trip_id).eq("status", "ready")
//     .order("calculated_at", { ascending: false }).limit(1).maybeSingle()
//
// `trip_health_analyses` has NO `overall_score`, NO `primary_factors` and NO
// `calculated_at`. Verified against information_schema.columns 2026-09-19; the
// real columns are `health_score`, `issues` and `analyzed_at`. A column that
// does not exist makes PostgREST reject the WHOLE query with 42703, so this
// returned nothing — ever, for every trip, since the day it was written.
//
// It was invisible because the query sits inside `Promise.allSettled`, whose
// rejection is read as `status !== "fulfilled" -> null`, and null was then
// rendered into the prompt as the string "Not yet analyzed". So the model was
// told, on every single run, that the trip had never been health-analysed —
// including for the four trips that have a `ready` row sitting in that table.
// Every readiness verdict this function has ever produced was reached without
// the health data it was designed to weigh.
//
// Fixed to the real column names. Each `allSettled` branch now logs its
// rejection and its PostgREST error instead of discarding both.
//
// ─── 3. The prompt read three columns that do not exist on `trips` ─────────
// `trip.travelers`, `trip.budget` and `trip.currency`. `trips` is
// (id, user_id, name, title, destination, start_date, end_date, status,
// primary_tz, base_currency, version, archived_at, created_at, updated_at).
// These were plain property reads on a `select("*")` row rather than named
// columns, so they did not raise 42703 — they were simply `undefined`, and the
// `??` fallbacks turned them into confident fictions: every trip was described
// to the model as having exactly "1" traveler and a currency of "USD",
// regardless of `base_currency`. Those lines are removed rather than guessed
// at; `base_currency` is passed because it is real.
//
// ─── Also: the AI failure path no longer destroys data ────────────────────
// On any failure of the model call the function used to fall through with a
// hardcoded `{ overall_status: "UNKNOWN", … items: [] }`, and then — before
// inserting anything — DELETE every OPEN row in `readiness_items` for the trip
// and upsert that placeholder over `pre_trip_readiness`. A transient upstream
// outage therefore wiped the traveller's open readiness items and replaced
// their readiness record with a manufactured one, and returned 200 as though
// it had analysed the trip. It now returns 502 and writes nothing. Nothing is
// invented on a failure path.
//
// Every column referenced below was checked against information_schema.columns
// on 2026-09-19.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { requireUserOrService, serviceClient } from "./_shared/auth.ts";
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY");
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
  };
}
function reply(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders()
    }
  });
}
function calcDaysUntilTrip(startDate) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(startDate);
  start.setHours(0, 0, 0, 0);
  return Math.round((start.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}
function calcTripPhase(startDate, endDate) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(startDate);
  start.setHours(0, 0, 0, 0);
  const end = new Date(endDate);
  end.setHours(0, 0, 0, 0);
  if (today < start) return "PRE_TRIP";
  if (today > end) return "POST_TRIP";
  return "IN_PROGRESS";
}
/** Log whatever an allSettled branch discarded, and hand back the rows. */ function settled(label, res) {
  if (res.status === "rejected") {
    console.error(`[analyze-readiness] ${label} threw:`, res.reason instanceof Error ? res.reason.message : String(res.reason));
    return null;
  }
  if (res.value.error) {
    console.error(`[analyze-readiness] ${label} failed:`, res.value.error.code ?? "", res.value.error.message);
    return null;
  }
  return res.value.data;
}
Deno.serve(async (req)=>{
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders()
    });
  }
  // Accepts a real user's JWT (the app) or the service-role key (the writes in
  // reservations-api, and any other worker that needs a trip re-scored). A bad
  // credential is 401.
  const caller = await requireUserOrService(req);
  if (caller instanceof Response) return caller;
  // null for a service caller. Used ONLY for the ownership comparisons.
  const callerUserId = caller.kind === "user" ? caller.userId : null;
  const supabase = serviceClient();
  if (req.method === "GET") {
    const url = new URL(req.url);
    const trip_id = url.searchParams.get("trip_id");
    if (!trip_id) return reply({
      error: "trip_id is required"
    }, 400);
    // SECURITY 2026-09-17 — This GET handler queried pre_trip_readiness and
    // readiness_items by trip_id alone, with no check that the caller owned
    // the trip. Since this function uses the service-role client (RLS is
    // bypassed), any signed-in user who knew or guessed a trip_id could read
    // another traveler's pre-trip readiness state, including items in the
    // DOCUMENTS and SAFETY_CONTINGENCY categories. Gate is now: trips.user_id
    // must equal the caller's verified auth.uid() before anything is read.
    // Returns 404 rather than 403 so a caller cannot probe which trip ids exist.
    //
    // 2026-09-19 — unchanged for a user caller. A service caller has no
    // auth.uid() to compare against, so it skips the comparison and takes the
    // owning user from trips.user_id instead. The trip must still exist.
    const { data: ownedTrip, error: ownedTripError } = await supabase.from("trips").select("id, user_id").eq("id", trip_id).maybeSingle();
    if (ownedTripError) {
      console.error("[analyze-readiness] GET trip lookup failed:", ownedTripError.code, ownedTripError.message);
      return reply({
        error: `Trip lookup failed: ${ownedTripError.message}`
      }, 500);
    }
    if (!ownedTrip) return reply({
      error: "Trip not found"
    }, 404);
    if (callerUserId !== null && ownedTrip.user_id !== callerUserId) {
      return reply({
        error: "Trip not found"
      }, 404);
    }
    const ownerUserId = ownedTrip.user_id;
    const [readinessRes, itemsRes, tasksRes] = await Promise.allSettled([
      supabase.from("pre_trip_readiness").select("*").eq("trip_id", trip_id).maybeSingle(),
      supabase.from("readiness_items").select("*").eq("trip_id", trip_id).in("status", [
        "OPEN"
      ]).order("priority", {
        ascending: true
      }).order("severity", {
        ascending: true
      }),
      supabase.from("pre_trip_tasks").select("*").eq("trip_id", trip_id).eq("user_id", ownerUserId).eq("status", "OPEN").order("created_at", {
        ascending: false
      })
    ]);
    return reply({
      readiness: settled("GET pre_trip_readiness", readinessRes) ?? null,
      items: settled("GET readiness_items", itemsRes) ?? [],
      tasks: settled("GET pre_trip_tasks", tasksRes) ?? []
    });
  }
  if (req.method === "POST") {
    let body;
    try {
      body = await req.json();
    } catch  {
      return reply({
        error: "Invalid JSON"
      }, 400);
    }
    const trip_id = body.trip_id;
    if (!trip_id) return reply({
      error: "trip_id is required"
    }, 400);
    const { data: trip, error: tripError } = await supabase.from("trips").select("*").eq("id", trip_id).maybeSingle();
    if (tripError) {
      console.error("[analyze-readiness] POST trip lookup failed:", tripError.code, tripError.message);
      return reply({
        error: `Trip lookup failed: ${tripError.message}`
      }, 500);
    }
    if (!trip) return reply({
      error: "Trip not found"
    }, 404);
    // Unchanged for a user caller: not your trip, 403. A service caller has no
    // user id to compare, so the comparison is skipped and the owner is read
    // out of the row. The identity is never taken from the request body.
    if (callerUserId !== null && trip.user_id !== callerUserId) {
      return reply({
        error: "Forbidden"
      }, 403);
    }
    const ownerUserId = trip.user_id;
    const [reservationsRes, assemblyRes, healthRes, dismissedRes, docsRes] = await Promise.allSettled([
      supabase.from("reservations").select("id, reservation_type, provider_name, confirmation_number, reservation_status, start_date, start_time, end_date, end_time, city, country, details, data_completeness, needs_review").eq("trip_id", trip_id).order("start_date", {
        ascending: true,
        nullsFirst: false
      }),
      supabase.from("trip_assemblies").select("assembly_status, conflicts, possible_gaps, open_windows, next_actions").eq("trip_id", trip_id).maybeSingle(),
      // 42703 fix — real columns are health_score / issues / analyzed_at.
      supabase.from("trip_health_analyses").select("health_score, health_status, issues").eq("trip_id", trip_id).eq("status", "ready").order("analyzed_at", {
        ascending: false
      }).limit(1).maybeSingle(),
      supabase.from("readiness_items").select("title, status").eq("trip_id", trip_id).in("status", [
        "DISMISSED",
        "EXPLAINED"
      ]),
      supabase.from("secure_documents").select("id, document_type, document_name, expiration_date, status, scope, extraction_confidence").eq("user_id", ownerUserId).eq("is_active", true)
    ]);
    const reservations = settled("reservations", reservationsRes) ?? [];
    const assembly = settled("trip_assemblies", assemblyRes);
    const health = settled("trip_health_analyses", healthRes);
    const dismissedItems = settled("dismissed readiness_items", dismissedRes) ?? [];
    const vaultDocs = settled("secure_documents", docsRes) ?? [];
    const days_until_trip = trip.start_date ? calcDaysUntilTrip(trip.start_date) : null;
    const trip_phase = trip.start_date && trip.end_date ? calcTripPhase(trip.start_date, trip.end_date) : "UNKNOWN";
    const dismissedTitles = dismissedItems.map((i)=>i.title);
    // Build document vault summary for AI prompt
    const docLines = vaultDocs.map((d)=>`- ${d.document_type}: "${d.document_name}" | expires: ${d.expiration_date ?? 'unknown'} | status: ${d.status} | confidence: ${d.extraction_confidence}`).join("\n");
    const systemPrompt = `You are a pre-trip readiness analyst for TravelOS. Your job is to identify meaningful preparation items, potential gaps, and issues the traveler should address before their trip.

CRITICAL RULES:
1. NEVER claim the traveler needs a visa, vaccination, passport, insurance, or any regulatory requirement unless explicitly supported by data
2. Use cautious language: "possible gap", "may want to verify", "appears to be missing"
3. Do not create false urgency — only flag genuinely important issues
4. Distinguish between KNOWN problems and POSSIBLE gaps
5. A missing reservation is not necessarily a mistake
6. Do not double-count the same underlying issue
7. Respond with ONLY valid JSON`;
    // NOTE 2026-09-19 — traveler count and budget are NOT in this prompt
    // because TravelOS does not store them on `trips`. The previous version
    // read `trip.travelers`, `trip.budget` and `trip.currency`, all of which
    // are undefined on every row, and the `??` fallbacks then asserted "1
    // traveler" and "USD" to the model as fact. Do not reintroduce a field
    // here without confirming it exists in information_schema.columns.
    const userPrompt = `Analyze this trip and identify pre-trip readiness items.

TRIP:
- Name: ${trip.name ?? trip.title ?? "Unknown"}
- Destination: ${trip.destination ?? "Unknown"}
- Start: ${trip.start_date ?? "Unknown"}
- End: ${trip.end_date ?? "Unknown"}
- Days until trip: ${days_until_trip ?? "Unknown"}
- Base currency: ${trip.base_currency ?? "Not set"}
- Traveler count and budget: not tracked by TravelOS — do not assume a value for either.

RESERVATIONS (${reservations.length} total):
${JSON.stringify(reservations, null, 2)}

TRIP ASSEMBLY:
${assembly ? JSON.stringify({
      assembly_status: assembly.assembly_status,
      conflicts: assembly.conflicts,
      possible_gaps: assembly.possible_gaps,
      open_windows: assembly.open_windows,
      next_actions: assembly.next_actions
    }, null, 2) : "Not yet assembled"}

TRIP HEALTH:
${health ? JSON.stringify({
      health_score: health.health_score,
      health_status: health.health_status,
      issues: health.issues
    }, null, 2) : "Not yet analyzed"}

DOCUMENTS IN VAULT (${vaultDocs.length} total):
${vaultDocs.length > 0 ? docLines : "No documents uploaded yet"}

ALREADY DISMISSED/EXPLAINED ITEMS (do not recreate these):
${dismissedTitles.length > 0 ? dismissedTitles.map((t)=>`- ${t}`).join("\n") : "None"}

Produce this exact JSON:
{
  "overall_status": "READY" | "MOSTLY_READY" | "NEEDS_ATTENTION" | "UNKNOWN",
  "confidence": "HIGH" | "MEDIUM" | "LOW",
  "summary_message": "1-2 sentence plain language summary",
  "category_statuses": {
    "RESERVATIONS": "READY" | "MOSTLY_READY" | "NEEDS_ATTENTION" | "UNKNOWN",
    "TRANSPORTATION": "READY" | "MOSTLY_READY" | "NEEDS_ATTENTION" | "UNKNOWN",
    "ACCOMMODATION": "READY" | "MOSTLY_READY" | "NEEDS_ATTENTION" | "UNKNOWN",
    "DOCUMENTS": "READY" | "MOSTLY_READY" | "NEEDS_ATTENTION" | "UNKNOWN",
    "TIMING": "READY" | "MOSTLY_READY" | "NEEDS_ATTENTION" | "UNKNOWN",
    "MONEY": "READY" | "MOSTLY_READY" | "NEEDS_ATTENTION" | "UNKNOWN",
    "PREPARATION": "UNKNOWN",
    "COMMUNICATION": "READY" | "MOSTLY_READY" | "NEEDS_ATTENTION" | "UNKNOWN",
    "SAFETY_CONTINGENCY": "UNKNOWN"
  },
  "items": [
    {
      "category": "RESERVATIONS" | "TRANSPORTATION" | "ACCOMMODATION" | "DOCUMENTS" | "TIMING" | "MONEY" | "PREPARATION" | "COMMUNICATION" | "SAFETY_CONTINGENCY" | "OTHER",
      "title": "short plain-language title",
      "description": "1-2 sentence explanation using cautious language",
      "severity": "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO",
      "priority": number,
      "source": "TRAVELOS_DETECTED",
      "source_reference": "string or null",
      "affected_date": "YYYY-MM-DD or null",
      "confidence": "HIGH" | "MEDIUM" | "LOW",
      "recommendation": "plain language suggestion"
    }
  ]
}

Document-related items to consider (only if relevant):
- If any uploaded document has status NEEDS_REVIEW, flag it
- If any document expires before or during the trip, flag it
- If the trip appears international and no passport is in the vault, note it as a possible gap (LOW severity)
- Do not flag missing documents for domestic trips

Limit to the 10 most important items. Do not include items that are already dismissed/explained.`;
    // The model call. There is no fallback verdict: if this does not produce a
    // usable analysis the function reports that and writes nothing. See the
    // header note — the previous fallback deleted the trip's open readiness
    // items and upserted a manufactured "UNKNOWN" readiness record under a 200.
    let aiResult;
    try {
      const aiResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          "HTTP-Referer": "https://travelos.app",
          "X-Title": "TravelOS"
        },
        body: JSON.stringify({
          model: "google/gemini-3.5-flash",
          messages: [
            {
              role: "system",
              content: systemPrompt
            },
            {
              role: "user",
              content: userPrompt
            }
          ],
          max_tokens: 2000,
          temperature: 0.1,
          response_format: {
            type: "json_object"
          }
        })
      });
      if (!aiResponse.ok) {
        const detail = (await aiResponse.text()).slice(0, 400);
        console.error(`[analyze-readiness] model call returned ${aiResponse.status}: ${detail}`);
        return reply({
          error: `Readiness analysis unavailable: model provider returned ${aiResponse.status}`
        }, 502);
      }
      const aiData = await aiResponse.json();
      const content = aiData?.choices?.[0]?.message?.content ?? "";
      const parsed = JSON.parse(typeof content === "string" ? content : JSON.stringify(content));
      if (!parsed || typeof parsed !== "object") throw new Error("model returned a non-object");
      aiResult = parsed;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error("[analyze-readiness] model call failed:", message);
      return reply({
        error: `Readiness analysis unavailable: ${message}`
      }, 502);
    }
    const newItems = Array.isArray(aiResult.items) ? aiResult.items : [];
    const { error: deleteError } = await supabase.from("readiness_items").delete().eq("trip_id", trip_id).eq("status", "OPEN");
    if (deleteError) {
      console.error("[analyze-readiness] could not clear OPEN readiness_items:", deleteError.code, deleteError.message);
      return reply({
        error: `Failed to replace readiness items: ${deleteError.message}`
      }, 500);
    }
    let insertedItems = [];
    if (newItems.length > 0) {
      const toInsert = newItems.map((item)=>({
          user_id: ownerUserId,
          trip_id,
          category: item.category ?? "OTHER",
          title: item.title ?? "Untitled",
          description: item.description ?? null,
          severity: item.severity ?? "MEDIUM",
          priority: typeof item.priority === "number" ? item.priority : 50,
          source: "TRAVELOS_DETECTED",
          source_reference: item.source_reference ?? null,
          affected_date: item.affected_date ?? null,
          status: "OPEN",
          confidence: item.confidence ?? "MEDIUM",
          recommendation: item.recommendation ?? null
        }));
      const { data: inserted, error: insertError } = await supabase.from("readiness_items").insert(toInsert).select();
      if (insertError) {
        console.error("[analyze-readiness] readiness_items insert failed:", insertError.code, insertError.message);
        return reply({
          error: `Failed to store readiness items: ${insertError.message}`
        }, 500);
      }
      insertedItems = inserted ?? [];
    }
    const openCount = insertedItems.length;
    const criticalCount = insertedItems.filter((i)=>i.severity === "CRITICAL").length;
    const highCount = insertedItems.filter((i)=>i.severity === "HIGH").length;
    const categoryStatuses = aiResult.category_statuses ?? {};
    const readinessPayload = {
      user_id: ownerUserId,
      trip_id,
      overall_status: aiResult.overall_status ?? "UNKNOWN",
      category_statuses: categoryStatuses,
      open_item_count: openCount,
      critical_item_count: criticalCount,
      high_item_count: highCount,
      upcoming_deadline_count: 0,
      confidence: aiResult.confidence ?? "LOW",
      summary_message: aiResult.summary_message ?? null,
      days_until_trip,
      trip_phase,
      calculated_at: new Date().toISOString()
    };
    const { data: readiness, error: readinessError } = await supabase.from("pre_trip_readiness").upsert(readinessPayload, {
      onConflict: "trip_id"
    }).select().single();
    if (readinessError) {
      console.error("[analyze-readiness] pre_trip_readiness upsert failed:", readinessError.code, readinessError.message);
      return reply({
        error: `Failed to store readiness: ${readinessError.message}`
      }, 500);
    }
    const { data: tasks, error: tasksError } = await supabase.from("pre_trip_tasks").select("*").eq("trip_id", trip_id).eq("user_id", ownerUserId).eq("status", "OPEN").order("created_at", {
      ascending: false
    });
    if (tasksError) {
      console.error("[analyze-readiness] pre_trip_tasks read failed:", tasksError.code, tasksError.message);
    }
    return reply({
      readiness,
      items: insertedItems,
      tasks: tasks ?? []
    });
  }
  return reply({
    error: "Method not allowed"
  }, 405);
});

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
// RATE LIMITING 2026-09-20 — the write routes had no limit, and a write here
// is not cheap. Each POST/PATCH/DELETE inserts or mutates a row AND fans out
// to three more edge functions through refreshTripDerivedData: assemble-trip,
// analyze-readiness and generate-offline-pack. One caller in a loop therefore
// costs four function invocations per iteration, not one, and the anon key
// that reaches this endpoint ships inside a published browser client.
//
// 60 writes per 5-minute window, per authenticated user. The number is set by
// what a legitimate burst looks like rather than by what a human types: a
// traveller importing a whole trip's reservations in one sitting is the
// heaviest honest case, and a trip rarely holds sixty of them, so the ceiling
// sits above real use while capping the downstream fan-out at 180 pipeline
// invocations per user per 5 minutes.
//
// READS ARE DELIBERATELY NOT LIMITED. A GET here is a single indexed select
// with no fan-out, and the itinerary screen polls it; limiting it would cost
// real users something and save almost nothing.
//
// Counting happens inside `public.rate_limit_hit`, which inserts and
// increments in one statement, so two concurrent writes cannot both read the
// same count and both be admitted.
//
// Deliberate choice: the limiter FAILS OPEN when the RPC itself errors, and
// says so at error level. Failing closed would mean a limiter outage blocks
// every reservation write in the product. Failing open *silently* is the
// defect being avoided, so the log line is the substance of the decision.
const RATE_LIMIT_MAX_WRITES = 60;
const RATE_LIMIT_WINDOW_SECONDS = 300;
// Must be one of global | strict | user_quota — see rate_limit_buckets_bucket_type_check.
const RATE_LIMIT_BUCKET_TYPE = "user_quota";
// IP RATE LIMITING 2026-09-20 (Q2.15) — the write-route limit above only
// starts counting once a JWT has been verified as belonging to a real user.
// A flood of requests carrying a syntactically-valid-looking but bogus
// bearer token — or the anon/publishable key itself, which IS a valid JWT —
// never fails to parse, so each one still pays for a full
// `supabase.auth.getUser(jwt)` round trip before the per-user bucket check
// can even run. Worse, a caller who mints many different garbage subjects
// gets a fresh per-user bucket for each one, so the per-user limit counts
// nothing against that shape of flood.
//
// This gate runs BEFORE any bearer token is looked at, keyed on the caller's
// IP alone, so it caps the cost of running auth verification itself rather
// than the cost of being authenticated. It also applies to every method
// (not just writes), since the auth check it protects runs for GET too.
//
// 300 requests per 5-minute window, per IP. Set well above the per-user
// write limit (60/5min) on purpose: this endpoint's GETs are unlimited and
// polled by the itinerary screen, and many real users can share one IP (NAT,
// a corporate network, mobile carrier CGNAT) — this is not meant to be the
// primary defense against one abusive user, which the per-user write limit
// above already is once a real identity is established. It exists so one
// source cannot force unlimited auth verifications or mint unlimited
// per-user buckets cheaply.
const IP_RATE_LIMIT_MAX = 300;
const IP_RATE_LIMIT_WINDOW_SECONDS = 300;
// Must be one of global | strict | user_quota — see rate_limit_buckets_bucket_type_check.
const IP_RATE_LIMIT_BUCKET_TYPE = "strict";
// Supabase Edge Functions sit behind a gateway that sets x-forwarded-for,
// which may be a comma-separated chain (client, then any intermediate
// proxies) — the first entry is the client's own address. Falls back to a
// constant so a missing header can never throw.
function getClientIp(req) {
  const forwardedFor = req.headers.get("x-forwarded-for");
  if (!forwardedFor) return "unknown";
  const first = forwardedFor.split(",")[0]?.trim();
  return first || "unknown";
}
// PIPELINE 2026-09-19 — the three downstream calls were being 401'd, silently.
//
// Every write here fired three POSTs at assemble-trip, analyze-readiness and
// generate-offline-pack so the trip's assembly, readiness score and offline
// pack would reflect the change. All three were sent with
// `Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}` — and all three
// authenticate with `supabase.auth.getUser(jwt)`, which resolves a token to a
// row in auth.users. The service-role key is not a user token: it carries
// role=service_role and no `sub`, so getUser fails and every one of those
// three requests returned 401 Unauthorized. Verified 2026-09-19: the same
// three endpoints reject any bearer that is not a user JWT.
//
// Two things hid it. The calls were fire-and-forget — an un-awaited fetch in
// the edge runtime is not guaranteed to survive the response being returned at
// all — and each carried `.catch(() => {})`, which discards the transport
// error AND, because a 401 is a perfectly successful fetch, would not have
// fired anyway. The 401 body was read by nobody. So a reservation could be
// created, the caller would get a clean 201, and the trip's assembly,
// readiness and offline pack would silently never update.
//
// Fix: forward the CALLER's Authorization header, not the service-role key.
// The caller is already proven to own the trip by verifyTripOwnership above,
// which is exactly the check all three downstream functions make
// (`trip.user_id !== user.id` → 403), so the caller's own token is the
// correct credential and the only one these endpoints accept. The calls are
// awaited inside EdgeRuntime.waitUntil() so they genuinely complete after the
// response is returned rather than being cut off, and every non-2xx is logged
// with its status and body instead of being swallowed.
// SECURITY 2026-09-17 — every read and write here already filtered by
// `.eq('user_id', user.id)`, which is correct for reservations themselves.
// What was missing: creating or re-pointing a reservation never checked that
// `trip_id` actually belonged to the caller. A signed-in user could POST a
// reservation (owned by themselves, so it never showed up in their own
// queries as "wrong") with an arbitrary trip_id, or PATCH `trip_id` on their
// own reservation to move it under someone else's trip. Because the pipeline
// calls fire on trip_id alone, that reservation could then be picked up by
// background jobs that operate on the whole trip regardless of which user_id
// created the row — planting bad data (fake confirmation numbers, wrong dates)
// inside a stranger's itinerary.
// Fix: verify `trip_id` (and any trip_id being written via PATCH) resolves to
// a trip owned by the caller before it is ever written.
async function verifyTripOwnership(supabase, tripId, userId) {
  const { data, error } = await supabase.from("trips").select("id").eq("id", tripId).eq("user_id", userId).maybeSingle();
  // Fails closed either way, but a query error and "not your trip" are very
  // different problems and used to be indistinguishable from the outside.
  if (error) console.error("[reservations-api] trip ownership check failed:", error.message);
  return !!data;
}
function computeCompleteness(reservation_type, body) {
  const details = body.details ?? {};
  const hasProviderName = !!body.provider_name;
  const hasStartDate = !!body.start_date;
  const hasEndDate = !!body.end_date;
  const hasStartTime = !!body.start_time;
  const hasEndTime = !!body.end_time;
  if (reservation_type === "FLIGHT") {
    const hasAirline = !!(details.airline || body.provider_name);
    const hasFlightNumber = !!details.flight_number;
    if (hasAirline && hasFlightNumber && hasStartDate && hasStartTime && hasEndDate && hasEndTime) return "COMPLETE";
    if (hasStartDate) return "MOSTLY_COMPLETE";
    return "INCOMPLETE";
  }
  if (reservation_type === "HOTEL") {
    if (hasProviderName && hasStartDate && hasEndDate) return "COMPLETE";
    if (hasStartDate) return "MOSTLY_COMPLETE";
    return "INCOMPLETE";
  }
  if (reservation_type === "RESTAURANT") {
    if (hasProviderName && hasStartDate && hasStartTime) return "COMPLETE";
    if (hasStartDate) return "MOSTLY_COMPLETE";
    return "INCOMPLETE";
  }
  if (hasProviderName && hasStartDate) return "COMPLETE";
  if (hasStartDate) return "MOSTLY_COMPLETE";
  return "INCOMPLETE";
}
function computeConfidence(body) {
  const hasConfirmation = !!body.confirmation_number;
  const hasStartDate = !!body.start_date;
  const hasProviderName = !!body.provider_name;
  if (hasConfirmation && hasStartDate && hasProviderName) return "HIGH";
  const criticalFields = [
    "confirmation_number",
    "start_date",
    "provider_name",
    "reservation_type"
  ];
  const missingCount = criticalFields.filter((f)=>!body[f]).length;
  if (missingCount > 2) return "LOW";
  return "MEDIUM";
}
function computeValidation(body) {
  const reasons = [];
  if (body.start_date && body.end_date) {
    const start = new Date(body.start_date);
    const end = new Date(body.end_date);
    if (end < start) reasons.push("end_date is before start_date");
  }
  const criticalDateTypes = [
    "FLIGHT",
    "HOTEL",
    "TRAIN",
    "BUS"
  ];
  if (criticalDateTypes.includes(body.reservation_type) && !body.start_date) {
    reasons.push("start_date is required for " + body.reservation_type);
  }
  if (body.reservation_status === "CONFIRMED" && !body.confirmation_number) {
    reasons.push("CONFIRMED status but no confirmation_number provided");
  }
  return {
    needs_review: reasons.length > 0,
    review_reason: reasons.length > 0 ? reasons.join("; ") : null
  };
}
async function checkDuplicate(supabase, body, excludeId) {
  const trip_id = body.trip_id;
  const confirmation_number = body.confirmation_number;
  const reservation_type = body.reservation_type;
  const start_date = body.start_date;
  const provider_name = body.provider_name;
  if (confirmation_number) {
    let q = supabase.from("reservations").select("id").eq("trip_id", trip_id).eq("confirmation_number", confirmation_number).limit(1);
    if (excludeId) q = q.neq("id", excludeId);
    const { data } = await q;
    if (data && data.length > 0) return data[0].id;
  }
  if (reservation_type && start_date && provider_name) {
    let q = supabase.from("reservations").select("id").eq("trip_id", trip_id).eq("reservation_type", reservation_type).eq("start_date", start_date).eq("provider_name", provider_name).limit(1);
    if (excludeId) q = q.neq("id", excludeId);
    const { data } = await q;
    if (data && data.length > 0) return data[0].id;
  }
  return null;
}
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, apikey, x-client-info"
  };
}
// ─── rate limit ───────────────────────────────────────────────────────────────
// Records one write against the caller's bucket and reports whether it is
// within the limit. See the RATE LIMITING note at the top for the numbers and
// for why this fails open rather than closed.
//
// `retryAfter` is taken from what the function reports as left in the window
// it actually used. A hardcoded value is wrong the moment the window changes,
// and tells the caller to come back at a time that means nothing.
async function checkWriteRateLimit(supabase, bucketKey) {
  const { data, error } = await supabase.rpc("rate_limit_hit", {
    p_bucket_key: bucketKey,
    p_bucket_type: RATE_LIMIT_BUCKET_TYPE,
    p_limit: RATE_LIMIT_MAX_WRITES,
    p_window_seconds: RATE_LIMIT_WINDOW_SECONDS
  });
  if (error) {
    console.error("[reservations-api] RATE LIMIT NOT ENFORCED — rate_limit_hit failed:", error.message);
    return {
      allowed: true,
      retryAfter: 0
    };
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row.is_allowed !== "boolean") {
    console.error("[reservations-api] RATE LIMIT NOT ENFORCED — rate_limit_hit returned no usable row");
    return {
      allowed: true,
      retryAfter: 0
    };
  }
  if (!row.is_allowed) {
    console.warn(`[reservations-api] rate limited ${bucketKey} at ${row.hits} writes (limit ${RATE_LIMIT_MAX_WRITES})`);
  }
  return {
    allowed: row.is_allowed,
    retryAfter: typeof row.retry_after_seconds === "number" ? row.retry_after_seconds : RATE_LIMIT_WINDOW_SECONDS
  };
}
// Same shape and same fail-open-loudly behavior as checkWriteRateLimit
// above, but against the IP bucket, with a log prefix that distinguishes it
// from a per-user block in the logs, and callable for every method.
async function checkIpRateLimit(supabase, bucketKey) {
  const { data, error } = await supabase.rpc("rate_limit_hit", {
    p_bucket_key: bucketKey,
    p_bucket_type: IP_RATE_LIMIT_BUCKET_TYPE,
    p_limit: IP_RATE_LIMIT_MAX,
    p_window_seconds: IP_RATE_LIMIT_WINDOW_SECONDS
  });
  if (error) {
    console.error("[reservations-api] RATE LIMIT NOT ENFORCED (ip) — rate_limit_hit failed:", error.message);
    return {
      allowed: true,
      retryAfter: 0
    };
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row.is_allowed !== "boolean") {
    console.error("[reservations-api] RATE LIMIT NOT ENFORCED (ip) — rate_limit_hit returned no usable row");
    return {
      allowed: true,
      retryAfter: 0
    };
  }
  if (!row.is_allowed) {
    console.warn(`[reservations-api] IP rate limited ${bucketKey} at ${row.hits} requests (limit ${IP_RATE_LIMIT_MAX})`);
  }
  return {
    allowed: row.is_allowed,
    retryAfter: typeof row.retry_after_seconds === "number" ? row.retry_after_seconds : IP_RATE_LIMIT_WINDOW_SECONDS
  };
}
// ─── downstream pipeline ───────────────────────────────────────────────────
async function callPipeline(authHeader, fn, body) {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/${fn}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      console.error(`[reservations-api] ${fn} returned ${res.status}: ${detail}`);
      return;
    }
    console.log(`[reservations-api] ${fn} ok for trip ${body.trip_id}`);
  } catch (e) {
    console.error(`[reservations-api] ${fn} unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }
}
// Refreshes everything derived from this trip's reservations. Runs after the
// response is sent — via EdgeRuntime.waitUntil where it exists, so the isolate
// stays alive until the work finishes rather than being torn down mid-flight.
// Never throws: a failed refresh must not turn a successful write into an
// error, but it must be visible in the logs, which is what the old
// `.catch(() => {})` prevented.
function refreshTripDerivedData(authHeader, trip_id) {
  const work = (async ()=>{
    await callPipeline(authHeader, "assemble-trip", {
      trip_id
    });
    await callPipeline(authHeader, "analyze-readiness", {
      trip_id
    });
    await callPipeline(authHeader, "generate-offline-pack", {
      action: "mark_outdated",
      trip_id
    });
  })();
  const runtime = globalThis.EdgeRuntime;
  if (runtime && typeof runtime.waitUntil === "function") {
    runtime.waitUntil(work);
  } else {
    // Local/`deno run` fallback: nothing keeps the process alive for us.
    work.catch((e)=>console.error("[reservations-api] pipeline refresh failed:", e));
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
  // IP RATE LIMIT GATE (Q2.15) — runs before any bearer token is even looked
  // at, let alone verified. See the IP RATE LIMITING note above.
  const clientIp = getClientIp(req);
  const ipRate = await checkIpRateLimit(supabase, `reservations-api:ip:${clientIp}`);
  if (!ipRate.allowed) {
    return new Response(JSON.stringify({
      error: "Too many requests"
    }), {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(Math.max(1, ipRate.retryAfter)),
        ...corsHeaders()
      }
    });
  }
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
  // Writes only. GET falls straight through — see the RATE LIMITING note.
  //
  // The bucket is keyed on `user.id`, the subject of the JWT just verified,
  // and never on a trip_id or user_id taken from the body. A body-supplied
  // identity is chosen by the caller, so it would let them mint a fresh bucket
  // per request and the limit would count nothing. The `reservations-api:`
  // prefix keeps these buckets clear of every other function's in the shared
  // table.
  if (req.method === "POST" || req.method === "PATCH" || req.method === "DELETE") {
    const { allowed, retryAfter } = await checkWriteRateLimit(supabase, `reservations-api:write:user:${user.id}`);
    if (!allowed) {
      return new Response(JSON.stringify({
        error: "Too many requests"
      }), {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": String(Math.max(1, retryAfter)),
          ...corsHeaders()
        }
      });
    }
  }
  const url = new URL(req.url);
  if (req.method === "GET") {
    const trip_id = url.searchParams.get("trip_id");
    const reservation_id = url.searchParams.get("reservation_id");
    if (reservation_id) {
      const { data, error } = await supabase.from("reservations").select("*").eq("id", reservation_id).eq("user_id", user.id).single();
      if (error || !data) return new Response(JSON.stringify({
        error: "Reservation not found"
      }), {
        status: 404,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders()
        }
      });
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders()
        }
      });
    }
    if (!trip_id) {
      return new Response(JSON.stringify({
        error: "trip_id or reservation_id is required"
      }), {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders()
        }
      });
    }
    const { data, error } = await supabase.from("reservations").select("*").eq("trip_id", trip_id).eq("user_id", user.id).order("start_date", {
      ascending: true,
      nullsFirst: false
    }).order("start_time", {
      ascending: true,
      nullsFirst: false
    });
    if (error) return new Response(JSON.stringify({
      error: error.message
    }), {
      status: 500,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders()
      }
    });
    const list = data ?? [];
    return new Response(JSON.stringify({
      reservations: list,
      total_count: list.length,
      confirmed_count: list.filter((r)=>r.reservation_status === "CONFIRMED").length,
      needs_review_count: list.filter((r)=>r.needs_review === true).length
    }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders()
      }
    });
  }
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
    if (!body.trip_id || !body.reservation_type) {
      return new Response(JSON.stringify({
        error: "trip_id and reservation_type are required"
      }), {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders()
        }
      });
    }
    const ownsTrip = await verifyTripOwnership(supabase, body.trip_id, user.id);
    if (!ownsTrip) {
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
    const data_completeness = computeCompleteness(body.reservation_type, body);
    const confidence = computeConfidence(body);
    const { needs_review, review_reason } = computeValidation(body);
    const possible_duplicate_id = await checkDuplicate(supabase, body);
    const insertPayload = {
      user_id: user.id,
      trip_id: body.trip_id,
      reservation_type: body.reservation_type,
      provider_name: body.provider_name ?? null,
      confirmation_number: body.confirmation_number ?? null,
      reservation_status: body.reservation_status ?? "UNKNOWN",
      traveler_names: body.traveler_names ?? null,
      start_date: body.start_date ?? null,
      start_time: body.start_time ?? null,
      end_date: body.end_date ?? null,
      end_time: body.end_time ?? null,
      timezone: body.timezone ?? null,
      location_name: body.location_name ?? null,
      address: body.address ?? null,
      city: body.city ?? null,
      state_or_region: body.state_or_region ?? null,
      country: body.country ?? null,
      latitude: body.latitude ?? null,
      longitude: body.longitude ?? null,
      details: body.details ?? {},
      notes: body.notes ?? null,
      source_type: body.source_type ?? "MANUAL",
      source_reference: body.source_reference ?? null,
      confidence,
      data_completeness,
      needs_review,
      review_reason,
      possible_duplicate_id
    };
    const { data: created, error: insertError } = await supabase.from("reservations").insert(insertPayload).select().single();
    if (insertError) return new Response(JSON.stringify({
      error: insertError.message
    }), {
      status: 500,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders()
      }
    });
    refreshTripDerivedData(authHeader, body.trip_id);
    return new Response(JSON.stringify(created), {
      status: 201,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders()
      }
    });
  }
  if (req.method === "PATCH") {
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
    const { reservation_id, ...fields } = body;
    if (!reservation_id) {
      return new Response(JSON.stringify({
        error: "reservation_id is required"
      }), {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders()
        }
      });
    }
    const { data: existing, error: fetchError } = await supabase.from("reservations").select("*").eq("id", reservation_id).eq("user_id", user.id).single();
    if (fetchError || !existing) return new Response(JSON.stringify({
      error: "Reservation not found"
    }), {
      status: 404,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders()
      }
    });
    // A PATCH that re-points trip_id must be checked exactly like a create —
    // otherwise a caller can move their own reservation into a trip they do
    // not own.
    if (fields.trip_id && fields.trip_id !== existing.trip_id) {
      const ownsTrip = await verifyTripOwnership(supabase, fields.trip_id, user.id);
      if (!ownsTrip) {
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
    }
    const merged = {
      ...existing,
      ...fields
    };
    const data_completeness = computeCompleteness(merged.reservation_type, merged);
    const confidence = computeConfidence(merged);
    const { needs_review, review_reason } = computeValidation(merged);
    const possible_duplicate_id = await checkDuplicate(supabase, merged, reservation_id);
    const updatePayload = {
      ...fields,
      data_completeness,
      confidence,
      needs_review,
      review_reason,
      possible_duplicate_id
    };
    delete updatePayload.id;
    delete updatePayload.user_id;
    delete updatePayload.created_at;
    const { data: updated, error: updateError } = await supabase.from("reservations").update(updatePayload).eq("id", reservation_id).eq("user_id", user.id).select().single();
    if (updateError) return new Response(JSON.stringify({
      error: updateError.message
    }), {
      status: 500,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders()
      }
    });
    // Both trips are refreshed when the reservation moved between them —
    // otherwise the trip it left keeps a stale assembly that still counts it.
    refreshTripDerivedData(authHeader, existing.trip_id);
    if (updated && updated.trip_id && updated.trip_id !== existing.trip_id) {
      refreshTripDerivedData(authHeader, updated.trip_id);
    }
    return new Response(JSON.stringify(updated), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders()
      }
    });
  }
  if (req.method === "DELETE") {
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
    const { reservation_id } = body;
    if (!reservation_id) {
      return new Response(JSON.stringify({
        error: "reservation_id is required"
      }), {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders()
        }
      });
    }
    const { data: existing, error: fetchError } = await supabase.from("reservations").select("id, trip_id").eq("id", reservation_id).eq("user_id", user.id).single();
    if (fetchError || !existing) return new Response(JSON.stringify({
      error: "Reservation not found"
    }), {
      status: 404,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders()
      }
    });
    // reservations.possible_duplicate_id is a self-referencing FK with no ON
    // DELETE action, so deleting a row that some OTHER row was flagged against
    // fails with a foreign key violation — a 500 on an ordinary delete, and
    // only ever reachable once duplicates exist, which is exactly when a user
    // is most likely to be deleting one. Clear the inbound references first.
    const { error: unlinkError } = await supabase.from("reservations").update({
      possible_duplicate_id: null
    }).eq("possible_duplicate_id", reservation_id);
    if (unlinkError) {
      console.error("[reservations-api] could not clear duplicate references:", unlinkError.message);
      return new Response(JSON.stringify({
        error: unlinkError.message
      }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders()
        }
      });
    }
    const { error: deleteError } = await supabase.from("reservations").delete().eq("id", reservation_id).eq("user_id", user.id);
    if (deleteError) return new Response(JSON.stringify({
      error: deleteError.message
    }), {
      status: 500,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders()
      }
    });
    refreshTripDerivedData(authHeader, existing.trip_id);
    return new Response(JSON.stringify({
      success: true
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

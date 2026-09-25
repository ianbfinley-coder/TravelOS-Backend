// VIEWER GATE 2026-09-25 — viewers read cached results but cannot run a new check.
//   A new run is a billed AI call plus writes, so user callers now need an
//   active account membership (trip_members kind 'account', removed_at null)
//   with role owner/organizer/member. A viewer still gets a valid cached
//   result (the cache check runs first); where a new run would be needed they
//   get 403 { error: "FORBIDDEN", message: "Viewers can see this trip's health
//   but can't run a new check." }. force_refresh from a viewer is therefore a
//   403. Non-members still get 404. Service callers are unchanged.
// ITINERARY RECONCILIATION 2026-09-24 — keyed by trip, reads itinerary_items.
// ---------------------------------------------------------------------------
// This function required a generated_itineraries (GI) id and read GI.itinerary.
// GI is being retired; current trips keep their live plan in itinerary_items
// and their history in itinerary_versions, so every current trip got a 400/404
// here and the whole trip-health chain had gone dark.
//
// CONTRACT NOW
//   POST { trip_id (required), version_id?, force_refresh?, user_id? (service only),
//          itinerary_id? (legacy — accepted and ignored, never required) }
//   * The days[] structure the prompt expects is rebuilt in code from
//     itinerary_items (see the reconciliation helpers below). The prompt text,
//     scoring rules and response parsing are unchanged. GI-only inputs that
//     items do not carry (validation/geo/pace reports) are passed as
//     "Not available", exactly as the prompt already handled a missing report.
//   * version_id defaults to the trip's active itinerary_versions row (null if
//     the trip has none). New rows are written with trip_id + version_id and
//     itinerary_id = null.
//   * Budget context is the latest ready budget_analyses row for the trip.
//   * Cache: a ready row for the same trip + version newer than 30 minutes AND
//     newer than the last itinerary_items edit.
//   * A trip with zero live items returns 200 { analysis: null,
//     status: "no_itinerary" } without an AI call or a write.
//   * Response adds version_id and item_count alongside { analysis, cached }.
//
// AUTHORIZATION NOW
//   User callers must be an active trip member (trip_members via
//   auth_identities, removed_at IS NULL); otherwise 404 "Trip not found".
//   The trips.user_id and generated_itineraries.user_id ownership checks
//   described in the SECURITY 2026-09-16 note below are REPLACED by this.
//   Service-role callers are trusted as before; the row's user_id is the
//   body user_id, else trips.user_id. For user callers it is always the
//   verified token's uid.
// ---------------------------------------------------------------------------
// FABRICATION REMOVED 2026-09-19 — the AI failure path wrote a real-looking
// health score into the database.
// ---------------------------------------------------------------------------
// If you are reading this with no other context: when the OpenRouter call
// failed (timeout, rate limit, bad key, unparseable JSON — anything inside the
// try block below), this function used to INSERT a row into
// public.trip_health_analyses before returning:
//
//   const { data: failedRow } = await supabase
//     .from("trip_health_analyses")
//     .insert({
//       trip_id,
//       itinerary_id,
//       user_id,
//       health_score: 0,
//       health_status: "watch",
//       status: "failed",
//       data_completeness: "insufficient",
//     })
//     .select()
//     .single();
//
// `health_score: 0` and `health_status: "watch"` are not measurements. Nothing
// was analyzed — the analysis is exactly what failed. But once that row exists
// it is a row in the health table like any other, and every reader downstream
// (get-trip-health, the readiness surfaces, the alert pipeline, the copilot
// context) consumes health_score and health_status. A trip whose analysis
// failed became a trip scored zero. A genuine 0 and "we could not analyze this"
// were stored identically and could not be told apart a week later.
//
// Worse, the two invented values disagreed with each other and with this file's
// own rules: determineHealthStatus(0) returns "needs_attention", not "watch",
// so the stored pair was not even internally consistent — a score of 0 labelled
// "watch" cannot be produced by any successful run of this function.
//
// WHAT IT DOES NOW
// The failure path writes NOTHING and returns HTTP 500 naming the failure. The
// absence of a row is the honest record of an analysis that did not happen:
// the cache lookup above only accepts status = 'ready' rows, so the next call
// simply retries instead of serving a fabricated zero.
//
// Callers that previously read `analysis` off the error body now get
// `analysis: null` with `status: 'unavailable'` and a safeFailureMessage. A UI
// must render that as "health could not be analyzed", never as a score.
//
// Rows already in the database: trip_health_analyses was checked on 2026-09-19
// and held 4 rows, all status='ready' with real scores (72, 81, 73, 81) and
// none with health_score=0/health_status='watch'. No fabricated row from this
// path is present. Any future row with status='failed' predating this change
// would be one.
// ---------------------------------------------------------------------------
// SECURITY 2026-09-16 — Authentication was a presence check, not verification.
//
// The entire auth gate was:
//   const authHeader = req.headers.get("Authorization");
//   if (!authHeader) {
//     return new Response(JSON.stringify({ error: "Missing authorization header" }), { status: 401, ... });
//   }
// The header value was never decoded or verified, so `Authorization: x`
// passed. The function then built a service_role client (bypasses RLS) and
// read/wrote `trip_health_analyses` rows for whatever trip_id, itinerary_id
// and user_id the caller put in the JSON body. Any caller could read another
// user's itinerary and budget data, insert fabricated health analyses under
// an arbitrary user_id, or trigger paid OpenRouter calls at will.
//
// Fixed: requireUserOrService() verifies the bearer token. It accepts either
// a real user JWT or the service_role key, because this function is also
// called fire-and-forget by create-itinerary-version and change-plan with
// `Authorization: Bearer <service_role_key>`. For a user caller, user_id
// comes only from the verified token (never the body), and both the trip
// (trips.user_id) and the itinerary (generated_itineraries.user_id) must
// belong to that caller before any database work happens. A caller who
// doesn't own the target gets 404, not 403, so ids can't be enumerated.
// Service callers are trusted, matching their existing internal-pipeline use.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { requireUserOrService, serviceClient } from "./_shared/auth.ts";
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY");
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};
const SYSTEM_PROMPT = `You are TravelOS's Trip Health Analysis Engine. You analyze travel itineraries and produce structured health assessments. You are a planning heuristic tool — you identify potential friction and planning quality issues. You do NOT predict actual travel outcomes. You do NOT fabricate information. You clearly distinguish between known problems, estimates, and unknowns.`;
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
 * 2026-09-25 — the caller's best active account-membership role on the trip
 * (owner > organizer > member > viewer), or null for a non-member.
 */ const RECON_ROLE_RANK = {
  owner: 4,
  organizer: 3,
  member: 2,
  viewer: 1
};
async function reconMemberRole(db, tripId, authUid) {
  const { data: idents, error: identErr } = await db.from("auth_identities").select("user_id").eq("provider_subject", authUid);
  if (identErr) throw new Error(`identity lookup failed: ${identErr.message}`);
  const platformIds = [
    ...new Set((idents ?? []).map((r)=>r.user_id).filter(Boolean))
  ];
  if (platformIds.length === 0) return null;
  const { data: members, error: memberErr } = await db.from("trip_members").select("role").eq("trip_id", tripId).eq("kind", "account").in("user_id", platformIds).is("removed_at", null);
  if (memberErr) throw new Error(`membership lookup failed: ${memberErr.message}`);
  let best = null;
  for (const m of members ?? []){
    const r = String(m.role ?? "");
    if ((RECON_ROLE_RANK[r] ?? 0) > (best ? RECON_ROLE_RANK[best] : 0)) best = r;
  }
  return best;
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
// ─── end ITINERARY RECONCILIATION helpers ───
// ─── ITINERARY RECONCILIATION 2026-09-24: itinerary_items -> legacy days[] ───
// The analysis prompts below were written against generated_itineraries.itinerary,
// a days array: [{ day_number, date, day_label, city, activities: [{ id, time,
// title, description, duration_minutes, location, category, ... }], meals,
// daily_summary }]. Current trips keep their live plan in itinerary_items, so
// that shape is rebuilt here, in code, from the items:
//   * grouped by calendar date in trips.primary_tz (start_time converted to that
//     zone; an item with no start_time uses its own `date`);
//   * day_number = days since trips.start_date + 1 (sequential when no start_date);
//     every date in the trip's start..end range is emitted, so rest days are
//     visible to the pace/friction logic as empty days, not missing ones;
//   * activity.time = HH:MM of start_time in primary_tz, or null (never guessed);
//   * duration_minutes = duration_min, else end_time - start_time, else null;
//   * description = notes; category = category ?? type; id = the item id;
//   * city, meals and daily_summary are not stored on items and are left
//     null / [] rather than invented. Items whose status is cancelled/removed
//     are excluded; items with neither start_time nor date go in a trailing
//     "Unscheduled" day with day_number null.
const RECON_ITEM_COLUMNS = "id, title, type, category, status, date, start_time, end_time, timezone, duration_min, location, notes, " + "transport_mode, party_size, lat, lng, fixed, fixed_start, outdoor, must_do, critical, energy_cost, created_at, updated_at";
const RECON_EXCLUDED_STATUSES = new Set([
  "cancelled",
  "canceled",
  "removed",
  "deleted"
]);
const RECON_MAX_RANGE_DAYS = 120;
function reconSafeTz(tz) {
  if (typeof tz !== "string" || !tz) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz
    });
    return tz;
  } catch  {
    return "UTC";
  }
}
function reconLocalParts(iso, tz) {
  if (typeof iso !== "string" || !iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const parts = {};
  for (const p of new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(d))parts[p.type] = p.value;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`
  };
}
function reconIsDate(v) {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
}
function reconDayDiff(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}
function reconAddDays(d, n) {
  return new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}
/** All itinerary_items for the trip. A query failure throws — it is not an empty trip. */ async function reconLoadItems(db, tripId) {
  const { data, error } = await db.from("itinerary_items").select(RECON_ITEM_COLUMNS).eq("trip_id", tripId).order("date", {
    ascending: true,
    nullsFirst: false
  }).order("start_time", {
    ascending: true,
    nullsFirst: false
  });
  if (error) throw new Error(`itinerary_items lookup failed: ${error.message}`);
  return data ?? [];
}
function reconBuildDays(items, trip) {
  const tz = reconSafeTz(trip.primary_tz);
  let latest = null;
  for (const it of items){
    const t = Date.parse(it.updated_at ?? it.created_at ?? "");
    if (!Number.isNaN(t) && (latest === null || t > latest)) latest = t;
  }
  const live = items.filter((it)=>!RECON_EXCLUDED_STATUSES.has(String(it.status ?? "").toLowerCase()));
  const byDate = new Map();
  const undated = [];
  for (const it of live){
    const start = reconLocalParts(it.start_time, tz);
    const end = reconLocalParts(it.end_time, tz);
    const date = start?.date ?? (reconIsDate(it.date) ? it.date : null);
    let duration = typeof it.duration_min === "number" ? it.duration_min : null;
    if (duration === null && it.start_time && it.end_time) {
      const mins = Math.round((Date.parse(it.end_time) - Date.parse(it.start_time)) / 60000);
      if (Number.isFinite(mins) && mins > 0) duration = mins;
    }
    const activity = {
      id: it.id,
      time: start?.time ?? null,
      end_time: end?.time ?? null,
      title: it.title ?? null,
      description: it.notes ?? null,
      duration_minutes: duration,
      location: it.location ?? null,
      category: it.category ?? it.type ?? null,
      type: it.type ?? null,
      status: it.status ?? null,
      transport_mode: it.transport_mode ?? null,
      party_size: it.party_size ?? null,
      lat: it.lat ?? null,
      lng: it.lng ?? null,
      fixed: it.fixed ?? null,
      must_do: it.must_do ?? null,
      critical: it.critical ?? null,
      outdoor: it.outdoor ?? null,
      energy_cost: it.energy_cost ?? null
    };
    const entry = {
      sort: it.start_time ? Date.parse(it.start_time) : Number.POSITIVE_INFINITY,
      created: Date.parse(it.created_at ?? "") || 0,
      activity
    };
    if (date) {
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push(entry);
    } else {
      undated.push(entry);
    }
  }
  const dates = new Set(byDate.keys());
  const startDate = reconIsDate(trip.start_date) ? trip.start_date : null;
  const endDate = reconIsDate(trip.end_date) ? trip.end_date : null;
  if (startDate && endDate) {
    const span = reconDayDiff(startDate, endDate);
    if (span >= 0 && span <= RECON_MAX_RANGE_DAYS) {
      for(let i = 0; i <= span; i++)dates.add(reconAddDays(startDate, i));
    }
  }
  const bySort = (a, b)=>a.sort !== b.sort ? a.sort < b.sort ? -1 : 1 : a.created - b.created;
  const days = [
    ...dates
  ].sort().map((date, idx)=>{
    const n = startDate ? reconDayDiff(startDate, date) + 1 : idx + 1;
    return {
      day_number: n,
      date,
      day_label: `Day ${n}`,
      city: null,
      activities: (byDate.get(date) ?? []).sort(bySort).map((e)=>e.activity),
      meals: [],
      daily_summary: null
    };
  });
  if (undated.length > 0) {
    days.push({
      day_number: null,
      date: null,
      day_label: "Unscheduled",
      city: null,
      activities: undated.sort(bySort).map((e)=>e.activity),
      meals: [],
      daily_summary: null
    });
  }
  return {
    days,
    item_count: live.length,
    latest_item_change: latest === null ? null : new Date(latest).toISOString()
  };
}
/** Stand-in for generated_itineraries.trip_summary, built only from stored trip facts. */ function reconTripSummary(trip, built) {
  return {
    name: trip.name ?? trip.title ?? null,
    destination: trip.destination ?? null,
    start_date: trip.start_date ?? null,
    end_date: trip.end_date ?? null,
    timezone: trip.primary_tz ?? null,
    base_currency: trip.base_currency ?? null,
    total_days: built.days.filter((d)=>d.date).length,
    total_items: built.item_count,
    source: "itinerary_items"
  };
}
/** Cache cutoff: 30 minutes ago, or the last item edit if that is more recent. */ function reconCacheCutoff(latestItemChange) {
  const thirty = Date.now() - 30 * 60 * 1000;
  const edited = latestItemChange ? Date.parse(latestItemChange) : NaN;
  return new Date(Number.isNaN(edited) ? thirty : Math.max(thirty, edited + 1)).toISOString();
}
// ─── end itinerary_items -> days[] ───
function determineHealthStatus(score) {
  if (score >= 90) return "excellent";
  if (score >= 75) return "good";
  if (score >= 60) return "watch";
  return "needs_attention";
}
serve(async (req)=>{
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: CORS_HEADERS
    });
  }
  const supabase = serviceClient();
  try {
    // SECURITY 2026-09-16: verify the caller (user JWT or service_role key).
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
    // ITINERARY RECONCILIATION 2026-09-24: trip_id is the key. itinerary_id is
    // legacy — accepted so old callers do not 400, but never required or used.
    const { trip_id, version_id: requestedVersionId, force_refresh = false } = body;
    if (body.itinerary_id) {
      console.log("[analyze-trip-health] legacy itinerary_id supplied and ignored:", body.itinerary_id);
    }
    if (!reconIsUuid(trip_id)) {
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
    const trip = await reconLoadTrip(supabase, trip_id);
    // VIEWER GATE 2026-09-25: role, not just membership (null = non-member).
    const callerRole = trip && caller.kind === "user" ? await reconMemberRole(supabase, trip_id, caller.userId) : null;
    if (!trip || caller.kind === "user" && !callerRole) {
      return new Response(JSON.stringify({
        error: "Trip not found"
      }), {
        status: 404,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/json"
        }
      });
    }
    const user_id = caller.kind === "user" ? caller.userId : (reconIsUuid(body.user_id) ? body.user_id : null) ?? trip.user_id;
    if (!user_id) {
      return new Response(JSON.stringify({
        error: "user_id could not be resolved for this trip"
      }), {
        status: 400,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/json"
        }
      });
    }
    const version = await reconResolveVersion(supabase, trip_id, requestedVersionId);
    if (version === "not_found") {
      return new Response(JSON.stringify({
        error: "Version not found"
      }), {
        status: 404,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/json"
        }
      });
    }
    const version_id = version.id;
    // Load the live itinerary. A failed read throws to the 500 handler; it is
    // never reported as an empty trip.
    const built = reconBuildDays(await reconLoadItems(supabase, trip_id), trip);
    if (built.item_count === 0) {
      return new Response(JSON.stringify({
        analysis: null,
        cached: false,
        status: "no_itinerary",
        persisted: false,
        version_id,
        item_count: 0,
        message: "This trip has no itinerary items yet, so there is nothing to analyze. No score was produced or recorded."
      }), {
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/json"
        }
      });
    }
    // Check cache if not force_refresh
    if (!force_refresh) {
      let cacheQuery = supabase.from("trip_health_analyses").select("*").eq("trip_id", trip_id).eq("status", "ready").gte("analyzed_at", reconCacheCutoff(built.latest_item_change)).order("analyzed_at", {
        ascending: false
      }).limit(1);
      cacheQuery = version_id ? cacheQuery.eq("version_id", version_id) : cacheQuery.is("version_id", null);
      const { data: cached, error: cacheErr } = await cacheQuery.maybeSingle();
      if (cacheErr) console.error("[analyze-trip-health] cache read failed (treated as miss):", cacheErr.message);
      if (cached) {
        return new Response(JSON.stringify({
          analysis: cached,
          cached: true,
          version_id,
          item_count: built.item_count
        }), {
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "application/json"
          }
        });
      }
    }
    // VIEWER GATE 2026-09-25 — past this point a new (billed) check runs.
    if (callerRole === "viewer") {
      return new Response(JSON.stringify({
        error: "FORBIDDEN",
        message: "Viewers can see this trip's health but can't run a new check."
      }), {
        status: 403,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/json"
        }
      });
    }
    // Stand-in for the generated_itineraries row the prompt below was written
    // against. Reports that items do not carry are undefined, which the prompt
    // renders as 'Not available'.
    const itinerary = {
      trip_summary: reconTripSummary(trip, built),
      itinerary: built.days,
      validation_report: undefined,
      geo_report: undefined,
      pace_report: undefined
    };
    // Fetch latest budget analysis (by trip; budget_analyses.itinerary_id is a GI id)
    let budgetAnalysis = null;
    try {
      const { data: budgetRow, error: budgetErr } = await supabase.from("budget_analyses").select("*").eq("trip_id", trip_id).eq("status", "ready").order("created_at", {
        ascending: false
      }).limit(1).maybeSingle();
      if (budgetErr) console.error("[analyze-trip-health] Budget fetch error (non-fatal):", budgetErr.message);
      budgetAnalysis = budgetRow;
    } catch (e) {
      console.error("[analyze-trip-health] Budget fetch failed (non-fatal):", e);
    }
    // Fetch previous health score for trend
    let previousHealthScore = null;
    try {
      const { data: prevHealth, error: prevErr } = await supabase.from("trip_health_analyses").select("health_score").eq("trip_id", trip_id).eq("status", "ready").order("created_at", {
        ascending: false
      }).limit(1).maybeSingle();
      if (prevErr) console.error("[analyze-trip-health] Previous health fetch error (non-fatal):", prevErr.message);
      if (prevHealth) previousHealthScore = prevHealth.health_score;
    } catch (e) {
      console.error("[analyze-trip-health] Previous health fetch failed (non-fatal):", e);
    }
    // Build AI prompt
    const userPrompt = `Analyze this travel itinerary and produce a Trip Health assessment.

TRIP SUMMARY:
${JSON.stringify(itinerary.trip_summary || {})}

ITINERARY (day by day):
${JSON.stringify(itinerary.itinerary || [])}

VALIDATION REPORT:
${JSON.stringify(itinerary.validation_report) || 'Not available'}

GEOGRAPHIC REPORT:
${JSON.stringify(itinerary.geo_report) || 'Not available'}

PACE REPORT:
${JSON.stringify(itinerary.pace_report) || 'Not available'}

BUDGET ANALYSIS:
${JSON.stringify(budgetAnalysis) || 'Not available'}

SCORING RULES:
- Score each dimension 0-20 (total = 0-100)
- Schedule (0-20): time conflicts, overlaps, arrival/departure issues, reservation conflicts
- Geography (0-20): backtracking, inefficient routing, excessive location changes
- Pace (0-20): overloaded days, consecutive busy days, insufficient rest, walking load
- Budget (0-20): over-budget, budget pressure, unknown costs, no buffer
- Completeness (0-20): missing hotel/transport/reservation info, unknown items

SCORING GUIDANCE:
- 18-20: No significant issues
- 14-17: Minor issues only
- 10-13: Moderate issues
- 6-9: Significant issues
- 0-5: Critical issues

IMPORTANT RULES:
1. Do NOT double-penalize the same root cause across multiple dimensions
2. Do NOT penalize for unknown information the same as known problems — unknowns create uncertainty, not automatic failures
3. Distinguish KNOWN PROBLEM vs UNKNOWN/NEEDS VERIFICATION
4. Keep issue descriptions traveler-friendly (no technical jargon)
5. Prioritize issues: reservation conflicts > validation failures > arrival/departure > overloaded days > geo inefficiency > budget pressure > walking/fatigue > unknowns
6. Daily friction = planning complexity for that day (0-100), NOT a prediction of problems

Return ONLY valid JSON matching this exact schema:
{
  "health_score": number (0-100, sum of 5 dimension scores),
  "health_status": "excellent"|"good"|"watch"|"needs_attention",
  "schedule_score": number (0-20),
  "geography_score": number (0-20),
  "pace_score": number (0-20),
  "budget_score": number (0-20),
  "completeness_score": number (0-20),
  "overall_assessment": string (2-3 sentences, traveler-friendly),
  "daily_friction": [
    {
      "day_number": number,
      "friction_score": number (0-100),
      "friction_label": "LOW"|"MODERATE"|"ELEVATED"|"HIGH"|"VERY_HIGH",
      "primary_issue": string | null,
      "recommended_action": string | null,
      "factors": string[] (2-4 bullet points explaining friction sources)
    }
  ],
  "issues": [
    {
      "id": string (unique, e.g. "issue_1"),
      "severity": "CRITICAL"|"HIGH"|"MEDIUM"|"LOW"|"INFO",
      "category": "SCHEDULE"|"GEOGRAPHY"|"PACE"|"WALKING"|"BUDGET"|"RESERVATIONS"|"COMPLETENESS"|"TRANSPORTATION"|"OTHER",
      "affected_days": number[],
      "title": string (short, max 60 chars),
      "description": string (what is happening, why it matters),
      "recommended_action": string,
      "auto_fixable": boolean,
      "confidence": "HIGH"|"MEDIUM"|"LOW",
      "potential_impact": string
    }
  ],
  "readiness_planning": "READY"|"READY_WITH_NOTES"|"NEEDS_REVIEW"|"UNKNOWN",
  "readiness_reservations": "READY"|"READY_WITH_NOTES"|"NEEDS_REVIEW"|"UNKNOWN",
  "readiness_transportation": "READY"|"READY_WITH_NOTES"|"NEEDS_REVIEW"|"UNKNOWN",
  "readiness_budget": "READY"|"READY_WITH_NOTES"|"NEEDS_REVIEW"|"UNKNOWN",
  "readiness_overall": "READY"|"READY_WITH_NOTES"|"NEEDS_REVIEW"|"UNKNOWN",
  "unknown_items_count": number,
  "top_issue_title": string | null,
  "top_issue_severity": string | null,
  "data_completeness": "full"|"partial"|"insufficient"
}`;
    // Call OpenRouter
    let aiResult;
    try {
      const aiResp = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
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
              content: userPrompt
            }
          ],
          response_format: {
            type: "json_object"
          },
          temperature: 0.2,
          max_tokens: 8000
        })
      });
      if (!aiResp.ok) {
        const errText = await aiResp.text();
        throw new Error(`OpenRouter error: ${errText}`);
      }
      const aiData = await aiResp.json();
      const rawContent = aiData.choices?.[0]?.message?.content;
      if (!rawContent) throw new Error("Empty AI response");
      aiResult = JSON.parse(rawContent);
    } catch (aiError) {
      const errMsg = aiError instanceof Error ? aiError.message : String(aiError);
      console.error("[analyze-trip-health] AI call failed:", errMsg);
      // FABRICATION REMOVED 2026-09-19 — this used to INSERT a
      // trip_health_analyses row with health_score: 0 and
      // health_status: "watch". Nothing was analyzed, so there is no score to
      // record. Nothing is written; the failure is reported as a failure.
      // See the block at the top of this file.
      return new Response(JSON.stringify({
        error: "health_analysis_failed",
        details: errMsg,
        analysis: null,
        data: null,
        status: "unavailable",
        persisted: false,
        safeFailureMessage: "Trip health could not be analyzed because the analysis service did not respond. " + "No score was produced and none was recorded — this is not a score of zero. Try again."
      }), {
        status: 500,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/json"
        }
      });
    }
    // Determine health status from score
    const healthScore = Math.min(100, Math.max(0, Number(aiResult.health_score) || 0));
    const healthStatus = determineHealthStatus(healthScore);
    // Calculate trend
    let healthScoreChange = null;
    let healthTrendMessage = null;
    if (previousHealthScore !== null) {
      healthScoreChange = healthScore - previousHealthScore;
      if (healthScoreChange > 5) {
        healthTrendMessage = "Your latest changes improved your trip health.";
      } else if (healthScoreChange < -5) {
        healthTrendMessage = "Your latest changes increased planning complexity.";
      } else {
        healthTrendMessage = "Your trip health is similar to the previous version.";
      }
    }
    // Insert into trip_health_analyses
    const { data: newAnalysis, error: insertError } = await supabase.from("trip_health_analyses").insert({
      trip_id,
      itinerary_id: null,
      version_id,
      user_id,
      health_score: healthScore,
      health_status: healthStatus,
      schedule_score: Number(aiResult.schedule_score) || 0,
      geography_score: Number(aiResult.geography_score) || 0,
      pace_score: Number(aiResult.pace_score) || 0,
      budget_score: Number(aiResult.budget_score) || 0,
      completeness_score: Number(aiResult.completeness_score) || 0,
      daily_friction: aiResult.daily_friction || [],
      issues: aiResult.issues || [],
      readiness_planning: aiResult.readiness_planning || "unknown",
      readiness_reservations: aiResult.readiness_reservations || "unknown",
      readiness_transportation: aiResult.readiness_transportation || "unknown",
      readiness_budget: aiResult.readiness_budget || "unknown",
      readiness_overall: aiResult.readiness_overall || "unknown",
      unknown_items_count: Number(aiResult.unknown_items_count) || 0,
      overall_assessment: aiResult.overall_assessment || null,
      top_issue_title: aiResult.top_issue_title || null,
      top_issue_severity: aiResult.top_issue_severity || null,
      data_completeness: aiResult.data_completeness || "partial",
      previous_health_score: previousHealthScore,
      health_score_change: healthScoreChange,
      health_trend_message: healthTrendMessage,
      status: "ready",
      analyzed_at: new Date().toISOString()
    }).select().single();
    if (insertError) {
      throw new Error(`Failed to save health analysis: ${insertError.message}`);
    }
    return new Response(JSON.stringify({
      analysis: newAnalysis,
      cached: false,
      version_id,
      item_count: built.item_count
    }), {
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/json"
      }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[analyze-trip-health] Unhandled error:", msg);
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

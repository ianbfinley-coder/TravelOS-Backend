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
// This function required a generated_itineraries (GI) id and read GI.itinerary,
// so it went dark for every current trip (their plan lives in itinerary_items).
//
// CONTRACT NOW
//   POST { trip_id (required), version_id?, force_refresh?, user_id? (service only),
//          itinerary_id? (legacy — accepted and ignored, never required) }
//   * days[] is rebuilt in code from itinerary_items (helpers below); the
//     prompt, scoring rules and normalisation are unchanged. Validation/geo/
//     pace reports are not stored for items and go in as "Not available".
//   * version_id defaults to the trip's active itinerary_versions row (null if
//     none). Rows are written with trip_id + version_id and itinerary_id = null.
//     This replaces the source_itinerary_id version lookup described in the
//     2026-09-19 note below: the version is now named explicitly or is the
//     active one, never inferred from a GI link.
//   * Budget daily analysis is the latest ready budget_analyses row for the trip.
//   * Cache: a ready row for the same trip + version newer than 30 minutes AND
//     newer than the last itinerary_items edit.
//   * A trip with zero live items returns the existing
//     { scores: [], message: "No itinerary data available" } shape, no AI call.
//
// AUTHORIZATION NOW
//   User callers must be an active trip member (trip_members via
//   auth_identities, removed_at IS NULL); otherwise 404 "Trip not found". The
//   generated_itineraries ownership scoping described below is REPLACED by this.
//   Service callers as before; row user_id = body user_id, else trips.user_id.
// ---------------------------------------------------------------------------
// SECURITY 2026-09-16 — Authentication was a presence check, not verification:
//   const authHeader = req.headers.get("Authorization");
//   if (!authHeader) return new Response(..., { status: 401 });
// Any value satisfied it — `Authorization: x` passed the check — because the
// token itself was never decoded. The function then built a service_role
// client (bypasses RLS) and took itinerary_id, trip_id, and user_id straight
// from the request body with no ownership check. An attacker who knew or
// guessed an itinerary_id could pass any user_id and trigger a paid AI
// analysis "on behalf of" a user they are not, with the result written to
// daily_friction_scores under that arbitrary user_id and returned to them.
// Fixed by gating on requireUserOrService (./_shared/auth.ts): the caller
// must present either a valid Supabase user JWT or the service_role key
// (create-itinerary-version calls this fire-and-forget with the service key,
// so that path must keep working). For a user caller, user_id now comes from
// the verified token, never the body. The generated_itineraries lookup is
// scoped to (id = itinerary_id AND user_id = that resolved user_id), so a
// caller can only trigger analysis on an itinerary they own — a mismatch
// falls through to the pre-existing "Itinerary not found" 404, so itinerary
// ids cannot be enumerated.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireUserOrService } from "./_shared/auth.ts";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY");
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};
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
function frictionStatus(score) {
  if (score <= 20) return "LOW";
  if (score <= 40) return "MODERATE";
  if (score <= 60) return "ELEVATED";
  if (score <= 80) return "HIGH";
  return "VERY_HIGH";
}
serve(async (req)=>{
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: CORS_HEADERS
    });
  }
  const caller = await requireUserOrService(req);
  if (caller instanceof Response) return caller;
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
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
    // ITINERARY RECONCILIATION 2026-09-24: trip_id is the key. itinerary_id is
    // legacy — accepted so old callers do not 400, but never required or used.
    const { trip_id, version_id: requestedVersionId, force_refresh = false } = body;
    if (body.itinerary_id) {
      console.log("[analyze-daily-friction] legacy itinerary_id supplied and ignored:", body.itinerary_id);
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
    // Load the live itinerary. A failed read throws to the 500 handler — the
    // "failure-looks-like-absence" rule from 2026-09-19 still holds.
    const built = reconBuildDays(await reconLoadItems(supabase, trip_id), trip);
    // Check cache (< 30 min old and newer than the last item edit) unless force_refresh
    if (!force_refresh) {
      // DEFECT 2026-09-19 — the error was discarded here, so a broken cache read
      // was indistinguishable from a cache miss and simply burned another AI
      // call every time, silently. A miss is still the right behaviour; it is
      // now at least logged.
      let cacheQuery = supabase.from("daily_friction_scores").select("*").eq("trip_id", trip_id).eq("status", "ready").gte("created_at", reconCacheCutoff(built.latest_item_change)).order("created_at", {
        ascending: false
      }).limit(1);
      cacheQuery = version_id ? cacheQuery.eq("version_id", version_id) : cacheQuery.is("version_id", null);
      const { data: cached, error: cacheError } = await cacheQuery.maybeSingle();
      if (cacheError) {
        console.error("[analyze-daily-friction] cache read failed:", cacheError.code, cacheError.message);
      }
      if (cached) {
        return new Response(JSON.stringify({
          analysis: cached,
          cached: true
        }), {
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "application/json"
          }
        });
      }
    }
    // Stand-in for the generated_itineraries row the prompt below was written
    // against. Reports that items do not carry are undefined, which the prompt
    // renders as 'Not available'.
    const itineraryRow = {
      itinerary: built.days,
      validation_report: undefined,
      geo_report: undefined,
      pace_report: undefined
    };
    const itinerary_days = built.item_count > 0 ? built.days : [];
    if (!itinerary_days || !Array.isArray(itinerary_days) || itinerary_days.length === 0) {
      return new Response(JSON.stringify({
        scores: [],
        message: "No itinerary data available"
      }), {
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/json"
        }
      });
    }
    // Fetch budget analysis (by trip; budget_analyses.itinerary_id is a GI id)
    let budget_daily_analysis = null;
    try {
      const { data: budgetRow, error: budgetError } = await supabase.from("budget_analyses").select("daily_analysis").eq("trip_id", trip_id).eq("status", "ready").order("created_at", {
        ascending: false
      }).limit(1).maybeSingle();
      if (budgetError) {
        console.error("[analyze-daily-friction] budget fetch failed (non-fatal):", budgetError.code, budgetError.message);
      }
      if (budgetRow) budget_daily_analysis = budgetRow.daily_analysis;
    } catch (e) {
      console.error("[analyze-daily-friction] Budget fetch failed (non-fatal):", e);
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
    // Insert placeholder row with status='analyzing'
    const { data: placeholderRow, error: placeholderError } = await supabase.from("daily_friction_scores").insert({
      trip_id,
      itinerary_id: null,
      version_id,
      user_id,
      scores: [],
      status: "analyzing"
    }).select().single();
    if (placeholderError || !placeholderRow) {
      throw new Error(`Failed to insert placeholder: ${placeholderError?.message}`);
    }
    const rowId = placeholderRow.id;
    // Build AI prompt
    const systemPrompt = `You are TravelOS's Daily Friction Analysis Engine. You analyze each day of a travel itinerary and produce a friction score representing how difficult, rushed, or complicated that day is likely to be to execute comfortably. This is a planning heuristic — not a prediction. You do NOT fabricate information. You clearly distinguish between known problems, estimates, and unknowns. You do NOT double-penalize the same underlying problem across multiple factors.`;
    const userPrompt = `Analyze each day of this travel itinerary and produce a Daily Friction Score for each day.

ITINERARY DAYS:
${JSON.stringify(itinerary_days)}

VALIDATION REPORT (use to identify scheduling conflicts, timing issues):
${JSON.stringify(itineraryRow.validation_report) || 'Not available'}

GEOGRAPHIC REPORT (use for backtracking, routing inefficiency):
${JSON.stringify(itineraryRow.geo_report) || 'Not available'}

PACE REPORT (use for overloaded days, walking load, energy):
${JSON.stringify(itineraryRow.pace_report) || 'Not available'}

BUDGET DAILY ANALYSIS (use for budget pressure per day):
${JSON.stringify(budget_daily_analysis) || 'Not available'}

FRICTION SCORING RULES:
- Score each day 0-100
- 0-20: LOW FRICTION
- 21-40: MODERATE
- 41-60: ELEVATED
- 61-80: HIGH
- 81-100: VERY HIGH

FRICTION FACTORS TO CONSIDER:
1. Schedule density (too many activities, insufficient transition time)
2. Travel complexity (number and complexity of location changes)
3. Geographic inefficiency (backtracking, unnecessary movement — use geo_report if available)
4. Walking load (high walking when user prefers low — use pace_report if available)
5. Pace (overloaded days — use pace_report if available)
6. Rest availability (meaningful breaks, open time, recovery)
7. Meal timing (unusually difficult meal timing)
8. Reservation pressure (tightly timed fixed commitments — but do NOT penalize confirmed reservations just for being confirmed)
9. Arrival/departure constraints (naturally higher friction due to logistics)
10. Unknown information (reduce confidence, not score)

IMPORTANT RULES:
1. Do NOT double-penalize the same root cause across multiple factors
2. Do NOT penalize confirmed reservations just because they are confirmed
3. Unknown information → reduce confidence, not automatically increase score
4. Arrival/departure days may naturally score higher due to logistics — this is expected
5. Use existing report data (geo, pace, validation) rather than re-analyzing from scratch
6. Confidence = reliability of available information (HIGH/MEDIUM/LOW)
7. Every day MUST have a numeric friction_score. If you genuinely cannot score a day, set friction_score to null and confidence to "LOW" — do NOT guess a number and do NOT omit the day.

Return ONLY valid JSON:
{
  "scores": [
    {
      "day_number": number,
      "date": string | null,
      "friction_score": number (0-100) | null,
      "friction_status": "LOW" | "MODERATE" | "ELEVATED" | "HIGH" | "VERY_HIGH" | "UNKNOWN",
      "top_factors": string[] (2-4 most important friction sources for this day),
      "explanation": string (1-2 sentences, traveler-friendly),
      "confidence": "HIGH" | "MEDIUM" | "LOW",
      "is_arrival_day": boolean,
      "is_departure_day": boolean
    }
  ]
}`;
    // Call OpenRouter
    let aiScores = [];
    let aiCallFailed = false;
    try {
      const aiResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": SUPABASE_URL,
          "X-Title": "TravelOS Daily Friction Analysis"
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
          temperature: 0.3,
          response_format: {
            type: "json_object"
          }
        })
      });
      if (!aiResponse.ok) {
        const errText = await aiResponse.text();
        throw new Error(`OpenRouter error ${aiResponse.status}: ${errText.slice(0, 300)}`);
      }
      const aiData = await aiResponse.json();
      const rawContent = aiData.choices?.[0]?.message?.content ?? "{}";
      const parsed = JSON.parse(rawContent);
      aiScores = Array.isArray(parsed.scores) ? parsed.scores : [];
      // DEFECT 2026-09-19 (fabricated data) — this normalisation step read
      //   friction_status: score.friction_status || frictionStatus(Number(score.friction_score) || 0)
      // Both `||`s invent. If the model returned a day with no friction_score
      // (or a non-numeric one), `Number(...) || 0` produced 0, and 0 maps to
      // "LOW". So a day the analysis could not score at all was stored and
      // shown to the traveller as the calmest day of their trip — the same
      // shape as the health-score-of-0-on-crash defect found elsewhere in this
      // codebase. An unscored day is now explicitly UNKNOWN with a null score,
      // and is excluded from the summary statistics below rather than dragging
      // the trip average down towards zero.
      aiScores = aiScores.map((s)=>{
        const score = s;
        const raw = score.friction_score;
        const numeric = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
        return {
          ...score,
          friction_score: numeric,
          friction_status: numeric === null ? "UNKNOWN" : score.friction_status || frictionStatus(numeric),
          score_available: numeric !== null
        };
      });
    } catch (e) {
      console.error("[analyze-daily-friction] AI call failed:", e);
      aiCallFailed = true;
    }
    if (aiCallFailed) {
      await supabase.from("daily_friction_scores").update({
        status: "failed"
      }).eq("id", rowId);
      return new Response(JSON.stringify({
        error: "AI analysis failed",
        analysis: {
          id: rowId,
          status: "failed"
        }
      }), {
        status: 500,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/json"
        }
      });
    }
    // Calculate summary stats over the days that actually have a score.
    // Previously every entry was assumed numeric, so a single unscored day
    // turned average_friction into NaN (serialised as null) and made the
    // highest/lowest reducers return whichever entry the comparison happened to
    // favour against undefined.
    const scored = aiScores.filter((s)=>typeof s.friction_score === "number");
    const average_friction = scored.length > 0 ? Math.round(scored.reduce((a, b)=>a + b.friction_score, 0) / scored.length * 100) / 100 : null;
    let highest_friction_day = null;
    let highest_friction_score = null;
    let lowest_friction_day = null;
    let lowest_friction_score = null;
    const high_friction_days = [];
    if (scored.length > 0) {
      const maxEntry = scored.reduce((a, b)=>a.friction_score >= b.friction_score ? a : b);
      const minEntry = scored.reduce((a, b)=>a.friction_score <= b.friction_score ? a : b);
      highest_friction_day = maxEntry.day_number;
      highest_friction_score = maxEntry.friction_score;
      lowest_friction_day = minEntry.day_number;
      lowest_friction_score = minEntry.friction_score;
      for (const s of scored){
        if (s.friction_score >= 61) high_friction_days.push(s.day_number);
      }
    }
    const now = new Date().toISOString();
    // Update the placeholder row with results
    const { data: updatedRow, error: updateError } = await supabase.from("daily_friction_scores").update({
      scores: aiScores,
      average_friction,
      highest_friction_day,
      highest_friction_score,
      lowest_friction_day,
      lowest_friction_score,
      high_friction_days,
      status: "ready",
      calculated_at: now
    }).eq("id", rowId).select().single();
    if (updateError || !updatedRow) {
      throw new Error(`Failed to update friction scores: ${updateError?.message}`);
    }
    return new Response(JSON.stringify({
      analysis: updatedRow,
      days_scored: scored.length,
      days_unscored: aiScores.length - scored.length
    }), {
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/json"
      }
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[analyze-daily-friction] Error:", message);
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

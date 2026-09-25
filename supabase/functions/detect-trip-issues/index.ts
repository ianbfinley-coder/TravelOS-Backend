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
// This function required a generated_itineraries (GI) id, read GI.itinerary
// and keyed the whole issue lifecycle on trip_issues.itinerary_id, so it went
// dark for every current trip (their plan lives in itinerary_items).
//
// CONTRACT NOW
//   POST { trip_id (required), version_id?, force_refresh?, user_id? (service only),
//          itinerary_id? (legacy — accepted and ignored, never required) }
//   * days[] is rebuilt in code from itinerary_items (helpers below); the
//     prompt, detection rules and lifecycle logic are unchanged.
//   * version_id defaults to the trip's active itinerary_versions row.
//   * The issue LIFECYCLE (previous count, stale resolution, DISMISSED map,
//     existing-issue match) is now scoped to trip_issues.trip_id instead of
//     itinerary_id, so an issue is one living row per trip + issue_key across
//     versions: a dismissal survives a version change, and re-detection
//     re-stamps version_id with the version it was last seen on. New rows
//     carry trip_id + version_id with itinerary_id = null.
//   * Context rows: budget_analyses latest for the trip; trip_health_analyses
//     and daily_friction_scores prefer the same version, else latest for the
//     trip — now restricted to status = 'ready' (an 'analyzing' friction
//     placeholder used to be eligible).
//   * A trip with zero live items returns 200 { issues: [], total_count: 0 }
//     with no AI call and no lifecycle writes.
//
// AUTHORIZATION NOW
//   User callers must be an active trip member (trip_members via
//   auth_identities, removed_at IS NULL); otherwise 404 "Trip not found". The
//   generated_itineraries ownership check and the user_id-scoped cache read
//   described in the SECURITY / FOLLOW-UP notes below are REPLACED by this
//   (issues are trip-level and visible to every active member). Service
//   callers as before; row user_id = body user_id, else trips.user_id.
// ---------------------------------------------------------------------------
// COLUMN NAMES 2026-09-19 — this function wrote and filtered a column that
// does not exist, and the whole issue lifecycle was dead because of it.
//
// `trip_issues` has `itinerary_id` (uuid, FK to generated_itineraries.id) and a
// separate `version_id` (uuid, FK to itinerary_versions.id). There is NO
// `itinerary_version_id` column. This function named that nonexistent column in
// SIX places:
//
//   1. the previous-issue count           .eq("itinerary_version_id", …)
//   2. the stale-resolution update        .eq("itinerary_version_id", …)   (detected-keys branch)
//   3. the stale-resolution update        .eq("itinerary_version_id", …)   (no-keys branch)
//   4. the DISMISSED lookup               .eq("itinerary_version_id", …)
//   5. the existing-issue lookup          .eq("itinerary_version_id", …)
//   6. the INSERT payload                 itinerary_version_id: itinerary_id
//
// PostgREST rejects the ENTIRE query when a filtered or written column does not
// exist, with error code 42703 (`column trip_issues.itinerary_version_id does
// not exist`). Every one of the six results was destructured as `const { data }`
// with the error discarded, so:
//
//   * previous_issue_count was always 0;
//   * resolved_count was always 0 and NOTHING was ever resolved — stale issues
//     accumulated forever;
//   * the DISMISSED map was always empty, so a dismissal was never respected
//     and a re-escalated issue was never re-opened;
//   * the existing-issue lookup always missed, so the function always took the
//     INSERT branch;
//   * and the INSERT itself always failed, so `upsertedIssues` was always empty
//     and this function returned `{issues: [], total_count: 0}` with HTTP 200 —
//     indistinguishable from "your trip has no issues".
//
// In short: the AI call ran (and was billed) on every request, and not one row
// was ever written or resolved. get-trip-issues reads these rows back with
// `.eq("trip_id", trip_id)`, and change-plan fixed this identical bug
// in itself on 2026-09-17 by moving to `.eq("itinerary_id", …)`. The correct
// column is `itinerary_id`, and all six sites now use it.
//
// Two further defects fixed in the same pass:
//
//   * `trips` has no `budget` and no `currency` column (it has `base_currency`).
//     `trip_context` read `trip?.budget` and `trip?.currency`, which are plain
//     property reads on a `select("*")` row: no 42703, they simply came back
//     `undefined` and JSON.stringify dropped them, so the model was silently
//     told nothing about the budget on every single call. The real budget lives
//     in `budget_analyses` (total_budget / currency), which this function
//     already fetches and passes to the model separately, so nothing is
//     invented here to fill the gap — the keys are removed and base_currency,
//     which does exist, is passed.
//
//   * `if (itineraryResult.error || !itineraryResult.data)` returned HTTP 200
//     with `{issues: [], message: "No itinerary data available"}`. A failed
//     query is not an empty trip. A read error is now a 500 that says so, and
//     only a genuinely absent row is a 404.
//
// Every `{ data }` destructure in this file that discarded an `error` now
// captures and logs it.
//
// SECURITY 2026-09-16 —
// This function's entire authentication was a presence check:
//   const authHeader = req.headers.get("Authorization");
//   if (!authHeader) { return new Response(..., { status: 401 }); }
// The token was never decoded or verified, so `Authorization: x` passed.
// The function then ran on a service_role client (bypasses RLS) and inserted
// or updated trip_issues rows using `trip_id`, `itinerary_id`, and `user_id`
// taken straight from the request body. Any caller who could reach this
// endpoint could write trip_issues for an arbitrary user_id/trip_id/
// itinerary_id — forging or resolving another user's issues.
// Fix: replaced the presence check with requireUserOrService (./_shared/auth.ts),
// which verifies the bearer token via auth.getUser() for normal callers and
// accepts the service_role key for the internal pipeline callers
// (create-itinerary-version, change-plan) that invoke this fire-and-forget.
// For a user caller, user_id now comes from the verified token
// (caller.userId), never from the request body.
//
// FOLLOW-UP FIX (same date) — the gate above verified identity but nothing
// scoped the reads to that identity, which left two leaks:
//   1. The 30-minute cache read (`trip_issues` by itinerary_id + status =
//      OPEN) had no user_id filter at all. On a cache hit, any authenticated
//      caller who supplied someone else's itinerary_id got that victim's
//      full trip_issues rows back — title, description, impact,
//      recommended_action.
//   2. Past the cache, `generated_itineraries` and `trips` were fetched by
//      `.eq("id", ...)` alone, with no ownership check, so a victim's
//      itinerary and budget would be sent to OpenRouter and the resulting
//      analysis (and the itinerary/trip rows visible in later steps) handed
//      back to the attacker.
// Fix: for `caller.kind === "user"`, we now confirm
// `generated_itineraries.id = itinerary_id AND user_id = caller.userId`
// before the cache read and before the main fetch, returning 404 on failure
// (matching get-trip-issues, which does the same check) so itinerary ids
// cannot be enumerated by response code. The cache read is additionally
// scoped with `.eq("user_id", caller.userId)`. Service callers are
// unaffected — they still pass identity via the body, as required by the
// fire-and-forget callers create-itinerary-version and change-plan.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { requireUserOrService, serviceClient, fail } from "./_shared/auth.ts";
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY");
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};
// PostgREST's `in` value list is parsed, not parameterised: an unquoted value
// containing a comma, a parenthesis or a quote silently changes the meaning of
// the filter (or makes it a parse error, which — being an error — used to be
// discarded along with everything else). issue_key comes from the model, so it
// is quoted defensively here.
function pgrstInList(values) {
  return `(${values.map((v)=>`"${String(v).replace(/"/g, '""')}"`).join(",")})`;
}
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
/** Latest ready row of an analysis table for the trip, preferring the given version. */ async function reconLatestAnalysis(db, table, tripId, versionId) {
  if (versionId) {
    const byVersion = await db.from(table).select("*").eq("trip_id", tripId).eq("version_id", versionId).eq("status", "ready").order("created_at", {
      ascending: false
    }).limit(1).maybeSingle();
    if (byVersion.error || byVersion.data) return {
      data: byVersion.data ?? null,
      error: byVersion.error ?? null
    };
  }
  const latest = await db.from(table).select("*").eq("trip_id", tripId).eq("status", "ready").order("created_at", {
    ascending: false
  }).limit(1).maybeSingle();
  return {
    data: latest.data ?? null,
    error: latest.error ?? null
  };
}
serve(async (req)=>{
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: CORS_HEADERS
    });
  }
  const supabase = serviceClient();
  try {
    // Auth check
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
      console.log("[detect-trip-issues] legacy itinerary_id supplied and ignored:", body.itinerary_id);
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
    // Membership gate before reading anything. 404, not 403, so trip ids
    // cannot be enumerated by response code.
    const trip = await reconLoadTrip(supabase, trip_id);
    // VIEWER GATE 2026-09-25: role, not just membership (null = non-member).
    const callerRole = trip && caller.kind === "user" ? await reconMemberRole(supabase, trip_id, caller.userId) : null;
    if (!trip || caller.kind === "user" && !callerRole) {
      return fail("Trip not found", 404);
    }
    // identity for user callers comes from the token, never the body:
    const user_id = caller.kind === "user" ? caller.userId : (reconIsUuid(body.user_id) ? body.user_id : null) ?? trip.user_id;
    if (!user_id) {
      return fail("user_id could not be resolved for this trip", 400);
    }
    const version = await reconResolveVersion(supabase, trip_id, requestedVersionId);
    if (version === "not_found") return fail("Version not found", 404);
    const version_id = version.id;
    // Load the live itinerary. A failed read throws to the 500 handler.
    const built = reconBuildDays(await reconLoadItems(supabase, trip_id), trip);
    if (built.item_count === 0) {
      return new Response(JSON.stringify({
        issues: [],
        total_count: 0,
        critical_count: 0,
        high_count: 0,
        version_id,
        message: "No itinerary data available"
      }), {
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/json"
        }
      });
    }
    // Check for recent issues if not force_refresh (newer than 30 minutes and
    // than the last itinerary_items edit)
    if (!force_refresh) {
      const { data: recentIssues, error: cacheErr } = await supabase.from("trip_issues").select("*").eq("trip_id", trip_id).eq("status", "OPEN").gte("created_at", reconCacheCutoff(built.latest_item_change)).order("priority_rank", {
        ascending: true
      });
      if (cacheErr) {
        // A cache-read failure is not "no cached issues" — it used to be
        // treated as one, which meant a broken cache read was invisible and
        // the (billed) AI path ran on every request.
        console.error("[detect-trip-issues] cache read failed:", cacheErr.message);
        return new Response(JSON.stringify({
          error: "Could not read cached issues",
          detail: cacheErr.message
        }), {
          status: 500,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "application/json"
          }
        });
      }
      if (recentIssues && recentIssues.length > 0) {
        const criticalCount = recentIssues.filter((i)=>i.severity === "CRITICAL").length;
        const highCount = recentIssues.filter((i)=>i.severity === "HIGH").length;
        return new Response(JSON.stringify({
          issues: recentIssues,
          total_count: recentIssues.length,
          critical_count: criticalCount,
          high_count: highCount,
          cached: true
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
    // Fetch count of currently open/acknowledged issues BEFORE detection (for delta reporting).
    // COLUMN FIX 2026-09-19: was .eq("itinerary_version_id", itinerary_id) — 42703.
    const { data: previousIssuesData, error: previousIssuesErr } = await supabase.from("trip_issues").select("issue_key, severity, status").eq("trip_id", trip_id).in("status", [
      "OPEN",
      "ACKNOWLEDGED"
    ]);
    if (previousIssuesErr) {
      console.error("[detect-trip-issues] previous-issue count failed:", previousIssuesErr.message);
    }
    // null when the read failed, so the client can tell "none open" from
    // "we could not count them" instead of both looking like 0.
    const previousIssueCount = previousIssuesErr ? null : previousIssuesData?.length ?? 0;
    // Fetch all analysis data in parallel
    // ITINERARY RECONCILIATION 2026-09-24: the itinerary comes from
    // itinerary_items (loaded above) and the trip row from the membership gate;
    // the analysis context rows are keyed by trip (+ version).
    const [budgetResult, healthResult, frictionResult] = await Promise.all([
      supabase.from("budget_analyses").select("*").eq("trip_id", trip_id).order("created_at", {
        ascending: false
      }).limit(1).maybeSingle(),
      reconLatestAnalysis(supabase, "trip_health_analyses", trip_id, version_id),
      reconLatestAnalysis(supabase, "daily_friction_scores", trip_id, version_id)
    ]);
    if (budgetResult.error) console.error("[detect-trip-issues] budget_analyses read failed:", budgetResult.error.message);
    if (healthResult.error) console.error("[detect-trip-issues] trip_health_analyses read failed:", healthResult.error.message);
    if (frictionResult.error) console.error("[detect-trip-issues] daily_friction_scores read failed:", frictionResult.error.message);
    // Stand-in for the generated_itineraries row the prompt below was written
    // against. Reports that items do not carry are undefined, which the prompt
    // renders as 'Not available'.
    const itinerary = {
      itinerary: built.days,
      validation_report: undefined,
      geo_report: undefined,
      pace_report: undefined
    };
    const budget_analysis = budgetResult.data;
    const health_analysis = healthResult.data;
    const friction_scores = frictionResult.data;
    // COLUMN FIX 2026-09-19: `budget` and `currency` are not columns on
    // `trips`. They were read off the row and came back undefined on every
    // call. `base_currency` is the real column. The trip's budget figure lives
    // in budget_analyses, which is passed to the model separately below — it
    // is deliberately NOT reconstructed or estimated here.
    const trip_context = {
      name: trip?.name ?? null,
      destination: trip?.destination ?? null,
      start_date: trip?.start_date ?? null,
      end_date: trip?.end_date ?? null,
      base_currency: trip?.base_currency ?? null
    };
    const itinerary_days = itinerary.itinerary;
    const validation_report = itinerary.validation_report;
    const geo_report = itinerary.geo_report;
    const pace_report = itinerary.pace_report;
    // Build AI prompt
    const userPrompt = `Analyze this travel itinerary data and identify meaningful issues.

TRIP CONTEXT:
${JSON.stringify(trip_context)}

ITINERARY DAYS:
${JSON.stringify(itinerary_days)}

VALIDATION REPORT:
${JSON.stringify(validation_report) || 'Not available'}

GEOGRAPHIC REPORT:
${JSON.stringify(geo_report) || 'Not available'}

PACE REPORT:
${JSON.stringify(pace_report) || 'Not available'}

BUDGET ANALYSIS:
${JSON.stringify(budget_analysis) || 'Not available'}

TRIP HEALTH ANALYSIS:
${JSON.stringify(health_analysis) || 'Not available'}

DAILY FRICTION SCORES:
${JSON.stringify(friction_scores) || 'Not available'}

ISSUE DETECTION RULES:
1. Distinguish PROBLEM (something is wrong), RISK (may become a problem), OPPORTUNITY (could be improved)
2. Use severity: CRITICAL (reservation conflicts, impossible timing), HIGH (serious scheduling/pace problems), MEDIUM (inefficiency, budget pressure), LOW (minor optimization), INFO (useful context)
3. Do NOT create multiple issues for the same root cause — consolidate symptoms into one primary issue
4. Do NOT penalize confirmed reservations just for being confirmed
5. Do NOT treat unknown information as a confirmed problem — use RISK type with lower confidence
6. Prioritize: feasibility > reservation conflicts > time constraints > major disruption > budget > pace/walking > geography > minor optimizations
7. Aim for 3-8 meaningful issues maximum — quality over quantity
8. Each issue needs a stable issue_key (snake_case, descriptive, e.g. "schedule_conflict_day3_museum", "overloaded_day5", "budget_pressure_overall")

Return ONLY valid JSON:
{
  "issues": [
    {
      "issue_key": string,
      "severity": "CRITICAL"|"HIGH"|"MEDIUM"|"LOW"|"INFO",
      "category": "SCHEDULE"|"GEOGRAPHY"|"PACE"|"WALKING"|"BUDGET"|"RESERVATIONS"|"TRANSPORTATION"|"COMPLETENESS"|"OTHER",
      "issue_type": "PROBLEM"|"RISK"|"OPPORTUNITY",
      "title": string,
      "short_description": string,
      "detailed_explanation": string,
      "impact": string,
      "recommended_action": string,
      "affected_days": number[],
      "source_system": string,
      "confidence": "HIGH"|"MEDIUM"|"LOW",
      "fixable_by": "CAN_OPTIMIZE"|"CAN_ADJUST"|"USER_DECISION_REQUIRED"|"INFORMATION_NEEDED"|"NO_AUTOMATIC_ACTION",
      "change_plan_prompt": string | null,
      "priority_rank": number
    }
  ]
}`;
    // Call OpenRouter
    let aiIssues = [];
    try {
      const aiResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "google/gemini-3.5-flash",
          messages: [
            {
              role: "system",
              content: "You are TravelOS's Issue Detection Engine. You analyze travel itinerary data from multiple planning systems and identify meaningful problems, risks, and opportunities. You do NOT fabricate information. You clearly distinguish between known problems, estimates, and unknowns. You avoid creating duplicate issues for the same underlying problem. You prioritize issues by actual impact on the traveler."
            },
            {
              role: "user",
              content: userPrompt
            }
          ],
          response_format: {
            type: "json_object"
          }
        })
      });
      if (!aiResponse.ok) {
        const errText = await aiResponse.text();
        console.error(`[detect-trip-issues] OpenRouter ${aiResponse.status}:`, errText);
        // Diagnosed 2026-09-18: this branch was collapsing every upstream
        // failure into a generic 503 "temporarily unavailable", which is
        // wrong for a permanent configuration problem — it will never
        // recover on its own no matter how many times the client retries.
        // Distinguish the cases we can identify by status code instead of
        // guessing, and always carry the real OpenRouter error through in a
        // `detail` field so it shows up in logs/clients instead of being
        // swallowed.
        if (aiResponse.status === 402) {
          // OpenRouter account out of credits. Permanent until billing is
          // fixed — never "temporarily unavailable".
          return new Response(JSON.stringify({
            error: "Issue detection unavailable: AI provider account is out of credits",
            detail: errText
          }), {
            status: 502,
            headers: {
              ...CORS_HEADERS,
              "Content-Type": "application/json"
            }
          });
        }
        if (aiResponse.status === 404) {
          // E.g. "No endpoints found for <model>" — the configured model id
          // is invalid/deprecated. Also a permanent config problem, not a
          // transient outage.
          return new Response(JSON.stringify({
            error: "Issue detection misconfigured: AI model unavailable",
            detail: errText
          }), {
            status: 502,
            headers: {
              ...CORS_HEADERS,
              "Content-Type": "application/json"
            }
          });
        }
        throw new Error(`OpenRouter error: ${aiResponse.status} ${errText}`);
      }
      const aiData = await aiResponse.json();
      const rawContent = aiData.choices?.[0]?.message?.content;
      if (!rawContent) throw new Error("Empty AI response");
      const parsed = JSON.parse(rawContent);
      aiIssues = parsed.issues || [];
    } catch (aiErr) {
      const message = aiErr instanceof Error ? aiErr.message : String(aiErr);
      console.error("[detect-trip-issues] AI call failed:", message);
      // Genuinely transient cases land here (network error, malformed AI
      // response, etc.) — those are the only ones for which "temporarily
      // unavailable" is accurate. The underlying error is still surfaced via
      // `detail` rather than swallowed.
      return new Response(JSON.stringify({
        error: "Issue detection temporarily unavailable",
        detail: message
      }), {
        status: 503,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/json"
        }
      });
    }
    // Build set of detected issue keys
    const detectedKeys = aiIssues.map((i)=>i.issue_key).filter(Boolean);
    // ─── ISSUE LIFECYCLE STEP 1: resolve stale OPEN/ACKNOWLEDGED issues ────
    // Issues that were open but are NOT in the newly detected set → RESOLVED
    // COLUMN FIX 2026-09-19: both branches filtered on the nonexistent
    // `itinerary_version_id`, so this update matched nothing and nothing was
    // ever resolved. The correct column is `itinerary_id`.
    let resolvedCount = 0;
    if (detectedKeys.length > 0) {
      const { data: resolvedRows, error: resolveErr } = await supabase.from("trip_issues").update({
        status: "RESOLVED",
        updated_at: new Date().toISOString()
      }).eq("trip_id", trip_id).in("status", [
        "OPEN",
        "ACKNOWLEDGED"
      ]).not("issue_key", "in", pgrstInList(detectedKeys)).select("id");
      if (resolveErr) {
        console.error("[detect-trip-issues] stale-issue resolution failed:", resolveErr.message);
        resolvedCount = null;
      } else {
        resolvedCount = resolvedRows?.length ?? 0;
      }
    } else {
      // No new issues detected — resolve everything
      const { data: resolvedRows, error: resolveErr } = await supabase.from("trip_issues").update({
        status: "RESOLVED",
        updated_at: new Date().toISOString()
      }).eq("trip_id", trip_id).in("status", [
        "OPEN",
        "ACKNOWLEDGED"
      ]).select("id");
      if (resolveErr) {
        console.error("[detect-trip-issues] blanket issue resolution failed:", resolveErr.message);
        resolvedCount = null;
      } else {
        resolvedCount = resolvedRows?.length ?? 0;
      }
    }
    // ─── ISSUE LIFECYCLE STEP 2: re-open DISMISSED issues with higher severity ─
    // Fetch all DISMISSED issues for this itinerary so we can compare severity.
    // COLUMN FIX 2026-09-19: was .eq("itinerary_version_id", …) — 42703, so the
    // map was always empty and a user's dismissal was never honoured.
    const { data: dismissedIssues, error: dismissedErr } = await supabase.from("trip_issues").select("id, issue_key, severity").eq("trip_id", trip_id).eq("status", "DISMISSED");
    if (dismissedErr) {
      // Proceeding with an empty map would silently re-open issues the
      // traveller has already dismissed. Refuse instead.
      console.error("[detect-trip-issues] DISMISSED lookup failed:", dismissedErr.message);
      return new Response(JSON.stringify({
        error: "Could not read dismissed issues",
        detail: dismissedErr.message
      }), {
        status: 500,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/json"
        }
      });
    }
    const severityRank = {
      INFO: 0,
      LOW: 1,
      MEDIUM: 2,
      HIGH: 3,
      CRITICAL: 4
    };
    const dismissedMap = new Map((dismissedIssues || []).map((d)=>[
        d.issue_key,
        {
          id: d.id,
          severity: d.severity
        }
      ]));
    // Upsert new issues
    const upsertedIssues = [];
    const writeFailures = [];
    for (const issue of aiIssues){
      const dismissed = dismissedMap.get(issue.issue_key);
      if (dismissed) {
        // Re-open DISMISSED issue only if new severity is HIGHER than when dismissed
        const oldRank = severityRank[dismissed.severity] ?? 0;
        const newRank = severityRank[issue.severity] ?? 0;
        if (newRank > oldRank) {
          // Severity escalated — re-open
          const { data: updated, error: reopenErr } = await supabase.from("trip_issues").update({
            status: "OPEN",
            severity: issue.severity,
            category: issue.category,
            issue_type: issue.issue_type,
            title: issue.title,
            short_description: issue.short_description,
            detailed_explanation: issue.detailed_explanation,
            impact: issue.impact,
            recommended_action: issue.recommended_action,
            affected_days: issue.affected_days || [],
            source_system: issue.source_system,
            confidence: issue.confidence,
            fixable_by: issue.fixable_by,
            change_plan_prompt: issue.change_plan_prompt,
            priority_rank: issue.priority_rank,
            version_id,
            updated_at: new Date().toISOString()
          }).eq("id", dismissed.id).select().single();
          if (reopenErr) {
            console.error(`[detect-trip-issues] re-open of ${issue.issue_key} failed:`, reopenErr.message);
            writeFailures.push(`reopen ${issue.issue_key}: ${reopenErr.message}`);
          } else if (updated) {
            upsertedIssues.push(updated);
          }
        }
        continue;
      }
      // Check for existing non-dismissed issue.
      // COLUMN FIX 2026-09-19: was .eq("itinerary_version_id", …) — 42703, so
      // this always "found nothing" and every run took the INSERT path below.
      const { data: existing, error: existingErr } = await supabase.from("trip_issues").select("id, status").eq("trip_id", trip_id).eq("issue_key", issue.issue_key).not("status", "eq", "DISMISSED").order("updated_at", {
        ascending: false
      }).limit(1).maybeSingle();
      if (existingErr) {
        console.error(`[detect-trip-issues] existing-issue lookup for ${issue.issue_key} failed:`, existingErr.message);
        writeFailures.push(`lookup ${issue.issue_key}: ${existingErr.message}`);
        continue;
      }
      if (existing) {
        // Update existing (re-open if RESOLVED, update content if OPEN/ACKNOWLEDGED)
        const { data: updated, error: updateErr } = await supabase.from("trip_issues").update({
          status: "OPEN",
          severity: issue.severity,
          category: issue.category,
          issue_type: issue.issue_type,
          title: issue.title,
          short_description: issue.short_description,
          detailed_explanation: issue.detailed_explanation,
          impact: issue.impact,
          recommended_action: issue.recommended_action,
          affected_days: issue.affected_days || [],
          source_system: issue.source_system,
          confidence: issue.confidence,
          fixable_by: issue.fixable_by,
          change_plan_prompt: issue.change_plan_prompt,
          priority_rank: issue.priority_rank,
          version_id,
          updated_at: new Date().toISOString()
        }).eq("id", existing.id).select().single();
        if (updateErr) {
          console.error(`[detect-trip-issues] update of ${issue.issue_key} failed:`, updateErr.message);
          writeFailures.push(`update ${issue.issue_key}: ${updateErr.message}`);
        } else if (updated) {
          upsertedIssues.push(updated);
        }
      } else {
        // Insert new.
        // COLUMN FIX 2026-09-19: the payload carried
        // `itinerary_version_id: itinerary_id`, which does not exist on
        // trip_issues, so EVERY insert failed with 42703 and the error was
        // discarded. The row already carries `itinerary_id`; `version_id` is
        // the separate FK to itinerary_versions and is taken from the
        // generated_itineraries row, which does have a `version_id` column.
        const { data: inserted, error: insertErr } = await supabase.from("trip_issues").insert({
          trip_id,
          itinerary_id: null,
          version_id,
          user_id,
          issue_key: issue.issue_key,
          severity: issue.severity,
          category: issue.category,
          issue_type: issue.issue_type,
          title: issue.title,
          short_description: issue.short_description,
          detailed_explanation: issue.detailed_explanation,
          impact: issue.impact,
          recommended_action: issue.recommended_action,
          affected_days: issue.affected_days || [],
          source_system: issue.source_system,
          confidence: issue.confidence,
          fixable_by: issue.fixable_by,
          change_plan_prompt: issue.change_plan_prompt,
          priority_rank: issue.priority_rank,
          status: "OPEN"
        }).select().single();
        if (insertErr) {
          console.error(`[detect-trip-issues] insert of ${issue.issue_key} failed:`, insertErr.message);
          writeFailures.push(`insert ${issue.issue_key}: ${insertErr.message}`);
        } else if (inserted) {
          upsertedIssues.push(inserted);
        }
      }
    }
    // If the model produced issues and NOT ONE of them could be written, the
    // caller must not be told "0 issues" with HTTP 200 — that is precisely the
    // shape this function returned for the whole time the column name was
    // wrong.
    if (aiIssues.length > 0 && upsertedIssues.length === 0 && writeFailures.length > 0) {
      return new Response(JSON.stringify({
        error: "Detected issues could not be saved",
        detail: writeFailures.slice(0, 5)
      }), {
        status: 500,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/json"
        }
      });
    }
    const criticalCount = upsertedIssues.filter((i)=>i.severity === "CRITICAL").length;
    const highCount = upsertedIssues.filter((i)=>i.severity === "HIGH").length;
    return new Response(JSON.stringify({
      issues: upsertedIssues,
      total_count: upsertedIssues.length,
      critical_count: criticalCount,
      high_count: highCount,
      previous_issue_count: previousIssueCount,
      resolved_count: resolvedCount,
      version_id,
      write_failures: writeFailures.length > 0 ? writeFailures : undefined
    }), {
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/json"
      }
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[detect-trip-issues] Error:", message);
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

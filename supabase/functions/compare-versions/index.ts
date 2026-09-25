// ITINERARY RECONCILIATION 2026-09-24 — compare-versions understands both
// snapshot formats in itinerary_versions.itinerary_snapshot:
//   - FLAT (current): an array of itinerary_items rows, written by change-plan
//     and the itinerary_* RPCs. Diffed by item id: added / removed / changed,
//     where "changed" compares title, date, start_time, end_time and location.
//     The result is returned as `item_diff`, and ALSO folded into the existing
//     `day_diffs` shape (days by date, day_number from trips.start_date, times
//     as local HH:MM in trips.primary_tz) so current clients keep rendering.
//   - LEGACY (days array with activities, from generated_itineraries): the
//     original title-based day diff, unchanged.
// When one side is flat and the other legacy, the formats cannot be matched
// item-by-item: day_diffs is empty, item_diff is null, and
// `comparable: false` + `note` say so instead of reporting "no differences".
// New response keys: snapshot_format_a / snapshot_format_b, item_diff,
// comparable, note. Access rules are unchanged (creator-only versions).
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
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
/** Same test the itinerary_restore_version RPC uses to refuse legacy snapshots. */ function snapshotFormat(snap) {
  if (!Array.isArray(snap)) return "unknown";
  if (snap.length === 0) return "empty";
  const flat = snap.every((x)=>x && typeof x === "object" && !Array.isArray(x) && "id" in x && "title" in x && !("activities" in x));
  if (flat) return "flat";
  const legacy = snap.every((x)=>x && typeof x === "object" && !Array.isArray(x) && ("activities" in x || "day_number" in x));
  return legacy ? "legacy_days" : "unknown";
}
const COMPARED_FIELDS = [
  "title",
  "date",
  "start_time",
  "end_time",
  "location"
];
function sameInstant(a, b) {
  if (a == null || b == null) return a == b;
  const ta = Date.parse(String(a).replace(" ", "T"));
  const tb = Date.parse(String(b).replace(" ", "T"));
  if (!isNaN(ta) && !isNaN(tb)) return ta === tb;
  return String(a) === String(b);
}
function itemBrief(it, tz) {
  return {
    id: it.id,
    title: it.title ?? null,
    date: it.date ?? localParts(it.start_time, tz)?.date ?? null,
    start: itemLocalTime(it, tz),
    end: itemLocalTime(it, tz, "end_time"),
    location: it.location ?? null
  };
}
function diffFlat(a, b, tz) {
  const mapA = new Map(a.map((it)=>[
      String(it.id),
      it
    ]));
  const mapB = new Map(b.map((it)=>[
      String(it.id),
      it
    ]));
  const added = b.filter((it)=>!mapA.has(String(it.id))).map((it)=>itemBrief(it, tz));
  const removed = a.filter((it)=>!mapB.has(String(it.id))).map((it)=>itemBrief(it, tz));
  const changed = [];
  for (const itB of b){
    const itA = mapA.get(String(itB.id));
    if (!itA) continue;
    const changes = {};
    for (const f of COMPARED_FIELDS){
      const va = itA[f] ?? null;
      const vb = itB[f] ?? null;
      const equal = f === "start_time" || f === "end_time" ? sameInstant(va, vb) : va === vb;
      if (!equal) {
        changes[f] = f === "start_time" || f === "end_time" ? {
          from: itemLocalTime(itA, tz, f) ?? va,
          to: itemLocalTime(itB, tz, f) ?? vb
        } : {
          from: va,
          to: vb
        };
      }
    }
    if (Object.keys(changes).length > 0) {
      changed.push({
        id: String(itB.id),
        title: itB.title ?? itA.title ?? null,
        changes
      });
    }
  }
  return {
    added,
    removed,
    changed
  };
}
serve(async (req)=>{
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: CORS_HEADERS
    });
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  try {
    // Auth check
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({
        error: "Missing authorization header"
      }), {
        status: 401,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/json"
        }
      });
    }
    const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY") || SUPABASE_SERVICE_ROLE_KEY, {
      global: {
        headers: {
          Authorization: authHeader
        }
      }
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({
        error: "Unauthorized"
      }), {
        status: 401,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/json"
        }
      });
    }
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
    const { version_id_a, version_id_b } = body;
    if (!version_id_a || !version_id_b) {
      return new Response(JSON.stringify({
        error: "version_id_a and version_id_b are required"
      }), {
        status: 400,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/json"
        }
      });
    }
    // Fetch both versions — verify user owns both
    const [{ data: versionA, error: errA }, { data: versionB, error: errB }] = await Promise.all([
      supabase.from("itinerary_versions").select("*").eq("id", version_id_a).eq("user_id", user.id).single(),
      supabase.from("itinerary_versions").select("*").eq("id", version_id_b).eq("user_id", user.id).single()
    ]);
    if (errA || !versionA) {
      return new Response(JSON.stringify({
        error: "Version A not found or access denied"
      }), {
        status: 404,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/json"
        }
      });
    }
    if (errB || !versionB) {
      return new Response(JSON.stringify({
        error: "Version B not found or access denied"
      }), {
        status: 404,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/json"
        }
      });
    }
    const formatA = snapshotFormat(versionA.itinerary_snapshot);
    const formatB = snapshotFormat(versionB.itinerary_snapshot);
    const isFlatish = (f)=>f === "flat" || f === "empty";
    const isLegacyish = (f)=>f === "legacy_days" || f === "empty";
    let dayDiffs = [];
    let itemDiff = null;
    let comparable = true;
    let note = null;
    if (isFlatish(formatA) && isFlatish(formatB) && (formatA === "flat" || formatB === "flat")) {
      // ── Flat snapshots: diff by item id ───────────────────────────────
      const { data: tripRow, error: tripErr } = await supabase.from("trips").select("primary_tz, start_date").eq("id", versionB.trip_id).maybeSingle();
      if (tripErr) console.error("[compare-versions] trip lookup failed:", tripErr.message);
      const tz = validTz(tripRow?.primary_tz ?? null);
      const itemsA = versionA.itinerary_snapshot || [];
      const itemsB = versionB.itinerary_snapshot || [];
      itemDiff = diffFlat(itemsA, itemsB, tz);
      // Fold into the legacy day_diffs shape, keyed by date.
      const daysOfA = itemsToDays(itemsA, tz, tripRow?.start_date ?? null);
      const daysOfB = itemsToDays(itemsB, tz, tripRow?.start_date ?? null);
      const byDate = new Map();
      const dayFor = (date, n)=>{
        const key = date ?? "";
        if (!byDate.has(key)) {
          byDate.set(key, {
            day_number: n,
            date,
            activities_added: [],
            activities_removed: [],
            activities_moved: [],
            activity_count_a: daysOfA.find((d)=>d.date === date)?.items.length ?? 0,
            activity_count_b: daysOfB.find((d)=>d.date === date)?.items.length ?? 0
          });
        }
        return byDate.get(key);
      };
      const dayNumOf = (date)=>daysOfB.find((d)=>d.date === date)?.day_number ?? daysOfA.find((d)=>d.date === date)?.day_number ?? 0;
      for (const it of itemDiff.added)dayFor(it.date, dayNumOf(it.date)).activities_added.push(it.title ?? "(untitled)");
      for (const it of itemDiff.removed)dayFor(it.date, dayNumOf(it.date)).activities_removed.push(it.title ?? "(untitled)");
      for (const c of itemDiff.changed){
        const itB = itemsB.find((x)=>String(x.id) === c.id);
        const itA = itemsA.find((x)=>String(x.id) === c.id);
        const dateB = itB.date ?? localParts(itB.start_time, tz)?.date ?? null;
        const dateA = itA.date ?? localParts(itA.start_time, tz)?.date ?? null;
        if (dateA !== dateB) {
          // Moved to another day: removed from one, added to the other.
          dayFor(dateA, dayNumOf(dateA)).activities_removed.push(c.title ?? "(untitled)");
          dayFor(dateB, dayNumOf(dateB)).activities_added.push(c.title ?? "(untitled)");
        } else if (c.changes.start_time || c.changes.end_time) {
          dayFor(dateB, dayNumOf(dateB)).activities_moved.push({
            title: c.title ?? "(untitled)",
            old_time: itemLocalTime(itA, tz) ?? "",
            new_time: itemLocalTime(itB, tz) ?? ""
          });
        }
      }
      dayDiffs = [
        ...byDate.values()
      ].sort((x, y)=>String(x.date ?? "~").localeCompare(String(y.date ?? "~")));
    } else if (isLegacyish(formatA) && isLegacyish(formatB)) {
      // ── Legacy day-array snapshots: original title-based diff ─────────
      const daysA = versionA.itinerary_snapshot || [];
      const daysB = versionB.itinerary_snapshot || [];
      const legacyDiffs = [];
      {
        // Build day maps
        const dayMapA = new Map();
        const dayMapB = new Map();
        for (const d of daysA)if (d.day_number) dayMapA.set(d.day_number, d);
        for (const d of daysB)if (d.day_number) dayMapB.set(d.day_number, d);
        const allDayNumbers = new Set([
          ...dayMapA.keys(),
          ...dayMapB.keys()
        ]);
        const dayDiffs = [];
        for (const dayNum of Array.from(allDayNumbers).sort((a, b)=>a - b)){
          const dayA = dayMapA.get(dayNum);
          const dayB = dayMapB.get(dayNum);
          const activitiesA = dayA?.activities || [];
          const activitiesB = dayB?.activities || [];
          // Build title->time maps
          const titlesA = new Map();
          const titlesB = new Map();
          for (const a of activitiesA)if (a.title) titlesA.set(a.title, a.time || "");
          for (const a of activitiesB)if (a.title) titlesB.set(a.title, a.time || "");
          const added = [];
          const removed = [];
          const moved = [];
          // Activities in B but not A = added
          for (const [title, time] of titlesB){
            if (!titlesA.has(title)) {
              added.push(title);
            } else {
              // Both have it — check if time changed
              const oldTime = titlesA.get(title) || "";
              if (oldTime !== time && (oldTime || time)) {
                moved.push({
                  title,
                  old_time: oldTime,
                  new_time: time
                });
              }
            }
          }
          // Activities in A but not B = removed
          for (const [title] of titlesA){
            if (!titlesB.has(title)) {
              removed.push(title);
            }
          }
          const hasDiff = added.length > 0 || removed.length > 0 || moved.length > 0 || activitiesA.length !== activitiesB.length;
          if (hasDiff) {
            dayDiffs.push({
              day_number: dayNum,
              activities_added: added,
              activities_removed: removed,
              activities_moved: moved,
              activity_count_a: activitiesA.length,
              activity_count_b: activitiesB.length
            });
          }
        }
        legacyDiffs.push(...dayDiffs);
      }
      dayDiffs = legacyDiffs;
    } else {
      comparable = false;
      note = `These versions were saved in different formats (${formatA} vs ${formatB}), so their activities can't be compared item by item.`;
    }
    // Budget diff
    const budgetA = versionA.budget_snapshot;
    const budgetB = versionB.budget_snapshot;
    let budgetDiff = null;
    if (budgetA || budgetB) {
      const totalA = budgetA?.total_projected_cost ?? null;
      const totalB = budgetB?.total_projected_cost ?? null;
      budgetDiff = {
        total_a: totalA,
        total_b: totalB,
        change: totalA !== null && totalB !== null ? totalB - totalA : null,
        currency: budgetA?.currency || budgetB?.currency || "USD"
      };
    }
    // Pace diff
    const paceA = versionA.pace_snapshot;
    const paceB = versionB.pace_snapshot;
    let paceDiff = null;
    if (paceA || paceB) {
      paceDiff = {
        overall_pace_a: paceA?.overall_pace ?? null,
        overall_pace_b: paceB?.overall_pace ?? null,
        busy_days_a: paceA?.busy_days ?? 0,
        busy_days_b: paceB?.busy_days ?? 0,
        walking_a: null,
        walking_b: null
      };
    }
    // Geo diff
    const geoA = versionA.geo_snapshot;
    const geoB = versionB.geo_snapshot;
    let geoDiff = null;
    if (geoA || geoB) {
      geoDiff = {
        score_a: geoA?.overall_geo_score_after ?? null,
        score_b: geoB?.overall_geo_score_after ?? null
      };
    }
    const hasDifferences = dayDiffs.length > 0 || itemDiff !== null && itemDiff.added.length + itemDiff.removed.length + itemDiff.changed.length > 0 || budgetDiff?.change !== null && budgetDiff?.change !== 0 || paceDiff?.overall_pace_a !== paceDiff?.overall_pace_b;
    return new Response(JSON.stringify({
      version_a: {
        version_number: versionA.version_number,
        version_name: versionA.version_name,
        created_at: versionA.created_at
      },
      version_b: {
        version_number: versionB.version_number,
        version_name: versionB.version_name,
        created_at: versionB.created_at
      },
      snapshot_format_a: formatA,
      snapshot_format_b: formatB,
      comparable,
      note,
      item_diff: itemDiff,
      day_diffs: dayDiffs,
      budget_diff: budgetDiff,
      pace_diff: paceDiff,
      geo_diff: geoDiff,
      has_differences: hasDifferences
    }), {
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/json"
      }
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[compare-versions] Error:", message);
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

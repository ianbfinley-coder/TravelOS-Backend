// SECURITY 2026-09-17 — Three defects:
//
// 1. /solve and /apply checked trip membership with
//    `trip_members.eq('trip_id', tripId).eq('user_id', user.id)`, comparing
//    the Supabase auth uuid (`user.id`) directly against `trip_members.user_id`,
//    which is a TEXT column holding platform_users.id — a different id space
//    entirely (confirmed against information_schema.columns; see
//    _shared/auth.ts's note on the two id systems). A raw auth uuid can never
//    equal a platform_users.id string, so this check has denied every real
//    caller unconditionally — /solve and /apply have never succeeded for
//    anyone. Fixed by bridging through `resolvePlatformUserId` (which matches
//    on `auth_identities.provider_subject`, the documented correct join)
//    before checking trip_members.
//
// 2. GET /cached took a bare `tripId` query parameter and returned that trip's
//    cached replan alternatives — including day plans, itinerary ops, and
//    drafted messages to hotels/restaurants/tour operators with names and
//    booking references — to ANY authenticated caller, with no membership
//    check at all. Fixed by applying the same membership check as /solve and
//    /apply before returning cached data.
//
// 3. CORRECTION 2026-09-19 — the note that stood here was FALSE. It claimed
//    `itinerary_items` "does not exist in this database (confirmed against
//    information_schema.tables)" and that every solve() had therefore run
//    against zero tasks. The table does exist, with 34 columns (re-confirmed
//    2026-09-19 against information_schema.columns: id, trip_id, title, type,
//    category, status, date, start_time, end_time, timezone, duration_min,
//    location, notes, country_code, transport_mode, party_size, place_id,
//    lat, lng, windows, fixed, fixed_start, outdoor, must_do, starred,
//    suggested, droppable, critical, hold_minutes, energy_cost, member_ids,
//    cancellation, created_at, updated_at). That false note is why the real
//    defects in this file went unexamined for two days. The ones found and
//    fixed on 2026-09-19 are marked "CORRECTION 2026-09-19" at each site:
//    a reservations query against three columns that do not exist; drafted
//    messages to real businesses carrying an internal uuid as a "booking
//    reference", an invented party size and a hardcoded UTC time; an /apply
//    loop that discarded every write result and always answered
//    `{applied: true}`; an unchecked `baseVersion`; a fabricated enjoyment
//    score fed to the objective function; a constant presented as a measured
//    energy budget; weather defaults that silently disabled the outdoor
//    constraint; and a set of discarded query errors that turned failures
//    into cheerful empty results.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { corsHeaders, resolvePlatformUserId } from './_shared/auth.ts';
// ─── ULID-lite ──────────
function ulid(prefix = '') {
  const t = Date.now().toString(36).padStart(8, '0');
  const r = Math.random().toString(36).slice(2, 12).padStart(10, '0');
  return `${prefix}${t}${r}`;
}
// ─── Haversine ────────────
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function travelMinutes(t1, t2) {
  if (!t1 || !t2) return 0;
  if (t1.placeId && t1.placeId === t2.placeId) return 0;
  if (t1.lat != null && t1.lng != null && t2.lat != null && t2.lng != null) {
    const km = haversineKm(t1.lat, t1.lng, t2.lat, t2.lng);
    return Math.ceil(km / 5 * 60) + 10;
  }
  return 20; // default buffer when no coords
}
// ─── Time helpers ────────────────
function toMs(iso) {
  return new Date(iso).getTime();
}
function msToIso(ms) {
  return new Date(ms).toISOString();
}
function dayStartMs(dateStr) {
  // 08:30 local approximated as UTC (no tz info available)
  return new Date(`${dateStr}T08:30:00Z`).getTime();
}
function dayEndMs(dateStr) {
  // 22:30 local (23:00 - 30 min)
  return new Date(`${dateStr}T22:30:00Z`).getTime();
}
// ─── Objective function ────────────────
function objective(scheduled, taskMap, baseline, config) {
  const baselineIds = new Set(baseline.map((s)=>s.taskId));
  const scheduledIds = new Set(scheduled.map((s)=>s.taskId));
  let score = 0;
  // Enjoyment × priority
  // CORRECTION 2026-09-19 — this term used to run on a fabricated enjoyment:
  // when happiness-prediction returned nothing, `enjoyment.mean` had been set
  // to the item's own `priority` (0.5/1/2/3) and scored as if it were a
  // predicted enjoyment on a 1–5 scale, which made the term `priority²`.
  // An unknown enjoyment is now excluded from the objective entirely.
  for (const s of scheduled){
    const t = taskMap.get(s.taskId);
    if (!t) continue;
    if (!t.enjoyment.known) continue;
    score += t.priority * t.enjoyment.mean;
  }
  // Travel time penalty
  const sorted = [
    ...scheduled
  ].sort((a, b)=>toMs(a.start) - toMs(b.start));
  let totalTravel = 0;
  for(let i = 1; i < sorted.length; i++){
    const prev = taskMap.get(sorted[i - 1].taskId);
    const curr = taskMap.get(sorted[i].taskId);
    totalTravel += travelMinutes(prev ?? null, curr ?? null);
  }
  score -= 0.02 * totalTravel;
  // Changed count penalty
  let changedCount = 0;
  for (const s of scheduled){
    const orig = baseline.find((b)=>b.taskId === s.taskId);
    if (!orig) {
      changedCount += 1; // added
    } else if (orig.start !== s.start) {
      changedCount += 1; // moved
    }
  }
  for (const b of baseline){
    if (!scheduledIds.has(b.taskId)) changedCount += 2; // dropped
  }
  score -= config.stabilityWeight * 0.5 * changedCount;
  // Dropped must-do penalty
  for (const b of baseline){
    if (!scheduledIds.has(b.taskId)) {
      const t = taskMap.get(b.taskId);
      if (t) score -= 3 * t.priority;
    }
  }
  // Cancellation fee penalty
  for (const b of baseline){
    if (!scheduledIds.has(b.taskId)) {
      const t = taskMap.get(b.taskId);
      if (t?.cancellation?.fee) {
        score -= t.cancellation.fee.amountMinor / 1000;
      }
    }
  }
  // Energy penalty
  let totalEnergy = 0;
  for (const s of scheduled){
    const t = taskMap.get(s.taskId);
    if (t) totalEnergy += t.energyCost;
  }
  const energyRatio = totalEnergy / config.energyBudget;
  score -= 1.5 * Math.max(0, energyRatio - 0.9);
  return score;
}
// ─── Constraint checks ────────────────
function inWindow(task, startMs, endMs) {
  if (task.windows.length === 0) return true;
  return task.windows.some((w)=>startMs >= toMs(w.start) && endMs <= toMs(w.end));
}
function hasOverlap(scheduled, taskMap, newTask, newStart, newEnd) {
  for (const s of scheduled){
    const t = taskMap.get(s.taskId);
    if (!t) continue;
    // Check member overlap. Defensive `?? []`: memberIds is now always populated
    // at Task-construction time (see CORRECTION 2026-09-21 above), but this
    // guards the one place that actually crashed rather than trusting every
    // caller of hasOverlap() to have gone through that path.
    const sharedMembers = (newTask.memberIds ?? []).filter((m)=>(t.memberIds ?? []).includes(m));
    if (sharedMembers.length === 0) continue;
    const sStart = toMs(s.start);
    const sEnd = toMs(s.end);
    const travel = travelMinutes(t, newTask) * 60 * 1000;
    // Overlap or insufficient travel gap
    if (newStart < sEnd + travel && newEnd > sStart - travel) return true;
  }
  return false;
}
function feasible(task, startMs, durationMs, scheduled, taskMap, config, dateStr) {
  const endMs = startMs + durationMs;
  const dayStart = dayStartMs(dateStr);
  const dayEnd = dayEndMs(dateStr);
  if (startMs < dayStart || endMs > dayEnd) return false;
  if (!inWindow(task, startMs, endMs)) return false;
  if (hasOverlap(scheduled, taskMap, task, startMs, endMs)) return false;
  // Outdoor constraint
  if (task.outdoor && config.weather) {
    if (config.weather.precipPct >= 40 || config.weather.severeAlert) return false;
  }
  return true;
}
// ─── Solver ────────────
function solve(tasks, schedule, config, dateStr, annealBudgetMs) {
  const taskMap = new Map(tasks.map((t)=>[
      t.id,
      t
    ]));
  const SLOT_MS = 15 * 60 * 1000; // 15-min slots
  const dayStart = dayStartMs(dateStr);
  const dayEnd = dayEndMs(dateStr);
  // Step 1: Seed — place fixed tasks
  let current = [];
  const unplaced = [];
  for (const task of tasks){
    if (config.locks.includes(task.id)) {
      const orig = schedule.find((s)=>s.taskId === task.id);
      if (orig) {
        current.push({
          ...orig
        });
        continue;
      }
    }
    if (task.fixed && task.fixedStart) {
      const startMs = toMs(task.fixedStart);
      const endMs = startMs + task.durationMin * 60 * 1000;
      current.push({
        taskId: task.id,
        start: msToIso(startMs),
        end: msToIso(endMs)
      });
    } else {
      unplaced.push(task);
    }
  }
  // Step 2: Greedy insertion — sort by priority × enjoyment desc.
  // CORRECTION 2026-09-19 — where enjoyment is unknown this ranks on priority
  // alone rather than on a stand-in enjoyment value. This is an ordering
  // heuristic only; no number produced here reaches the objective or the user.
  const rank = (t)=>t.enjoyment.known ? t.priority * t.enjoyment.mean : t.priority;
  const sorted = [
    ...unplaced
  ].sort((a, b)=>rank(b) - rank(a));
  let optionalDropped = 0;
  for (const task of sorted){
    if (task.droppable && optionalDropped >= config.maxOptionalDrop) continue;
    let bestStart = -1;
    let bestCost = Infinity;
    // Try each 15-min slot in the day
    for(let t = dayStart; t + task.minDurationMin * 60 * 1000 <= dayEnd; t += SLOT_MS){
      const dur = task.durationMin * 60 * 1000;
      if (!feasible(task, t, dur, current, taskMap, config, dateStr)) continue;
      // Cost = travel from previous task
      const sortedCurrent = [
        ...current
      ].sort((a, b)=>toMs(a.start) - toMs(b.start));
      const prevTask = sortedCurrent.filter((s)=>toMs(s.end) <= t).pop();
      const prevT = prevTask ? taskMap.get(prevTask.taskId) : null;
      const cost = travelMinutes(prevT ?? null, task);
      if (cost < bestCost) {
        bestCost = cost;
        bestStart = t;
      }
    }
    if (bestStart >= 0) {
      const dur = task.durationMin * 60 * 1000;
      current.push({
        taskId: task.id,
        start: msToIso(bestStart),
        end: msToIso(bestStart + dur)
      });
    } else if (task.droppable) {
      optionalDropped++;
    }
  }
  // Step 3: Local search with simulated annealing
  const deadline = Date.now() + annealBudgetMs;
  let best = [
    ...current
  ];
  let bestScore = objective(best, taskMap, schedule, config);
  let T = 1.0;
  let iter = 0;
  while(Date.now() < deadline){
    iter++;
    if (iter % 50 === 0) T *= 0.95;
    const candidate = [
      ...best
    ];
    const move = Math.floor(Math.random() * 4);
    if (move === 0 && candidate.length > 0) {
      // Relocate a random task
      const idx = Math.floor(Math.random() * candidate.length);
      const task = taskMap.get(candidate[idx].taskId);
      if (!task || task.fixed || config.locks.includes(task.id)) continue;
      const others = candidate.filter((_, i)=>i !== idx);
      let newStart = -1;
      for(let t = dayStart; t + task.minDurationMin * 60 * 1000 <= dayEnd; t += SLOT_MS){
        if (feasible(task, t, task.durationMin * 60 * 1000, others, taskMap, config, dateStr)) {
          newStart = t;
          break;
        }
      }
      if (newStart < 0) continue;
      candidate[idx] = {
        taskId: task.id,
        start: msToIso(newStart),
        end: msToIso(newStart + task.durationMin * 60 * 1000)
      };
    } else if (move === 1 && candidate.length >= 2) {
      // Swap two tasks' times
      const i = Math.floor(Math.random() * candidate.length);
      const j = Math.floor(Math.random() * candidate.length);
      if (i === j) continue;
      const ti = taskMap.get(candidate[i].taskId);
      const tj = taskMap.get(candidate[j].taskId);
      if (!ti || !tj || ti.fixed || tj.fixed) continue;
      if (config.locks.includes(ti.id) || config.locks.includes(tj.id)) continue;
      const tmpStart = candidate[i].start;
      const tmpEnd = candidate[i].end;
      candidate[i] = {
        ...candidate[i],
        start: candidate[j].start,
        end: candidate[j].end
      };
      candidate[j] = {
        ...candidate[j],
        start: tmpStart,
        end: tmpEnd
      };
    } else if (move === 2 && candidate.length > 0) {
      // Shorten a flexible task
      const idx = Math.floor(Math.random() * candidate.length);
      const task = taskMap.get(candidate[idx].taskId);
      if (!task || task.fixed) continue;
      const minDur = task.minDurationMin * 60 * 1000;
      const curDur = toMs(candidate[idx].end) - toMs(candidate[idx].start);
      if (curDur <= minDur) continue;
      const newDur = Math.max(minDur, curDur - 15 * 60 * 1000);
      candidate[idx] = {
        ...candidate[idx],
        end: msToIso(toMs(candidate[idx].start) + newDur)
      };
    } else if (move === 3) {
      // Drop a droppable task
      const droppable = candidate.filter((s)=>{
        const t = taskMap.get(s.taskId);
        return t?.droppable && !config.locks.includes(s.taskId);
      });
      if (droppable.length === 0) continue;
      const idx = Math.floor(Math.random() * droppable.length);
      const toRemove = droppable[idx].taskId;
      candidate.splice(candidate.findIndex((s)=>s.taskId === toRemove), 1);
    }
    const newScore = objective(candidate, taskMap, schedule, config);
    const delta = newScore - bestScore;
    if (delta > 0 || Math.random() < Math.exp(delta / T)) {
      best = candidate;
      bestScore = newScore;
    }
  }
  return best;
}
// ─── Build ops from diff ────────────────
function buildOps(baseline, result) {
  const ops = [];
  const baseMap = new Map(baseline.map((s)=>[
      s.taskId,
      s
    ]));
  const resultMap = new Map(result.map((s)=>[
      s.taskId,
      s
    ]));
  for (const s of result){
    const orig = baseMap.get(s.taskId);
    if (!orig) {
      ops.push({
        kind: 'add',
        itemId: s.taskId,
        after: s
      });
    } else if (orig.start !== s.start || orig.end !== s.end) {
      ops.push({
        kind: 'move',
        itemId: s.taskId,
        before: orig,
        after: s
      });
    }
  }
  for (const b of baseline){
    if (!resultMap.has(b.taskId)) {
      ops.push({
        kind: 'remove',
        itemId: b.taskId,
        before: b
      });
    }
  }
  return ops;
}
// ─── Conflict detection ────────────────────
function detectConflicts(schedule, taskMap, weather) {
  const conflicts = [];
  const sorted = [
    ...schedule
  ].sort((a, b)=>toMs(a.start) - toMs(b.start));
  for(let i = 0; i < sorted.length; i++){
    for(let j = i + 1; j < sorted.length; j++){
      const a = sorted[i];
      const b = sorted[j];
      const ta = taskMap.get(a.taskId);
      const tb = taskMap.get(b.taskId);
      if (!ta || !tb) continue;
      // Defensive `?? []` — same reasoning as hasOverlap() above.
      const sharedMembers = (ta.memberIds ?? []).filter((m)=>(tb.memberIds ?? []).includes(m));
      if (sharedMembers.length === 0) continue;
      if (toMs(a.end) > toMs(b.start)) {
        conflicts.push({
          kind: 'overlap',
          severity: 'error',
          message: `"${ta.title}" overlaps with "${tb.title}"`,
          itemIds: [
            a.taskId,
            b.taskId
          ]
        });
      }
    }
    // Outdoor weather check
    const task = taskMap.get(sorted[i].taskId);
    if (task?.outdoor && weather && (weather.precipPct >= 40 || weather.severeAlert)) {
      conflicts.push({
        kind: 'weather',
        severity: 'warning',
        message: `"${task.title}" is outdoors but weather is unfavorable`,
        itemIds: [
          sorted[i].taskId
        ]
      });
    }
  }
  return conflicts;
}
// ─── Explanation generator ────────────────
// CORRECTION 2026-09-19 — this rendered move times with a hardcoded
// `timeZone: 'UTC'`, exactly as the provider drafts did, so a traveller in
// Tokyo was told their activity "moves to 6:00 AM" when it moves to 3:00 PM
// local. The zone is now passed in (itinerary item / trip primary_tz) and,
// where it is genuinely unknown, the explanation says so instead of quoting
// a UTC time as if it were local.
function generateExplanation(ops, taskMap, label, tz) {
  const moves = ops.filter((o)=>o.kind === 'move');
  const drops = ops.filter((o)=>o.kind === 'remove');
  const adds = ops.filter((o)=>o.kind === 'add');
  if (ops.length === 0) return 'No changes needed — the current plan is already optimal.';
  const parts = [];
  if (moves.length > 0) {
    const names = moves.slice(0, 2).map((o)=>{
      const t = taskMap.get(o.itemId);
      let newTime = 'a new time';
      if (o.after?.start) {
        if (tz) {
          try {
            newTime = new Date(o.after.start).toLocaleTimeString('en-US', {
              hour: 'numeric',
              minute: '2-digit',
              hour12: true,
              timeZone: tz
            });
          } catch  {
            newTime = 'a new time (local time unavailable — unknown timezone)';
          }
        } else {
          newTime = 'a new time (no timezone recorded for this trip, so the local time cannot be shown)';
        }
      }
      return t ? `moves "${t.title}" to ${newTime}` : null;
    }).filter(Boolean);
    if (names.length) parts.push(names.join(' and '));
  }
  if (drops.length > 0) {
    const names = drops.slice(0, 2).map((o)=>{
      const t = taskMap.get(o.itemId);
      return t ? `drops "${t.title}" (${t.priority < 1 ? 'low priority' : 'to free energy'})` : null;
    }).filter(Boolean);
    if (names.length) parts.push(names.join(' and '));
  }
  if (adds.length > 0) {
    const names = adds.slice(0, 1).map((o)=>{
      const t = taskMap.get(o.itemId);
      return t ? `adds "${t.title}"` : null;
    }).filter(Boolean);
    if (names.length) parts.push(names.join(' and '));
  }
  const sentence = parts.length > 0 ? parts.join('; ') + '.' : `Applies ${ops.length} change(s) to improve the day.`;
  const suffix = label === 'Minimal change' ? ' Keeps disruption to a minimum.' : label === 'Relaxed' ? ' Reduces energy load for a more comfortable day.' : ' Optimises for the best overall experience.';
  return sentence.charAt(0).toUpperCase() + sentence.slice(1) + suffix;
}
/** Wall-clock date and HH:MM for an instant, in a named zone. */ function localParts(iso, tz) {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }).formatToParts(d).map((x)=>[
        x.type,
        x.value
      ]));
    if (!parts.year || !parts.hour) return null;
    return {
      date: `${parts.year}-${parts.month}-${parts.day}`,
      time: `${parts.hour}:${parts.minute}`
    };
  } catch  {
    // An unknown IANA zone throws here; the caller reports it rather than
    // falling back to UTC.
    return null;
  }
}
/** Normalise a postgres `time` value ("19:30:00", "19:30") to HH:MM. */ function hhmm(t) {
  const m = /^(\d{2}):(\d{2})/.exec(t.trim());
  return m ? `${m[1]}:${m[2]}` : null;
}
/** Render an instant for a human, in a named zone, or return null if unknown. */ function formatInZone(iso, tz) {
  if (!tz) return null;
  try {
    return new Date(iso).toLocaleString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: tz
    });
  } catch  {
    return null;
  }
}
/**
 * Link reservations to itinerary items on (trip_id, date, local start time).
 * Returns only unambiguous matches; everything else is reported as a reason.
 */ function linkReservations(items, reservations, tripTz) {
  const byItemId = new Map();
  const problems = new Map();
  for (const item of items){
    const itemId = item.id;
    const iso = item.start_time;
    const date = item.date;
    if (!iso || !date) continue; // unscheduled item — nothing to contact about
    const tz = item.timezone ?? tripTz;
    if (!tz) {
      problems.set(itemId, 'no timezone on the itinerary item and no trips.primary_tz, so its local start time cannot be compared against reservations.start_time');
      continue;
    }
    const local = localParts(iso, tz);
    if (!local) {
      problems.set(itemId, `could not render start_time in timezone "${tz}"`);
      continue;
    }
    const candidates = reservations.filter((r)=>{
      if (r.start_date !== date) return false;
      if (!r.start_time) return false;
      return hhmm(r.start_time) === local.time;
    });
    if (candidates.length === 1) {
      byItemId.set(itemId, candidates[0]);
    } else if (candidates.length > 1) {
      problems.set(itemId, `${candidates.length} reservations share this trip, date and start time, so the link is ambiguous — no message drafted`);
    }
  // candidates.length === 0: no reservation for this item. Not a problem.
  }
  return {
    byItemId,
    problems
  };
}
// ─── Provider message drafts ───────────────
//
// CORRECTION 2026-09-19 — these drafts are sent by a user to a real business.
// The previous version filled them with invented values:
//   `res.booking_ref ?? res.id`  → put an internal database uuid in front of a
//                                  hotel as "Booking reference"
//   `res.member_count ?? 1`      → invented the size of the party
//   `res.provider_name ?? 'the venue'`
//   `timeZone: 'UTC'`            → hardcoded, so a restaurant in Kyoto was
//                                  asked to move a booking to a UTC time
// Anything not actually known is now an explicit bracketed placeholder for
// the user to fill in, and the new time is rendered in the reservation's own
// timezone, falling back to trips.primary_tz, and otherwise stated as unknown.
function generateProviderMessages(ops, taskMap, resByItemId, linkProblems, tripTz) {
  const messages = [];
  const unmatched = [];
  const affected = ops.filter((o)=>o.kind === 'move' || o.kind === 'remove');
  for (const op of affected){
    const res = resByItemId.get(op.itemId);
    if (!res) {
      const why = linkProblems.get(op.itemId);
      if (why) unmatched.push({
        itemId: op.itemId,
        reason: why
      });
      continue;
    }
    const task = taskMap.get(op.itemId);
    const activity = task ? `"${task.title}"` : res.location_name ?? '[activity]';
    // Booking reference: the provider's own confirmation number, or a
    // placeholder. Never this system's row id — a hotel cannot look that up.
    const ref = res.confirmation_number ?? '[booking reference — please fill in]';
    const provider = res.provider_name ?? res.location_name ?? '[provider name — please fill in]';
    // Party size: the only real signal is the recorded traveler names.
    const names = Array.isArray(res.traveler_names) ? res.traveler_names.filter((n)=>typeof n === 'string' && n.trim() !== '') : [];
    const party = names.length > 0 ? `${names.length} guest(s) (${names.join(', ')})` : '[number of guests — please fill in]';
    let draft = '';
    if (op.kind === 'move' && op.after?.start) {
      const zone = res.timezone ?? tripTz;
      const newTime = formatInZone(op.after.start, zone);
      const whenLine = newTime ? `${newTime} (${zone} local time)` : `[new date and time — please fill in; the system holds ${op.after.start} as a UTC instant but no local timezone is recorded for this booking, so it cannot state the local time]`;
      draft = `Subject: Booking change request — ${ref}\n\n` + `Dear ${provider},\n\n` + `We have a reservation for ${party} for ${activity}. Due to a schedule change, ` + `we would like to move our booking to ${whenLine} if available.\n\n` + `Booking reference: ${ref}.\n\n` + `Thank you for your assistance.\n\n` + `(Please review every [bracketed] field before sending, and translate to the local language if needed.)`;
    } else if (op.kind === 'remove') {
      draft = `Subject: Booking cancellation — ${ref}\n\n` + `Dear ${provider},\n\n` + `We need to cancel our reservation (booking reference: ${ref}) for ${party} for ${activity}. ` + `We apologise for any inconvenience.\n\n` + `Thank you.\n\n` + `(Please review every [bracketed] field before sending, and translate to the local language if needed.)`;
    }
    if (draft) {
      messages.push({
        ref,
        channel: 'email',
        draft
      });
    }
  }
  const note = unmatched.length > 0 ? `${unmatched.length} changed item(s) could not be linked to a reservation, so no message was drafted for them. This is not the same as "no one to contact" — see providerMessageIssues.` : undefined;
  return {
    messages,
    unmatched,
    note
  };
}
// ─── Compute deltas ──────────────
function computeDeltas(baseline, result, ops, taskMap) {
  const baselineIds = new Set(baseline.map((s)=>s.taskId));
  const resultIds = new Set(result.map((s)=>s.taskId));
  const dropped = ops.filter((o)=>o.kind === 'remove').map((o)=>o.itemId);
  const added = ops.filter((o)=>o.kind === 'add').map((o)=>o.itemId);
  const changedCount = ops.length;
  // Travel minutes
  function totalTravel(sched) {
    const sorted = [
      ...sched
    ].sort((a, b)=>toMs(a.start) - toMs(b.start));
    let total = 0;
    for(let i = 1; i < sorted.length; i++){
      total += travelMinutes(taskMap.get(sorted[i - 1].taskId) ?? null, taskMap.get(sorted[i].taskId) ?? null);
    }
    return total;
  }
  // Enjoyment
  // CORRECTION 2026-09-19 — only calibrated predictions are summed, and
  // `calibrated` below now reports whether any were available instead of
  // being hardcoded `true`.
  function totalEnjoyment(sched) {
    return sched.reduce((sum, s)=>{
      const t = taskMap.get(s.taskId);
      return sum + (t && t.enjoyment.known ? t.enjoyment.mean : 0);
    }, 0);
  }
  const anyCalibrated = [
    ...baseline,
    ...result
  ].some((s)=>taskMap.get(s.taskId)?.enjoyment.known === true);
  // Energy
  function totalEnergy(sched) {
    return sched.reduce((sum, s)=>{
      const t = taskMap.get(s.taskId);
      return sum + (t ? t.energyCost : 0);
    }, 0);
  }
  // Fees
  let feeTotal = 0;
  let feeCurrency = 'USD';
  const deadlinesPassed = [];
  for (const op of ops){
    if (op.kind === 'remove') {
      const t = taskMap.get(op.itemId);
      if (t?.cancellation?.fee) {
        feeTotal += t.cancellation.fee.amountMinor;
        feeCurrency = t.cancellation.fee.currency;
      }
      if (t?.cancellation?.deadline) {
        if (new Date(t.cancellation.deadline) < new Date()) {
          deadlinesPassed.push(op.itemId);
        }
      }
    }
  }
  const energyBefore = totalEnergy(baseline);
  const energyAfter = totalEnergy(result);
  const maxEnergy = Math.max(energyBefore, energyAfter, 1);
  return {
    changedCount,
    dropped,
    added,
    travelMinutes: {
      before: totalTravel(baseline),
      after: totalTravel(result)
    },
    enjoyment: {
      before: totalEnjoyment(baseline),
      after: totalEnjoyment(result),
      calibrated: anyCalibrated
    },
    energyPct: {
      before: Math.round(energyBefore / maxEnergy * 100),
      after: Math.round(energyAfter / maxEnergy * 100)
    },
    fees: {
      amountMinor: feeTotal,
      currency: feeCurrency
    },
    deadlinesPassed,
    resolvesImpacts: []
  };
}
// ─── Trip membership (platform id space) ──────────────
//
// trip_members.trip_id / .user_id are TEXT columns in the platform id space
// (platform_users.id), not the Supabase auth uuid. Bridge through
// auth_identities before checking membership — see SECURITY note above.
async function requireTripMember(service, tripId, authUserId) {
  const platformUserId = await resolvePlatformUserId(service, authUserId);
  if (!platformUserId) return false;
  const { data } = await service.from('trip_members').select('id').eq('trip_id', tripId).eq('user_id', platformUserId).is('removed_at', null).maybeSingle();
  return !!data;
}
// RATE LIMITING 2026-09-20 — /solve had no limit. It is the expensive route
// in this function by a wide margin: it loads a trip's items, reservations,
// weather and enjoyment predictions, then runs solve() once per solver config
// per date — four configs across the requested dates — and writes a
// `replan_cache` row on every call. /apply is deliberately left alone: it is
// already serialised per trip by the row lock inside `replan_apply_atomic`,
// and it is not where the cost is.
//
// 10 solves per 5-minute window, per authenticated user. A traveller
// re-planning a day genuinely does it several times over — change a lock,
// solve again, compare — and ten covers that comfortably. What it does not
// cover is a script, which would want hundreds, and each one of those costs
// real solver CPU and leaves a cache row behind.
//
// Counting happens inside `public.rate_limit_hit`, which inserts and
// increments in one statement, so two concurrent solves cannot both read the
// same count and both be admitted.
//
// Deliberate choice: the limiter FAILS OPEN when the RPC itself errors, and
// says so at error level with an unmissable prefix. Failing closed would turn
// a limiter outage into a replan outage. The defect worth avoiding is failing
// open *silently*, so the log line is the point.
const RATE_LIMIT_SOLVE_MAX = 10;
const RATE_LIMIT_WINDOW_SECONDS = 300;
// Must be one of global | strict | user_quota — see rate_limit_buckets_bucket_type_check.
const RATE_LIMIT_BUCKET_TYPE = 'user_quota';
// IP RATE LIMITING 2026-09-20 (Q2.15) — the per-user /solve limit above only
// starts counting once a JWT has been verified as belonging to a real user.
// A flood of requests carrying a syntactically-valid-looking but bogus
// bearer token — or the anon/publishable key itself, which IS a valid JWT —
// never fails to parse, so each one still pays for a full
// `userClient.auth.getUser()` round trip before the per-user bucket check
// (or any route) can even run. Worse, a caller who mints many different
// garbage subjects gets a fresh per-user bucket for each one, so the
// per-user limit counts nothing against that shape of flood.
//
// This gate runs BEFORE the JWT is verified, keyed on the caller's IP alone,
// so it caps the cost of running auth verification itself rather than the
// cost of being authenticated. It applies once, at the top of the handler,
// before the route is even known — that verification is paid once per
// request regardless of which of /cached, /solve, /apply or /undo the
// caller is hitting.
//
// 100 requests per 5-minute window, per IP — deliberately generous: many
// real users can share one IP (NAT, a corporate network, mobile carrier
// CGNAT), so this is not tuned as the primary defense against one abusive
// user — the per-user /solve bucket above already is that, once a real
// identity is established. It exists so one source cannot force unlimited
// auth verifications or mint unlimited per-user buckets cheaply.
const IP_RATE_LIMIT_MAX = 100;
const IP_RATE_LIMIT_WINDOW_SECONDS = 300;
// Must be one of global | strict | user_quota — see rate_limit_buckets_bucket_type_check.
const IP_RATE_LIMIT_BUCKET_TYPE = 'strict';
// Supabase Edge Functions sit behind a gateway that sets x-forwarded-for,
// which may be a comma-separated chain (client, then any intermediate
// proxies) — the first entry is the client's own address. Falls back to a
// constant so a missing header can never throw.
function getClientIp(req) {
  const forwardedFor = req.headers.get('x-forwarded-for');
  if (!forwardedFor) return 'unknown';
  const first = forwardedFor.split(',')[0]?.trim();
  return first || 'unknown';
}
// Records one solve against the caller's bucket and reports whether it is
// within the limit. `retryAfter` is taken from the window the function
// actually used rather than hardcoded, so the two cannot drift apart and
// start telling callers to return at a meaningless time.
async function checkRateLimit(service, bucketKey) {
  const { data, error } = await service.rpc('rate_limit_hit', {
    p_bucket_key: bucketKey,
    p_bucket_type: RATE_LIMIT_BUCKET_TYPE,
    p_limit: RATE_LIMIT_SOLVE_MAX,
    p_window_seconds: RATE_LIMIT_WINDOW_SECONDS
  });
  if (error) {
    console.error('[replan-engine] RATE LIMIT NOT ENFORCED — rate_limit_hit failed:', error.message);
    return {
      allowed: true,
      retryAfter: 0
    };
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row.is_allowed !== 'boolean') {
    console.error('[replan-engine] RATE LIMIT NOT ENFORCED — rate_limit_hit returned no usable row');
    return {
      allowed: true,
      retryAfter: 0
    };
  }
  if (!row.is_allowed) {
    console.warn(`[replan-engine] rate limited ${bucketKey} at ${row.hits} solves (limit ${RATE_LIMIT_SOLVE_MAX})`);
  }
  return {
    allowed: row.is_allowed,
    retryAfter: typeof row.retry_after_seconds === 'number' ? row.retry_after_seconds : RATE_LIMIT_WINDOW_SECONDS
  };
}
// Same shape and same fail-open-loudly behavior as checkRateLimit above,
// but against the IP bucket, with a log prefix that distinguishes it from a
// per-user block in the logs.
async function checkIpRateLimit(service, bucketKey) {
  const { data, error } = await service.rpc('rate_limit_hit', {
    p_bucket_key: bucketKey,
    p_bucket_type: IP_RATE_LIMIT_BUCKET_TYPE,
    p_limit: IP_RATE_LIMIT_MAX,
    p_window_seconds: IP_RATE_LIMIT_WINDOW_SECONDS
  });
  if (error) {
    console.error('[replan-engine] RATE LIMIT NOT ENFORCED (ip) — rate_limit_hit failed:', error.message);
    return {
      allowed: true,
      retryAfter: 0
    };
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row.is_allowed !== 'boolean') {
    console.error('[replan-engine] RATE LIMIT NOT ENFORCED (ip) — rate_limit_hit returned no usable row');
    return {
      allowed: true,
      retryAfter: 0
    };
  }
  if (!row.is_allowed) {
    console.warn(`[replan-engine] IP rate limited ${bucketKey} at ${row.hits} requests (limit ${IP_RATE_LIMIT_MAX})`);
  }
  return {
    allowed: row.is_allowed,
    retryAfter: typeof row.retry_after_seconds === 'number' ? row.retry_after_seconds : IP_RATE_LIMIT_WINDOW_SECONDS
  };
}
// ─── Main handler ─────────────
Deno.serve(async (req)=>{
  // CORS preflight — must be the absolute first thing handled, before the IP
  // rate-limit gate and before auth. A preflight is a lightweight,
  // browser-automatic OPTIONS request with no Authorization header; it must
  // never be rate-limited or auth-gated, or the browser never gets the
  // Access-Control-Allow-* headers it needs to let the real request through.
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders
    });
  }
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/replan-engine/, '');
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  // Auth
  const authHeader = req.headers.get('Authorization') ?? '';
  const userClient = createClient(supabaseUrl, anonKey, {
    global: {
      headers: {
        Authorization: authHeader
      }
    }
  });
  const serviceClient = createClient(supabaseUrl, serviceKey);
  // IP RATE LIMIT GATE (Q2.15) — runs before the JWT is verified, and before
  // the route is even known. See the IP RATE LIMITING note above.
  const clientIp = getClientIp(req);
  const ipRate = await checkIpRateLimit(serviceClient, `replan-engine:ip:${clientIp}`);
  if (!ipRate.allowed) {
    return new Response(JSON.stringify({
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many requests'
      }
    }), {
      status: 429,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'Retry-After': String(Math.max(1, ipRate.retryAfter))
      }
    });
  }
  const { data: { user }, error: authError } = await userClient.auth.getUser();
  if (authError || !user) {
    return new Response(JSON.stringify({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid or missing JWT'
      }
    }), {
      status: 401,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
  // ── GET /cached ──────────────────
  if (req.method === 'GET' && path === '/cached') {
    const tripId = url.searchParams.get('tripId');
    const caseId = url.searchParams.get('caseId');
    if (!tripId) {
      return new Response(JSON.stringify({
        error: {
          code: 'BAD_REQUEST',
          message: 'tripId required'
        }
      }), {
        status: 400,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // Ownership check — this previously returned any trip's cached
    // alternatives (including drafted messages to third parties) to any
    // authenticated caller. See SECURITY note above.
    if (!await requireTripMember(serviceClient, tripId, user.id)) {
      return new Response(JSON.stringify({
        error: {
          code: 'NOT_FOUND',
          message: 'Trip not found'
        }
      }), {
        status: 404,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    const query = serviceClient.from('replan_cache').select('*').eq('trip_id', tripId).gt('expires_at', new Date().toISOString()).order('created_at', {
      ascending: false
    }).limit(1);
    if (caseId) query.eq('case_id', caseId);
    // CORRECTION 2026-09-19 — this was `if (error || !data || data.length === 0)`
    // returning `{alternatives: [], baseline: null}` with a 200. A failed read
    // and an empty cache are different outcomes and the caller could not tell
    // them apart: a database error was presented as "there is nothing cached".
    const { data, error } = await query;
    if (error) {
      console.error('[replan-engine] replan_cache read failed:', error);
      return new Response(JSON.stringify({
        error: {
          code: 'CACHE_READ_FAILED',
          message: `Could not read cached replan results: ${error.message}`
        }
      }), {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    if (!data || data.length === 0) {
      return new Response(JSON.stringify({
        alternatives: [],
        baseline: null,
        cached: false
      }), {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    const row = data[0];
    return new Response(JSON.stringify({
      alternatives: row.alternatives,
      baseline: row.baseline,
      seed: row.seed,
      cacheId: row.id
    }), {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
  // ── POST /solve ──────────────────
  if (req.method === 'POST' && path === '/solve') {
    // Gated before the body is parsed and before the membership read, so a
    // caller in a loop cannot make the database do work just by asking.
    //
    // The bucket is keyed on `user.id`, the subject of the JWT verified at
    // the top of this handler, never on `body.tripId` or anything else the
    // caller supplies — a caller-chosen key means a fresh bucket per request
    // and a limit that counts nothing. The `replan-engine:solve:` prefix keeps
    // these buckets clear of other functions' in the shared table, and clear
    // of any future bucket for another route here.
    const rateLimit = await checkRateLimit(serviceClient, `replan-engine:solve:user:${user.id}`);
    if (!rateLimit.allowed) {
      return new Response(JSON.stringify({
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many replan requests'
        }
      }), {
        status: 429,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
          'Retry-After': String(Math.max(1, rateLimit.retryAfter))
        }
      });
    }
    const solveStart = Date.now();
    let body;
    try {
      body = await req.json();
    } catch  {
      return new Response(JSON.stringify({
        error: {
          code: 'BAD_REQUEST',
          message: 'Invalid JSON'
        }
      }), {
        status: 400,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    const { tripId, dates, memberScope, trigger, locks = [] } = body;
    if (!tripId || !dates?.length) {
      return new Response(JSON.stringify({
        error: {
          code: 'BAD_REQUEST',
          message: 'tripId and dates required'
        }
      }), {
        status: 400,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // Validate trip membership (bridged through the platform id space — see
    // SECURITY note above; this previously denied every caller unconditionally).
    if (!await requireTripMember(serviceClient, tripId, user.id)) {
      return new Response(JSON.stringify({
        error: {
          code: 'FORBIDDEN',
          message: 'Not a trip member'
        }
      }), {
        status: 403,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // Trip timezone — needed to compare an item's timestamptz start against
    // reservations.start_time, which is a bare `time without time zone`.
    const { data: tripRow, error: tripError } = await serviceClient.from('trips').select('primary_tz, version').eq('id', tripId).maybeSingle();
    if (tripError) {
      console.error('[replan-engine] trips read failed:', tripError);
      return new Response(JSON.stringify({
        error: {
          code: 'TRIP_READ_FAILED',
          message: `Could not read the trip: ${tripError.message}`
        }
      }), {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    if (!tripRow) {
      return new Response(JSON.stringify({
        error: {
          code: 'NOT_FOUND',
          message: 'Trip not found'
        }
      }), {
        status: 404,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    const tripTz = tripRow.primary_tz ?? null;
    const tripVersion = tripRow.version ?? 0;
    // Fetch itinerary items for the requested dates.
    // CORRECTION 2026-09-19 — the error was discarded here. A failed read
    // produced `items === null`, the solver then ran on zero tasks, and the
    // handler returned a baseline with an empty `problems` array — telling the
    // user their day is fine when in fact nothing had been read at all.
    const { data: items, error: itemsError } = await serviceClient.from('itinerary_items').select('*').eq('trip_id', tripId).in('date', dates);
    if (itemsError) {
      console.error('[replan-engine] itinerary_items read failed:', itemsError);
      return new Response(JSON.stringify({
        error: {
          code: 'ITEMS_READ_FAILED',
          message: `Could not read the itinerary for this trip: ${itemsError.message}`
        }
      }), {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    if (!items || items.length === 0) {
      return new Response(JSON.stringify({
        alternatives: [],
        baseline: null,
        reason: 'NO_ITEMS',
        message: 'No itinerary items exist for the requested dates, so there is nothing to replan. This is not a statement that the existing plan is problem-free.'
      }), {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // Fetch reservations for these dates — see the linking note above
    // generateProviderMessages for why this is matched on (trip_id, date,
    // local start time) and not on a non-existent `item_id` column.
    const { data: reservationRows, error: resError } = await serviceClient.from('reservations').select('id, provider_name, confirmation_number, traveler_names, start_date, start_time, timezone, location_name, reservation_status').eq('trip_id', tripId).in('start_date', dates);
    let reservations = [];
    let reservationReadNote;
    if (resError) {
      // Not fatal to the replan itself, but it must never look like
      // "no reservations exist".
      console.error('[replan-engine] reservations read failed:', resError);
      reservationReadNote = `Reservations could not be read (${resError.message}), so no provider messages could be drafted. This does not mean there is nobody to contact.`;
    } else {
      reservations = reservationRows ?? [];
    }
    const { byItemId: resByItemId, problems: linkProblems } = linkReservations(items, reservations, tripTz);
    // Fetch enjoyment predictions (graceful degradation)
    let enjoymentMap = new Map();
    try {
      const predResp = await fetch(`${supabaseUrl}/functions/v1/happiness-prediction/predictions/items?tripId=${tripId}`, {
        headers: {
          Authorization: authHeader
        }
      });
      if (predResp.ok) {
        const predData = await predResp.json();
        if (Array.isArray(predData.predictions)) {
          for (const p of predData.predictions){
            // CORRECTION 2026-09-19 — this was `p.mean ?? 3, p.low ?? 2,
            // p.high ?? 4`, inventing a mid-scale prediction for any item the
            // predictor returned without one and feeding it to the objective
            // function as if it were measured. A prediction without a usable
            // mean is now skipped, and the item's enjoyment stays unknown.
            if (typeof p.mean !== 'number' || !Number.isFinite(p.mean)) continue;
            const lo = typeof p.low === 'number' && Number.isFinite(p.low) ? p.low : p.mean;
            const hi = typeof p.high === 'number' && Number.isFinite(p.high) ? p.high : p.mean;
            enjoymentMap.set(p.itemId, {
              mean: p.mean,
              low: lo,
              high: hi,
              known: true
            });
          }
        }
      }
    } catch (e) {
      console.warn('happiness-prediction unavailable, using priority proxy:', e);
    }
    // Energy budget.
    //
    // CORRECTION 2026-09-19 — what stood here POSTed to
    // traveler-profile/internal/profile-vector with an `Authorization` header
    // and a body of `{userId, tripId}`, then read `profileData.energyBudget`.
    // Re-read that function's source on 2026-09-19: the route authenticates on
    // an `x-service-key` header compared timing-safely against the service role
    // key (an Authorization header is rejected 401), it requires `userId` AND
    // `context` and 422s without them, and its only success shape is
    // `{ userId, context, vector, available }` — there is no `energyBudget`
    // field and there never has been. So `profileResp.ok` was never true, the
    // assignment never ran, and `energyBudget` has been the constant 100 on
    // every solve since this code was written, while the call cost a round
    // trip and the log line claimed a "default" was being used as a fallback.
    //
    // There is no measured per-traveler energy budget in this system. Rather
    // than dress a constant up as one, the call is removed and the constant is
    // named for what it is: a fixed scale unit against which itinerary_items
    // .energy_cost values are compared. It is reported to the caller as
    // unmeasured so the UI cannot present energyPct as a personal measurement.
    const ENERGY_BUDGET_IS_MEASURED = false;
    const energyBudget = 100; // fixed scale unit, not a measurement
    // Fetch weather (graceful degradation)
    //
    // CORRECTION 2026-09-19 — this read `weatherData.precipPct ?? 0` and
    // `weatherData.severeAlert ?? false`. A 200 response that omitted those
    // fields therefore became a confident "0% rain, no severe alerts", and
    // detectConflicts' outdoor check (`precipPct >= 40 || severeAlert`) could
    // never fire — the outdoor constraint silently stopped applying while the
    // plan still claimed weather had been taken into account. Weather is now
    // only used when the response actually carries a usable precipPct; missing
    // fields leave `weather` null, which is the same state as "not fetched"
    // and is reported to the caller.
    let weather = null;
    let weatherHash = '';
    let weatherNote;
    try {
      const weatherResp = await fetch(`${supabaseUrl}/functions/v1/provider-adapters/weather?tripId=${tripId}&dates=${dates.join(',')}`, {
        headers: {
          Authorization: authHeader
        }
      });
      if (weatherResp.ok) {
        const weatherData = await weatherResp.json();
        const precip = weatherData?.precipPct;
        const severe = weatherData?.severeAlert;
        if (typeof precip === 'number' && Number.isFinite(precip)) {
          weather = {
            precipPct: precip,
            severeAlert: typeof severe === 'boolean' ? severe : false,
            hash: typeof weatherData?.hash === 'string' ? weatherData.hash : ''
          };
          weatherHash = weather.hash;
        } else {
          weatherNote = 'The weather service answered 200 but without a usable precipPct, so the outdoor-weather constraint was NOT applied. Outdoor activities have not been checked against the forecast.';
          console.warn('[replan-engine]', weatherNote, JSON.stringify(weatherData));
        }
      } else {
        weatherNote = `The weather service returned ${weatherResp.status}, so the outdoor-weather constraint was NOT applied.`;
        console.warn('[replan-engine]', weatherNote);
      }
    } catch (e) {
      weatherNote = 'The weather service could not be reached, so the outdoor-weather constraint was NOT applied.';
      console.warn('[replan-engine]', weatherNote, e);
    }
    // Build Task objects from itinerary items
    const tasks = (items ?? []).map((item)=>{
      const itemId = item.id;
      const priority = item.must_do ? 3 : item.starred ? 2 : item.suggested ? 0.5 : 1;
      const durationMin = item.duration_min ?? 60;
      // CORRECTION 2026-09-19 — this was
      //   enjoymentMap.get(itemId) ?? { mean: priority, low: priority - 1, high: priority + 1 }
      // which substituted the item's own priority (0.5 / 1 / 2 / 3) for a
      // predicted enjoyment on a 1–5 scale and fed it straight to objective().
      // An item with no calibrated prediction is now marked unknown and its
      // enjoyment term is excluded from the objective rather than invented.
      const enj = enjoymentMap.get(itemId) ?? {
        mean: 0,
        low: 0,
        high: 0,
        known: false
      };
      return {
        id: itemId,
        title: item.title ?? 'Untitled',
        placeId: item.place_id,
        lat: item.lat,
        lng: item.lng,
        durationMin,
        minDurationMin: Math.round(durationMin * 0.7),
        windows: item.windows ?? [],
        fixed: !!item.fixed,
        fixedStart: item.fixed_start,
        outdoor: !!item.outdoor,
        priority,
        enjoyment: enj,
        energyCost: item.energy_cost ?? 10,
        // CORRECTION 2026-09-21 — this was `(item.member_ids as string[]) ?? memberScope`.
        // The request body's `memberScope` is never validated (only tripId/dates
        // are checked above), so a caller that omits it — like the console's
        // Smoke Test "Run /solve" button — leaves `memberScope` `undefined`. Any
        // itinerary item with a null `member_ids` column then got `memberIds:
        // undefined` on its Task, which crashed `hasOverlap()`/`detectConflicts()`
        // with `TypeError: Cannot read properties of undefined (reading 'filter')`
        // as soon as two scheduled items were compared. Falling back to `[]` keeps
        // such an item real (it just has no shared-member conflicts) instead of
        // producing a Task the solver cannot safely read.
        memberIds: item.member_ids ?? memberScope ?? [],
        droppable: !!item.droppable,
        cancellation: item.cancellation
      };
    });
    const taskMap = new Map(tasks.map((t)=>[
        t.id,
        t
      ]));
    // Build baseline schedule from current items
    const baselineSchedule = (items ?? []).filter((i)=>i.start_time).map((i)=>({
        taskId: i.id,
        start: i.start_time,
        end: i.end_time
      }));
    // Baseline problems
    const baselineConflicts = detectConflicts(baselineSchedule, taskMap, weather);
    const baselineScore = objective(baselineSchedule, taskMap, baselineSchedule, {
      label: 'Best day',
      stabilityWeight: 1,
      energyCapPct: 1.1,
      maxOptionalDrop: 0,
      locks,
      weather,
      energyBudget
    });
    const baselinePlan = {
      schedule: baselineSchedule,
      problems: baselineConflicts,
      objectiveScore: baselineScore
    };
    // Run solver for each alternative config
    const solverConfigs = [
      {
        label: 'Minimal change',
        stabilityWeight: 3,
        energyCapPct: 1.1,
        maxOptionalDrop: 1,
        locks,
        weather,
        energyBudget
      },
      {
        label: 'Best day',
        stabilityWeight: 1,
        energyCapPct: 1.1,
        maxOptionalDrop: 3,
        locks,
        weather,
        energyBudget
      },
      {
        label: 'Relaxed',
        stabilityWeight: 1,
        energyCapPct: 0.85,
        maxOptionalDrop: 5,
        locks,
        weather,
        energyBudget: energyBudget * 0.85
      }
    ];
    const rawAlternatives = [];
    // CPU BUDGET 2026-09-21 (WORKER_RESOURCE_LIMIT / 546) — solve() ran a
    // simulated-annealing loop with a hardcoded `Date.now() + 800` deadline,
    // and is called once per (solverConfig, date) pair below: even a
    // single-date request makes 3 calls (one per solverConfigs entry), for
    // 2400ms of synchronous, CPU-bound busy-work — over Supabase Edge
    // Functions' hard 2000ms-CPU-time-per-request cap on its own, before
    // counting the greedy-insertion pass, detectConflicts(), or anything
    // else in this handler. That is exactly what a live "Run /solve" call
    // hit: the isolate was killed mid-request with `sb-error-code:
    // WORKER_RESOURCE_LIMIT`, `execution_time_ms: 8313` (multiple dates
    // pushed it well past 2s), confirmed against Supabase's own limits doc
    // (2s CPU time per request; async I/O like the weather/happiness-
    // prediction fetches above does NOT count against it — only synchronous
    // compute does). The annealing budget is now shared across the whole
    // request rather than fixed per call: divided among every
    // (solverConfigs.length × dates.length) call to solve() so the total
    // stays safely under the cap, leaving headroom for everything else this
    // handler does. Real tradeoff, stated plainly rather than hidden: with
    // more dates or configs each individual solve() gets a smaller search
    // budget and may find a less-optimized schedule — that is the actual
    // cost of staying under the platform's CPU limit, not a bug being
    // papered over.
    const totalSolveCalls = Math.max(1, solverConfigs.length * dates.length);
    const ANNEAL_TOTAL_BUDGET_MS = 1200; // total across the whole request, well under the 2000ms hard cap
    const annealBudgetMs = Math.max(50, Math.floor(ANNEAL_TOTAL_BUDGET_MS / totalSolveCalls));
    for (const config of solverConfigs){
      // Run solver per date
      let combinedResult = [];
      for (const date of dates){
        const dayTasks = tasks.filter((t)=>{
          // Include tasks that have windows on this date or no windows
          if (t.windows.length === 0) return true;
          return t.windows.some((w)=>w.start.startsWith(date));
        });
        const dayBaseline = baselineSchedule.filter((s)=>s.start.startsWith(date));
        const dayResult = solve(dayTasks, dayBaseline, config, date, annealBudgetMs);
        combinedResult = [
          ...combinedResult,
          ...dayResult
        ];
      }
      const score = objective(combinedResult, taskMap, baselineSchedule, config);
      rawAlternatives.push({
        config,
        result: combinedResult,
        score
      });
    }
    // Deduplicate alternatives within 5% objective AND same changed tasks
    const alternatives = [];
    for (const alt of rawAlternatives){
      const ops = buildOps(baselineSchedule, alt.result);
      const changedIds = new Set(ops.map((o)=>o.itemId));
      const isDuplicate = alternatives.some((existing)=>{
        const existingChangedIds = new Set(existing.ops.map((o)=>o.itemId));
        const sameIds = [
          ...changedIds
        ].every((id)=>existingChangedIds.has(id)) && [
          ...existingChangedIds
        ].every((id)=>changedIds.has(id));
        const scoreDiff = Math.abs(alt.score - existing.objectiveScore) / (Math.abs(existing.objectiveScore) || 1);
        return sameIds && scoreDiff < 0.05;
      });
      if (isDuplicate) continue;
      const conflicts = detectConflicts(alt.result, taskMap, weather);
      const deltas = computeDeltas(baselineSchedule, alt.result, ops, taskMap);
      const pm = generateProviderMessages(ops, taskMap, resByItemId, linkProblems, tripTz);
      const providerMessages = pm.messages;
      const providerMessageIssues = pm.unmatched;
      const providerMessageNote = reservationReadNote ?? pm.note;
      const explanation = generateExplanation(ops, taskMap, alt.config.label, tripTz);
      // Health delta: fewer conflicts = positive
      const healthDelta = baselineConflicts.length - conflicts.length;
      // Friction delta by day
      const frictionDeltaByDay = {};
      for (const date of dates){
        const baseDayConflicts = baselineConflicts.filter((c)=>c.itemIds.some((id)=>{
            const s = baselineSchedule.find((s)=>s.taskId === id);
            return s?.start.startsWith(date);
          })).length;
        const newDayConflicts = conflicts.filter((c)=>c.itemIds.some((id)=>{
            const s = alt.result.find((s)=>s.taskId === id);
            return s?.start.startsWith(date);
          })).length;
        frictionDeltaByDay[date] = baseDayConflicts - newDayConflicts;
      }
      // Cost delta from fees
      const costDelta = deltas.fees.amountMinor > 0 ? {
        amountMinor: deltas.fees.amountMinor,
        currency: deltas.fees.currency
      } : undefined;
      alternatives.push({
        id: ulid('alt_'),
        label: alt.config.label,
        ops,
        preview: {
          conflicts,
          healthDelta,
          frictionDeltaByDay,
          costDelta
        },
        deltas,
        explanation,
        providerMessages,
        providerMessageIssues,
        providerMessageNote,
        objectiveScore: alt.score
      });
    }
    const seed = ulid('seed_');
    const cacheId = ulid('rpl_');
    const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    // Cache result.
    //
    // CORRECTION 2026-09-19 — the insert's result was discarded. When it
    // failed, /solve still returned this `cacheId` to the caller, who then
    // POSTed it to /apply and was told "Alternative not found or cache
    // expired" — a 404 blaming an expiry for a write that never happened.
    // A failed cache write is now reported as the failure it is.
    //
    // `plan_version` was also hardcoded to 0; it now records the trip version
    // these alternatives were computed against, which is what /apply's
    // compare-and-set needs in order to mean anything.
    const { error: cacheError } = await serviceClient.from('replan_cache').insert({
      id: cacheId,
      trip_id: tripId,
      dates,
      trigger_kind: trigger.kind,
      case_id: trigger.kind === 'disruption' ? trigger.caseId : null,
      alternatives,
      baseline: baselinePlan,
      seed,
      plan_version: tripVersion,
      weather_hash: weatherHash,
      expires_at: expiresAt
    });
    if (cacheError) {
      console.error('[replan-engine] replan_cache insert failed:', cacheError);
      return new Response(JSON.stringify({
        error: {
          code: 'CACHE_WRITE_FAILED',
          message: `The plan was computed but could not be stored, so it cannot be applied: ${cacheError.message}`
        },
        alternatives,
        baseline: baselinePlan,
        seed,
        cacheId: null,
        applicable: false
      }), {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    const solveMs = Date.now() - solveStart;
    if (solveMs > 2000) {
      console.warn(`[replan-engine] Solve took ${solveMs}ms for single day — performance warning`);
    } else {
      console.log(`[replan-engine] Solve completed in ${solveMs}ms, ${alternatives.length} alternatives`);
    }
    return new Response(JSON.stringify({
      alternatives,
      baseline: baselinePlan,
      seed,
      cacheId,
      // The trip version these alternatives were computed against. Pass it
      // back as /apply's `baseVersion`.
      baseVersion: tripVersion,
      // CORRECTION 2026-09-19 — what the solver did and did not actually
      // know, so the UI cannot present a guess as a measurement.
      inputs: {
        itemCount: items.length,
        weatherApplied: weather !== null,
        weatherNote,
        enjoymentCalibratedCount: enjoymentMap.size,
        enjoymentNote: enjoymentMap.size === 0 ? 'No calibrated enjoyment predictions were available, so the enjoyment term was excluded from the objective rather than estimated.' : undefined,
        energyBudget,
        energyBudgetMeasured: ENERGY_BUDGET_IS_MEASURED,
        energyBudgetNote: 'energyBudget is a fixed scale unit, not a measured personal budget. No per-traveler energy budget exists in this system.',
        reservationsRead: reservationReadNote === undefined,
        reservationReadNote
      }
    }), {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
  // ── POST /apply ──────────────────
  if (req.method === 'POST' && path === '/apply') {
    let body;
    try {
      body = await req.json();
    } catch  {
      return new Response(JSON.stringify({
        error: {
          code: 'BAD_REQUEST',
          message: 'Invalid JSON'
        }
      }), {
        status: 400,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    const { tripId, alternativeId, baseVersion } = body;
    if (!tripId || !alternativeId) {
      return new Response(JSON.stringify({
        error: {
          code: 'BAD_REQUEST',
          message: 'tripId and alternativeId required'
        }
      }), {
        status: 400,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // CORRECTION 2026-09-19 — `baseVersion` was destructured here, never
    // compared against anything, and then written to replan_applied as
    // `baseVersion ?? 0`. Two trip members applying different alternatives to
    // the same day both received `{applied: true}` and the second silently
    // overwrote the first. It is now required, and enforced by the version
    // check inside the atomic apply further down.
    if (typeof baseVersion !== 'number' || !Number.isInteger(baseVersion)) {
      return new Response(JSON.stringify({
        error: {
          code: 'BAD_REQUEST',
          message: 'baseVersion (integer) is required. Use the baseVersion returned by /solve; it is checked against the trip version so that two members cannot silently overwrite each other.'
        }
      }), {
        status: 400,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // Validate trip membership (see SECURITY note above)
    if (!await requireTripMember(serviceClient, tripId, user.id)) {
      return new Response(JSON.stringify({
        error: {
          code: 'FORBIDDEN',
          message: 'Not a trip member'
        }
      }), {
        status: 403,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // Find the cached alternative.
    // CORRECTION 2026-09-19 — the error was discarded, so a failed read became
    // `cacheRows === null` and the handler answered 404 "cache expired", which
    // told the user their plan had timed out when in fact the database call
    // had failed.
    const { data: cacheRows, error: cacheReadError } = await serviceClient.from('replan_cache').select('*').eq('trip_id', tripId).gt('expires_at', new Date().toISOString()).order('created_at', {
      ascending: false
    }).limit(10);
    if (cacheReadError) {
      console.error('[replan-engine] replan_cache read failed:', cacheReadError);
      return new Response(JSON.stringify({
        error: {
          code: 'CACHE_READ_FAILED',
          message: `Could not read the cached plan, so nothing was applied: ${cacheReadError.message}`
        }
      }), {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    let foundAlt = null;
    for (const row of cacheRows ?? []){
      const alts = row.alternatives;
      const alt = alts.find((a)=>a.id === alternativeId);
      if (alt) {
        foundAlt = alt;
        break;
      }
    }
    if (!foundAlt) {
      return new Response(JSON.stringify({
        error: {
          code: 'NOT_FOUND',
          message: 'Alternative not found or cache expired'
        }
      }), {
        status: 404,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // The applied id is still minted here and still returned to the caller,
    // but it is generated BEFORE the call now: the RPC writes the
    // replan_applied row itself, inside the transaction, so it has to be
    // handed the id rather than allocating one after the fact.
    const appliedId = ulid('rpl_');
    const undoExpiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const { data: applyData, error: applyRpcError } = await serviceClient.rpc('replan_apply_atomic', {
      p_trip_id: tripId,
      p_base_version: baseVersion,
      p_ops: foundAlt.ops,
      p_applied_id: appliedId,
      p_alternative_id: alternativeId,
      p_applied_by: user.id,
      p_undo_expires_at: undoExpiresAt
    });
    // A call that failed and an apply that was refused are different outcomes
    // and must not be collapsed into one. This branch is the call itself
    // failing — the function never reached a verdict — which is a 500 and says
    // so.
    if (applyRpcError) {
      console.error('[replan-engine] replan_apply_atomic call failed:', applyRpcError);
      return new Response(JSON.stringify({
        applied: false,
        error: {
          code: 'APPLY_RPC_FAILED',
          message: `The atomic apply could not be run, so nothing was applied: ${applyRpcError.message}`
        },
        baseVersion
      }), {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    const applyResult = applyData ?? null;
    if (!applyResult) {
      console.error('[replan-engine] replan_apply_atomic returned no result');
      return new Response(JSON.stringify({
        applied: false,
        error: {
          code: 'APPLY_RPC_FAILED',
          message: 'The atomic apply returned no result, so it is not known whether anything was applied.'
        },
        baseVersion
      }), {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    const opResults = applyResult.opResults ?? [];
    // Every branch below is a refusal: the transaction rolled back, nothing
    // was written, and trips.version is untouched.
    if (!applyResult.applied) {
      if (applyResult.code === 'TRIP_NOT_FOUND') {
        return new Response(JSON.stringify({
          error: {
            code: 'NOT_FOUND',
            message: 'Trip not found'
          }
        }), {
          status: 404,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      if (applyResult.code === 'VERSION_CONFLICT') {
        return new Response(JSON.stringify({
          applied: false,
          error: {
            code: 'VERSION_CONFLICT',
            message: `This plan was computed against trip version ${baseVersion} but the trip is now at version ${applyResult.currentVersion}. Someone else has changed the itinerary. Nothing was applied — re-run /solve and try again.`
          },
          baseVersion,
          currentVersion: applyResult.currentVersion
        }), {
          status: 409,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      if (applyResult.code === 'OPS_INVALID') {
        console.error('[replan-engine] apply refused — ops invalid:', JSON.stringify(opResults));
        return new Response(JSON.stringify({
          applied: false,
          error: {
            code: 'OPS_INVALID',
            message: `${applyResult.failedCount ?? 0} of ${applyResult.totalOps ?? opResults.length} change(s) in this plan cannot be applied to the trip as it now stands — see opResults for which. The plan is stale: it was solved against items that have since changed or been deleted, and applying the rest would produce a schedule the solver never checked. Nothing was written and the trip version has not moved — re-run /solve and try again.`
          },
          baseVersion,
          currentVersion: applyResult.currentVersion,
          appliedCount: 0,
          failedCount: applyResult.failedCount ?? 0,
          totalOps: applyResult.totalOps ?? opResults.length,
          opResults
        }), {
          status: 409,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      // BAD_REQUEST / OPS_NOT_ARRAY. The ops came out of replan_cache, not out
      // of the request body, so a malformed batch is this service's problem
      // rather than the caller's: 500, not 400.
      console.error('[replan-engine] apply refused:', applyResult.code, applyResult.detail);
      return new Response(JSON.stringify({
        applied: false,
        error: {
          code: applyResult.code ?? 'APPLY_REFUSED',
          message: `Nothing was applied — the cached plan could not be read as a set of ops: ${applyResult.detail ?? 'no detail given'}`
        },
        baseVersion,
        opResults
      }), {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    const newVersion = applyResult.newVersion;
    const appliedCount = applyResult.appliedCount ?? 0;
    const removedCount = applyResult.removedCount ?? 0;
    const failedCount = applyResult.failedCount ?? 0;
    const totalOps = applyResult.totalOps ?? opResults.length;
    const undoLogged = applyResult.undoLogged === true;
    // Notify affected members (graceful degradation)
    let notifyNote;
    try {
      // ID SPACE 2026-09-18 — this exclusion was `.neq('user_id', user.id)`,
      // comparing an auth uuid against trip_members.user_id, which is TEXT in
      // the platform id space (`usr_` ids). The neq therefore never matched and
      // the actor was notified about their own change. Resolve the actor's
      // platform id and exclude that instead. If it does not resolve, keep
      // every member: notifying one extra person beats notifying nobody.
      const actorPlatformId = await resolvePlatformUserId(serviceClient, user.id);
      if (!actorPlatformId) {
        console.error('[replan-engine] no platform user id for auth user; notifying all trip members:', user.id);
      }
      let membersQuery = serviceClient.from('trip_members').select('user_id').eq('trip_id', tripId);
      if (actorPlatformId) membersQuery = membersQuery.neq('user_id', actorPlatformId);
      // CORRECTION 2026-09-19 — the error was discarded here, so a failed
      // trip_members read produced `members === null`, the `if` below was
      // skipped, and nobody on the trip was told their itinerary had changed —
      // with no trace anywhere that a notification had been due.
      const { data: members, error: membersError } = await membersQuery;
      if (membersError) {
        console.error('[replan-engine] trip_members read failed — NO ONE was notified of this apply:', membersError);
        notifyNote = `The itinerary was changed but the trip member list could not be read (${membersError.message}), so no one else was notified.`;
      } else if (!members || members.length === 0) {
        notifyNote = 'No other trip members to notify.';
      }
      if (!membersError && members && members.length > 0) {
        // notification-delivery dispatches on `action`; `send_direct` is the
        // action built for service-to-service callers like this one. `id_space`
        // is mandatory: trip_members.user_id holds platform `usr_` ids.
        const notifResp = await fetch(`${supabaseUrl}/functions/v1/notification-delivery`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${serviceKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            action: 'send_direct',
            recipients: members.map((m)=>m.user_id),
            id_space: 'platform',
            title: 'Itinerary updated',
            // CORRECTION 2026-09-19 — this counted `foundAlt.ops.length`, the
            // number of ops *attempted*, including `add` ops the apply loop
            // had no branch for and any op that silently matched no row. It
            // now counts what actually landed.
            message: `The trip plan has been re-optimised. ${appliedCount} change(s) applied.`,
            data: {
              tripId,
              alternativeId,
              kind: 'replan_applied'
            }
          })
        });
        // Never swallow the result: this call silently 400'd for its whole
        // life because the body carried no `action`. A 200 with resolved: 0
        // is also a real outcome and must be visible.
        const rawBody = await notifResp.text();
        let parsed = null;
        try {
          parsed = JSON.parse(rawBody);
        } catch  {}
        if (!notifResp.ok) {
          console.error('[replan-engine] notification-delivery failed:', notifResp.status, rawBody);
          notifyNote = `The itinerary was changed but notification-delivery returned ${notifResp.status}, so other members may not have been told.`;
        } else {
          const d = parsed?.data ?? {};
          console.log('[replan-engine] notification-delivery ok:', JSON.stringify({
            requested: d.requested,
            resolved: d.resolved,
            delivered_inapp: d.delivered_inapp,
            delivered_push: d.delivered_push,
            unresolved: d.unresolved
          }));
        }
      }
    } catch (e) {
      // A notification failure must not break /apply — but it is logged now,
      // and reported to the caller instead of vanishing.
      console.error('[replan-engine] notification-delivery unavailable:', e);
      notifyNote = 'The itinerary was changed but the notification service could not be reached, so other members may not have been told.';
    }
    // CORRECTION 2026-09-19 — this used to be an unconditional
    //     { applied: true, undoExpiresAt, appliedId }
    // returned no matter what the writes above had done, alongside an
    // `undoExpiresAt` for an /undo route that did not exist. The response now
    // reports exactly what landed, and states plainly whether an undo is
    // actually available.
    //
    // An undo can reverse a `move`, an `add` and an `update` (the row still
    // exists and its previous schedule is in the op). It cannot reverse a
    // `remove`: the row is deleted and the op holds only {taskId, start, end},
    // not the item's other 30 columns. So undo is offered only when nothing
    // was removed, and the reason is given when it is not.
    const undoAvailable = undoLogged && appliedCount > 0 && removedCount === 0;
    const undoReason = !undoLogged ? 'This apply could not be written to the applied-changes log, so it cannot be undone.' : appliedCount === 0 ? 'Nothing was applied, so there is nothing to undo.' : removedCount > 0 ? `This plan deleted ${removedCount} itinerary item(s). Deleted items cannot be restored from the change log, so this apply cannot be undone.` : undefined;
    // A reply only gets this far when the transaction committed, so every op
    // landed and `partial` cannot happen: no 207, no warning. opResults is
    // kept because it still says what each op did.
    return new Response(JSON.stringify({
      applied: true,
      appliedId,
      appliedCount,
      failedCount,
      totalOps,
      opResults,
      baseVersion,
      newVersion,
      undo: {
        available: undoAvailable,
        expiresAt: undoAvailable ? undoExpiresAt : null,
        reason: undoReason
      },
      notifyNote
    }), {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
  // ── POST /undo ──────────────────
  //
  // CORRECTION 2026-09-19 — /apply returned an `undoExpiresAt` to every caller
  // and there was no /undo route anywhere in this function; the promise was
  // simply false. This implements it for the cases that are genuinely
  // reversible and refuses, with a reason, for the cases that are not.
  if (req.method === 'POST' && path === '/undo') {
    let body;
    try {
      body = await req.json();
    } catch  {
      return new Response(JSON.stringify({
        error: {
          code: 'BAD_REQUEST',
          message: 'Invalid JSON'
        }
      }), {
        status: 400,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    const { tripId, appliedId, baseVersion } = body;
    if (!tripId || !appliedId) {
      return new Response(JSON.stringify({
        error: {
          code: 'BAD_REQUEST',
          message: 'tripId and appliedId required'
        }
      }), {
        status: 400,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    if (typeof baseVersion !== 'number' || !Number.isInteger(baseVersion)) {
      return new Response(JSON.stringify({
        error: {
          code: 'BAD_REQUEST',
          message: 'baseVersion (integer) is required — the trip version you expect to be undoing from, as returned by /apply as newVersion.'
        }
      }), {
        status: 400,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    if (!await requireTripMember(serviceClient, tripId, user.id)) {
      return new Response(JSON.stringify({
        error: {
          code: 'FORBIDDEN',
          message: 'Not a trip member'
        }
      }), {
        status: 403,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    const { data: appliedRow, error: appliedReadError } = await serviceClient.from('replan_applied').select('*').eq('id', appliedId).eq('trip_id', tripId).maybeSingle();
    if (appliedReadError) {
      console.error('[replan-engine] replan_applied read failed:', appliedReadError);
      return new Response(JSON.stringify({
        error: {
          code: 'APPLIED_READ_FAILED',
          message: `Could not read the change log, so nothing was undone: ${appliedReadError.message}`
        }
      }), {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    if (!appliedRow) {
      return new Response(JSON.stringify({
        error: {
          code: 'NOT_FOUND',
          message: 'No such applied change for this trip'
        }
      }), {
        status: 404,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    if (new Date(appliedRow.undo_expires_at) <= new Date()) {
      return new Response(JSON.stringify({
        undone: false,
        error: {
          code: 'UNDO_EXPIRED',
          message: `The undo window for this change closed at ${appliedRow.undo_expires_at}.`
        }
      }), {
        status: 410,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    const undoOps = appliedRow.ops ?? [];
    const removes = undoOps.filter((o)=>o.kind === 'remove');
    if (removes.length > 0) {
      return new Response(JSON.stringify({
        undone: false,
        error: {
          code: 'UNDO_NOT_POSSIBLE',
          message: `This change deleted ${removes.length} itinerary item(s). The change log holds only their id, start and end, not the rest of the row, so they cannot be restored. Nothing was undone.`
        },
        unrestorableItemIds: removes.map((o)=>o.itemId)
      }), {
        status: 409,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // Claim the write, same compare-and-set as /apply.
    const { data: undoVersionRows, error: undoVersionError } = await serviceClient.from('trips').update({
      version: baseVersion + 1
    }).eq('id', tripId).eq('version', baseVersion).select('version');
    if (undoVersionError) {
      console.error('[replan-engine] undo version CAS failed:', undoVersionError);
      return new Response(JSON.stringify({
        error: {
          code: 'VERSION_CAS_FAILED',
          message: `Could not claim the trip for writing, so nothing was undone: ${undoVersionError.message}`
        }
      }), {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    if (!undoVersionRows || undoVersionRows.length === 0) {
      const { data: cur } = await serviceClient.from('trips').select('version').eq('id', tripId).maybeSingle();
      return new Response(JSON.stringify({
        undone: false,
        error: {
          code: 'VERSION_CONFLICT',
          message: `Expected trip version ${baseVersion}${cur ? `, found ${cur.version}` : ''}. Someone else has changed the itinerary since. Nothing was undone.`
        },
        baseVersion,
        currentVersion: cur?.version ?? null
      }), {
        status: 409,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    const undoResults = [];
    for (const op of undoOps){
      // `add` ops had no prior schedule: undoing one means unscheduling the
      // item again, which is a real, representable state (start_time is
      // nullable on itinerary_items).
      const prevStart = op.kind === 'add' ? null : op.before?.start ?? null;
      const prevEnd = op.kind === 'add' ? null : op.before?.end ?? null;
      if (op.kind !== 'add' && (!prevStart || !prevEnd)) {
        undoResults.push({
          itemId: op.itemId,
          status: 'error',
          detail: 'the change log holds no previous start/end for this item, so it cannot be restored'
        });
        continue;
      }
      const { data, error } = await serviceClient.from('itinerary_items').update({
        start_time: prevStart,
        end_time: prevEnd
      }).eq('id', op.itemId).eq('trip_id', tripId).select('id');
      if (error) {
        console.error('[replan-engine] undo write failed:', op.itemId, error);
        undoResults.push({
          itemId: op.itemId,
          status: 'error',
          detail: error.message
        });
      } else if (!data || data.length === 0) {
        undoResults.push({
          itemId: op.itemId,
          status: 'not_found',
          detail: 'no itinerary item with this id belongs to this trip'
        });
      } else {
        undoResults.push({
          itemId: op.itemId,
          status: 'ok'
        });
      }
    }
    const undoneCount = undoResults.filter((r)=>r.status === 'ok').length;
    const undoFailed = undoResults.filter((r)=>r.status !== 'ok');
    return new Response(JSON.stringify({
      undone: undoFailed.length === 0 ? true : undoneCount > 0 ? 'partial' : false,
      undoneCount,
      failedCount: undoFailed.length,
      totalOps: undoResults.length,
      undoResults,
      baseVersion,
      newVersion: undoVersionRows[0].version
    }), {
      status: undoFailed.length === 0 ? 200 : undoneCount > 0 ? 207 : 500,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
  return new Response(JSON.stringify({
    error: {
      code: 'NOT_FOUND',
      message: 'Route not found'
    }
  }), {
    status: 404,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json'
    }
  });
});

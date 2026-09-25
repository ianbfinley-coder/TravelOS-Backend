import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
function serviceClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
}
function generateId(prefix) {
  const timestamp = Date.now().toString(36).padStart(8, '0');
  const random = Math.random().toString(36).substring(2, 12);
  return `${prefix}_${timestamp}${random}`;
}
function cors(req) {
  return {
    'Access-Control-Allow-Origin': req.headers.get('origin') ?? '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'authorization,content-type,x-client-info,apikey'
  };
}
function json(data, status = 200, req) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...req ? cors(req) : {}
    }
  });
}
function err(msg, status, code, req) {
  return json({
    error: msg,
    code
  }, status, req);
}
// ─── Auth helpers ────────────────────────────────────────────────────────
async function verifyJwt(req) {
  const auth = req.headers.get('authorization');
  if (!auth) return null;
  const token = auth.replace('Bearer ', '');
  const client = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user;
}
// SECURITY 2026-09-18: TravelOS runs two id spaces for users — auth.uid()
// (a uuid, what a JWT carries) and platform_users.id (TEXT, "usr_<hex>"),
// which is what trip_members.user_id actually holds. getMemberId() and
// checkTripMembership() below used to filter trip_members.user_id directly
// on the caller's raw auth uuid, which can never match a "usr_..." value —
// every membership check silently returned zero rows and denied every real
// member (checkTripMembership then fell through to the trips.user_id owner
// fallback below, so only the trip owner ever passed). auth_identities.
// provider_subject holds the auth uuid as text and bridges to
// auth_identities.user_id (the platform "usr_" id); this mirrors
// _shared/auth.ts's resolvePlatformUserId(), inlined here since this
// function does not bundle _shared/auth.ts. Match on provider_subject
// ALONE — the provider column varies by sign-in method.
async function resolvePlatformUserId(db, authUserId) {
  const { data } = await db.from('auth_identities').select('user_id').eq('provider_subject', authUserId).maybeSingle();
  return data?.user_id ?? null;
}
// Unused elsewhere in this file (dead code), but fixed for the same reason
// as checkTripMembership below: it filtered trip_members.user_id on the raw
// auth uuid, which can never match the platform "usr_" id space.
async function getMemberId(db, userId, tripId) {
  const platformUserId = await resolvePlatformUserId(db, userId);
  if (!platformUserId) return userId;
  const { data } = await db.from('trip_members').select('id').eq('trip_id', tripId).eq('user_id', platformUserId).is('removed_at', null).maybeSingle();
  return data?.id ?? userId;
}
// SECURITY 2026-09-17 — this was a blanket authorization bypass, not a
// narrow gap. The old fallback was: if no trip_members row matches this
// caller, check whether ANY row exists for that trip id in `trips` — and if
// the trip merely exists, let the caller in as a plain 'member'. That check
// has nothing to do with the caller; it only confirms the trip id is real.
// trip_members is currently empty for every trip in this project, so this
// fallback fired on every single call: any authenticated user, given any
// real trip id, could list/create polls, cast ballots, close polls, and read
// fairness data for a trip they have no relationship to at all.
//
// Fixed the same way as agreement-engine's identical pattern: fall back to
// the trip's actual owner (`trips.user_id`, a uuid, matches auth.uid()
// directly) instead of "the trip exists". Once trip_members is populated for
// real multi-member trips, invited members are recognized through the
// primary lookup as designed; until then, only the owner passes.
//
// SECURITY 2026-09-18: the primary trip_members lookup below is now done
// against the resolved platform user id (see resolvePlatformUserId() above),
// not the raw auth uuid — see that comment for why. The trips.user_id
// fallback a few lines down is untouched: trips.user_id IS an auth uuid, so
// comparing it to the raw userId there is correct.
async function checkTripMembership(db, userId, tripId) {
  const platformUserId = await resolvePlatformUserId(db, userId);
  if (platformUserId) {
    const { data } = await db.from('trip_members').select('id,role,kind').eq('trip_id', tripId).eq('user_id', platformUserId).is('removed_at', null).maybeSingle();
    if (data) return {
      memberId: data.id,
      role: data.role ?? data.kind ?? 'member'
    };
  }
  const { data: trip } = await db.from('trips').select('id').eq('id', tripId).eq('user_id', userId).maybeSingle();
  if (trip) return {
    memberId: userId,
    role: 'organizer'
  };
  return null;
}
// ─── Strategy implementations ──────────────────────────────────────────────────
function strategyMajority(ballots, options, threshold) {
  const tally = {};
  for (const o of options)tally[o.id] = 0;
  const active = ballots.filter((b)=>!b.abstain);
  for (const b of active){
    const p = b.payload;
    if (p.optionId && tally[p.optionId] !== undefined) tally[p.optionId]++;
  }
  const total = active.length;
  if (total === 0) return {
    winnerId: null,
    tally
  };
  let best = null;
  let bestCount = -1;
  for (const [id, count] of Object.entries(tally)){
    if (count > bestCount) {
      bestCount = count;
      best = id;
    }
  }
  const pct = total > 0 ? bestCount / total * 100 : 0;
  if (pct > threshold) return {
    winnerId: best,
    tally
  };
  return {
    winnerId: null,
    tally
  };
}
function strategyApproval(ballots, options) {
  const tally = {};
  for (const o of options)tally[o.id] = 0;
  const active = ballots.filter((b)=>!b.abstain);
  for (const b of active){
    const p = b.payload;
    for (const id of p.optionIds ?? []){
      if (tally[id] !== undefined) tally[id]++;
    }
  }
  let best = null;
  let bestCount = -1;
  let tied = false;
  for (const [id, count] of Object.entries(tally)){
    if (count > bestCount) {
      bestCount = count;
      best = id;
      tied = false;
    } else if (count === bestCount) tied = true;
  }
  if (tied) return {
    winnerId: null,
    tally
  };
  return {
    winnerId: best,
    tally
  };
}
function strategyScore(ballots, options) {
  const sums = {};
  const counts = {};
  for (const o of options){
    sums[o.id] = 0;
    counts[o.id] = 0;
  }
  const active = ballots.filter((b)=>!b.abstain);
  for (const b of active){
    const p = b.payload;
    for (const [id, score] of Object.entries(p.scores ?? {})){
      if (sums[id] !== undefined) {
        sums[id] += score;
        counts[id]++;
      }
    }
  }
  const means = {};
  for (const o of options){
    means[o.id] = counts[o.id] > 0 ? sums[o.id] / counts[o.id] : 0;
  }
  let best = null;
  let bestMean = -1;
  let tied = false;
  for (const [id, mean] of Object.entries(means)){
    if (mean > bestMean + 0.01) {
      bestMean = mean;
      best = id;
      tied = false;
    } else if (Math.abs(mean - bestMean) <= 0.01 && best !== null) tied = true;
  }
  if (tied) return {
    winnerId: null,
    tally: means
  };
  return {
    winnerId: best,
    tally: means
  };
}
function strategyRankedIrv(ballots, options) {
  const active = ballots.filter((b)=>!b.abstain);
  let remaining = options.map((o)=>o.id);
  const rounds = [];
  while(remaining.length > 1){
    const counts = {};
    for (const id of remaining)counts[id] = 0;
    let continuing = 0;
    for (const b of active){
      const p = b.payload;
      const top = (p.ranking ?? []).find((id)=>remaining.includes(id));
      if (top) {
        counts[top]++;
        continuing++;
      }
    }
    if (continuing === 0) break;
    // Check majority
    for (const [id, count] of Object.entries(counts)){
      if (count / continuing > 0.5) {
        return {
          winnerId: id,
          tally: counts,
          rounds
        };
      }
    }
    // Eliminate lowest
    let minCount = Infinity;
    let toEliminate = '';
    for (const [id, count] of Object.entries(counts)){
      if (count < minCount) {
        minCount = count;
        toEliminate = id;
      }
    }
    rounds.push({
      eliminated: toEliminate,
      counts: {
        ...counts
      }
    });
    remaining = remaining.filter((id)=>id !== toEliminate);
  }
  return {
    winnerId: remaining[0] ?? null,
    tally: {},
    rounds
  };
}
function strategyBorda(ballots, options) {
  const n = options.length;
  const points = {};
  for (const o of options)points[o.id] = 0;
  const active = ballots.filter((b)=>!b.abstain);
  for (const b of active){
    const p = b.payload;
    const ranking = p.ranking ?? [];
    for(let i = 0; i < ranking.length; i++){
      const id = ranking[i];
      if (points[id] !== undefined) points[id] += n - 1 - i;
    }
  }
  let best = null;
  let bestPts = -1;
  let tied = false;
  for (const [id, pts] of Object.entries(points)){
    if (pts > bestPts) {
      bestPts = pts;
      best = id;
      tied = false;
    } else if (pts === bestPts) tied = true;
  }
  if (tied) return {
    winnerId: null,
    tally: points
  };
  return {
    winnerId: best,
    tally: points
  };
}
function strategyConsensus(ballots, options, threshold) {
  const active = ballots.filter((b)=>!b.abstain);
  const total = active.length;
  const tally = {};
  const blocks = {};
  const yeses = {};
  for (const o of options){
    tally[o.id] = 0;
    blocks[o.id] = 0;
    yeses[o.id] = 0;
  }
  for (const b of active){
    const p = b.payload;
    for (const [id, stance] of Object.entries(p.stances ?? {})){
      if (tally[id] === undefined) continue;
      if (stance === 'block') blocks[id]++;
      else {
        tally[id]++;
        if (stance === 'yes') yeses[id]++;
      }
    }
  }
  const eligible = options.filter((o)=>{
    if (blocks[o.id] > 0) return false;
    const pct = total > 0 ? tally[o.id] / total * 100 : 0;
    return pct >= threshold;
  });
  if (eligible.length === 0) return {
    winnerId: null,
    tally
  };
  eligible.sort((a, b)=>yeses[b.id] - yeses[a.id]);
  return {
    winnerId: eligible[0].id,
    tally
  };
}
// ─── Tie-break ────────────────────────────────────────────────────────────
async function resolveTie(tiedOptionIds, ballots, options, poll, bandHigh) {
  const active = ballots.filter((b)=>!b.abstain);
  // Step 1 — Head-to-head
  const h2hWins = {};
  for (const id of tiedOptionIds)h2hWins[id] = 0;
  for(let i = 0; i < tiedOptionIds.length; i++){
    for(let j = i + 1; j < tiedOptionIds.length; j++){
      const a = tiedOptionIds[i];
      const b = tiedOptionIds[j];
      let aWins = 0;
      let bWins = 0;
      for (const ballot of active){
        const p = ballot.payload;
        if (poll.strategy === 'ranked_irv' || poll.strategy === 'borda') {
          const ranking = p.ranking ?? [];
          const ai = ranking.indexOf(a);
          const bi = ranking.indexOf(b);
          if (ai !== -1 && (bi === -1 || ai < bi)) aWins++;
          else if (bi !== -1 && (ai === -1 || bi < ai)) bWins++;
        } else if (poll.strategy === 'score') {
          const scores = p.scores ?? {};
          if ((scores[a] ?? 0) > (scores[b] ?? 0)) aWins++;
          else if ((scores[b] ?? 0) > (scores[a] ?? 0)) bWins++;
        } else if (poll.strategy === 'approval') {
          const ids = p.optionIds ?? [];
          if (ids.includes(a) && !ids.includes(b)) aWins++;
          else if (ids.includes(b) && !ids.includes(a)) bWins++;
        }
      }
      if (aWins > bWins) h2hWins[a]++;
      else if (bWins > aWins) h2hWins[b]++;
    }
  }
  const maxH2h = Math.max(...Object.values(h2hWins));
  const h2hWinners = tiedOptionIds.filter((id)=>h2hWins[id] === maxH2h && maxH2h === tiedOptionIds.length - 1);
  if (h2hWinners.length === 1) {
    return {
      winnerId: h2hWinners[0],
      step: 1,
      name: 'head_to_head',
      detail: 'Won all pairwise comparisons.'
    };
  }
  const remaining1 = h2hWinners.length > 0 ? h2hWinners : tiedOptionIds;
  // Step 2 — Breadth of support
  const breadth = {};
  for (const id of remaining1)breadth[id] = 0;
  for (const ballot of active){
    const p = ballot.payload;
    for (const id of remaining1){
      let acceptable = false;
      if (poll.strategy === 'approval') acceptable = (p.optionIds ?? []).includes(id);
      else if (poll.strategy === 'score') acceptable = (p.scores ?? {})[id] >= 3;
      else if (poll.strategy === 'ranked_irv' || poll.strategy === 'borda') {
        const ranking = p.ranking ?? [];
        const idx = ranking.indexOf(id);
        acceptable = idx !== -1 && idx < Math.ceil(ranking.length / 2);
      } else if (poll.strategy === 'consensus') {
        const stance = (p.stances ?? {})[id];
        acceptable = stance === 'yes' || stance === 'can_live_with';
      } else if (poll.strategy === 'majority') {
        acceptable = p.optionId === id;
      }
      if (acceptable) breadth[id]++;
    }
  }
  const maxBreadth = Math.max(...Object.values(breadth));
  const breadthWinners = remaining1.filter((id)=>breadth[id] === maxBreadth);
  if (breadthWinners.length === 1) {
    return {
      winnerId: breadthWinners[0],
      step: 2,
      name: 'breadth_of_support',
      detail: 'Most members found this option acceptable.'
    };
  }
  const remaining2 = breadthWinners;
  // Step 3 — Fairness credit
  const db = serviceClient();
  const fairnessScores = {};
  for (const id of remaining2)fairnessScores[id] = 0;
  for (const ballot of active){
    const p = ballot.payload;
    let preferred = null;
    if (poll.strategy === 'majority') preferred = p.optionId;
    else if (poll.strategy === 'ranked_irv' || poll.strategy === 'borda') preferred = (p.ranking ?? [])[0] ?? null;
    else if (poll.strategy === 'score') {
      const scores = p.scores ?? {};
      let best = null;
      let bestScore = -1;
      for (const [oid, s] of Object.entries(scores)){
        if (s > bestScore) {
          bestScore = s;
          best = oid;
        }
      }
      preferred = best;
    } else if (poll.strategy === 'approval') preferred = (p.optionIds ?? [])[0] ?? null;
    if (preferred && remaining2.includes(preferred)) {
      const rolling = await getRollingSatisfaction(db, poll.trip_id, ballot.member_id);
      fairnessScores[preferred] += 1 - rolling;
    }
  }
  const maxFairness = Math.max(...Object.values(fairnessScores));
  const fairnessWinners = remaining2.filter((id)=>Math.abs(fairnessScores[id] - maxFairness) < 0.001);
  if (fairnessWinners.length === 1) {
    return {
      winnerId: fairnessWinners[0],
      step: 3,
      name: 'fairness_credit',
      detail: 'Favors members who have been losing recently.'
    };
  }
  const remaining3 = fairnessWinners;
  // Step 4 — Budget fit
  if (bandHigh !== undefined) {
    const withinBand = remaining3.filter((id)=>{
      const opt = options.find((o)=>o.id === id);
      return opt?.cost_per_person_minor !== null && opt.cost_per_person_minor <= bandHigh;
    });
    if (withinBand.length === 1) {
      return {
        winnerId: withinBand[0],
        step: 4,
        name: 'budget_fit',
        detail: 'Within or below the group budget band.'
      };
    }
    if (withinBand.length > 1) {
      withinBand.sort((a, b)=>{
        const oa = options.find((o)=>o.id === a);
        const ob = options.find((o)=>o.id === b);
        return (oa.cost_per_person_minor ?? 0) - (ob.cost_per_person_minor ?? 0);
      });
      return {
        winnerId: withinBand[0],
        step: 4,
        name: 'budget_fit',
        detail: 'Lowest cost within budget band.'
      };
    }
  }
  const remaining4 = remaining3;
  // Step 5 — Plan fit (stub)
  // 5G2 integration pending — skip
  const remaining5 = remaining4;
  // Step 6 — Organizer choice
  if (remaining5.length > 1) {
    return {
      winnerId: null,
      step: 6,
      name: 'organizer_choice',
      detail: 'Organizer must choose from remaining tied options.'
    };
  }
  // Step 7 — Seeded draw (fallback if somehow only 1 remains)
  const closedAt = new Date().toISOString();
  const seedInput = poll.id + closedAt;
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(seedInput));
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map((b)=>b.toString(16).padStart(2, '0')).join('');
  const sorted = [
    ...remaining5
  ].sort();
  const idx = parseInt(hashHex.substring(0, 8), 16) % sorted.length;
  return {
    winnerId: sorted[idx],
    step: 7,
    name: 'seeded_draw',
    detail: `Deterministic draw. Seed: ${hashHex.substring(0, 16)}`
  };
}
async function seededDraw(tiedOptionIds, pollId, closedAt) {
  const seedInput = pollId + closedAt;
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(seedInput));
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map((b)=>b.toString(16).padStart(2, '0')).join('');
  const sorted = [
    ...tiedOptionIds
  ].sort();
  const idx = parseInt(hashHex.substring(0, 8), 16) % sorted.length;
  return {
    winnerId: sorted[idx],
    seed: hashHex
  };
}
// ─── Satisfaction ─────────────────────────────────────────────────────────
function computeSatisfaction(ballot, winnerOptionId, strategy, options) {
  if (ballot.abstain) return 0.5;
  const p = ballot.payload;
  switch(strategy){
    case 'majority':
      return p.optionId === winnerOptionId ? 1 : 0;
    case 'approval':
      return (p.optionIds ?? []).includes(winnerOptionId) ? 1 : 0;
    case 'score':
      {
        const scores = p.scores ?? {};
        return (scores[winnerOptionId] ?? 0) / 5;
      }
    case 'ranked_irv':
    case 'borda':
      {
        const ranking = p.ranking ?? [];
        const n = options.length;
        const idx = ranking.indexOf(winnerOptionId);
        if (idx === -1) return 0;
        if (n <= 1) return 1;
        return 1 - idx / (n - 1);
      }
    case 'consensus':
      {
        const stances = p.stances ?? {};
        const stance = stances[winnerOptionId];
        if (stance === 'yes') return 1;
        if (stance === 'can_live_with') return 0.6;
        return 0;
      }
    default:
      return 0.5;
  }
}
async function getRollingSatisfaction(db, tripId, memberId) {
  const { data } = await db.from('satisfaction_ledger').select('satisfaction').eq('trip_id', tripId).eq('member_id', memberId).order('created_at', {
    ascending: false
  }).limit(10);
  if (!data || data.length === 0) return 0.5;
  const alpha = 0.3;
  let rolling = 0;
  let weight = alpha;
  let totalWeight = 0;
  for(let i = 0; i < data.length; i++){
    const w = alpha * Math.pow(1 - alpha, i);
    rolling += data[i].satisfaction * w;
    totalWeight += w;
  }
  return totalWeight > 0 ? rolling / totalWeight : 0.5;
}
// ─── Split proposal ──────────────────────────────────────────────────────
function proposeSplit(ballots, options, minGroupSize = 2) {
  const active = ballots.filter((b)=>!b.abstain);
  if (active.length < minGroupSize * 2) return [];
  // Build score vectors
  const vectors = {};
  for (const b of active){
    const p = b.payload;
    const vec = options.map((o, i)=>{
      if ('scores' in p) return (p.scores ?? {})[o.id] ?? 0;
      if ('ranking' in p) {
        const ranking = p.ranking ?? [];
        const idx = ranking.indexOf(o.id);
        return idx === -1 ? 0 : options.length - idx;
      }
      if ('optionIds' in p) return (p.optionIds ?? []).includes(o.id) ? 1 : 0;
      if ('optionId' in p) return p.optionId === o.id ? 1 : 0;
      return 0;
    });
    vectors[b.member_id] = vec;
  }
  const memberIds = Object.keys(vectors);
  if (memberIds.length < 2) return [];
  function distance(a, b) {
    return a.reduce((sum, v, i)=>sum + Math.abs(v - b[i]), 0);
  }
  // Pick 2 seeds that maximize distance
  let maxDist = -1;
  let seed1 = memberIds[0];
  let seed2 = memberIds[1];
  for(let i = 0; i < memberIds.length; i++){
    for(let j = i + 1; j < memberIds.length; j++){
      const d = distance(vectors[memberIds[i]], vectors[memberIds[j]]);
      if (d > maxDist) {
        maxDist = d;
        seed1 = memberIds[i];
        seed2 = memberIds[j];
      }
    }
  }
  // Assign each member to nearest seed
  const cluster1 = [];
  const cluster2 = [];
  for (const mid of memberIds){
    const d1 = distance(vectors[mid], vectors[seed1]);
    const d2 = distance(vectors[mid], vectors[seed2]);
    if (d1 <= d2) cluster1.push(mid);
    else cluster2.push(mid);
  }
  // Enforce minimum group size
  if (cluster1.length < minGroupSize || cluster2.length < minGroupSize) {
    // Merge smallest into largest — return single group (no split)
    return [];
  }
  // Find medoid for each cluster
  function medoid(cluster) {
    let best = cluster[0];
    let bestSum = Infinity;
    for (const a of cluster){
      const sum = cluster.reduce((s, b)=>s + distance(vectors[a], vectors[b]), 0);
      if (sum < bestSum) {
        bestSum = sum;
        best = a;
      }
    }
    // Map member medoid to preferred option
    const vec = vectors[best];
    let bestOpt = options[0].id;
    let bestScore = -1;
    for(let i = 0; i < options.length; i++){
      if (vec[i] > bestScore) {
        bestScore = vec[i];
        bestOpt = options[i].id;
      }
    }
    return bestOpt;
  }
  return [
    {
      optionId: medoid(cluster1),
      memberIds: cluster1
    },
    {
      optionId: medoid(cluster2),
      memberIds: cluster2
    }
  ];
}
// ─── Trip length ──────────────────────────────────────────────────────────
/**
 * The trip's REAL length in days, from trips.start_date / trips.end_date
 * (both DATE columns), inclusive of the first and last day. Returns null —
 * never a guess — when the read fails or either date is missing, so callers
 * can report "unknown" instead of inventing a trip length.
 *
 * Read with the service-role client, so the RLS policy added to trips is not
 * in play here; a null result means missing data or a real error, not a
 * permission filter.
 */ async function resolveTripDays(db, tripId) {
  const { data, error } = await db.from('trips').select('start_date, end_date').eq('id', tripId).maybeSingle();
  if (error) {
    console.error('[group-decisions] trip dates lookup failed for', tripId, '-', error.message);
    return null;
  }
  if (!data?.start_date || !data?.end_date) return null;
  const start = new Date(`${data.start_date}T00:00:00Z`).getTime();
  const end = new Date(`${data.end_date}T00:00:00Z`).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    console.error('[group-decisions] trip dates unusable for', tripId, '-', data.start_date, '->', data.end_date);
    return null;
  }
  return {
    days: Math.max(1, Math.round((end - start) / 86400000) + 1),
    source: `trips.start_date..end_date (${data.start_date}..${data.end_date})`
  };
}
// ─── Close logic ──────────────────────────────────────────────────────────
async function closePoll(db, poll, options, ballots) {
  const eligible = poll.eligible_member_ids.length;
  const voted = ballots.filter((b)=>!b.abstain).length;
  const abstained = ballots.filter((b)=>b.abstain).length;
  const participation = voted + abstained;
  const quorumMet = eligible === 0 || participation / eligible >= poll.quorum_pct / 100;
  if (!quorumMet) {
    const result = {
      status: 'no_quorum',
      tally: {},
      participation: {
        eligible,
        voted,
        abstained,
        quorumMet: false
      },
      explanation: `Quorum not met. ${participation} of ${eligible} eligible members participated.`
    };
    await db.from('polls_v2').update({
      status: 'closed',
      closed_at: new Date().toISOString(),
      result
    }).eq('id', poll.id);
    return result;
  }
  // Fetch budget band for above-band check
  //
  // FABRICATION FIX 2026-09-19 — two defects here.
  // (1) `: 7` invented a seven-day trip whenever the poll had no closes_at,
  //     and the step-4 "budget fit" tie-break then DECIDED the poll against a
  //     ceiling derived from that invented length. Even with a closes_at the
  //     figure used was the gap between poll creation and poll close — a
  //     polling window, not a trip. The band is now scaled by the trip's real
  //     length (trips.start_date..end_date); when that cannot be established
  //     the band is left undefined, step 4 is skipped, and the reason is
  //     reported in the result instead of papered over.
  // (2) The read sat inside `try {} catch (_) {}` and destructured `{ data }`
  //     only, so a failed budget_aggregates read was indistinguishable from
  //     "no band recorded". The error is now captured and reported.
  //
  // NOTE on RLS: budget_aggregates was made trip-member-gated with
  // private.is_trip_member(trip_id) on 2026-09-19. This function reads it
  // with the SERVICE-ROLE client (serviceClient()) and the table does not
  // FORCE row security, so that policy does not apply to these reads and
  // they are unaffected by the change.
  let bandHigh;
  let budgetBandBasis = 'not_evaluated';
  {
    const { data: budgetData, error: budgetErr } = await db.from('budget_aggregates').select('band').eq('trip_id', poll.trip_id).maybeSingle();
    if (budgetErr) {
      console.error('[group-decisions] budget_aggregates lookup failed for trip', poll.trip_id, '-', budgetErr.message);
      budgetBandBasis = `unavailable: budget_aggregates lookup failed (${budgetErr.message}); budget-fit tie-break skipped`;
    } else if (typeof budgetData?.band?.comfortPerDay?.high !== 'number') {
      budgetBandBasis = 'unavailable: no comfortPerDay.high budget band recorded for this trip; budget-fit tie-break skipped';
    } else {
      const tripDays = await resolveTripDays(db, poll.trip_id);
      if (tripDays === null) {
        budgetBandBasis = 'unavailable: trip length unknown (trips.start_date/end_date not both usable); budget-fit tie-break skipped rather than assume a trip length';
      } else {
        bandHigh = budgetData.band.comfortPerDay.high * tripDays.days;
        budgetBandBasis = `comfortPerDay.high x ${tripDays.days} day(s) from ${tripDays.source}`;
      }
    }
    console.log('[group-decisions] budget band basis for poll', poll.id, '-', budgetBandBasis);
  }
  let winnerId = null;
  let tally = {};
  let rounds;
  let tieBreak;
  const threshold = poll.pass_threshold_pct ?? 50;
  switch(poll.strategy){
    case 'majority':
      {
        const r = strategyMajority(ballots, options, threshold);
        winnerId = r.winnerId;
        tally = r.tally;
        break;
      }
    case 'approval':
      {
        const r = strategyApproval(ballots, options);
        winnerId = r.winnerId;
        tally = r.tally;
        break;
      }
    case 'score':
      {
        const r = strategyScore(ballots, options);
        winnerId = r.winnerId;
        tally = r.tally;
        break;
      }
    case 'ranked_irv':
      {
        const r = strategyRankedIrv(ballots, options);
        winnerId = r.winnerId;
        tally = r.tally;
        rounds = r.rounds;
        break;
      }
    case 'borda':
      {
        const r = strategyBorda(ballots, options);
        winnerId = r.winnerId;
        tally = r.tally;
        break;
      }
    case 'consensus':
      {
        const r = strategyConsensus(ballots, options, threshold);
        winnerId = r.winnerId;
        tally = r.tally;
        break;
      }
  }
  // Tie-break if needed
  if (winnerId === null && poll.strategy !== 'consensus') {
    const tiedIds = Object.keys(tally).length > 0 ? Object.entries(tally).filter(([, v])=>v === Math.max(...Object.values(tally))).map(([k])=>k) : options.map((o)=>o.id);
    const tb = await resolveTie(tiedIds, ballots, options, poll, bandHigh);
    if (tb.winnerId) {
      winnerId = tb.winnerId;
      tieBreak = {
        step: tb.step,
        name: tb.name,
        detail: tb.detail
      };
    } else if (tb.step === 6) {
      // Organizer must choose — keep poll open with partial result
      const partialResult = {
        status: 'winner',
        tally,
        rounds,
        tieBreak: {
          step: 6,
          name: 'organizer_choice',
          detail: tb.detail
        },
        participation: {
          eligible,
          voted,
          abstained,
          quorumMet
        },
        explanation: 'Tie could not be resolved automatically. Organizer must choose.'
      };
      await db.from('polls_v2').update({
        result: partialResult
      }).eq('id', poll.id);
      return partialResult;
    } else {
      // Seeded draw
      const closedAt = new Date().toISOString();
      const draw = await seededDraw(tiedIds, poll.id, closedAt);
      winnerId = draw.winnerId;
      tieBreak = {
        step: 7,
        name: 'seeded_draw',
        detail: `Deterministic draw. Seed: ${draw.seed.substring(0, 16)}`
      };
      await db.from('polls_v2').update({
        tie_break_seed: draw.seed
      }).eq('id', poll.id);
    }
  }
  // Split proposal
  let splitProposal;
  if (poll.allow_split && winnerId === null) {
    splitProposal = proposeSplit(ballots, options);
  }
  const closedAt = new Date().toISOString();
  // Compute satisfaction
  if (winnerId) {
    const upserts = ballots.map((b)=>({
        trip_id: poll.trip_id,
        member_id: b.member_id,
        poll_id: poll.id,
        satisfaction: computeSatisfaction(b, winnerId, poll.strategy, options),
        created_at: closedAt
      }));
    if (upserts.length > 0) {
      await db.from('satisfaction_ledger').upsert(upserts, {
        onConflict: 'poll_id,member_id'
      });
    }
  }
  const winnerLabel = options.find((o)=>o.id === winnerId)?.label ?? winnerId ?? 'unknown';
  const result = {
    status: winnerId ? 'winner' : splitProposal ? 'split' : poll.strategy === 'consensus' ? 'no_consensus' : 'no_quorum',
    winnerOptionId: winnerId ?? undefined,
    splitProposal,
    tally,
    rounds,
    tieBreak,
    participation: {
      eligible,
      voted,
      abstained,
      quorumMet
    },
    explanation: winnerId ? `"${winnerLabel}" won with ${tally[winnerId] ?? 'N/A'} points/votes.` : splitProposal ? 'No consensus reached. A split proposal has been generated.' : 'No winner could be determined.',
    budgetBandBasis
  };
  await db.from('polls_v2').update({
    status: 'closed',
    closed_at: closedAt,
    result
  }).eq('id', poll.id);
  return result;
}
// ─── Route handlers ────────────────────────────────────────────────────────
async function handleCreatePoll(req, db, user) {
  const body = await req.json();
  const { tripId, question, description, strategy, options: optionsInput, quorumPct, passThresholdPct, secret, closesAt, allowSplit, linkedRef, eligibleMemberIds } = body;
  if (!tripId || !question || !optionsInput?.length) {
    return err('tripId, question, and options are required', 400, undefined, req);
  }
  const membership = await checkTripMembership(db, user.id, tripId);
  if (!membership) return err('Not a member of this trip', 404, undefined, req);
  if (membership.role === 'viewer') return err('Viewers cannot create polls', 403, undefined, req);
  const memberId = membership.memberId;
  // Suggest strategy
  const resolvedStrategy = strategy ?? (optionsInput.length === 2 ? 'majority' : optionsInput.length <= 6 ? 'score' : 'ranked_irv');
  // Fetch eligible members
  let resolvedEligible = eligibleMemberIds ?? [];
  if (!resolvedEligible.length) {
    const { data: members } = await db.from('trip_members').select('id').eq('trip_id', tripId).is('removed_at', null);
    resolvedEligible = members?.map((m)=>m.id) ?? [
      memberId
    ];
  }
  // Fetch budget band for above-band tagging
  //
  // FABRICATION FIX 2026-09-19 — same pair of defects as closePoll: `: 7`
  // invented a seven-day trip when the poll had no closesAt (and otherwise
  // used the time until the poll closes, which is not a trip length either),
  // and an option was then tagged "above band" against that invented basis.
  // The error was discarded by `try {} catch (_) {}` plus a `{ data }`-only
  // destructure. Now: the trip's real length, or no tagging at all with the
  // reason recorded on each option. See the RLS note in closePoll — this is
  // the service-role client, so the new is_trip_member() policy on
  // budget_aggregates does not filter these reads.
  let bandHighMinor;
  let aboveBandBasis = 'not_evaluated';
  {
    const { data: budgetData, error: budgetErr } = await db.from('budget_aggregates').select('band').eq('trip_id', tripId).maybeSingle();
    if (budgetErr) {
      console.error('[group-decisions] budget_aggregates lookup failed for trip', tripId, '-', budgetErr.message);
      aboveBandBasis = `not_evaluated: budget_aggregates lookup failed (${budgetErr.message})`;
    } else if (typeof budgetData?.band?.comfortPerDay?.high !== 'number') {
      aboveBandBasis = 'not_evaluated: no comfortPerDay.high budget band recorded for this trip';
    } else {
      const tripDays = await resolveTripDays(db, tripId);
      if (tripDays === null) {
        aboveBandBasis = 'not_evaluated: trip length unknown (trips.start_date/end_date not both usable)';
      } else {
        bandHighMinor = budgetData.band.comfortPerDay.high * tripDays.days;
        aboveBandBasis = `comfortPerDay.high x ${tripDays.days} day(s) from ${tripDays.source}`;
      }
    }
    console.log('[group-decisions] above-band basis for new poll on trip', tripId, '-', aboveBandBasis);
  }
  // Fetch agreement responses for dealbreaker check
  //
  // SCHEMA + FABRICATION FIX 2026-09-19 — this selected `answer,visibility`
  // from agreement_responses. There is no `answer` column: the answer lives
  // in `value_enc`. Postgres rejected the whole query with 42703 every time,
  // and the error was discarded twice over — `{ data }` dropped it, and the
  // whole block sat inside `try {} catch (_) {}`. So `agreementResponses` was
  // ALWAYS `[]`, `dealbreakerFlag` was ALWAYS false, and every option ever
  // created was silently stamped as carrying no dealbreaker. The check has
  // never once fired.
  //
  // The deeper problem is that the check as written cannot work here at all.
  // `value_enc` is AES-GCM ciphertext written by agreement-engine under a key
  // derived from AGREEMENT_MASTER_KEY + trip id + member id. This function
  // holds no master key and has no decryption path, so it cannot substring-
  // match an option label against the answers. Rather than keep reporting a
  // check that never ran as a clean pass, report its real status: count the
  // shared/aggregate responses that EXIST (that much is readable) and record
  // the outcome as `unavailable_encrypted`, so a caller can tell "nothing was
  // screened" from "screened and clear". The old always-false
  // `dealbreaker_flag` key is gone; it only ever meant "not checked".
  let dealbreakerStatus = 'no_responses';
  let dealbreakerDetail = 'No shared or aggregate agreement responses exist for this trip, so there was nothing to screen these options against.';
  {
    const { data: arRows, error: arErr } = await db.from('agreement_responses').select('member_id, question_id, visibility, value_enc').eq('trip_id', tripId).in('visibility', [
      'shared',
      'aggregate'
    ]);
    if (arErr) {
      console.error('[group-decisions] agreement_responses lookup failed for trip', tripId, '-', arErr.message);
      dealbreakerStatus = 'lookup_failed';
      dealbreakerDetail = `Agreement responses could not be read (${arErr.message}), so these options were NOT screened against the group's stated dealbreakers.`;
    } else if ((arRows ?? []).length > 0) {
      dealbreakerStatus = 'unavailable_encrypted';
      dealbreakerDetail = `${(arRows ?? []).length} shared/aggregate agreement response(s) exist for this trip, but they are stored encrypted in agreement_responses.value_enc and this function cannot decrypt them, so these options were NOT screened against them.`;
    }
    console.log('[group-decisions] dealbreaker screening for trip', tripId, '-', dealbreakerStatus, '-', dealbreakerDetail);
  }
  const pollId = generateId('poll');
  const now = new Date().toISOString();
  const { error: pollError } = await db.from('polls_v2').insert({
    id: pollId,
    trip_id: tripId,
    question,
    description: description ?? null,
    strategy: resolvedStrategy,
    quorum_pct: quorumPct ?? 60,
    pass_threshold_pct: passThresholdPct ?? null,
    secret: secret ?? false,
    eligible_member_ids: resolvedEligible,
    closes_at: closesAt ?? null,
    allow_split: allowSplit ?? false,
    linked_ref: linkedRef ?? null,
    status: 'open',
    created_by: memberId,
    created_at: now
  });
  if (pollError) {
    console.log('[group-decisions] poll insert error', pollError);
    return err(pollError.message, 500, undefined, req);
  }
  const optionRows = optionsInput.map((o, i)=>{
    const cost = o.costPerPersonMinor;
    // `above_band` is only ever true when a band was actually established;
    // `above_band_basis` says what it was measured against, or why it was not
    // evaluated. `dealbreaker_check` replaces the old always-false
    // `dealbreaker_flag` (see the note above the agreement_responses read).
    const aboveBand = bandHighMinor !== undefined && cost !== undefined && cost > bandHighMinor;
    return {
      id: generateId('opt'),
      poll_id: pollId,
      label: o.label,
      cost_per_person_minor: cost ?? null,
      cost_currency: o.costCurrency ?? null,
      opt_in: o.optIn ?? false,
      sort: i,
      // Extra fields stored in linked_ref extension
      linked_ref: {
        ...o.linkedRef ?? {},
        above_band: aboveBand,
        above_band_basis: aboveBandBasis,
        dealbreaker_check: dealbreakerStatus,
        dealbreaker_check_detail: dealbreakerDetail
      }
    };
  });
  const { error: optError } = await db.from('poll_options_v2').insert(optionRows);
  if (optError) {
    console.log('[group-decisions] options insert error', optError);
    return err(optError.message, 500, undefined, req);
  }
  const { data: poll } = await db.from('polls_v2').select('*').eq('id', pollId).single();
  const { data: opts } = await db.from('poll_options_v2').select('*').eq('poll_id', pollId).order('sort');
  console.log('[group-decisions] created poll', pollId, 'strategy', resolvedStrategy);
  return json({
    poll,
    options: opts
  }, 201, req);
}
async function handleListPolls(req, db, user) {
  const url = new URL(req.url);
  const tripId = url.searchParams.get('tripId');
  const status = url.searchParams.get('status');
  if (!tripId) return err('tripId is required', 400, undefined, req);
  const membership = await checkTripMembership(db, user.id, tripId);
  if (!membership) return err('Not a member of this trip', 404, undefined, req);
  // Auto-close expired polls
  const now = new Date().toISOString();
  const { data: expiredPolls } = await db.from('polls_v2').select('*').eq('trip_id', tripId).eq('status', 'open').lt('closes_at', now).not('closes_at', 'is', null);
  for (const ep of expiredPolls ?? []){
    const { data: opts } = await db.from('poll_options_v2').select('*').eq('poll_id', ep.id).order('sort');
    const { data: ballots } = await db.from('ballots_v2').select('*').eq('poll_id', ep.id);
    if (opts && ballots) {
      await closePoll(db, ep, opts, ballots);
    }
  }
  let query = db.from('polls_v2').select('*').eq('trip_id', tripId);
  if (status) query = query.eq('status', status);
  query = query.order('created_at', {
    ascending: false
  });
  const { data: polls, error } = await query;
  if (error) return err(error.message, 500, undefined, req);
  const enriched = await Promise.all((polls ?? []).map(async (poll)=>{
    const { data: opts } = await db.from('poll_options_v2').select('*').eq('poll_id', poll.id).order('sort');
    const { count } = await db.from('ballots_v2').select('*', {
      count: 'exact',
      head: true
    }).eq('poll_id', poll.id);
    const { data: myBallot } = await db.from('ballots_v2').select('payload,abstain,updated_at').eq('poll_id', poll.id).eq('member_id', membership.memberId).maybeSingle();
    return {
      ...poll,
      options: opts ?? [],
      ballotCount: count ?? 0,
      myBallot: poll.secret && poll.status === 'open' ? null : myBallot
    };
  }));
  return json(enriched, 200, req);
}
async function handleGetPoll(req, db, user, pollId) {
  const { data: poll, error } = await db.from('polls_v2').select('*').eq('id', pollId).maybeSingle();
  if (error || !poll) return err('Poll not found', 404, undefined, req);
  const membership = await checkTripMembership(db, user.id, poll.trip_id);
  if (!membership) return err('Not a member of this trip', 404, undefined, req);
  const { data: opts } = await db.from('poll_options_v2').select('*').eq('poll_id', pollId).order('sort');
  const { count } = await db.from('ballots_v2').select('*', {
    count: 'exact',
    head: true
  }).eq('poll_id', pollId);
  const { data: myBallot } = await db.from('ballots_v2').select('payload,abstain,updated_at').eq('poll_id', pollId).eq('member_id', membership.memberId).maybeSingle();
  let ballots = null;
  if (poll.status === 'closed' && !poll.secret) {
    const { data } = await db.from('ballots_v2').select('*').eq('poll_id', pollId);
    ballots = data;
  }
  return json({
    ...poll,
    options: opts ?? [],
    ballotCount: count ?? 0,
    myBallot: poll.secret && poll.status === 'open' ? null : myBallot,
    ballots: ballots
  }, 200, req);
}
async function handleCastBallot(req, db, user, pollId) {
  const body = await req.json();
  const { data: poll, error } = await db.from('polls_v2').select('*').eq('id', pollId).maybeSingle();
  if (error || !poll) return err('Poll not found', 404, undefined, req);
  const membership = await checkTripMembership(db, user.id, poll.trip_id);
  if (!membership) return err('Not a member of this trip', 404, undefined, req);
  if (poll.status !== 'open') return err('Poll is closed', 409, 'POLL_CLOSED', req);
  if (poll.closes_at && new Date(poll.closes_at) < new Date()) {
    return err('Poll has expired', 409, 'POLL_CLOSED', req);
  }
  const memberId = membership.memberId;
  if (poll.eligible_member_ids.length > 0 && !poll.eligible_member_ids.includes(memberId)) {
    return err('You are not eligible to vote in this poll', 403, undefined, req);
  }
  const isAbstain = body.abstain === true;
  const payload = isAbstain ? {
    strategy: poll.strategy,
    ...poll.strategy === 'majority' ? {
      optionId: ''
    } : poll.strategy === 'approval' ? {
      optionIds: []
    } : poll.strategy === 'score' ? {
      scores: {}
    } : poll.strategy === 'consensus' ? {
      stances: {}
    } : {
      ranking: []
    }
  } : body;
  const now = new Date().toISOString();
  const { error: upsertError } = await db.from('ballots_v2').upsert({
    poll_id: pollId,
    member_id: memberId,
    payload,
    abstain: isAbstain,
    updated_at: now
  }, {
    onConflict: 'poll_id,member_id'
  });
  if (upsertError) return err(upsertError.message, 500, undefined, req);
  console.log('[group-decisions] ballot cast', pollId, memberId);
  return json({
    success: true,
    updatedAt: now
  }, 200, req);
}
async function handleClosePoll(req, db, user, pollId) {
  const { data: poll, error } = await db.from('polls_v2').select('*').eq('id', pollId).maybeSingle();
  if (error || !poll) return err('Poll not found', 404, undefined, req);
  const membership = await checkTripMembership(db, user.id, poll.trip_id);
  if (!membership) return err('Not a member of this trip', 404, undefined, req);
  if (membership.memberId !== poll.created_by && membership.role !== 'organizer' && membership.role !== 'admin') {
    return err('Only the poll creator or trip organizer can close this poll', 403, undefined, req);
  }
  if (poll.status !== 'open') return err('Poll is already closed', 409, 'POLL_CLOSED', req);
  const { data: opts } = await db.from('poll_options_v2').select('*').eq('poll_id', pollId).order('sort');
  const { data: ballots } = await db.from('ballots_v2').select('*').eq('poll_id', pollId);
  const eligible = poll.eligible_member_ids.length;
  const voted = (ballots ?? []).filter((b)=>!b.abstain).length;
  const abstained = (ballots ?? []).filter((b)=>b.abstain).length;
  const participation = voted + abstained;
  const quorumMet = eligible === 0 || participation / eligible >= poll.quorum_pct / 100;
  if (!quorumMet) {
    if (!poll.extended_once) {
      const newClosesAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      await db.from('polls_v2').update({
        closes_at: newClosesAt,
        extended_once: true
      }).eq('id', pollId);
      console.log('[group-decisions] poll extended', pollId, newClosesAt);
      return json({
        extended: true,
        newClosesAt
      }, 200, req);
    }
  }
  const result = await closePoll(db, poll, opts ?? [], ballots ?? []);
  console.log('[group-decisions] poll closed', pollId, result.status);
  return json(result, 200, req);
}
async function handleOrganizerChoice(req, db, user, pollId) {
  const body = await req.json();
  const { optionId } = body;
  if (!optionId) return err('optionId is required', 400, undefined, req);
  const { data: poll, error } = await db.from('polls_v2').select('*').eq('id', pollId).maybeSingle();
  if (error || !poll) return err('Poll not found', 404, undefined, req);
  const membership = await checkTripMembership(db, user.id, poll.trip_id);
  if (!membership) return err('Not a member of this trip', 404, undefined, req);
  if (membership.role !== 'organizer' && membership.role !== 'admin') {
    return err('Only the trip organizer can make this choice', 403, undefined, req);
  }
  const currentResult = poll.result;
  if (!currentResult || currentResult.tieBreak?.step !== 6) {
    return err('Organizer choice is only allowed when a tie is at step 6', 409, 'NOT_AT_ORGANIZER_STEP', req);
  }
  const { data: opts } = await db.from('poll_options_v2').select('*').eq('poll_id', pollId).order('sort');
  const { data: ballots } = await db.from('ballots_v2').select('*').eq('poll_id', pollId);
  const closedAt = new Date().toISOString();
  const options = opts ?? [];
  const ballotsArr = ballots ?? [];
  // Compute satisfaction
  const upserts = ballotsArr.map((b)=>({
      trip_id: poll.trip_id,
      member_id: b.member_id,
      poll_id: poll.id,
      satisfaction: computeSatisfaction(b, optionId, poll.strategy, options),
      created_at: closedAt
    }));
  if (upserts.length > 0) {
    await db.from('satisfaction_ledger').upsert(upserts, {
      onConflict: 'poll_id,member_id'
    });
  }
  const winnerLabel = options.find((o)=>o.id === optionId)?.label ?? optionId;
  const result = {
    ...currentResult,
    status: 'winner',
    winnerOptionId: optionId,
    tieBreak: {
      step: 7,
      name: 'organizer_chose',
      detail: `Organizer selected "${winnerLabel}" after step-6 tie.`
    },
    explanation: `Organizer chose "${winnerLabel}" to resolve the tie.`
  };
  await db.from('polls_v2').update({
    status: 'closed',
    closed_at: closedAt,
    result
  }).eq('id', pollId);
  console.log('[group-decisions] organizer choice', pollId, optionId);
  return json(result, 200, req);
}
async function handleSplitAccept(req, db, user, pollId) {
  const body = await req.json();
  const { optionId } = body;
  if (!optionId) return err('optionId is required', 400, undefined, req);
  const { data: poll, error } = await db.from('polls_v2').select('*').eq('id', pollId).maybeSingle();
  if (error || !poll) return err('Poll not found', 404, undefined, req);
  const membership = await checkTripMembership(db, user.id, poll.trip_id);
  if (!membership) return err('Not a member of this trip', 404, undefined, req);
  // Record acceptance in the result's splitProposal
  const currentResult = poll.result;
  if (!currentResult?.splitProposal) return err('No split proposal exists for this poll', 409, undefined, req);
  const memberId = membership.memberId;
  const updatedSplit = currentResult.splitProposal.map((group)=>{
    if (group.optionId === optionId && !group.memberIds.includes(memberId)) {
      return {
        ...group,
        memberIds: [
          ...group.memberIds,
          memberId
        ]
      };
    }
    // Remove from other groups
    return {
      ...group,
      memberIds: group.memberIds.filter((id)=>id !== memberId)
    };
  });
  await db.from('polls_v2').update({
    result: {
      ...currentResult,
      splitProposal: updatedSplit
    }
  }).eq('id', pollId);
  console.log('[group-decisions] split accept', pollId, memberId, optionId);
  return json({
    success: true
  }, 200, req);
}
async function handleFairnessMe(req, db, user) {
  const url = new URL(req.url);
  const tripId = url.searchParams.get('tripId');
  if (!tripId) return err('tripId is required', 400, undefined, req);
  const membership = await checkTripMembership(db, user.id, tripId);
  if (!membership) return err('Not a member of this trip', 404, undefined, req);
  const memberId = membership.memberId;
  const rolling = await getRollingSatisfaction(db, tripId, memberId);
  // Count wins/losses in last 10 closed polls
  const { data: recentLedger } = await db.from('satisfaction_ledger').select('satisfaction,poll_id').eq('trip_id', tripId).eq('member_id', memberId).order('created_at', {
    ascending: false
  }).limit(10);
  const wins = (recentLedger ?? []).filter((r)=>r.satisfaction >= 0.7).length;
  const losses = (recentLedger ?? []).filter((r)=>r.satisfaction < 0.4).length;
  const total = (recentLedger ?? []).length;
  const trend = total > 0 ? `You've gotten your way in ${wins} of the last ${total} decisions` : 'No decisions recorded yet';
  return json({
    rollingSatisfaction: rolling,
    winsLast10: wins,
    lossesLast10: losses,
    trend
  }, 200, req);
}
async function handleFairnessGroup(req, db, user) {
  const url = new URL(req.url);
  const tripId = url.searchParams.get('tripId');
  if (!tripId) return err('tripId is required', 400, undefined, req);
  const membership = await checkTripMembership(db, user.id, tripId);
  if (!membership) return err('Not a member of this trip', 404, undefined, req);
  const { data: members } = await db.from('trip_members').select('id').eq('trip_id', tripId).is('removed_at', null);
  const memberIds = members?.map((m)=>m.id) ?? [
    membership.memberId
  ];
  const satisfactions = await Promise.all(memberIds.map((mid)=>getRollingSatisfaction(db, tripId, mid)));
  const mean = satisfactions.reduce((a, b)=>a + b, 0) / satisfactions.length;
  const variance = satisfactions.reduce((a, b)=>a + Math.pow(b - mean, 2), 0) / satisfactions.length;
  const stdDev = Math.sqrt(variance);
  let indicator;
  let detail;
  if (stdDev < 0.1) {
    indicator = 'balanced';
    detail = 'Decisions have been fairly distributed across the group.';
  } else if (stdDev < 0.2) {
    indicator = 'some_imbalance';
    detail = 'Some members have been getting their preferences more often than others.';
  } else {
    indicator = 'significant_imbalance';
    detail = 'There is a notable imbalance in how decisions have gone for different members.';
  }
  return json({
    indicator,
    detail,
    stdDev
  }, 200, req);
}
// ─── Router ──────────────────────────────────────────────────────────────────
Deno.serve(async (req)=>{
  const corsHeaders = cors(req);
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders
    });
  }
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/group-decisions/, '');
  console.log('[group-decisions]', req.method, path);
  const user = await verifyJwt(req);
  if (!user) return err('Unauthorized', 401, undefined, req);
  const db = serviceClient();
  try {
    // POST /polls
    if (req.method === 'POST' && path === '/polls') {
      return await handleCreatePoll(req, db, user);
    }
    // GET /polls
    if (req.method === 'GET' && path === '/polls') {
      return await handleListPolls(req, db, user);
    }
    // GET /polls/:pollId
    const pollMatch = path.match(/^\/polls\/([^/]+)$/);
    if (req.method === 'GET' && pollMatch) {
      return await handleGetPoll(req, db, user, pollMatch[1]);
    }
    // PUT /polls/:pollId/ballot
    const ballotMatch = path.match(/^\/polls\/([^/]+)\/ballot$/);
    if (req.method === 'PUT' && ballotMatch) {
      return await handleCastBallot(req, db, user, ballotMatch[1]);
    }
    // POST /polls/:pollId/close
    const closeMatch = path.match(/^\/polls\/([^/]+)\/close$/);
    if (req.method === 'POST' && closeMatch) {
      return await handleClosePoll(req, db, user, closeMatch[1]);
    }
    // POST /polls/:pollId/organizer-choice
    const orgChoiceMatch = path.match(/^\/polls\/([^/]+)\/organizer-choice$/);
    if (req.method === 'POST' && orgChoiceMatch) {
      return await handleOrganizerChoice(req, db, user, orgChoiceMatch[1]);
    }
    // POST /polls/:pollId/split/accept
    const splitMatch = path.match(/^\/polls\/([^/]+)\/split\/accept$/);
    if (req.method === 'POST' && splitMatch) {
      return await handleSplitAccept(req, db, user, splitMatch[1]);
    }
    // GET /fairness/me
    if (req.method === 'GET' && path === '/fairness/me') {
      return await handleFairnessMe(req, db, user);
    }
    // GET /fairness/group
    if (req.method === 'GET' && path === '/fairness/group') {
      return await handleFairnessGroup(req, db, user);
    }
    return err('Not found', 404, undefined, req);
  } catch (e) {
    console.log('[group-decisions] unhandled error', e);
    return err('Internal server error', 500, undefined, req);
  }
});

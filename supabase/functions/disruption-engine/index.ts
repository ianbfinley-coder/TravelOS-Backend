// SECURITY 2026-09-17 — disruption-engine authenticated correctly on every
// client-facing route (every route but POST /scan called a real JWT check
// before touching data) but had two defects:
//
// 1. getUserFromRequest() built its verification client with
//    `Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!`
//    — the exact fail-open shape this codebase's audit flags elsewhere
//    (a missing ANON_KEY silently swaps in the service-role key). It still
//    called `.auth.getUser(token)` on the caller's own supplied token, so no
//    privilege escalation resulted in practice, but it duplicated a
//    hand-rolled gate instead of the shared, audited one. Replaced with
//    `requireUser` from `_shared/auth.ts`, which always uses
//    SUPABASE_ANON_KEY with no service-role fallback.
//
// 2. Every ownership failure ("not a trip member") returned 403 FORBIDDEN.
//    Combined with a client-supplied tripId, a caller could distinguish
//    "trip exists, not mine" (403) from "no such trip" (404) and enumerate
//    valid trip ids across POST /reports, GET /dependency-graph,
//    PATCH /items/:id/criticality, POST /disruptions/:id/dismiss,
//    GET /disruptions/:id and GET /disruptions. Changed all six to 404,
//    matching the house convention (requireTripOwner and 35+ other
//    functions here).
//
// NOT CHANGED, deliberately:
//   * POST /scan is pipeline-only, gated by a separate `SERVICE_KEY` /
//     `x-service-key` header check that fails closed (401) if the secret is
//     unset or does not match. No evidence was found in this codebase of
//     what invokes it (no pg_cron job in this project), so its auth
//     mechanism was left as-is rather than swapped for requireService and
//     risking breaking whatever external scheduler calls it.
//
// CORRECTNESS 2026-09-18 — platform_trips has been dropped and merged into
// trips; every formerly-TEXT trip_id column (including trip_members.trip_id)
// is now uuid FK'd to trips(id). There is exactly one trip identity now.
// This invalidates the 2026-09-17 note above about isTripMember's dual
// check: it is no longer "two genuinely different id spaces" — both
// branches queried the same uuid space, so an id that failed the
// trip_members lookup could still slip through the trips.user_id fallback
// (or vice versa) with no principled reason for the two to disagree.
// Replaced isTripMember with checkTripAccess(), which:
//   1. Does ONE authoritative existence check against `trips` (by id only,
//      no user filter) and surfaces/logs its error instead of discarding it,
//      returning 500 on a lookup failure and 404 when the trip truly does
//      not exist.
//   2. Then applies authorization as membership OR ownership, unchanged in
//      substance from before — trip_members (shared/group trips) and
//      trips.user_id (solo trips with no member row) are complementary
//      populations, not competing checks over the same one, so neither was
//      dropped. Every previously-discarded `error` on these paths (and on
//      the dep_nodes/dep_edges/disruption_cases/disruption_reports/
//      flight_signals writes and the reservations/trip_members reads
//      throughout this file) is now captured and logged.
//   3. `itinerary_items` was checked against the live schema and does not
//      exist in this project (information_schema.tables reports zero rows
//      for it in `public`). Every read of it below was already silently
//      swallowing its error; that error is now logged so this shows up in
//      function logs instead of vanishing.
//      [SUPERSEDED 2026-09-19: `itinerary_items` DOES exist in `public`
//      today — re-checked against information_schema.tables. Its columns are
//      id, trip_id, title, type, category, status, date, start_time,
//      end_time, timezone, duration_min, location, notes, country_code,
//      transport_mode, party_size, place_id, lat, lng, windows, fixed,
//      fixed_start, outdoor, must_do, starred, suggested, droppable,
//      critical, hold_minutes, energy_cost, member_ids, cancellation,
//      created_at, updated_at — every column this file reads off it is
//      present, and start_time/end_time are timestamptz, so the runScan
//      window filter on start_time is sound.]
//
// SCOPE CORRECTION 2026-09-18 — the migration described immediately above
// unified the TRIP id axis only. It was mistakenly read as covering the USER
// axis too, and it does not: `trip_members.user_id` is still TEXT FK'd to
// `platform_users(id)` and holds prefixed platform ids (`usr_<hex>`), while
// `requireUser` yields a Supabase auth uuid. The membership branch of
// checkTripAccess compared the auth uuid straight against that TEXT column,
// so it matched nothing and threw nothing; the trips.user_id owner branch
// (uuid vs uuid, correct) masked the failure for trip owners while every
// invited member was silently denied on all six client routes. The user axis
// is handled separately, below, by resolving the auth uuid through
// `resolvePlatformUserId` (auth_identities.provider_subject -> user_id)
// before the trip_members comparison. The owner branch is unchanged.
//
// ════════════════════════════════════════════════════════════════════════
// CROSS-FUNCTION CALLS 2026-09-19 — the flight-signal lookup in runScan() has
// never returned a single flight. Three separate defects, any one of which was
// fatal on its own.
//
// It called:
//   GET /functions/v1/provider-adapters?type=flight_status&ident=<IDENT>
//       Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>
//
//   1. WRONG CREDENTIAL. provider-adapters authenticates with
//      `supabase.auth.getUser(token)` and returns 401 {"error":"Unauthorized"}
//      when that resolves to no user. The service-role JWT has no `sub`, so it
//      resolves to nobody. Every call was a 401 before any routing happened.
//   2. WRONG ROUTE. provider-adapters is a path router: the flight endpoint is
//      `GET /provider-adapters/flight?ident=...&scheduledOut=...`. There is no
//      `type=` query parameter anywhere in it, and with no path segment the
//      request falls through every route to a 404. So even with a valid user
//      JWT this was a 404.
//   3. RESPONSE SHAPE NOT CHECKED. The old code did `flightData = json.data ??
//      json`. provider-adapters returns a ProviderResult —
//      `{ data, status: 'ok'|'stale'|'unavailable'|'mock', provenance,
//      safeFailureMessage? }` — and on an upstream failure or a missing
//      FLIGHTAWARE_API_KEY it returns `{ data: null, status: 'unavailable' }`
//      with HTTP 200. The `?? json` fallback would then have assigned the
//      entire envelope object as if it were flight data, and
//      `predictedDelay()` would have read undefined times off it and cached
//      that envelope into flight_signals. It now requires status 'ok' or
//      'stale' AND a non-null `data`, and caches nothing otherwise.
//
// Because `resp.ok` was false on every call, `flightData` stayed null, the loop
// hit `if (!flightData) continue;`, and the scan silently examined zero
// flights. No error was ever logged: the catch below only fires on a transport
// error, and a 401/404 is a successful fetch.
//
// CREDENTIAL, NOW. provider-adapters is user-JWT-only and there is no service
// path to use, so the caller's own Authorization header is forwarded when there
// is one. POST /scan is gated by `x-service-key`, not by a JWT, so on the
// normal pipeline invocation there is NO user header to forward. That case is
// not papered over: the scan logs, once per scan, that live flight lookups are
// unavailable, uses only whatever is already cached in flight_signals
// (regardless of age — flagged as stale in the log), and invents nothing. A
// caller that does supply a user Authorization header gets live lookups.
//
// TO MAKE THE PIPELINE SCAN WORK PROPERLY, provider-adapters (outside this
// function — not changed here) needs a service path: replace its
// `authenticate()` gate with `requireUserOrService` from `_shared/auth.ts` and
// treat a `kind === 'service'` caller as non-staff (so `/health` stays
// staff-only) while letting the read-only provider routes through. Its data
// routes are not user-scoped — they take lat/lon/ident and return third-party
// data — so a service caller needs no per-user authorization there.
//
// ERROR LEAKAGE 2026-09-20 — four routes returned the raw PostgREST error
// string straight to the caller: `errResp('DB_ERROR', error.message, 500)` on
// the dep_nodes criticality update, the disruption_cases dismiss update, the
// single-case read and the case list. A PostgREST message names the table, the
// column, the constraint and sometimes the offending value, so each of those
// responses handed a caller a free fragment of the schema map — and handed an
// ordinary user a sentence they could do nothing with. The detail belongs in
// the function log, where an operator can read it and an attacker cannot; the
// body now says only which operation failed, in the caller's own terms. Status
// codes are untouched: all four were already 500s on a query failure, and the
// single-case route still distinguishes a failed query (500) from an absent
// row (404) rather than collapsing both.
// ════════════════════════════════════════════════════════════════════════
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { requireUser, resolvePlatformUserId, corsHeaders } from './_shared/auth.ts';
// ---------------------------------------------------------------------------
// ULID generator (no external dep)
// ---------------------------------------------------------------------------
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function ulid() {
  const now = Date.now();
  let timeStr = '';
  let t = now;
  for(let i = 9; i >= 0; i--){
    timeStr = ENCODING[t % 32] + timeStr;
    t = Math.floor(t / 32);
  }
  let randStr = '';
  for(let i = 0; i < 16; i++){
    randStr += ENCODING[Math.floor(Math.random() * 32)];
  }
  return timeStr + randStr;
}
function newId(prefix) {
  return `${prefix}${ulid()}`;
}
// ---------------------------------------------------------------------------
// Supabase client helpers
// ---------------------------------------------------------------------------
function serviceClient() {
  return createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: {
      persistSession: false
    }
  });
}
// SECURITY 2026-09-17 — delegates to the shared, audited requireUser instead
// of a hand-rolled check that fell back to the service-role key when
// SUPABASE_ANON_KEY was unset. See file-header comment.
async function getUserFromRequest(req) {
  const result = await requireUser(req);
  if (result instanceof Response) return null;
  return {
    id: result.userId
  };
}
async function checkTripAccess(db, tripId, userId) {
  const { data: trip, error: tripErr } = await db.from('trips').select('id').eq('id', tripId).maybeSingle();
  if (tripErr) {
    console.error('[disruption-engine] trip lookup failed:', tripErr.message);
    return {
      ok: false,
      dbError: true
    };
  }
  if (!trip) return {
    ok: false,
    dbError: false
  };
  const platformUserId = await resolvePlatformUserId(db, userId);
  if (!platformUserId) {
    console.error('[disruption-engine] no platform user id for auth user; treating as non-member:', userId);
  } else {
    const { data: member, error: memberErr } = await db.from('trip_members').select('id').eq('trip_id', tripId).eq('user_id', platformUserId).maybeSingle();
    if (memberErr) {
      console.error('[disruption-engine] trip_members membership lookup failed:', memberErr.message);
      return {
        ok: false,
        dbError: true
      };
    }
    if (member) return {
      ok: true
    };
  }
  const { data: owned, error: ownerErr } = await db.from('trips').select('id').eq('id', tripId).eq('user_id', userId).maybeSingle();
  if (ownerErr) {
    console.error('[disruption-engine] trip ownership lookup failed:', ownerErr.message);
    return {
      ok: false,
      dbError: true
    };
  }
  if (owned) return {
    ok: true
  };
  return {
    ok: false,
    dbError: false
  };
}
// ---------------------------------------------------------------------------
// Error response helper
// ---------------------------------------------------------------------------
function errResp(code, message, status = 400) {
  return new Response(JSON.stringify({
    error: {
      code,
      message
    }
  }), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json'
    }
  });
}
function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json'
    }
  });
}
// ---------------------------------------------------------------------------
// Predicted delay logic
// ---------------------------------------------------------------------------
function predictedDelay(outbound, inbound, aircraftBody) {
  const minTurn = aircraftBody === 'wide' ? 60 : 35;
  const scheduledOut = new Date(outbound.scheduledOut);
  const announcedOut = outbound.estimatedOut ? new Date(outbound.estimatedOut) : scheduledOut;
  let predictedOut = announcedOut;
  if (inbound?.estimatedIn) {
    const inboundReadyAt = new Date(new Date(inbound.estimatedIn).getTime() + minTurn * 60000);
    if (inboundReadyAt > predictedOut) predictedOut = inboundReadyAt;
  }
  const delayMinutes = Math.round((predictedOut.getTime() - scheduledOut.getTime()) / 60000);
  const confidence = outbound.status === 'Delayed' ? 'announced' : delayMinutes >= 15 ? 'predicted' : 'announced';
  return {
    predictedOut,
    delayMinutes,
    confidence
  };
}
// ---------------------------------------------------------------------------
// Impact propagation
// ---------------------------------------------------------------------------
function propagateImpacts(nodes, edges, changedNodeId, newEnd) {
  const nodeMap = new Map(nodes.map((n)=>[
      n.id,
      n
    ]));
  // Build adjacency list (downstream)
  const downstream = new Map();
  for (const e of edges){
    if (!downstream.has(e.from_node_id)) downstream.set(e.from_node_id, []);
    downstream.get(e.from_node_id).push({
      toId: e.to_node_id,
      minGap: e.min_gap_minutes
    });
  }
  // BFS/topological walk
  const impacts = [];
  const visited = new Set();
  const queue = [
    {
      nodeId: changedNodeId,
      upstreamEnd: newEnd
    }
  ];
  while(queue.length > 0){
    const { nodeId, upstreamEnd } = queue.shift();
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);
    const children = downstream.get(nodeId) ?? [];
    for (const { toId, minGap } of children){
      const child = nodeMap.get(toId);
      if (!child) continue;
      const arrivalAt = new Date(upstreamEnd.getTime() + minGap * 60000);
      const nodeStart = new Date(child.starts_at);
      const slackMinutes = Math.round((nodeStart.getTime() + child.hold_minutes * 60000 - arrivalAt.getTime()) / 60000);
      let status;
      if (slackMinutes >= 15) {
        status = 'ok';
      } else if (slackMinutes >= 0) {
        status = 'tight';
      } else if (slackMinutes >= -child.hold_minutes) {
        status = 'at_risk';
      } else {
        status = child.fixed ? 'cancelled' : 'missed';
      }
      impacts.push({
        nodeId: toId,
        refType: child.ref_type,
        refId: child.ref_id,
        status,
        slackMinutes,
        arrivalAt: arrivalAt.toISOString(),
        nonRefundableMinor: child.non_refundable_minor,
        nonRefundableCurrency: child.non_refundable_currency
      });
      // Propagate further downstream using arrivalAt as the new upstream end
      const childEnd = arrivalAt > new Date(child.ends_at) ? arrivalAt : new Date(child.ends_at);
      queue.push({
        nodeId: toId,
        upstreamEnd: childEnd
      });
    }
  }
  return impacts;
}
// ---------------------------------------------------------------------------
// Severity computation
// ---------------------------------------------------------------------------
function computeSeverity(impacts, nodes) {
  const nodeMap = new Map(nodes.map((n)=>[
      n.id,
      n
    ]));
  for (const imp of impacts){
    if (imp.status === 'missed' || imp.status === 'cancelled') return 'critical';
    const node = nodeMap.get(imp.nodeId);
    if (node?.critical && imp.status === 'at_risk') return 'critical';
  }
  for (const imp of impacts){
    if (imp.status === 'at_risk' || imp.status === 'tight') return 'warning';
  }
  return 'info';
}
// ---------------------------------------------------------------------------
// Time to act
// ---------------------------------------------------------------------------
function computeTimeToAct(impacts, nodes) {
  const nodeMap = new Map(nodes.map((n)=>[
      n.id,
      n
    ]));
  const candidates = [];
  for (const imp of impacts){
    if (imp.status === 'ok') continue;
    const node = nodeMap.get(imp.nodeId);
    if (!node) continue;
    const nodeStart = new Date(node.starts_at);
    // For connections: 45 min before departure
    if (node.ref_type === 'reservation') {
      candidates.push(new Date(nodeStart.getTime() - 45 * 60000));
    } else {
      // For restaurants/hotels: item start or 18:00 local
      candidates.push(nodeStart);
    }
  }
  if (candidates.length === 0) return null;
  return candidates.reduce((earliest, d)=>d < earliest ? d : earliest);
}
// ---------------------------------------------------------------------------
// Money at risk
// ---------------------------------------------------------------------------
function computeMoneyAtRisk(impacts) {
  let total = 0;
  let currency = 'USD';
  for (const imp of impacts){
    if (imp.status === 'missed' || imp.status === 'cancelled') {
      if (imp.nonRefundableMinor) {
        total += imp.nonRefundableMinor;
        if (imp.nonRefundableCurrency) currency = imp.nonRefundableCurrency;
      }
    }
  }
  return {
    minor: total,
    currency
  };
}
// ---------------------------------------------------------------------------
// Dependency graph builder
// ---------------------------------------------------------------------------
async function buildDependencyGraph(db, tripId) {
  // Fetch existing nodes
  const { data: existingNodes, error: existingNodesErr } = await db.from('dep_nodes').select('*').eq('trip_id', tripId);
  if (existingNodesErr) console.error('[disruption-engine] dep_nodes read failed:', existingNodesErr.message);
  const existingNodeMap = new Map((existingNodes ?? []).map((n)=>[
      n.ref_id,
      n
    ]));
  // Fetch reservations
  const { data: reservations, error: reservationsErr } = await db.from('reservations').select('*').eq('trip_id', tripId);
  if (reservationsErr) console.error('[disruption-engine] reservations read failed:', reservationsErr.message);
  // Fetch itinerary items
  const { data: itineraryItems, error: itineraryItemsErr } = await db.from('itinerary_items').select('*').eq('trip_id', tripId);
  if (itineraryItemsErr) console.error('[disruption-engine] itinerary_items read failed:', itineraryItemsErr.message);
  const upsertNodes = [];
  // COLUMN FIX 2026-09-19 — every field read off a reservation row below was
  // checked against information_schema.columns for `reservations`. That table
  // has start_date (date), start_time (time), end_date (date), end_time (time),
  // timezone, reservation_type, latitude, longitude, details (jsonb) and the
  // price columns. It does NOT have check_in, check_out, departure_time,
  // arrival_time, type, lat, lng, non_refundable_minor or currency — every one
  // of which this block read. The rows come from select('*'), so these were
  // silently `undefined` rather than a 42703; the effect was that EVERY
  // reservation node was written with `new Date()` as both its start and its
  // end — a fabricated schedule that the dependency graph, the delay
  // propagation and the money-at-risk calculation then all reasoned over as if
  // it were real — plus fixed:false, flexible:false, hold_minutes:0 and no
  // coordinates for every reservation regardless of type.
  const skippedForNoSchedule = [];
  for (const res of reservations ?? []){
    const existing = existingNodeMap.get(res.id);
    if (existing) continue; // preserve manual edits
    const resType = typeof res.reservation_type === 'string' ? res.reservation_type.toLowerCase() : '';
    // start_date is a date and start_time a bare time, so they are combined
    // into a timestamp. dep_nodes.tz carries the zone.
    const startsAt = res.start_date ? `${res.start_date}T${res.start_time ?? '00:00:00'}` : null;
    const endsAt = res.end_date ? `${res.end_date}T${res.end_time ?? '00:00:00'}` : startsAt;
    // dep_nodes.starts_at and .ends_at are NOT NULL. A reservation with no
    // dates has no place on a timeline, and substituting "now" would invent a
    // schedule. Skip it and report it.
    if (!startsAt || !endsAt) {
      skippedForNoSchedule.push(res.id);
      continue;
    }
    upsertNodes.push({
      id: newId('nod_'),
      trip_id: tripId,
      ref_type: 'reservation',
      ref_id: res.id,
      member_ids: [],
      starts_at: startsAt,
      ends_at: endsAt,
      tz: typeof res.timezone === 'string' && res.timezone ? res.timezone : 'UTC',
      fixed: resType === 'flight' || resType === 'train',
      flexible: resType === 'hotel' || resType === 'restaurant',
      critical: false,
      hold_minutes: resType === 'hotel' ? 120 : 0,
      lat: res.latitude ?? null,
      lng: res.longitude ?? null,
      // `reservations` carries no non-refundable amount. current_price_amount
      // is the booking price, not the unrecoverable portion of it, and the two
      // are not interchangeable — writing one into the other would overstate
      // money-at-risk on every disruption case. Left null until the schema
      // carries the real figure.
      non_refundable_minor: null,
      non_refundable_currency: null
    });
  }
  if (skippedForNoSchedule.length > 0) {
    console.warn(`[disruption-engine] buildDependencyGraph(${tripId}): skipped ${skippedForNoSchedule.length} ` + `reservation(s) with no start_date — they cannot be placed on the dependency graph: ` + skippedForNoSchedule.slice(0, 10).join(', '));
  }
  for (const item of itineraryItems ?? []){
    const existing = existingNodeMap.get(item.id);
    if (existing) continue;
    upsertNodes.push({
      id: newId('nod_'),
      trip_id: tripId,
      ref_type: 'itinerary_item',
      ref_id: item.id,
      member_ids: [],
      starts_at: item.start_time ?? item.starts_at ?? new Date().toISOString(),
      ends_at: item.end_time ?? item.ends_at ?? new Date().toISOString(),
      tz: item.timezone ?? 'UTC',
      fixed: false,
      flexible: true,
      critical: item.critical ?? false,
      hold_minutes: item.hold_minutes ?? 0,
      lat: item.lat ?? null,
      lng: item.lng ?? null,
      non_refundable_minor: null,
      non_refundable_currency: null
    });
  }
  if (upsertNodes.length > 0) {
    const { error: upsertNodesErr } = await db.from('dep_nodes').upsert(upsertNodes, {
      onConflict: 'id'
    });
    if (upsertNodesErr) console.error('[disruption-engine] dep_nodes upsert failed:', upsertNodesErr.message);
  }
  // Fetch all nodes now
  const { data: allNodes, error: allNodesErr } = await db.from('dep_nodes').select('*').eq('trip_id', tripId);
  if (allNodesErr) console.error('[disruption-engine] dep_nodes re-read failed:', allNodesErr.message);
  const nodes = allNodes ?? [];
  // Auto-build edges
  const { data: existingEdges, error: existingEdgesErr } = await db.from('dep_edges').select('*').eq('trip_id', tripId).eq('auto', true);
  if (existingEdgesErr) console.error('[disruption-engine] dep_edges read failed:', existingEdgesErr.message);
  // Delete stale auto edges and rebuild
  if ((existingEdges ?? []).length > 0) {
    const { error: deleteEdgesErr } = await db.from('dep_edges').delete().eq('trip_id', tripId).eq('auto', true);
    if (deleteEdgesErr) console.error('[disruption-engine] dep_edges delete failed:', deleteEdgesErr.message);
  }
  const newEdges = [];
  const sorted = [
    ...nodes
  ].sort((a, b)=>new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime());
  for(let i = 0; i < sorted.length; i++){
    for(let j = i + 1; j < sorted.length; j++){
      const from = sorted[i];
      const to = sorted[j];
      const fromEnd = new Date(from.ends_at);
      const toStart = new Date(to.starts_at);
      const gapMinutes = Math.round((toStart.getTime() - fromEnd.getTime()) / 60000);
      // Only create edges for items within 6 hours of each other
      if (gapMinutes < 0 || gapMinutes > 360) continue;
      let kind;
      let minGap;
      const samePlace = from.lat != null && to.lat != null && Math.abs(from.lat - to.lat) < 0.05 && Math.abs((from.lng ?? 0) - (to.lng ?? 0)) < 0.05;
      if (from.ref_type === 'reservation' && to.ref_type === 'reservation') {
        kind = 'connection';
        minGap = 60; // default domestic
      } else if (from.ref_type === 'reservation') {
        kind = 'requires_arrival';
        minGap = 60;
      } else if (samePlace) {
        kind = 'sequence';
        minGap = 0;
      } else {
        kind = 'transfer';
        minGap = 30;
      }
      newEdges.push({
        id: newId('edg_'),
        trip_id: tripId,
        from_node_id: from.id,
        to_node_id: to.id,
        kind,
        min_gap_minutes: minGap,
        auto: true
      });
    }
  }
  if (newEdges.length > 0) {
    const { error: insertEdgesErr } = await db.from('dep_edges').insert(newEdges);
    if (insertEdgesErr) console.error('[disruption-engine] dep_edges insert failed:', insertEdgesErr.message);
  }
  const { data: finalEdges, error: finalEdgesErr } = await db.from('dep_edges').select('*').eq('trip_id', tripId);
  if (finalEdgesErr) console.error('[disruption-engine] dep_edges final read failed:', finalEdgesErr.message);
  return {
    nodes,
    edges: finalEdges ?? []
  };
}
// ---------------------------------------------------------------------------
// Process a user report into a disruption case
// ---------------------------------------------------------------------------
async function processReport(db, tripId, refType, refId, kind, note) {
  const rootCause = {
    source: 'user_report',
    refType,
    refId,
    kind,
    note
  };
  // Check if open case already exists for this ref
  const { data: existing, error: existingErr } = await db.from('disruption_cases').select('*').eq('trip_id', tripId).eq('status', 'open').contains('root_cause', {
    refId
  }).maybeSingle();
  if (existingErr) console.error('[disruption-engine] disruption_cases lookup (processReport) failed:', existingErr.message);
  if (existing) {
    const history = [
      ...existing.history ?? [],
      {
        at: new Date().toISOString(),
        event: 'user_report',
        note
      }
    ];
    const { error: updateErr } = await db.from('disruption_cases').update({
      history,
      updated_at: new Date().toISOString()
    }).eq('id', existing.id);
    if (updateErr) console.error('[disruption-engine] disruption_cases update (processReport) failed:', updateErr.message);
    return;
  }
  const caseId = newId('dsc_');
  const { error: insertErr } = await db.from('disruption_cases').insert({
    id: caseId,
    trip_id: tripId,
    root_cause: rootCause,
    predicted: {
      confidence: 'reported'
    },
    impacts: [],
    money_at_risk_minor: 0,
    money_at_risk_currency: 'USD',
    severity: 'warning',
    status: 'open',
    history: [
      {
        at: new Date().toISOString(),
        event: 'created_from_report'
      }
    ]
  });
  if (insertErr) console.error('[disruption-engine] disruption_cases insert (processReport) failed:', insertErr.message);
}
// ---------------------------------------------------------------------------
// Notification helper
// ---------------------------------------------------------------------------
async function sendNotification(db, tripId, disruptionCase) {
  try {
    const { data: members, error: membersErr } = await db.from('trip_members').select('user_id').eq('trip_id', tripId);
    if (membersErr) console.error('[disruption-engine] trip_members read (sendNotification) failed:', membersErr.message);
    const userIds = (members ?? []).map((m)=>m.user_id);
    if (userIds.length === 0) return;
    const severity = disruptionCase.severity ?? 'info';
    if (severity === 'info') return; // info = in-app only
    const timeToAct = disruptionCase.time_to_act ? new Date(disruptionCase.time_to_act) : null;
    const hoursToAct = timeToAct ? (timeToAct.getTime() - Date.now()) / 3600000 : Infinity;
    const bypassQuietHours = severity === 'critical' && hoursToAct < 3 || severity === 'warning' && hoursToAct < 2;
    // notification-delivery dispatches on `action`; `send_direct` is the
    // action built for service-to-service callers like this one. `id_space`
    // is mandatory: trip_members.user_id holds platform `usr_` ids, so
    // 'platform' is correct here.
    const rootCause = disruptionCase.root_cause ?? {};
    const flightIdent = typeof rootCause.flightIdent === 'string' ? rootCause.flightIdent : null;
    const delayMinutes = typeof rootCause.delayMinutes === 'number' ? rootCause.delayMinutes : null;
    const reportedKind = typeof rootCause.kind === 'string' ? rootCause.kind.replace(/_/g, ' ') : null;
    const subject = flightIdent ?? (reportedKind ? `your ${reportedKind}` : 'your trip');
    const title = severity === 'critical' ? `Action needed: ${subject} disrupted` : `Heads up: ${subject} disrupted`;
    const messageParts = [];
    if (flightIdent && delayMinutes !== null) {
      messageParts.push(`${flightIdent} is running about ${delayMinutes} min late.`);
    } else if (flightIdent) {
      messageParts.push(`${flightIdent} has been disrupted.`);
    } else if (reportedKind) {
      messageParts.push(`A ${reportedKind} problem was reported on your trip.`);
    } else {
      messageParts.push('A disruption was detected on your trip.');
    }
    if (Number.isFinite(hoursToAct)) {
      messageParts.push(hoursToAct <= 1 ? 'Less than an hour left to act.' : `About ${Math.round(hoursToAct)}h left to act.`);
    }
    const moneyMinor = disruptionCase.money_at_risk_minor ?? 0;
    if (moneyMinor > 0) {
      messageParts.push(`${disruptionCase.money_at_risk_currency ?? 'USD'} ${(moneyMinor / 100).toFixed(2)} at risk.`);
    }
    messageParts.push('Open TravelOS to see your options.');
    const message = messageParts.join(' ');
    const priority = severity === 'critical' ? 'CRITICAL' : severity === 'warning' ? 'HIGH' : 'MEDIUM';
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const notifResp = await fetch(`${supabaseUrl}/functions/v1/notification-delivery`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`
      },
      body: JSON.stringify({
        action: 'send_direct',
        recipients: userIds,
        id_space: 'platform',
        title,
        message,
        tripId,
        data: {
          priority,
          theme: 'disruption',
          type: 'disruption',
          severity,
          bypassQuietHours,
          caseId: disruptionCase.id,
          rootCause: disruptionCase.root_cause,
          timeToAct: disruptionCase.time_to_act,
          moneyAtRisk: disruptionCase.money_at_risk_minor
        }
      })
    });
    // Never swallow the result: this call silently 400'd for its whole life
    // because the body carried no `action`. A 200 with resolved: 0 is also a
    // real outcome (auth_identities is sparsely bridged) and must be visible.
    const rawBody = await notifResp.text();
    let parsed = null;
    try {
      parsed = JSON.parse(rawBody);
    } catch  {}
    if (!notifResp.ok) {
      console.error('[disruption-engine] notification-delivery failed:', notifResp.status, rawBody);
    } else {
      const d = parsed?.data ?? {};
      console.log('[disruption-engine] notification-delivery ok:', JSON.stringify({
        requested: d.requested,
        resolved: d.resolved,
        delivered_inapp: d.delivered_inapp,
        delivered_push: d.delivered_push,
        unresolved: d.unresolved
      }));
    }
  } catch (e) {
    // A notification failure must not break the scan — but it is logged now.
    console.error('[disruption-engine] notification send failed', e);
  }
}
// ---------------------------------------------------------------------------
// Full scan logic
// ---------------------------------------------------------------------------
// CROSS-FUNCTION CALLS 2026-09-19 — `callerAuthHeader` added. provider-adapters
// is user-JWT-only, so the only credential this scan can present is the one its
// own caller presented. POST /scan is service-key gated and normally has none,
// in which case live flight lookups are reported as unavailable rather than
// faked. See the block comment at the top of this file.
async function runScan(db, callerAuthHeader) {
  const now = new Date();
  // Logged once per scan rather than once per flight.
  let flightLookupUnavailableLogged = false;
  const horizon = new Date(now.getTime() + 48 * 3600000);
  // Find trips with items in the next 48h
  const { data: upcomingItems, error: upcomingItemsErr } = await db.from('itinerary_items').select('trip_id').gte('start_time', now.toISOString()).lte('start_time', horizon.toISOString());
  if (upcomingItemsErr) console.error('[disruption-engine] itinerary_items read (runScan) failed:', upcomingItemsErr.message);
  // COLUMN FIX 2026-09-19 — this filtered `reservations.departure_time`, which
  // does not exist. Verified against information_schema.columns: the table has
  // start_date (date), start_time, end_date, end_time, timezone — no
  // departure_time at all. PostgREST rejects the WHOLE query with 42703 when a
  // filter names a missing column, so this returned zero rows on every scan and
  // reservations never contributed a single trip id to the scan set. (The error
  // was already logged below, which is how it was found.) Filtering on
  // start_date, a date column, so the bounds are compared as dates.
  const { data: upcomingRes, error: upcomingResErr } = await db.from('reservations').select('trip_id').gte('start_date', now.toISOString().slice(0, 10)).lte('start_date', horizon.toISOString().slice(0, 10));
  if (upcomingResErr) console.error('[disruption-engine] reservations read (runScan) failed:', upcomingResErr.message);
  const tripIds = [
    ...new Set([
      ...(upcomingItems ?? []).map((r)=>r.trip_id),
      ...(upcomingRes ?? []).map((r)=>r.trip_id)
    ])
  ];
  let totalCases = 0;
  for (const tripId of tripIds){
    try {
      // Build/refresh dependency graph
      const { nodes, edges } = await buildDependencyGraph(db, tripId);
      // Fetch flight reservations for this trip
      const { data: flightRes, error: flightResErr } = await db.from('reservations').select('*')// COLUMN FIX 2026-09-19 — `reservations.type` does not exist; the
      // column is `reservation_type`. A filter on a missing column is a 42703
      // that PostgREST applies to the whole query, so this returned nothing
      // on every scan. ilike because nothing in this project pins the casing
      // of reservation_type and the table is currently empty, so neither
      // 'flight' nor 'FLIGHT' can be assumed.
      .eq('trip_id', tripId).ilike('reservation_type', 'flight');
      if (flightResErr) console.error('[disruption-engine] reservations (flights) read failed:', flightResErr.message);
      for (const flight of flightRes ?? []){
        // COLUMN FIX 2026-09-19 — `reservations.flight_number` does not exist
        // either. Flight-specific fields live in the `details` jsonb column;
        // `confirmation_number` is the only top-level fallback.
        const flightDetails = flight.details ?? {};
        const flightIdent = (typeof flightDetails.flight_number === 'string' ? flightDetails.flight_number : null) ?? (typeof flightDetails.ident === 'string' ? flightDetails.ident : null) ?? flight.confirmation_number;
        if (!flightIdent) continue;
        // Try to get flight signal from cache or provider-adapters
        let flightData = null;
        const { data: cached, error: cachedErr } = await db.from('flight_signals').select('*').eq('flight_ident', flightIdent).eq('trip_id', tripId).maybeSingle();
        if (cachedErr) console.error('[disruption-engine] flight_signals cache read failed:', cachedErr.message);
        const cacheAge = cached ? (Date.now() - new Date(cached.polled_at).getTime()) / 60000 : Infinity;
        if (cached && cacheAge < 15) {
          flightData = cached.data;
        } else if (!callerAuthHeader) {
          // No user credential to present. provider-adapters will not accept
          // the service-role key (see the top-of-file note), so do not make a
          // call that is certain to 401. Report it, fall back to whatever is
          // cached even if stale, and invent nothing.
          if (!flightLookupUnavailableLogged) {
            console.error('[disruption-engine] live flight lookups unavailable for this scan: ' + 'provider-adapters requires a user JWT and this request carried no Authorization header. ' + 'Using cached flight_signals only.');
            flightLookupUnavailableLogged = true;
          }
          if (cached) {
            console.warn(`[disruption-engine] using STALE cached flight signal for ${flightIdent} ` + `(${Math.round(cacheAge)} min old); no live lookup was possible.`);
            flightData = cached.data;
          }
        } else {
          try {
            const supabaseUrl = Deno.env.get('SUPABASE_URL');
            // Correct route: GET /provider-adapters/flight?ident=...
            // Correct credential: the caller's own user JWT, forwarded.
            // COLUMN FIX 2026-09-19 — no `departure_time` column; build the
            // scheduled departure from start_date + start_time when present.
            const scheduledOut = flight.start_date ? `${flight.start_date}${flight.start_time ? `T${flight.start_time}` : ''}` : null;
            const flightUrl = `${supabaseUrl}/functions/v1/provider-adapters/flight` + `?ident=${encodeURIComponent(flightIdent)}` + (scheduledOut ? `&scheduledOut=${encodeURIComponent(String(scheduledOut))}` : '');
            const resp = await fetch(flightUrl, {
              headers: {
                Authorization: callerAuthHeader
              }
            });
            if (!resp.ok) {
              const body = await resp.text().catch(()=>'<unreadable body>');
              console.error(`[disruption-engine] provider-adapters /flight failed for ${flightIdent}: ` + `HTTP ${resp.status} ${body.slice(0, 300)}`);
              if (cached) flightData = cached.data;
            } else {
              // ProviderResult: { data, status, provenance, safeFailureMessage? }.
              // 'unavailable' arrives with HTTP 200 and data: null — it is NOT
              // flight data and must never be cached or reasoned over.
              const payload = await resp.json();
              const usable = (payload?.status === 'ok' || payload?.status === 'stale') && payload.data != null;
              if (!usable) {
                console.error(`[disruption-engine] provider-adapters /flight returned no usable data for ${flightIdent}: ` + `status=${payload?.status ?? 'missing'} ${payload?.safeFailureMessage ?? ''}`);
                if (cached) flightData = cached.data;
              } else {
                flightData = payload.data;
                // Cache it
                const { error: cacheUpsertErr } = await db.from('flight_signals').upsert({
                  flight_ident: flightIdent,
                  trip_id: tripId,
                  data: flightData,
                  polled_at: new Date().toISOString()
                });
                if (cacheUpsertErr) console.error('[disruption-engine] flight_signals upsert failed:', cacheUpsertErr.message);
              }
            }
          } catch (e) {
            console.error('[disruption-engine] provider-adapters /flight threw for', flightIdent, e instanceof Error ? e.message : String(e));
            if (cached) flightData = cached.data;
          }
        }
        if (!flightData) continue;
        // Determine aircraft body type
        const wideBodyTypes = [
          '777',
          '787',
          '747',
          '767',
          '380',
          '350',
          'A380',
          'B777',
          'B787'
        ];
        const aircraftBody = wideBodyTypes.some((t)=>(flightData.aircraftType ?? '').includes(t)) ? 'wide' : 'narrow';
        // Try to get inbound aircraft data
        let inboundData = null;
        // COLUMN FIX 2026-09-19 — `reservations.inbound_flight_ident` does not
        // exist; read it out of the `details` jsonb like the ident above.
        const inboundIdent = typeof flightDetails.inbound_flight_ident === 'string' ? flightDetails.inbound_flight_ident : null;
        if (inboundIdent) {
          const { data: inboundCached, error: inboundCachedErr } = await db.from('flight_signals').select('*').eq('flight_ident', inboundIdent).eq('trip_id', tripId).maybeSingle();
          if (inboundCachedErr) console.error('[disruption-engine] flight_signals inbound-cache read failed:', inboundCachedErr.message);
          if (inboundCached) inboundData = inboundCached.data;
        }
        const { predictedOut, delayMinutes, confidence } = predictedDelay(flightData, inboundData, aircraftBody);
        if (delayMinutes < 15) continue; // Not significant
        // Find the dep_node for this flight
        const flightNode = nodes.find((n)=>n.ref_id === flight.id);
        if (!flightNode) continue;
        const newEnd = new Date(predictedOut.getTime() + (new Date(flightData.scheduledIn).getTime() - new Date(flightData.scheduledOut).getTime()));
        const impacts = propagateImpacts(nodes, edges, flightNode.id, newEnd);
        const severity = computeSeverity(impacts, nodes);
        const timeToAct = computeTimeToAct(impacts, nodes);
        const { minor: moneyAtRisk, currency: moneyAtRiskCurrency } = computeMoneyAtRisk(impacts);
        const rootCause = {
          source: 'flight_signal',
          flightIdent,
          flightId: flight.id,
          delayMinutes,
          confidence,
          predictedOut: predictedOut.toISOString()
        };
        // Check for existing open case
        const { data: existingCase, error: existingCaseErr } = await db.from('disruption_cases').select('*').eq('trip_id', tripId).eq('status', 'open').contains('root_cause', {
          flightId: flight.id
        }).maybeSingle();
        if (existingCaseErr) console.error('[disruption-engine] disruption_cases lookup (runScan) failed:', existingCaseErr.message);
        const shouldNotify = (existing, newSeverity, newTimeToAct)=>{
          if (!existing) return true;
          if (existing.severity !== newSeverity) return true;
          if (newTimeToAct && existing.time_to_act) {
            const oldTta = new Date(existing.time_to_act);
            const diff = (oldTta.getTime() - newTimeToAct.getTime()) / 60000;
            if (diff >= 15) return true;
          }
          const oldImpactIds = new Set(existing.impacts.map((i)=>i.nodeId));
          const newImpactIds = impacts.map((i)=>i.nodeId);
          if (newImpactIds.some((id)=>!oldImpactIds.has(id))) return true;
          return false;
        };
        const caseData = {
          trip_id: tripId,
          root_cause: rootCause,
          predicted: {
            predictedOut: predictedOut.toISOString(),
            delayMinutes,
            confidence
          },
          impacts,
          money_at_risk_minor: moneyAtRisk,
          money_at_risk_currency: moneyAtRiskCurrency,
          time_to_act: timeToAct?.toISOString() ?? null,
          severity,
          status: 'open',
          updated_at: new Date().toISOString()
        };
        if (existingCase) {
          const notify = shouldNotify(existingCase, severity, timeToAct);
          const history = [
            ...existingCase.history ?? [],
            {
              at: new Date().toISOString(),
              event: 'updated',
              delayMinutes,
              severity
            }
          ];
          const { error: updateCaseErr } = await db.from('disruption_cases').update({
            ...caseData,
            history
          }).eq('id', existingCase.id);
          if (updateCaseErr) console.error('[disruption-engine] disruption_cases update (runScan) failed:', updateCaseErr.message);
          if (notify) {
            await sendNotification(db, tripId, {
              ...caseData,
              id: existingCase.id
            });
          }
        } else {
          const caseId = newId('dsc_');
          const history = [
            {
              at: new Date().toISOString(),
              event: 'created',
              delayMinutes,
              severity
            }
          ];
          const { error: insertCaseErr } = await db.from('disruption_cases').insert({
            id: caseId,
            ...caseData,
            history
          });
          if (insertCaseErr) console.error('[disruption-engine] disruption_cases insert (runScan) failed:', insertCaseErr.message);
          await sendNotification(db, tripId, {
            id: caseId,
            ...caseData
          });
          totalCases++;
        }
      }
    } catch (e) {
      console.error(`scan failed for trip ${tripId}:`, e);
    }
  }
  return {
    scanned: tripIds.length,
    cases: totalCases
  };
}
// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders
    });
  }
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/disruption-engine/, '');
  const method = req.method;
  // Internal scan endpoint — service key auth.
  // NOT CHANGED 2026-09-17: left on its existing SERVICE_KEY/x-service-key
  // check (fails closed) rather than moved to requireService — see
  // file-header comment for why.
  if (method === 'POST' && path === '/scan') {
    const serviceKey = Deno.env.get('SERVICE_KEY');
    const provided = req.headers.get('x-service-key');
    if (!serviceKey || provided !== serviceKey) {
      return errResp('UNAUTHORIZED', 'Invalid service key', 401);
    }
    const db = serviceClient();
    // CROSS-FUNCTION CALLS 2026-09-19 — forward whatever Authorization header
    // this request carried. /scan authenticates with x-service-key, so this is
    // normally absent and live flight lookups are reported unavailable rather
    // than attempted with a credential provider-adapters rejects.
    const result = await runScan(db, req.headers.get('Authorization'));
    return jsonResp(result);
  }
  // All other routes require JWT auth
  const user = await getUserFromRequest(req);
  if (!user) return errResp('UNAUTHORIZED', 'Authentication required', 401);
  const db = serviceClient();
  // POST /reports
  if (method === 'POST' && path === '/reports') {
    let body;
    try {
      body = await req.json();
    } catch  {
      return errResp('BAD_REQUEST', 'Invalid JSON body');
    }
    const { tripId, refType, refId, kind, note } = body;
    if (!tripId || !refType || !refId || !kind) {
      return errResp('BAD_REQUEST', 'tripId, refType, refId, kind are required');
    }
    const tripAccess = await checkTripAccess(db, tripId, user.id);
    if (!tripAccess.ok) {
      return tripAccess.dbError ? errResp('DB_ERROR', 'Failed to verify trip access', 500) : errResp('NOT_FOUND', 'Trip not found', 404);
    }
    // ID SPACE 2026-09-18 — `disruption_reports.reporter_id` is TEXT with no FK
    // (verified against information_schema.columns), so writing the raw auth
    // uuid here succeeded silently while storing a value nothing could join:
    // every other reporter-ish column in this schema holds a platform `usr_`
    // id. Resolve through auth_identities before the insert, and refuse the
    // write outright if the caller has no platform identity rather than
    // persisting an unusable id.
    const reporterId = await resolvePlatformUserId(db, user.id);
    if (!reporterId) {
      console.error('[disruption-engine] no platform user id for auth user; refusing report insert:', user.id);
      return errResp('NO_PLATFORM_IDENTITY', 'No platform identity for this account; cannot record report', 409);
    }
    const reportId = newId('rpt_');
    const { error: reportInsertErr } = await db.from('disruption_reports').insert({
      id: reportId,
      trip_id: tripId,
      reporter_id: reporterId,
      ref_type: refType,
      ref_id: refId,
      kind,
      note: note ?? null
    });
    if (reportInsertErr) {
      console.error('[disruption-engine] disruption_reports insert failed:', reportInsertErr.message);
      return errResp('DB_ERROR', 'Failed to record report', 500);
    }
    await processReport(db, tripId, refType, refId, kind, note);
    return jsonResp({
      id: reportId,
      status: 'received'
    }, 201);
  }
  // GET /dependency-graph?tripId=&memberId=
  if (method === 'GET' && path === '/dependency-graph') {
    const tripId = url.searchParams.get('tripId');
    const memberId = url.searchParams.get('memberId');
    if (!tripId) return errResp('BAD_REQUEST', 'tripId is required');
    const tripAccess = await checkTripAccess(db, tripId, user.id);
    if (!tripAccess.ok) {
      return tripAccess.dbError ? errResp('DB_ERROR', 'Failed to verify trip access', 500) : errResp('NOT_FOUND', 'Trip not found', 404);
    }
    const { nodes, edges } = await buildDependencyGraph(db, tripId);
    const filteredNodes = memberId ? nodes.filter((n)=>n.member_ids.includes(memberId)) : nodes;
    const filteredNodeIds = new Set(filteredNodes.map((n)=>n.id));
    const filteredEdges = memberId ? edges.filter((e)=>filteredNodeIds.has(e.from_node_id) && filteredNodeIds.has(e.to_node_id)) : edges;
    return jsonResp({
      nodes: filteredNodes,
      edges: filteredEdges
    });
  }
  // PATCH /items/:itemId/criticality
  const criticalityMatch = path.match(/^\/items\/([^/]+)\/criticality$/);
  if (method === 'PATCH' && criticalityMatch) {
    const itemId = criticalityMatch[1];
    let body;
    try {
      body = await req.json();
    } catch  {
      return errResp('BAD_REQUEST', 'Invalid JSON body');
    }
    // Find the node
    const { data: node, error: nodeErr } = await db.from('dep_nodes').select('*').eq('ref_id', itemId).maybeSingle();
    if (nodeErr) {
      console.error('[disruption-engine] dep_nodes lookup (criticality route) failed:', nodeErr.message);
      return errResp('DB_ERROR', 'Failed to look up node', 500);
    }
    if (!node) return errResp('NOT_FOUND', 'Node not found', 404);
    const nodeTripAccess = await checkTripAccess(db, node.trip_id, user.id);
    if (!nodeTripAccess.ok) {
      return nodeTripAccess.dbError ? errResp('DB_ERROR', 'Failed to verify trip access', 500) : errResp('NOT_FOUND', 'Node not found', 404);
    }
    const updates = {
      updated_at: new Date().toISOString()
    };
    if (body.flexible !== undefined) updates.flexible = body.flexible;
    if (body.critical !== undefined) updates.critical = body.critical;
    if (body.holdMinutes !== undefined) updates.hold_minutes = body.holdMinutes;
    const { data: updated, error } = await db.from('dep_nodes').update(updates).eq('id', node.id).select().single();
    if (error) {
      console.error('[disruption-engine] dep_nodes criticality update failed:', error.message);
      return errResp('DB_ERROR', 'Could not update the criticality for this item.', 500);
    }
    return jsonResp(updated);
  }
  // POST /disruptions/:id/dismiss
  const dismissMatch = path.match(/^\/disruptions\/([^/]+)\/dismiss$/);
  if (method === 'POST' && dismissMatch) {
    const caseId = dismissMatch[1];
    const tripId = url.searchParams.get('tripId');
    if (!tripId) return errResp('BAD_REQUEST', 'tripId is required');
    const caseTripAccess = await checkTripAccess(db, tripId, user.id);
    if (!caseTripAccess.ok) {
      return caseTripAccess.dbError ? errResp('DB_ERROR', 'Failed to verify trip access', 500) : errResp('NOT_FOUND', 'Case not found', 404);
    }
    const { data: existing, error: existingCaseFetchErr } = await db.from('disruption_cases').select('*').eq('id', caseId).eq('trip_id', tripId).maybeSingle();
    if (existingCaseFetchErr) {
      console.error('[disruption-engine] disruption_cases lookup (dismiss route) failed:', existingCaseFetchErr.message);
      return errResp('DB_ERROR', 'Failed to look up case', 500);
    }
    if (!existing) return errResp('NOT_FOUND', 'Case not found', 404);
    const history = [
      ...existing.history ?? [],
      {
        at: new Date().toISOString(),
        event: 'dismissed',
        by: user.id
      }
    ];
    const { data: updated, error } = await db.from('disruption_cases').update({
      status: 'dismissed',
      history,
      updated_at: new Date().toISOString()
    }).eq('id', caseId).select().single();
    if (error) {
      console.error('[disruption-engine] disruption_cases dismiss update failed:', error.message);
      return errResp('DB_ERROR', 'Could not dismiss this disruption case.', 500);
    }
    return jsonResp(updated);
  }
  // GET /disruptions/:id
  const caseDetailMatch = path.match(/^\/disruptions\/([^/]+)$/);
  if (method === 'GET' && caseDetailMatch) {
    const caseId = caseDetailMatch[1];
    const tripId = url.searchParams.get('tripId');
    if (!tripId) return errResp('BAD_REQUEST', 'tripId is required');
    const caseTripAccess = await checkTripAccess(db, tripId, user.id);
    if (!caseTripAccess.ok) {
      return caseTripAccess.dbError ? errResp('DB_ERROR', 'Failed to verify trip access', 500) : errResp('NOT_FOUND', 'Case not found', 404);
    }
    const { data, error } = await db.from('disruption_cases').select('*').eq('id', caseId).eq('trip_id', tripId).maybeSingle();
    if (error) {
      console.error('[disruption-engine] disruption_cases detail read failed:', error.message);
      return errResp('DB_ERROR', 'Could not read this disruption case.', 500);
    }
    if (!data) return errResp('NOT_FOUND', 'Case not found', 404);
    return jsonResp(data);
  }
  // GET /disruptions?tripId=&status=
  if (method === 'GET' && path === '/disruptions') {
    const tripId = url.searchParams.get('tripId');
    const status = url.searchParams.get('status') ?? 'open';
    if (!tripId) return errResp('BAD_REQUEST', 'tripId is required');
    const tripAccess = await checkTripAccess(db, tripId, user.id);
    if (!tripAccess.ok) {
      return tripAccess.dbError ? errResp('DB_ERROR', 'Failed to verify trip access', 500) : errResp('NOT_FOUND', 'Trip not found', 404);
    }
    const { data, error } = await db.from('disruption_cases').select('*').eq('trip_id', tripId).eq('status', status).order('created_at', {
      ascending: false
    });
    if (error) {
      console.error('[disruption-engine] disruption_cases list read failed:', error.message);
      return errResp('DB_ERROR', 'Could not read the disruption cases for this trip.', 500);
    }
    return jsonResp(data ?? []);
  }
  return errResp('NOT_FOUND', 'Route not found', 404);
});

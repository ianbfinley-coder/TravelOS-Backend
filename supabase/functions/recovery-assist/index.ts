// SECURITY 2026-09-17 — None of the tripId-scoped routes verified that the
// calling user actually belongs to that trip; `tripId` from the request was
// used to read and write data with no ownership check at all. Confirmed
// against every route:
//   - GET /assist?tripId&disruptionId returned another trip's disruption
//     case and reservation contact details (provider names, confirmation
//     numbers, phone numbers) to any authenticated caller who knew or
//     guessed the ids.
//   - POST /broadcast is the serious one: it looked up trip_members for the
//     given tripId and sent a push notification with an ATTACKER-CONTROLLED
//     message to every one of those members via notification-delivery, with
//     no check that the caller belongs to the trip. That is a spam/phishing
//     primitive against arbitrary trip members, gated only by having a
//     TravelOS account.
//   - PATCH /steps/:stepId, POST /claims and POST /eta-links let a caller
//     attach step-completion, claim and eta-link rows to a tripId they don't
//     belong to.
// Fixed by requiring trip membership (bridged through the platform id space —
// disruption_cases/trip_members use platform_users.id, not the Supabase auth
// uuid; see _shared/auth.ts) before any of these routes touch tripId data.
// GET /playbooks is unaffected — it is shared reference content, not
// per-trip data.
//
// DEFECT 2026-09-19 (the whole function has never worked) — the client every
// route uses was built like this:
//
//   const supabase = createClient(URL, SERVICE_ROLE_KEY,
//     { global: { headers: { Authorization: authHeader } } });
//
// That is not a service-role client. PostgREST takes the role from the JWT in
// the Authorization header, and the header here is the CALLER'S user JWT, so
// every query ran as `authenticated`, not `service_role`, and RLS applied.
// auth_identities, trip_members, playbooks, disruption_cases,
// disruption_claims, claim_expenses, playbook_step_completions and eta_links
// all have RLS ENABLED WITH ZERO POLICIES (verified against pg_class
// .relrowsecurity and pg_policies), which denies the authenticated role
// everything. So:
//   * resolvePlatformUserId() read zero rows from auth_identities and
//     returned null, so requireTripMember() returned false for EVERY caller
//     and every trip-scoped route answered 404 'not found';
//   * GET /playbooks returned [] — all 12 playbooks are invisible;
//   * GET /claims returned [], every insert was refused.
// None of it errored in a way anyone would notice: a row-level-security
// refusal on a SELECT is an empty result, not an error. Recovery assistance
// has been silently unavailable to every user since it shipped.
// The service client is now built without the caller's Authorization header;
// the separate anon client below still verifies the JWT, and the membership
// check above is what authorises access.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { resolvePlatformUserId, corsHeaders } from './_shared/auth.ts';
// ─── Rights Library ───────────────────────────────────────────────
//
// NOTE 2026-09-19 — these are hardcoded statements of passenger-rights law
// with compensation figures in them, and they are quoted verbatim into the
// claim letter a user sends to an airline. Every entry is stamped
// reviewedAt 2025-01-01. The playbooks table gets a `stale` flag computed
// against a 180-day threshold; this library did not, so the figures were
// presented to the user as current regardless of age. `stale` is now computed
// the same way and returned alongside the rights, and the letter carries the
// review date so nobody quotes a number at an airline believing it was
// checked recently when it was not.
const RIGHTS_LIBRARY = {
  EU261: {
    regime: 'EU261',
    appliesIf: 'Flight departs an EU airport, or arrives in the EU on an EU-licensed carrier',
    summary: [
      'Cancellations: choose between full refund or rerouting at no extra cost',
      'Long delays (2h+): free meals and refreshments; 5h+ delay: full refund option',
      'Compensation €250-€600 for cancellations and long delays (not for extraordinary circumstances)',
      'Denied boarding: same rights as cancellation plus immediate compensation'
    ],
    officialUrl: 'https://transport.ec.europa.eu/transport-modes/air/passenger-rights/your-rights-when-travelling-air_en',
    reviewedAt: '2025-01-01'
  },
  US_DOT: {
    regime: 'US_DOT',
    appliesIf: 'Flight operated by a US carrier or departing a US airport',
    summary: [
      'Cancellations and significant changes: automatic cash refund if you do not accept alternatives',
      'Significant delay: 3h+ domestic, 6h+ international qualifies for refund',
      'Denied boarding (involuntary): compensation 200-400% of one-way fare, capped at $775-$1,550',
      'Tarmac delays: must deplane after 3h domestic, 4h international'
    ],
    officialUrl: 'https://www.transportation.gov/airconsumer/fly-rights',
    reviewedAt: '2025-01-01'
  },
  UK261: {
    regime: 'UK261',
    appliesIf: 'Flight departs a UK airport, or arrives in the UK on a UK-licensed carrier',
    summary: [
      'Mirrors EU261 for flights from UK airports post-Brexit',
      'Compensation £220-£520 depending on distance and delay length',
      'Right to care: meals, refreshments, accommodation for long delays',
      'Cancellations: full refund or rerouting'
    ],
    officialUrl: 'https://www.caa.co.uk/passengers-and-public/resolving-travel-problems/disrupted-flights/your-rights/',
    reviewedAt: '2025-01-01'
  },
  CA_APPR: {
    regime: 'CA_APPR',
    appliesIf: 'Flight operated by a carrier subject to Canadian APPR regulations',
    summary: [
      'Delays within carrier control: compensation $125-$1,000 depending on delay length and carrier size',
      'Cancellations: rebooking or refund; compensation if within carrier control',
      'Denied boarding: $900 minimum compensation',
      'Lost baggage: up to $2,300 compensation'
    ],
    officialUrl: 'https://otc-cta.gc.ca/eng/air-passenger-protection-regulations',
    reviewedAt: '2025-01-01'
  }
};
const STALE_THRESHOLD_MS = 180 * 24 * 60 * 60 * 1000;
function isStale(reviewedAt) {
  if (!reviewedAt) return null;
  const t = new Date(reviewedAt).getTime();
  if (!Number.isFinite(t)) return null;
  return Date.now() - t > STALE_THRESHOLD_MS;
}
// ─── Template Filling ──────────────────────────────────────────────────
const TEMPLATES = {
  rebook_request_airline: 'My flight {ident} on {date} is delayed and I will miss {connection}. Please rebook me on the next available flight to {destination}. Booking reference: {pnr}.',
  late_arrival_hotel: 'Reservation {conf} for {name}. Our flight is delayed; we now expect to arrive around {eta}. Please hold the room. Thank you.',
  restaurant_reschedule: 'We have a reservation for {covers} at {time} under {name}. Due to a flight delay, we would like to move to {newTime} if available. Reservation reference: {ref}.',
  tour_reschedule: 'Booking {ref} for {name} on {date}. Our flight is delayed; we will arrive around {eta}. Please advise if we can join a later session.',
  rental_late_pickup: 'Reservation {ref} for {name}. Our flight is delayed; we expect to pick up the vehicle around {eta}. Please hold the reservation.',
  assistance_request: 'My flight {ident} on {date} has been {reason}. I am entitled to assistance under applicable regulations. Please provide meal vouchers and hotel accommodation for the wait.',
  baggage_followup: 'Property Irregularity Report reference: {pirRef}. My bag has not arrived after {days} days. Please provide an update on its status and advise on the claims process.'
};
function fillTemplate(key, data) {
  const raw = TEMPLATES[key];
  if (!raw) return {
    en: '',
    note: `Unknown template: ${key}`
  };
  const filled = raw.replace(/\{(\w+)\}/g, (_match, placeholder)=>{
    const val = data[placeholder];
    return val !== undefined && val !== '' ? val : `[${placeholder}]`;
  });
  const unfilled = filled.match(/\[\w+\]/g) || [];
  const note = unfilled.length > 0 ? `Fill in: ${unfilled.join(', ')}` : 'Ready to send';
  return {
    en: filled,
    note
  };
}
// ─── ULID-style ID generator ───────────────────────────────────────────
function generateId(prefix) {
  const ts = Date.now().toString(36).toUpperCase().padStart(10, '0');
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(10))).map((b)=>b.toString(36).toUpperCase().padStart(2, '0')).join('').slice(0, 16);
  return `${prefix}${ts}${rand}`;
}
function generateToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(24))).map((b)=>b.toString(16).padStart(2, '0')).join('');
}
// ─── Reservation helpers ─────────────────────────────────────────────
//
// DEFECT 2026-09-19 (schema mismatch, masked by select('*')) — every place
// this function looked at a reservation's kind it wrote `r.type === 'flight'`
// (and 'hotel', 'rental'). The column is `reservation_type`, and its CHECK
// constraint spells the values in upper case: FLIGHT, HOTEL, RENTAL_CAR,
// TRAIN, BUS, RESTAURANT, TOUR, ACTIVITY, EVENT, CRUISE, TRANSFER, OTHER.
// Because the query was select('*'), `r.type` was simply undefined rather
// than an error, so the comparison was quietly false for every row ever
// loaded. Consequences, all of them silent:
//   * `contacts` was always {} — during a disruption the screen showed no
//     airline or hotel phone number at all, which is the one thing a stranded
//     traveller needs;
//   * flightRes/hotelRes/rentalRes were always undefined, so ident, pnr, conf
//     and ref in every message template rendered as "[ident]", "[pnr]" …;
//   * the compensation letter was addressed "To: Airline/Provider" and
//     "Dear Airline/Provider Customer Relations," for every claim ever
//     generated.
const RES_KIND = {
  flight: 'FLIGHT',
  hotel: 'HOTEL',
  rental: 'RENTAL_CAR'
};
function findReservation(reservations, kind) {
  return reservations.find((r)=>r.reservation_type === RES_KIND[kind]);
}
// reservations has no provider_phone column. If a phone number was captured
// at all it is inside the `details` jsonb. Report null when it is not there —
// the previous `?? ''` rendered as an empty phone field that looked like a
// number we had and failed to display.
function providerPhone(r) {
  const d = r?.details ?? {};
  const candidates = [
    d.provider_phone,
    d.phone,
    d.contact_phone,
    d.telephone
  ];
  for (const c of candidates){
    if (typeof c === 'string' && c.trim().length > 0) return c.trim();
  }
  return null;
}
// ─── Playbook matching ───────────────────────────────────────────────
function matchPlaybook(playbooks, rootCause) {
  if (!rootCause?.kind) return null;
  const kind = rootCause.kind;
  // Priority order: exact kind match first
  for (const pb of playbooks){
    const aw = pb.applies_when;
    if (aw?.kinds?.includes(kind)) return pb;
  }
  return null;
}
// ─── Error helper ─────────────────────────────────────────────────
function errResp(code, message, status) {
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
async function checkTripMember(service, tripId, authUserId) {
  const platformUserId = await resolvePlatformUserId(service, authUserId);
  if (!platformUserId) return {
    member: false
  };
  const { data, error } = await service.from('trip_members').select('id').eq('trip_id', tripId).eq('user_id', platformUserId).is('removed_at', null).maybeSingle();
  if (error) {
    console.error('[recovery-assist] trip_members membership lookup failed:', error.message);
    return {
      failed: error.message
    };
  }
  return data ? {
    member: true,
    platformUserId
  } : {
    member: false
  };
}
// ─── Main handler ────────────────────────────────────────────────────
Deno.serve(async (req)=>{
  // CORS 2026-09-20 — OPTIONS preflight must be short-circuited BEFORE the
  // JWT auth check below. A preflight carries no Authorization header, so
  // without this it fell through to anonClient.auth.getUser(), got 401, and
  // the browser blocked the real request client-side since a non-2xx
  // preflight fails CORS regardless of headers present.
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders
    });
  }
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/recovery-assist/, '');
  const method = req.method;
  // Auth
  const authHeader = req.headers.get('Authorization') ?? '';
  // The service client carries NO caller Authorization header — see the
  // DEFECT note at the top of this file. Everything this function reads is
  // behind RLS that denies the authenticated role, so passing the user's JWT
  // here silently emptied every query.
  const supabase = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));
  const anonClient = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_ANON_KEY'), {
    global: {
      headers: {
        Authorization: authHeader
      }
    }
  });
  const { data: { user }, error: authErr } = await anonClient.auth.getUser();
  if (authErr || !user) return errResp('UNAUTHORIZED', 'Invalid or missing JWT', 401);
  // NOTE 2026-09-19 (identity axis) — `memberId` is the caller's raw auth
  // uuid and is written to playbook_step_completions.member_id,
  // disruption_claims.member_id and eta_links.created_by, all of which are
  // TEXT with no foreign key. Membership above resolves the platform
  // "usr_<hex>" id for the same person. Nothing in the schema settles which
  // of the two these member_id columns are meant to hold, and the tables are
  // read back with the same value they were written with, so the function is
  // at least self-consistent. Left as the auth uuid rather than switched
  // blind; flagged so it is decided before another component writes here.
  const memberId = user.id;
  // Shared handling for the membership gate.
  async function gate(tripId, notFoundMsg = 'Trip not found') {
    const result = await checkTripMember(supabase, tripId, memberId);
    if ('failed' in result) {
      return errResp('MEMBERSHIP_CHECK_FAILED', 'Could not verify your membership of this trip', 500);
    }
    if (!result.member) return errResp('NOT_FOUND', notFoundMsg, 404);
    return null;
  }
  // ── GET /playbooks ───────────────────────────────────────────────
  // Shared reference content, identical for every user — no trip scoping needed.
  if (method === 'GET' && path === '/playbooks') {
    const { data, error } = await supabase.from('playbooks').select('*').order('key');
    if (error) return errResp('DB_ERROR', error.message, 500);
    const result = (data ?? []).map((pb)=>({
        ...pb,
        stale: isStale(pb.reviewed_at)
      }));
    return jsonResp(result);
  }
  // ── GET /assist ──────────────────────────────────────────────────
  if (method === 'GET' && path === '/assist') {
    const tripId = url.searchParams.get('tripId');
    const disruptionId = url.searchParams.get('disruptionId');
    if (!tripId || !disruptionId) return errResp('BAD_REQUEST', 'tripId and disruptionId required', 400);
    const denied = await gate(tripId, 'Disruption case not found');
    if (denied) return denied;
    // Fetch disruption case.
    //
    // DEFECT 2026-09-19 (failure looks like absence) — `.single()` with
    // `if (dErr || !disruption) return 404` folded a broken read into "no
    // such disruption". `.single()` also raises PGRST116 for zero rows, so
    // the two could never have been told apart.
    const { data: disruption, error: dErr } = await supabase.from('disruption_cases').select('*').eq('id', disruptionId).eq('trip_id', tripId).maybeSingle();
    if (dErr) return errResp('DB_ERROR', dErr.message, 500);
    if (!disruption) return errResp('NOT_FOUND', 'Disruption case not found', 404);
    // Fetch all playbooks
    const { data: allPlaybooks, error: pbErr } = await supabase.from('playbooks').select('*');
    if (pbErr) return errResp('DB_ERROR', pbErr.message, 500);
    // Match playbook
    const rootCause = disruption.root_cause;
    const playbook = matchPlaybook(allPlaybooks ?? [], rootCause);
    // Fetch trip
    const { data: trip, error: tripErr } = await supabase.from('trips').select('id, destination, primary_tz').eq('id', tripId).maybeSingle();
    if (tripErr) return errResp('DB_ERROR', tripErr.message, 500);
    // Fetch reservations for contacts
    const { data: reservations, error: resErr } = await supabase.from('reservations').select('*').eq('trip_id', tripId);
    // DEFECT 2026-09-19 (discarded error) — this was logged and ignored, so a
    // failed read produced an empty contacts block and empty templates that
    // looked exactly like a trip with no reservations on file.
    if (resErr) return errResp('DB_ERROR', resErr.message, 500);
    const allRes = reservations ?? [];
    const flightRes = findReservation(allRes, 'flight');
    const hotelRes = findReservation(allRes, 'hotel');
    const rentalRes = findReservation(allRes, 'rental');
    const contacts = {};
    if (flightRes) contacts.airline = {
      name: flightRes.provider_name ?? null,
      phone: providerPhone(flightRes)
    };
    if (hotelRes) contacts.hotel = {
      name: hotelRes.provider_name ?? null,
      phone: providerPhone(hotelRes)
    };
    if (rentalRes) contacts.rental = {
      name: rentalRes.provider_name ?? null,
      phone: providerPhone(rentalRes)
    };
    // DEFECT 2026-09-19 (placeholder timestamp standing in for a real one) —
    // templateData.date was `new Date().toISOString().split('T')[0]`, i.e.
    // TODAY. The templates read "My flight {ident} on {date} is delayed" and
    // "Booking {ref} for {name} on {date}", so a message sent to an airline
    // about a flight on the 22nd said the 19th, because that happened to be
    // the day the user opened the screen. The flight's own date is used when
    // there is a flight reservation, and otherwise the placeholder is left
    // visible for the user to fill in.
    const templateData = {
      ident: flightRes?.confirmation_number ?? '',
      pnr: flightRes?.confirmation_number ?? '',
      conf: hotelRes?.confirmation_number ?? '',
      ref: rentalRes?.confirmation_number ?? flightRes?.confirmation_number ?? '',
      name: user.user_metadata?.full_name ?? '',
      destination: trip?.destination ?? '',
      date: flightRes?.start_date ?? '',
      eta: '',
      connection: '',
      reason: rootCause?.kind ?? ''
    };
    // Fetch step completions for this member
    const { data: completions, error: compErr } = await supabase.from('playbook_step_completions').select('*').eq('trip_id', tripId).eq('disruption_id', disruptionId).eq('member_id', memberId);
    // DEFECT 2026-09-19 (discarded error) — a failed read showed every step
    // as not done, inviting the traveller to redo steps (phoning the airline,
    // filing a PIR) they had already completed.
    if (compErr) return errResp('DB_ERROR', compErr.message, 500);
    const completionMap = {};
    for (const c of completions ?? []){
      completionMap[c.step_id] = c.done;
    }
    // Resolve steps with done status and filled templates
    const steps = playbook ? playbook.steps.map((step)=>{
      const enriched = {
        ...step,
        done: completionMap[step.id] ?? false
      };
      if (step.template) {
        enriched.filledTemplate = fillTemplate(step.template, templateData);
      }
      return enriched;
    }) : [];
    // Resolve rights, each with its own staleness flag.
    const rightsKeys = playbook?.rights ?? [];
    const rights = rightsKeys.map((k)=>RIGHTS_LIBRARY[k]).filter(Boolean).map((r)=>({
        ...r,
        stale: isStale(r.reviewedAt)
      }));
    // Pre-fill all templates
    const templates = {};
    for (const key of Object.keys(TEMPLATES)){
      templates[key] = fillTemplate(key, templateData);
    }
    return jsonResp({
      playbook: playbook ? {
        ...playbook,
        stale: isStale(playbook.reviewed_at)
      } : null,
      steps,
      contacts,
      templates,
      rights,
      disruption,
      // Says plainly which reservations were found, so an empty contacts block
      // reads as "none on file" rather than "lookup silently produced nothing".
      reservationsFound: {
        flight: !!flightRes,
        hotel: !!hotelRes,
        rental: !!rentalRes,
        total: allRes.length
      }
    });
  }
  // ── PATCH /steps/:stepId ─────────────────────────────────────────
  const stepMatch = path.match(/^\/steps\/([^/]+)$/);
  if (method === 'PATCH' && stepMatch) {
    const stepId = stepMatch[1];
    let body;
    try {
      body = await req.json();
    } catch  {
      return errResp('BAD_REQUEST', 'Invalid JSON', 400);
    }
    const { tripId, disruptionId, done } = body ?? {};
    if (!tripId || !disruptionId || done === undefined) {
      return errResp('BAD_REQUEST', 'tripId, disruptionId, done required', 400);
    }
    if (typeof done !== 'boolean') return errResp('BAD_REQUEST', 'done must be a boolean', 400);
    const denied = await gate(tripId);
    if (denied) return denied;
    const { error } = await supabase.from('playbook_step_completions').upsert({
      trip_id: tripId,
      disruption_id: disruptionId,
      step_id: stepId,
      member_id: memberId,
      done,
      done_at: done ? new Date().toISOString() : null
    }, {
      onConflict: 'trip_id,disruption_id,step_id,member_id'
    });
    if (error) return errResp('DB_ERROR', error.message, 500);
    return jsonResp({
      ok: true
    });
  }
  // ── POST /claims ─────────────────────────────────────────────────
  if (method === 'POST' && path === '/claims') {
    let body;
    try {
      body = await req.json();
    } catch  {
      return errResp('BAD_REQUEST', 'Invalid JSON', 400);
    }
    const { tripId, disruptionId, flightIdent, scheduledTime, actualTime, airlineReason, regime } = body ?? {};
    if (!tripId || !disruptionId) return errResp('BAD_REQUEST', 'tripId and disruptionId required', 400);
    if (regime !== undefined && regime !== null && !RIGHTS_LIBRARY[regime]) {
      return errResp('BAD_REQUEST', `regime must be one of ${Object.keys(RIGHTS_LIBRARY).join(', ')}`, 400);
    }
    const denied = await gate(tripId);
    if (denied) return denied;
    const id = generateId('clm_');
    const followUpAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase.from('disruption_claims').insert({
      id,
      trip_id: tripId,
      disruption_id: disruptionId,
      member_id: memberId,
      flight_ident: flightIdent ?? null,
      scheduled_time: scheduledTime ?? null,
      actual_time: actualTime ?? null,
      airline_reason: airlineReason ?? null,
      regime: regime ?? null,
      status: 'draft',
      follow_up_at: followUpAt
    }).select().single();
    if (error) return errResp('DB_ERROR', error.message, 500);
    return jsonResp(data, 201);
  }
  // ── GET /claims ──────────────────────────────────────────────────
  if (method === 'GET' && path === '/claims') {
    const tripId = url.searchParams.get('tripId');
    if (!tripId) return errResp('BAD_REQUEST', 'tripId required', 400);
    const denied = await gate(tripId);
    if (denied) return denied;
    const { data, error } = await supabase.from('disruption_claims').select('*, claim_expenses(*)').eq('trip_id', tripId).eq('member_id', memberId).order('created_at', {
      ascending: false
    });
    if (error) return errResp('DB_ERROR', error.message, 500);
    return jsonResp(data ?? []);
  }
  // ── PATCH /claims/:id ────────────────────────────────────────────
  const claimPatchMatch = path.match(/^\/claims\/([^/]+)$/);
  if (method === 'PATCH' && claimPatchMatch) {
    const claimId = claimPatchMatch[1];
    let body;
    try {
      body = await req.json();
    } catch  {
      return errResp('BAD_REQUEST', 'Invalid JSON', 400);
    }
    body = body ?? {};
    // disruption_claims.status is CHECK-constrained; an unlisted value was
    // sent straight to Postgres and came back as a raw 23514 in a 500.
    const VALID_STATUS = [
      'draft',
      'submitted',
      'awaiting',
      'paid',
      'rejected'
    ];
    if (body.status !== undefined && !VALID_STATUS.includes(body.status)) {
      return errResp('BAD_REQUEST', `status must be one of ${VALID_STATUS.join(', ')}`, 400);
    }
    // Verify ownership
    const { data: existing, error: fetchErr } = await supabase.from('disruption_claims').select('*').eq('id', claimId).eq('member_id', memberId).maybeSingle();
    if (fetchErr) return errResp('DB_ERROR', fetchErr.message, 500);
    if (!existing) return errResp('NOT_FOUND', 'Claim not found', 404);
    const updates = {
      updated_at: new Date().toISOString()
    };
    if (body.status !== undefined) updates.status = body.status;
    if (body.airlineReason !== undefined) updates.airline_reason = body.airlineReason;
    if (body.amountClaimedMinor !== undefined) updates.amount_claimed_minor = body.amountClaimedMinor;
    if (body.amountClaimedCurrency !== undefined) updates.amount_claimed_currency = body.amountClaimedCurrency;
    if (body.amountReceivedMinor !== undefined) updates.amount_received_minor = body.amountReceivedMinor;
    if (body.amountReceivedCurrency !== undefined) updates.amount_received_currency = body.amountReceivedCurrency;
    if (body.notes !== undefined) updates.notes = body.notes;
    if (body.status === 'submitted') {
      updates.submitted_at = new Date().toISOString();
      updates.follow_up_at = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    }
    const { data, error } = await supabase.from('disruption_claims').update(updates).eq('id', claimId).eq('member_id', memberId).select().single();
    if (error) return errResp('DB_ERROR', error.message, 500);
    return jsonResp(data);
  }
  // ── GET /claims/:id/letter ────────────────────────────────────────
  const letterMatch = path.match(/^\/claims\/([^/]+)\/letter$/);
  if (method === 'GET' && letterMatch) {
    const claimId = letterMatch[1];
    const { data: claim, error: claimErr } = await supabase.from('disruption_claims').select('*, claim_expenses(*)').eq('id', claimId).eq('member_id', memberId).maybeSingle();
    if (claimErr) return errResp('DB_ERROR', claimErr.message, 500);
    if (!claim) return errResp('NOT_FOUND', 'Claim not found', 404);
    // Fetch reservation for the airline name
    const { data: reservations, error: resErr } = await supabase.from('reservations').select('*').eq('trip_id', claim.trip_id);
    if (resErr) return errResp('DB_ERROR', resErr.message, 500);
    const flightRes = findReservation(reservations ?? [], 'flight');
    // DEFECT 2026-09-19 (placeholder presented as real) — this was
    //     const providerName = flightRes?.provider_name ?? 'Airline/Provider';
    //     const claimantName = user.user_metadata?.full_name ?? user.email ?? 'Claimant';
    // and those strings went straight into a formal compensation letter the
    // user downloads and sends: "To: Airline/Provider", "Dear Airline/Provider
    // Customer Relations," and signed "Claimant" — or signed with the user's
    // raw email address. Combined with the r.type defect above, flightRes was
    // always undefined, so EVERY letter this function has produced was
    // addressed to "Airline/Provider". Unknown values are now bracketed
    // placeholders and listed in `missing`, so the UI can require them before
    // the letter is sent.
    const missing = [];
    const providerName = flightRes?.provider_name ?? null;
    if (!providerName) missing.push('airline or provider name');
    const providerLabel = providerName ?? '[airline / provider name]';
    const fullName = user.user_metadata?.full_name ?? null;
    if (!fullName) missing.push('your full name');
    const claimantName = fullName ?? '[your full name]';
    const today = new Date().toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    });
    const regimeInfo = claim.regime ? RIGHTS_LIBRARY[claim.regime] : null;
    const regimeName = regimeInfo ? ({
      EU261: 'EU Regulation 261/2004',
      US_DOT: 'US DOT 14 CFR Part 250',
      UK261: 'UK Regulation (EC) 261/2004 (retained)',
      CA_APPR: 'Canadian Air Passenger Protection Regulations'
    })[claim.regime] ?? claim.regime : null;
    if (!regimeInfo) missing.push('the applicable passenger-rights regime');
    const expenses = claim.claim_expenses ?? [];
    // DEFECT 2026-09-19 (fabricated figure) — the total was
    //     const totalMinor = expenses.reduce((sum, e) => sum + (e.amount_minor ?? 0), 0);
    //     const currency = claim.amount_claimed_currency ?? expenses[0]?.currency ?? 'USD';
    // which adds amounts in different currencies together and labels the sum
    // with whichever currency happened to be first — or, failing that, USD.
    // A claim for €40 of meals and £30 of taxis printed "Total claimed: EUR
    // 70.00" in a letter sent to an airline. Totals are now kept per currency
    // and the `?? 'USD'` is gone.
    const totalsByCurrency = new Map();
    for (const e of expenses){
      const cur = typeof e.currency === 'string' && e.currency.trim() ? e.currency.trim() : null;
      if (!cur) {
        missing.push(`currency for expense "${e.description}"`);
        continue;
      }
      totalsByCurrency.set(cur, (totalsByCurrency.get(cur) ?? 0) + (e.amount_minor ?? 0));
    }
    const scheduledStr = claim.scheduled_time ? new Date(claim.scheduled_time).toLocaleString('en-GB') : '[scheduled time]';
    const actualStr = claim.actual_time ? new Date(claim.actual_time).toLocaleString('en-GB') : '[actual time]';
    if (!claim.scheduled_time) missing.push('scheduled departure time');
    if (!claim.actual_time) missing.push('actual departure time');
    let delayMinutes = 0;
    if (claim.scheduled_time && claim.actual_time) {
      delayMinutes = Math.round((new Date(claim.actual_time).getTime() - new Date(claim.scheduled_time).getTime()) / 60000);
    }
    const delayStr = delayMinutes > 0 ? `${Math.floor(delayMinutes / 60)}h ${delayMinutes % 60}m` : '[delay duration]';
    if (!claim.flight_ident) missing.push('flight number');
    if (!claim.airline_reason) missing.push('the reason the airline gave');
    const lines = [
      `${claimantName}`,
      `Date: ${today}`,
      ``,
      `To: ${providerLabel}`,
      ``,
      `Subject: Compensation Claim — Flight ${claim.flight_ident ?? '[flight]'}`,
      ``,
      `Dear ${providerLabel} Customer Relations,`,
      ``,
      `I am writing to claim compensation and/or reimbursement in connection with the following disruption:`,
      ``,
      `  Flight:           ${claim.flight_ident ?? '[flight ident]'}`,
      `  Scheduled:        ${scheduledStr}`,
      `  Actual departure: ${actualStr}`,
      `  Delay:            ${delayStr}`,
      `  Reason given:     ${claim.airline_reason ?? '[reason]'}`,
      ``
    ];
    if (regimeName) {
      lines.push(`Under ${regimeName}, I am entitled to compensation and/or reimbursement for the disruption described above.`);
      if (regimeInfo) {
        lines.push(``);
        lines.push(`Applicable rights:`);
        for (const s of regimeInfo.summary){
          lines.push(`  • ${s}`);
        }
      }
      lines.push(``);
    }
    if (expenses.length > 0) {
      lines.push(`Expenses incurred:`);
      for (const e of expenses){
        const amt = ((e.amount_minor ?? 0) / 100).toFixed(2);
        lines.push(`  • ${e.description}: ${e.currency ?? '[currency]'} ${amt}`);
      }
      lines.push(``);
      for (const [cur, minor] of totalsByCurrency){
        lines.push(`Total claimed: ${cur} ${(minor / 100).toFixed(2)}`);
      }
    } else if (claim.amount_claimed_minor) {
      const cur = claim.amount_claimed_currency ?? '[currency]';
      if (!claim.amount_claimed_currency) missing.push('the currency of the amount claimed');
      lines.push(`Total claimed: ${cur} ${(claim.amount_claimed_minor / 100).toFixed(2)}`);
    }
    lines.push(``);
    lines.push(`Please respond within 14 days. I am happy to provide any additional documentation required.`);
    lines.push(``);
    lines.push(`Yours sincerely,`);
    lines.push(`${claimantName}`);
    lines.push(``);
    lines.push(`---`);
    lines.push(`This letter is for informational purposes. Not legal advice.`);
    if (regimeInfo) {
      lines.push(`The rights summarised above were last reviewed on ${regimeInfo.reviewedAt}` + `${isStale(regimeInfo.reviewedAt) ? ' and may be out of date' : ''}` + `. Check ${regimeInfo.officialUrl} before relying on any figure.`);
    }
    const text = lines.join('\n');
    const filename = `claim-letter-${claim.flight_ident ?? claim.id}-${today.replace(/ /g, '-')}.txt`;
    // `missing` lists what the letter could not fill in, so the caller can
    // block sending rather than letting a bracketed placeholder go to an
    // airline.
    return jsonResp({
      text,
      filename,
      missing,
      readyToSend: missing.length === 0
    });
  }
  // ── POST /broadcast ─────────────────────────────────────────────────
  if (method === 'POST' && path === '/broadcast') {
    let body;
    try {
      body = await req.json();
    } catch  {
      return errResp('BAD_REQUEST', 'Invalid JSON', 400);
    }
    const { tripId, disruptionId, message } = body ?? {};
    if (!tripId) return errResp('BAD_REQUEST', 'tripId required', 400);
    // This sends a push notification with caller-supplied content to every
    // member of tripId — the membership check below is the only thing
    // standing between this and an open spam/phishing channel. See SECURITY
    // note above.
    const denied = await gate(tripId);
    if (denied) return denied;
    // Fetch disruption for context
    let disruption = null;
    if (disruptionId) {
      const { data, error } = await supabase.from('disruption_cases').select('*').eq('id', disruptionId).eq('trip_id', tripId).maybeSingle();
      if (error) return errResp('DB_ERROR', error.message, 500);
      disruption = data;
    }
    const broadcastMsg = message ?? `Travel disruption update: ${disruption?.root_cause?.kind ?? 'disruption'} reported. Check the TravelOS app for details.`;
    // DEFECT 2026-09-19 (schema mismatch — chat broadcast has never worked) —
    // this was:
    //   for (const table of ['group_messages', 'chat_messages']) {
    //     const { error } = await supabase.from(table).insert({
    //       trip_id: tripId, sender_id: memberId, content: broadcastMsg,
    //       type: 'system', created_at: ... });
    //     if (!error) { chatInserted = true; break; }
    //   }
    // group_messages has no trip_id and no sender_id: it is keyed on
    // group_id (TEXT, -> trip_groups.id), carries user_id (uuid, FK to
    // auth.users) and display_name, and its id is TEXT NOT NULL with no
    // default. So the first insert was a 42703 on three columns at once.
    // chat_messages does not exist in this database at all, so the fallback
    // was a 42P01. Both failures were logged as "non-fatal" and the route
    // returned chatInserted: false — the disruption notice has never once
    // reached a trip's chat. Resolved through trip_groups, with the columns
    // the table actually has.
    let chatInserted = false;
    let chatError = null;
    const { data: group, error: groupErr } = await supabase.from('trip_groups').select('id').eq('trip_id', tripId).maybeSingle();
    if (groupErr) {
      chatError = groupErr.message;
      console.error('[recovery-assist] trip_groups lookup failed:', groupErr.message);
    } else if (!group) {
      chatError = 'This trip has no group chat to post into.';
    } else {
      const { error: msgErr } = await supabase.from('group_messages').insert({
        id: generateId('msg_'),
        group_id: group.id,
        user_id: user.id,
        display_name: user.user_metadata?.full_name ?? null,
        content: broadcastMsg,
        type: 'system'
      });
      if (msgErr) {
        chatError = msgErr.message;
        console.error('[recovery-assist] group_messages insert failed:', msgErr.message);
      } else {
        chatInserted = true;
      }
    }
    // Fetch trip members for push notifications
    const { data: members, error: membersErr } = await supabase.from('trip_members').select('user_id').eq('trip_id', tripId).is('removed_at', null);
    // DEFECT 2026-09-19 (discarded error) — logged and ignored, so a failed
    // read meant nobody was notified while the response still said ok: true.
    if (membersErr) return errResp('DB_ERROR', membersErr.message, 500);
    const recipients = (members ?? []).map((m)=>m.user_id).filter(Boolean);
    // Send push via notification-delivery function.
    // notification-delivery dispatches on `action`; `send_direct` is the action
    // built for service-to-service callers like this one. `id_space` is
    // mandatory: trip_members.user_id holds platform `usr_` ids.
    let notifResult = null;
    let notified = 0;
    let unresolved = [];
    let notifyError = null;
    if (recipients.length > 0) {
      try {
        const notifResp = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/notification-delivery`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`
          },
          body: JSON.stringify({
            action: 'send_direct',
            recipients,
            id_space: 'platform',
            title: 'Travel Disruption Update',
            message: broadcastMsg,
            tripId,
            data: {
              disruptionId
            }
          })
        });
        // Never swallow the result: this call silently 400'd for its whole
        // life because the body carried no `action`, and /broadcast then
        // reported every member as notified. A 200 with resolved: 0 is also a
        // real outcome and must be visible.
        const rawBody = await notifResp.text();
        try {
          notifResult = JSON.parse(rawBody);
        } catch  {
          notifResult = rawBody;
        }
        if (!notifResp.ok) {
          notifyError = `notification-delivery returned ${notifResp.status}`;
          console.error('[recovery-assist] notification-delivery failed:', notifResp.status, rawBody);
        } else {
          const d = notifResult?.data ?? {};
          notified = typeof d.delivered_inapp === 'number' ? d.delivered_inapp : 0;
          unresolved = Array.isArray(d.unresolved) ? d.unresolved : [];
          console.log('[recovery-assist] notification-delivery ok:', JSON.stringify({
            requested: d.requested,
            resolved: d.resolved,
            delivered_inapp: d.delivered_inapp,
            delivered_push: d.delivered_push,
            unresolved: d.unresolved
          }));
        }
      } catch (e) {
        // A notification failure must not break the broadcast — but it is
        // logged now, and never counted as a success.
        notifyError = e instanceof Error ? e.message : String(e);
        console.error('[recovery-assist] notification-delivery error:', e);
      }
    }
    // `notified` is the real delivered count reported by notification-delivery,
    // not the number of members we asked about. It was the latter before, which
    // reported full success on a call that had never once succeeded.
    return jsonResp({
      ok: chatInserted || notified > 0,
      chatInserted,
      chatError,
      requested: recipients.length,
      notified,
      unresolved,
      notifyError,
      notifResult
    });
  }
  // ── POST /eta-links ─────────────────────────────────────────────────
  if (method === 'POST' && path === '/eta-links') {
    let body;
    try {
      body = await req.json();
    } catch  {
      return errResp('BAD_REQUEST', 'Invalid JSON', 400);
    }
    const { tripId, itemId } = body ?? {};
    if (!tripId || !itemId) return errResp('BAD_REQUEST', 'tripId and itemId required', 400);
    const denied = await gate(tripId);
    if (denied) return denied;
    // Fetch the itinerary item for its arrival time.
    //
    // DEFECT 2026-09-19 (missing scope check) — the lookup was
    // `.eq('id', itemId)` only, with no trip filter, so an item belonging to
    // a different trip could be used to set the expiry of a link created
    // under this trip. The trip filter is now applied and a mismatch is a 404.
    const { data: item, error: itemErr } = await supabase.from('itinerary_items').select('id, end_time').eq('id', itemId).eq('trip_id', tripId).maybeSingle();
    if (itemErr) return errResp('DB_ERROR', itemErr.message, 500);
    if (!item) return errResp('NOT_FOUND', 'Itinerary item not found on this trip', 404);
    // DEFECT 2026-09-19 (nonexistent column) — this read
    //     if (item?.end_time || item?.arrival_time) { ... item.end_time ?? item.arrival_time }
    // itinerary_items has no `arrival_time` column, so that half of the
    // expression was always undefined (masked by select('*')). Harmless in
    // itself, but it hid the real case: an item with no end_time silently
    // fell back to "expires in 24 hours", which the caller could not tell
    // apart from an expiry derived from the arrival. `expiresBasis` now says
    // which it is.
    let expiresAt;
    let expiresBasis;
    const endTime = item.end_time ? new Date(item.end_time) : null;
    if (endTime && Number.isFinite(endTime.getTime())) {
      expiresAt = new Date(endTime.getTime() + 2 * 60 * 60 * 1000);
      expiresBasis = 'item_end_time';
    } else {
      expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      expiresBasis = 'default_24h';
    }
    const id = generateId('eta_');
    const token = generateToken();
    const { data, error } = await supabase.from('eta_links').insert({
      id,
      trip_id: tripId,
      item_id: itemId,
      created_by: memberId,
      token,
      expires_at: expiresAt.toISOString()
    }).select().single();
    if (error) return errResp('DB_ERROR', error.message, 500);
    return jsonResp({
      token,
      url: `https://travelos.app/eta/${token}`,
      expiresAt: expiresAt.toISOString(),
      expiresBasis,
      id: data.id
    }, 201);
  }
  return errResp('NOT_FOUND', 'Route not found', 404);
});

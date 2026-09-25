// RATE LIMITING 2026-09-18 —
// `checkRateLimit` never limited anything, for the life of the project, because
// of two independent fatal bugs:
//
//   1. It filtered `rate_limit_buckets` on `actor_id`. That column does not
//      exist — the table has `bucket_key`. PostgREST rejects the whole query
//      with 42703; the error was discarded, `data` came back null, and
//      `if (data && data.request_count >= 120) return false` therefore never
//      fired. The matching upsert failed the same way, which is why the table
//      had zero rows.
//   2. It wrote `bucket_type: 'api'`. The table's check constraint only
//      permits `global | strict | user_quota`, so even with the column name
//      corrected every write would still have been rejected. Found by running
//      the replacement against the real table rather than reading the schema.
//
// There was a third, quieter problem the column name was hiding: select-then-
// upsert is not atomic. Two concurrent requests both read 5 and both write 6,
// so a caller could exceed any limit just by being parallel. Counting now
// happens inside a single statement in `public.rate_limit_hit`, so the count
// is exact under concurrency.
//
// Deliberate choice: the limiter FAILS OPEN on a database error, but logs at
// error level with an unmissable prefix. Failing closed would turn a limiter
// outage into a total API outage. The defect being fixed here was failing open
// *silently* — the logging is the part that matters.
//
// Not covered: unauthenticated requests. `authenticate()` runs an
// `auth_identities` lookup or a guest-token hash lookup before returning null,
// so an unauthenticated flood still costs database work. Limiting that needs
// an IP-derived bucket and is a separate change.
//
// INVITE LINK HOST 2026-09-18 —
// Both places that mint a guest invite read
// `Deno.env.get('APP_BASE_URL') || 'https://app.travelos.com'`. APP_BASE_URL
// has never been set and `app.travelos.com` is not a host this project
// controls, so every guest invite link would have pointed somewhere else
// entirely — an invite that cannot be accepted, sent to a stranger's domain.
//
// Nothing had actually broken yet: `trip_members` contained no `kind='guest'`
// row and `audit_log` no `member.guest_*` entry, so not one invite had ever
// been minted. The first one would have been wrong. See appBaseUrl() below.
//
// IDENTITY BRIDGE 2026-09-18 —
// `authenticate()` looked up `auth_identities` with
// `.eq('provider', provider).eq('provider_subject', user.id)`. The `provider`
// column is `app_metadata.provider || 'email_link'`, so it varies by sign-in
// method: the same human signing in through Google or Apple rather than email
// would miss their own identity row and be returned as `null` — an
// indistinguishable 401 for a legitimate member. Fixed by matching on
// `provider_subject` ALONE, which is the verified token's `user.id` and the
// only stable key.
//
// SECURITY 2026-09-16 —
// Two authorization defects fixed in this function.
//
// 1) Missing tenant filter on role/removal writes. The DELETE
//    /trips/:tripId/members/:memberId and PATCH
//    /trips/:tripId/members/:memberId/role handlers looked up and mutated
//    trip_members rows with `.eq('id', memberId)` alone. `trip_members.id`
//    is globally unique across all trips, not scoped to a trip, so an
//    owner/organizer of trip A who obtained (or guessed/enumerated) a
//    member id belonging to trip B could change that member's role or
//    remove them from trip B, despite having no membership in trip B at
//    all — a cross-tenant authorization bypass. Fixed by adding
//    `.eq('trip_id', tripId)` to every read and write keyed by memberId in
//    those two handlers.
//
// 2) Privilege escalation via member.invite. POST
//    /trips/:tripId/members accepted `body.role` and wrote it straight to
//    trip_members.role with no validation against the role matrix and no
//    check against the caller's own role. Any organizer could mint a new
//    member with role 'owner'. Fixed by validating `role` against the four
//    known roles and rejecting any invite where the requested role outranks
//    the caller's own.
//
// DEFECT 2026-09-19 (42703 — IDEMPOTENCY-KEY HAS ALWAYS BEEN IGNORED).
//
// checkIdempotency/saveIdempotency were written against `idempotency_keys`
// using the columns `key`, `actor_id`, `request_hash`, `response_status` and
// `response_body`. That table has none of them; its columns are
// (id, idempotency_key, operation_id, result_id, result_type, status,
// created_at, completed_at, expires_at). Every read failed with 42703 and the
// error was discarded, so `existing` was null and checkIdempotency always
// returned "no previous request"; every write failed the same way, and
// `onConflict: 'key,actor_id'` named columns with no unique constraint anyway.
//
// The effect: POST /trips accepted an Idempotency-Key header, appeared to
// honour it, and honoured nothing. A client retrying a create after a timeout
// — exactly what the header exists for — got a SECOND trip, with a second
// owner membership row, every time.
//
// Rewritten against `idempotency_records`, which has the right shape for this
// (request_hash, status, response_reference) and a real UNIQUE(user_id,
// idempotency_key). Note user_id there is a uuid, so it takes the caller's
// auth uuid, NOT the platform TEXT user id — passing the latter would be a
// 22P02, not an empty result. The key is also now CLAIMED before the trip is
// created rather than recorded after it, so two concurrent retries cannot both
// pass the check and both create a trip.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-guest-token, idempotency-key, if-match'
};
// 120 requests per rolling 60-second fixed window, per actor.
const RATE_LIMIT_MAX = 120;
const RATE_LIMIT_WINDOW_SECONDS = 60;
// Must be one of global | strict | user_quota — see rate_limit_buckets_bucket_type_check.
const RATE_LIMIT_BUCKET_TYPE = 'user_quota';
const IDEMPOTENCY_TTL_MS = 86400000;
// The deployed TravelOS web app, confirmed serving the real application on
// 2026-09-18. `APP_BASE_URL` still wins when set — set it the moment a custom
// domain exists, and links minted after that use it. A trailing slash in the
// env value is trimmed so the result is never `https://host//join?token=...`.
const DEFAULT_APP_BASE_URL = 'https://travelos-frontend-pi.vercel.app';
function appBaseUrl() {
  const configured = Deno.env.get('APP_BASE_URL')?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  console.warn(`[platform-trips] APP_BASE_URL not set; guest invite links use the default host ${DEFAULT_APP_BASE_URL}`);
  return DEFAULT_APP_BASE_URL;
}
const db = ()=>createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));
function errResp(status, code, message, details) {
  return new Response(JSON.stringify({
    error: {
      code,
      message,
      details
    }
  }), {
    status,
    headers: {
      ...cors,
      'Content-Type': 'application/json'
    }
  });
}
function ok(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors,
      'Content-Type': 'application/json'
    }
  });
}
function genId(prefix) {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return `${prefix}_${Array.from(bytes).map((b)=>b.toString(16).padStart(2, '0')).join('')}`;
}
async function sha256Hex(input) {
  const enc = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf)).map((b)=>b.toString(16).padStart(2, '0')).join('');
}
const MATRIX = {
  'trip.read': [
    'owner',
    'organizer',
    'member',
    'viewer'
  ],
  'trip.update': [
    'owner',
    'organizer'
  ],
  'trip.delete': [
    'owner'
  ],
  'member.invite': [
    'owner',
    'organizer'
  ],
  'member.remove': [
    'owner',
    'organizer'
  ],
  'member.role': [
    'owner'
  ],
  'content.create': [
    'owner',
    'organizer',
    'member'
  ],
  'content.update_own': [
    'owner',
    'organizer',
    'member'
  ],
  'content.update_any': [
    'owner',
    'organizer'
  ],
  'content.delete_any': [
    'owner',
    'organizer'
  ],
  'finance.write': [
    'owner',
    'organizer',
    'member'
  ],
  'finance.admin': [
    'owner',
    'organizer'
  ]
};
// Hierarchy derived from MATRIX: owner > organizer > member > viewer.
const ROLE_RANK = {
  owner: 3,
  organizer: 2,
  member: 1,
  viewer: 0
};
async function authenticate(req, supabase) {
  const authHeader = req.headers.get('Authorization');
  const guestToken = req.headers.get('X-Guest-Token');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const anonClient = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_ANON_KEY'), {
      global: {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    });
    const { data: { user } } = await anonClient.auth.getUser();
    if (!user) return null;
    // Match on provider_subject ALONE — never on `provider`. See header.
    // limit(1) rather than maybeSingle(): auth_identities is UNIQUE(provider,
    // provider_subject), so one subject can hold two rows (same person, two
    // sign-in methods) and maybeSingle() would error on the second.
    const { data: identities, error: identityErr } = await supabase.from('auth_identities').select('user_id').eq('provider_subject', user.id).limit(1);
    if (identityErr) {
      console.error('[platform-trips] auth_identities lookup failed:', identityErr.code, identityErr.message);
      return null;
    }
    const identity = identities?.[0];
    if (!identity) return null;
    return {
      type: 'user',
      userId: identity.user_id,
      authUserId: user.id
    };
  }
  if (guestToken) {
    const hash = await sha256Hex(guestToken);
    const { data: member, error: memberErr } = await supabase.from('trip_members').select('id, trip_id, guest_expires_at, removed_at').eq('guest_token_hash', hash).eq('kind', 'guest').maybeSingle();
    if (memberErr) {
      console.error('[platform-trips] guest token lookup failed:', memberErr.code, memberErr.message);
      return null;
    }
    if (!member || member.removed_at) return null;
    if (member.guest_expires_at && new Date(member.guest_expires_at) < new Date()) return null;
    return {
      type: 'guest',
      memberId: member.id,
      tripId: member.trip_id
    };
  }
  return null;
}
async function authorize(supabase, actor, tripId, action) {
  let member = null;
  if (actor.type === 'guest') {
    if (actor.tripId !== tripId) {
      throw {
        status: 404,
        code: 'TRIP_NOT_FOUND',
        message: 'Trip not found'
      };
    }
    const { data, error } = await supabase.from('trip_members').select('id, role, display_name').eq('id', actor.memberId).eq('trip_id', tripId).is('removed_at', null).maybeSingle();
    // DEFECT 2026-09-19 — the error was discarded here and in the branch below,
    // so a failed membership read was thrown as TRIP_NOT_FOUND: a member of the
    // trip was told the trip does not exist.
    if (error) {
      console.error('[platform-trips] guest membership read failed:', error.code, error.message);
      throw {
        status: 500,
        code: 'DB_ERROR',
        message: 'Failed to check trip membership'
      };
    }
    member = data;
  } else {
    const { data, error } = await supabase.from('trip_members').select('id, role, display_name').eq('trip_id', tripId).eq('user_id', actor.userId).is('removed_at', null).maybeSingle();
    if (error) {
      console.error('[platform-trips] membership read failed:', error.code, error.message);
      throw {
        status: 500,
        code: 'DB_ERROR',
        message: 'Failed to check trip membership'
      };
    }
    member = data;
  }
  if (!member) throw {
    status: 404,
    code: 'TRIP_NOT_FOUND',
    message: 'Trip not found'
  };
  const allowed = MATRIX[action];
  if (!allowed.includes(member.role)) {
    throw {
      status: 403,
      code: 'FORBIDDEN',
      message: `Action '${action}' requires role: ${allowed.join(', ')}`
    };
  }
  return member;
}
/**
 * Claims an idempotency key BEFORE the work is done. See the header note.
 * Returns either permission to proceed, or the Response to send (a replay of
 * the earlier result, a conflict, or a failure).
 */ async function claimIdempotency(supabase, key, authUserId, body) {
  const requestHash = await sha256Hex(body);
  const { error: insertErr } = await supabase.from('idempotency_records').insert({
    idempotency_key: key,
    user_id: authUserId,
    operation_type: 'platform_trips.create_trip',
    request_hash: requestHash,
    status: 'IN_PROGRESS',
    expires_at: new Date(Date.now() + IDEMPOTENCY_TTL_MS).toISOString()
  });
  if (!insertErr) return {
    proceed: true
  };
  if (insertErr.code !== '23505') {
    console.error('[platform-trips] idempotency claim failed:', insertErr.code, insertErr.message);
    return {
      response: errResp(500, 'DB_ERROR', 'Failed to record the idempotency key')
    };
  }
  // A record already exists for this (user, key).
  const { data: existing, error: readErr } = await supabase.from('idempotency_records').select('request_hash, status, response_reference, created_at').eq('user_id', authUserId).eq('idempotency_key', key).maybeSingle();
  if (readErr) {
    console.error('[platform-trips] idempotency read failed:', readErr.code, readErr.message);
    return {
      response: errResp(500, 'DB_ERROR', 'Failed to read the idempotency key')
    };
  }
  if (!existing) {
    // Deleted between the insert and the read; let the caller retry rather than
    // risk creating a second trip.
    return {
      response: errResp(409, 'IDEMPOTENCY_RACE', 'Please retry this request')
    };
  }
  if (Date.now() - new Date(existing.created_at).getTime() > IDEMPOTENCY_TTL_MS) {
    // Expired: replace it and let the work run again.
    const { error: refreshErr } = await supabase.from('idempotency_records').update({
      request_hash: requestHash,
      status: 'IN_PROGRESS',
      response_reference: null,
      completed_at: null,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + IDEMPOTENCY_TTL_MS).toISOString()
    }).eq('user_id', authUserId).eq('idempotency_key', key);
    if (refreshErr) {
      console.error('[platform-trips] idempotency refresh failed:', refreshErr.code, refreshErr.message);
      return {
        response: errResp(500, 'DB_ERROR', 'Failed to reuse the expired idempotency key')
      };
    }
    return {
      proceed: true
    };
  }
  if (existing.request_hash && existing.request_hash !== requestHash) {
    return {
      response: errResp(422, 'IDEMPOTENCY_MISMATCH', 'Same key used with different request body')
    };
  }
  if (existing.status === 'SUCCEEDED' && existing.response_reference) {
    try {
      return {
        response: ok(JSON.parse(existing.response_reference), 201)
      };
    } catch  {
      console.error('[platform-trips] stored idempotent response is not JSON');
      return {
        response: errResp(500, 'IDEMPOTENCY_CORRUPT', 'The stored response for this key could not be read')
      };
    }
  }
  // Still running, or it failed and left no result.
  return {
    response: errResp(409, 'IDEMPOTENCY_IN_PROGRESS', 'A request with this key is already being processed')
  };
}
async function completeIdempotency(supabase, key, authUserId, responseBody) {
  const { error } = await supabase.from('idempotency_records').update({
    status: 'SUCCEEDED',
    response_reference: JSON.stringify(responseBody),
    completed_at: new Date().toISOString()
  }).eq('user_id', authUserId).eq('idempotency_key', key);
  if (error) {
    console.error('[platform-trips] idempotency completion failed:', error.code, error.message);
  }
}
async function releaseIdempotency(supabase, key, authUserId) {
  const { error } = await supabase.from('idempotency_records').delete().eq('user_id', authUserId).eq('idempotency_key', key);
  if (error) {
    console.error('[platform-trips] idempotency release failed:', error.code, error.message);
  }
}
async function writeAudit(supabase, opts) {
  // DEFECT 2026-09-19 — the error was discarded. audit_log is the record of who
  // changed what on a shared trip; entries could be missing with nothing
  // anywhere saying so. Still non-fatal to the operation, but now logged.
  const { error } = await supabase.from('audit_log').insert({
    id: genId('aud'),
    trip_id: opts.tripId,
    actor_member_id: opts.actorMemberId,
    actor_user_id: opts.actorUserId,
    action: opts.action,
    entity_type: opts.entityType,
    entity_id: opts.entityId,
    before: opts.before || null,
    after: opts.after || null
  });
  if (error) {
    console.error('[platform-trips] audit_log insert failed:', error.code, error.message, opts.action);
    return false;
  }
  return true;
}
/**
 * Records one request against the caller's bucket and reports whether it is
 * within the limit. All counting happens inside `public.rate_limit_hit`, in a
 * single atomic statement — see the header for why the previous select-then-
 * upsert could not work.
 *
 * Fails OPEN on error, but never silently: a limiter outage must not take the
 * whole API down, and the log line is what makes the failure detectable.
 */ async function checkRateLimit(supabase, bucketKey) {
  const { data, error } = await supabase.rpc('rate_limit_hit', {
    p_bucket_key: bucketKey,
    p_bucket_type: RATE_LIMIT_BUCKET_TYPE,
    p_limit: RATE_LIMIT_MAX,
    p_window_seconds: RATE_LIMIT_WINDOW_SECONDS
  });
  if (error) {
    console.error('[platform-trips] RATE LIMIT NOT ENFORCED — rate_limit_hit failed:', error.message);
    return {
      allowed: true,
      retryAfter: 0
    };
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row.is_allowed !== 'boolean') {
    console.error('[platform-trips] RATE LIMIT NOT ENFORCED — rate_limit_hit returned no usable row');
    return {
      allowed: true,
      retryAfter: 0
    };
  }
  if (!row.is_allowed) {
    console.warn(`[platform-trips] rate limited ${bucketKey} at ${row.hits} hits (limit ${RATE_LIMIT_MAX})`);
  }
  return {
    allowed: row.is_allowed,
    retryAfter: typeof row.retry_after_seconds === 'number' ? row.retry_after_seconds : RATE_LIMIT_WINDOW_SECONDS
  };
}
serve(async (req)=>{
  if (req.method === 'OPTIONS') return new Response('ok', {
    headers: cors
  });
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/platform-trips/, '').replace(/^\/api/, '');
  const supabase = db();
  const actor = await authenticate(req, supabase);
  if (actor) {
    // Namespaced so a platform user id can never collide with a member id.
    const bucketKey = actor.type === 'guest' ? `platform-trips:guest:${actor.memberId}` : `platform-trips:user:${actor.userId}`;
    const { allowed, retryAfter } = await checkRateLimit(supabase, bucketKey);
    if (!allowed) {
      return new Response(JSON.stringify({
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many requests'
        }
      }), {
        status: 429,
        headers: {
          ...cors,
          'Content-Type': 'application/json',
          'Retry-After': String(Math.max(1, retryAfter))
        }
      });
    }
  }
  try {
    // ── POST /trips — create trip ────────────────────────────────────
    if (req.method === 'POST' && path === '/trips') {
      if (!actor || actor.type !== 'user') return errResp(401, 'UNAUTHORIZED', 'Sign in required');
      const body = await req.json();
      if (!body.title) return errResp(400, 'BAD_REQUEST', 'title is required');
      const rawBody = JSON.stringify(body);
      const idempKey = req.headers.get('Idempotency-Key');
      if (idempKey) {
        const outcome = await claimIdempotency(supabase, idempKey, actor.authUserId, rawBody);
        if ('response' in outcome) return outcome.response;
      }
      const tripId = crypto.randomUUID();
      const memberId = genId('mem');
      // DEFECT 2026-09-19 (fabricated data) — this inserted
      //   primary_tz: body.primaryTz || 'UTC'
      //   base_currency: body.baseCurrency || 'USD'
      // so a trip created without either was recorded as being in UTC and
      // budgeted in US dollars, as though the traveller had said so. Every
      // downstream figure — budget analysis, settlements, arrival times — then
      // read those as the user's choice. Both columns are NOT NULL with those
      // same values as DATABASE defaults, so the honest move is to omit the
      // field and let the schema default apply, then tell the caller which
      // values they did not choose.
      const defaultsApplied = [];
      const tripRow = {
        id: tripId,
        user_id: actor.authUserId,
        name: body.title,
        title: body.title,
        start_date: body.startDate || null,
        end_date: body.endDate || null
      };
      if (body.primaryTz) tripRow.primary_tz = body.primaryTz;
      else defaultsApplied.push('primary_tz');
      if (body.baseCurrency) tripRow.base_currency = body.baseCurrency;
      else defaultsApplied.push('base_currency');
      const { error: tripErr } = await supabase.from('trips').insert(tripRow);
      if (tripErr) {
        console.error('[platform-trips] trip insert failed:', tripErr.message);
        if (idempKey) await releaseIdempotency(supabase, idempKey, actor.authUserId);
        return errResp(500, 'TRIP_INSERT_FAILED', tripErr.message);
      }
      const { error: memberErr } = await supabase.from('trip_members').insert({
        id: memberId,
        trip_id: tripId,
        user_id: actor.userId,
        kind: 'account',
        role: 'owner',
        display_name: body.displayName || 'Owner'
      });
      if (memberErr) {
        console.error('[platform-trips] trip_members insert failed:', memberErr.message);
        // A trip with no owner membership is unreachable by every other route
        // here. Do not leave one behind.
        await supabase.from('trips').delete().eq('id', tripId);
        if (idempKey) await releaseIdempotency(supabase, idempKey, actor.authUserId);
        return errResp(500, 'MEMBER_INSERT_FAILED', memberErr.message);
      }
      await writeAudit(supabase, {
        tripId,
        actorUserId: actor.userId,
        action: 'trip.create',
        entityType: 'trip',
        entityId: tripId,
        after: {
          title: body.title
        }
      });
      const resp = {
        tripId,
        memberId,
        ...defaultsApplied.length ? {
          defaults_applied: defaultsApplied
        } : {}
      };
      if (idempKey) await completeIdempotency(supabase, idempKey, actor.authUserId, resp);
      return ok(resp, 201);
    }
    // ── GET /trips/:tripId — get trip ─────────────────────────────────
    const tripMatch = path.match(/^\/trips\/([^/]+)$/);
    if (req.method === 'GET' && tripMatch) {
      if (!actor) return errResp(401, 'UNAUTHORIZED', 'Authentication required');
      const tripId = tripMatch[1];
      await authorize(supabase, actor, tripId, 'trip.read');
      const { data: trip, error: tripErr } = await supabase.from('trips').select('*').eq('id', tripId).maybeSingle();
      if (tripErr) {
        console.error('[platform-trips] trip read failed:', tripErr.code, tripErr.message);
        return errResp(500, 'DB_ERROR', 'Failed to load trip');
      }
      if (!trip) return errResp(404, 'TRIP_NOT_FOUND', 'Trip not found');
      return ok({
        trip
      });
    }
    // ── PATCH /trips/:tripId — update trip ─────────────────────────────
    if (req.method === 'PATCH' && tripMatch) {
      if (!actor) return errResp(401, 'UNAUTHORIZED', 'Authentication required');
      const tripId = tripMatch[1];
      await authorize(supabase, actor, tripId, 'trip.update');
      const body = await req.json();
      const ifMatch = req.headers.get('If-Match');
      const { data: current, error: currentErr } = await supabase.from('trips').select('*').eq('id', tripId).maybeSingle();
      if (currentErr) {
        console.error('[platform-trips] trip read failed:', currentErr.code, currentErr.message);
        return errResp(500, 'DB_ERROR', 'Failed to load trip');
      }
      if (!current) return errResp(404, 'TRIP_NOT_FOUND', 'Trip not found');
      if (ifMatch && String(current.version) !== ifMatch) {
        return errResp(409, 'VERSION_CONFLICT', 'Version conflict', {
          current
        });
      }
      const updates = {};
      if (body.title !== undefined) updates.title = body.title;
      if (body.startDate !== undefined) updates.start_date = body.startDate;
      if (body.endDate !== undefined) updates.end_date = body.endDate;
      if (body.primaryTz !== undefined) updates.primary_tz = body.primaryTz;
      updates.version = current.version + 1;
      // DEFECT 2026-09-19 — the update's error was discarded and
      // `{ updated: true, version }` returned regardless, so a failed edit was
      // reported as saved AND advertised a new version number the row never
      // reached. The version filter also makes the If-Match check real: it was
      // previously read-then-write, so two concurrent edits both passed the
      // check and the second silently overwrote the first.
      const { data: updatedRows, error: updateErr } = await supabase.from('trips').update(updates).eq('id', tripId).eq('version', current.version).select('id');
      if (updateErr) {
        console.error('[platform-trips] trip update failed:', updateErr.code, updateErr.message);
        return errResp(500, 'DB_ERROR', 'Failed to update trip');
      }
      if (!updatedRows || updatedRows.length === 0) {
        return errResp(409, 'VERSION_CONFLICT', 'The trip changed while you were editing it');
      }
      await writeAudit(supabase, {
        tripId,
        actorUserId: actor.userId,
        actorMemberId: actor.memberId,
        action: 'trip.update',
        entityType: 'trip',
        entityId: tripId,
        before: current,
        after: updates
      });
      return ok({
        updated: true,
        version: updates.version
      });
    }
    // ── GET /trips/:tripId/members ─────────────────────────────────
    const membersMatch = path.match(/^\/trips\/([^/]+)\/members$/);
    if (req.method === 'GET' && membersMatch) {
      if (!actor) return errResp(401, 'UNAUTHORIZED', 'Authentication required');
      const tripId = membersMatch[1];
      await authorize(supabase, actor, tripId, 'trip.read');
      const limit = parseInt(url.searchParams.get('limit') || '50');
      const cursor = url.searchParams.get('cursor');
      let query = supabase.from('trip_members').select('id, kind, role, display_name, joined_at').eq('trip_id', tripId).is('removed_at', null).order('joined_at', {
        ascending: true
      }).limit(limit + 1);
      if (cursor) query = query.gt('joined_at', cursor);
      // Previously discarded: a failed read rendered as "this trip has no
      // members", to a caller who had just been authorized AS a member of it.
      const { data: members, error: membersErr } = await query;
      if (membersErr) {
        console.error('[platform-trips] members read failed:', membersErr.code, membersErr.message);
        return errResp(500, 'DB_ERROR', 'Failed to load trip members');
      }
      const items = (members || []).slice(0, limit);
      const nextCursor = members && members.length > limit ? members[limit - 1].joined_at : null;
      return ok({
        items,
        nextCursor
      });
    }
    // ── POST /trips/:tripId/members — invite account member ──────────────────
    if (req.method === 'POST' && membersMatch) {
      if (!actor) return errResp(401, 'UNAUTHORIZED', 'Authentication required');
      const tripId = membersMatch[1];
      const actorMember = await authorize(supabase, actor, tripId, 'member.invite');
      const body = await req.json();
      if (!body.userId) return errResp(400, 'BAD_REQUEST', 'userId is required');
      const requestedRole = body.role || 'member';
      if (!(requestedRole in ROLE_RANK)) {
        return errResp(400, 'BAD_REQUEST', 'Invalid role', {
          role: body.role
        });
      }
      if (ROLE_RANK[requestedRole] > ROLE_RANK[actorMember.role]) {
        return errResp(403, 'FORBIDDEN', 'Cannot grant a role above your own');
      }
      const memberId = genId('mem');
      // DEFECT 2026-09-19 — the insert's error was discarded and 201 returned
      // with a memberId for a member that was never created.
      const { error: inviteErr } = await supabase.from('trip_members').insert({
        id: memberId,
        trip_id: tripId,
        user_id: body.userId,
        kind: 'account',
        role: requestedRole,
        display_name: body.displayName || 'Member'
      });
      if (inviteErr) {
        console.error('[platform-trips] member invite insert failed:', inviteErr.code, inviteErr.message);
        return errResp(500, 'DB_ERROR', `Failed to add member: ${inviteErr.message}`);
      }
      await writeAudit(supabase, {
        tripId,
        actorUserId: actor.userId,
        actorMemberId: actor.memberId,
        action: 'member.invite',
        entityType: 'trip_member',
        entityId: memberId,
        after: {
          userId: body.userId,
          role: requestedRole
        }
      });
      return ok({
        memberId
      }, 201);
    }
    // ── POST /trips/:tripId/guests — create guest invite ────────────────────
    const guestsMatch = path.match(/^\/trips\/([^/]+)\/guests$/);
    if (req.method === 'POST' && guestsMatch) {
      if (!actor) return errResp(401, 'UNAUTHORIZED', 'Authentication required');
      const tripId = guestsMatch[1];
      await authorize(supabase, actor, tripId, 'member.invite');
      const body = await req.json();
      if (!body.displayName) return errResp(400, 'BAD_REQUEST', 'displayName is required');
      const guestRole = body.role || 'member';
      if (!(guestRole in ROLE_RANK)) {
        return errResp(400, 'BAD_REQUEST', 'Invalid role', {
          role: body.role
        });
      }
      const { data: trip, error: tripErr } = await supabase.from('trips').select('end_date').eq('id', tripId).maybeSingle();
      if (tripErr) {
        console.error('[platform-trips] trip read failed:', tripErr.code, tripErr.message);
        return errResp(500, 'DB_ERROR', 'Failed to load trip');
      }
      const rawBytes = crypto.getRandomValues(new Uint8Array(32));
      const rawToken = btoa(String.fromCharCode(...rawBytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const tokenHash = await sha256Hex(rawToken);
      let expiresAt;
      if (body.expiresInDays) {
        expiresAt = new Date(Date.now() + body.expiresInDays * 86400000).toISOString();
      } else if (trip?.end_date) {
        expiresAt = new Date(new Date(trip.end_date).getTime() + 30 * 86400000).toISOString();
      } else {
        expiresAt = new Date(Date.now() + 30 * 86400000).toISOString();
      }
      const memberId = genId('mem');
      // DEFECT 2026-09-19 — the insert's error was discarded and an inviteUrl
      // was returned regardless. The caller would then send someone a guest
      // link whose token hash was never stored, so the invite could never be
      // accepted — and nothing in the response or the logs said so.
      const { error: guestErr } = await supabase.from('trip_members').insert({
        id: memberId,
        trip_id: tripId,
        kind: 'guest',
        role: guestRole,
        display_name: body.displayName,
        guest_token_hash: tokenHash,
        guest_expires_at: expiresAt
      });
      if (guestErr) {
        console.error('[platform-trips] guest invite insert failed:', guestErr.code, guestErr.message);
        return errResp(500, 'DB_ERROR', `Failed to create guest invite: ${guestErr.message}`);
      }
      await writeAudit(supabase, {
        tripId,
        actorUserId: actor.userId,
        actorMemberId: actor.memberId,
        action: 'member.guest_invite',
        entityType: 'trip_member',
        entityId: memberId,
        after: {
          displayName: body.displayName,
          role: guestRole,
          expiresAt
        }
      });
      const inviteUrl = `${appBaseUrl()}/join?token=${rawToken}`;
      return ok({
        member: {
          id: memberId,
          displayName: body.displayName,
          role: guestRole,
          expiresAt
        },
        inviteUrl
      }, 201);
    }
    // ── POST /trips/:tripId/guests/:memberId/rotate — rotate guest token ───
    const rotateMatch = path.match(/^\/trips\/([^/]+)\/guests\/([^/]+)\/rotate$/);
    if (req.method === 'POST' && rotateMatch) {
      if (!actor) return errResp(401, 'UNAUTHORIZED', 'Authentication required');
      const [, tripId, memberId] = rotateMatch;
      await authorize(supabase, actor, tripId, 'member.invite');
      const rawBytes = crypto.getRandomValues(new Uint8Array(32));
      const rawToken = btoa(String.fromCharCode(...rawBytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const tokenHash = await sha256Hex(rawToken);
      // DEFECT 2026-09-19 — neither the error nor the affected-row count was
      // checked, and a new inviteUrl was returned regardless. Rotating a guest
      // token is how you revoke access for someone who should no longer have
      // it; a failed rotation reported as success left the OLD token working
      // while the trip owner believed they had cut it off.
      const { data: rotated, error: rotateErr } = await supabase.from('trip_members').update({
        guest_token_hash: tokenHash
      }).eq('id', memberId).eq('trip_id', tripId).eq('kind', 'guest').select('id');
      if (rotateErr) {
        console.error('[platform-trips] guest token rotate failed:', rotateErr.code, rotateErr.message);
        return errResp(500, 'DB_ERROR', 'Failed to rotate the guest token; the previous link is still valid');
      }
      if (!rotated || rotated.length === 0) {
        return errResp(404, 'NOT_FOUND', 'Guest member not found on this trip; no token was rotated');
      }
      await writeAudit(supabase, {
        tripId,
        actorUserId: actor.userId,
        action: 'member.guest_rotate',
        entityType: 'trip_member',
        entityId: memberId
      });
      return ok({
        inviteUrl: `${appBaseUrl()}/join?token=${rawToken}`
      });
    }
    // ── DELETE /trips/:tripId/members/:memberId — remove member ─────────────
    const memberIdMatch = path.match(/^\/trips\/([^/]+)\/members\/([^/]+)$/);
    if (req.method === 'DELETE' && memberIdMatch) {
      if (!actor) return errResp(401, 'UNAUTHORIZED', 'Authentication required');
      const [, tripId, memberId] = memberIdMatch;
      const actorMember = await authorize(supabase, actor, tripId, 'member.remove');
      const { data: target, error: targetErr } = await supabase.from('trip_members').select('role, user_id').eq('id', memberId).eq('trip_id', tripId).maybeSingle();
      if (targetErr) {
        console.error('[platform-trips] target member read failed:', targetErr.code, targetErr.message);
        return errResp(500, 'DB_ERROR', 'Failed to load that member');
      }
      if (!target) return errResp(404, 'NOT_FOUND', 'Member not found');
      if (target.role === 'owner') {
        // Previously the count's error was discarded, so `(count || 0) <= 1`
        // was TRUE on a failed query and a legitimate removal was refused with
        // LAST_OWNER. Failing closed is right here, but it should say why.
        const { count, error: countErr } = await supabase.from('trip_members').select('id', {
          count: 'exact',
          head: true
        }).eq('trip_id', tripId).eq('role', 'owner').is('removed_at', null);
        if (countErr) {
          console.error('[platform-trips] owner count failed:', countErr.code, countErr.message);
          return errResp(500, 'DB_ERROR', 'Could not confirm how many owners this trip has, so nothing was removed');
        }
        if ((count || 0) <= 1) {
          return errResp(409, 'LAST_OWNER', 'Transfer ownership before leaving');
        }
      }
      // Previously the error was discarded and `{ removed: true }` returned.
      const { data: removed, error: removeErr } = await supabase.from('trip_members').update({
        removed_at: new Date().toISOString()
      }).eq('id', memberId).eq('trip_id', tripId).is('removed_at', null).select('id');
      if (removeErr) {
        console.error('[platform-trips] member remove failed:', removeErr.code, removeErr.message);
        return errResp(500, 'DB_ERROR', 'Failed to remove that member');
      }
      if (!removed || removed.length === 0) {
        return errResp(404, 'NOT_FOUND', 'Member not found or already removed');
      }
      await writeAudit(supabase, {
        tripId,
        actorUserId: actor.userId,
        actorMemberId: actorMember.id,
        action: 'member.remove',
        entityType: 'trip_member',
        entityId: memberId
      });
      return ok({
        removed: true
      });
    }
    // ── PATCH /trips/:tripId/members/:memberId/role — change role ──────────
    const roleMatch = path.match(/^\/trips\/([^/]+)\/members\/([^/]+)\/role$/);
    if (req.method === 'PATCH' && roleMatch) {
      if (!actor) return errResp(401, 'UNAUTHORIZED', 'Authentication required');
      const [, tripId, memberId] = roleMatch;
      await authorize(supabase, actor, tripId, 'member.role');
      const body = await req.json();
      // DEFECT 2026-09-19 — `body.role` was written straight through with no
      // validation, unlike the invite handler two blocks up. trip_members.role
      // is a Postgres enum, so an unrecognised value failed the write — and
      // with the error discarded the caller got `{ updated: true }` and the
      // role was unchanged. A value the enum happened to accept but MATRIX
      // does not list would be worse: that member would pass no permission
      // check at all and silently lose access to the trip.
      const newRole = body.role;
      if (!newRole || !(newRole in ROLE_RANK)) {
        return errResp(400, 'BAD_REQUEST', 'Invalid role', {
          role: body.role,
          allowed: Object.keys(ROLE_RANK)
        });
      }
      const { data: updated, error: roleErr } = await supabase.from('trip_members').update({
        role: newRole
      }).eq('id', memberId).eq('trip_id', tripId).is('removed_at', null).select('id');
      if (roleErr) {
        console.error('[platform-trips] role update failed:', roleErr.code, roleErr.message);
        return errResp(500, 'DB_ERROR', `Failed to change role: ${roleErr.message}`);
      }
      if (!updated || updated.length === 0) {
        return errResp(404, 'NOT_FOUND', 'Member not found on this trip');
      }
      await writeAudit(supabase, {
        tripId,
        actorUserId: actor.userId,
        action: 'member.role_change',
        entityType: 'trip_member',
        entityId: memberId,
        after: {
          role: newRole
        }
      });
      return ok({
        updated: true
      });
    }
    // ── GET /trips/:tripId/audit — audit log ────────────────────────────
    const auditMatch = path.match(/^\/trips\/([^/]+)\/audit$/);
    if (req.method === 'GET' && auditMatch) {
      if (!actor) return errResp(401, 'UNAUTHORIZED', 'Authentication required');
      const tripId = auditMatch[1];
      await authorize(supabase, actor, tripId, 'trip.read');
      const limit = parseInt(url.searchParams.get('limit') || '50');
      const cursor = url.searchParams.get('cursor');
      let query = supabase.from('audit_log').select('id, actor_member_id, actor_user_id, action, entity_type, entity_id, created_at').eq('trip_id', tripId).order('created_at', {
        ascending: false
      }).limit(limit + 1);
      if (cursor) query = query.lt('created_at', cursor);
      // Previously discarded: a failed read presented as an EMPTY audit log,
      // which is the one thing an audit log must never claim falsely.
      const { data: entries, error: auditErr } = await query;
      if (auditErr) {
        console.error('[platform-trips] audit read failed:', auditErr.code, auditErr.message);
        return errResp(500, 'DB_ERROR', 'Failed to load the audit log');
      }
      const items = (entries || []).slice(0, limit);
      const nextCursor = entries && entries.length > limit ? entries[limit - 1].created_at : null;
      return ok({
        items,
        nextCursor
      });
    }
    // ── Phase 4 aliases ──────────────────────────────────────────
    const phase4Aliases = {
      '/price-snapshots': 'price-snapshots',
      '/better-deals': 'deals',
      '/safety-assessments': 'safety-assessments',
      '/health-alerts': 'health-alerts',
      '/natural-disaster-alerts': 'disaster-alerts'
    };
    for (const [alias, _target] of Object.entries(phase4Aliases)){
      if (req.method === 'POST' && path === alias) {
        if (!actor) return errResp(401, 'UNAUTHORIZED', 'Authentication required');
        const body = await req.json();
        if (!body.tripId) return errResp(400, 'BAD_REQUEST', 'tripId required in body for legacy endpoint');
        await authorize(supabase, actor, body.tripId, 'content.create');
        const audited = await writeAudit(supabase, {
          tripId: body.tripId,
          actorUserId: actor.userId,
          action: `phase4.${alias.slice(1)}`,
          entityType: alias.slice(1),
          entityId: genId('ent'),
          after: body
        });
        // NOTE 2026-09-19: these aliases write an audit row and nothing else —
        // no price snapshot, deal, assessment or alert is created or queued.
        // "202 accepted" implied work was pending that never was; the response
        // now says plainly that the payload was only recorded.
        return ok({
          accepted: audited,
          recorded_only: true,
          note: 'This legacy endpoint records the payload in the audit log. It does not create or queue any downstream record.',
          tripId: body.tripId
        }, audited ? 202 : 500);
      }
    }
    // GET /trips/current/reservations alias
    if (req.method === 'GET' && path === '/trips/current/reservations') {
      if (!actor) return errResp(401, 'UNAUTHORIZED', 'Authentication required');
      const tripId = url.searchParams.get('tripId');
      if (!tripId) return errResp(400, 'BAD_REQUEST', 'tripId query param required');
      await authorize(supabase, actor, tripId, 'trip.read');
      // NOTE 2026-09-19: this reads audit_log, not the `reservations` table, so
      // it returns audit entries about reservations rather than reservations.
      // Left as-is (legacy alias contract), but the error is no longer
      // discarded — a failed read used to present as "no reservations".
      const { data: reservations, error: resErr } = await supabase.from('audit_log').select('entity_id, after, created_at').eq('trip_id', tripId).eq('entity_type', 'reservation').order('created_at', {
        ascending: false
      }).limit(50);
      if (resErr) {
        console.error('[platform-trips] legacy reservations read failed:', resErr.code, resErr.message);
        return errResp(500, 'DB_ERROR', 'Failed to load reservation audit entries');
      }
      return ok({
        items: reservations || [],
        nextCursor: null,
        source: 'audit_log'
      });
    }
    return errResp(404, 'NOT_FOUND', 'Route not found');
  } catch (e) {
    if (e.status && e.code) {
      return errResp(e.status, e.code, e.message);
    }
    console.error('[platform-trips] unhandled error:', e);
    return errResp(500, 'INTERNAL_ERROR', 'Internal server error', {
      details: e.message
    });
  }
});

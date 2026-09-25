// IDENTITY BRIDGE 2026-09-18 —
// `findOrCreateUser` looked up `auth_identities` with
// `.eq('provider', provider).eq('provider_subject', subject)`. The `provider`
// column is `app_metadata.provider || 'email_link'`, so it varies by sign-in
// method. The same human signing in through Google or Apple rather than email
// would miss the existing identity row, fall past the lookup, and — if their
// platform_users row had no matching email — mint a SECOND platform user for
// one person, splitting their trips, memberships and encrypted data across two
// identities with no error anywhere.
//
// Fixed by matching on `provider_subject` ALONE, which is the verified token's
// `user.id` and is the only stable key. `provider` is still written on insert
// as provenance; it is never filtered on for a read. This is the convention
// `_shared/auth.ts` (`resolvePlatformUserId`) documents and depends on.
//
// DEFECT 2026-09-19 (42703 + 23514 + 23502 + 42P10 — THE RATE LIMITER HAS
// NEVER LIMITED ANYTHING).
//
// `checkRateLimit` was written against a table shape that does not exist. Four
// independent faults, any one of which was fatal:
//
//   1. It filtered and inserted `actor_id`. `rate_limit_buckets` has no such
//      column — it is `bucket_key`. PostgREST rejects the whole statement
//      (42703), so the SELECT returned an error and the UPSERT wrote nothing.
//   2. It passed bucket_type 'auth' / 'api'. The column is CHECK-constrained
//      to ('global','strict','user_quota'); neither value is permitted (23514).
//   3. `id` (TEXT, no default) and `window_end` (timestamptz, NOT NULL, no
//      default) were never supplied (23502).
//   4. `onConflict: 'actor_id,bucket_type,window_start'` names columns with no
//      unique constraint behind them — the table's only unique constraint is
//      its primary key on `id` (42P10).
//
// Every error was discarded (`const { data } = ...`), so the SELECT yielded
// null, `data && data.request_count >= limit` was false, and the function
// returned true. The sign-in endpoint's documented 20-requests-per-minute cap
// was never applied to anybody: an unauthenticated caller could hammer
// /sign-in, and each attempt ran a full token verification. Rewritten against
// the real columns, with a deterministic primary key so the upsert can conflict
// on something that actually exists.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-guest-token, idempotency-key'
};
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
  const hex = Array.from(bytes).map((b)=>b.toString(16).padStart(2, '0')).join('');
  return `${prefix}_${hex}`;
}
async function sha256Hex(input) {
  const enc = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf)).map((b)=>b.toString(16).padStart(2, '0')).join('');
}
// Verify Supabase JWT and return provider + subject + email
async function verifySupabaseToken(token) {
  const supabase = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_ANON_KEY'), {
    global: {
      headers: {
        Authorization: `Bearer ${token}`
      }
    }
  });
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return null;
  const provider = user.app_metadata?.provider || 'email_link';
  return {
    provider,
    subject: user.id,
    email: user.email
  };
}
// Find or create platform_users row via auth_identities.
//
// DEFECT 2026-09-19 — every query in here discarded its error and the function
// promised a user unconditionally:
//   - the platform_users lookup ended `return user!`, so a missing or
//     unreadable row returned null through a non-null assertion and the caller
//     then dereferenced `user.id`, throwing a bare TypeError with no context;
//   - both inserts ignored failure, so a failed platform_users insert was
//     followed by an auth_identities insert pointing at a user that does not
//     exist (or a foreign-key violation, also discarded), and the caller was
//     handed an id for an account that was never created.
// It now returns either a user or the Response to send.
async function findOrCreateUser(supabase, provider, subject, email) {
  // Check existing identity.
  // Match on provider_subject ALONE — never on `provider`. See header.
  // auth_identities is UNIQUE(provider, provider_subject), so one subject can
  // legitimately have more than one row (same person, two sign-in methods);
  // they all link to the same user_id, so limit(1) is safe here where
  // maybeSingle() alone would raise on the second row.
  const { data: identities, error: identityErr } = await supabase.from('auth_identities').select('user_id').eq('provider_subject', subject).limit(1);
  if (identityErr) {
    console.error('[platform-auth] auth_identities lookup failed:', identityErr.code, identityErr.message);
    return {
      failure: errResp(500, 'DB_ERROR', 'Failed to resolve your account identity')
    };
  }
  const identity = identities?.[0];
  if (identity) {
    const { data: user, error: userErr } = await supabase.from('platform_users').select('id, display_name').eq('id', identity.user_id).maybeSingle();
    if (userErr) {
      console.error('[platform-auth] platform_users lookup failed:', userErr.code, userErr.message);
      return {
        failure: errResp(500, 'DB_ERROR', 'Failed to load your account')
      };
    }
    if (!user) {
      // An identity row pointing at a platform user that is gone. Say so —
      // previously this returned null through `user!` and crashed downstream.
      console.error('[platform-auth] auth_identities row', identity.user_id, 'has no platform_users row');
      return {
        failure: errResp(500, 'ACCOUNT_INCONSISTENT', 'Your account identity does not resolve to a user record')
      };
    }
    return {
      user: user
    };
  }
  // Check if email already exists (link identities)
  if (email) {
    const { data: existingUser, error: existingErr } = await supabase.from('platform_users').select('id, display_name').eq('email', email).maybeSingle();
    if (existingErr) {
      console.error('[platform-auth] platform_users email lookup failed:', existingErr.code, existingErr.message);
      return {
        failure: errResp(500, 'DB_ERROR', 'Failed to look up your account')
      };
    }
    if (existingUser) {
      // Link new identity to existing user
      const { error: linkErr } = await supabase.from('auth_identities').insert({
        id: genId('aid'),
        user_id: existingUser.id,
        provider,
        provider_subject: subject
      });
      if (linkErr && linkErr.code !== '23505') {
        console.error('[platform-auth] auth_identities link insert failed:', linkErr.code, linkErr.message);
        return {
          failure: errResp(500, 'DB_ERROR', 'Failed to link this sign-in method to your account')
        };
      }
      return {
        user: existingUser
      };
    }
  }
  // Create new user
  const userId = genId('usr');
  const displayName = email ? email.split('@')[0] : 'Traveler';
  const { error: createErr } = await supabase.from('platform_users').insert({
    id: userId,
    email: email || null,
    display_name: displayName
  });
  if (createErr) {
    console.error('[platform-auth] platform_users insert failed:', createErr.code, createErr.message);
    return {
      failure: errResp(500, 'DB_ERROR', 'Failed to create your account')
    };
  }
  const { error: idErr } = await supabase.from('auth_identities').insert({
    id: genId('aid'),
    user_id: userId,
    provider,
    provider_subject: subject
  });
  if (idErr) {
    console.error('[platform-auth] auth_identities insert failed:', idErr.code, idErr.message);
    // Do not leave a platform user nobody can ever sign in as.
    await supabase.from('platform_users').delete().eq('id', userId);
    return {
      failure: errResp(500, 'DB_ERROR', 'Failed to register this sign-in method')
    };
  }
  return {
    user: {
      id: userId,
      display_name: displayName
    }
  };
}
// Rate limit check: 120/min for api, 20/min for auth.
//
// See the header note for what was wrong. Mapping to the real schema:
//   actor_id   -> bucket_key
//   'auth'     -> 'strict'   (rate_limit_buckets_bucket_type_check)
//   'api'      -> 'global'
// `id` is derived deterministically from (key, type, window) so the upsert can
// conflict on the primary key, which is the table's only unique constraint.
async function checkRateLimit(supabase, bucketKey, kind) {
  const limit = kind === 'auth' ? 20 : 120;
  const bucketType = kind === 'auth' ? 'strict' : 'global';
  const windowStartMs = Math.floor(Date.now() / 60000) * 60000;
  const windowStart = new Date(windowStartMs).toISOString();
  const windowEnd = new Date(windowStartMs + 60000).toISOString();
  const id = `rl_${await sha256Hex(`${bucketKey}|${bucketType}|${windowStart}`)}`;
  const { data, error } = await supabase.from('rate_limit_buckets').select('request_count').eq('id', id).maybeSingle();
  if (error) {
    // Deliberate choice: fail OPEN, loudly. A rate limiter is a protective
    // measure, not an authorization decision, and failing closed here would
    // lock every user out of signing in on a transient database error. The
    // caller is told the limit was not enforced rather than being allowed to
    // assume it was — which is exactly what the previous version did silently,
    // for every request, forever.
    console.error('[platform-auth] rate limit read failed (not enforcing):', error.code, error.message);
    return {
      allowed: true,
      enforced: false
    };
  }
  if (data && data.request_count >= limit) return {
    allowed: false,
    enforced: true
  };
  const { error: writeErr } = await supabase.from('rate_limit_buckets').upsert({
    id,
    bucket_key: bucketKey,
    bucket_type: bucketType,
    window_start: windowStart,
    window_end: windowEnd,
    request_count: (data?.request_count || 0) + 1,
    updated_at: new Date().toISOString()
  }, {
    onConflict: 'id'
  });
  if (writeErr) {
    console.error('[platform-auth] rate limit write failed (not enforcing):', writeErr.code, writeErr.message);
    return {
      allowed: true,
      enforced: false
    };
  }
  return {
    allowed: true,
    enforced: true
  };
}
serve(async (req)=>{
  if (req.method === 'OPTIONS') return new Response('ok', {
    headers: cors
  });
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/platform-auth/, '');
  const supabase = db();
  // POST /sign-in — exchange Supabase JWT for platform user
  if (req.method === 'POST' && path === '/sign-in') {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) return errResp(401, 'UNAUTHORIZED', 'Missing bearer token');
    const token = authHeader.slice(7);
    const rate = await checkRateLimit(supabase, token.slice(0, 16), 'auth');
    if (!rate.allowed) return new Response(JSON.stringify({
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many requests'
      }
    }), {
      status: 429,
      headers: {
        ...cors,
        'Content-Type': 'application/json',
        'Retry-After': '60'
      }
    });
    const identity = await verifySupabaseToken(token);
    if (!identity) return errResp(401, 'INVALID_TOKEN', 'Token verification failed');
    const result = await findOrCreateUser(supabase, identity.provider, identity.subject, identity.email);
    if ('failure' in result) return result.failure;
    const user = result.user;
    // Register device.
    //
    // DEFECT 2026-09-19 — this insert's error was discarded and the deviceId
    // was returned regardless, so a client could be handed a device id that
    // does not exist and which /devices would never list.
    //
    // NOTE 2026-09-19: a fresh device row is minted on EVERY sign-in rather
    // than being keyed to the client's device, so the user's device list grows
    // by one per login. That is a design question, not a defect this sweep can
    // settle without knowing the client contract; left as-is deliberately.
    const body = await req.json().catch(()=>({}));
    const deviceId = genId('dev');
    const { error: deviceErr } = await supabase.from('user_devices').insert({
      id: deviceId,
      user_id: user.id,
      label: body.deviceLabel || null,
      last_seen_at: new Date().toISOString()
    });
    if (deviceErr) {
      console.error('[platform-auth] user_devices insert failed:', deviceErr.code, deviceErr.message);
      return errResp(500, 'DB_ERROR', 'Signed in, but the device could not be registered');
    }
    return ok({
      user,
      deviceId,
      rate_limit_enforced: rate.enforced
    });
  }
  // GET /devices — list devices for authenticated user
  if (req.method === 'GET' && path === '/devices') {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) return errResp(401, 'UNAUTHORIZED', 'Missing bearer token');
    const identity = await verifySupabaseToken(authHeader.slice(7));
    if (!identity) return errResp(401, 'INVALID_TOKEN', 'Token verification failed');
    const result = await findOrCreateUser(supabase, identity.provider, identity.subject, identity.email);
    if ('failure' in result) return result.failure;
    const user = result.user;
    // DEFECT 2026-09-19 — the error was discarded and `devices: []` returned,
    // so a failed read told the user they had no registered devices — the
    // exact screen someone checks when they suspect their account is being
    // used from somewhere they do not recognise.
    const { data: devices, error: devicesErr } = await supabase.from('user_devices').select('id, label, last_seen_at, revoked_at').eq('user_id', user.id).order('last_seen_at', {
      ascending: false
    });
    if (devicesErr) {
      console.error('[platform-auth] user_devices read failed:', devicesErr.code, devicesErr.message);
      return errResp(500, 'DB_ERROR', 'Failed to load your devices');
    }
    return ok({
      devices: devices || []
    });
  }
  // DELETE /devices/:deviceId — revoke a device
  if (req.method === 'DELETE' && path.startsWith('/devices/')) {
    const deviceId = path.split('/')[2];
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) return errResp(401, 'UNAUTHORIZED', 'Missing bearer token');
    const identity = await verifySupabaseToken(authHeader.slice(7));
    if (!identity) return errResp(401, 'INVALID_TOKEN', 'Token verification failed');
    const result = await findOrCreateUser(supabase, identity.provider, identity.subject, identity.email);
    if ('failure' in result) return result.failure;
    const user = result.user;
    const { data: device, error: deviceErr } = await supabase.from('user_devices').select('user_id').eq('id', deviceId).maybeSingle();
    if (deviceErr) {
      console.error('[platform-auth] device lookup failed:', deviceErr.code, deviceErr.message);
      return errResp(500, 'DB_ERROR', 'Failed to load that device');
    }
    if (!device || device.user_id !== user.id) return errResp(404, 'NOT_FOUND', 'Device not found');
    // DEFECT 2026-09-19 — the error was discarded and `{ revoked: true }`
    // returned regardless. Telling somebody a device has been signed out when
    // it has not is the single worst way for this endpoint to fail.
    const { data: revoked, error: revokeErr } = await supabase.from('user_devices').update({
      revoked_at: new Date().toISOString()
    }).eq('id', deviceId).eq('user_id', user.id).select('id');
    if (revokeErr) {
      console.error('[platform-auth] device revoke failed:', revokeErr.code, revokeErr.message);
      return errResp(500, 'DB_ERROR', 'Failed to revoke that device');
    }
    if (!revoked || revoked.length === 0) {
      return errResp(404, 'NOT_FOUND', 'Device not found');
    }
    return ok({
      revoked: true
    });
  }
  // POST /guest/claim — convert guest member to account member
  if (req.method === 'POST' && path === '/guest/claim') {
    const authHeader = req.headers.get('Authorization');
    const guestToken = req.headers.get('X-Guest-Token');
    if (!authHeader?.startsWith('Bearer ') || !guestToken) {
      return errResp(400, 'BAD_REQUEST', 'Requires both bearer token and X-Guest-Token');
    }
    const identity = await verifySupabaseToken(authHeader.slice(7));
    if (!identity) return errResp(401, 'INVALID_TOKEN', 'Token verification failed');
    const result = await findOrCreateUser(supabase, identity.provider, identity.subject, identity.email);
    if ('failure' in result) return result.failure;
    const user = result.user;
    const tokenHash = await sha256Hex(guestToken);
    const { data: member, error: memberErr } = await supabase.from('trip_members').select('id, trip_id, guest_expires_at, removed_at').eq('guest_token_hash', tokenHash).eq('kind', 'guest').maybeSingle();
    if (memberErr) {
      console.error('[platform-auth] guest member lookup failed:', memberErr.code, memberErr.message);
      return errResp(500, 'DB_ERROR', 'Failed to look up that guest invitation');
    }
    if (!member) return errResp(404, 'NOT_FOUND', 'Guest token not found');
    if (member.removed_at) return errResp(410, 'REVOKED', 'Guest token has been revoked');
    if (member.guest_expires_at && new Date(member.guest_expires_at) < new Date()) {
      return errResp(410, 'EXPIRED', 'Guest token has expired');
    }
    // Convert to account member.
    //
    // DEFECT 2026-09-19 — the error was discarded and the success payload was
    // returned regardless, so a failed conversion told the person they had
    // claimed their place on the trip while the membership row was still a
    // guest one — and the guest token they had just "used up" was still live.
    // The kind filter makes this a compare-and-set against a concurrent claim.
    const { data: converted, error: convertErr } = await supabase.from('trip_members').update({
      kind: 'account',
      user_id: user.id,
      guest_token_hash: null,
      guest_expires_at: null
    }).eq('id', member.id).eq('kind', 'guest').select('id');
    if (convertErr) {
      console.error('[platform-auth] guest claim update failed:', convertErr.code, convertErr.message);
      return errResp(500, 'DB_ERROR', 'Failed to claim that guest invitation');
    }
    if (!converted || converted.length === 0) {
      return errResp(409, 'ALREADY_CLAIMED', 'That guest invitation has already been claimed');
    }
    return ok({
      memberId: member.id,
      tripId: member.trip_id,
      userId: user.id
    });
  }
  return errResp(404, 'NOT_FOUND', 'Route not found');
});

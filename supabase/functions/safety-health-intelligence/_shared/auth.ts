// TravelOS — shared edge function authentication.
//
// Created 2026-09-16 after an audit found 36 of 46 functions with an
// authentication or authorization defect. The root cause was that every
// function improvised its own gate, or skipped one: `verify_jwt: false` means
// Supabase does NOT authenticate the caller, and most functions then built a
// service_role client, which bypasses RLS. Neither layer was protecting the
// other.
//
// Use this instead of writing a new gate. Deploy it alongside a function as
// `_shared/auth.ts` and import with `./_shared/auth.ts`.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
export const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
export const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');
export const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'
};
export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json'
    }
  });
}
export function fail(message, status = 400) {
  return json({
    error: message
  }, status);
}
/** Service-role client. Bypasses RLS — only for operations that must cross a tenant boundary. */ export function serviceClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
}
/** Length-independent constant-time compare, for secret material. */ export function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for(let i = 0; i < len; i++)diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}
function bearer(req) {
  const header = req.headers.get('Authorization');
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token || null;
}
/**
 * Verifies the caller's JWT and returns their auth.uid().
 *
 * NEVER accept an identity from the request body. Seven functions in this
 * codebase did, which let any caller act as any user.
 *
 * Note the deliberate rejection of a bare presence check: seven other functions
 * used `if (!authHeader) return 401`, which `Authorization: x` passes because
 * the token is never decoded.
 */ export async function requireUser(req) {
  const token = bearer(req);
  if (!token) return fail('Missing or invalid Authorization header', 401);
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: {
      headers: {
        Authorization: `Bearer ${token}`
      }
    }
  });
  const { data, error } = await client.auth.getUser();
  if (error || !data?.user) return fail('Invalid token', 401);
  return {
    userId: data.user.id,
    client
  };
}
/** Requires the service-role key. For genuine service-to-service endpoints. */ export function requireService(req) {
  const token = bearer(req);
  if (!token || !timingSafeEqual(token, SERVICE_ROLE_KEY)) {
    return fail('Service key required', 401);
  }
  return true;
}
/** Accepts either caller type. For endpoints serving both clients and workers. */ export async function requireUserOrService(req) {
  const token = bearer(req);
  if (!token) return fail('Missing or invalid Authorization header', 401);
  if (timingSafeEqual(token, SERVICE_ROLE_KEY)) return {
    kind: 'service'
  };
  const result = await requireUser(req);
  if (result instanceof Response) return result;
  return {
    kind: 'user',
    userId: result.userId,
    client: result.client
  };
}
/**
 * Confirms the caller owns the trip. `trips.user_id` is a uuid and matches
 * auth.uid() directly. Returns 404 rather than 403 so a caller cannot probe
 * which trip ids exist.
 *
 * ERROR VS ABSENCE 2026-09-19 — this used to destructure `data` only:
 *
 *   const { data } = await service.from('trips')...maybeSingle();
 *   if (!data) return fail('Trip not found', 404);
 *
 * which turned every failed query — a dropped connection, a PostgREST 42703
 * from a column rename, an exhausted pool — into "Trip not found" against the
 * owner's own trip, and logged nothing. That is this project's recurring
 * defect: a failed call read as an absent answer. A failure is now a 500 that
 * says so and is logged; only a query that succeeded and returned no row is a
 * 404. The 404-not-403 choice for a genuine miss is unchanged, so trip ids
 * still cannot be enumerated.
 *
 * NOTE: `_shared/auth.ts` is deployed per function, so this fix currently
 * applies only to the functions redeployed since. Propagate it.
 */ export async function requireTripOwner(service, tripId, userId) {
  const { data, error } = await service.from('trips').select('id').eq('id', tripId).eq('user_id', userId).maybeSingle();
  if (error) {
    console.error('[auth] trip ownership check failed:', error.message);
    return fail('Trip ownership could not be verified', 500);
  }
  if (!data) return fail('Trip not found', 404);
  return true;
}
/**
 * Bridges Supabase auth to the platform identity space.
 *
 * TravelOS runs two id systems: Supabase uuids (auth.uid(), trips, profiles)
 * and prefixed text ids (platform_users, platform_trips, trip_members).
 * `auth_identities.provider_subject` holds auth.uid() as text.
 *
 * Match on provider_subject ALONE. The `provider` column is
 * `app_metadata.provider || 'email_link'`, so it varies by sign-in method and
 * filtering on a fixed value matches nothing — a check that looks secure and
 * silently denies everyone.
 */ export async function resolvePlatformUserId(service, authUserId) {
  const { data, error } = await service.from('auth_identities').select('user_id').eq('provider_subject', authUserId).maybeSingle();
  if (error) console.error('[auth] auth_identities lookup failed:', error.message);
  return data?.user_id ?? null;
}

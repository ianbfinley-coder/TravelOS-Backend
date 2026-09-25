// TravelOS shared edge function authentication.
// Never build a service client passing the caller's JWT as Authorization -
// PostgREST takes the role from that header, so it runs as `authenticated`,
// not `service_role`, and RLS applies. Use serviceClient() below instead.
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
/** Service-role client. Bypasses RLS - only for operations that must cross a tenant boundary. */ export function serviceClient() {
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
 * NEVER accept an identity from the request body.
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
 */ export async function requireTripOwner(service, tripId, userId) {
  const { data, error } = await service.from('trips').select('id').eq('id', tripId).eq('user_id', userId).maybeSingle();
  if (error) console.error('[auth] trips ownership lookup failed:', error.message);
  if (!data) return fail('Trip not found', 404);
  return true;
}
/**
 * Bridges Supabase auth to the platform identity space.
 * Match on provider_subject ALONE - the `provider` column varies by
 * sign-in method, so filtering on a fixed value matches nothing.
 */ export async function resolvePlatformUserId(service, authUserId) {
  const { data, error } = await service.from('auth_identities').select('user_id').eq('provider_subject', authUserId).maybeSingle();
  if (error) console.error('[auth] auth_identities lookup failed:', error.message);
  return data?.user_id ?? null;
}

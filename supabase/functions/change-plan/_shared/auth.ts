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

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
export const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
export const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

export function fail(message: string, status = 400): Response {
  return json({ error: message }, status);
}

/** Service-role client. Bypasses RLS — only for operations that must cross a tenant boundary. */
export function serviceClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
}

/** Length-independent constant-time compare, for secret material. */
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

function bearer(req: Request): string | null {
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
 */
export async function requireUser(
  req: Request,
): Promise<{ userId: string; client: SupabaseClient } | Response> {
  const token = bearer(req);
  if (!token) return fail('Missing or invalid Authorization header', 401);

  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const { data, error } = await client.auth.getUser();
  if (error || !data?.user) return fail('Invalid token', 401);

  return { userId: data.user.id, client };
}

/** Requires the service-role key. For genuine service-to-service endpoints. */
export function requireService(req: Request): true | Response {
  const token = bearer(req);
  if (!token || !timingSafeEqual(token, SERVICE_ROLE_KEY)) {
    return fail('Service key required', 401);
  }
  return true;
}

/** Accepts either caller type. For endpoints serving both clients and workers. */
export async function requireUserOrService(
  req: Request,
): Promise<{ kind: 'service' } | { kind: 'user'; userId: string; client: SupabaseClient } | Response> {
  const token = bearer(req);
  if (!token) return fail('Missing or invalid Authorization header', 401);
  if (timingSafeEqual(token, SERVICE_ROLE_KEY)) return { kind: 'service' };

  const result = await requireUser(req);
  if (result instanceof Response) return result;
  return { kind: 'user', userId: result.userId, client: result.client };
}

/**
 * Confirms the caller owns the trip. `trips.user_id` is a uuid and matches
 * auth.uid() directly. Returns 404 rather than 403 so a caller cannot probe
 * which trip ids exist.
 */
export async function requireTripOwner(
  service: SupabaseClient,
  tripId: string,
  userId: string,
): Promise<true | Response> {
  const { data } = await service
    .from('trips')
    .select('id')
    .eq('id', tripId)
    .eq('user_id', userId)
    .maybeSingle();
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
 */
export async function resolvePlatformUserId(
  service: SupabaseClient,
  authUserId: string,
): Promise<string | null> {
  const { data } = await service
    .from('auth_identities')
    .select('user_id')
    .eq('provider_subject', authUserId)
    .maybeSingle();
  return (data?.user_id as string | undefined) ?? null;
}

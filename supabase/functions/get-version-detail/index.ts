// ---------------------------------------------------------------------------
// 2026-09-19 — handlePublicShare could never name the person who shared a trip.
//
// It read `.from('profiles').select('full_name, first_name')`. `profiles` has
// NEITHER column — verified against information_schema.columns on 2026-09-19,
// its columns are id, email, name, avatar_url, created_at, updated_at, phone,
// phone_verified, email_verified, expo_push_token. The display column is
// `name`. PostgREST rejects the whole query with 42703, the error was
// discarded, `profile` was always null, and `sharerName` therefore silently
// stayed the placeholder 'A traveler' on every shared trip page ever served.
//
// Fixing the column alone would NOT have been enough, and this is the part
// worth remembering: the id spaces do not line up either.
// `trip_members.user_id` is a platform TEXT id (`usr_<hex>`, FK to
// platform_users.id) while `profiles.id` is a uuid. `.eq('id', 'usr_...')`
// against a uuid column is an invalid-input-syntax error (22P02) — not an
// empty result — so the query would have kept failing, just with a different
// error code. The platform id is now bridged to the auth uuid through
// `auth_identities` (the reverse of resolvePlatformUserId below) before
// `profiles` is touched at all.
//
// Two truthful sources are tried, in order, and nothing is invented: the
// bridged `profiles.name`, then `platform_users.display_name` reached by the
// direct FK from trip_members.user_id. If neither is on file the placeholder
// 'A traveler' stands — as a placeholder, not as a claim about anybody — and
// every failed lookup along the way is logged instead of being swallowed.
//
// Also in this pass, to the standing rules, and confined to the routes touched:
//   * handlePublicShare discarded the `error` on its trip_members, trips and
//     itinerary_items reads. The itinerary_items one mattered most: a failed
//     read produced `items: []`, so a public share page told a viewer the trip
//     had no plans in it.
//   * handleGetVersionDetail did `if (error || !version) return 404`, telling a
//     caller their version did not exist when the read had merely failed. Only
//     an absent row is a 404 now.
//
// The share-link CRUD handlers are otherwise unchanged, as are the router's
// path matchers and the privacy handlers.
// ---------------------------------------------------------------------------
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function ulid(prefix) {
  const ts = Date.now().toString(36).toUpperCase().padStart(10, '0');
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(10))).map((b)=>'ABCDEFGHJKMNPQRSTVWXYZ0123456789'[b % 32]).join('');
  return `${prefix}${ts}${rand}`;
}
async function sha256Hex(input) {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(input));
  return Array.from(new Uint8Array(buf)).map((b)=>b.toString(16).padStart(2, '0')).join('');
}
function generateToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}
function err(code, message, status = 400) {
  return json({
    error: {
      code,
      message
    }
  }, status);
}
// ---------------------------------------------------------------------------
// Rate limiter (in-memory, per IP, 60 req/min)
// ---------------------------------------------------------------------------
const rateLimitMap = new Map();
function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, {
      count: 1,
      resetAt: now + 60_000
    });
    return true;
  }
  if (entry.count >= 60) return false;
  entry.count++;
  return true;
}
setInterval(()=>{
  const now = Date.now();
  for (const [k, v] of rateLimitMap){
    if (now > v.resetAt) rateLimitMap.delete(k);
  }
}, 120_000);
// ---------------------------------------------------------------------------
// Visibility defaults
// ---------------------------------------------------------------------------
const DEFAULT_VISIBILITY = {
  showTimes: true,
  showPlaces: 'exact',
  showLodgingAddress: false,
  showTravelerNames: 'first',
  showCosts: false,
  showNotes: false,
  showConfirmationNumbers: false,
  showDocuments: false,
  includePlansNotConfirmed: true
};
// ---------------------------------------------------------------------------
// Data inventory & processors (hardcoded)
// ---------------------------------------------------------------------------
const DATA_INVENTORY = [
  {
    category: 'Account data',
    examples: [
      'Email address',
      'Name',
      'Profile photo'
    ],
    purpose: 'To identify you and let you sign in',
    sharedWith: [
      'Trip members you invite'
    ],
    retention: 'Until you delete your account',
    sensitive: false
  },
  {
    category: 'Trip plans and bookings',
    examples: [
      'Flight numbers',
      'Hotel names',
      'Confirmation numbers',
      'Itinerary items'
    ],
    purpose: 'To show and organize your trip',
    sharedWith: [
      'Trip members you invite',
      'Anyone you share a link with (filtered by your settings)'
    ],
    retention: 'Until you delete the trip',
    sensitive: false
  },
  {
    category: 'Documents',
    examples: [
      'Passport scans',
      'Boarding passes',
      'Insurance policies'
    ],
    purpose: 'To store and retrieve your travel documents',
    sharedWith: [
      'Only you'
    ],
    retention: 'Until you delete them',
    sensitive: true
  },
  {
    category: 'Expenses and budgets',
    examples: [
      'Expense amounts',
      'Budget preferences',
      'Spending categories'
    ],
    purpose: 'To track and split travel costs',
    sharedWith: [
      'Trip members for shared expenses',
      'Budget preferences: only you'
    ],
    retention: 'Until you delete the trip',
    sensitive: true
  },
  {
    category: 'Location data',
    examples: [
      'GPS coordinates during active location shares',
      'Check-in locations'
    ],
    purpose: 'To share your location with people you choose',
    sharedWith: [
      'Only people you explicitly share with'
    ],
    retention: 'Deleted 24 hours after the share ends',
    sensitive: true
  },
  {
    category: 'Preferences and profile learning',
    examples: [
      'Activity ratings',
      'Kept and removed items',
      'Style preferences'
    ],
    purpose: 'To personalize recommendations and predictions',
    sharedWith: [
      'Group features use aggregated scores only, never your individual profile'
    ],
    retention: 'Until you delete your profile or pause learning',
    sensitive: false
  },
  {
    category: 'Health and accessibility info',
    examples: [
      'Dietary needs',
      'Accessibility requirements',
      'Medical info (if added)'
    ],
    purpose: 'To personalize planning and emergency information',
    sharedWith: [
      'Only you, unless you choose to share with trip members'
    ],
    retention: 'Until you delete it',
    sensitive: true
  },
  {
    category: 'AI Copilot conversations',
    examples: [
      'Messages you send to the copilot',
      'Trip context sent to the AI'
    ],
    purpose: 'To generate trip suggestions and answer questions',
    sharedWith: [
      'Processed by our AI provider to generate responses; not used for training'
    ],
    retention: '90 days, then deleted',
    sensitive: false
  },
  {
    category: 'Device and diagnostics',
    examples: [
      'Device type',
      'App version',
      'Crash reports'
    ],
    purpose: 'To fix bugs and improve the app',
    sharedWith: [
      'Our analytics and crash-reporting providers (see processors list)'
    ],
    retention: '30 days',
    sensitive: false
  }
];
const PROCESSORS = [
  {
    name: 'Supabase',
    purpose: 'Database and authentication hosting',
    privacyUrl: 'https://supabase.com/privacy'
  },
  {
    name: 'Anthropic',
    purpose: 'AI Copilot responses',
    privacyUrl: 'https://www.anthropic.com/privacy'
  },
  {
    name: 'Google Places',
    purpose: 'Place search and details',
    privacyUrl: 'https://policies.google.com/privacy'
  },
  {
    name: 'FlightAware',
    purpose: 'Flight status data',
    privacyUrl: 'https://www.flightaware.com/about/privacy'
  },
  {
    name: 'Open-Meteo',
    purpose: 'Weather forecasts',
    privacyUrl: 'https://open-meteo.com/en/terms'
  },
  {
    name: 'Mapbox',
    purpose: 'Maps and geocoding',
    privacyUrl: 'https://www.mapbox.com/legal/privacy'
  },
  {
    name: 'Expo / EAS',
    purpose: 'App delivery and push notifications',
    privacyUrl: 'https://expo.dev/privacy'
  }
];
// ---------------------------------------------------------------------------
// Supabase client factory
// ---------------------------------------------------------------------------
function makeServiceClient() {
  return createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: {
      persistSession: false
    }
  });
}
async function getAuthUser(req) {
  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const client = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_ANON_KEY'), {
    auth: {
      persistSession: false
    }
  });
  const { data: { user }, error } = await client.auth.getUser(token);
  if (error || !user) return null;
  return user;
}
// SECURITY 2026-09-18: TravelOS runs two id spaces for users — auth.uid()
// (a uuid, what a JWT carries) and platform_users.id (TEXT, "usr_<hex>"),
// which is what trip_members.user_id actually holds. Every share-links
// handler below used to filter trip_members.user_id directly on
// getAuthUser()'s raw auth uuid, which can never match a "usr_..." value —
// so the membership check silently returned zero rows and every real trip
// member got a 403 "not a member" on their own trip. auth_identities.
// provider_subject holds the auth uuid as text and bridges to
// auth_identities.user_id (the platform "usr_" id); this mirrors
// _shared/auth.ts's resolvePlatformUserId(), inlined here since this
// function does not bundle _shared/auth.ts. Match on provider_subject
// ALONE — the provider column varies by sign-in method.
async function resolvePlatformUserId(service, authUserId) {
  const { data } = await service.from('auth_identities').select('user_id').eq('provider_subject', authUserId).maybeSingle();
  return data?.user_id ?? null;
}
/**
 * 2026-09-19 — the reverse bridge: platform `usr_<hex>` id → auth uuid.
 *
 * Needed because `profiles` is keyed on the auth uuid while
 * `trip_members.user_id` holds the platform id. Without this, reading a
 * member's profile is not a 42703 but a 22P02 (invalid uuid input), which is
 * just as fatal to the query. Same matching rule as above: the bridge row is
 * found by `user_id` alone, never by `provider`.
 */ async function resolveAuthUserId(service, platformUserId) {
  const { data, error } = await service.from('auth_identities').select('provider_subject').eq('user_id', platformUserId).maybeSingle();
  if (error) {
    console.error('[get-version-detail] auth_identities reverse bridge lookup failed:', error.message);
    return null;
  }
  return data?.provider_subject ?? null;
}
/** First word of a display name, or null if there is nothing usable. */ function firstName(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.split(/\s+/)[0];
}
// ---------------------------------------------------------------------------
// Visibility filtering
// ---------------------------------------------------------------------------
function applyVisibilityToItem(item, vis) {
  const out = {
    ...item
  };
  // Always remove
  delete out.confirmation_number;
  delete out.document_url;
  delete out.documents;
  if (!vis.showTimes) {
    delete out.start_time;
    delete out.end_time;
    delete out.time;
  }
  if (!vis.showCosts) {
    delete out.cost;
    delete out.price;
    delete out.amount;
    delete out.total_cost;
  }
  if (!vis.showNotes) {
    delete out.notes;
    delete out.description;
  }
  if (vis.showPlaces === 'city_only') {
    if (out.address) out.address = out.city ?? 'City';
    if (out.location) out.location = out.city ?? 'City';
  }
  if (!vis.showLodgingAddress && (out.type === 'lodging' || out.category === 'lodging')) {
    delete out.address;
    delete out.location;
  }
  if (vis.showTravelerNames === 'none') {
    if (Array.isArray(out.travelers)) {
      out.travelers = out.travelers.map(()=>'Traveler');
    }
    if (out.traveler_name) out.traveler_name = 'Traveler';
  } else if (vis.showTravelerNames === 'first') {
    if (Array.isArray(out.travelers)) {
      out.travelers = out.travelers.map((n)=>n.split(' ')[0]);
    }
    if (out.traveler_name) {
      out.traveler_name = out.traveler_name.split(' ')[0];
    }
  }
  return out;
}
// ---------------------------------------------------------------------------
// Share link handlers
// ---------------------------------------------------------------------------
async function handleCreateShareLink(req) {
  const user = await getAuthUser(req);
  if (!user) return err('UNAUTHORIZED', 'Authentication required', 401);
  const body = await req.json().catch(()=>null);
  if (!body) return err('BAD_REQUEST', 'Invalid JSON body');
  const { tripId, scope, scopeRef, visibility, expiresAt } = body;
  if (!tripId || !scope) return err('BAD_REQUEST', 'tripId and scope are required');
  if (![
    'trip',
    'day',
    'item',
    'eta'
  ].includes(scope)) return err('BAD_REQUEST', 'Invalid scope');
  const db = makeServiceClient();
  const platformUserId = await resolvePlatformUserId(db, user.id);
  if (!platformUserId) return err('FORBIDDEN', 'You are not a member of this trip', 403);
  const { data: member } = await db.from('trip_members').select('id, role').eq('trip_id', tripId).eq('user_id', platformUserId).maybeSingle();
  if (!member) return err('FORBIDDEN', 'You are not a member of this trip', 403);
  if (scope === 'trip' && member.role !== 'organizer') {
    return err('FORBIDDEN', 'Only organizers can create trip-wide share links', 403);
  }
  const { data: trip } = await db.from('trips').select('end_date, title').eq('id', tripId).maybeSingle();
  if (!trip) return err('NOT_FOUND', 'Trip not found', 404);
  let computedExpiry = null;
  if (expiresAt) {
    computedExpiry = expiresAt;
  } else if (trip.end_date) {
    const d = new Date(trip.end_date);
    d.setDate(d.getDate() + 7);
    computedExpiry = d.toISOString();
  }
  const mergedVisibility = {
    ...DEFAULT_VISIBILITY,
    ...visibility ?? {},
    showConfirmationNumbers: false,
    showDocuments: false
  };
  const token = generateToken();
  const tokenHash = await sha256Hex(token);
  const id = ulid('slk_');
  const { error: insertErr } = await db.from('share_links').insert({
    id,
    trip_id: tripId,
    created_by_member_id: member.id,
    scope,
    scope_ref: scopeRef ?? null,
    token_hash: tokenHash,
    visibility: mergedVisibility,
    expires_at: computedExpiry
  });
  if (insertErr) {
    console.error('share_links insert error:', insertErr.message);
    return err('INTERNAL', 'Failed to create share link', 500);
  }
  return json({
    id,
    url: `https://travelos.app/s/${token}`,
    token
  }, 201);
}
async function handleListShareLinks(req) {
  const user = await getAuthUser(req);
  if (!user) return err('UNAUTHORIZED', 'Authentication required', 401);
  const url = new URL(req.url);
  const tripId = url.searchParams.get('tripId');
  if (!tripId) return err('BAD_REQUEST', 'tripId query param required');
  const db = makeServiceClient();
  const platformUserId = await resolvePlatformUserId(db, user.id);
  if (!platformUserId) return err('FORBIDDEN', 'You are not a member of this trip', 403);
  const { data: member } = await db.from('trip_members').select('id, role').eq('trip_id', tripId).eq('user_id', platformUserId).maybeSingle();
  if (!member) return err('FORBIDDEN', 'You are not a member of this trip', 403);
  let query = db.from('share_links').select('id, trip_id, scope, scope_ref, visibility, expires_at, revoked_at, view_count, last_viewed_at, created_at, created_by_member_id').eq('trip_id', tripId).order('created_at', {
    ascending: false
  });
  if (member.role !== 'organizer') {
    query = query.eq('created_by_member_id', member.id);
  }
  const { data, error: fetchErr } = await query;
  if (fetchErr) return err('INTERNAL', 'Failed to fetch share links', 500);
  return json({
    links: data ?? []
  });
}
async function handleUpdateShareLink(req, linkId) {
  const user = await getAuthUser(req);
  if (!user) return err('UNAUTHORIZED', 'Authentication required', 401);
  const body = await req.json().catch(()=>null);
  if (!body) return err('BAD_REQUEST', 'Invalid JSON body');
  const db = makeServiceClient();
  const { data: link } = await db.from('share_links').select('id, trip_id, created_by_member_id, visibility').eq('id', linkId).maybeSingle();
  if (!link) return err('NOT_FOUND', 'Share link not found', 404);
  const platformUserId = await resolvePlatformUserId(db, user.id);
  if (!platformUserId) return err('FORBIDDEN', 'Not a trip member', 403);
  const { data: member } = await db.from('trip_members').select('id, role').eq('trip_id', link.trip_id).eq('user_id', platformUserId).maybeSingle();
  if (!member) return err('FORBIDDEN', 'Not a trip member', 403);
  if (member.id !== link.created_by_member_id && member.role !== 'organizer') {
    return err('FORBIDDEN', 'Only the creator or organizer can update this link', 403);
  }
  const updates = {};
  if (body.visibility !== undefined) {
    updates.visibility = {
      ...link.visibility,
      ...body.visibility,
      showConfirmationNumbers: false,
      showDocuments: false
    };
  }
  if (body.expiresAt !== undefined) updates.expires_at = body.expiresAt;
  const { error: updateErr } = await db.from('share_links').update(updates).eq('id', linkId);
  if (updateErr) return err('INTERNAL', 'Failed to update share link', 500);
  return json({
    success: true
  });
}
async function handleRevokeShareLink(req, linkId) {
  const user = await getAuthUser(req);
  if (!user) return err('UNAUTHORIZED', 'Authentication required', 401);
  const db = makeServiceClient();
  const { data: link } = await db.from('share_links').select('id, trip_id, created_by_member_id').eq('id', linkId).maybeSingle();
  if (!link) return err('NOT_FOUND', 'Share link not found', 404);
  const platformUserId = await resolvePlatformUserId(db, user.id);
  if (!platformUserId) return err('FORBIDDEN', 'Not a trip member', 403);
  const { data: member } = await db.from('trip_members').select('id, role').eq('trip_id', link.trip_id).eq('user_id', platformUserId).maybeSingle();
  if (!member) return err('FORBIDDEN', 'Not a trip member', 403);
  if (member.id !== link.created_by_member_id && member.role !== 'organizer') {
    return err('FORBIDDEN', 'Only the creator or organizer can revoke this link', 403);
  }
  const { error: updateErr } = await db.from('share_links').update({
    revoked_at: new Date().toISOString()
  }).eq('id', linkId);
  if (updateErr) return err('INTERNAL', 'Failed to revoke share link', 500);
  return json({
    success: true
  });
}
async function handleResetShareLink(req, linkId) {
  const user = await getAuthUser(req);
  if (!user) return err('UNAUTHORIZED', 'Authentication required', 401);
  const db = makeServiceClient();
  const { data: link } = await db.from('share_links').select('id, trip_id, created_by_member_id').eq('id', linkId).maybeSingle();
  if (!link) return err('NOT_FOUND', 'Share link not found', 404);
  const platformUserId = await resolvePlatformUserId(db, user.id);
  if (!platformUserId) return err('FORBIDDEN', 'Not a trip member', 403);
  const { data: member } = await db.from('trip_members').select('id, role').eq('trip_id', link.trip_id).eq('user_id', platformUserId).maybeSingle();
  if (!member) return err('FORBIDDEN', 'Not a trip member', 403);
  if (member.id !== link.created_by_member_id && member.role !== 'organizer') {
    return err('FORBIDDEN', 'Only the creator or organizer can reset this link', 403);
  }
  const token = generateToken();
  const tokenHash = await sha256Hex(token);
  const { error: updateErr } = await db.from('share_links').update({
    token_hash: tokenHash,
    revoked_at: null
  }).eq('id', linkId);
  if (updateErr) return err('INTERNAL', 'Failed to reset share link', 500);
  return json({
    url: `https://travelos.app/s/${token}`,
    token
  });
}
async function handlePublicShare(req, token) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? req.headers.get('x-real-ip') ?? 'unknown';
  if (!checkRateLimit(ip)) {
    return err('RATE_LIMITED', 'Too many requests. Please try again later.', 429);
  }
  const tokenHash = await sha256Hex(token);
  const db = makeServiceClient();
  const { data: link, error: linkErr } = await db.from('share_links').select('id, trip_id, scope, scope_ref, visibility, expires_at, revoked_at, created_by_member_id, view_count').eq('token_hash', tokenHash).maybeSingle();
  if (linkErr) {
    console.error('[get-version-detail] public share: share_links lookup failed:', linkErr.message);
    return err('INTERNAL', 'Could not load this share link', 500);
  }
  if (!link) return err('NOT_FOUND', 'Share link not found', 404);
  if (link.revoked_at) return err('GONE', 'This share link has been revoked', 410);
  if (link.expires_at && new Date(link.expires_at) < new Date()) {
    return err('GONE', 'This share link has expired', 410);
  }
  // Increment view count
  await db.from('share_links').update({
    view_count: (link.view_count ?? 0) + 1,
    last_viewed_at: new Date().toISOString()
  }).eq('id', link.id);
  const { data: trip, error: tripErr } = await db.from('trips').select('id, title, start_date, end_date, destination').eq('id', link.trip_id).maybeSingle();
  if (tripErr) {
    console.error('[get-version-detail] public share: trips lookup failed:', tripErr.message);
    return err('INTERNAL', 'Could not load this trip', 500);
  }
  if (!trip) return err('NOT_FOUND', 'Trip not found', 404);
  // Fetch sharer name. See the dated block at the top of this file: this used
  // to read profiles.full_name / profiles.first_name, neither of which exists,
  // and to hand a platform `usr_` id to a uuid column. 'A traveler' below is a
  // placeholder for a name we do not have — it is never presented as one.
  let sharerName = 'A traveler';
  const { data: sharerMember, error: sharerMemberErr } = await db.from('trip_members').select('user_id').eq('id', link.created_by_member_id).maybeSingle();
  if (sharerMemberErr) {
    console.error('[get-version-detail] public share: trip_members lookup failed:', sharerMemberErr.message);
  }
  if (sharerMember?.user_id) {
    const platformUserId = sharerMember.user_id;
    // 1. profiles.name, reached through the auth_identities bridge.
    const authUserId = await resolveAuthUserId(db, platformUserId);
    if (authUserId) {
      const { data: profile, error: profileErr } = await db.from('profiles').select('id, name').eq('id', authUserId).maybeSingle();
      if (profileErr) {
        console.error('[get-version-detail] public share: profiles lookup failed:', profileErr.message);
      } else {
        sharerName = firstName(profile?.name) ?? sharerName;
      }
    } else {
      console.warn(`[get-version-detail] public share: no auth_identities bridge row for platform user ` + `${platformUserId} — falling back to platform_users.display_name`);
    }
    // 2. platform_users.display_name, reached by the direct FK from
    //    trip_members.user_id. Tried only if the profile gave nothing.
    if (sharerName === 'A traveler') {
      const { data: platformUser, error: platformUserErr } = await db.from('platform_users').select('id, display_name').eq('id', platformUserId).maybeSingle();
      if (platformUserErr) {
        console.error('[get-version-detail] public share: platform_users lookup failed:', platformUserErr.message);
      } else {
        sharerName = firstName(platformUser?.display_name) ?? sharerName;
      }
    }
  }
  const vis = link.visibility;
  let itemsQuery = db.from('itinerary_items').select('*').eq('trip_id', link.trip_id);
  if (!vis.includePlansNotConfirmed) {
    itemsQuery = itemsQuery.eq('status', 'confirmed');
  }
  if (link.scope === 'day' && link.scope_ref) {
    itemsQuery = itemsQuery.eq('date', link.scope_ref);
  } else if (link.scope === 'item' && link.scope_ref) {
    itemsQuery = itemsQuery.eq('id', link.scope_ref);
  }
  const { data: rawItems, error: itemsErr } = await itemsQuery;
  // 2026-09-19: this error was discarded, so a failed read rendered the shared
  // page with `items: []` — telling whoever opened the link that the trip had
  // nothing planned in it.
  if (itemsErr) {
    console.error('[get-version-detail] public share: itinerary_items lookup failed:', itemsErr.message);
    return err('INTERNAL', 'Could not load this itinerary', 500);
  }
  const items = (rawItems ?? []).map((item)=>applyVisibilityToItem(item, vis));
  return json({
    trip: {
      title: trip.title,
      dates: {
        start: trip.start_date,
        end: trip.end_date
      },
      destination: trip.destination,
      items
    },
    visibility: vis,
    expiresAt: link.expires_at,
    sharerName
  });
}
// ---------------------------------------------------------------------------
// Privacy handlers
// ---------------------------------------------------------------------------
async function handleGetPrivacyInventory(req) {
  const user = await getAuthUser(req);
  if (!user) return err('UNAUTHORIZED', 'Authentication required', 401);
  return json({
    inventory: DATA_INVENTORY
  });
}
async function handleGetProcessors(req) {
  const user = await getAuthUser(req);
  if (!user) return err('UNAUTHORIZED', 'Authentication required', 401);
  return json({
    processors: PROCESSORS
  });
}
async function handleGetPrivacyControls(req) {
  const user = await getAuthUser(req);
  if (!user) return err('UNAUTHORIZED', 'Authentication required', 401);
  const db = makeServiceClient();
  let { data: controls } = await db.from('privacy_controls').select('*').eq('user_id', user.id).maybeSingle();
  if (!controls) {
    const defaults = {
      user_id: user.id,
      profile_learning_paused: false,
      use_profile_in_groups: true,
      copilot_memory_enabled: true,
      serendipity_enabled: true,
      personalized_ranking: true,
      marketing_emails: false,
      diagnostics_sharing: false
    };
    const { data: created } = await db.from('privacy_controls').insert(defaults).select().single();
    controls = created;
  }
  return json({
    controls
  });
}
async function handleUpdatePrivacyControls(req) {
  const user = await getAuthUser(req);
  if (!user) return err('UNAUTHORIZED', 'Authentication required', 401);
  const body = await req.json().catch(()=>null);
  if (!body) return err('BAD_REQUEST', 'Invalid JSON body');
  const allowed = [
    'profile_learning_paused',
    'use_profile_in_groups',
    'copilot_memory_enabled',
    'serendipity_enabled',
    'personalized_ranking',
    'marketing_emails',
    'diagnostics_sharing'
  ];
  const updates = {
    updated_at: new Date().toISOString()
  };
  for (const key of allowed){
    if (key in body) updates[key] = body[key];
  }
  const db = makeServiceClient();
  const { error: upsertErr } = await db.from('privacy_controls').upsert({
    user_id: user.id,
    ...updates
  }, {
    onConflict: 'user_id'
  });
  if (upsertErr) return err('INTERNAL', 'Failed to update privacy controls', 500);
  return json({
    success: true
  });
}
async function handleRequestExport(req) {
  const user = await getAuthUser(req);
  if (!user) return err('UNAUTHORIZED', 'Authentication required', 401);
  const db = makeServiceClient();
  const id = ulid('exp_');
  const { error: insertErr } = await db.from('data_export_requests').insert({
    id,
    user_id: user.id,
    status: 'pending'
  });
  if (insertErr) return err('INTERNAL', 'Failed to create export request', 500);
  return json({
    requestId: id,
    message: "We'll email you a download link within 24 hours."
  }, 201);
}
async function handleRequestDeletion(req) {
  const user = await getAuthUser(req);
  if (!user) return err('UNAUTHORIZED', 'Authentication required', 401);
  const db = makeServiceClient();
  const { data: existing } = await db.from('account_deletion_requests').select('id, status').eq('user_id', user.id).eq('status', 'pending').maybeSingle();
  if (existing) return err('CONFLICT', 'A deletion request is already pending', 409);
  const id = ulid('del_');
  const graceEndsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const { error: insertErr } = await db.from('account_deletion_requests').insert({
    id,
    user_id: user.id,
    grace_ends_at: graceEndsAt,
    status: 'pending'
  });
  if (insertErr) return err('INTERNAL', 'Failed to create deletion request', 500);
  return json({
    requestId: id,
    graceEndsAt,
    message: 'Your account will be deleted in 7 days. You can cancel anytime.'
  }, 201);
}
async function handleCancelDeletion(req) {
  const user = await getAuthUser(req);
  if (!user) return err('UNAUTHORIZED', 'Authentication required', 401);
  const db = makeServiceClient();
  const { data: request } = await db.from('account_deletion_requests').select('id').eq('user_id', user.id).eq('status', 'pending').maybeSingle();
  if (!request) return err('NOT_FOUND', 'No pending deletion request found', 404);
  const { error: updateErr } = await db.from('account_deletion_requests').update({
    status: 'cancelled',
    cancelled_at: new Date().toISOString()
  }).eq('id', request.id);
  if (updateErr) return err('INTERNAL', 'Failed to cancel deletion request', 500);
  return json({
    success: true,
    message: 'Account deletion cancelled.'
  });
}
// ---------------------------------------------------------------------------
// Legacy: get-version-detail (original behavior preserved)
// ---------------------------------------------------------------------------
async function handleGetVersionDetail(req) {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
  };
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return new Response(JSON.stringify({
      error: 'Missing authorization header'
    }), {
      status: 401,
      headers: {
        ...CORS,
        'Content-Type': 'application/json'
      }
    });
  }
  const db = makeServiceClient();
  const userClient = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_ANON_KEY'), {
    global: {
      headers: {
        Authorization: authHeader
      }
    }
  });
  const { data: { user }, error: authError } = await userClient.auth.getUser();
  if (authError || !user) {
    return new Response(JSON.stringify({
      error: 'Unauthorized'
    }), {
      status: 401,
      headers: {
        ...CORS,
        'Content-Type': 'application/json'
      }
    });
  }
  const { version_id } = await req.json();
  if (!version_id) {
    return new Response(JSON.stringify({
      error: 'version_id is required'
    }), {
      status: 400,
      headers: {
        ...CORS,
        'Content-Type': 'application/json'
      }
    });
  }
  // itinerary_versions.user_id is a uuid and matches auth.uid() directly
  // (verified 2026-09-19), so this filter is correct as written.
  const { data: version, error } = await db.from('itinerary_versions').select('*').eq('id', version_id).eq('user_id', user.id).maybeSingle();
  // 2026-09-19: was `.single()` behind `if (error || !version)`, so a failed
  // read was reported to the caller as 'Version not found' — their version
  // looked deleted when the query had merely failed. Only an absent row (or a
  // row belonging to someone else, which is deliberately indistinguishable) is
  // a 404.
  if (error) {
    console.error('[get-version-detail] itinerary_versions read failed:', error.message);
    return new Response(JSON.stringify({
      error: 'Failed to load version'
    }), {
      status: 500,
      headers: {
        ...CORS,
        'Content-Type': 'application/json'
      }
    });
  }
  if (!version) {
    return new Response(JSON.stringify({
      error: 'Version not found'
    }), {
      status: 404,
      headers: {
        ...CORS,
        'Content-Type': 'application/json'
      }
    });
  }
  return new Response(JSON.stringify({
    version
  }), {
    headers: {
      ...CORS,
      'Content-Type': 'application/json'
    }
  });
}
// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
Deno.serve(async (req)=>{
  const url = new URL(req.url);
  const method = req.method.toUpperCase();
  if (method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, PUT, OPTIONS',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
      }
    });
  }
  // Strip function prefix: /get-version-detail/...
  const rawPath = url.pathname.replace(/^\/get-version-detail/, '').replace(/^\/functions\/v1\/get-version-detail/, '') || '/';
  const path = rawPath || '/';
  try {
    // ── Share links routes ────────────────────────────────────────────
    if (path.startsWith('/share-links')) {
      const sub = path.replace(/^\/share-links/, '') || '/';
      // Public share (no JWT)
      const publicMatch = sub.match(/^\/public\/shares\/([A-Za-z0-9_-]+)$/);
      if (publicMatch && method === 'GET') {
        return await handlePublicShare(req, publicMatch[1]);
      }
      if (sub === '/' || sub === '') {
        if (method === 'POST') return await handleCreateShareLink(req);
        if (method === 'GET') return await handleListShareLinks(req);
      }
      const resetMatch = sub.match(/^\/([^/]+)\/reset$/);
      if (resetMatch && method === 'POST') {
        return await handleResetShareLink(req, resetMatch[1]);
      }
      const linkMatch = sub.match(/^\/([^/]+)$/);
      if (linkMatch) {
        if (method === 'PATCH') return await handleUpdateShareLink(req, linkMatch[1]);
        if (method === 'DELETE') return await handleRevokeShareLink(req, linkMatch[1]);
      }
    }
    // ── Privacy routes ─────────────────────────────────────────────────
    if (path === '/privacy/inventory' && method === 'GET') return await handleGetPrivacyInventory(req);
    if (path === '/privacy/processors' && method === 'GET') return await handleGetProcessors(req);
    if (path === '/privacy/controls' && method === 'GET') return await handleGetPrivacyControls(req);
    if (path === '/privacy/controls' && method === 'PUT') return await handleUpdatePrivacyControls(req);
    if (path === '/privacy/export' && method === 'POST') return await handleRequestExport(req);
    if (path === '/privacy/delete/cancel' && method === 'POST') return await handleCancelDeletion(req);
    if (path === '/privacy/delete' && method === 'POST') return await handleRequestDeletion(req);
    // ── Legacy: get-version-detail ─────────────────────────────────────
    if ((path === '/' || path === '') && method === 'POST') {
      return await handleGetVersionDetail(req);
    }
    return json({
      error: {
        code: 'NOT_FOUND',
        message: `Route not found: ${method} ${path}`
      }
    }, 404);
  } catch (e) {
    console.error('Unhandled error:', e);
    return json({
      error: {
        code: 'INTERNAL',
        message: 'An unexpected error occurred'
      }
    }, 500);
  }
});

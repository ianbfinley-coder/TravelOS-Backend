// FABRICATION REMOVED 2026-09-19
//
// This function invented hotel bookings and wrote them to
// `booking_reservations` as real, confirmed reservations. Five distinct
// defects, not one:
//
// 1. `sync_reservations` fabricated. Whenever the stored access token was
//    missing or began with `mock_token_`, it upserted TWO invented
//    reservations - "Grand Hotel & Spa", Paris, $680, and "Boutique City
//    Hotel", Barcelona, $550 - with status 'confirmed' and manufactured
//    confirmation numbers (CONF-<PLATFORM>-001), then reported them as
//    `synced`. A traveller could have packed for a hotel that does not exist.
//
// 2. Fake mode was CLIENT-CONTROLLED. `connect_platform` accepted a
//    `mock_credentials: true` flag from the request body and stored
//    `access_token = 'mock_token_' + platform_id`, marking the connection
//    CONNECTED. Any signed-in caller could switch on the fabrication above by
//    setting a boolean in the request.
//
// 3. A failed OAuth exchange looked like a successful one. `exchange_token`
//    defaulted to mock_token_/mock_refresh_, only attempted a real exchange
//    when the client id was not the literal 'demo_client', and on any non-ok
//    response or thrown error fell through to the mock token and still wrote
//    status CONNECTED. Broken credentials produced a connection that claimed
//    to work.
//
// 4. 'demo_client' / 'demo_secret' literals were the credential fallback, so
//    `initiate_oauth` happily built an authorization URL against a client id
//    belonging to nobody.
//
// 5. The OAuth redirect URI was hardcoded to https://travelos.app/..., a host
//    this project does not control. That is not merely a dead link - the
//    authorization code would have been delivered to someone else's domain.
//    Same class of defect as the invite-link host fixed in platform-trips on
//    2026-09-18, but with a credential on the line.
//
// Nothing had fabricated yet: booking_connections and booking_reservations
// were both empty when this was fixed. The first sync would have done it.
//
// The replacement never invents anything. No provider API client exists in
// this codebase, so `sync_reservations` says so (501) rather than filling the
// gap with fiction. Every credential path fails closed and records the real
// reason on the connection.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
// The deployed TravelOS web app. APP_BASE_URL overrides it when set; set that
// the moment a custom domain exists. The OAuth redirect URI is built from this,
// so a wrong value here means authorization codes go to the wrong host.
const DEFAULT_APP_BASE_URL = 'https://travelos-frontend-pi.vercel.app';
function appBaseUrl() {
  const configured = Deno.env.get('APP_BASE_URL')?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  return DEFAULT_APP_BASE_URL;
}
function redirectUriFor(platformId) {
  return `${appBaseUrl()}/auth/callback/${encodeURIComponent(platformId)}`;
}
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json'
    }
  });
}
function getServiceClient() {
  return createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));
}
/**
 * Per-platform OAuth credentials. Returns null when either half is missing.
 * There is deliberately NO fallback literal: 'demo_client' is not a client id,
 * and pretending it is one is what produced authorization URLs that could
 * never work and connections that claimed they did.
 */ function platformCredentials(platformId) {
  const upper = platformId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const clientId = Deno.env.get(`${upper}_CLIENT_ID`) ?? Deno.env.get('BOOKING_CLIENT_ID');
  const clientSecret = Deno.env.get(`${upper}_CLIENT_SECRET`) ?? Deno.env.get('BOOKING_CLIENT_SECRET');
  if (!clientId || !clientSecret) return null;
  return {
    clientId,
    clientSecret
  };
}
async function getAuthUser(req) {
  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const supabase = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_ANON_KEY'));
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user;
}
// Records why a connection is not usable, so the UI can say something true
// instead of showing a green tick.
async function markConnectionError(db, userId, platformId, message) {
  const { error } = await db.from('booking_connections').update({
    status: 'ERROR',
    error_message: message
  }).eq('user_id', userId).eq('platform_id', platformId);
  if (error) console.error('[booking-platform-sync] could not record connection error:', error.message);
}
async function handleGetPlatforms() {
  const db = getServiceClient();
  const { data, error } = await db.from('booking_platforms').select('id, name, display_name, auth_method, webhook_support, authorization_url, token_url, scopes, logo_url');
  if (error) return jsonResponse({
    error: error.message
  }, 500);
  // Say which platforms could actually be connected today. Listing sixteen
  // platforms with no credentials configured, and no way to tell them apart,
  // is how someone ends up believing a connection is one click away.
  const platforms = (data ?? []).map((p)=>({
      ...p,
      credentials_configured: platformCredentials(String(p.id)) !== null
    }));
  return jsonResponse({
    platforms
  });
}
async function handleGetConnections(userId) {
  const db = getServiceClient();
  const { data, error } = await db.from('booking_connections').select('id, platform_id, status, display_name, scope, connected_at, last_synced_at, error_message, booking_platforms(display_name, auth_method, webhook_support)').eq('user_id', userId);
  if (error) return jsonResponse({
    error: error.message
  }, 500);
  return jsonResponse({
    connections: data ?? []
  });
}
/**
 * Creates or updates the local record for a platform. It CANNOT mark a
 * connection CONNECTED: only a completed OAuth exchange that produced a real
 * access token may do that. The `mock_credentials` flag this used to accept is
 * gone - it let any caller turn on fabricated reservations.
 */ async function handleConnectPlatform(userId, body) {
  const platform_id = body.platform_id;
  const display_name = body.display_name;
  if (!platform_id) return jsonResponse({
    error: 'platform_id required'
  }, 400);
  if (body.mock_credentials !== undefined) {
    return jsonResponse({
      error: 'mock_credentials_removed',
      message: 'mock_credentials is no longer supported. It stored a fake access token and caused invented reservations to be written as real. Use initiate_oauth.'
    }, 400);
  }
  const db = getServiceClient();
  const upsertData = {
    user_id: userId,
    platform_id,
    status: 'DISCONNECTED',
    error_message: null
  };
  if (display_name) upsertData.display_name = display_name;
  const { data, error } = await db.from('booking_connections').upsert(upsertData, {
    onConflict: 'user_id,platform_id'
  }).select().single();
  if (error) return jsonResponse({
    error: error.message
  }, 500);
  return jsonResponse({
    success: true,
    connection: data,
    next_step: 'initiate_oauth',
    message: 'Record created. A platform is only CONNECTED once OAuth completes and returns a real access token.'
  });
}
async function handleDisconnectPlatform(userId, body) {
  const platform_id = body.platform_id;
  if (!platform_id) return jsonResponse({
    error: 'platform_id required'
  }, 400);
  const db = getServiceClient();
  const { error } = await db.from('booking_connections').update({
    status: 'DISCONNECTED',
    access_token: null,
    refresh_token: null,
    token_expires_at: null,
    error_message: null
  }).eq('user_id', userId).eq('platform_id', platform_id);
  if (error) return jsonResponse({
    error: error.message
  }, 500);
  return jsonResponse({
    success: true
  });
}
async function handleInitiateOAuth(userId, body) {
  const platform_id = body.platform_id;
  if (!platform_id) return jsonResponse({
    error: 'platform_id required'
  }, 400);
  const db = getServiceClient();
  const { data: platform, error: pErr } = await db.from('booking_platforms').select('authorization_url, scopes').eq('id', platform_id).single();
  if (pErr || !platform) return jsonResponse({
    error: 'Platform not found'
  }, 404);
  // Fail closed. Building an authorization URL around 'demo_client' produces a
  // link that cannot work and a user who thinks the integration is live.
  const creds = platformCredentials(platform_id);
  if (!creds) {
    return jsonResponse({
      error: 'credentials_not_configured',
      message: `No OAuth client is configured for ${platform_id}. Set ${platform_id.toUpperCase()}_CLIENT_ID and ${platform_id.toUpperCase()}_CLIENT_SECRET (or BOOKING_CLIENT_ID / BOOKING_CLIENT_SECRET) in Edge Function Secrets.`
    }, 503);
  }
  if (!platform.authorization_url) {
    return jsonResponse({
      error: 'platform_has_no_authorization_url',
      message: `${platform_id} has no authorization_url recorded.`
    }, 503);
  }
  const state = crypto.randomUUID();
  const { error: sErr } = await db.from('oauth_states').insert({
    user_id: userId,
    provider: platform_id,
    state
  });
  if (sErr) return jsonResponse({
    error: sErr.message
  }, 500);
  const params = new URLSearchParams({
    client_id: creds.clientId,
    redirect_uri: redirectUriFor(platform_id),
    scope: platform.scopes ?? '',
    state,
    response_type: 'code'
  });
  return jsonResponse({
    auth_url: `${platform.authorization_url}?${params.toString()}`,
    state
  });
}
async function handleExchangeToken(userId, body) {
  const platform_id = body.platform_id;
  const code = body.code;
  const state = body.state;
  if (!platform_id || !code || !state) return jsonResponse({
    error: 'platform_id, code, state required'
  }, 400);
  const db = getServiceClient();
  const { data: stateRow, error: stateErr } = await db.from('oauth_states').select('id, expires_at').eq('user_id', userId).eq('provider', platform_id).eq('state', state).single();
  if (stateErr || !stateRow) return jsonResponse({
    error: 'Invalid or expired state'
  }, 400);
  // The state is single-use whatever happens next.
  await db.from('oauth_states').delete().eq('id', stateRow.id);
  if (new Date(stateRow.expires_at) < new Date()) {
    return jsonResponse({
      error: 'State token expired'
    }, 400);
  }
  const creds = platformCredentials(platform_id);
  if (!creds) {
    await markConnectionError(db, userId, platform_id, 'OAuth client credentials are not configured for this platform.');
    return jsonResponse({
      error: 'credentials_not_configured',
      message: `No OAuth client is configured for ${platform_id}.`
    }, 503);
  }
  const { data: platform } = await db.from('booking_platforms').select('token_url').eq('id', platform_id).single();
  if (!platform?.token_url) {
    await markConnectionError(db, userId, platform_id, 'Platform has no token_url recorded.');
    return jsonResponse({
      error: 'platform_has_no_token_url'
    }, 503);
  }
  // Real exchange only. Every failure below marks the connection ERROR and
  // returns - none of them invents a token, and none of them writes CONNECTED.
  let tokenPayload;
  try {
    const tokenRes = await fetch(platform.token_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        redirect_uri: redirectUriFor(platform_id)
      })
    });
    const raw = await tokenRes.text();
    if (!tokenRes.ok) {
      // Log the upstream body; never return it - token endpoints echo
      // parameters, including the client secret, in their error responses.
      console.error(`[booking-platform-sync] token exchange for ${platform_id} failed ${tokenRes.status}:`, raw.slice(0, 500));
      await markConnectionError(db, userId, platform_id, `Token exchange failed (HTTP ${tokenRes.status}).`);
      return jsonResponse({
        error: 'token_exchange_failed',
        status: tokenRes.status
      }, 502);
    }
    try {
      tokenPayload = JSON.parse(raw);
    } catch  {
      console.error(`[booking-platform-sync] token exchange for ${platform_id} returned non-JSON:`, raw.slice(0, 300));
      await markConnectionError(db, userId, platform_id, 'Token endpoint returned a response that could not be parsed.');
      return jsonResponse({
        error: 'token_response_unparseable'
      }, 502);
    }
  } catch (e) {
    console.error(`[booking-platform-sync] token exchange for ${platform_id} threw:`, e instanceof Error ? e.message : String(e));
    await markConnectionError(db, userId, platform_id, 'Token endpoint was unreachable.');
    return jsonResponse({
      error: 'token_endpoint_unreachable'
    }, 502);
  }
  // A 200 with no access_token is a failure, not a success. The old code kept
  // its mock token in exactly this case.
  if (!tokenPayload.access_token) {
    await markConnectionError(db, userId, platform_id, 'Token endpoint returned no access_token.');
    return jsonResponse({
      error: 'no_access_token_returned'
    }, 502);
  }
  const expiresAt = tokenPayload.expires_in ? new Date(Date.now() + tokenPayload.expires_in * 1000).toISOString() : null;
  const { data, error } = await db.from('booking_connections').upsert({
    user_id: userId,
    platform_id,
    status: 'CONNECTED',
    access_token: tokenPayload.access_token,
    refresh_token: tokenPayload.refresh_token ?? null,
    token_expires_at: expiresAt,
    connected_at: new Date().toISOString(),
    error_message: null
  }, {
    onConflict: 'user_id,platform_id'
  }).select('id, platform_id, status, display_name, connected_at, token_expires_at').single();
  if (error) return jsonResponse({
    error: error.message
  }, 500);
  return jsonResponse({
    success: true,
    connection: data
  });
}
/**
 * There is no provider API client in this codebase. The OAuth plumbing exists;
 * the code that would call a platform's reservations endpoint and map the
 * result into `booking_reservations` does not. This action therefore reports
 * that, and writes nothing.
 *
 * It used to fill that gap with two invented hotel bookings.
 */ async function handleSyncReservations(userId, body) {
  const platform_id = body.platform_id;
  if (!platform_id) return jsonResponse({
    error: 'platform_id required'
  }, 400);
  const db = getServiceClient();
  const { data: conn, error: connErr } = await db.from('booking_connections').select('access_token, status').eq('user_id', userId).eq('platform_id', platform_id).maybeSingle();
  if (connErr) {
    console.error('[booking-platform-sync] connection lookup failed:', connErr.message);
    return jsonResponse({
      error: 'connection_lookup_failed'
    }, 500);
  }
  if (!conn) return jsonResponse({
    error: 'no_connection',
    message: 'No connection found for this platform.'
  }, 404);
  if (conn.status !== 'CONNECTED' || !conn.access_token) {
    return jsonResponse({
      error: 'not_connected',
      synced: 0,
      reservations: [],
      message: `${platform_id} is not connected. Complete the OAuth flow first.`
    }, 409);
  }
  // A token left over from the removed mock mode is not a credential.
  if (conn.access_token.startsWith('mock_token_')) {
    await markConnectionError(db, userId, platform_id, 'Stored token was a placeholder from the removed mock mode. Reconnect this platform.');
    return jsonResponse({
      error: 'placeholder_token',
      synced: 0,
      reservations: [],
      message: 'This connection holds a placeholder token from the removed mock mode and has been marked ERROR. Reconnect the platform.'
    }, 409);
  }
  console.log(`[booking-platform-sync] sync requested for ${platform_id}; no provider client implemented`);
  return jsonResponse({
    error: 'provider_sync_not_implemented',
    synced: 0,
    reservations: [],
    message: `This platform is connected, but TravelOS has no client for ${platform_id}'s reservations API yet, so there is nothing to import. No data has been written.`
  }, 501);
}
async function handleGetReservations(userId, body) {
  const trip_id = body.trip_id;
  const db = getServiceClient();
  let query = db.from('booking_reservations').select('*').eq('user_id', userId).order('check_in', {
    ascending: true
  });
  if (trip_id) query = query.eq('trip_id', trip_id);
  const { data, error } = await query;
  if (error) return jsonResponse({
    error: error.message
  }, 500);
  return jsonResponse({
    reservations: data ?? []
  });
}
async function handleGetPriceHistory(userId, body) {
  const reservation_id = body.reservation_id;
  if (!reservation_id) return jsonResponse({
    error: 'reservation_id required'
  }, 400);
  const db = getServiceClient();
  const { data, error } = await db.from('price_snapshots').select('price, recorded_at').eq('reservation_id', reservation_id).eq('user_id', userId).order('recorded_at', {
    ascending: true
  }).limit(30);
  if (error) return jsonResponse({
    error: error.message
  }, 500);
  return jsonResponse({
    price_history: data ?? []
  });
}
Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS
    });
  }
  if (req.method !== 'POST') {
    return jsonResponse({
      error: 'Method not allowed'
    }, 405);
  }
  let body = {};
  try {
    body = await req.json();
  } catch (_e) {
    return jsonResponse({
      error: 'Invalid JSON body'
    }, 400);
  }
  const action = body.action;
  if (!action) return jsonResponse({
    error: 'action required'
  }, 400);
  // Every action requires a real user. get_platforms used to be reachable
  // before this check; it now reports which platforms have credentials
  // configured, which is not something to hand to anonymous callers.
  const user = await getAuthUser(req);
  if (!user) return jsonResponse({
    error: 'unauthorized'
  }, 401);
  if (action === 'get_platforms') return handleGetPlatforms();
  if (action === 'get_connections') return handleGetConnections(user.id);
  if (action === 'connect_platform') return handleConnectPlatform(user.id, body);
  if (action === 'disconnect_platform') return handleDisconnectPlatform(user.id, body);
  if (action === 'initiate_oauth') return handleInitiateOAuth(user.id, body);
  if (action === 'exchange_token') return handleExchangeToken(user.id, body);
  if (action === 'sync_reservations') return handleSyncReservations(user.id, body);
  if (action === 'get_reservations') return handleGetReservations(user.id, body);
  if (action === 'get_price_history') return handleGetPriceHistory(user.id, body);
  return jsonResponse({
    error: 'Unknown action: ' + action
  }, 400);
});

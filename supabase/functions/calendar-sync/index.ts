import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
// COLUMN FIX 2026-09-19 — every calendar_connections query in this file named
// columns that do not exist on public.calendar_connections, so PostgREST
// rejected each whole statement with 42703:
//   `is_connected`     -> the real column is `is_active`
//   `calendar_id`      -> the real column is `provider_calendar_id`
//   `provider_user_id` -> no such column at all (dropped; the provider's
//                         account is identified by `provider_email`)
// Consequences, all of them silent or misattributed:
//   get_connections   returned HTTP 500 with the raw PostgREST message.
//   save_connection   returned 500; no calendar could ever be connected.
//   disconnect        returned 500; no calendar could ever be disconnected.
//   create_events     folded the error into `if (connErr || !conn)` and
//                     answered 404 "No active connection for provider" — for
//                     users who did have an active connection.
//   delete_events     discarded the error entirely, found `conn` null, deleted
//                     nothing from the provider, and reported `deleted: 0` as
//                     if there had been nothing to delete.
// In short: calendar sync has never worked for anyone through this function.
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json'
    }
  });
}
async function getAuthUser(req) {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return null;
  const token = authHeader.replace('Bearer ', '');
  const supabase = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;
  return {
    user,
    supabase
  };
}
Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: corsHeaders
    });
  }
  const auth = await getAuthUser(req);
  if (!auth) return json({
    error: 'Unauthorized'
  }, 401);
  const { user, supabase } = auth;
  const url = new URL(req.url);
  let action = url.searchParams.get('action');
  let body = {};
  if (req.method === 'POST') {
    try {
      body = await req.json();
    } catch (_) {
      body = {};
    }
    if (!action && body.action) action = body.action;
  }
  if (!action) {
    // Infer from path
    const path = url.pathname.split('/').pop();
    action = path ?? null;
  }
  // ── get_connections ──────────────────────────────────────────
  if (action === 'get_connections') {
    // COLUMN FIX 2026-09-19 — `is_connected` / `calendar_id` do not exist.
    const { data, error } = await supabase.from('calendar_connections').select('id, provider, is_active, provider_email, provider_calendar_id, token_expires_at, created_at, access_token, refresh_token').eq('user_id', user.id);
    if (error) return json({
      error: error.message
    }, 500);
    const connections = (data ?? []).map((c)=>({
        id: c.id,
        provider: c.provider,
        is_connected: c.is_active,
        provider_email: c.provider_email,
        calendar_id: c.provider_calendar_id,
        token_expires_at: c.token_expires_at,
        created_at: c.created_at,
        has_token: !!(c.access_token || c.refresh_token)
      }));
    return json({
      connections
    });
  }
  // ── save_connection ──────────────────────────────────────────
  if (action === 'save_connection') {
    const { provider, access_token, refresh_token, token_expires_at, provider_email, calendar_id } = body;
    if (!provider) return json({
      error: 'provider required'
    }, 400);
    // COLUMN FIX 2026-09-19 — `is_connected`, `calendar_id` and
    // `provider_user_id` are not columns on calendar_connections.
    // `provider_user_id` has no counterpart and is dropped rather than
    // written somewhere it does not belong.
    const { data, error } = await supabase.from('calendar_connections').upsert({
      user_id: user.id,
      provider,
      access_token: access_token ?? null,
      refresh_token: refresh_token ?? null,
      token_expires_at: token_expires_at ?? null,
      provider_email: provider_email ?? null,
      provider_calendar_id: calendar_id ?? 'primary',
      is_active: true,
      updated_at: new Date().toISOString()
    }, {
      onConflict: 'user_id,provider'
    }).select('id, provider, is_active, provider_email').single();
    if (error) return json({
      error: error.message
    }, 500);
    return json({
      connection: {
        id: data.id,
        provider: data.provider,
        is_connected: data.is_active,
        provider_email: data.provider_email
      }
    });
  }
  // ── disconnect ───────────────────────────────────────────────
  if (action === 'disconnect') {
    const { provider } = body;
    if (!provider) return json({
      error: 'provider required'
    }, 400);
    // COLUMN FIX 2026-09-19 — `is_connected` -> `is_active`.
    const { error } = await supabase.from('calendar_connections').update({
      is_active: false,
      access_token: null,
      refresh_token: null,
      updated_at: new Date().toISOString()
    }).eq('user_id', user.id).eq('provider', provider);
    if (error) return json({
      error: error.message
    }, 500);
    return json({
      success: true
    });
  }
  // ── refresh_token ───────────────────────────────────────────
  if (action === 'refresh_token') {
    const { provider, refresh_token } = body;
    if (!provider || !refresh_token) return json({
      error: 'provider and refresh_token required'
    }, 400);
    let tokenUrl;
    let params;
    if (provider === 'google') {
      tokenUrl = 'https://oauth2.googleapis.com/token';
      params = {
        grant_type: 'refresh_token',
        refresh_token,
        client_id: Deno.env.get('GOOGLE_CLIENT_ID') ?? '',
        client_secret: Deno.env.get('GOOGLE_CLIENT_SECRET') ?? ''
      };
    } else if (provider === 'outlook') {
      tokenUrl = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
      params = {
        grant_type: 'refresh_token',
        refresh_token,
        client_id: Deno.env.get('MICROSOFT_CLIENT_ID') ?? '',
        client_secret: Deno.env.get('MICROSOFT_CLIENT_SECRET') ?? ''
      };
    } else {
      return json({
        error: 'Token refresh not supported for this provider'
      }, 400);
    }
    const resp = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams(params).toString()
    });
    if (!resp.ok) {
      const errText = await resp.text();
      return json({
        error: 'Token refresh failed',
        details: errText
      }, 502);
    }
    const tokenData = await resp.json();
    const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();
    const { error: storeErr } = await supabase.from('calendar_connections').update({
      access_token: tokenData.access_token,
      token_expires_at: expiresAt,
      updated_at: new Date().toISOString()
    }).eq('user_id', user.id).eq('provider', provider);
    if (storeErr) {
      console.error('[calendar-sync] storing refreshed token failed:', storeErr.message);
      return json({
        error: 'Refreshed token could not be stored',
        details: storeErr.message
      }, 500);
    }
    return json({
      access_token: tokenData.access_token,
      expires_at: expiresAt
    });
  }
  // ── create_events ───────────────────────────────────────────
  if (action === 'create_events') {
    const { provider, events, trip_id } = body;
    if (!provider || !events || !trip_id) return json({
      error: 'provider, events, and trip_id required'
    }, 400);
    if (provider === 'apple') {
      return json({
        method: 'ics_download',
        message: 'Apple Calendar uses ICS file download'
      });
    }
    // Get connection
    // COLUMN FIX 2026-09-19 — `calendar_id` / `is_connected` do not exist, and
    // the resulting 42703 was reported as "No active connection for provider".
    const { data: conn, error: connErr } = await supabase.from('calendar_connections').select('access_token, provider_calendar_id, token_expires_at').eq('user_id', user.id).eq('provider', provider).eq('is_active', true).maybeSingle();
    if (connErr) {
      console.error('[calendar-sync] connection lookup failed:', connErr.message);
      return json({
        error: 'Calendar connection lookup failed',
        details: connErr.message
      }, 500);
    }
    if (!conn) return json({
      error: 'No active connection for provider'
    }, 404);
    // Check token expiry
    if (conn.token_expires_at && new Date(conn.token_expires_at) <= new Date()) {
      return json({
        error: 'token_expired'
      }, 401);
    }
    const calendarId = conn.provider_calendar_id ?? 'primary';
    const accessToken = conn.access_token;
    let created = 0;
    let failed = 0;
    const providerEventIds = [];
    const syncLogEntries = [];
    for (const evt of events){
      try {
        let eventResp;
        if (provider === 'google') {
          const googleEvent = {
            summary: evt.summary,
            description: evt.description ?? '',
            location: evt.location ?? '',
            start: {
              dateTime: evt.dtStart,
              timeZone: 'UTC'
            },
            end: {
              dateTime: evt.dtEnd,
              timeZone: 'UTC'
            },
            reminders: {
              useDefault: false,
              overrides: [
                {
                  method: 'popup',
                  minutes: 1440
                }
              ]
            }
          };
          eventResp = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(googleEvent)
          });
        } else {
          // outlook
          const outlookEvent = {
            subject: evt.summary,
            body: {
              contentType: 'text',
              content: evt.description ?? ''
            },
            start: {
              dateTime: evt.dtStart,
              timeZone: 'UTC'
            },
            end: {
              dateTime: evt.dtEnd,
              timeZone: 'UTC'
            },
            location: {
              displayName: evt.location ?? ''
            },
            isReminderOn: true,
            reminderMinutesBeforeStart: 1440
          };
          eventResp = await fetch('https://graph.microsoft.com/v1.0/me/events', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(outlookEvent)
          });
        }
        if (eventResp.ok) {
          const eventData = await eventResp.json();
          const providerEventId = eventData.id;
          providerEventIds.push(providerEventId);
          created++;
          syncLogEntries.push({
            user_id: user.id,
            trip_id,
            provider,
            provider_event_id: providerEventId,
            status: 'synced'
          });
        } else {
          const errText = await eventResp.text();
          failed++;
          syncLogEntries.push({
            user_id: user.id,
            trip_id,
            provider,
            provider_event_id: `failed_${evt.uid}`,
            status: 'failed',
            error_message: errText.slice(0, 500)
          });
        }
      } catch (e) {
        failed++;
        syncLogEntries.push({
          user_id: user.id,
          trip_id,
          provider,
          provider_event_id: `failed_${evt.uid}`,
          status: 'failed',
          error_message: String(e).slice(0, 500)
        });
      }
    }
    if (syncLogEntries.length > 0) {
      const { error: logInsertErr } = await supabase.from('calendar_sync_log').insert(syncLogEntries);
      if (logInsertErr) console.error('[calendar-sync] calendar_sync_log insert failed:', logInsertErr.message);
    }
    return json({
      created,
      failed,
      provider_event_ids: providerEventIds
    });
  }
  // ── delete_events ───────────────────────────────────────────
  if (action === 'delete_events') {
    const { provider, trip_id } = body;
    if (!provider || !trip_id) return json({
      error: 'provider and trip_id required'
    }, 400);
    // Get connection for access token
    // COLUMN FIX 2026-09-19 — same non-existent `calendar_id` / `is_connected`,
    // and the error was discarded entirely, so this reported `deleted: 0`
    // instead of admitting it could not reach the provider.
    const { data: conn, error: connErr } = await supabase.from('calendar_connections').select('access_token, provider_calendar_id').eq('user_id', user.id).eq('provider', provider).eq('is_active', true).maybeSingle();
    if (connErr) {
      console.error('[calendar-sync] connection lookup failed:', connErr.message);
      return json({
        error: 'Calendar connection lookup failed',
        details: connErr.message
      }, 500);
    }
    // Get synced log entries
    const { data: logEntries, error: logErr } = await supabase.from('calendar_sync_log').select('id, provider_event_id').eq('user_id', user.id).eq('trip_id', trip_id).eq('provider', provider).eq('status', 'synced');
    if (logErr) return json({
      error: logErr.message
    }, 500);
    if (!logEntries || logEntries.length === 0) return json({
      deleted: 0
    });
    if (!conn?.access_token) {
      // Do not report 0 deletions as success when there is nothing to delete
      // with: say why.
      return json({
        error: 'No active connection for provider',
        deleted: 0
      }, 404);
    }
    let deleted = 0;
    const deletedIds = [];
    const calendarId = conn.provider_calendar_id ?? 'primary';
    for (const entry of logEntries){
      try {
        let delResp;
        if (provider === 'google') {
          delResp = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${entry.provider_event_id}`, {
            method: 'DELETE',
            headers: {
              Authorization: `Bearer ${conn.access_token}`
            }
          });
        } else {
          delResp = await fetch(`https://graph.microsoft.com/v1.0/me/events/${entry.provider_event_id}`, {
            method: 'DELETE',
            headers: {
              Authorization: `Bearer ${conn.access_token}`
            }
          });
        }
        if (delResp.ok || delResp.status === 404) {
          deleted++;
          deletedIds.push(entry.id);
        }
      } catch (e) {
        console.error('[calendar-sync] provider delete failed:', e);
      }
    }
    if (deletedIds.length > 0) {
      const { error: markErr } = await supabase.from('calendar_sync_log').update({
        status: 'deleted'
      }).in('id', deletedIds);
      if (markErr) console.error('[calendar-sync] marking sync log deleted failed:', markErr.message);
    }
    return json({
      deleted
    });
  }
  // ── get_sync_log ───────────────────────────────────────────
  if (action === 'get_sync_log') {
    const trip_id = url.searchParams.get('trip_id') ?? body.trip_id;
    if (!trip_id) return json({
      error: 'trip_id required'
    }, 400);
    const { data, error } = await supabase.from('calendar_sync_log').select('*').eq('user_id', user.id).eq('trip_id', trip_id).order('synced_at', {
      ascending: false
    });
    if (error) return json({
      error: error.message
    }, 500);
    const grouped = {
      google: [],
      outlook: [],
      apple: []
    };
    for (const entry of data ?? []){
      const p = entry.provider;
      if (!grouped[p]) grouped[p] = [];
      grouped[p].push(entry);
    }
    return json({
      log: grouped
    });
  }
  return json({
    error: `Unknown action: ${action}`
  }, 400);
});

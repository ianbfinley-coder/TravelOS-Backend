// calm-ux: Alert Preferences, Tips, Place Reports, Support, Glance, Outbox
// (deployed to analyze-pace slot due to function limit; frontend calls /functions/v1/calm-ux)
//
// COLUMN NAMES 2026-09-19 - GET /glance named five columns that do not exist,
// across all three of its content queries. PostgREST rejects the ENTIRE query
// when a selected, filtered or ordered column is missing (error 42703), so each
// of the three returned { data: null, error: 42703 }. The errors WERE logged
// (that part was already fixed), but the payload was built from
// res.data?.[0] ?? null, so all three came out null and /glance answered
// HTTP 200 with nothing but {tripId, generatedAt} - no next item, no flight,
// no alert - on every single call, for every user, since the route shipped.
// The traveller's at-a-glance screen has been permanently, silently empty.
//
// itinerary_items.starts_at does not exist. The columns are start_time
// and end_time, both timestamptz.
// itinerary_items.place_name does not exist. The nearest real column is
// location (text).
// reservations.starts_at does not exist. A reservation's start is split
// across start_date (date) and start_time (time without time zone),
// interpreted in the row's own timezone.
// reservations.type does not exist. The column is reservation_type.
// reservations.metadata does not exist. The jsonb column is details.
// disruption_cases.title does not exist. That table has no title at all:
// it stores root_cause (jsonb) and the human sentence is composed at
// display time, matching disruption-engine's own notifier derivation.
//
// Because reservations store a local wall-clock time rather than an instant,
// the next-24-hours window can no longer be a plain timestamp comparison in
// the database. The query now bounds start_date to a +/-1-day range (a cheap
// superset that the index can serve) and the exact window is applied in code by
// comparing local wall-clock strings, using each row's own timezone (falling
// back to the trip's primary_tz). No time is fabricated and no offset is
// guessed.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
const ALL_KINDS = [
  'flight_status',
  'gate_change',
  'boarding_soon',
  'connection_risk',
  'disruption_case',
  'weather_change',
  'safety_note',
  'entry_rule_change',
  'price_change',
  'deal_found',
  'fee_creep',
  'expense_added',
  'settle_nudge',
  'payment_confirm',
  'poll_opened',
  'poll_closing',
  'mention',
  'comment_reply',
  'suggestion',
  'prep_reminder',
  'checkin_timer',
  'rollcall'
];
const SAFETY_CRITICAL = new Set([
  'checkin_timer',
  'rollcall',
  'connection_risk'
]);
const DEFAULTS = {
  flight_status: {
    push: true,
    email: false,
    inApp: true
  },
  gate_change: {
    push: true,
    email: false,
    inApp: true
  },
  boarding_soon: {
    push: true,
    email: false,
    inApp: true
  },
  connection_risk: {
    push: true,
    email: false,
    inApp: true
  },
  disruption_case: {
    push: true,
    email: false,
    inApp: true
  },
  weather_change: {
    push: false,
    email: false,
    inApp: true
  },
  safety_note: {
    push: false,
    email: false,
    inApp: true
  },
  entry_rule_change: {
    push: true,
    email: true,
    inApp: true
  },
  price_change: {
    push: false,
    email: false,
    inApp: true
  },
  deal_found: {
    push: false,
    email: false,
    inApp: true
  },
  fee_creep: {
    push: false,
    email: false,
    inApp: true
  },
  expense_added: {
    push: false,
    email: false,
    inApp: true
  },
  settle_nudge: {
    push: true,
    email: false,
    inApp: true
  },
  payment_confirm: {
    push: true,
    email: false,
    inApp: true
  },
  poll_opened: {
    push: true,
    email: false,
    inApp: true
  },
  poll_closing: {
    push: true,
    email: false,
    inApp: true
  },
  mention: {
    push: true,
    email: false,
    inApp: true
  },
  comment_reply: {
    push: true,
    email: false,
    inApp: true
  },
  suggestion: {
    push: false,
    email: false,
    inApp: true
  },
  prep_reminder: {
    push: true,
    email: true,
    inApp: true
  },
  checkin_timer: {
    push: true,
    email: false,
    inApp: true
  },
  rollcall: {
    push: true,
    email: false,
    inApp: true
  }
};
function ulid(prefix) {
  const ts = Date.now().toString(36).toUpperCase().padStart(10, '0');
  const rand = Array.from({
    length: 16
  }, ()=>'0123456789ABCDEFGHJKMNPQRSTVWXYZ'[Math.floor(Math.random() * 32)]).join('');
  return `${prefix}${ts}${rand}`;
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
function localDate(at, tz) {
  return localWallClock(at, tz).slice(0, 10);
}
function localWallClock(at, tz) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).format(at);
  } catch  {
    console.error('[calm-ux] unknown time zone, falling back to UTC:', tz);
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).format(at);
  }
  return parts.replace(', ', 'T').replace('T24:', 'T00:');
}
function normalizeTime(t) {
  if (typeof t !== 'string' || t.length === 0) return '00:00:00';
  const [hms] = t.split('+');
  const bits = hms.split(':');
  const hh = (bits[0] ?? '00').padStart(2, '0');
  const mm = (bits[1] ?? '00').padStart(2, '0');
  const ss = (bits[2] ?? '00').split('.')[0].padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}
function makeDb(_req) {
  return createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));
}
async function getUser(req) {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return null;
  const userClient = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_ANON_KEY'), {
    global: {
      headers: {
        Authorization: authHeader
      }
    }
  });
  const { data: { user } } = await userClient.auth.getUser();
  return user;
}
async function resolvePlatformUserId(db, authUserId) {
  const { data, error } = await db.from('auth_identities').select('user_id').eq('provider_subject', authUserId).maybeSingle();
  if (error) {
    console.error('[calm-ux] resolvePlatformUserId lookup failed:', error.message);
    return null;
  }
  return data?.user_id ?? null;
}
async function callerCanAccessTrip(db, tripId, authUserId) {
  const platformUserId = await resolvePlatformUserId(db, authUserId);
  if (platformUserId) {
    const { data: memberRows, error: memberErr } = await db.from('trip_members').select('id').eq('trip_id', tripId).eq('user_id', platformUserId).is('removed_at', null).limit(1);
    if (memberErr) {
      console.error('[calm-ux] trip_members authorization lookup failed:', memberErr.message);
      return false;
    }
    if ((memberRows ?? []).length > 0) return true;
  }
  const { data: ownerRows, error: ownerErr } = await db.from('trips').select('id').eq('id', tripId).eq('user_id', authUserId).limit(1);
  if (ownerErr) {
    console.error('[calm-ux] trips owner authorization lookup failed:', ownerErr.message);
    return false;
  }
  return (ownerRows ?? []).length > 0;
}
async function handleGetAlertPreferences(req, db, userId) {
  const url = new URL(req.url);
  const tripId = url.searchParams.get('tripId') ?? null;
  const { data: globalRows, error: globalErr } = await db.from('alert_preferences_v2').select('*').eq('user_id', userId).is('trip_id', null);
  if (globalErr) {
    console.error('[calm-ux] /alert-preferences global read failed:', globalErr.message);
    return err('DB_ERROR', 'Could not read alert preferences', 500);
  }
  const globalMap = {};
  for (const row of globalRows ?? [])globalMap[row.kind] = row;
  const tripMap = {};
  if (tripId) {
    const { data: tripRows, error: tripRowsErr } = await db.from('alert_preferences_v2').select('*').eq('user_id', userId).eq('trip_id', tripId);
    if (tripRowsErr) {
      console.error('[calm-ux] /alert-preferences trip read failed:', tripRowsErr.message);
      return err('DB_ERROR', 'Could not read trip alert preferences', 500);
    }
    for (const row of tripRows ?? [])tripMap[row.kind] = row;
  }
  const preferences = ALL_KINDS.map((kind)=>{
    const base = globalMap[kind];
    const override = tripMap[kind];
    const def = DEFAULTS[kind];
    return {
      kind,
      tripId: tripId ?? null,
      push: override ? override.push_enabled : base ? base.push_enabled : def.push,
      email: override ? override.email_enabled : base ? base.email_enabled : def.email,
      inApp: override ? override.in_app_enabled : base ? base.in_app_enabled : def.inApp,
      filterParams: override?.filter_params ?? base?.filter_params ?? null,
      isSafetyCritical: SAFETY_CRITICAL.has(kind)
    };
  });
  return json({
    preferences
  });
}
async function handlePutAlertPreferences(req, db, userId) {
  const body = await req.json();
  const items = body.preferences;
  if (!Array.isArray(items)) return err('INVALID_BODY', 'preferences must be an array');
  for (const item of items){
    if (SAFETY_CRITICAL.has(item.kind)) {
      if (!item.push && !item.email && !item.inApp) {
        return err('SAFETY_CRITICAL_DISABLED', 'This alert type cannot be fully disabled during an active trip', 422);
      }
    }
  }
  const tripIds = [
    ...new Set(items.map((i)=>i.tripId).filter((t)=>!!t))
  ];
  for (const tripId of tripIds){
    if (!await callerCanAccessTrip(db, tripId, userId)) {
      return err('NOT_FOUND', 'Trip not found', 404);
    }
  }
  const rows = items.map((item)=>({
      user_id: userId,
      trip_id: item.tripId ?? null,
      kind: item.kind,
      push_enabled: item.push,
      email_enabled: item.email,
      in_app_enabled: item.inApp,
      filter_params: item.filterParams ?? null,
      updated_at: new Date().toISOString()
    }));
  const { error: upsertErr } = await db.from('alert_preferences_v2').upsert(rows, {
    onConflict: 'user_id,kind,trip_id'
  });
  if (upsertErr) return err('DB_ERROR', upsertErr.message, 500);
  return json({
    updated: rows.length
  });
}
async function handleGetTips(db, userId) {
  const { data, error: dbErr } = await db.from('tips_preferences').select('*').eq('user_id', userId).maybeSingle();
  if (dbErr) return err('DB_ERROR', dbErr.message, 500);
  if (!data) {
    const defaultRow = {
      user_id: userId,
      level: 'essential',
      dismissed: [],
      updated_at: new Date().toISOString()
    };
    const { error: seedErr } = await db.from('tips_preferences').insert(defaultRow);
    if (seedErr) console.error('[calm-ux] /tips default row insert failed:', seedErr.message);
    return json(defaultRow);
  }
  return json(data);
}
async function handlePutTips(req, db, userId) {
  const body = await req.json();
  const update = {
    user_id: userId,
    updated_at: new Date().toISOString()
  };
  if (body.level !== undefined) update.level = body.level;
  if (body.dismissed !== undefined) update.dismissed = body.dismissed;
  const { error: upsertErr } = await db.from('tips_preferences').upsert(update, {
    onConflict: 'user_id'
  });
  if (upsertErr) return err('DB_ERROR', upsertErr.message, 500);
  return json({
    ok: true
  });
}
async function handlePostPlaceReport(req, db, userId) {
  const body = await req.json();
  const { placeId, tripId, kind, note, photoUrl } = body;
  if (!placeId || !kind) return err('MISSING_FIELDS', 'placeId and kind are required');
  if (tripId && !await callerCanAccessTrip(db, tripId, userId)) {
    return err('NOT_FOUND', 'Trip not found', 404);
  }
  const id = ulid('rpt_');
  const report = {
    id,
    place_id: placeId,
    reporter_id: userId,
    trip_id: tripId ?? null,
    kind,
    note: note ?? null,
    photo_url: photoUrl ?? null,
    status: 'pending',
    override_data: null,
    expires_at: null,
    created_at: new Date().toISOString()
  };
  const { error: insertErr } = await db.from('place_reports').insert(report);
  if (insertErr) return err('DB_ERROR', insertErr.message, 500);
  const { data: consistentReports, error: consistentErr } = await db.from('place_reports').select('id').eq('place_id', placeId).eq('kind', kind).in('status', [
    'pending',
    'approved'
  ]);
  if (consistentErr) {
    console.error('[calm-ux] /place-reports consensus count failed:', consistentErr.message);
  }
  if (!consistentErr && (consistentReports?.length ?? 0) >= 3) {
    const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
    const { error: approveErr } = await db.from('place_reports').update({
      status: 'approved',
      expires_at: expiresAt
    }).eq('place_id', placeId).eq('kind', kind).eq('status', 'pending');
    if (approveErr) console.error('[calm-ux] /place-reports auto-approve failed:', approveErr.message);
  }
  return json({
    report
  }, 201);
}
async function handleGetPlaceReports(placeId, db) {
  const { data, error: dbErr } = await db.from('place_reports').select('kind, override_data, expires_at').eq('place_id', placeId).eq('status', 'approved').gt('expires_at', new Date().toISOString());
  if (dbErr) return err('DB_ERROR', dbErr.message, 500);
  const overrides = (data ?? []).map((r)=>({
      kind: r.kind,
      overrideData: r.override_data,
      expiresAt: r.expires_at
    }));
  return json({
    overrides
  });
}
async function handlePostSupportConversation(req, db, userId) {
  const body = await req.json();
  const { tripId, screen, caseId, recentErrors, offlineQueueSize } = body;
  if (!screen) return err('MISSING_FIELDS', 'screen is required');
  if (tripId && !await callerCanAccessTrip(db, tripId, userId)) {
    return err('NOT_FOUND', 'Trip not found', 404);
  }
  const id = ulid('sup_');
  const convo = {
    id,
    user_id: userId,
    trip_id: tripId ?? null,
    screen,
    case_id: caseId ?? null,
    context: {
      recentErrors: recentErrors ?? [],
      offlineQueueSize: offlineQueueSize ?? 0
    },
    adapter: 'mock',
    external_id: null,
    trip_access_granted_until: null,
    created_at: new Date().toISOString()
  };
  const { error: insertErr } = await db.from('support_conversations').insert(convo);
  if (insertErr) return err('DB_ERROR', insertErr.message, 500);
  return json({
    conversationId: id,
    responseExpectation: 'Usually replies within 2 hours'
  }, 201);
}
async function handleGrantTripAccess(req, convId, db, userId) {
  const body = await req.json();
  const hours = Math.min(Number(body.hours ?? 1), 24);
  if (isNaN(hours) || hours <= 0) return err('INVALID_HOURS', 'hours must be between 1 and 24');
  const { data: convo, error: convoErr } = await db.from('support_conversations').select('id, user_id').eq('id', convId).maybeSingle();
  if (convoErr) {
    console.error('[calm-ux] support_conversations lookup failed:', convoErr.message);
    return err('DB_ERROR', 'Could not read the conversation', 500);
  }
  if (!convo) return err('NOT_FOUND', 'Conversation not found', 404);
  if (convo.user_id !== userId) return err('FORBIDDEN', 'Not your conversation', 403);
  const grantedUntil = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  const { error: updateErr } = await db.from('support_conversations').update({
    trip_access_granted_until: grantedUntil
  }).eq('id', convId);
  if (updateErr) return err('DB_ERROR', updateErr.message, 500);
  return json({
    grantedUntil
  });
}
async function handleGetGlance(db, userId) {
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const platformUserId = await resolvePlatformUserId(db, userId);
  if (!platformUserId) {
    console.error('[calm-ux] /glance: no platform identity for auth user', userId);
    return json({
      tripId: null,
      generatedAt: now
    });
  }
  const { data: memberRows, error: memberErr } = await db.from('trip_members').select('trip_id').eq('user_id', platformUserId);
  if (memberErr) {
    console.error('[calm-ux] /glance: trip_members lookup failed:', memberErr.message);
    return err('DB_ERROR', 'Could not load your trips', 500);
  }
  const tripIds = (memberRows ?? []).map((r)=>r.trip_id);
  if (!tripIds.length) return json({
    tripId: null,
    generatedAt: now
  });
  const { data: trips, error: tripsErr } = await db.from('trips').select('id, start_date, end_date, primary_tz').in('id', tripIds).order('start_date', {
    ascending: true
  });
  if (tripsErr) {
    console.error('[calm-ux] /glance: trips lookup failed:', tripsErr.message);
    return err('DB_ERROR', 'Could not load trips', 500);
  }
  const tripRows = trips ?? [];
  const current = tripRows.find((t)=>{
    const todayThere = localDate(nowDate, t.primary_tz ?? 'UTC');
    return t.start_date <= todayThere && todayThere <= t.end_date;
  });
  const upcoming = current ?? tripRows.find((t)=>t.start_date > localDate(nowDate, t.primary_tz ?? 'UTC'));
  if (!upcoming) return json({
    tripId: null,
    generatedAt: now
  });
  const activeTripId = upcoming.id;
  const activeTripTz = upcoming.primary_tz ?? 'UTC';
  const in24hDate = new Date(nowDate.getTime() + 24 * 60 * 60 * 1000);
  const dateFrom = localDate(new Date(nowDate.getTime() - 24 * 60 * 60 * 1000), activeTripTz);
  const dateTo = localDate(new Date(nowDate.getTime() + 48 * 60 * 60 * 1000), activeTripTz);
  const [nextItemsRes, flightsRes, disruptionsRes] = await Promise.all([
    db.from('itinerary_items').select('title, start_time, timezone, category, location').eq('trip_id', activeTripId).gt('start_time', now).order('start_time', {
      ascending: true
    }).limit(1),
    db.from('reservations').select('confirmation_number, reservation_type, start_date, start_time, timezone, details').eq('trip_id', activeTripId).eq('reservation_type', 'flight').gte('start_date', dateFrom).lte('start_date', dateTo).order('start_date', {
      ascending: true
    }).order('start_time', {
      ascending: true
    }).limit(20),
    db.from('disruption_cases').select('id, severity, root_cause, time_to_act').eq('trip_id', activeTripId).eq('status', 'open').in('severity', [
      'critical',
      'warning'
    ]).order('created_at', {
      ascending: false
    }).limit(20)
  ]);
  if (nextItemsRes.error) console.error('[calm-ux] /glance: itinerary_items lookup failed:', nextItemsRes.error.message);
  if (flightsRes.error) console.error('[calm-ux] /glance: reservations lookup failed:', flightsRes.error.message);
  if (disruptionsRes.error) console.error('[calm-ux] /glance: disruption_cases lookup failed:', disruptionsRes.error.message);
  const nextItem = nextItemsRes.data?.[0] ?? null;
  let flight = null;
  for (const r of flightsRes.data ?? []){
    const tz = r.timezone || activeTripTz;
    const startLocal = `${r.start_date}T${normalizeTime(r.start_time)}`;
    if (startLocal >= localWallClock(nowDate, tz) && startLocal <= localWallClock(in24hDate, tz)) {
      flight = r;
      break;
    }
  }
  const severityRank = {
    critical: 0,
    warning: 1,
    info: 2
  };
  const disruption = (disruptionsRes.data ?? []).slice().sort((a, b)=>(severityRank[a.severity] ?? 9) - (severityRank[b.severity] ?? 9))[0] ?? null;
  const payload = {
    tripId: activeTripId,
    generatedAt: now
  };
  const unavailable = [];
  if (nextItemsRes.error) unavailable.push('next');
  if (flightsRes.error) unavailable.push('flight');
  if (disruptionsRes.error) unavailable.push('alert');
  if (unavailable.length) payload.unavailable = unavailable;
  if (nextItem) {
    payload.next = {
      title: nextItem.title,
      startsAtLocal: nextItem.start_time,
      tz: nextItem.timezone ?? activeTripTz,
      category: nextItem.category ?? 'general',
      placeName: nextItem.location ?? null
    };
  }
  if (flight) {
    const details = flight.details ?? {};
    payload.flight = {
      ident: flight.confirmation_number ?? details.ident ?? null,
      departsAtLocal: `${flight.start_date}T${normalizeTime(flight.start_time)}`,
      tz: flight.timezone ?? activeTripTz,
      boardingAtLocal: details.boarding_at ?? null,
      boardingEstimated: details.boarding_at != null ? details.boarding_estimated ?? null : null,
      gate: details.gate ?? null,
      seat: details.seat ?? null,
      status: details.status ?? null,
      delayMinutes: details.delay_minutes ?? null
    };
  }
  if (disruption) {
    const rootCause = disruption.root_cause ?? {};
    const flightIdent = typeof rootCause.flightIdent === 'string' ? rootCause.flightIdent : null;
    const reportedKind = typeof rootCause.kind === 'string' ? rootCause.kind.replace(/_/g, ' ') : null;
    const subject = flightIdent ?? (reportedKind ? `your ${reportedKind}` : 'your trip');
    payload.alert = {
      caseId: disruption.id,
      severity: disruption.severity,
      title: disruption.severity === 'critical' ? `Action needed: ${subject} disrupted` : `Heads up: ${subject} disrupted`,
      timeToAct: disruption.time_to_act ?? null
    };
  }
  return json(payload);
}
async function handleGetOutbox(db, userId) {
  const { data, error: dbErr } = await db.from('outbox_items').select('*').eq('user_id', userId).in('status', [
    'pending',
    'failed'
  ]).order('created_at', {
    ascending: true
  });
  if (dbErr) return err('DB_ERROR', dbErr.message, 500);
  return json({
    items: data ?? []
  });
}
async function handlePostOutbox(req, db, userId) {
  const body = await req.json();
  const { idempotencyKey, operation, payload } = body;
  if (!idempotencyKey || !operation || !payload) {
    return err('MISSING_FIELDS', 'idempotencyKey, operation, and payload are required');
  }
  const { data: existing, error: existingErr } = await db.from('outbox_items').select('*').eq('user_id', userId).eq('idempotency_key', idempotencyKey).maybeSingle();
  if (existingErr) {
    console.error('[calm-ux] /outbox idempotency lookup failed:', existingErr.message);
    return err('DB_ERROR', 'Could not check idempotency key', 500);
  }
  if (existing) return json({
    item: existing
  }, 200);
  const id = ulid('out_');
  const item = {
    id,
    user_id: userId,
    idempotency_key: idempotencyKey,
    operation,
    payload,
    status: 'pending',
    attempts: 0,
    last_error: null,
    created_at: new Date().toISOString(),
    processed_at: null
  };
  const { error: insertErr } = await db.from('outbox_items').insert(item);
  if (insertErr) return err('DB_ERROR', insertErr.message, 500);
  return json({
    item
  }, 201);
}
async function handlePatchOutbox(req, itemId, db, userId) {
  const body = await req.json();
  const { status, lastError } = body;
  const validStatuses = [
    'pending',
    'processing',
    'done',
    'failed'
  ];
  if (status && !validStatuses.includes(status)) {
    return err('INVALID_STATUS', `status must be one of: ${validStatuses.join(', ')}`);
  }
  const { data: existing, error: existingErr } = await db.from('outbox_items').select('id, user_id').eq('id', itemId).maybeSingle();
  if (existingErr) {
    console.error('[calm-ux] /outbox item lookup failed:', existingErr.message);
    return err('DB_ERROR', 'Could not read the outbox item', 500);
  }
  if (!existing) return err('NOT_FOUND', 'Outbox item not found', 404);
  if (existing.user_id !== userId) return err('FORBIDDEN', 'Not your outbox item', 403);
  const update = {};
  if (status) update.status = status;
  if (lastError !== undefined) update.last_error = lastError;
  if (status === 'done' || status === 'failed') update.processed_at = new Date().toISOString();
  const { error: updateErr } = await db.from('outbox_items').update(update).eq('id', itemId);
  if (updateErr) return err('DB_ERROR', updateErr.message, 500);
  return json({
    ok: true
  });
}
Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, apikey, x-client-info'
      }
    });
  }
  const db = makeDb(req);
  const user = await getUser(req);
  if (!user) return err('UNAUTHORIZED', 'Missing or invalid JWT', 401);
  const url = new URL(req.url);
  const rawPath = url.pathname.replace(/^\/[^/]+/, '') || '/';
  const method = req.method.toUpperCase();
  if (method === 'GET' && rawPath === '/alert-preferences') return handleGetAlertPreferences(req, db, user.id);
  if (method === 'PUT' && rawPath === '/alert-preferences') return handlePutAlertPreferences(req, db, user.id);
  if (method === 'GET' && rawPath === '/tips') return handleGetTips(db, user.id);
  if (method === 'PUT' && rawPath === '/tips') return handlePutTips(req, db, user.id);
  if (method === 'POST' && rawPath === '/place-reports') return handlePostPlaceReport(req, db, user.id);
  const placeReportMatch = rawPath.match(/^\/place-reports\/([^/]+)$/);
  if (method === 'GET' && placeReportMatch) return handleGetPlaceReports(decodeURIComponent(placeReportMatch[1]), db);
  if (method === 'POST' && rawPath === '/support/conversations') return handlePostSupportConversation(req, db, user.id);
  const grantAccessMatch = rawPath.match(/^\/support\/conversations\/([^/]+)\/grant-access$/);
  if (method === 'POST' && grantAccessMatch) return handleGrantTripAccess(req, grantAccessMatch[1], db, user.id);
  if (method === 'GET' && rawPath === '/glance') return handleGetGlance(db, user.id);
  if (method === 'GET' && rawPath === '/outbox') return handleGetOutbox(db, user.id);
  if (method === 'POST' && rawPath === '/outbox') return handlePostOutbox(req, db, user.id);
  const outboxPatchMatch = rawPath.match(/^\/outbox\/([^/]+)$/);
  if (method === 'PATCH' && outboxPatchMatch) return handlePatchOutbox(req, outboxPatchMatch[1], db, user.id);
  return err('NOT_FOUND', `No route: ${method} ${rawPath}`, 404);
});

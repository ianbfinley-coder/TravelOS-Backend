// ─────────────────────────────────────────────────────────────────────────────
// 2026-09-25 — wave 6b defect fixes (emergency-mode):
//  a. /me/emergency-info encoding. PUT wrote `Array.from(packed)` (a JSON array
//     of numbers) into the bytea `encrypted_data`, and GET did
//     `new Uint8Array(data.encrypted_data)` on what PostgREST actually returns
//     for bytea — hex TEXT like "\x0000000c…". `new Uint8Array(<string>)` is an
//     empty array, so every read was DECRYPT_ERROR. PUT now writes the packed
//     bytes as a Postgres hex bytea literal ('\x' + hex) and GET decodes that
//     hex text back to bytes (byteaToBytes also accepts a number[] defensively).
//     No schema change needed (the table had 0 rows).
//  b. The AES key fell back to SUPABASE_SERVICE_ROLE_KEY when
//     EMERGENCY_INFO_SECRET was unset — medical data encrypted under a key
//     shared with every other purpose. The fallback is removed: with no secret
//     the two emergency-info routes return 503 EMERGENCY_INFO_UNAVAILABLE;
//     every other route is unaffected.
//  c. Every `await req.json()` now goes through readJson(), so a malformed body
//     is a 400 INVALID_JSON instead of a 500.
//  d. /sos-card lodging lookup matched only type='accommodation'; the web app
//     writes 'lodging'. It now accepts 'accommodation', 'lodging' and 'hotel'.
// supabase-js import switched from jsr: to esm.sh (standing rule).
// ─────────────────────────────────────────────────────────────────────────────
// 2026-09-19 — SAFETY-CRITICAL fabrication sweep of handleGetSosCard, plus an
// error-handling audit of the rest of this file.
//
// `handleGetSosCard` asserted two facts about the world that it did not know,
// on paths a traveler reaches in an emergency.
//
// 1. NATIONALITY / EMBASSY. It read `profiles.nationality`. There is no
//    `nationality` column on `profiles` (verified against
//    information_schema.columns on 2026-09-19: profiles is id, email, name,
//    avatar_url, created_at, updated_at, phone, phone_verified, email_verified,
//    expo_push_token). PostgREST rejects the WHOLE query with 42703, so
//    `profile` was always null, the error was discarded, and
//    `profile?.nationality || 'US'` made EVERY user American. The SOS card then
//    showed that user the US embassy in the country they were in, whoever they
//    actually were. Nothing in this schema records a user's nationality —
//    `embassies.nationality` is the country an embassy REPRESENTS and
//    `entry_requirements.nationality` is a reference dimension; neither is
//    keyed to a user. So the embassy lookup is not guessable and is not
//    guessed: `embassy` is null with an explicit reason.
//
// 2. LOCAL EMERGENCY NUMBER. On an empty or failed `emergency_numbers` lookup
//    it substituted a literal `[{ label: 'Emergency', number: '112' }]`. 112 is
//    not the emergency number in much of the world (it is 911 in the US/Canada,
//    000 in Australia, 100/101/102 in India, 119 in Japan, 191/1669 in
//    Thailand...). The fabricated shape did not even match the table, which is
//    country_code/police/ambulance/fire/general — so any consumer reading
//    `.number` got the invented value and nothing else. Now: the query error is
//    captured and logged, an empty result returns `emergencyNumbers: []` and
//    says so, and no number is ever invented.
//
// A failed `emergency_numbers` lookup returns 200 with
// `emergencyNumbersStatus: 'unavailable'` and a loud note rather than failing
// the whole card, so a traveler still gets their lodging address and phrase
// cards; the distinction between "lookup failed" and "nothing on file" is
// explicit in the payload and in the logs, and neither invents a number.
//
// Also in this pass, to the standing rules: every `if (error || !row) return
// 404` was split so a failed query is a 500 that says so and only an absent row
// is a 404, and previously-discarded `error` bindings are captured and logged.
// The public token-gated route GET /share/location/:token is behaviourally
// unchanged for every valid token.
//
// verify_jwt stays FALSE — gating is in code (requireAuth / the service-key
// check in handleScan / the share token).
// ─────────────────────────────────────────────────────────────────────────────
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const APP_BASE_URL = 'https://travelos.app';
// ── Crypto helpers ──────────────────────────────────────────────────
function randomHex(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map((b)=>b.toString(16).padStart(2, '0')).join('');
}
function generateId(prefix) {
  const ts = Date.now().toString(36).toUpperCase().padStart(10, '0');
  const rand = randomHex(10).toUpperCase();
  return `${prefix}${ts}${rand}`;
}
/** Length-independent constant-time compare, for secret material. */ function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for(let i = 0; i < len; i++)diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}
async function deriveKey(masterSecret, userId) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(masterSecret), {
    name: 'HKDF'
  }, false, [
    'deriveKey'
  ]);
  return crypto.subtle.deriveKey({
    name: 'HKDF',
    hash: 'SHA-256',
    salt: enc.encode(userId),
    info: enc.encode('emergency-info-v1')
  }, keyMaterial, {
    name: 'AES-GCM',
    length: 256
  }, false, [
    'encrypt',
    'decrypt'
  ]);
}
async function encryptData(data, masterSecret, userId) {
  const key = await deriveKey(masterSecret, userId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt({
    name: 'AES-GCM',
    iv
  }, key, enc.encode(JSON.stringify(data)));
  return {
    ciphertext: new Uint8Array(ciphertext),
    iv
  };
}
async function decryptData(ciphertext, iv, masterSecret, userId) {
  const key = await deriveKey(masterSecret, userId);
  const plaintext = await crypto.subtle.decrypt({
    name: 'AES-GCM',
    iv
  }, key, ciphertext);
  return JSON.parse(new TextDecoder().decode(plaintext));
}
function packEncrypted(iv, ciphertext) {
  const buf = new Uint8Array(4 + iv.length + ciphertext.length);
  const view = new DataView(buf.buffer);
  view.setUint32(0, iv.length, false);
  buf.set(iv, 4);
  buf.set(ciphertext, 4 + iv.length);
  return buf;
}
function unpackEncrypted(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const ivLen = view.getUint32(0, false);
  const iv = buf.slice(4, 4 + ivLen);
  const ciphertext = buf.slice(4 + ivLen);
  return {
    iv,
    ciphertext
  };
}
// 2026-09-25: bytea <-> bytes over PostgREST. PostgREST returns bytea as hex
// text ("\\x…") and accepts the same form on write.
function bytesToByteaHex(buf) {
  return '\\x' + Array.from(buf).map((b)=>b.toString(16).padStart(2, '0')).join('');
}
function byteaToBytes(value) {
  if (typeof value === 'string') {
    const hex = value.startsWith('\\x') ? value.slice(2) : value;
    if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new Error('encrypted_data is not hex bytea');
    const out = new Uint8Array(hex.length / 2);
    for(let i = 0; i < out.length; i++)out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }
  if (Array.isArray(value)) return new Uint8Array(value);
  throw new Error('encrypted_data has an unexpected shape');
}
// 2026-09-25: the emergency-info master secret. No fallback — see header (b).
function emergencyInfoSecret() {
  const s = Deno.env.get('EMERGENCY_INFO_SECRET');
  return s && s.length > 0 ? s : null;
}
// 2026-09-25: malformed JSON is a client error, not a 500.
class BadJsonError extends Error {
}
async function readJson(req) {
  let body;
  try {
    body = await req.json();
  } catch  {
    throw new BadJsonError('Request body is not valid JSON');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new BadJsonError('Body must be a JSON object');
  return body;
}
// ── Haversine distance (metres) ──────────────────────────────────────
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d)=>d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
// ── Service client ─────────────────────────────────────────────────
function svc() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
}
/**
 * Bridges Supabase auth to the platform identity space.
 *
 * TravelOS runs two parallel id systems: Supabase uuids (auth.uid(), profiles,
 * trips) and platform text ids (platform_users, platform_trips, trip_members).
 * `auth_identities.provider_subject` holds auth.uid() as text and maps to
 * platform_users.id — this mirrors what the deployed `platform-auth` function
 * writes. Matching is on provider_subject ALONE: the `provider` column varies by
 * sign-in method (email / google / apple / email_link), so filtering on a fixed
 * provider string would match nothing.
 *
 * 2026-09-19: the query error was discarded, so a failed bridge lookup was
 * indistinguishable from "this user has no bridge row" — and callers turn a
 * null into a 404 NOT_A_MEMBER. The error is now logged; the null return is
 * kept so callers stay fail-closed, but the cause is no longer invisible.
 */ async function resolvePlatformUserId(service, authUserId) {
  const { data, error } = await service.from('auth_identities').select('user_id').eq('provider_subject', authUserId).maybeSingle();
  if (error) {
    console.error(`[emergency-mode] resolvePlatformUserId: auth_identities lookup FAILED for auth user ` + `${authUserId} — treating as unresolved (fail-closed):`, error);
    return null;
  }
  return data?.user_id ?? null;
}
/**
 * Most recent location point belonging to this user.
 *
 * SECURITY 2026-09-16: callers previously queried location_points with NO filter
 * at all — `select(...).order('at', desc).limit(1)` — which is literally "the
 * newest row in the table". RLS on location_points happened to clamp it to the
 * caller's own rows, so it did not leak, but the query was only correct by
 * accident: the day someone swaps that client for service_role it becomes a
 * cross-user location disclosure inside a notification payload. Scoped
 * explicitly to the user's own shares so it is correct on its own terms.
 *
 * 2026-09-19: both query errors were discarded, so a failed lookup looked
 * exactly like "this traveler has never shared a location" — and this value is
 * attached to SOS and roll-call-help notifications. Errors are now logged.
 */ async function latestLocationForUser(client, userId) {
  const { data: shares, error: sharesErr } = await client.from('location_shares').select('id').eq('user_id', userId);
  if (sharesErr) {
    console.error(`[emergency-mode] latestLocationForUser: location_shares lookup FAILED for user ${userId} — ` + `no last-known location will be attached:`, sharesErr);
    return null;
  }
  const shareIds = (shares ?? []).map((s)=>s.id);
  if (!shareIds.length) return null;
  const { data: points, error: pointsErr } = await client.from('location_points').select('lat, lng, at').in('share_id', shareIds).order('at', {
    ascending: false
  }).limit(1);
  if (pointsErr) {
    console.error(`[emergency-mode] latestLocationForUser: location_points lookup FAILED for user ${userId} — ` + `no last-known location will be attached:`, pointsErr);
    return null;
  }
  return points?.[0] ?? null;
}
// ── Notification helper ─────────────────────────────────────────────
const NOTIFICATION_DELIVERY_URL = `${SUPABASE_URL}/functions/v1/notification-delivery`;
/**
 * Fans a notification out through notification-delivery's `send_direct` action.
 *
 * 2026-09-18 — this helper previously posted `{ userId | userIds, title, body }`
 * with NO `action` field. notification-delivery dispatches on `body.action`, so
 * every call this function has ever made returned 400 "Missing action" and was
 * discarded behind the catch below. Check-in reminders, overdue escalation, the
 * SOS `POST /checkins/:id/help` path and roll-call notifications have therefore
 * never reached anyone; runtime logs show zero 2xx responses from
 * notification-delivery, ever.
 *
 * Three things changed.
 *
 * 1. The wire shape. `action: 'send_direct'` is mandatory, the recipient list is
 *    `recipients` (not `userId`/`userIds`), and the text field is `message`
 *    (NOT `body` — that was the previous field name and would be dropped).
 *
 * 2. `id_space` is mandatory and deliberately has no default, because the call
 *    sites in this file genuinely hold ids from two different spaces:
 *    `trip_members.user_id` is a platform text id (`usr_...`, FK to
 *    platform_users.id) while `checkins.user_id` and `trips.user_id` hold
 *    Supabase auth uuids. Nothing is normalised here — the caller declares what
 *    it is actually holding, because only the caller knows.
 *
 * 3. Delivery goes over fetch with the service-role key rather than
 *    `supabase.functions.invoke`. send_direct only permits a *user* caller to
 *    notify themselves, so a user-scoped client cannot page a traveler's
 *    escalation contacts or a trip's members — it would get 403. `invoke` also
 *    hides the HTTP status, which is precisely what kept this defect invisible.
 *
 * Failures are still swallowed — a notification must never break an emergency
 * operation — but they are no longer SILENT. Every outcome is logged, a non-2xx
 * is logged at error level with status and body, and unresolved recipients are
 * named. `auth_identities` currently holds a single bridge row on this project,
 * so `resolved: 0` is a likely real outcome today: that is a data gap, not a
 * code bug, and it is now visible instead of invented away.
 *
 * `supabase` is retained in the signature so every call site keeps its existing
 * shape and so the client that owns the surrounding operation stays visible at
 * the call site; delivery itself no longer routes through it (see 3).
 */ async function sendNotification(supabase, payload) {
  const label = `${payload.data?.type ?? 'notification'}/${payload.idSpace}`;
  const recipients = (payload.recipients ?? []).filter((r)=>typeof r === 'string' && r.length > 0);
  if (recipients.length === 0) {
    console.warn(`[emergency-mode] ${label}: no recipients — nothing sent`);
    return null;
  }
  try {
    const res = await fetch(NOTIFICATION_DELIVERY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
      },
      body: JSON.stringify({
        action: 'send_direct',
        recipients,
        id_space: payload.idSpace,
        title: payload.title,
        message: payload.message,
        data: payload.data ?? {},
        ...payload.tripId ? {
          tripId: payload.tripId
        } : {}
      })
    });
    const raw = await res.text();
    if (!res.ok) {
      console.error(`[emergency-mode] ${label}: notification-delivery HTTP ${res.status} — ` + `${recipients.length} recipient(s) NOT notified. Body: ${raw}`);
      return null;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch  {
      console.error(`[emergency-mode] ${label}: unparseable notification-delivery response: ${raw}`);
      return null;
    }
    if (!parsed.success || !parsed.data) {
      console.error(`[emergency-mode] ${label}: notification-delivery reported failure: ${parsed.error ?? raw}`);
      return null;
    }
    const result = parsed.data;
    const unresolved = result.unresolved ?? [];
    console.log(`[emergency-mode] ${label}: requested=${result.requested} resolved=${result.resolved} ` + `delivered_inapp=${result.delivered_inapp} delivered_push=${result.delivered_push} ` + `unresolved=${unresolved.length}`);
    if (unresolved.length > 0) {
      console.warn(`[emergency-mode] ${label}: ${unresolved.length} recipient(s) could not be resolved to a ` + `delivery identity and were NOT notified: ${JSON.stringify(unresolved)}`);
    }
    return result;
  } catch (e) {
    console.error(`[emergency-mode] ${label}: notification-delivery unavailable:`, e);
    return null;
  }
}
/**
 * `checkins.escalation_contact_ids` is `text[]` with no foreign key, no
 * referencing table anywhere in this schema (there is no contacts table of any
 * kind), and zero rows on this project. Its only writer is the client-supplied
 * `escalationContactIds` in `POST /checkins`, which is stored unvalidated. Its
 * intended id space therefore could NOT be established, and nothing here
 * assumes one.
 *
 * Instead each id is classified by its own verifiable form, which is decidable
 * per id even though the column's intent is not: platform ids are
 * `usr_<hex>` text (platform_users.id) and auth ids are uuids — disjoint sets.
 * Anything matching neither is unroutable and is logged at error level rather
 * than sent into a space it does not belong to. No id is ever converted between
 * spaces here.
 */ const AUTH_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function splitByIdSpace(ids) {
  const platform = [];
  const auth = [];
  const unroutable = [];
  for (const id of Array.isArray(ids) ? ids : []){
    if (typeof id !== 'string' || id.length === 0) continue;
    if (id.startsWith('usr_')) platform.push(id);
    else if (AUTH_UUID_RE.test(id)) auth.push(id);
    else unroutable.push(id);
  }
  return {
    platform,
    auth,
    unroutable
  };
}
/**
 * Sends one escalation notification to a `escalation_contact_ids` list, one
 * send per id space actually present. Returns the total `delivered_inapp` so
 * the caller can be loud about a safety notification that reached nobody.
 */ async function notifyEscalationContacts(client, contactIds, payload, logContext) {
  const { platform, auth, unroutable } = splitByIdSpace(contactIds);
  if (unroutable.length > 0) {
    console.error(`[emergency-mode] ${logContext}: ${unroutable.length} escalation contact id(s) belong to ` + `neither the platform (usr_) nor the auth (uuid) id space and cannot be routed: ` + `${JSON.stringify(unroutable)}`);
  }
  let deliveredInapp = 0;
  for (const [idSpace, recipients] of [
    [
      'platform',
      platform
    ],
    [
      'auth',
      auth
    ]
  ]){
    if (recipients.length === 0) continue;
    const result = await sendNotification(client, {
      recipients: [
        ...recipients
      ],
      idSpace,
      title: payload.title,
      message: payload.message,
      data: payload.data,
      tripId: payload.tripId
    });
    deliveredInapp += result?.delivered_inapp ?? 0;
  }
  return deliveredInapp;
}
// ── Auth helper ────────────────────────────────────────────────────
async function requireAuth(req) {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return jsonError('UNAUTHORIZED', 'Missing or invalid Authorization header', 401);
  }
  const token = authHeader.slice(7);
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: {
      headers: {
        Authorization: `Bearer ${token}`
      }
    }
  });
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return jsonError('UNAUTHORIZED', 'Invalid token', 401);
  return {
    userId: user.id,
    supabase
  };
}
// ── Response helpers ───────────────────────────────────────────────
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders
    }
  });
}
function jsonError(code, message, status = 400) {
  return new Response(JSON.stringify({
    error: {
      code,
      message
    }
  }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders
    }
  });
}
// ── Phrase cards by country ───────────────────────────────────────────
const PHRASE_CARDS = {
  FR: [
    {
      phrase: 'Au secours!',
      translation: 'Help!',
      phonetic: 'oh suh-KOOR'
    },
    {
      phrase: "J'ai besoin d'un médecin",
      translation: 'I need a doctor',
      phonetic: 'zhay buh-ZWAN dun may-duh-SAN'
    },
    {
      phrase: 'Appelez la police',
      translation: 'Call the police',
      phonetic: 'ah-puh-LAY lah poh-LEES'
    }
  ],
  ES: [
    {
      phrase: '¡Ayuda!',
      translation: 'Help!',
      phonetic: 'ah-YOO-dah'
    },
    {
      phrase: 'Necesito un médico',
      translation: 'I need a doctor',
      phonetic: 'neh-seh-SEE-toh oon MEH-dee-koh'
    },
    {
      phrase: 'Llame a la policía',
      translation: 'Call the police',
      phonetic: 'YAH-meh ah lah poh-lee-SEE-ah'
    }
  ],
  IT: [
    {
      phrase: 'Aiuto!',
      translation: 'Help!',
      phonetic: 'ah-YOO-toh'
    },
    {
      phrase: 'Ho bisogno di un medico',
      translation: 'I need a doctor',
      phonetic: 'oh bee-ZON-yoh dee oon MEH-dee-koh'
    },
    {
      phrase: 'Chiami la polizia',
      translation: 'Call the police',
      phonetic: 'KYAH-mee lah poh-LEE-tsyah'
    }
  ],
  JP: [
    {
      phrase: '助けて！',
      translation: 'Help!',
      phonetic: 'tah-soo-KEH-teh'
    },
    {
      phrase: '医者が必要です',
      translation: 'I need a doctor',
      phonetic: 'ee-sha ga hee-tsoo-YOH des'
    },
    {
      phrase: '警察を呼んでください',
      translation: 'Call the police',
      phonetic: 'keh-sah-tsu oh yon-deh koo-dah-SAI'
    }
  ],
  TH: [
    {
      phrase: 'ช่วยด้วย!',
      translation: 'Help!',
      phonetic: 'chuay duay'
    },
    {
      phrase: 'ฉันต้องการหมอ',
      translation: 'I need a doctor',
      phonetic: 'chan dtong gaan mor'
    },
    {
      phrase: 'โทรเรียกตำรวจ',
      translation: 'Call the police',
      phonetic: 'toh riak dtam-ruat'
    }
  ],
  DE: [
    {
      phrase: 'Hilfe!',
      translation: 'Help!',
      phonetic: 'HIL-feh'
    },
    {
      phrase: 'Ich brauche einen Arzt',
      translation: 'I need a doctor',
      phonetic: 'ikh BROW-kheh EYE-nen artst'
    },
    {
      phrase: 'Rufen Sie die Polizei',
      translation: 'Call the police',
      phonetic: 'ROO-fen zee dee poh-lee-TSAI'
    }
  ],
  PT: [
    {
      phrase: 'Socorro!',
      translation: 'Help!',
      phonetic: 'soh-KOH-roh'
    },
    {
      phrase: 'Preciso de um médico',
      translation: 'I need a doctor',
      phonetic: 'preh-SEE-zoo deh oom MEH-dee-koo'
    },
    {
      phrase: 'Chame a polícia',
      translation: 'Call the police',
      phonetic: 'SHA-meh ah poh-LEE-syah'
    }
  ]
};
// ── Checkin escalation ─────────────────────────────────────────────
async function processCheckinEscalation(serviceSupabase, checkinId) {
  const { data: checkin, error } = await serviceSupabase.from('checkins').select('*').eq('id', checkinId).single();
  // 2026-09-19: this was `if (error || !checkin) return;` — a failed read of a
  // PENDING check-in silently aborted its escalation, which is the exact path
  // that pages someone when a traveler has gone quiet. Still returns (there is
  // nothing safe to do without the row) but no longer silently.
  if (error) {
    console.error(`[emergency-mode] SAFETY: processCheckinEscalation ${checkinId}: checkins read FAILED — ` + `escalation for this check-in did NOT run:`, error);
    return;
  }
  if (!checkin) {
    console.warn(`[emergency-mode] processCheckinEscalation ${checkinId}: check-in no longer exists`);
    return;
  }
  if (checkin.status !== 'pending') return;
  const now = new Date();
  const dueAt = new Date(checkin.due_at);
  const graceMs = checkin.grace_minutes * 60000;
  if (!checkin.first_prompt_sent_at && now >= dueAt) {
    // checkins.user_id is TEXT, but its only writer is handleCreateCheckin,
    // which stores requireAuth's user.id — an auth uuid. id space: 'auth'.
    await sendNotification(serviceSupabase, {
      recipients: [
        checkin.user_id
      ],
      idSpace: 'auth',
      title: 'Check-in reminder',
      message: checkin.context ? `Check-in: ${checkin.context}` : 'Please confirm you are safe.',
      data: {
        checkinId,
        prompt: 1,
        type: 'checkin_prompt',
        priority: 'MEDIUM'
      },
      tripId: checkin.trip_id || undefined
    });
    await serviceSupabase.from('checkins').update({
      first_prompt_sent_at: now.toISOString()
    }).eq('id', checkinId);
  } else if (checkin.first_prompt_sent_at && !checkin.second_prompt_sent_at) {
    const firstSent = new Date(checkin.first_prompt_sent_at);
    if (now >= new Date(firstSent.getTime() + graceMs)) {
      // Still the traveler themselves, not an escalation contact: id space 'auth'.
      await sendNotification(serviceSupabase, {
        recipients: [
          checkin.user_id
        ],
        idSpace: 'auth',
        title: '⚠️ Check-in overdue',
        message: 'You missed your check-in. Please respond now.',
        data: {
          checkinId,
          prompt: 2,
          type: 'checkin_prompt',
          urgent: true,
          priority: 'HIGH'
        },
        tripId: checkin.trip_id || undefined
      });
      await serviceSupabase.from('checkins').update({
        second_prompt_sent_at: now.toISOString()
      }).eq('id', checkinId);
    }
  } else if (checkin.second_prompt_sent_at && checkin.status === 'pending') {
    const secondSent = new Date(checkin.second_prompt_sent_at);
    if (now >= new Date(secondSent.getTime() + graceMs)) {
      if (checkin.escalation_contact_ids?.length > 0) {
        const deliveredInapp = await notifyEscalationContacts(serviceSupabase, checkin.escalation_contact_ids, {
          title: '🚨 Emergency escalation',
          message: `A traveler has missed their check-in${checkin.context ? `: ${checkin.context}` : ''}. Please check on them.`,
          data: {
            checkinId,
            type: 'checkin_escalation',
            userId: checkin.user_id,
            priority: 'CRITICAL'
          },
          tripId: checkin.trip_id || undefined
        }, `checkin_escalation ${checkinId}`);
        if (deliveredInapp === 0) {
          console.error(`[emergency-mode] SAFETY: checkin_escalation ${checkinId} delivered_inapp=0 — this ` + `overdue-check-in escalation reached NOBODY ` + `(${checkin.escalation_contact_ids.length} escalation contact(s) requested). ` + `The check-in is being marked escalated regardless.`);
        }
      } else {
        console.error(`[emergency-mode] SAFETY: checkin_escalation ${checkinId} has NO escalation contacts — ` + `the check-in is being marked escalated with nobody notified.`);
      }
      await serviceSupabase.from('checkins').update({
        status: 'escalated',
        escalated_at: now.toISOString()
      }).eq('id', checkinId);
    }
  }
}
// ── Route handlers ────────────────────────────────────────────────
/**
 * GET /sos-card?country=XX[&tripId=...]
 *
 * See the dated block at the top of this file. Nothing on this card is invented:
 * every field is either read from the database or explicitly reported as not
 * known, because each one of them is something a person may act on while in
 * trouble in a country they do not know.
 */ async function handleGetSosCard(req, url) {
  const authResult = await requireAuth(req);
  if (authResult instanceof Response) return authResult;
  const { supabase } = authResult;
  const country = url.searchParams.get('country')?.toUpperCase();
  const tripId = url.searchParams.get('tripId');
  if (!country) return jsonError('MISSING_PARAM', 'country is required');
  const notes = [];
  // ── Emergency numbers ────────────────────────────────────────────
  //
  // emergency_numbers columns, verified against information_schema.columns on
  // 2026-09-19: country_code, police, ambulance, fire, general, source_url,
  // reviewed_at. There is no `label` and no `number` column — the old fallback
  // row `{ label: 'Emergency', number: '112' }` matched nothing in this table
  // and was pure invention. 112 is simply wrong across much of the world.
  const { data: emergencyRows, error: emergencyErr } = await supabase.from('emergency_numbers').select('country_code, police, ambulance, fire, general, source_url, reviewed_at').eq('country_code', country).limit(10);
  let emergencyNumbers = [];
  let emergencyNumbersStatus = 'none_on_file';
  if (emergencyErr) {
    console.error(`[emergency-mode] SAFETY: sos-card: emergency_numbers lookup FAILED for country ${country} — ` + `returning NO numbers rather than a guess:`, emergencyErr);
    emergencyNumbersStatus = 'lookup_failed';
    notes.push(`Emergency numbers for ${country} could not be looked up (the lookup failed). ` + `None are shown, because guessing one could send you to the wrong place.`);
  } else if (!emergencyRows || emergencyRows.length === 0) {
    emergencyNumbersStatus = 'none_on_file';
    notes.push(`No verified emergency numbers on file for ${country}.`);
  } else {
    emergencyNumbers = emergencyRows;
    emergencyNumbersStatus = 'ok';
  }
  // ── Lodging ──────────────────────────────────────────────────────
  let lodging = null;
  if (tripId) {
    const { data: reservations, error: lodgingErr } = await supabase.from('itinerary_items').select('title, location, notes').eq('trip_id', tripId).in('type', [
      'accommodation',
      'lodging',
      'hotel'
    ]) // 2026-09-25: web writes 'lodging'
    .limit(1);
    if (lodgingErr) {
      console.error(`[emergency-mode] sos-card: itinerary_items lodging lookup FAILED for trip ${tripId}:`, lodgingErr);
      notes.push('Your lodging could not be looked up (the lookup failed).');
    } else if (reservations?.length) {
      lodging = {
        name: reservations[0].title,
        address: reservations[0].location || reservations[0].notes || ''
      };
    }
  }
  // ── Embassy ──────────────────────────────────────────────────────
  //
  // This USED to be: read profiles.nationality (a column that does not exist →
  // 42703 → the whole query rejected → error discarded), default it to 'US',
  // and then look up `embassies` for that nationality. Result: every traveler,
  // of every citizenship, was shown the UNITED STATES embassy — an embassy that
  // has no obligation to them and may be in a different city from the one that
  // does.
  //
  // Nothing in this schema records a user's nationality. Verified 2026-09-19:
  // the only `nationality` columns in the database are embassies.nationality
  // (the country an embassy REPRESENTS) and entry_requirements.nationality (a
  // reference-table dimension). Neither is keyed to a user, and `profiles` has
  // no such field. The embassy is therefore NOT determinable and is NOT
  // guessed.
  const embassy = null;
  const embassyStatus = 'nationality_not_recorded';
  notes.push('Nationality is not recorded for this account, so no embassy could be identified. ' + 'Look up your own country\'s embassy or consulate in ' + country + ' directly.');
  const phraseCards = PHRASE_CARDS[country] || [];
  const insuranceInfo = null;
  return json({
    emergencyNumbers,
    emergencyNumbersStatus,
    lodging,
    embassy,
    embassyStatus,
    phraseCards,
    insuranceInfo,
    notes
  });
}
async function handleCreateLocationShare(req) {
  const authResult = await requireAuth(req);
  if (authResult instanceof Response) return authResult;
  const { userId, supabase } = authResult;
  const body = await readJson(req);
  const { tripId, mode, endsAt, destination, audienceMemberIds = [], audienceContactIds = [] } = body;
  if (!mode || ![
    'duration',
    'until_arrival',
    'until_time'
  ].includes(mode)) {
    return jsonError('INVALID_MODE', 'mode must be duration, until_arrival, or until_time');
  }
  const id = generateId('lsh_');
  const linkToken = randomHex(16);
  const { data, error } = await supabase.from('location_shares').insert({
    id,
    trip_id: tripId || null,
    user_id: userId,
    audience: {
      memberIds: audienceMemberIds,
      contactIds: audienceContactIds
    },
    mode,
    ends_at: endsAt || null,
    destination: destination || null,
    link_token: linkToken,
    status: 'active'
  }).select().single();
  if (error) return jsonError('DB_ERROR', error.message, 500);
  return json({
    ...data,
    publicLink: `${APP_BASE_URL}/share/location/${linkToken}`
  }, 201);
}
async function handleAddLocationPoint(req, shareId) {
  const authResult = await requireAuth(req);
  if (authResult instanceof Response) return authResult;
  const { userId, supabase } = authResult;
  const body = await readJson(req);
  const { lat, lng, accuracyM, batteryPct } = body;
  if (lat == null || lng == null) return jsonError('MISSING_PARAM', 'lat and lng are required');
  const { data: share, error: shareErr } = await supabase.from('location_shares').select('*').eq('id', shareId).eq('user_id', userId).maybeSingle();
  // 2026-09-19: was `if (shareErr || !share) return 404`. A database failure
  // reported as "Share not found" tells a traveler whose phone is posting
  // location that their share has gone away when it has not.
  if (shareErr) {
    console.error(`[emergency-mode] add_location_point: location_shares read FAILED for share ${shareId}:`, shareErr);
    return jsonError('DB_ERROR', shareErr.message, 500);
  }
  if (!share) return jsonError('NOT_FOUND', 'Share not found', 404);
  if (share.status !== 'active') return jsonError('SHARE_ENDED', 'Location share is no longer active', 409);
  const now = new Date().toISOString();
  const { error: insertErr } = await supabase.from('location_points').insert({
    share_id: shareId,
    at: now,
    lat,
    lng,
    accuracy_m: accuracyM ?? null,
    battery_pct: batteryPct ?? null
  });
  if (insertErr) return jsonError('DB_ERROR', insertErr.message, 500);
  let autoStopped = false;
  if (share.mode === 'until_arrival' && share.destination) {
    const dest = share.destination;
    const dist = haversine(lat, lng, dest.lat, dest.lng);
    if (dist < 150) {
      await supabase.from('location_shares').update({
        status: 'ended',
        ends_at: now
      }).eq('id', shareId);
      autoStopped = true;
    }
  }
  if (share.mode === 'until_time' && share.ends_at && new Date() >= new Date(share.ends_at)) {
    await supabase.from('location_shares').update({
      status: 'expired'
    }).eq('id', shareId);
    autoStopped = true;
  }
  return json({
    ok: true,
    autoStopped
  });
}
async function handleStopLocationShare(req, shareId) {
  const authResult = await requireAuth(req);
  if (authResult instanceof Response) return authResult;
  const { userId, supabase } = authResult;
  const { data: share, error: shareErr } = await supabase.from('location_shares').select('id, user_id').eq('id', shareId).eq('user_id', userId).maybeSingle();
  // 2026-09-19: the error was discarded and a failed read became "Share not
  // found" — i.e. a traveler trying to STOP broadcasting their location would
  // be told there was nothing to stop while the share stayed active.
  if (shareErr) {
    console.error(`[emergency-mode] stop_location_share: location_shares read FAILED for share ${shareId}:`, shareErr);
    return jsonError('DB_ERROR', shareErr.message, 500);
  }
  if (!share) return jsonError('NOT_FOUND', 'Share not found', 404);
  const now = new Date().toISOString();
  const { error: updateErr } = await supabase.from('location_shares').update({
    status: 'ended',
    ends_at: now
  }).eq('id', shareId);
  if (updateErr) {
    console.error(`[emergency-mode] stop_location_share: update FAILED for share ${shareId}:`, updateErr);
    return jsonError('DB_ERROR', updateErr.message, 500);
  }
  return json({
    ok: true,
    endsAt: now
  });
}
/**
 * PUBLIC, token-gated: GET /share/location/:token
 *
 * Unchanged for every valid token. 2026-09-19 only split the failure paths
 * apart: a failed `location_shares` read used to be reported as "Share not
 * found or expired" (404), telling whoever is watching a traveler's live
 * location that the share is gone when the database had merely errored.
 */ async function handleGetPublicShare(token) {
  const serviceSupabase = svc();
  const { data: share, error } = await serviceSupabase.from('location_shares').select('id, status, ends_at, user_id').eq('link_token', token).maybeSingle();
  if (error) {
    console.error('[emergency-mode] public_share: location_shares read FAILED:', error);
    return jsonError('DB_ERROR', 'Could not load this location share', 500);
  }
  if (!share) return jsonError('NOT_FOUND', 'Share not found or expired', 404);
  if (share.status === 'expired') return jsonError('EXPIRED', 'This location share has expired', 410);
  const { data: points, error: pointsErr } = await serviceSupabase.from('location_points').select('lat, lng, at, battery_pct').eq('share_id', share.id).order('at', {
    ascending: false
  }).limit(1);
  if (pointsErr) {
    console.error(`[emergency-mode] public_share: location_points read FAILED for share ${share.id}:`, pointsErr);
  }
  const lastPoint = points?.[0] || null;
  const { data: userData } = await serviceSupabase.auth.admin.getUserById(share.user_id);
  const sharerFirstName = userData?.user?.user_metadata?.full_name?.split(' ')[0] || userData?.user?.email?.split('@')[0] || 'Traveler';
  return json({
    shareId: share.id,
    lastPoint,
    status: share.status,
    endsAt: share.ends_at,
    sharerFirstName
  });
}
async function handleCreateCheckin(req) {
  const authResult = await requireAuth(req);
  if (authResult instanceof Response) return authResult;
  const { userId, supabase } = authResult;
  const body = await readJson(req);
  const { tripId, dueAt, graceMinutes = 10, context, escalationContactIds = [], shareLocation = false } = body;
  if (!dueAt) return jsonError('MISSING_PARAM', 'dueAt is required');
  const id = generateId('chk_');
  const { data, error } = await supabase.from('checkins').insert({
    id,
    trip_id: tripId || null,
    user_id: userId,
    due_at: dueAt,
    grace_minutes: graceMinutes,
    context: context || null,
    escalation_contact_ids: escalationContactIds,
    share_location: shareLocation,
    status: 'pending'
  }).select().single();
  if (error) return jsonError('DB_ERROR', error.message, 500);
  // `userId` is requireAuth's user.id — an auth uuid. id space: 'auth'.
  await sendNotification(supabase, {
    recipients: [
      userId
    ],
    idSpace: 'auth',
    title: 'Check-in scheduled',
    message: context ? `Check-in set: ${context}` : `Check-in set for ${new Date(dueAt).toLocaleTimeString()}`,
    data: {
      checkinId: id,
      type: 'checkin_scheduled',
      dueAt,
      priority: 'LOW'
    },
    tripId: tripId || undefined
  });
  return json(data, 201);
}
async function handleCheckinOk(req, checkinId) {
  const authResult = await requireAuth(req);
  if (authResult instanceof Response) return authResult;
  const { userId, supabase } = authResult;
  const { data: checkin, error: checkinErr } = await supabase.from('checkins').select('id, user_id, status').eq('id', checkinId).eq('user_id', userId).maybeSingle();
  // 2026-09-19: error discarded → a failed read told a traveler their check-in
  // did not exist, and the check-in stayed pending and escalated later.
  if (checkinErr) {
    console.error(`[emergency-mode] checkin_ok: checkins read FAILED for ${checkinId}:`, checkinErr);
    return jsonError('DB_ERROR', checkinErr.message, 500);
  }
  if (!checkin) return jsonError('NOT_FOUND', 'Check-in not found', 404);
  if ([
    'ok',
    'cancelled'
  ].includes(checkin.status)) {
    return jsonError('ALREADY_RESOLVED', 'Check-in already resolved', 409);
  }
  const { error: updateErr } = await supabase.from('checkins').update({
    status: 'ok',
    responded_at: new Date().toISOString()
  }).eq('id', checkinId);
  if (updateErr) {
    console.error(`[emergency-mode] SAFETY: checkin_ok: FAILED to mark ${checkinId} ok — the traveler said they ` + `are safe but the check-in is still pending and will escalate:`, updateErr);
    return jsonError('DB_ERROR', updateErr.message, 500);
  }
  return json({
    ok: true
  });
}
async function handleCheckinHelp(req, checkinId) {
  const authResult = await requireAuth(req);
  if (authResult instanceof Response) return authResult;
  const { userId, supabase } = authResult;
  const { data: checkin, error: checkinErr } = await supabase.from('checkins').select('*').eq('id', checkinId).eq('user_id', userId).maybeSingle();
  // 2026-09-19: error discarded. This is the SOS path — a database failure was
  // being reported to someone asking for help as "Check-in not found".
  if (checkinErr) {
    console.error(`[emergency-mode] SAFETY: checkin_help: checkins read FAILED for ${checkinId} — the SOS path ` + `could not run:`, checkinErr);
    return jsonError('DB_ERROR', checkinErr.message, 500);
  }
  if (!checkin) return jsonError('NOT_FOUND', 'Check-in not found', 404);
  await supabase.from('checkins').update({
    status: 'help'
  }).eq('id', checkinId);
  // SECURITY 2026-09-16: was an unfiltered "newest row in location_points".
  let lastLocation = null;
  if (checkin.share_location) {
    lastLocation = await latestLocationForUser(supabase, userId);
  }
  // THE SOS PATH. escalation_contact_ids has no determinable id space (see
  // splitByIdSpace), so each id is routed by its own verifiable form rather
  // than by an assumed one. Nothing is converted between spaces.
  const deliveredInapp = await notifyEscalationContacts(supabase, checkin.escalation_contact_ids || [], {
    title: '🚨 Help requested',
    message: `A traveler needs help${checkin.context ? `: ${checkin.context}` : ''}`,
    data: {
      checkinId,
      type: 'checkin_help',
      userId,
      lastLocation,
      priority: 'CRITICAL'
    },
    tripId: checkin.trip_id || undefined
  }, `checkin_help ${checkinId}`);
  if (deliveredInapp === 0) {
    console.error(`[emergency-mode] SAFETY: SOS checkin_help ${checkinId} delivered_inapp=0 — this help ` + `request reached NOBODY ` + `(${(checkin.escalation_contact_ids || []).length} escalation contact(s) requested). ` + `The caller is still being returned their SOS card.`);
  }
  const sosCardUrl = checkin.trip_id ? `/sos-card?tripId=${checkin.trip_id}` : '/sos-card';
  return json({
    ok: true,
    sosCardUrl,
    lastLocation,
    notifiedContacts: deliveredInapp
  });
}
async function handleCheckinExtend(req, checkinId) {
  const authResult = await requireAuth(req);
  if (authResult instanceof Response) return authResult;
  const { userId, supabase } = authResult;
  const body = await readJson(req);
  const minutes = Math.min(Number(body.minutes) || 30, 120);
  const { data: checkin, error: checkinErr } = await supabase.from('checkins').select('id, user_id, due_at, status').eq('id', checkinId).eq('user_id', userId).maybeSingle();
  if (checkinErr) {
    console.error(`[emergency-mode] checkin_extend: checkins read FAILED for ${checkinId}:`, checkinErr);
    return jsonError('DB_ERROR', checkinErr.message, 500);
  }
  if (!checkin) return jsonError('NOT_FOUND', 'Check-in not found', 404);
  if (checkin.status === 'cancelled') return jsonError('CANCELLED', 'Check-in is cancelled', 409);
  const newDueAt = new Date(new Date(checkin.due_at).getTime() + minutes * 60000).toISOString();
  const { error: updateErr } = await supabase.from('checkins').update({
    due_at: newDueAt,
    status: 'extended',
    first_prompt_sent_at: null,
    second_prompt_sent_at: null
  }).eq('id', checkinId);
  if (updateErr) {
    console.error(`[emergency-mode] checkin_extend: update FAILED for ${checkinId}:`, updateErr);
    return jsonError('DB_ERROR', updateErr.message, 500);
  }
  return json({
    ok: true,
    newDueAt
  });
}
async function handleCheckinCancel(req, checkinId) {
  const authResult = await requireAuth(req);
  if (authResult instanceof Response) return authResult;
  const { userId, supabase } = authResult;
  const { data: checkin, error: checkinErr } = await supabase.from('checkins').select('id, user_id').eq('id', checkinId).eq('user_id', userId).maybeSingle();
  if (checkinErr) {
    console.error(`[emergency-mode] checkin_cancel: checkins read FAILED for ${checkinId}:`, checkinErr);
    return jsonError('DB_ERROR', checkinErr.message, 500);
  }
  if (!checkin) return jsonError('NOT_FOUND', 'Check-in not found', 404);
  const { error: updateErr } = await supabase.from('checkins').update({
    status: 'cancelled'
  }).eq('id', checkinId);
  if (updateErr) {
    console.error(`[emergency-mode] checkin_cancel: update FAILED for ${checkinId}:`, updateErr);
    return jsonError('DB_ERROR', updateErr.message, 500);
  }
  return json({
    ok: true
  });
}
async function handleCreateRollcall(req, url) {
  const authResult = await requireAuth(req);
  if (authResult instanceof Response) return authResult;
  const { userId, supabase } = authResult;
  const tripId = url.searchParams.get('tripId');
  if (!tripId) return jsonError('MISSING_PARAM', 'tripId is required');
  const body = await readJson(req);
  const { triggerKind = 'manual', alertRef } = body;
  if (![
    'manual',
    'alert'
  ].includes(triggerKind)) {
    return jsonError('INVALID_PARAM', 'triggerKind must be manual or alert');
  }
  // SECURITY / CORRECTNESS 2026-09-16.
  //
  // Two defects were fixed here.
  //
  // 1. Members were read through the user-scoped client. trip_members has RLS
  //    enabled with no policies, so that read returned zero rows every time:
  //    the roll call was created, no response rows were written, nobody was
  //    notified, and it returned 201 with memberCount 0. A safety feature that
  //    silently reached no one. The survey of this codebase concluded
  //    trip_members is deliberately edge-function-only, so the read is now done
  //    with service_role.
  //
  // 2. There was no membership check at all. Any authenticated user could raise
  //    a roll call on any trip id they could guess and push an emergency
  //    notification to every member of a stranger's trip.
  //
  // The caller is resolved into the platform id space first, because
  // trip_members.user_id holds platform_users.id (text), not auth.uid() (uuid).
  const service = svc();
  const platformUserId = await resolvePlatformUserId(service, userId);
  if (!platformUserId) {
    return jsonError('NOT_A_MEMBER', 'You are not a member of this trip', 404);
  }
  const { data: callerMembership, error: membershipErr } = await service.from('trip_members').select('id').eq('trip_id', tripId).eq('user_id', platformUserId).is('removed_at', null).maybeSingle();
  // 2026-09-19: the error was discarded, so a failed membership read denied a
  // real member the ability to raise a roll call and said "you are not a member".
  if (membershipErr) {
    console.error(`[emergency-mode] create_rollcall: trip_members membership read FAILED for trip ${tripId}:`, membershipErr);
    return jsonError('DB_ERROR', membershipErr.message, 500);
  }
  if (!callerMembership) {
    return jsonError('NOT_A_MEMBER', 'You are not a member of this trip', 404);
  }
  const id = generateId('rcl_');
  const { data: rollcall, error } = await supabase.from('rollcalls').insert({
    id,
    trip_id: tripId,
    triggered_by: platformUserId,
    trigger_kind: triggerKind,
    alert_ref: alertRef || null,
    status: 'open'
  }).select().single();
  if (error) return jsonError('DB_ERROR', error.message, 500);
  const { data: members, error: membersErr } = await service.from('trip_members').select('user_id').eq('trip_id', tripId).is('removed_at', null);
  // 2026-09-19: discarded error. A failed member read produced memberCount 0 —
  // a roll call that looks raised and reaches nobody, indistinguishable from a
  // trip that genuinely has no members.
  if (membersErr) {
    console.error(`[emergency-mode] SAFETY: create_rollcall ${id}: trip_members read FAILED for trip ${tripId} — ` + `the roll call exists but NOBODY was notified:`, membersErr);
    return json({
      ...rollcall,
      memberCount: null,
      membersNotified: false,
      membersError: membersErr.message
    }, 201);
  }
  const memberIds = (members ?? []).map((m)=>m.user_id).filter((v)=>!!v);
  if (memberIds.length === 0) {
    console.error(`[emergency-mode] SAFETY: create_rollcall ${id}: trip ${tripId} has no active members — ` + `the roll call was raised with nobody to notify.`);
  } else {
    const { error: responsesErr } = await service.from('rollcall_responses').insert(memberIds.map((memberId)=>({
        rollcall_id: id,
        member_id: memberId,
        reminder_count: 0
      })));
    if (responsesErr) {
      console.error(`[emergency-mode] SAFETY: create_rollcall ${id}: rollcall_responses insert FAILED — members ` + `will not be able to respond to this roll call:`, responsesErr);
    }
    // trip_members.user_id is TEXT with a foreign key to platform_users.id —
    // these are platform `usr_` ids, never auth uuids. id space: 'platform'.
    // Sent as one fan-out rather than one request per member.
    await sendNotification(service, {
      recipients: memberIds,
      idSpace: 'platform',
      title: '🔔 Roll call',
      message: 'Are you safe? Please respond to the roll call.',
      data: {
        rollcallId: id,
        tripId,
        type: 'rollcall',
        priority: 'HIGH'
      },
      tripId
    });
  }
  return json({
    ...rollcall,
    memberCount: memberIds.length
  }, 201);
}
async function handleRollcallRespond(req, rollcallId) {
  const authResult = await requireAuth(req);
  if (authResult instanceof Response) return authResult;
  const { userId, supabase } = authResult;
  const body = await readJson(req);
  const { response } = body;
  if (![
    'safe',
    'help',
    'not_affected'
  ].includes(response)) {
    return jsonError('INVALID_PARAM', 'response must be safe, help, or not_affected');
  }
  const service = svc();
  const { data: rollcall, error: rollcallErr } = await service.from('rollcalls').select('id, trip_id, status').eq('id', rollcallId).maybeSingle();
  // 2026-09-19: discarded error. Someone responding 'help' to a roll call was
  // told the roll call did not exist when the read had merely failed.
  if (rollcallErr) {
    console.error(`[emergency-mode] SAFETY: rollcall_respond: rollcalls read FAILED for ${rollcallId} — a ` + `'${response}' response could not be recorded:`, rollcallErr);
    return jsonError('DB_ERROR', rollcallErr.message, 500);
  }
  if (!rollcall) return jsonError('NOT_FOUND', 'Roll call not found', 404);
  if (rollcall.status === 'closed') return jsonError('CLOSED', 'Roll call is closed', 409);
  // rollcall_responses.member_id holds platform_users.id, so the responder must
  // be resolved out of the auth id space before matching.
  const platformUserId = await resolvePlatformUserId(service, userId);
  if (!platformUserId) return jsonError('NOT_A_MEMBER', 'You are not part of this roll call', 404);
  const now = new Date().toISOString();
  const { data: updatedRows, error } = await service.from('rollcall_responses').update({
    response,
    responded_at: now
  }).eq('rollcall_id', rollcallId).eq('member_id', platformUserId).select('rollcall_id');
  if (error) return jsonError('DB_ERROR', error.message, 500);
  if (!updatedRows || updatedRows.length === 0) {
    return jsonError('NOT_A_MEMBER', 'You are not part of this roll call', 404);
  }
  if (response === 'help') {
    const { data: trip, error: tripErr } = await service.from('trips').select('user_id, title').eq('id', rollcall.trip_id).maybeSingle();
    // 2026-09-19: discarded error — a failed trips read was indistinguishable
    // from a missing trip, and both ended with the owner not being told that a
    // member had asked for help.
    if (tripErr) {
      console.error(`[emergency-mode] SAFETY: rollcall_help ${rollcallId} — trips read FAILED for trip ` + `${rollcall.trip_id}, so the trip owner was NOT notified that a member asked for help:`, tripErr);
    } else if (trip) {
      // SECURITY 2026-09-16: was an unfiltered "newest row in location_points".
      const lastLocation = await latestLocationForUser(supabase, userId);
      // trips.user_id is a uuid column matching auth.uid() directly — this is
      // the trip owner's auth id, not a platform id. id space: 'auth'.
      const result = await sendNotification(service, {
        recipients: [
          trip.user_id
        ],
        idSpace: 'auth',
        title: '🚨 Member needs help',
        message: `A member of your trip "${trip.title}" has responded to the roll call requesting help.`,
        data: {
          rollcallId,
          tripId: rollcall.trip_id,
          type: 'rollcall_help',
          memberId: platformUserId,
          lastLocation,
          priority: 'CRITICAL'
        },
        tripId: rollcall.trip_id
      });
      if ((result?.delivered_inapp ?? 0) === 0) {
        console.error(`[emergency-mode] SAFETY: rollcall_help ${rollcallId} delivered_inapp=0 — a member of ` + `trip ${rollcall.trip_id} asked for help and the trip owner was NOT notified.`);
      }
    } else {
      console.error(`[emergency-mode] SAFETY: rollcall_help ${rollcallId} — trip ${rollcall.trip_id} not found, ` + `so nobody was notified that a member asked for help.`);
    }
  }
  return json({
    ok: true,
    response
  });
}
async function handleGetEmergencyInfo(req) {
  const authResult = await requireAuth(req);
  if (authResult instanceof Response) return authResult;
  const { userId, supabase } = authResult;
  const { data, error } = await supabase.from('emergency_info').select('encrypted_data, key_id').eq('user_id', userId).maybeSingle();
  // 2026-09-19: was `if (error || !data) return json({})`. A failed read of a
  // traveler's blood type, allergies, conditions and medications was returned
  // to the caller as an empty object — i.e. "this person has no medical
  // information", which is a clinically dangerous thing to assert wrongly.
  if (error) {
    console.error(`[emergency-mode] SAFETY: emergency_info read FAILED for user ${userId} — returning 500 rather ` + `than an empty record that would read as 'no medical information':`, error);
    return jsonError('DB_ERROR', 'Could not load emergency info', 500);
  }
  if (!data) return json({});
  const masterSecret = emergencyInfoSecret();
  if (!masterSecret) {
    console.error('[emergency-mode] EMERGENCY_INFO_SECRET is not set — emergency info unavailable');
    return jsonError('EMERGENCY_INFO_UNAVAILABLE', 'Emergency info is temporarily unavailable', 503);
  }
  try {
    const encBuf = byteaToBytes(data.encrypted_data);
    const { iv, ciphertext } = unpackEncrypted(encBuf);
    const decrypted = await decryptData(ciphertext, iv, masterSecret, userId);
    return json(decrypted);
  } catch (e) {
    console.error('Decryption failed:', e);
    return jsonError('DECRYPT_ERROR', 'Failed to decrypt emergency info', 500);
  }
}
async function handlePutEmergencyInfo(req) {
  const authResult = await requireAuth(req);
  if (authResult instanceof Response) return authResult;
  const { userId, supabase } = authResult;
  const masterSecret = emergencyInfoSecret();
  if (!masterSecret) {
    console.error('[emergency-mode] EMERGENCY_INFO_SECRET is not set — refusing to store emergency info');
    return jsonError('EMERGENCY_INFO_UNAVAILABLE', 'Emergency info is temporarily unavailable', 503);
  }
  const body = await readJson(req);
  const { name, bloodType, allergies, conditions, medications } = body;
  const payload = {
    name,
    bloodType,
    allergies,
    conditions,
    medications
  };
  const keyId = 'v1';
  const { ciphertext, iv } = await encryptData(payload, masterSecret, userId);
  const packed = packEncrypted(iv, ciphertext);
  const { error } = await supabase.from('emergency_info').upsert({
    user_id: userId,
    encrypted_data: bytesToByteaHex(packed),
    key_id: keyId,
    updated_at: new Date().toISOString()
  }, {
    onConflict: 'user_id'
  });
  if (error) return jsonError('DB_ERROR', error.message, 500);
  return json({
    ok: true
  });
}
async function handleScan(req) {
  // SECURITY 2026-09-16: previously `authHeader.includes(serviceKey)` — a
  // substring test for a secret, and not constant-time. Now an exact,
  // constant-time comparison of the bearer token.
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return jsonError('UNAUTHORIZED', 'Service key required', 401);
  }
  const token = authHeader.slice(7).trim();
  if (!timingSafeEqual(token, SUPABASE_SERVICE_ROLE_KEY)) {
    return jsonError('UNAUTHORIZED', 'Service key required', 401);
  }
  const serviceSupabase = svc();
  const { data: pendingCheckins, error: pendingErr } = await serviceSupabase.from('checkins').select('id').eq('status', 'pending').lte('due_at', new Date(Date.now() + 60000).toISOString());
  // 2026-09-19: discarded error. If this read failed the sweep reported
  // `processedCheckins: 0` — identical to "nothing was due" — while every
  // overdue check-in in the system went un-escalated.
  if (pendingErr) {
    console.error('[emergency-mode] SAFETY: scan: pending checkins read FAILED — NO check-in escalation ran ' + 'on this sweep:', pendingErr);
    return jsonError('DB_ERROR', pendingErr.message, 500);
  }
  let processedCheckins = 0;
  for (const { id } of pendingCheckins || []){
    await processCheckinEscalation(serviceSupabase, id);
    processedCheckins++;
  }
  const { data: expiredShares, error: expiredErr } = await serviceSupabase.from('location_shares').select('id').eq('status', 'active').not('ends_at', 'is', null).lte('ends_at', new Date().toISOString());
  if (expiredErr) {
    console.error('[emergency-mode] scan: expired location_shares read FAILED:', expiredErr);
  }
  let expiredCount = 0;
  if (expiredShares?.length) {
    const { error: expireUpdateErr } = await serviceSupabase.from('location_shares').update({
      status: 'expired'
    }).in('id', expiredShares.map((s)=>s.id));
    if (expireUpdateErr) {
      console.error('[emergency-mode] scan: expiring location_shares FAILED:', expireUpdateErr);
    } else {
      expiredCount = expiredShares.length;
    }
  }
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: oldShares, error: oldSharesErr } = await serviceSupabase.from('location_shares').select('id').in('status', [
    'ended',
    'expired'
  ]).lte('ends_at', cutoff);
  if (oldSharesErr) {
    console.error('[emergency-mode] scan: old location_shares read FAILED:', oldSharesErr);
  }
  let cleanedPoints = 0;
  if (oldShares?.length) {
    const { count, error: deleteErr } = await serviceSupabase.from('location_points').delete({
      count: 'exact'
    }).in('share_id', oldShares.map((s)=>s.id));
    if (deleteErr) {
      console.error('[emergency-mode] scan: location_points cleanup FAILED:', deleteErr);
    } else {
      cleanedPoints = count || 0;
    }
  }
  return json({
    ok: true,
    processedCheckins,
    expiredShares: expiredCount,
    cleanedLocationPoints: cleanedPoints
  });
}
// ── Router ─────────────────────────────────────────────────────────
Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: corsHeaders
    });
  }
  const url = new URL(req.url);
  const rawPath = url.pathname.replace(/^\/emergency-mode/, '') || '/';
  try {
    if (req.method === 'GET' && rawPath === '/sos-card') return await handleGetSosCard(req, url);
    if (req.method === 'POST' && rawPath === '/location-shares') return await handleCreateLocationShare(req);
    const pointsMatch = rawPath.match(/^\/location-shares\/([^/]+)\/points$/);
    if (req.method === 'POST' && pointsMatch) return await handleAddLocationPoint(req, pointsMatch[1]);
    const stopMatch = rawPath.match(/^\/location-shares\/([^/]+)\/stop$/);
    if (req.method === 'POST' && stopMatch) return await handleStopLocationShare(req, stopMatch[1]);
    const publicShareMatch = rawPath.match(/^\/share\/location\/([^/]+)$/);
    if (req.method === 'GET' && publicShareMatch) return await handleGetPublicShare(publicShareMatch[1]);
    if (req.method === 'POST' && rawPath === '/checkins') return await handleCreateCheckin(req);
    const checkinOkMatch = rawPath.match(/^\/checkins\/([^/]+)\/ok$/);
    if (req.method === 'POST' && checkinOkMatch) return await handleCheckinOk(req, checkinOkMatch[1]);
    const checkinHelpMatch = rawPath.match(/^\/checkins\/([^/]+)\/help$/);
    if (req.method === 'POST' && checkinHelpMatch) return await handleCheckinHelp(req, checkinHelpMatch[1]);
    const checkinExtendMatch = rawPath.match(/^\/checkins\/([^/]+)\/extend$/);
    if (req.method === 'POST' && checkinExtendMatch) return await handleCheckinExtend(req, checkinExtendMatch[1]);
    const checkinCancelMatch = rawPath.match(/^\/checkins\/([^/]+)\/cancel$/);
    if (req.method === 'POST' && checkinCancelMatch) return await handleCheckinCancel(req, checkinCancelMatch[1]);
    if (req.method === 'POST' && rawPath === '/rollcalls') return await handleCreateRollcall(req, url);
    const rollcallRespondMatch = rawPath.match(/^\/rollcalls\/([^/]+)\/respond$/);
    if (req.method === 'POST' && rollcallRespondMatch) return await handleRollcallRespond(req, rollcallRespondMatch[1]);
    if (req.method === 'GET' && rawPath === '/me/emergency-info') return await handleGetEmergencyInfo(req);
    if (req.method === 'PUT' && rawPath === '/me/emergency-info') return await handlePutEmergencyInfo(req);
    if (req.method === 'POST' && rawPath === '/scan') return await handleScan(req);
    return jsonError('NOT_FOUND', `Route not found: ${req.method} ${rawPath}`, 404);
  } catch (err) {
    if (err instanceof BadJsonError) return jsonError('INVALID_JSON', err.message, 400);
    console.error('Unhandled error:', err);
    return jsonError('INTERNAL_ERROR', 'An unexpected error occurred', 500);
  }
});

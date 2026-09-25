// 2026-09-19 — two fabrications in the delivery path, both of the same kind:
// a query that could never succeed, whose failure was then reported as a fact
// about the user.
//
// 1. SMS — sendSmsInternal read
//    `.from('user_profiles').select('phone, phone_verified').eq('user_id', …)`.
//    `public.user_profiles` DOES NOT EXIST (42P01). The real table is
//    `profiles`; it does carry `phone` and `phone_verified`, but it is keyed on
//    `id`, not `user_id` (verified against information_schema.columns on
//    2026-09-19). The error was discarded and every single call fell through to
//    `{ skipped: true, reason: 'no_verified_phone' }` — so "this project has no
//    such table" and "this traveler has not given us a phone number" were
//    reported identically, on the path that only runs for CRITICAL alerts.
//    Now: the right table, the right key, the error captured, and four
//    distinguishable outcomes — profile_lookup_failed (a real error, logged and
//    recorded as a FAILED delivery attempt), no_profile, no_phone_on_file and
//    phone_not_verified.
//
// 2. Alert detail — sendEmailInternal and sendInappInternal both read
//    `batch.alerts`. `alert_batches` has no `alerts` column; it has
//    `alert_ids uuid[]` (verified 2026-09-19). `batch.alerts` was therefore
//    always undefined, and the `?? []` behind it meant every alert email
//    contained zero alert cards (falling back to repeating the one-line
//    summary) and every in-app notification was written with
//    `action_items: []`. The alert rows are now loaded from `travel_alerts` by
//    those ids — see loadBatchAlerts.
//
// Also in this pass: `if (batchErr || !batch) return 404` was split so a failed
// alert_batches read is a 500 that says so and only an absent batch is a 404;
// and the previously-discarded `error` bindings on the push-token and
// preference lookups are captured, so a failed token read is no longer
// recorded as the fabricated reason `no_push_tokens`.
//
// SECURITY 2026-09-17 — This function sends push/email/SMS to real people, so
// two different defects mattered more here than elsewhere:
//
// 1. Broken pipeline caller. Every action required a real user JWT
//    (`supabase.auth.getUser()` off the caller's own Authorization header)
//    and then used that SAME caller's id as the delivery target everywhere
//    (push tokens, email, phone, preferences). Alert delivery is triggered by
//    the batching/alert pipeline, which has no end-user session to present —
//    it calls with the service-role key (see replan-engine and
//    recovery-assist, which both already call this function with
//    `Authorization: Bearer <SERVICE_ROLE_KEY>`). Every such call has
//    returned 401 and done nothing; delivery has only ever worked when a
//    user's own browser session called it directly for itself. Fixed with
//    requireUserOrService for the batch-delivery actions (deliver_batch,
//    send_push, send_email, send_sms, send_inapp): the delivery target is now
//    resolved from `alert_batches.user_id` (looked up by the batch_id in the
//    request) rather than from the caller's identity, and a real user caller
//    is still required to own that batch. The purely personal actions
//    (register_push_token, get_inapp_notifications, mark_read,
//    dismiss_notification, get_delivery_stats) still require a real user and
//    still act only on that user's own id — a service caller has no reason to
//    read or mark another person's notification feed, and identity for those
//    must never come from the request body.
//
// 2. Note for whoever owns replan-engine's "notify affected members" call and
//    recovery-assist's /broadcast call: both send a body shaped like
//    { userIds/memberIds, title, message, ... } with no `action` field. This
//    function has never supported that shape (every action here is
//    batch_id-based) — those calls get "Missing action" and silently no-op
//    behind a .catch(() => {}). That is a separate, still-open defect this
//    patch does not invent a fix for; see the audit report.
//
// 2026-09-18 — `send_direct` added, which is the missing shape defect (2)
// describes. Four callers fan a notification out to a list of trip members and
// have never delivered anything: disruption-engine, recovery-assist
// /broadcast, replan-engine /apply, and emergency-mode (check-in reminders,
// overdue escalation, the SOS `/checkins/:id/help` path, and roll calls). All
// four POST a body with no `action` field, hit `Missing action`, and swallow
// the 400 behind a .catch — runtime logs for the 24h before this patch show 4
// invocations, 3x400 + 1x401, zero 2xx, and every delivery table empty. The
// SOS path has therefore never paged anyone.
//
// `send_direct` takes an explicit recipient list instead of a batch id:
//   { action: 'send_direct', recipients: string[], id_space: 'platform'|'auth',
//     title, message, data?, tripId? }
// `id_space` is required with no default because the two id spaces are not
// interchangeable: `trip_members.user_id` is TEXT `usr_<hex>` while every
// delivery-target column (user_push_tokens.user_id, inapp_notifications.user_id,
// user_alert_preferences.user_id, auth.admin.getUserById) is uuid. Platform ids
// are bridged through `auth_identities.provider_subject` in ONE batched query,
// matching on `user_id` alone — the `provider` column varies by sign-in method
// and filtering on it matches nothing.
//
// Authorization: service callers may send to anyone; a real user caller may
// only send to themselves. Without that check any signed-in user could push
// arbitrary notifications to every other user.
//
// Channels: in-app + push only. Email and SMS are deliberately skipped and
// logged — neither provider is configured. (The 2026-09-18 note here also gave
// "public.user_profiles does not exist" as a reason SMS could not resolve a
// phone; that table indeed does not exist, but `profiles` does and holds the
// phone — see the 2026-09-19 note above. The remaining blocker is the provider.)
//
// DUPLICATE FIX 2026-09-18 — see deliverBatch: 'inapp' and 'dashboard' are the
// same surface and each was writing its own inapp_notifications row.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { requireUser, requireUserOrService, serviceClient } from './_shared/auth.ts';
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
function ok(data) {
  return new Response(JSON.stringify({
    success: true,
    data,
    error: null
  }), {
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json'
    }
  });
}
function err(message, status = 400) {
  return new Response(JSON.stringify({
    success: false,
    data: null,
    error: message
  }), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json'
    }
  });
}
// Actions that operate on an alert_batches row rather than the caller's own
// profile. These are the ones the delivery pipeline drives with the
// service-role key.
const BATCH_ACTIONS = new Set([
  'deliver_batch',
  'send_push',
  'send_email',
  'send_sms',
  'send_inapp'
]);
Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: corsHeaders
    });
  }
  const serviceClientInstance = serviceClient();
  let body = {};
  try {
    body = await req.json();
  } catch  {
    return err('Invalid JSON body');
  }
  const action = body.action;
  if (!action) return err('Missing action');
  // ─── send_direct ────────────────────────────────────────────────────
  // Its own path: no alert_batches row exists for these, so the batch lookup
  // below does not apply. See the header note.
  if (action === 'send_direct') {
    const caller = await requireUserOrService(req);
    if (caller instanceof Response) return caller;
    try {
      return await sendDirect(serviceClientInstance, caller, body);
    } catch (e) {
      console.error('[notification-delivery] Error in action send_direct:', e);
      return err(e instanceof Error ? e.message : 'Internal server error', 500);
    }
  }
  // Resolve the target user (whose tokens/email/phone/preferences this
  // action acts on) and enforce ownership.
  let targetUserId;
  if (BATCH_ACTIONS.has(action)) {
    const caller = await requireUserOrService(req);
    if (caller instanceof Response) return caller;
    const batchId = body.batch_id;
    if (!batchId) return err('Missing batch_id');
    const { data: batch, error: batchErr } = await serviceClientInstance.from('alert_batches').select('*').eq('id', batchId).maybeSingle();
    // 2026-09-19: was `.single()` behind `if (batchErr || !batch) return 404`,
    // so a failed read of the batch told the delivery pipeline the batch did
    // not exist and the alert was dropped silently. Only an absent row is a
    // 404. The ownership check below still answers 404 deliberately, so a user
    // cannot probe which batch ids exist.
    if (batchErr) {
      console.error(`[notification-delivery] alert_batches read FAILED for batch ${batchId}:`, batchErr);
      return err(`Batch lookup failed: ${batchErr.message}`, 500);
    }
    if (!batch) return err('Batch not found', 404);
    if (caller.kind === 'user' && batch.user_id !== caller.userId) {
      return err('Batch not found', 404);
    }
    targetUserId = batch.user_id;
    try {
      switch(action){
        case 'deliver_batch':
          return await deliverBatch(serviceClientInstance, targetUserId, batch);
        case 'send_push':
          return ok(await sendPushInternal(serviceClientInstance, targetUserId, batch));
        case 'send_email':
          return ok(await sendEmailInternal(serviceClientInstance, targetUserId, batch));
        case 'send_sms':
          return ok(await sendSmsInternal(serviceClientInstance, targetUserId, batch));
        case 'send_inapp':
          return ok(await sendInappInternal(serviceClientInstance, targetUserId, batch));
      }
    } catch (e) {
      console.error(`[notification-delivery] Error in action ${action}:`, e);
      return err(e instanceof Error ? e.message : 'Internal server error', 500);
    }
  }
  // Every remaining action is "read/change my own notification feed" and
  // must come from a real, verified user — never a service caller, and never
  // an id from the body.
  const caller = await requireUser(req);
  if (caller instanceof Response) return caller;
  targetUserId = caller.userId;
  try {
    switch(action){
      case 'register_push_token':
        return await registerPushToken(serviceClientInstance, targetUserId, body);
      case 'get_inapp_notifications':
        return await getInappNotifications(serviceClientInstance, targetUserId, body);
      case 'mark_read':
        return await markRead(serviceClientInstance, targetUserId, body);
      case 'dismiss_notification':
        return await dismissNotification(serviceClientInstance, targetUserId, body);
      case 'get_delivery_stats':
        return await getDeliveryStats(serviceClientInstance, targetUserId);
      default:
        return err(`Unknown action: ${action}`);
    }
  } catch (e) {
    console.error(`[notification-delivery] Error in action ${action}:`, e);
    return err(e instanceof Error ? e.message : 'Internal server error', 500);
  }
});
// ─── batch alert detail ────────────────────────────────────────────────
/**
 * The alerts that make up a batch.
 *
 * 2026-09-19: sendEmailInternal and sendInappInternal both read `batch.alerts`.
 * `alert_batches` has no `alerts` column — it has `alert_ids uuid[]` (verified
 * against information_schema.columns 2026-09-19). The expression was always
 * undefined, so `?? []` meant alert emails listed no alerts at all and every
 * in-app notification was stored with an empty `action_items`.
 *
 * `travel_alerts` has no `message` or `action_url` column either: the
 * human-readable text is `summary` (with `explanation` as the longer form), and
 * the link is the same in-app alerts route the rest of this file already uses.
 * An alert whose rows cannot be read yields an empty list and a loud log —
 * never invented cards.
 */ async function loadBatchAlerts(serviceClientInstance, batch) {
  const rawIds = batch.alert_ids;
  const alertIds = Array.isArray(rawIds) ? rawIds.filter((v)=>typeof v === 'string' && v) : [];
  if (alertIds.length === 0) {
    console.log(`[notification-delivery] batch ${batch.id}: alert_ids is empty — the notification will carry ` + `no per-alert detail (alert_count=${batch.alert_count})`);
    return [];
  }
  const { data, error } = await serviceClientInstance.from('travel_alerts').select('id, title, summary, explanation, priority').in('id', alertIds);
  if (error) {
    console.error(`[notification-delivery] batch ${batch.id}: travel_alerts lookup FAILED for ` + `${alertIds.length} alert id(s) — the notification will carry no per-alert detail:`, error);
    return [];
  }
  const rows = data ?? [];
  if (rows.length < alertIds.length) {
    console.warn(`[notification-delivery] batch ${batch.id}: ${alertIds.length} alert id(s) requested but ` + `${rows.length} row(s) found in travel_alerts`);
  }
  const tripId = batch.trip_id;
  return rows.map((a)=>({
      id: a.id,
      title: a.title ?? '',
      message: a.summary ?? a.explanation ?? '',
      priority: a.priority ?? 'LOW',
      action_url: tripId ? `/travel-alerts?tripId=${tripId}` : null
    }));
}
// ─── send_direct ───────────────────────────────────────────────────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRIORITIES = new Set([
  'CRITICAL',
  'HIGH',
  'MEDIUM',
  'LOW'
]);
const MAX_RECIPIENTS = 200;
async function sendDirect(serviceClientInstance, caller, body) {
  // ── validate ────────────────────────────────────────────────────────
  const rawRecipients = body.recipients;
  if (!Array.isArray(rawRecipients) || rawRecipients.length === 0) {
    return err('Missing or empty recipients');
  }
  if (rawRecipients.length > MAX_RECIPIENTS) {
    return err(`Too many recipients (max ${MAX_RECIPIENTS})`);
  }
  const recipients = Array.from(new Set(rawRecipients.filter((r)=>typeof r === 'string' && r.length > 0)));
  if (recipients.length === 0) return err('Missing or empty recipients');
  const idSpace = body.id_space;
  if (idSpace !== 'platform' && idSpace !== 'auth') {
    return err("Missing or invalid id_space (must be 'platform' or 'auth')");
  }
  const title = body.title;
  const message = body.message;
  if (!title || typeof title !== 'string') return err('Missing title');
  if (!message || typeof message !== 'string') return err('Missing message');
  const data = body.data ?? null;
  const tripIdRaw = body.tripId;
  // inapp_notifications.trip_id is uuid; a non-uuid would abort the whole
  // insert with 22P02, so keep it only when it really is one.
  const tripId = typeof tripIdRaw === 'string' && UUID_RE.test(tripIdRaw) ? tripIdRaw : null;
  // ── resolve recipients to auth uuids ──────────────────────────────────
  // Every delivery-target column is uuid. Platform ids are TEXT `usr_<hex>`
  // and must go through the auth_identities bridge. ONE query for the batch.
  const resolved = []; // auth uuids, deduped
  const unresolved = []; // input ids that produced nothing
  if (idSpace === 'platform') {
    const { data: rows, error: bridgeErr } = await serviceClientInstance.from('auth_identities').select('user_id, provider_subject').in('user_id', recipients);
    if (bridgeErr) throw new Error(bridgeErr.message);
    const map = new Map();
    for (const row of rows ?? []){
      if (row.provider_subject) map.set(row.user_id, row.provider_subject);
    }
    for (const r of recipients){
      const authId = map.get(r);
      if (authId && !resolved.includes(authId)) resolved.push(authId);
      else if (!authId) unresolved.push(r);
    }
  } else {
    // id_space 'auth' — already auth uuids, used as-is.
    for (const r of recipients){
      if (UUID_RE.test(r)) {
        if (!resolved.includes(r)) resolved.push(r);
      } else unresolved.push(r);
    }
  }
  // ── authorization ──────────────────────────────────────────────────
  // Service callers may send to anyone. A real user caller may only send to
  // themselves; anything else is a cross-user push and is refused outright.
  if (caller.kind === 'user') {
    const foreign = resolved.filter((id)=>id !== caller.userId);
    if (foreign.length > 0) {
      return err('Forbidden: a user caller may only send to themselves', 403);
    }
  }
  const result = {
    requested: recipients.length,
    resolved: resolved.length,
    delivered_inapp: 0,
    delivered_push: 0,
    unresolved
  };
  if (resolved.length === 0) {
    console.log('[notification-delivery] send_direct: nothing resolved', result);
    return ok(result);
  }
  // Email and SMS are deliberately not attempted here: neither SendGrid nor
  // Twilio is configured in this project. (Until 2026-09-19 this comment also
  // claimed the phone could not be resolved because `public.user_profiles`
  // does not exist. That table does not exist, but `profiles` does and holds
  // `phone`/`phone_verified` — the provider is the only remaining blocker.)
  console.log(`[notification-delivery] send_direct: skipping email+sms for ${resolved.length} recipient(s) ` + `(no_provider_configured)`);
  // ── preferences ────────────────────────────────────────────────────
  // Same gate the existing deliverBatch applies (push_enabled === false skips
  // push), just batched across recipients. In-app is not preference-gated in
  // the existing code either, so it is not gated here.
  const pushDisabled = new Set();
  const { data: prefRows, error: prefErr } = await serviceClientInstance.from('user_alert_preferences').select('user_id, push_enabled').in('user_id', resolved);
  if (prefErr) {
    // 2026-09-19: discarded. Failing open here pushes to people who asked not
    // to be pushed; that is worth saying out loud rather than swallowing.
    console.error('[notification-delivery] send_direct: user_alert_preferences lookup FAILED — proceeding ' + 'WITHOUT the push opt-out gate:', prefErr);
  }
  for (const row of prefRows ?? []){
    if (row.push_enabled === false) pushDisabled.add(row.user_id);
  }
  // ── in-app ─────────────────────────────────────────────────────────
  // Same column shape sendInappInternal writes, minus batch_id (nullable —
  // these have no batch).
  const theme = typeof data?.theme === 'string' ? data.theme : 'mixed';
  const priorityRaw = data?.max_priority ?? data?.priority;
  const maxPriority = typeof priorityRaw === 'string' && PRIORITIES.has(priorityRaw.toUpperCase()) ? priorityRaw.toUpperCase() : 'LOW';
  const actionUrl = typeof data?.action_url === 'string' ? data.action_url : typeof data?.actionUrl === 'string' ? data.actionUrl : tripId ? `/travel-alerts?tripId=${tripId}` : null;
  const rows = resolved.map((authId)=>({
      user_id: authId,
      trip_id: tripId,
      title,
      body: message,
      theme,
      max_priority: maxPriority,
      action_url: actionUrl,
      action_items: []
    }));
  const { data: inserted, error: insertErr } = await serviceClientInstance.from('inapp_notifications').insert(rows).select('id');
  if (insertErr) throw new Error(insertErr.message);
  result.delivered_inapp = (inserted ?? []).length;
  // ── push ───────────────────────────────────────────────────────────
  result.delivered_push = await sendDirectPush(serviceClientInstance, resolved.filter((id)=>!pushDisabled.has(id)), {
    title,
    message,
    data,
    tripId,
    actionUrl
  });
  console.log('[notification-delivery] send_direct result:', result);
  return ok(result);
}
/**
 * Push for send_direct. Same delivery path sendPushInternal uses — active rows
 * in user_push_tokens, one POST to the Expo push API, last_used_at refreshed —
 * but without the delivery_attempts bookkeeping, which is keyed on a batch_id
 * these sends do not have. sendPushInternal itself is untouched.
 *
 * Returns the number of RECIPIENTS for whom at least one token was accepted.
 */ async function sendDirectPush(serviceClientInstance, authIds, payload) {
  if (authIds.length === 0) return 0;
  const { data: tokens, error: tokenErr } = await serviceClientInstance.from('user_push_tokens').select('user_id, expo_push_token').in('user_id', authIds).eq('is_active', true);
  // 2026-09-19: discarded. A failed token read looked exactly like "none of
  // these people have a device registered".
  if (tokenErr) {
    console.error('[notification-delivery] send_direct push: user_push_tokens lookup FAILED:', tokenErr);
    return 0;
  }
  const tokenRows = tokens ?? [];
  if (tokenRows.length === 0) {
    console.log('[notification-delivery] send_direct push: no_push_tokens for any recipient');
    return 0;
  }
  const messages = tokenRows.map((t)=>({
      to: t.expo_push_token,
      title: payload.title,
      body: payload.message,
      data: {
        ...payload.data ?? {},
        tripId: payload.tripId,
        actionUrl: payload.actionUrl
      },
      sound: 'default',
      priority: 'high',
      badge: 1
    }));
  const deliveredUsers = new Set();
  try {
    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(messages)
    });
    const json = await res.json();
    const results = Array.isArray(json.data) ? json.data : [
      json.data
    ];
    results.forEach((r, i)=>{
      if (r?.status === 'ok' && tokenRows[i]) {
        deliveredUsers.add(tokenRows[i].user_id);
      }
    });
    await serviceClientInstance.from('user_push_tokens').update({
      last_used_at: new Date().toISOString()
    }).in('user_id', authIds).eq('is_active', true);
  } catch (e) {
    console.error('[notification-delivery] send_direct Expo push error:', e);
    return 0;
  }
  return deliveredUsers.size;
}
// ─── deliver_batch ─────────────────────────────────────────────────────
async function deliverBatch(serviceClientInstance, targetUserId, batch) {
  // Fetch user preferences. 2026-09-19: was `.single()` with the error
  // discarded, so a user who simply has no preferences row produced a PGRST116
  // error that was indistinguishable from a real read failure. maybeSingle()
  // plus an explicit log separates "no preferences set" from "could not read
  // preferences"; both still fall through to the defaults, which is the
  // pre-existing behaviour.
  const { data: prefs, error: prefsErr } = await serviceClientInstance.from('user_alert_preferences').select('*').eq('user_id', targetUserId).maybeSingle();
  if (prefsErr) {
    console.error(`[notification-delivery] deliverBatch: user_alert_preferences read FAILED for user ` + `${targetUserId} — delivering WITHOUT their channel opt-outs applied:`, prefsErr);
  }
  const channels = batch.delivery_channels ?? [
    'inapp'
  ];
  let succeeded = 0;
  let failed = 0;
  const attempted = channels.length;
  // DUPLICATE FIX 2026-09-18 — 'inapp' and 'dashboard' are not two
  // destinations: both branches below call sendInappInternal, which inserts
  // one inapp_notifications row. alert_batches.delivery_channels defaults to
  // ['inapp','dashboard'] (inherited from travel_alerts.delivery_channels), so
  // every batch wrote the SAME notification into the user's feed twice. This
  // was invisible until 2026-09-18, because alert-batcher marked batches
  // delivered without ever calling this function, so no batch had ever
  // actually been delivered; the first one that was produced two identical
  // rows. The row is now written once per batch. Both channels still get their
  // own delivery_attempts row marked sent below — they did both "succeed",
  // they just share one surface.
  let inappWritten = false;
  for (const channel of channels){
    // Check preference gate
    if (prefs) {
      if (channel === 'push' && prefs.push_enabled === false) {
        failed++;
        continue;
      }
      if (channel === 'email' && prefs.email_enabled === false) {
        failed++;
        continue;
      }
      if (channel === 'sms' && prefs.sms_enabled === false) {
        failed++;
        continue;
      }
    }
    // Create pending delivery attempt
    const { data: attempt, error: attemptErr } = await serviceClientInstance.from('delivery_attempts').insert({
      batch_id: batch.id,
      user_id: targetUserId,
      channel,
      status: 'pending'
    }).select('id').single();
    if (attemptErr) {
      // 2026-09-19: discarded. Without this row the per-channel status update
      // below silently does nothing, so the delivery record is simply missing.
      console.error(`[notification-delivery] deliverBatch: delivery_attempts insert FAILED for batch ` + `${batch.id} channel ${channel} — this send will not be recorded:`, attemptErr);
    }
    let channelOk = false;
    try {
      if (channel === 'push') {
        const r = await sendPushInternal(serviceClientInstance, targetUserId, batch);
        channelOk = r.sent > 0;
      } else if (channel === 'email') {
        const r = await sendEmailInternal(serviceClientInstance, targetUserId, batch);
        channelOk = r.sent;
      } else if (channel === 'sms') {
        const r = await sendSmsInternal(serviceClientInstance, targetUserId, batch);
        channelOk = r.sent;
      } else if (channel === 'inapp' || channel === 'dashboard') {
        if (!inappWritten) {
          await sendInappInternal(serviceClientInstance, targetUserId, batch);
          inappWritten = true;
        }
        channelOk = true;
      }
    } catch (e) {
      console.error(`[notification-delivery] Channel ${channel} error:`, e);
    }
    if (attempt?.id) {
      await serviceClientInstance.from('delivery_attempts').update({
        status: channelOk ? 'sent' : 'failed',
        attempted_at: new Date().toISOString()
      }).eq('id', attempt.id);
    }
    channelOk ? succeeded++ : failed++;
  }
  // Update batch status
  const newStatus = succeeded > 0 ? 'delivered' : 'failed';
  await serviceClientInstance.from('alert_batches').update({
    status: newStatus
  }).eq('id', batch.id);
  return ok({
    channels_attempted: attempted,
    channels_succeeded: succeeded,
    channels_failed: failed
  });
}
// ─── send_push ─────────────────────────────────────────────────────────
async function sendPushInternal(serviceClientInstance, targetUserId, batch) {
  const { data: tokens, error: tokenErr } = await serviceClientInstance.from('user_push_tokens').select('expo_push_token').eq('user_id', targetUserId).eq('is_active', true);
  // 2026-09-19: the error was discarded, so a failed read fell into the branch
  // below and was recorded against the delivery attempt as the invented reason
  // `no_push_tokens` — a claim that the user has no device registered.
  if (tokenErr) {
    console.error(`[notification-delivery] sendPush: user_push_tokens read FAILED for user ${targetUserId}:`, tokenErr);
    await serviceClientInstance.from('delivery_attempts').update({
      status: 'failed',
      failure_reason: `push_token_lookup_failed: ${tokenErr.message}`,
      attempted_at: new Date().toISOString()
    }).eq('batch_id', batch.id).eq('user_id', targetUserId).eq('channel', 'push').eq('status', 'pending');
    return {
      sent: 0,
      failed: 0,
      error: true
    };
  }
  if (!tokens || tokens.length === 0) {
    await serviceClientInstance.from('delivery_attempts').update({
      status: 'skipped',
      failure_reason: 'no_push_tokens',
      attempted_at: new Date().toISOString()
    }).eq('batch_id', batch.id).eq('user_id', targetUserId).eq('channel', 'push').eq('status', 'pending');
    return {
      sent: 0,
      failed: 0
    };
  }
  const messages = tokens.map((t)=>({
      to: t.expo_push_token,
      title: batch.summary,
      body: batch.alert_count > 1 ? `You have ${batch.alert_count} travel alerts` : batch.summary,
      data: {
        batchId: batch.id,
        tripId: batch.trip_id,
        actionUrl: `/travel-alerts?tripId=${batch.trip_id}`
      },
      sound: 'default',
      priority: 'high',
      badge: 1
    }));
  let sent = 0;
  let failed = 0;
  try {
    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(messages)
    });
    const json = await res.json();
    const results = Array.isArray(json.data) ? json.data : [
      json.data
    ];
    for (const r of results){
      if (r.status === 'ok') sent++;
      else failed++;
    }
    // Update last_used_at
    await serviceClientInstance.from('user_push_tokens').update({
      last_used_at: new Date().toISOString()
    }).eq('user_id', targetUserId).eq('is_active', true);
  } catch (e) {
    console.error('[notification-delivery] Expo push error:', e);
    failed = tokens.length;
  }
  return {
    sent,
    failed
  };
}
// ─── send_email ──────────────────────────────────────────────────────
async function sendEmailInternal(serviceClientInstance, targetUserId, batch) {
  // Get user email
  const { data: userData } = await serviceClientInstance.auth.admin.getUserById(targetUserId);
  const email = userData?.user?.email;
  if (!email) return {
    sent: false
  };
  // Check preferences
  const { data: prefs, error: prefsErr } = await serviceClientInstance.from('user_alert_preferences').select('email_enabled').eq('user_id', targetUserId).maybeSingle();
  if (prefsErr) {
    console.error(`[notification-delivery] sendEmail: user_alert_preferences read FAILED for user ` + `${targetUserId} — sending WITHOUT their email opt-out applied:`, prefsErr);
  }
  if (prefs?.email_enabled === false) return {
    sent: false,
    skipped: true
  };
  const maxPriority = batch.max_priority ?? 'LOW';
  const isCritical = maxPriority === 'CRITICAL';
  const subject = isCritical ? `🚨 ${batch.summary}` : `📢 ${batch.summary}`;
  // Build HTML email.
  // 2026-09-19: this was `(batch.alerts as Array<…>) ?? []`. alert_batches has
  // no `alerts` column, so `alerts` was ALWAYS empty and every alert email ever
  // sent contained zero alert cards — it fell through to the one-line summary
  // fallback below. The rows are now loaded by alert_ids.
  const alerts = await loadBatchAlerts(serviceClientInstance, batch);
  const priorityColor = {
    CRITICAL: '#ef4444',
    HIGH: '#f97316',
    MEDIUM: '#eab308',
    LOW: '#3b82f6'
  };
  const alertCards = alerts.map((a)=>`
    <div style="border-left: 4px solid ${priorityColor[a.priority] ?? '#3b82f6'}; padding: 12px 16px; margin: 8px 0; background: #f9fafb; border-radius: 0 8px 8px 0;">
      <strong style="color: #111827;">${a.title}</strong>
      <p style="color: #374151; margin: 4px 0 0;">${a.message}</p>
      ${a.action_url ? `<a href="${a.action_url}" style="color: #6366f1; font-size: 13px;">View details →</a>` : ''}
    </div>
  `).join('');
  const html = `
    <!DOCTYPE html>
    <html>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #111827;">
      <div style="background: linear-gradient(135deg, #6366f1, #8b5cf6); padding: 24px; border-radius: 12px; margin-bottom: 24px;">
        <h1 style="color: white; margin: 0; font-size: 22px;">✈️ TravelOS Alert</h1>
        <p style="color: rgba(255,255,255,0.85); margin: 8px 0 0;">${batch.summary}</p>
      </div>
      ${alertCards || `<p>${batch.summary}</p>`}
      <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
      <p style="color: #9ca3af; font-size: 12px; text-align: center;">
        <a href="#" style="color: #6366f1;">Manage notification preferences</a> · TravelOS
      </p>
    </body>
    </html>
  `;
  const sendgridKey = Deno.env.get('SENDGRID_API_KEY');
  if (!sendgridKey) {
    console.log(`[notification-delivery] Email would send to ${email}: ${subject}`);
    await serviceClientInstance.from('delivery_attempts').update({
      status: 'skipped',
      failure_reason: 'no_provider_configured',
      attempted_at: new Date().toISOString()
    }).eq('batch_id', batch.id).eq('user_id', targetUserId).eq('channel', 'email').eq('status', 'pending');
    return {
      sent: false,
      skipped: true,
      reason: 'no_provider_configured'
    };
  }
  try {
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${sendgridKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        personalizations: [
          {
            to: [
              {
                email
              }
            ]
          }
        ],
        from: {
          email: 'alerts@travelos.app',
          name: 'TravelOS'
        },
        subject,
        content: [
          {
            type: 'text/html',
            value: html
          }
        ]
      })
    });
    if (res.status >= 200 && res.status < 300) {
      await serviceClientInstance.from('delivery_attempts').update({
        status: 'sent',
        provider: 'sendgrid',
        attempted_at: new Date().toISOString()
      }).eq('batch_id', batch.id).eq('user_id', targetUserId).eq('channel', 'email').eq('status', 'pending');
      return {
        sent: true
      };
    } else {
      const errText = await res.text();
      await serviceClientInstance.from('delivery_attempts').update({
        status: 'failed',
        failure_reason: errText,
        attempted_at: new Date().toISOString()
      }).eq('batch_id', batch.id).eq('user_id', targetUserId).eq('channel', 'email').eq('status', 'pending');
      return {
        sent: false
      };
    }
  } catch (e) {
    console.error('[notification-delivery] SendGrid error:', e);
    return {
      sent: false
    };
  }
}
// ─── send_sms ──────────────────────────────────────────────────────────
async function sendSmsInternal(serviceClientInstance, targetUserId, batch) {
  // Only send for CRITICAL alerts
  if (batch.max_priority !== 'CRITICAL') {
    return {
      sent: false,
      skipped: true,
      reason: 'not_critical'
    };
  }
  // Get verified phone.
  //
  // 2026-09-19: this read `.from('user_profiles').select('phone, phone_verified')
  // .eq('user_id', targetUserId).single()`. `public.user_profiles` DOES NOT
  // EXIST — 42P01, so PostgREST rejected the whole query, `profile` was always
  // null, the error was discarded, and every call returned
  // `no_verified_phone`. The real table is `profiles`: it has `phone` and
  // `phone_verified`, and its key is `id`, not `user_id` (verified against
  // information_schema.columns 2026-09-19). A broken query and a traveler with
  // no phone on file are now four distinguishable outcomes rather than one.
  const { data: profile, error: profileErr } = await serviceClientInstance.from('profiles').select('id, phone, phone_verified').eq('id', targetUserId).maybeSingle();
  if (profileErr) {
    console.error(`[notification-delivery] sendSms: profiles read FAILED for user ${targetUserId} — a CRITICAL ` + `alert SMS could not even be attempted:`, profileErr);
    await serviceClientInstance.from('delivery_attempts').update({
      status: 'failed',
      failure_reason: `profile_lookup_failed: ${profileErr.message}`,
      attempted_at: new Date().toISOString()
    }).eq('batch_id', batch.id).eq('user_id', targetUserId).eq('channel', 'sms').eq('status', 'pending');
    return {
      sent: false,
      error: true,
      reason: 'profile_lookup_failed'
    };
  }
  if (!profile) {
    return {
      sent: false,
      skipped: true,
      reason: 'no_profile'
    };
  }
  if (!profile.phone) {
    return {
      sent: false,
      skipped: true,
      reason: 'no_phone_on_file'
    };
  }
  if (!profile.phone_verified) {
    return {
      sent: false,
      skipped: true,
      reason: 'phone_not_verified'
    };
  }
  // Check preferences
  const { data: prefs, error: prefsErr } = await serviceClientInstance.from('user_alert_preferences').select('sms_enabled, sms_critical_only').eq('user_id', targetUserId).maybeSingle();
  if (prefsErr) {
    console.error(`[notification-delivery] sendSms: user_alert_preferences read FAILED for user ` + `${targetUserId} — sending WITHOUT their SMS opt-out applied:`, prefsErr);
  }
  if (prefs?.sms_enabled === false) return {
    sent: false,
    skipped: true,
    reason: 'sms_disabled'
  };
  const summary = batch.summary ?? '';
  const truncated = summary.length > 120 ? summary.substring(0, 117) + '...' : summary;
  const smsText = `🚨 TravelOS: ${truncated}. Open app to view.`;
  const accountSid = Deno.env.get('TWILIO_ACCOUNT_SID');
  const authToken = Deno.env.get('TWILIO_AUTH_TOKEN');
  const fromPhone = Deno.env.get('TWILIO_PHONE_NUMBER');
  if (!accountSid || !authToken || !fromPhone) {
    console.log(`[notification-delivery] SMS would send to ${profile.phone}: ${smsText}`);
    await serviceClientInstance.from('delivery_attempts').update({
      status: 'skipped',
      failure_reason: 'no_provider_configured',
      attempted_at: new Date().toISOString()
    }).eq('batch_id', batch.id).eq('user_id', targetUserId).eq('channel', 'sms').eq('status', 'pending');
    return {
      sent: false,
      skipped: true,
      reason: 'no_provider_configured'
    };
  }
  try {
    const credentials = btoa(`${accountSid}:${authToken}`);
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        To: profile.phone,
        From: fromPhone,
        Body: smsText
      }).toString()
    });
    const json = await res.json();
    if (json.sid) {
      await serviceClientInstance.from('delivery_attempts').update({
        status: 'sent',
        provider: 'twilio',
        provider_message_id: json.sid,
        attempted_at: new Date().toISOString()
      }).eq('batch_id', batch.id).eq('user_id', targetUserId).eq('channel', 'sms').eq('status', 'pending');
      return {
        sent: true
      };
    } else {
      await serviceClientInstance.from('delivery_attempts').update({
        status: 'failed',
        failure_reason: json.error_message ?? 'unknown',
        attempted_at: new Date().toISOString()
      }).eq('batch_id', batch.id).eq('user_id', targetUserId).eq('channel', 'sms').eq('status', 'pending');
      return {
        sent: false
      };
    }
  } catch (e) {
    console.error('[notification-delivery] Twilio error:', e);
    return {
      sent: false
    };
  }
}
// ─── send_inapp ──────────────────────────────────────────────────────
async function sendInappInternal(serviceClientInstance, targetUserId, batch) {
  // 2026-09-19: `action_items` was `batch.alerts ?? []`. alert_batches has no
  // `alerts` column, so every in-app notification in this project was written
  // with an empty action_items array — the alert list the card is supposed to
  // expand into. Loaded from travel_alerts by alert_ids instead.
  const actionItems = await loadBatchAlerts(serviceClientInstance, batch);
  const { data: notification, error } = await serviceClientInstance.from('inapp_notifications').insert({
    user_id: targetUserId,
    batch_id: batch.id,
    trip_id: batch.trip_id,
    title: batch.summary,
    body: batch.alert_count > 1 ? `You have ${batch.alert_count} travel alerts requiring attention.` : batch.summary,
    theme: batch.theme ?? 'mixed',
    max_priority: batch.max_priority ?? 'LOW',
    action_url: `/travel-alerts?tripId=${batch.trip_id}`,
    action_items: actionItems
  }).select('id').single();
  if (error) throw new Error(error.message);
  await serviceClientInstance.from('delivery_attempts').update({
    status: 'sent',
    provider: 'supabase_realtime',
    attempted_at: new Date().toISOString()
  }).eq('batch_id', batch.id).eq('user_id', targetUserId).in('channel', [
    'inapp',
    'dashboard'
  ]).eq('status', 'pending');
  return {
    notification_id: notification?.id
  };
}
// ─── register_push_token ────────────────────────────────────────────────
async function registerPushToken(serviceClientInstance, userId, body) {
  const { expo_push_token, device_id, platform } = body;
  if (!expo_push_token) return err('Missing expo_push_token');
  const { error } = await serviceClientInstance.from('user_push_tokens').upsert({
    user_id: userId,
    expo_push_token,
    device_id: device_id ?? null,
    platform: platform ?? null,
    is_active: true,
    last_used_at: new Date().toISOString()
  }, {
    onConflict: 'user_id,expo_push_token'
  });
  if (error) return err(error.message);
  return ok({
    registered: true
  });
}
// ─── get_inapp_notifications ────────────────────────────────────────────
async function getInappNotifications(serviceClientInstance, userId, body) {
  const limit = body.limit ?? 50;
  const includeDismissed = body.include_dismissed ?? false;
  let query = serviceClientInstance.from('inapp_notifications').select('*').eq('user_id', userId).order('created_at', {
    ascending: false
  }).limit(limit);
  if (!includeDismissed) {
    query = query.eq('dismissed', false);
  }
  const { data, error } = await query;
  if (error) return err(error.message);
  const unread_count = (data ?? []).filter((n)=>!n.read).length;
  return ok({
    notifications: data ?? [],
    unread_count
  });
}
// ─── mark_read ─────────────────────────────────────────────────────────
async function markRead(serviceClientInstance, userId, body) {
  const now = new Date().toISOString();
  if (body.mark_all === true) {
    const { error } = await serviceClientInstance.from('inapp_notifications').update({
      read: true,
      read_at: now
    }).eq('user_id', userId).eq('read', false);
    if (error) return err(error.message);
    return ok({
      marked_all: true
    });
  }
  const { notification_id } = body;
  if (!notification_id) return err('Missing notification_id or mark_all');
  const { error } = await serviceClientInstance.from('inapp_notifications').update({
    read: true,
    read_at: now
  }).eq('id', notification_id).eq('user_id', userId);
  if (error) return err(error.message);
  return ok({
    marked: true
  });
}
// ─── dismiss_notification ───────────────────────────────────────────────
async function dismissNotification(serviceClientInstance, userId, body) {
  const { notification_id } = body;
  if (!notification_id) return err('Missing notification_id');
  const { error } = await serviceClientInstance.from('inapp_notifications').update({
    dismissed: true,
    dismissed_at: new Date().toISOString()
  }).eq('id', notification_id).eq('user_id', userId);
  if (error) return err(error.message);
  return ok({
    dismissed: true
  });
}
// ─── get_delivery_stats ────────────────────────────────────────────────
async function getDeliveryStats(serviceClientInstance, userId) {
  const { data, error } = await serviceClientInstance.from('delivery_attempts').select('channel, status').eq('user_id', userId);
  if (error) return err(error.message);
  const channels = [
    'push',
    'email',
    'sms',
    'inapp',
    'dashboard'
  ];
  const stats = {};
  for (const ch of channels){
    stats[ch] = {
      sent: 0,
      failed: 0,
      skipped: 0
    };
  }
  for (const row of data ?? []){
    const ch = row.channel;
    const st = row.status;
    if (!stats[ch]) stats[ch] = {
      sent: 0,
      failed: 0,
      skipped: 0
    };
    if (st === 'sent') stats[ch].sent++;
    else if (st === 'failed' || st === 'rate_limited') stats[ch].failed++;
    else if (st === 'skipped') stats[ch].skipped++;
  }
  return ok(stats);
}

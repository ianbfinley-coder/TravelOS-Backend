// SCHEDULED CLEANUP 2026-09-19 — `cleanup_expired` can now be scheduled.
//
// It was gated on `requireService`, i.e. the service-role key alone. That is a
// correct gate but an unschedulable one: putting the service-role key into
// `cron.job.command` would store an all-powerful credential in plaintext in a
// table, which is precisely what the Vault cron-key mechanism exists to avoid.
// So the action was safe and never ran. It now uses the same `authorizeCron`
// gate as `flush_due` — service-role key OR the Vault-held cron key, compared
// inside the database — which is no weaker (the cron key is 32 random bytes
// and grants exactly these two actions) and is schedulable.
//
// It also used to answer `{ cleaned: true }` unconditionally. A delete with no
// `count` returns no rows, so that field was a claim about intent, not a
// report of what happened: a cleanup that matched nothing and a cleanup that
// removed ten thousand rows were indistinguishable, and a monitor reading the
// response could not tell a working job from a broken one. Every statement now
// asks for `count: 'exact'` and the counts are returned.
//
// SCHEDULED FLUSH 2026-09-18 — `flush_due` added, and made safe to run every minute.
//
// Delivery worked (see below) but nothing ever triggered it. `flush_queue` is
// per-user and needs a caller that knows which user to flush; batches carry a
// scheduled_for delay (CRITICAL 0, HIGH 5min, MEDIUM 30min, LOW/INFO 2h) and
// sat `pending` forever because no such caller existed. `flush_due` is the
// missing piece: one service-side sweep across ALL users' due batches.
//
// Authentication for it is deliberately NOT the service-role key in a cron
// command — that would sit in `cron.job.command` in plaintext and grant
// everything. Instead a dedicated random secret lives in Vault and the
// comparison happens inside the database (`public.verify_cron_key`), which
// returns only a boolean. This function never sees the secret; it forwards the
// key it was handed and asks whether it is right. The service-role key is also
// accepted so the sweep can be run by hand.
//
// CONCURRENCY — a run is capped at MAX_BATCHES_PER_RUN, but each batch costs an
// HTTP hop to notification-delivery, so a full run can take longer than the
// one-minute cron interval and overlap its successor. Both runs would then
// select the same `pending` batch and deliver it twice: the user gets the same
// alert twice, which is exactly the duplicate-notification bug fixed in
// notification-delivery v15, reintroduced by a different route. flushOneBatch
// therefore CLAIMS a batch with a conditional update (`.eq('status','pending')`)
// and proceeds only if that update actually matched a row. Losing the claim is
// reported as `skipped`, not `failed`: nothing went wrong, another run simply
// got there first, and counting it as a failure would corrupt the stats.
//
// DELIVERY 2026-09-18 — flush_queue and flush_batch marked batches
// `delivered`, stamped travel_alerts.delivered_at and set
// alert_delivery_log.status = 'sent' WITHOUT EVER SENDING ANYTHING. No push,
// no in-app row, no email: the database simply asserted that delivery had
// happened. notification-delivery's `deliver_batch` action is the real sender
// (it fans out over batch.delivery_channels, honours user_alert_preferences
// and writes delivery_attempts) and was never called from here, so every
// alert this pipeline produced was swallowed while the stats showed 100%
// delivery. See deliverBatchViaNotificationDelivery below.
//
// Two consequences of the old shape are also fixed: the try/catch around the
// flush could never fire, because supabase-js RETURNS `{ error }` rather than
// throwing, so a batch could not be marked `failed` by any code path; and
// `batch_alerts` recovered the ids it had just inserted with a
// status='pending' + order-by-created_at query that could return OTHER
// people's older pending batches instead of the new ones.
//
// SECURITY 2026-09-17 — `cleanup_expired` skipped all authentication and ran
// with a service-role client; because verify_jwt: true only requires SOME
// well-formed JWT (the public anon key qualifies), any caller could trigger a
// global delete across alert_dedup_log and alert_rate_counters and a bulk
// cancel of pending alert_batches for every user. Fixed with requireService,
// now authorizeCron (see the 2026-09-19 note above). The remaining actions
// required a real user JWT with no service-role path, so the pipeline could
// never call them — fixed with requireUserOrService.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { requireUserOrService, serviceClient, timingSafeEqual, SERVICE_ROLE_KEY, SUPABASE_ANON_KEY, SUPABASE_URL } from './_shared/auth.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
// One sweep must finish inside the edge runtime's request budget, so the batch
// count per invocation is bounded. `more: true` in the response says the queue
// was still full at the cap; the next minute's run picks up the remainder.
const MAX_BATCHES_PER_RUN = 50;
const PRIORITY_ORDER = {
  CRITICAL: 5,
  HIGH: 4,
  MEDIUM: 3,
  LOW: 2,
  INFO: 1
};
const PRIORITY_DELAY_MS = {
  CRITICAL: 0,
  HIGH: 5 * 60 * 1000,
  MEDIUM: 30 * 60 * 1000,
  LOW: 120 * 60 * 1000,
  INFO: 120 * 60 * 1000
};
function higherPriority(a, b) {
  return (PRIORITY_ORDER[a] ?? 0) >= (PRIORITY_ORDER[b] ?? 0) ? a : b;
}
async function hashString(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b)=>b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}
function ok(data) {
  return new Response(JSON.stringify({
    success: true,
    data
  }), {
    headers: {
      ...CORS,
      'Content-Type': 'application/json'
    }
  });
}
function err(message, status = 400) {
  return new Response(JSON.stringify({
    success: false,
    error: message
  }), {
    status,
    headers: {
      ...CORS,
      'Content-Type': 'application/json'
    }
  });
}
// ─── real delivery ───────────────────────────────────────────────────────────
async function deliverBatchViaNotificationDelivery(batchId) {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/notification-delivery`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        action: 'deliver_batch',
        batch_id: batchId
      })
    });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch  {
    // non-JSON body (gateway error page); fall through to the raw text
    }
    if (!res.ok || parsed?.success !== true) {
      const detail = parsed?.error ?? text.slice(0, 300);
      return {
        ok: false,
        error: `notification-delivery ${res.status}: ${detail}`
      };
    }
    return {
      ok: true,
      succeeded: Number(parsed.data?.channels_succeeded ?? 0),
      attempted: Number(parsed.data?.channels_attempted ?? 0)
    };
  } catch (e) {
    return {
      ok: false,
      error: `notification-delivery unreachable: ${e instanceof Error ? e.message : String(e)}`
    };
  }
}
// Claims one batch and delivers it. travel_alerts.delivered_at and
// alert_delivery_log are stamped ONLY when at least one channel succeeded —
// they are the audit trail, and writing them on a failed send is what made the
// original bug invisible.
async function flushOneBatch(adminClient, batch) {
  const batchId = batch.id;
  // Conditional claim. `.eq('status','pending')` is what makes concurrent runs
  // safe: whichever run updates first is the only one whose update matches a
  // row, and `.select('id')` is how we learn which one that was.
  const { data: claimed, error: procErr } = await adminClient.from('alert_batches').update({
    status: 'processing',
    updated_at: new Date().toISOString()
  }).eq('id', batchId).eq('status', 'pending').select('id');
  if (procErr) {
    console.error('[alert-batcher] could not claim batch:', procErr.message);
    return {
      delivered: false,
      error: procErr.message
    };
  }
  if (!claimed || claimed.length === 0) {
    console.log(`[alert-batcher] batch ${batchId} already claimed by another run; skipping`);
    return {
      delivered: false,
      skipped: true
    };
  }
  const send = await deliverBatchViaNotificationDelivery(batchId);
  const stamp = new Date().toISOString();
  if (!send.ok || send.succeeded === 0) {
    const reason = send.ok ? `no delivery channel succeeded (${send.attempted} attempted)` : send.error;
    console.error(`[alert-batcher] batch ${batchId} not delivered: ${reason}`);
    await adminClient.from('alert_batches').update({
      status: 'failed',
      last_error: reason,
      updated_at: stamp
    }).eq('id', batchId);
    return {
      delivered: false,
      error: reason
    };
  }
  const alertIds = batch.alert_ids ?? [];
  if (alertIds.length > 0) {
    const { error: alertErr } = await adminClient.from('travel_alerts').update({
      delivered_at: stamp
    }).in('id', alertIds);
    if (alertErr) console.error('[alert-batcher] travel_alerts stamp failed:', alertErr.message);
    const { error: logErr } = await adminClient.from('alert_delivery_log').update({
      status: 'sent',
      sent_at: stamp
    }).in('alert_id', alertIds);
    if (logErr) console.error('[alert-batcher] alert_delivery_log stamp failed:', logErr.message);
  }
  const { error: doneErr } = await adminClient.from('alert_batches').update({
    status: 'delivered',
    delivered_at: stamp,
    updated_at: stamp
  }).eq('id', batchId);
  if (doneErr) console.error('[alert-batcher] could not mark batch delivered:', doneErr.message);
  return {
    delivered: true
  };
}
// Adds one user's flush outcome to alert_queue_stats.
async function bumpQueueStats(adminClient, userId, processed, failed) {
  if (processed === 0 && failed === 0) return;
  const stamp = new Date().toISOString();
  const { data: stats } = await adminClient.from('alert_queue_stats').select('*').eq('user_id', userId).maybeSingle();
  if (stats) {
    await adminClient.from('alert_queue_stats').update({
      total_delivered: (stats.total_delivered ?? 0) + processed,
      total_failed: (stats.total_failed ?? 0) + failed,
      last_flush_at: stamp,
      updated_at: stamp
    }).eq('user_id', userId);
  } else {
    await adminClient.from('alert_queue_stats').insert({
      user_id: userId,
      total_delivered: processed,
      total_failed: failed,
      last_flush_at: stamp
    });
  }
}
/**
 * Authorizes the two service-side actions (`flush_due`, `cleanup_expired`).
 * Accepts either the Vault-held cron key (via `x-cron-key`, verified inside the
 * database so this function never handles the secret) or the service-role key
 * as a bearer, for running either action by hand.
 */ async function authorizeCron(req, adminClient) {
  const bearer = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '').trim();
  if (bearer && timingSafeEqual(bearer, SERVICE_ROLE_KEY)) return true;
  const cronKey = req.headers.get('x-cron-key');
  if (!cronKey) return false;
  const { data, error } = await adminClient.rpc('verify_cron_key', {
    p_key: cronKey
  });
  if (error) {
    console.error('[alert-batcher] verify_cron_key failed:', error.message);
    return false;
  }
  return data === true;
}
// ─── flush_due — the scheduled sweep ──────────────────────────────────────────
async function handleFlushDue(adminClient) {
  const now = new Date().toISOString();
  const { data: batches, error: fetchErr } = await adminClient.from('alert_batches').select('*').eq('status', 'pending').lte('scheduled_for', now).order('scheduled_for', {
    ascending: true
  }).limit(MAX_BATCHES_PER_RUN);
  if (fetchErr) {
    console.error('[alert-batcher] flush_due fetch failed:', fetchErr.message);
    return err(`Failed to fetch due batches: ${fetchErr.message}`, 500);
  }
  const due = batches ?? [];
  if (due.length === 0) {
    return ok({
      scanned: 0,
      processed: 0,
      failed: 0,
      skipped: 0,
      users: 0,
      more: false,
      errors: []
    });
  }
  let processed = 0;
  let failed = 0;
  let skipped = 0;
  const errors = [];
  const perUser = new Map();
  for (const batch of due){
    const userId = batch.user_id;
    const result = await flushOneBatch(adminClient, batch);
    // A skipped batch is not a failure — a concurrent run claimed it, and that
    // run owns its accounting. Counting it here would double-count.
    if (result.skipped) {
      skipped++;
      continue;
    }
    if (!perUser.has(userId)) perUser.set(userId, {
      processed: 0,
      failed: 0
    });
    const tally = perUser.get(userId);
    if (result.delivered) {
      processed++;
      tally.processed++;
    } else {
      failed++;
      tally.failed++;
      if (result.error && errors.length < 5) errors.push(result.error);
    }
  }
  for (const [userId, tally] of perUser){
    await bumpQueueStats(adminClient, userId, tally.processed, tally.failed);
  }
  console.log(`[alert-batcher] flush_due scanned=${due.length} processed=${processed} failed=${failed} skipped=${skipped} users=${perUser.size}`);
  return ok({
    scanned: due.length,
    processed,
    failed,
    skipped,
    users: perUser.size,
    more: due.length === MAX_BATCHES_PER_RUN,
    errors
  });
}
Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: CORS
    });
  }
  const url = new URL(req.url);
  const pathParts = url.pathname.split('/');
  const action = pathParts[pathParts.length - 1];
  // flush_due and cleanup_expired are the two scheduled actions. They share a
  // gate that accepts either the cron key pg_cron presents or a service-role
  // bearer, and must be handled before requireUserOrService below — neither is
  // reachable by a user, however well authenticated.
  if (action === 'flush_due' || action === 'cleanup_expired') {
    const adminClient = serviceClient();
    if (!await authorizeCron(req, adminClient)) {
      return err('Cron key or service key required', 401);
    }
    return action === 'flush_due' ? handleFlushDue(adminClient) : handleCleanupExpired(adminClient);
  }
  const caller = await requireUserOrService(req);
  if (caller instanceof Response) return caller;
  const adminClient = serviceClient();
  let body = {};
  try {
    body = await req.json();
  } catch (_) {
  // empty body is fine for some actions
  }
  let userId;
  if (caller.kind === 'user') {
    userId = caller.userId;
  } else {
    const bodyUserId = body.user_id;
    if (!bodyUserId) return err('user_id is required for service-role calls', 400);
    userId = bodyUserId;
  }
  const userClient = caller.kind === 'user' ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: {
      headers: {
        Authorization: req.headers.get('Authorization')
      }
    }
  }) : adminClient;
  switch(action){
    case 'batch_alerts':
      return handleBatchAlerts(userClient, adminClient, userId, body);
    case 'flush_queue':
      return handleFlushQueue(adminClient, userId);
    case 'flush_batch':
      return handleFlushBatch(adminClient, userId, body);
    case 'cancel_batch':
      return handleCancelBatch(userClient, userId, body);
    case 'get_queue_status':
      return handleGetQueueStatus(userClient, userId);
    case 'check_rate_limit':
      return handleCheckRateLimit(userClient, userId, body);
    default:
      return err(`Unknown action: ${action}`, 404);
  }
});
// ─── batch_alerts ───────────────────────────────────────────────────────────
async function handleBatchAlerts(userClient, adminClient, userId, body) {
  const alertIds = body.alert_ids;
  const tripId = body.trip_id;
  if (!alertIds || !Array.isArray(alertIds) || alertIds.length === 0) {
    return err('alert_ids is required and must be a non-empty array');
  }
  const { data: alerts, error: fetchErr } = await userClient.from('travel_alerts').select('*').in('id', alertIds).eq('user_id', userId);
  if (fetchErr) return err(`Failed to fetch alerts: ${fetchErr.message}`);
  if (!alerts || alerts.length === 0) return err('No matching alerts found');
  let deduplicatedCount = 0;
  let rateLimitedCount = 0;
  const eligibleAlerts = [];
  for (const alert of alerts){
    const contextHash = await hashString(JSON.stringify(alert.context_data ?? {}));
    const fingerprint = `${alert.alert_category}_${contextHash}`;
    const { data: existing } = await adminClient.from('alert_dedup_log').select('*').eq('user_id', userId).eq('fingerprint', fingerprint).gt('expires_at', new Date().toISOString()).maybeSingle();
    if (existing) {
      const existingPriority = PRIORITY_ORDER[existing.priority] ?? 0;
      const newPriority = PRIORITY_ORDER[alert.priority] ?? 0;
      if (existingPriority >= newPriority) {
        deduplicatedCount++;
        continue;
      } else {
        await adminClient.from('alert_dedup_log').update({
          alert_id: alert.id,
          priority: alert.priority,
          expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString()
        }).eq('id', existing.id);
        deduplicatedCount++;
        continue;
      }
    }
    await adminClient.from('alert_dedup_log').insert({
      user_id: userId,
      fingerprint,
      alert_id: alert.id,
      priority: alert.priority,
      expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString()
    });
    eligibleAlerts.push(alert);
  }
  const now = new Date();
  const hourlyWindow = new Date(now);
  hourlyWindow.setMinutes(0, 0, 0);
  const dailyWindow = new Date(now);
  dailyWindow.setHours(0, 0, 0, 0);
  const { data: hourlyCounter } = await adminClient.from('alert_rate_counters').select('*').eq('user_id', userId).eq('window_type', 'hourly').eq('window_start', hourlyWindow.toISOString()).maybeSingle();
  const { data: dailyCounter } = await adminClient.from('alert_rate_counters').select('*').eq('user_id', userId).eq('window_type', 'daily').eq('window_start', dailyWindow.toISOString()).maybeSingle();
  const hourlyCount = hourlyCounter?.alert_count ?? 0;
  const dailyCount = dailyCounter?.alert_count ?? 0;
  const criticalDailyCount = dailyCounter?.critical_count ?? 0;
  const lastAlertAt = hourlyCounter?.last_alert_at ? new Date(hourlyCounter.last_alert_at).getTime() : 0;
  const passedRateLimit = [];
  for (const alert of eligibleAlerts){
    const isCritical = alert.priority === 'CRITICAL';
    const throttled = !isCritical && now.getTime() - lastAlertAt < 60_000;
    if (throttled) {
      rateLimitedCount++;
      continue;
    }
    if (!isCritical && hourlyCount >= 10) {
      rateLimitedCount++;
      continue;
    }
    if (!isCritical && dailyCount >= 50) {
      rateLimitedCount++;
      continue;
    }
    if (isCritical && criticalDailyCount >= 20) {
      rateLimitedCount++;
      continue;
    }
    passedRateLimit.push(alert);
  }
  if (passedRateLimit.length > 0) {
    const criticalPassed = passedRateLimit.filter((a)=>a.priority === 'CRITICAL').length;
    if (hourlyCounter) {
      await adminClient.from('alert_rate_counters').update({
        alert_count: hourlyCounter.alert_count + passedRateLimit.length,
        critical_count: hourlyCounter.critical_count + criticalPassed,
        last_alert_at: now.toISOString()
      }).eq('id', hourlyCounter.id);
    } else {
      await adminClient.from('alert_rate_counters').insert({
        user_id: userId,
        window_type: 'hourly',
        window_start: hourlyWindow.toISOString(),
        alert_count: passedRateLimit.length,
        critical_count: criticalPassed,
        last_alert_at: now.toISOString()
      });
    }
    if (dailyCounter) {
      await adminClient.from('alert_rate_counters').update({
        alert_count: dailyCounter.alert_count + passedRateLimit.length,
        critical_count: dailyCounter.critical_count + criticalPassed,
        last_alert_at: now.toISOString()
      }).eq('id', dailyCounter.id);
    } else {
      await adminClient.from('alert_rate_counters').insert({
        user_id: userId,
        window_type: 'daily',
        window_start: dailyWindow.toISOString(),
        alert_count: passedRateLimit.length,
        critical_count: criticalPassed,
        last_alert_at: now.toISOString()
      });
    }
  }
  const criticalAlerts = passedRateLimit.filter((a)=>a.priority === 'CRITICAL');
  const nonCriticalAlerts = passedRateLimit.filter((a)=>a.priority !== 'CRITICAL');
  const batchesToInsert = [];
  for (const alert of criticalAlerts){
    batchesToInsert.push(buildBatch(userId, tripId, [
      alert
    ], now));
  }
  const groups = {};
  for (const alert of nonCriticalAlerts){
    const day = alert.context_data?.day_number ?? 'x';
    const key = `${alert.alert_category}_${day}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(alert);
  }
  for (const group of Object.values(groups)){
    for(let i = 0; i < group.length; i += 3){
      batchesToInsert.push(buildBatch(userId, tripId, group.slice(i, i + 3), now));
    }
  }
  // ID FIX 2026-09-18 — the ids are taken from the insert itself. The old code
  // re-queried for status='pending' ordered by created_at desc, which returns
  // whatever pending batches happen to be newest for this user — including
  // older ones this call did not create.
  let batchIds = [];
  if (batchesToInsert.length > 0) {
    const { data: insertedBatches, error: insertErr } = await adminClient.from('alert_batches').insert(batchesToInsert).select('id');
    if (insertErr) return err(`Failed to insert batches: ${insertErr.message}`);
    batchIds = (insertedBatches ?? []).map((b)=>b.id);
  }
  // STATS FIX 2026-09-18 — this upsert SET the three counters to this call's
  // numbers instead of adding to them.
  const { data: priorStats } = await adminClient.from('alert_queue_stats').select('total_queued, total_deduplicated, total_rate_limited').eq('user_id', userId).maybeSingle();
  await adminClient.from('alert_queue_stats').upsert({
    user_id: userId,
    total_queued: (priorStats?.total_queued ?? 0) + batchesToInsert.length,
    total_deduplicated: (priorStats?.total_deduplicated ?? 0) + deduplicatedCount,
    total_rate_limited: (priorStats?.total_rate_limited ?? 0) + rateLimitedCount,
    updated_at: now.toISOString()
  }, {
    onConflict: 'user_id',
    ignoreDuplicates: false
  });
  return ok({
    batches_created: batchesToInsert.length,
    deduplicated_count: deduplicatedCount,
    rate_limited_count: rateLimitedCount,
    batch_ids: batchIds
  });
}
function buildBatch(userId, tripId, alerts, now) {
  const maxPriority = alerts.reduce((acc, a)=>higherPriority(acc, a.priority), 'INFO');
  const categories = [
    ...new Set(alerts.map((a)=>a.alert_category))
  ];
  const theme = mapCategoryToTheme(categories.length === 1 ? categories[0] : 'mixed');
  let summary;
  if (alerts.length === 1) {
    summary = alerts[0].title ?? 'Alert';
  } else if (categories.length === 1) {
    summary = `${alerts.length} ${categories[0]} alerts`;
  } else {
    summary = `${alerts.length} alerts need your attention`;
  }
  const topAlert = alerts.reduce((acc, a)=>(PRIORITY_ORDER[a.priority] ?? 0) >= (PRIORITY_ORDER[acc.priority] ?? 0) ? a : acc);
  const deliveryChannels = topAlert.delivery_channels ?? [
    'inapp',
    'dashboard'
  ];
  const delay = PRIORITY_DELAY_MS[maxPriority] ?? PRIORITY_DELAY_MS.LOW;
  const scheduledFor = new Date(now.getTime() + delay).toISOString();
  return {
    user_id: userId,
    trip_id: tripId ?? null,
    theme,
    summary,
    alert_ids: alerts.map((a)=>a.id),
    alert_count: alerts.length,
    max_priority: maxPriority,
    delivery_channels: deliveryChannels,
    scheduled_for: scheduledFor,
    status: 'pending'
  };
}
function mapCategoryToTheme(category) {
  const map = {
    health: 'health',
    friction: 'friction',
    booking: 'bookings',
    bookings: 'bookings',
    disruption: 'disruptions',
    disruptions: 'disruptions',
    reminder: 'reminders',
    reminders: 'reminders',
    suggestion: 'suggestions',
    suggestions: 'suggestions',
    mixed: 'mixed'
  };
  return map[category?.toLowerCase()] ?? 'mixed';
}
// ─── flush_queue ────────────────────────────────────────────────────────────
async function handleFlushQueue(adminClient, userId) {
  const now = new Date().toISOString();
  const { data: batches, error: fetchErr } = await adminClient.from('alert_batches').select('*').eq('user_id', userId).eq('status', 'pending').lte('scheduled_for', now);
  if (fetchErr) return err(`Failed to fetch batches: ${fetchErr.message}`);
  if (!batches || batches.length === 0) return ok({
    processed: 0,
    failed: 0,
    skipped: 0
  });
  let processed = 0;
  let failed = 0;
  let skipped = 0;
  const errors = [];
  for (const batch of batches){
    const result = await flushOneBatch(adminClient, batch);
    if (result.skipped) skipped++;
    else if (result.delivered) processed++;
    else {
      failed++;
      if (result.error && errors.length < 5) errors.push(result.error);
    }
  }
  await bumpQueueStats(adminClient, userId, processed, failed);
  return ok({
    processed,
    failed,
    skipped,
    errors
  });
}
// ─── flush_batch ────────────────────────────────────────────────────────────
async function handleFlushBatch(adminClient, userId, body) {
  const batchId = body.batch_id;
  if (!batchId) return err('batch_id is required');
  const { data: batch, error: fetchErr } = await adminClient.from('alert_batches').select('*').eq('id', batchId).eq('user_id', userId).maybeSingle();
  if (fetchErr || !batch) return err('Batch not found');
  if (batch.status !== 'pending') return err(`Batch is not pending (status: ${batch.status})`);
  const result = await flushOneBatch(adminClient, batch);
  if (result.skipped) {
    return err('Batch was already claimed by the scheduled sweep', 409);
  }
  await bumpQueueStats(adminClient, userId, result.delivered ? 1 : 0, result.delivered ? 0 : 1);
  if (!result.delivered) {
    return err(`Failed to flush batch: ${result.error ?? 'unknown'}`, 502);
  }
  return ok({
    processed: 1,
    failed: 0,
    batch_id: batchId
  });
}
// ─── cancel_batch ─────────────────────────────────────────────────────────
async function handleCancelBatch(userClient, userId, body) {
  const batchId = body.batch_id;
  if (!batchId) return err('batch_id is required');
  const { data: batch, error: fetchErr } = await userClient.from('alert_batches').select('id, status').eq('id', batchId).eq('user_id', userId).maybeSingle();
  if (fetchErr || !batch) return err('Batch not found');
  if (batch.status !== 'pending') return err(`Cannot cancel batch with status: ${batch.status}`);
  const { error: updateErr } = await userClient.from('alert_batches').update({
    status: 'cancelled',
    updated_at: new Date().toISOString()
  }).eq('id', batchId);
  if (updateErr) return err(`Failed to cancel batch: ${updateErr.message}`);
  return ok({
    cancelled: true,
    batch_id: batchId
  });
}
// ─── get_queue_status ──────────────────────────────────────────────────────
async function handleGetQueueStatus(userClient, userId) {
  const now = new Date();
  const [{ data: pendingBatches }, { data: stats }] = await Promise.all([
    userClient.from('alert_batches').select('*').eq('user_id', userId).eq('status', 'pending').order('scheduled_for', {
      ascending: true
    }),
    userClient.from('alert_queue_stats').select('*').eq('user_id', userId).maybeSingle()
  ]);
  const rateLimitStatus = await computeRateLimitStatus(userClient, userId, now, 'LOW');
  return ok({
    pending_batches: pendingBatches ?? [],
    stats: stats ?? null,
    rate_limit_status: rateLimitStatus
  });
}
// ─── check_rate_limit ─────────────────────────────────────────────────────
async function handleCheckRateLimit(userClient, userId, body) {
  const priority = body.priority ?? 'LOW';
  const now = new Date();
  const status = await computeRateLimitStatus(userClient, userId, now, priority);
  return ok(status);
}
async function computeRateLimitStatus(client, userId, now, priority) {
  const hourlyWindow = new Date(now);
  hourlyWindow.setMinutes(0, 0, 0);
  const dailyWindow = new Date(now);
  dailyWindow.setHours(0, 0, 0, 0);
  const [{ data: hourly }, { data: daily }] = await Promise.all([
    client.from('alert_rate_counters').select('*').eq('user_id', userId).eq('window_type', 'hourly').eq('window_start', hourlyWindow.toISOString()).maybeSingle(),
    client.from('alert_rate_counters').select('*').eq('user_id', userId).eq('window_type', 'daily').eq('window_start', dailyWindow.toISOString()).maybeSingle()
  ]);
  const hourlyCount = hourly?.alert_count ?? 0;
  const dailyCount = daily?.alert_count ?? 0;
  const criticalDailyCount = daily?.critical_count ?? 0;
  const lastAlertAt = hourly?.last_alert_at ? new Date(hourly.last_alert_at).getTime() : 0;
  const isCritical = priority === 'CRITICAL';
  const throttleMs = !isCritical ? Math.max(0, 60_000 - (now.getTime() - lastAlertAt)) : 0;
  let allowed = true;
  let reason;
  if (!isCritical && hourlyCount >= 10) {
    allowed = false;
    reason = 'hourly_limit_reached';
  } else if (!isCritical && dailyCount >= 50) {
    allowed = false;
    reason = 'daily_limit_reached';
  } else if (isCritical && criticalDailyCount >= 20) {
    allowed = false;
    reason = 'critical_daily_limit_reached';
  } else if (throttleMs > 0) {
    allowed = false;
    reason = 'throttled';
  }
  return {
    allowed,
    reason: reason ?? null,
    hourly_remaining: Math.max(0, 10 - hourlyCount),
    daily_remaining: Math.max(0, 50 - dailyCount),
    critical_daily_remaining: Math.max(0, 20 - criticalDailyCount),
    throttle_ms: throttleMs
  };
}
// ─── cleanup_expired ──────────────────────────────────────────────────────
// Every statement asks for an exact count and the counts are returned, so the
// caller — and the health check that reads the cron response — can tell a run
// that did nothing from a run that did not happen.
async function handleCleanupExpired(adminClient) {
  const now = new Date();
  const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const [dedupResult, counterResult, batchResult] = await Promise.all([
    adminClient.from('alert_dedup_log').delete({
      count: 'exact'
    }).lte('expires_at', now.toISOString()),
    adminClient.from('alert_rate_counters').delete({
      count: 'exact'
    }).lt('window_start', twoDaysAgo),
    adminClient.from('alert_batches').update({
      status: 'cancelled',
      updated_at: now.toISOString()
    }, {
      count: 'exact'
    }).eq('status', 'pending').lt('scheduled_for', oneDayAgo)
  ]);
  const errors = [
    dedupResult.error,
    counterResult.error,
    batchResult.error
  ].filter(Boolean);
  if (errors.length > 0) {
    const detail = errors.map((e)=>e?.message).join(', ');
    console.error('[alert-batcher] cleanup_expired failed:', detail);
    return err(`Cleanup errors: ${detail}`, 500);
  }
  const summary = {
    cleaned: true,
    dedup_rows_deleted: dedupResult.count ?? 0,
    rate_counter_rows_deleted: counterResult.count ?? 0,
    stale_batches_cancelled: batchResult.count ?? 0,
    timestamp: now.toISOString()
  };
  console.log(`[alert-batcher] cleanup_expired dedup=${summary.dedup_rows_deleted} counters=${summary.rate_counter_rows_deleted} batches=${summary.stale_batches_cancelled}`);
  return ok(summary);
}

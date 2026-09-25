// alert-notifier — Q2.19, 2026-09-19.
//
// The monitors detect. Until now nothing notified: `api_alerts` rows were
// written and waited to be looked at, which for a one-person project means
// they waited forever. This is the exit.
//
// THREE RULES SHAPE IT.
//
// 1. It must not depend on the pipeline it watches. It talks to a transactional
//    mail provider over plain HTTPS. It does not touch `alert-batcher`,
//    `notification-delivery`, `travel_alerts` or any of the tables those use.
//    If the alert pipeline is completely dead, this still sends.
//
// 2. `notified_at` is stamped only after the provider returns 2xx AND an id.
//    Stamping on attempt would be the same defect this project has now found
//    four times — a column asserting that delivery happened. If the send
//    fails, nothing is stamped and the next run retries the same alerts.
//
// 3. It has to be able to announce its own death, and it is the one component
//    the alert system cannot watch, because it IS the way out. Nothing inside
//    the system can tell you the exit is blocked. So it sends a HEARTBEAT: a
//    short "still running" email once a week. Silence for more than a week
//    means this is broken, and that is the only signal that works.
//
// Configuration: RESEND_API_KEY and ALERT_EMAIL_TO. Optional ALERT_EMAIL_FROM
// (defaults to Resend's shared sender, which can only deliver to the account
// owner — fine here, and it needs no verified domain). While unconfigured the
// function returns 503 and records itself as `degraded` in api_service_health;
// it does NOT raise an api_alerts row for its own misconfiguration, because
// that row could not be emailed either and would just be noise in the table.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
const ALERT_EMAIL_TO = Deno.env.get('ALERT_EMAIL_TO');
const ALERT_EMAIL_FROM = Deno.env.get('ALERT_EMAIL_FROM') ?? 'TravelOS Alerts <onboarding@resend.dev>';
const HEARTBEAT_INTERVAL_HOURS = 168; // one week
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
function ok(data, status = 200) {
  return new Response(JSON.stringify({
    success: true,
    data
  }), {
    status,
    headers: {
      ...CORS,
      'Content-Type': 'application/json'
    }
  });
}
function err(error, status = 400, extra = {}) {
  return new Response(JSON.stringify({
    success: false,
    error,
    ...extra
  }), {
    status,
    headers: {
      ...CORS,
      'Content-Type': 'application/json'
    }
  });
}
function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for(let i = 0; i < len; i++)diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}
// Same gate as flush_due and cleanup_expired: the Vault-held cron key compared
// inside the database, or the service-role key for a manual run.
async function authorizeCron(req, admin) {
  const bearer = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '').trim();
  if (bearer && timingSafeEqual(bearer, SERVICE_ROLE_KEY)) return true;
  const cronKey = req.headers.get('x-cron-key');
  if (!cronKey) return false;
  const { data, error } = await admin.rpc('verify_cron_key', {
    p_key: cronKey
  });
  if (error) {
    console.error('[alert-notifier] verify_cron_key failed:', error.message);
    return false;
  }
  return data === true;
}
async function recordHealth(admin, status, note) {
  const now = new Date().toISOString();
  const { error } = await admin.from('api_service_health').upsert({
    service: 'alert-notifier',
    status,
    consecutive_failures: status === 'healthy' ? 0 : 1,
    last_success_at: status === 'healthy' ? now : null,
    last_failure_at: status === 'healthy' ? null : now,
    updated_at: now
  }, {
    onConflict: 'service'
  });
  if (error) console.error('[alert-notifier] could not record health:', error.message);
  console.log(`[alert-notifier] ${status}: ${note}`);
}
async function sendEmail(subject, text) {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: ALERT_EMAIL_FROM,
        to: [
          ALERT_EMAIL_TO
        ],
        subject,
        text
      })
    });
    const body = await res.text();
    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch  {}
    if (!res.ok) {
      // Never return the provider's raw body to the caller: it echoes request
      // headers on some error paths. Log it, summarise it.
      console.error(`[alert-notifier] provider ${res.status}: ${body.slice(0, 400)}`);
      return {
        ok: false,
        error: `mail provider returned ${res.status}${parsed?.name ? ` (${parsed.name})` : ''}`
      };
    }
    if (!parsed?.id) {
      console.error(`[alert-notifier] provider 2xx with no id: ${body.slice(0, 400)}`);
      return {
        ok: false,
        error: 'mail provider accepted the request but returned no message id'
      };
    }
    return {
      ok: true,
      id: parsed.id
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[alert-notifier] provider unreachable:', message);
    return {
      ok: false,
      error: `mail provider unreachable: ${message}`
    };
  }
}
function formatAlerts(alerts) {
  const critical = alerts.filter((a)=>a.severity === 'critical').length;
  const lead = critical > 0 ? `${critical} critical` : `${alerts.length} ${alerts.length === 1 ? 'alert' : 'alerts'}`;
  const subject = `TravelOS: ${lead}${critical > 0 && alerts.length > critical ? ` and ${alerts.length - critical} more` : ''}`;
  const lines = [];
  lines.push(`${alerts.length} unresolved ${alerts.length === 1 ? 'alert' : 'alerts'} on TravelOS.`);
  lines.push('');
  for (const a of alerts){
    lines.push(`[${String(a.severity).toUpperCase()}] ${a.service ?? 'unknown service'} — ${a.kind}`);
    lines.push(`  ${a.message}`);
    lines.push(`  raised ${a.created_at}`);
    const details = a.details;
    const problems = details?.problems;
    if (Array.isArray(problems) && problems.length > 0) {
      for (const p of problems)lines.push(`  • ${p}`);
    }
    lines.push(`  id ${a.id}`);
    lines.push('');
  }
  lines.push('These resolve themselves when the underlying check passes again;');
  lines.push('you will not get a second email for the same alert.');
  lines.push('');
  lines.push('Open alerts: select * from public.api_alerts where resolved_at is null;');
  return {
    subject,
    text: lines.join('\n')
  };
}
async function maybeHeartbeat(admin) {
  const { data: row, error } = await admin.from('api_service_health').select('last_success_at').eq('service', 'alert-notifier-heartbeat').maybeSingle();
  if (error) {
    console.error('[alert-notifier] heartbeat lookup failed:', error.message);
    return {
      heartbeat: 'lookup_failed'
    };
  }
  const last = row?.last_success_at ? new Date(row.last_success_at).getTime() : 0;
  const dueAt = last + HEARTBEAT_INTERVAL_HOURS * 3600 * 1000;
  if (Date.now() < dueAt) return {
    heartbeat: 'not_due'
  };
  const sent = await sendEmail('TravelOS: alert delivery is alive', [
    'Weekly heartbeat from alert-notifier.',
    '',
    'Nothing is wrong. This email exists so that silence means something:',
    'alert-notifier is the way alerts leave the system, so nothing inside the',
    'system can tell you when it stops working. If more than a week goes by',
    'with no email of any kind from TravelOS, assume this is broken and check',
    '  select * from public.api_service_health where service like \'alert-notifier%\';',
    '',
    `Sent ${new Date().toISOString()}.`
  ].join('\n'));
  if (!sent.ok) return {
    heartbeat: 'failed',
    heartbeat_error: sent.error
  };
  const now = new Date().toISOString();
  await admin.from('api_service_health').upsert({
    service: 'alert-notifier-heartbeat',
    status: 'healthy',
    consecutive_failures: 0,
    last_success_at: now,
    updated_at: now
  }, {
    onConflict: 'service'
  });
  return {
    heartbeat: 'sent',
    heartbeat_id: sent.id
  };
}
Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') return new Response(null, {
    headers: CORS
  });
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  if (!await authorizeCron(req, admin)) {
    return err('Cron key or service key required', 401);
  }
  if (!RESEND_API_KEY || !ALERT_EMAIL_TO) {
    const missing = [
      RESEND_API_KEY ? null : 'RESEND_API_KEY',
      ALERT_EMAIL_TO ? null : 'ALERT_EMAIL_TO'
    ].filter(Boolean);
    await recordHealth(admin, 'degraded', `email not configured; missing ${missing.join(' and ')}`);
    return err('email_not_configured', 503, {
      missing
    });
  }
  const { data: alerts, error: fetchErr } = await admin.from('api_alerts').select('id, severity, kind, service, message, details, created_at').is('resolved_at', null).is('notified_at', null).order('created_at', {
    ascending: true
  }).limit(25);
  if (fetchErr) {
    await recordHealth(admin, 'down', `could not read api_alerts: ${fetchErr.message}`);
    return err(`Failed to read alerts: ${fetchErr.message}`, 500);
  }
  const pending = alerts ?? [];
  if (pending.length === 0) {
    const beat = await maybeHeartbeat(admin);
    await recordHealth(admin, 'healthy', `nothing to send (${beat.heartbeat})`);
    return ok({
      sent: 0,
      alerts: 0,
      ...beat
    });
  }
  const { subject, text } = formatAlerts(pending);
  const sent = await sendEmail(subject, text);
  if (!sent.ok) {
    // Nothing is stamped. The next run retries these same alerts.
    await recordHealth(admin, 'down', `send failed: ${sent.error}`);
    return err(`send_failed: ${sent.error}`, 502, {
      alerts: pending.length
    });
  }
  const now = new Date().toISOString();
  const { error: stampErr, count } = await admin.from('api_alerts').update({
    notified_at: now
  }, {
    count: 'exact'
  }).in('id', pending.map((a)=>a.id));
  if (stampErr) {
    // The mail went out. Say so loudly — the next run will send it again,
    // which is the right way round: a duplicate email beats a silent one.
    console.error('[alert-notifier] sent but could not stamp notified_at:', stampErr.message);
    await recordHealth(admin, 'degraded', `sent ${pending.length} but notified_at not stamped`);
    return ok({
      sent: pending.length,
      message_id: sent.id,
      stamped: 0,
      warning: stampErr.message
    });
  }
  const beat = await maybeHeartbeat(admin);
  await recordHealth(admin, 'healthy', `emailed ${pending.length} alert(s), id ${sent.id}`);
  return ok({
    sent: pending.length,
    stamped: count ?? 0,
    message_id: sent.id,
    ...beat
  });
});

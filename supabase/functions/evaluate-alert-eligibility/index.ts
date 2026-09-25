// 2026-09-25 — update_preferences 42P10 fix (wave 6b).
// The global-preferences branch (trip_id null) upserted with
// onConflict: 'user_id'. alert_preferences has no unique index on user_id
// alone — only the PARTIAL index idx_alert_preferences_user_global (WHERE
// trip_id IS NULL), which ON CONFLICT (user_id) cannot infer — so every save
// of global alert preferences failed with 42P10. The table already carries
// alert_preferences_user_trip_key UNIQUE NULLS NOT DISTINCT (user_id, trip_id),
// which covers both the global (NULL trip) and per-trip rows, so both branches
// now upsert onConflict 'user_id,trip_id'. Verified in a BEGIN…ROLLBACK dry
// run: ON CONFLICT (user_id) -> 42P10; ON CONFLICT (user_id, trip_id) with
// trip_id NULL inserts once and then updates the same row. No migration.
// SECURITY 2026-09-17 —
// This function decoded the caller's JWT itself (real decode via
// auth.getUser, not just a header-presence check) but never accepted a
// service-role caller. generate-alert's fire-and-forget call into this
// function (Authorization: Bearer <service role key>) was therefore failing
// auth and returning 401, silently swallowed by generate-alert's
// `.catch(() => {})` — eligibility evaluation for pipeline-created alerts
// was never actually running.
//
// Separately, the eligibility-evaluation branch trusted `trip_id` straight
// off the request body when writing the `notification_eligibility` row and
// when logging a preference-load failure, instead of using the trip_id on
// the alert row it had just verified ownership of. A caller who owned alert
// X (on their own trip A) could pass an arbitrary trip_id for a trip they do
// not own and have it recorded against their own eligibility row. It did
// not allow writing into `travel_alerts` or `alert_delivery_log` for a trip
// the caller does not own, but it is a caller-controlled identifier landing
// in a row without being checked, which is the same class of bug — fixed by
// always using the verified alert's own trip_id.
//
// update_preferences also let a user upsert an alert_preferences row for any
// trip_id, without checking they own that trip. Not a cross-tenant read/write
// (the row is still keyed to the caller's own user_id), but it let a caller
// attach preferences to a trip that is not theirs. Fixed by requiring trip
// ownership when a trip_id is given.
//
// Fix: replaced the hand-rolled gate with requireUserOrService. Service
// callers pass through untouched (trusted internal caller). User callers are
// identified only by caller.userId; the alert is fetched and ownership
// verified via .eq('user_id', callerId) before any read of preferences or
// write to notification_eligibility, and every value written comes from the
// alert row itself, never the request body. Ownership failures return 404.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { requireUserOrService, requireTripOwner, serviceClient } from "./_shared/auth.ts";
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
function ok(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json'
    }
  });
}
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const PRIORITY_ORDER = {
  INFO: 0,
  LOW: 1,
  HIGH: 2,
  CRITICAL: 3
};
// ── Safe failure logger — never throws ───────────────────────────────────────────────
async function logRecovery(params) {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/pipeline-recovery`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`
      },
      body: JSON.stringify({
        action: 'log_failure',
        ...params
      })
    });
    if (res.ok) {
      const data = await res.json();
      return data.recovery_log_id ?? null;
    }
    return null;
  } catch  {
    return null;
  }
}
function isInQuietPeriod(now, start, end, _tz) {
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const [startH, startM] = start.split(':').map(Number);
  const [endH, endM] = end.split(':').map(Number);
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;
  if (startMinutes <= endMinutes) {
    return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  } else {
    return nowMinutes >= startMinutes || nowMinutes < endMinutes;
  }
}
function getQuietPeriodEnd(now, endTime, _tz) {
  const [endH, endM] = endTime.split(':').map(Number);
  const end = new Date(now);
  end.setHours(endH, endM, 0, 0);
  if (end <= now) end.setDate(end.getDate() + 1);
  return end.toISOString();
}
function evaluateEligibility(alert, prefs) {
  // 1. Resolved/expired alerts are never eligible
  const status = alert.status;
  if (status === 'RESOLVED' || status === 'EXPIRED' || status === 'SUPERSEDED') {
    return {
      eligible: false,
      reason: 'ALERT_RESOLVED',
      defer_until: null
    };
  }
  const isCritical = alert.priority === 'CRITICAL';
  // 2. Check minimum priority threshold
  const alertPriority = PRIORITY_ORDER[alert.priority] ?? 0;
  const minPriority = PRIORITY_ORDER[prefs.minimum_priority] ?? 1;
  if (alertPriority < minPriority && !isCritical) {
    return {
      eligible: false,
      reason: 'BELOW_USER_THRESHOLD',
      defer_until: null
    };
  }
  // 3. Check informational alerts setting
  if (alert.priority === 'INFO' && !prefs.informational_alerts_enabled) {
    return {
      eligible: false,
      reason: 'USER_DISABLED',
      defer_until: null
    };
  }
  // 4. Check enabled alert types
  if (prefs.enabled_alert_types && prefs.enabled_alert_types.length > 0) {
    if (!prefs.enabled_alert_types.includes(alert.alert_type)) {
      return {
        eligible: false,
        reason: 'USER_DISABLED',
        defer_until: null
      };
    }
  }
  // 5. Check confidence gate
  if (alert.confidence === 'UNKNOWN' && alert.priority !== 'CRITICAL') {
    return {
      eligible: false,
      reason: 'LOW_CONFIDENCE',
      confidence_gate_applied: true,
      defer_until: null
    };
  }
  // 6. Check quiet period
  if (prefs.quiet_period_enabled && prefs.quiet_period_start && prefs.quiet_period_end) {
    const now = new Date();
    const tz = prefs.quiet_period_timezone || 'UTC';
    const isQuiet = isInQuietPeriod(now, prefs.quiet_period_start, prefs.quiet_period_end, tz);
    if (isQuiet) {
      if (isCritical && alert.urgency === 'IMMEDIATE') {
      // Allow through
      } else {
        const deferUntil = getQuietPeriodEnd(now, prefs.quiet_period_end, tz);
        return {
          eligible: false,
          reason: 'QUIET_PERIOD',
          quiet_period_applied: true,
          defer_until: deferUntil
        };
      }
    }
  }
  // 7. Determine preferred channel (in_app always available)
  const preferred_channel = 'IN_APP';
  return {
    eligible: true,
    reason: 'ELIGIBLE',
    preferred_channel,
    eligible_at: new Date().toISOString(),
    defer_until: null
  };
}
function defaultPreferences() {
  return {
    sensitivity: 'BALANCED',
    minimum_priority: 'LOW',
    minimum_urgency: 'NOT_URGENT',
    informational_alerts_enabled: true,
    critical_alerts_enabled: true,
    enabled_alert_types: null,
    quiet_period_enabled: false,
    quiet_period_start: null,
    quiet_period_end: null,
    quiet_period_timezone: 'UTC',
    push_enabled: false,
    sms_enabled: false,
    email_enabled: false,
    in_app_enabled: true
  };
}
function mergePreferences(global, tripSpecific) {
  const base = defaultPreferences();
  const merged = {
    ...base
  };
  if (global) {
    Object.assign(merged, {
      sensitivity: global.sensitivity ?? merged.sensitivity,
      minimum_priority: global.minimum_priority ?? merged.minimum_priority,
      minimum_urgency: global.minimum_urgency ?? merged.minimum_urgency,
      informational_alerts_enabled: global.informational_alerts_enabled ?? merged.informational_alerts_enabled,
      critical_alerts_enabled: global.critical_alerts_enabled ?? merged.critical_alerts_enabled,
      enabled_alert_types: global.enabled_alert_types ?? merged.enabled_alert_types,
      quiet_period_enabled: global.quiet_period_enabled ?? merged.quiet_period_enabled,
      quiet_period_start: global.quiet_period_start ?? merged.quiet_period_start,
      quiet_period_end: global.quiet_period_end ?? merged.quiet_period_end,
      quiet_period_timezone: global.quiet_period_timezone ?? merged.quiet_period_timezone,
      push_enabled: global.push_enabled ?? merged.push_enabled,
      sms_enabled: global.sms_enabled ?? merged.sms_enabled,
      email_enabled: global.email_enabled ?? merged.email_enabled,
      in_app_enabled: global.in_app_enabled ?? merged.in_app_enabled
    });
  }
  if (tripSpecific) {
    if (tripSpecific.sensitivity != null) merged.sensitivity = tripSpecific.sensitivity;
    if (tripSpecific.minimum_priority != null) merged.minimum_priority = tripSpecific.minimum_priority;
    if (tripSpecific.minimum_urgency != null) merged.minimum_urgency = tripSpecific.minimum_urgency;
    if (tripSpecific.informational_alerts_enabled != null) merged.informational_alerts_enabled = tripSpecific.informational_alerts_enabled;
    if (tripSpecific.critical_alerts_enabled != null) merged.critical_alerts_enabled = tripSpecific.critical_alerts_enabled;
    if (tripSpecific.enabled_alert_types != null) merged.enabled_alert_types = tripSpecific.enabled_alert_types;
    if (tripSpecific.quiet_period_enabled != null) merged.quiet_period_enabled = tripSpecific.quiet_period_enabled;
    if (tripSpecific.quiet_period_start != null) merged.quiet_period_start = tripSpecific.quiet_period_start;
    if (tripSpecific.quiet_period_end != null) merged.quiet_period_end = tripSpecific.quiet_period_end;
    if (tripSpecific.quiet_period_timezone != null) merged.quiet_period_timezone = tripSpecific.quiet_period_timezone;
    if (tripSpecific.push_enabled != null) merged.push_enabled = tripSpecific.push_enabled;
    if (tripSpecific.sms_enabled != null) merged.sms_enabled = tripSpecific.sms_enabled;
    if (tripSpecific.email_enabled != null) merged.email_enabled = tripSpecific.email_enabled;
    if (tripSpecific.in_app_enabled != null) merged.in_app_enabled = tripSpecific.in_app_enabled;
  }
  return merged;
}
Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS
    });
  }
  const caller = await requireUserOrService(req);
  if (caller instanceof Response) return caller;
  const supabase = serviceClient();
  const url = new URL(req.url);
  // ── GET: fetch preferences (user-only) ────────────────────────────────────
  if (req.method === 'GET') {
    if (caller.kind !== 'user') return ok({
      error: 'Unauthorized'
    }, 401);
    const userId = caller.userId;
    const trip_id = url.searchParams.get('trip_id');
    const { data: globalPrefs } = await supabase.from('alert_preferences').select('*').eq('user_id', userId).is('trip_id', null).maybeSingle();
    let tripPrefs = null;
    if (trip_id) {
      const { data } = await supabase.from('alert_preferences').select('*').eq('user_id', userId).eq('trip_id', trip_id).maybeSingle();
      tripPrefs = data;
    }
    const merged = mergePreferences(globalPrefs, tripPrefs);
    return ok({
      global: globalPrefs ?? null,
      trip_specific: tripPrefs ?? null,
      merged
    });
  }
  // ── POST ────────────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    let body;
    try {
      body = await req.json();
    } catch  {
      return ok({
        error: 'Invalid JSON body'
      }, 400);
    }
    // ── update_preferences action (user-only) ────────────────────────
    if (body.action === 'update_preferences') {
      if (caller.kind !== 'user') return ok({
        error: 'Unauthorized'
      }, 401);
      const userId = caller.userId;
      const trip_id = body.trip_id ?? null;
      if (trip_id !== null) {
        const ownerCheck = await requireTripOwner(supabase, trip_id, userId);
        if (ownerCheck instanceof Response) return ownerCheck;
      }
      const prefFields = {
        user_id: userId,
        trip_id
      };
      const allowedFields = [
        'sensitivity',
        'minimum_priority',
        'minimum_urgency',
        'informational_alerts_enabled',
        'critical_alerts_enabled',
        'enabled_alert_types',
        'quiet_period_enabled',
        'quiet_period_start',
        'quiet_period_end',
        'quiet_period_timezone',
        'push_enabled',
        'sms_enabled',
        'email_enabled',
        'in_app_enabled'
      ];
      for (const field of allowedFields){
        if (body[field] !== undefined) {
          prefFields[field] = body[field];
        }
      }
      let upsertResult;
      if (trip_id === null) {
        upsertResult = await supabase.from('alert_preferences').upsert(prefFields, {
          onConflict: 'user_id,trip_id',
          ignoreDuplicates: false
        }) // 2026-09-25: was 'user_id' -> 42P10
        .select().single();
      } else {
        upsertResult = await supabase.from('alert_preferences').upsert(prefFields, {
          onConflict: 'user_id,trip_id',
          ignoreDuplicates: false
        }).select().single();
      }
      if (upsertResult.error) {
        return ok({
          error: upsertResult.error.message
        }, 500);
      }
      return ok({
        success: true,
        preferences: upsertResult.data
      });
    }
    // ── evaluate eligibility for an alert (user OR trusted service caller) ──
    const { alert_id } = body;
    if (!alert_id) {
      return ok({
        error: 'alert_id is required'
      }, 400);
    }
    // Fetch the alert. A user caller may only evaluate their own alert; a
    // service caller (the pipeline) is trusted and may evaluate any alert.
    // Every identifier used below (trip_id, monitoring_event_id, user_id)
    // comes from this row, never from the request body.
    let alertQuery = supabase.from('travel_alerts').select('*').eq('id', alert_id);
    if (caller.kind === 'user') {
      alertQuery = alertQuery.eq('user_id', caller.userId);
    }
    const { data: alert, error: alertErr } = await alertQuery.maybeSingle();
    if (alertErr || !alert) {
      return ok({
        error: 'Alert not found or access denied'
      }, 404);
    }
    const ownerUserId = alert.user_id;
    const tripId = alert.trip_id;
    // Fetch global preferences — if this fails, fail SAFE (not eligible)
    let globalPrefs = null;
    let tripPrefs = null;
    let prefsLoadFailed = false;
    try {
      const { data: gp, error: gpErr } = await supabase.from('alert_preferences').select('*').eq('user_id', ownerUserId).is('trip_id', null).maybeSingle();
      if (gpErr) {
        prefsLoadFailed = true;
        console.error('[evaluate-alert-eligibility] Failed to load global preferences:', gpErr);
      } else {
        globalPrefs = gp;
      }
      const { data: tp, error: tpErr } = await supabase.from('alert_preferences').select('*').eq('user_id', ownerUserId).eq('trip_id', tripId).maybeSingle();
      if (tpErr) {
        console.error('[evaluate-alert-eligibility] Failed to load trip preferences:', tpErr);
      // Non-fatal — continue with global prefs only
      } else {
        tripPrefs = tp;
      }
    } catch (e) {
      prefsLoadFailed = true;
      console.error('[evaluate-alert-eligibility] Exception loading preferences:', e);
    }
    // If preferences failed to load — fail SAFE: not eligible
    if (prefsLoadFailed) {
      const now = new Date().toISOString();
      const safeEligibilityRecord = {
        user_id: ownerUserId,
        trip_id: tripId,
        alert_id,
        monitoring_event_id: alert.monitoring_event_id ?? null,
        eligible: false,
        eligibility_reason: 'PROCESSING_FAILED',
        priority: alert.priority,
        urgency: alert.urgency,
        preferred_channel: 'IN_APP',
        eligible_at: null,
        defer_until: null,
        quiet_period_applied: false,
        duplicate_suppressed: false,
        confidence_gate_applied: false,
        preferences_snapshot: null,
        suppressed: true,
        evaluated_at: now
      };
      // Upsert safe failure state
      const { data: existingElig } = await supabase.from('notification_eligibility').select('id').eq('alert_id', alert_id).maybeSingle();
      if (existingElig) {
        await supabase.from('notification_eligibility').update(safeEligibilityRecord).eq('id', existingElig.id);
      } else {
        await supabase.from('notification_eligibility').insert(safeEligibilityRecord);
      }
      // Log to pipeline_recovery_log
      await logRecovery({
        user_id: ownerUserId,
        trip_id: tripId,
        operation: 'PREFERENCE_CHECK',
        related_object_type: 'travel_alert',
        related_object_id: alert_id,
        failure_type: 'PROCESSING_FAILED',
        failure_message: 'Alert preference check could not be completed',
        failure_detail: {
          alert_id
        }
      });
      return ok({
        alert_id,
        eligible: false,
        reason: 'PROCESSING_FAILED',
        preferred_channel: 'IN_APP',
        quiet_period_applied: false,
        confidence_gate_applied: false,
        defer_until: null,
        preferences_used: null
      });
    }
    // Merge preferences and evaluate
    const prefs = mergePreferences(globalPrefs, tripPrefs);
    const result = evaluateEligibility(alert, prefs);
    // Check if a notification_eligibility record already exists
    const { data: existingElig } = await supabase.from('notification_eligibility').select('id').eq('alert_id', alert_id).maybeSingle();
    const now = new Date().toISOString();
    const eligibilityRecord = {
      user_id: ownerUserId,
      trip_id: tripId,
      alert_id,
      monitoring_event_id: alert.monitoring_event_id ?? null,
      eligible: result.eligible,
      eligibility_reason: result.reason,
      priority: alert.priority,
      urgency: alert.urgency,
      preferred_channel: result.preferred_channel ?? 'IN_APP',
      eligible_at: result.eligible ? now : null,
      defer_until: result.defer_until ?? null,
      quiet_period_applied: result.quiet_period_applied ?? false,
      duplicate_suppressed: false,
      confidence_gate_applied: result.confidence_gate_applied ?? false,
      preferences_snapshot: {
        sensitivity: prefs.sensitivity,
        minimum_priority: prefs.minimum_priority,
        quiet_period_enabled: prefs.quiet_period_enabled,
        informational_alerts_enabled: prefs.informational_alerts_enabled,
        enabled_alert_types: prefs.enabled_alert_types
      },
      suppressed: !result.eligible,
      evaluated_at: now
    };
    if (existingElig) {
      const { error: updateErr } = await supabase.from('notification_eligibility').update(eligibilityRecord).eq('id', existingElig.id);
      if (updateErr) {
        console.error('Failed to update notification_eligibility:', updateErr);
      }
    } else {
      const { error: insertErr } = await supabase.from('notification_eligibility').insert(eligibilityRecord);
      if (insertErr) {
        console.error('Failed to insert notification_eligibility:', insertErr);
      }
    }
    return ok({
      alert_id,
      eligible: result.eligible,
      reason: result.reason,
      preferred_channel: result.preferred_channel ?? 'IN_APP',
      quiet_period_applied: result.quiet_period_applied ?? false,
      confidence_gate_applied: result.confidence_gate_applied ?? false,
      defer_until: result.defer_until ?? null,
      preferences_used: {
        sensitivity: prefs.sensitivity,
        minimum_priority: prefs.minimum_priority,
        quiet_period_enabled: prefs.quiet_period_enabled
      }
    });
  }
  return ok({
    error: 'Method not allowed'
  }, 405);
});

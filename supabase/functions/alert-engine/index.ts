// SECURITY 2026-09-16 — IDOR in trip-scoped alert actions (2026-09-16 audit).
//
// What was wrong: every action below `get_priority_matrix` authenticated the
// caller's JWT correctly, but then trusted `trip_id` (and, for dismiss/snooze,
// the trip ownership derived from `alert_id`) straight from the request body
// with no check that the caller's own `user_id` matched it — while all reads
// and writes ran through a service_role client that bypasses RLS entirely.
//   - `get_active_alerts` returned every alert for any `trip_id` supplied,
//     regardless of who owned the trip.
//   - `create_alert`, `evaluate_health_alert`, `evaluate_friction_alert` and
//     `evaluate_booking_alert` all funnel into `createAlertInternal`, which
//     inserted a row into `travel_alerts` (plus `alert_delivery_log`) for
//     whatever `trip_id` was supplied, again with no ownership check.
//
// What an attacker could do: any authenticated user could read another
// user's trip alerts by guessing/enumerating a `trip_id`, and — worse —
// could plant a fabricated CRITICAL/HIGH alert (fake cancellations, fake
// booking failures) against a stranger's trip, contaminating their alert
// history and anything downstream that trusts `travel_alerts.trip_id`.
//
// The gate now: `requireUserOrService` (see ./_shared/auth.ts) accepts either
// a verified user JWT or the service-role key (the internal alert pipeline).
// For a user caller, identity always comes from the verified token
// (`caller.userId`), never the body, and:
//   - `get_active_alerts` additionally filters by `user_id = caller.userId`
//     (travel_alerts.user_id is a uuid matching auth.uid() directly — the
//     simplest correct gate, and it fails closed to an empty list rather
//     than leaking whether the trip exists).
//   - `create_alert` / `evaluate_*_alert` confirm trip ownership with
//     `requireTripOwner` before any insert, returning 404 (not 403) on
//     mismatch so trip ids cannot be enumerated by response code.
//   - `dismiss_alert` / `snooze_alert` keep their existing alert-ownership
//     check but now return 404 instead of 403 on mismatch, and use
//     `caller.userId` instead of the previously JWT-derived `user.id`.
//   - `get_user_preferences` / `update_user_preferences` operate on the
//     caller's own preferences row and now explicitly require a user caller.
// A service-role caller (the pipeline) skips the ownership check — it is
// already fully trusted — but for the two write actions above still needs a
// concrete `user_id` to attribute the alert to, so it resolves the trip's
// owner directly from `trips.user_id` (the trip is trusted input for a
// service caller; only the *owner lookup*, not an ownership match, happens).
//
// COLUMN FIX 2026-09-19 — two schema mismatches, both of which killed a whole
// action:
//   1. The travel_alerts INSERT in createAlertInternal wrote a `message`
//      column. public.travel_alerts has no `message`; the body of an alert is
//      `summary`. PostgREST rejected every insert with 42703, so `create_alert`,
//      `evaluate_health_alert`, `evaluate_friction_alert` and
//      `evaluate_booking_alert` have never once created an alert — all four
//      threw and returned 500.
//   2. `dismiss_alert` and `snooze_alert` selected `trips!inner(user_id)`.
//      There is NO foreign key from travel_alerts.trip_id to trips.id
//      (travel_alerts' only FKs are copilot_proposal_id, monitoring_event_id
//      and primary_impact_id), so PostgREST could not build that embedding and
//      rejected the query. The error was then folded into
//      `if (fetchErr || !alertRow) return err("Alert not found", 404)`, so
//      EVERY dismiss and EVERY snooze returned 404 "Alert not found" — for the
//      alert's real owner, on an alert that exists. Ownership is now checked
//      against travel_alerts.user_id, which is a real uuid column that
//      compares directly to auth.uid(), exactly as get_active_alerts does.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { requireUserOrService, requireTripOwner, serviceClient as createServiceClient } from "./_shared/auth.ts";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
const PRIORITY_MATRIX = {
  CRITICAL: {
    requiresAction: true,
    maxDelayMinutes: 0,
    deliveryChannels: [
      "push",
      "email",
      "sms",
      "inapp",
      "dashboard"
    ],
    shouldInterrupt: true,
    requiredAcknowledgement: true,
    snoozeAllowed: false
  },
  HIGH: {
    requiresAction: true,
    maxDelayMinutes: 5,
    deliveryChannels: [
      "push",
      "email",
      "inapp",
      "dashboard"
    ],
    shouldInterrupt: false,
    requiredAcknowledgement: true,
    snoozeAllowed: false
  },
  MEDIUM: {
    requiresAction: false,
    maxDelayMinutes: 30,
    deliveryChannels: [
      "inapp",
      "dashboard"
    ],
    shouldInterrupt: false,
    requiredAcknowledgement: false,
    snoozeAllowed: true
  },
  LOW: {
    requiresAction: false,
    maxDelayMinutes: 120,
    deliveryChannels: [
      "inapp",
      "dashboard"
    ],
    shouldInterrupt: false,
    requiredAcknowledgement: false,
    snoozeAllowed: true
  }
};
function ok(data) {
  return new Response(JSON.stringify({
    success: true,
    data
  }), {
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json"
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
      ...corsHeaders,
      "Content-Type": "application/json"
    }
  });
}
// Parse "HH:MM" into minutes since midnight
function timeToMinutes(t) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}
// Check if a UTC timestamp is within DND window for a given timezone
function isInDnd(nowUtc, timezone, dndStart, dndEnd) {
  try {
    const localStr = nowUtc.toLocaleString("en-US", {
      timeZone: timezone,
      hour12: false,
      hour: "2-digit",
      minute: "2-digit"
    });
    const [timePart] = localStr.split(", ").slice(-1);
    const [h, m] = timePart.split(":").map(Number);
    const nowMins = h * 60 + m;
    const startMins = timeToMinutes(dndStart);
    const endMins = timeToMinutes(dndEnd);
    if (startMins > endMins) {
      // Overnight DND (e.g. 22:00 - 07:00)
      return nowMins >= startMins || nowMins < endMins;
    }
    return nowMins >= startMins && nowMins < endMins;
  } catch  {
    return false;
  }
}
// Calculate next DND end time as a UTC Date
function nextDndEnd(nowUtc, timezone, dndEnd) {
  try {
    const [endH, endM] = dndEnd.split(":").map(Number);
    // Get today's date in the user's timezone
    const localDate = new Date(nowUtc.toLocaleString("en-US", {
      timeZone: timezone
    }));
    const candidate = new Date(localDate);
    candidate.setHours(endH, endM, 0, 0);
    // If candidate is in the past (local), move to tomorrow
    if (candidate <= localDate) {
      candidate.setDate(candidate.getDate() + 1);
    }
    return candidate;
  } catch  {
    // Fallback: 7 hours from now
    return new Date(nowUtc.getTime() + 7 * 60 * 60 * 1000);
  }
}
/**
 * Resolves who a trip-scoped alert action should be attributed to.
 *
 * For a user caller, confirms they own the trip (404 on mismatch, so trip
 * ids cannot be enumerated) and returns their own id. For a service caller
 * (the internal alert pipeline), there is no caller identity to check
 * against, so the trip's owner is looked up directly instead.
 */ async function resolveTripUserId(service, caller, tripId) {
  if (caller.kind === "user") {
    const owns = await requireTripOwner(service, tripId, caller.userId);
    if (owns instanceof Response) return owns;
    return caller.userId;
  }
  const { data, error } = await service.from("trips").select("user_id").eq("id", tripId).maybeSingle();
  if (error) {
    console.error("[alert-engine] trip owner lookup failed:", error.message);
    return err(`Trip lookup failed: ${error.message}`, 500);
  }
  if (!data) return err("Trip not found", 404);
  return data.user_id;
}
async function createAlertInternal(supabase, userId, params, prefs) {
  const matrix = PRIORITY_MATRIX[params.priority];
  if (!matrix) throw new Error(`Unknown priority: ${params.priority}`);
  const now = new Date();
  const timezone = prefs?.timezone ?? "UTC";
  const dndStart = prefs?.dnd_start ?? "22:00";
  const dndEnd = prefs?.dnd_end ?? "07:00";
  const requires_acknowledgement = matrix.requiredAcknowledgement;
  const snooze_allowed = matrix.snoozeAllowed;
  const delivery_channels = params.channels ?? matrix.deliveryChannels;
  const max_delay_minutes = matrix.maxDelayMinutes;
  const bypass_dnd = params.priority === "CRITICAL";
  let scheduled_for = null;
  if (params.priority === "CRITICAL") {
    scheduled_for = now;
  } else if (params.priority === "HIGH") {
    scheduled_for = new Date(now.getTime() + 5 * 60 * 1000);
  } else {
    // MEDIUM / LOW — respect DND
    const inDnd = isInDnd(now, timezone, dndStart, dndEnd);
    if (inDnd) {
      scheduled_for = nextDndEnd(now, timezone, dndEnd);
    } else {
      scheduled_for = new Date(now.getTime() + max_delay_minutes * 60 * 1000);
    }
  }
  // COLUMN FIX 2026-09-19 — `message:` here named a column travel_alerts does
  // not have; the alert body column is `summary`. This single wrong key made
  // PostgREST reject the whole INSERT with 42703, so no alert-engine action
  // has ever created an alert.
  const { data: alert, error: alertErr } = await supabase.from("travel_alerts").insert({
    trip_id: params.trip_id,
    user_id: userId,
    alert_category: params.alert_category,
    priority: params.priority,
    title: params.title,
    summary: params.message,
    context_data: params.context_data ?? {},
    action_items: params.action_items ?? [],
    requires_acknowledgement,
    snooze_allowed,
    delivery_channels,
    max_delay_minutes,
    bypass_dnd,
    scheduled_for: scheduled_for?.toISOString(),
    status: "ACTIVE"
  }).select().single();
  if (alertErr) throw new Error(alertErr.message);
  // Insert delivery log rows
  const logRows = delivery_channels.map((channel)=>({
      alert_id: alert.id,
      user_id: userId,
      channel,
      status: "pending",
      scheduled_at: scheduled_for?.toISOString()
    }));
  const { error: logErr } = await supabase.from("alert_delivery_log").insert(logRows);
  if (logErr) {
    // Non-fatal: the alert itself exists. Never silently discard this.
    console.error("[alert-engine] alert_delivery_log insert failed:", logErr.message);
  }
  return alert;
}
Deno.serve(async (req)=>{
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: corsHeaders
    });
  }
  let body;
  try {
    body = await req.json();
  } catch  {
    return err("Invalid JSON body");
  }
  const action = body.action;
  // Public action — no auth needed
  if (action === "get_priority_matrix") {
    return ok(PRIORITY_MATRIX);
  }
  // All other actions require a verified user or the service-role key.
  const caller = await requireUserOrService(req);
  if (caller instanceof Response) return caller;
  const serviceClient = createServiceClient();
  try {
    switch(action){
      case "create_alert":
        {
          const { trip_id, alert_category, priority, title, message, context_data, action_items, channels } = body;
          if (!trip_id || !alert_category || !priority || !title || !message) {
            return err("Missing required fields: trip_id, alert_category, priority, title, message");
          }
          const ownerUserId = await resolveTripUserId(serviceClient, caller, trip_id);
          if (ownerUserId instanceof Response) return ownerUserId;
          const { data: prefsRow, error: prefsErr } = await serviceClient.from("user_alert_preferences").select("*").eq("user_id", ownerUserId).maybeSingle();
          if (prefsErr) console.error("[alert-engine] user_alert_preferences lookup failed:", prefsErr.message);
          const alert = await createAlertInternal(serviceClient, ownerUserId, {
            trip_id: trip_id,
            alert_category: alert_category,
            priority: priority,
            title: title,
            message: message,
            context_data: context_data,
            action_items: action_items,
            channels: channels
          }, prefsRow ?? null);
          return ok(alert);
        }
      case "evaluate_health_alert":
        {
          const { trip_id, health_score, category_scores } = body;
          if (!trip_id || health_score === undefined) return err("Missing trip_id or health_score");
          const ownerUserId = await resolveTripUserId(serviceClient, caller, trip_id);
          if (ownerUserId instanceof Response) return ownerUserId;
          const score = Number(health_score);
          let priority = null;
          let message = "";
          if (score < 50) {
            priority = "CRITICAL";
            message = `Trip readiness critically low (${score}%). Major issues need attention.`;
          } else if (score < 75) {
            priority = "HIGH";
            let lowestCat = "";
            if (category_scores && typeof category_scores === "object") {
              const entries = Object.entries(category_scores);
              if (entries.length > 0) {
                lowestCat = entries.reduce((a, b)=>b[1] < a[1] ? b : a)[0];
              }
            }
            message = `Trip health dropped to ${score}%.${lowestCat ? ` ${lowestCat} needs attention.` : ""}`;
          } else if (score < 80) {
            priority = "MEDIUM";
            message = `Minor issues detected. Trip health at ${score}%.`;
          } else {
            return ok({
              alert_needed: false
            });
          }
          const { data: prefsRow, error: prefsErr } = await serviceClient.from("user_alert_preferences").select("*").eq("user_id", ownerUserId).maybeSingle();
          if (prefsErr) console.error("[alert-engine] user_alert_preferences lookup failed:", prefsErr.message);
          const alert = await createAlertInternal(serviceClient, ownerUserId, {
            trip_id: trip_id,
            alert_category: "health",
            priority,
            title: "Trip Health Alert",
            message,
            context_data: {
              health_score: score,
              category_scores: category_scores ?? {}
            }
          }, prefsRow ?? null);
          return ok({
            alert_needed: true,
            alert_id: alert.id,
            priority
          });
        }
      case "evaluate_friction_alert":
        {
          const { trip_id, day_number, friction_points, issue_count, days_until_event } = body;
          if (!trip_id || friction_points === undefined || days_until_event === undefined) {
            return err("Missing required fields");
          }
          const ownerUserId = await resolveTripUserId(serviceClient, caller, trip_id);
          if (ownerUserId instanceof Response) return ownerUserId;
          const fp = Number(friction_points);
          const due = Number(days_until_event);
          let priority = null;
          if (fp >= 75 && due <= 3) {
            priority = "CRITICAL";
          } else if (fp >= 50) {
            priority = "HIGH";
          } else {
            return ok({
              alert_needed: false
            });
          }
          const { data: prefsRow, error: prefsErr } = await serviceClient.from("user_alert_preferences").select("*").eq("user_id", ownerUserId).maybeSingle();
          if (prefsErr) console.error("[alert-engine] user_alert_preferences lookup failed:", prefsErr.message);
          const alert = await createAlertInternal(serviceClient, ownerUserId, {
            trip_id: trip_id,
            alert_category: "friction",
            priority,
            title: "High Friction Detected",
            message: `Day ${day_number ?? "?"} has ${fp} friction points with ${issue_count ?? 0} issues. Event in ${due} day(s).`,
            context_data: {
              day_number,
              friction_points: fp,
              issue_count,
              days_until_event: due
            }
          }, prefsRow ?? null);
          return ok({
            alert_needed: true,
            alert_id: alert.id,
            priority
          });
        }
      case "evaluate_booking_alert":
        {
          const { trip_id, reservation_id, reservation_name, status, hours_until_deadline } = body;
          if (!trip_id || !reservation_id || !status) return err("Missing required fields");
          const ownerUserId = await resolveTripUserId(serviceClient, caller, trip_id);
          if (ownerUserId instanceof Response) return ownerUserId;
          const hours = hours_until_deadline !== undefined ? Number(hours_until_deadline) : null;
          let priority = null;
          let message = "";
          const isCancelled = status === "CANCELLED";
          const isUnconfirmedPast = status === "UNCONFIRMED" && hours !== null && hours < 0;
          if (isCancelled || isUnconfirmedPast) {
            priority = "CRITICAL";
            message = isCancelled ? `Reservation "${reservation_name}" has been cancelled.` : `Unconfirmed reservation "${reservation_name}" deadline has passed.`;
          } else if (hours !== null && hours <= 24) {
            priority = "HIGH";
            message = `Reservation "${reservation_name}" requires action within ${Math.round(hours)} hours.`;
          } else {
            return ok({
              alert_needed: false
            });
          }
          const { data: prefsRow, error: prefsErr } = await serviceClient.from("user_alert_preferences").select("*").eq("user_id", ownerUserId).maybeSingle();
          if (prefsErr) console.error("[alert-engine] user_alert_preferences lookup failed:", prefsErr.message);
          const alert = await createAlertInternal(serviceClient, ownerUserId, {
            trip_id: trip_id,
            alert_category: "booking",
            priority,
            title: "Booking Alert",
            message,
            context_data: {
              reservation_id,
              reservation_name,
              status,
              hours_until_deadline: hours
            }
          }, prefsRow ?? null);
          return ok({
            alert_needed: true,
            alert_id: alert.id,
            priority
          });
        }
      case "dismiss_alert":
        {
          const { alert_id } = body;
          if (!alert_id) return err("Missing alert_id");
          // COLUMN FIX 2026-09-19 — was `.select("id, trip_id, trips!inner(user_id)")`.
          // There is no FK from travel_alerts.trip_id to trips.id, so PostgREST
          // could not resolve that embedding and rejected the query; the error
          // was then reported as "Alert not found", making dismiss impossible
          // for everyone. travel_alerts.user_id is the real ownership column.
          const { data: alertRow, error: fetchErr } = await serviceClient.from("travel_alerts").select("id, trip_id, user_id").eq("id", alert_id).maybeSingle();
          if (fetchErr) {
            console.error("[alert-engine] alert lookup failed:", fetchErr.message);
            return err(`Alert lookup failed: ${fetchErr.message}`, 500);
          }
          if (!alertRow) return err("Alert not found", 404);
          if (caller.kind === "user" && alertRow.user_id !== caller.userId) {
            return err("Alert not found", 404);
          }
          const { error: updateErr } = await serviceClient.from("travel_alerts").update({
            status: "DISMISSED",
            dismissed_at: new Date().toISOString()
          }).eq("id", alert_id);
          if (updateErr) return err(updateErr.message);
          return ok({
            dismissed: true,
            alert_id
          });
        }
      case "snooze_alert":
        {
          const { alert_id, minutes } = body;
          if (!alert_id || minutes === undefined) return err("Missing alert_id or minutes");
          // COLUMN FIX 2026-09-19 — same dead `trips!inner(user_id)` embedding as
          // dismiss_alert above; every snooze returned 404 "Alert not found".
          const { data: alertRow, error: fetchErr } = await serviceClient.from("travel_alerts").select("id, snooze_allowed, user_id").eq("id", alert_id).maybeSingle();
          if (fetchErr) {
            console.error("[alert-engine] alert lookup failed:", fetchErr.message);
            return err(`Alert lookup failed: ${fetchErr.message}`, 500);
          }
          if (!alertRow) return err("Alert not found", 404);
          if (caller.kind === "user" && alertRow.user_id !== caller.userId) {
            return err("Alert not found", 404);
          }
          if (!alertRow.snooze_allowed) {
            return err("This alert cannot be snoozed.");
          }
          const snoozeUntil = new Date(Date.now() + Number(minutes) * 60 * 1000);
          const { error: updateErr } = await serviceClient.from("travel_alerts").update({
            snooze_until: snoozeUntil.toISOString()
          }).eq("id", alert_id);
          if (updateErr) return err(updateErr.message);
          return ok({
            snoozed: true,
            alert_id,
            snooze_until: snoozeUntil.toISOString()
          });
        }
      case "get_active_alerts":
        {
          const { trip_id } = body;
          if (!trip_id) return err("Missing trip_id");
          const now = new Date().toISOString();
          let query = serviceClient.from("travel_alerts").select("*").eq("trip_id", trip_id).eq("status", "ACTIVE");
          // travel_alerts.user_id is a uuid matching auth.uid() directly, so for
          // a user caller this alone is the ownership gate — it also fails
          // closed to an empty list rather than revealing whether trip_id exists.
          if (caller.kind === "user") {
            query = query.eq("user_id", caller.userId);
          }
          const { data: alerts, error: fetchErr } = await query.or(`snooze_until.is.null,snooze_until.lte.${now}`).or(`scheduled_for.is.null,scheduled_for.lte.${now}`);
          if (fetchErr) return err(fetchErr.message);
          const priorityOrder = {
            CRITICAL: 0,
            HIGH: 1,
            MEDIUM: 2,
            LOW: 3,
            INFO: 4
          };
          const sorted = (alerts ?? []).sort((a, b)=>{
            const pa = priorityOrder[a.priority] ?? 99;
            const pb = priorityOrder[b.priority] ?? 99;
            if (pa !== pb) return pa - pb;
            return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
          });
          return ok(sorted);
        }
      case "get_user_preferences":
        {
          if (caller.kind !== "user") return err("This action requires a user session", 400);
          const { data: prefsRow, error: prefsErr } = await serviceClient.from("user_alert_preferences").select("*").eq("user_id", caller.userId).maybeSingle();
          if (prefsErr) {
            console.error("[alert-engine] user_alert_preferences lookup failed:", prefsErr.message);
            return err(`Preferences lookup failed: ${prefsErr.message}`, 500);
          }
          if (prefsRow) return ok(prefsRow);
          // No row stored yet — return the documented defaults, marked as such so
          // the caller can tell them apart from values the user actually chose.
          return ok({
            user_id: caller.userId,
            timezone: "UTC",
            dnd_start: "22:00",
            dnd_end: "07:00",
            push_enabled: true,
            email_enabled: true,
            sms_enabled: false,
            email_digest_mode: "immediate",
            sms_critical_only: true,
            category_preferences: {},
            priority_channel_overrides: {},
            is_stored: false
          });
        }
      case "update_user_preferences":
        {
          if (caller.kind !== "user") return err("This action requires a user session", 400);
          const { timezone, dnd_start, dnd_end, push_enabled, email_enabled, sms_enabled, email_digest_mode, category_preferences, priority_channel_overrides } = body;
          const upsertData = {
            user_id: caller.userId,
            updated_at: new Date().toISOString()
          };
          if (timezone !== undefined) upsertData.timezone = timezone;
          if (dnd_start !== undefined) upsertData.dnd_start = dnd_start;
          if (dnd_end !== undefined) upsertData.dnd_end = dnd_end;
          if (push_enabled !== undefined) upsertData.push_enabled = push_enabled;
          if (email_enabled !== undefined) upsertData.email_enabled = email_enabled;
          if (sms_enabled !== undefined) upsertData.sms_enabled = sms_enabled;
          if (email_digest_mode !== undefined) upsertData.email_digest_mode = email_digest_mode;
          if (category_preferences !== undefined) upsertData.category_preferences = category_preferences;
          if (priority_channel_overrides !== undefined) upsertData.priority_channel_overrides = priority_channel_overrides;
          const { data: updated, error: upsertErr } = await serviceClient.from("user_alert_preferences").upsert(upsertData, {
            onConflict: "user_id"
          }).select().single();
          if (upsertErr) return err(upsertErr.message);
          return ok(updated);
        }
      default:
        return err(`Unknown action: ${action}`);
    }
  } catch (e) {
    return err(e.message, 500);
  }
});

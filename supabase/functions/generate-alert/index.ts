// SECURITY 2026-09-17 —
// This function had a hand-rolled auth gate duplicated from the pre-audit
// pattern: it decoded the caller's JWT itself (real decode, not just a
// header-presence check) but never accepted a service-role caller. Every
// ownership check on trips/travel_alerts was written by hand per branch
// instead of using the shared module, and denial responses used 403
// ("Forbidden") instead of 404, letting a caller distinguish "not yours"
// from "doesn't exist" and probe for valid alert/trip ids.
//
// Because this function does not accept a service-role caller, the
// fire-and-forget call FROM run-alert-pipeline (Authorization: Bearer
// <service role key>) was failing auth.getUser() and returning 401 — the
// automated alert-generation pipeline for monitoring events was silently
// broken. An attacker could not exploit this directly (it fails closed),
// but it meant CRITICAL alerts from the automated pipeline were not being
// created at all.
//
// Fix: replaced the hand-rolled gate with requireUserOrService. A service
// caller (the pipeline) now passes through and generates alerts using the
// trip's own owner as the alert's user_id — resolved server-side from the
// trips row, never from the request body. A user caller is identified only
// by caller.userId (from the verified JWT), and every trip- or alert-scoped
// read/write is checked against that id via requireTripOwner or an explicit
// .eq('user_id', caller.userId) filter before it runs. Ownership failures
// now return 404, not 403.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { requireUserOrService, requireTripOwner, serviceClient } from "./_shared/auth.ts";
const PRIORITY_ORDER = {
  CRITICAL: 0,
  HIGH: 1,
  LOW: 2,
  INFO: 3
};
const URGENCY_ORDER = {
  IMMEDIATE: 0,
  TIME_SENSITIVE: 1,
  SOON: 2,
  NOT_URGENT: 3,
  UNKNOWN: 4
};
const IMPACT_LEVEL_ORDER = {
  CRITICAL: 0,
  HIGH: 1,
  MODERATE: 2,
  LOW: 3,
  POSSIBLE: 4,
  NONE: 5,
  UNKNOWN: 6
};
function calculateTimeToImpact(effectiveAt, affectedDate) {
  const target = effectiveAt || (affectedDate ? affectedDate + 'T00:00:00Z' : null);
  if (!target) return {
    bucket: 'UNKNOWN',
    minutes: null
  };
  const now = new Date();
  const targetDate = new Date(target);
  const diffMs = targetDate.getTime() - now.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 0) return {
    bucket: 'PAST',
    minutes: diffMins
  };
  if (diffMins < 120) return {
    bucket: 'LESS_THAN_2_HOURS',
    minutes: diffMins
  };
  if (diffMins < 360) return {
    bucket: '2_TO_6_HOURS',
    minutes: diffMins
  };
  if (diffMins < 720) return {
    bucket: '6_TO_12_HOURS',
    minutes: diffMins
  };
  if (diffMins < 1440) return {
    bucket: '12_TO_24_HOURS',
    minutes: diffMins
  };
  return {
    bucket: 'MORE_THAN_24_HOURS',
    minutes: diffMins
  };
}
function getHighestImpactLevel(impacts) {
  const order = [
    'CRITICAL',
    'HIGH',
    'MODERATE',
    'LOW',
    'POSSIBLE',
    'NONE',
    'UNKNOWN'
  ];
  for (const level of order){
    if (impacts.some((i)=>i.impact_level === level)) return level;
  }
  return 'UNKNOWN';
}
function calculateImpactScore(event, impacts, timeToImpact, tripData) {
  // A. Direct Traveler Impact (0-30)
  let directImpact = 0;
  const highestLevel = getHighestImpactLevel(impacts);
  const impactCount = impacts.filter((i)=>i.impact_level !== 'NONE').length;
  if (highestLevel === 'CRITICAL') directImpact = 30;
  else if (highestLevel === 'HIGH') directImpact = 24;
  else if (highestLevel === 'MODERATE') directImpact = 16;
  else if (highestLevel === 'LOW') directImpact = 8;
  else if (highestLevel === 'POSSIBLE') directImpact = 4;
  else directImpact = 0;
  if (impactCount >= 3) directImpact = Math.min(30, directImpact + 4);
  else if (impactCount >= 2) directImpact = Math.min(30, directImpact + 2);
  // B. Time Sensitivity (0-25)
  let timeSensitivity = 0;
  switch(timeToImpact){
    case 'CURRENT':
      timeSensitivity = 25;
      break;
    case 'LESS_THAN_2_HOURS':
      timeSensitivity = 22;
      break;
    case '2_TO_6_HOURS':
      timeSensitivity = 18;
      break;
    case '6_TO_12_HOURS':
      timeSensitivity = 13;
      break;
    case '12_TO_24_HOURS':
      timeSensitivity = 8;
      break;
    case 'MORE_THAN_24_HOURS':
      timeSensitivity = 3;
      break;
    default:
      timeSensitivity = 5;
  }
  // C. Dependency Strength (0-20)
  let dependencyStrength = 0;
  const hasTransportation = impacts.some((i)=>i.impact_type === 'TRANSPORTATION' || i.impact_type === 'CONNECTION');
  const hasAccommodation = impacts.some((i)=>i.impact_type === 'ACCOMMODATION');
  const hasItinerary = impacts.some((i)=>i.impact_type === 'ITINERARY');
  const hasRequirement = impacts.some((i)=>i.impact_type === 'REQUIREMENT' || i.impact_type === 'DOCUMENT');
  if (event.event_type === 'CANCELLATION') dependencyStrength = 20;
  else if (hasTransportation && hasAccommodation) dependencyStrength = 18;
  else if (hasTransportation) dependencyStrength = 15;
  else if (hasAccommodation) dependencyStrength = 12;
  else if (hasItinerary) dependencyStrength = 8;
  else if (hasRequirement) dependencyStrength = 10;
  else dependencyStrength = 4;
  // D. Trip Criticality (0-15)
  let tripCriticality = 0;
  const today = new Date();
  if (tripData.start_date) {
    const startDate = new Date(tripData.start_date);
    const daysUntilTrip = Math.floor((startDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
    if (daysUntilTrip <= 0) tripCriticality = 15;
    else if (daysUntilTrip <= 1) tripCriticality = 13;
    else if (daysUntilTrip <= 3) tripCriticality = 10;
    else if (daysUntilTrip <= 7) tripCriticality = 7;
    else if (daysUntilTrip <= 14) tripCriticality = 4;
    else tripCriticality = 2;
  } else {
    tripCriticality = 5;
  }
  // E. Confidence Component (0-10)
  let confidenceComponent = 0;
  switch(event.confidence){
    case 'HIGH':
      confidenceComponent = 10;
      break;
    case 'MEDIUM':
      confidenceComponent = 6;
      break;
    case 'LOW':
      confidenceComponent = 2;
      break;
    default:
      confidenceComponent = 1;
  }
  const rawTotal = directImpact + timeSensitivity + dependencyStrength + tripCriticality + confidenceComponent;
  let total = rawTotal;
  let confidenceCeilingApplied = false;
  const ceilings = {
    HIGH: 100,
    MEDIUM: 74,
    LOW: 49,
    UNKNOWN: 49
  };
  const ceiling = ceilings[event.confidence] ?? 49;
  if (total > ceiling) {
    total = ceiling;
    confidenceCeilingApplied = true;
  }
  let escalationApplied = false;
  let escalationReason = null;
  if (event.event_type === 'CANCELLATION' && event.confidence !== 'LOW' && event.confidence !== 'UNKNOWN') {
    if (impactCount >= 2 && total < 75) {
      total = 75;
      escalationApplied = true;
      escalationReason = 'Confirmed cancellation with multiple dependencies';
    }
  }
  if (event.event_type === 'AIRPORT_CHANGE' && hasTransportation && total < 50) {
    total = 50;
    escalationApplied = true;
    escalationReason = 'Airport change with transportation dependency';
  }
  if (timeToImpact === 'LESS_THAN_2_HOURS' && highestLevel === 'HIGH' && total < 75) {
    total = 75;
    escalationApplied = true;
    escalationReason = 'Imminent high-impact event';
  }
  if (total > ceiling) {
    total = ceiling;
  }
  return {
    breakdown: {
      direct_traveler_impact: directImpact,
      time_sensitivity: timeSensitivity,
      dependency_strength: dependencyStrength,
      trip_criticality: tripCriticality,
      confidence_component: confidenceComponent,
      total
    },
    escalation_applied: escalationApplied,
    escalation_reason: escalationReason,
    confidence_ceiling_applied: confidenceCeilingApplied
  };
}
function scoreToPriority(score) {
  if (score >= 75) return 'CRITICAL';
  if (score >= 50) return 'HIGH';
  if (score >= 25) return 'LOW';
  return 'INFO';
}
function calculateUrgencyScore(timeToImpact, priority) {
  let urgencyScore = 0;
  let urgency = 'UNKNOWN';
  switch(timeToImpact){
    case 'CURRENT':
      urgencyScore = 100;
      urgency = 'IMMEDIATE';
      break;
    case 'LESS_THAN_2_HOURS':
      urgencyScore = 90;
      urgency = 'IMMEDIATE';
      break;
    case '2_TO_6_HOURS':
      urgencyScore = 70;
      urgency = 'TIME_SENSITIVE';
      break;
    case '6_TO_12_HOURS':
      urgencyScore = 50;
      urgency = 'SOON';
      break;
    case '12_TO_24_HOURS':
      urgencyScore = 30;
      urgency = 'SOON';
      break;
    case 'MORE_THAN_24_HOURS':
      urgencyScore = 10;
      urgency = 'NOT_URGENT';
      break;
    case 'PAST':
      urgencyScore = 0;
      urgency = 'NOT_URGENT';
      break;
    default:
      if (priority === 'CRITICAL') {
        urgencyScore = 60;
        urgency = 'TIME_SENSITIVE';
      } else if (priority === 'HIGH') {
        urgencyScore = 40;
        urgency = 'SOON';
      } else {
        urgencyScore = 10;
        urgency = 'NOT_URGENT';
      }
  }
  return {
    time_to_impact_bucket: timeToImpact,
    minutes_to_impact: null,
    urgency_score: urgencyScore,
    urgency
  };
}
async function generateAlertContentWithAI(event, impacts, reservation, priority, urgency, timeToImpact) {
  const openrouterKey = Deno.env.get('OPENROUTER_API_KEY');
  if (!openrouterKey) throw new Error('OPENROUTER_API_KEY not set');
  const impactsSummary = impacts.map((i)=>`- ${i.impact_type}, level: ${i.impact_level}, entity: ${i.affected_entity_type ?? 'unknown'}, explanation: ${i.explanation}, confidence: ${i.confidence}`).join('\n');
  const reservationContext = reservation ? `Type: ${reservation.reservation_type}, Provider: ${reservation.provider_name ?? 'unknown'}, Date: ${reservation.start_date ?? 'unknown'}, Time: ${reservation.start_time ?? 'unknown'}, City: ${reservation.city ?? 'unknown'}` : 'No source reservation linked';
  const userPrompt = `Generate alert content for this travel change.

MONITORING EVENT:
- Type: ${event.event_type}
- Change: ${JSON.stringify(event.previous_value)} → ${JSON.stringify(event.new_value)}
- Changed fields: ${JSON.stringify(event.changed_fields)}
- Confidence: ${event.confidence}

SOURCE RESERVATION:
${reservationContext}

TRIP IMPACTS (${impacts.length} identified):
${impactsSummary || 'None identified'}

PRIORITY: ${priority}
URGENCY: ${urgency}
TIME TO IMPACT: ${timeToImpact}

Generate:
{
  "title": "short specific title (max 60 chars)",
  "summary": "one sentence summary",
  "explanation": "2-3 sentence explanation with appropriate confidence language",
  "affected_entities_description": "brief description of what may be affected",
  "recommended_next_step_type": "NO_ACTION_IDENTIFIED" | "REVIEW" | "VERIFY" | "POSSIBLE_ITINERARY_CHANGE" | "POSSIBLE_RESERVATION_FOLLOW_UP" | "POSSIBLE_TRAVEL_ADJUSTMENT" | "CHECK_DOCUMENT" | "REVIEW_REQUIREMENT" | "NO_ACTION",
  "alert_type": "INFORMATIONAL" | "SCHEDULE_CHANGE" | "DELAY" | "CANCELLATION" | "LOCATION_CHANGE" | "AIRPORT_CHANGE" | "TERMINAL_CHANGE" | "GATE_CHANGE" | "RESERVATION_CHANGE" | "CHECK_IN_CHANGE" | "CHECK_OUT_CHANGE" | "REQUIREMENT_CHANGE" | "WEATHER_ALERT" | "TRANSPORTATION_DISRUPTION" | "TRIP_IMPACT" | "OTHER"
}`;
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${openrouterKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'google/gemini-3.5-flash',
      messages: [
        {
          role: 'system',
          content: `You are a travel alert content writer for TravelOS. Generate clear, accurate, appropriately cautious alert content.

LANGUAGE RULES:
- HIGH confidence: use factual language ("Your flight departure changed from X to Y")
- MEDIUM confidence: use cautious language ("TravelOS detected a possible change to...")
- LOW/UNKNOWN confidence: use verification language ("TravelOS found conflicting information... Please verify with the provider")
- Never claim a connection is impossible unless data supports it
- Never use alarmist language
- Distinguish FACT from POTENTIAL IMPACT from RECOMMENDED NEXT STEP
- Respond with ONLY valid JSON`
        },
        {
          role: 'user',
          content: userPrompt
        }
      ],
      max_tokens: 500,
      temperature: 0.2
    })
  });
  if (!response.ok) throw new Error(`OpenRouter error: ${response.status}`);
  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content ?? '{}';
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
  return JSON.parse(cleaned);
}
function buildFallbackContent(event, priority) {
  const eventType = event.event_type.replace(/_/g, ' ').toLowerCase();
  return {
    title: `Travel ${eventType} detected`,
    summary: `A ${eventType} has been detected for your trip.`,
    explanation: `TravelOS detected a ${eventType}. Please review your travel plans and verify with your provider.`,
    affected_entities_description: 'Your travel reservation may be affected.',
    recommended_next_step_type: 'VERIFY',
    alert_type: event.event_type
  };
}
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
  // ── GET: fetch existing alerts (user-only; lists the caller's own alerts) ──
  if (req.method === 'GET') {
    if (caller.kind !== 'user') return ok({
      error: 'Unauthorized'
    }, 401);
    const userId = caller.userId;
    const trip_id = url.searchParams.get('trip_id');
    const status = url.searchParams.get('status') ?? 'ACTIVE';
    const unread_only = url.searchParams.get('unread_only') === 'true';
    if (!trip_id) {
      return ok({
        error: 'trip_id is required'
      }, 400);
    }
    const ownerCheck = await requireTripOwner(supabase, trip_id, userId);
    if (ownerCheck instanceof Response) return ownerCheck;
    let query = supabase.from('travel_alerts').select('id, user_id, trip_id, monitoring_event_id, primary_impact_id, itinerary_version_id, alert_group_id, alert_type, priority, urgency, confidence, title, summary, explanation, affected_entities, recommended_next_step_type, time_to_impact, minutes_to_impact, first_detected_at, last_updated_at, expires_at, status, fingerprint, created_at, updated_at, unread, read_at, acknowledged_at, impact_ids, copilot_context_available, copilot_proposal_id, impact_score, urgency_score, score_breakdown, escalation_applied, escalation_reason, confidence_ceiling_applied, score_calculated_at').eq('trip_id', trip_id).eq('user_id', userId);
    if (status !== 'ALL') query = query.eq('status', status);
    if (unread_only) query = query.eq('unread', true);
    const { data: alerts, error: alertsErr } = await query.order('created_at', {
      ascending: false
    });
    if (alertsErr) {
      return ok({
        error: alertsErr.message
      }, 500);
    }
    const sorted = (alerts ?? []).sort((a, b)=>{
      const priorityOrder = {
        CRITICAL: 0,
        HIGH: 1,
        LOW: 2,
        INFO: 3
      };
      const pa = priorityOrder[a.priority] ?? 4;
      const pb = priorityOrder[b.priority] ?? 4;
      if (pa !== pb) return pa - pb;
      const ua = a.urgency_score ?? 0;
      const ub = b.urgency_score ?? 0;
      if (ua !== ub) return ub - ua;
      const ia = a.impact_score ?? 0;
      const ib = b.impact_score ?? 0;
      if (ia !== ib) return ib - ia;
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });
    const activeAlerts = sorted.filter((a)=>a.status === 'ACTIVE');
    const unreadAlerts = activeAlerts.filter((a)=>a.unread === true);
    return ok({
      alerts: sorted,
      summary: {
        active_count: activeAlerts.length,
        unread_count: unreadAlerts.length,
        critical_count: activeAlerts.filter((a)=>a.priority === 'CRITICAL').length,
        high_count: activeAlerts.filter((a)=>a.priority === 'HIGH').length
      }
    });
  }
  // ── POST ───────────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    let body;
    try {
      body = await req.json();
    } catch  {
      return ok({
        error: 'Invalid JSON body'
      }, 400);
    }
    // ── mark_read action (user-only) ────────────────────────────────
    if (body.action === 'mark_read') {
      if (caller.kind !== 'user') return ok({
        error: 'Unauthorized'
      }, 401);
      const userId = caller.userId;
      const { alert_id } = body;
      if (!alert_id) {
        return ok({
          error: 'alert_id is required'
        }, 400);
      }
      const { data: existing } = await supabase.from('travel_alerts').select('id').eq('id', alert_id).eq('user_id', userId).maybeSingle();
      if (!existing) {
        return ok({
          error: 'Alert not found'
        }, 404);
      }
      const now = new Date().toISOString();
      const { error: updateErr } = await supabase.from('travel_alerts').update({
        read_at: now,
        unread: false,
        updated_at: now
      }).eq('id', alert_id);
      if (updateErr) {
        return ok({
          error: updateErr.message
        }, 500);
      }
      return ok({
        success: true
      });
    }
    // ── acknowledge action (user-only) ────────────────────────────────
    if (body.action === 'acknowledge') {
      if (caller.kind !== 'user') return ok({
        error: 'Unauthorized'
      }, 401);
      const userId = caller.userId;
      const { alert_id } = body;
      if (!alert_id) {
        return ok({
          error: 'alert_id is required'
        }, 400);
      }
      const { data: existing } = await supabase.from('travel_alerts').select('id, read_at').eq('id', alert_id).eq('user_id', userId).maybeSingle();
      if (!existing) {
        return ok({
          error: 'Alert not found'
        }, 404);
      }
      const now = new Date().toISOString();
      const { error: updateErr } = await supabase.from('travel_alerts').update({
        acknowledged_at: now,
        read_at: existing.read_at ?? now,
        unread: false,
        updated_at: now
      }).eq('id', alert_id);
      if (updateErr) {
        return ok({
          error: updateErr.message
        }, 500);
      }
      return ok({
        success: true
      });
    }
    // ── mark_all_read action (user-only) ────────────────────────────────
    if (body.action === 'mark_all_read') {
      if (caller.kind !== 'user') return ok({
        error: 'Unauthorized'
      }, 401);
      const userId = caller.userId;
      const { trip_id } = body;
      if (!trip_id) {
        return ok({
          error: 'trip_id is required'
        }, 400);
      }
      const ownerCheck = await requireTripOwner(supabase, trip_id, userId);
      if (ownerCheck instanceof Response) return ownerCheck;
      const now = new Date().toISOString();
      const { data: updated, error: updateErr } = await supabase.from('travel_alerts').update({
        read_at: now,
        unread: false,
        updated_at: now
      }).eq('trip_id', trip_id).eq('user_id', userId).eq('status', 'ACTIVE').eq('unread', true).select('id');
      if (updateErr) {
        return ok({
          error: updateErr.message
        }, 500);
      }
      return ok({
        success: true,
        updated_count: (updated ?? []).length
      });
    }
    // ── update_status action (user-only) ────────────────────────────────
    if (body.action === 'update_status') {
      if (caller.kind !== 'user') return ok({
        error: 'Unauthorized'
      }, 401);
      const userId = caller.userId;
      const { alert_id, status } = body;
      if (!alert_id || !status) {
        return ok({
          error: 'alert_id and status are required'
        }, 400);
      }
      const validStatuses = [
        'ACTIVE',
        'RESOLVED',
        'SUPERSEDED',
        'DISMISSED',
        'EXPIRED',
        'UNKNOWN'
      ];
      if (!validStatuses.includes(status)) {
        return ok({
          error: 'Invalid status'
        }, 400);
      }
      const { data: existing } = await supabase.from('travel_alerts').select('id').eq('id', alert_id).eq('user_id', userId).maybeSingle();
      if (!existing) {
        return ok({
          error: 'Alert not found'
        }, 404);
      }
      const { error: updateErr } = await supabase.from('travel_alerts').update({
        status,
        last_updated_at: new Date().toISOString()
      }).eq('id', alert_id);
      if (updateErr) {
        return ok({
          error: updateErr.message
        }, 500);
      }
      return ok({
        success: true
      });
    }
    // ── generate alert from monitoring event (user OR trusted service caller) ──
    const { monitoring_event_id, trip_id } = body;
    if (!monitoring_event_id || !trip_id) {
      return ok({
        error: 'monitoring_event_id and trip_id are required'
      }, 400);
    }
    const { data: trip, error: tripErr } = await supabase.from('trips').select('*').eq('id', trip_id).maybeSingle();
    if (tripErr || !trip) {
      return ok({
        error: 'Trip not found'
      }, 404);
    }
    // A user caller may only generate alerts for a trip they own. A service
    // caller (the alert pipeline) is trusted and acts as the trip's owner —
    // that owner id, never a body field, becomes the alert's user_id.
    let ownerUserId;
    if (caller.kind === 'user') {
      if (trip.user_id !== caller.userId) {
        return ok({
          error: 'Trip not found'
        }, 404);
      }
      ownerUserId = caller.userId;
    } else {
      ownerUserId = trip.user_id;
    }
    const { data: event, error: eventErr } = await supabase.from('monitoring_events').select('*').eq('id', monitoring_event_id).eq('trip_id', trip_id).maybeSingle();
    if (eventErr || !event) {
      return ok({
        error: 'Monitoring event not found or does not belong to this trip'
      }, 404);
    }
    const { data: impacts } = await supabase.from('trip_impacts').select('*').eq('monitoring_event_id', monitoring_event_id).eq('status', 'ACTIVE');
    const activeImpacts = impacts ?? [];
    let monitoredEntity = null;
    if (event.monitored_entity_id) {
      const { data: me } = await supabase.from('monitored_entities').select('*').eq('id', event.monitored_entity_id).single();
      monitoredEntity = me ?? null;
    }
    let reservation = null;
    const reservationId = event.reservation_id ?? monitoredEntity?.reservation_id;
    if (reservationId) {
      const { data: res } = await supabase.from('reservations').select('*').eq('id', reservationId).single();
      reservation = res ?? null;
    }
    const primaryImpact = activeImpacts.length > 0 ? activeImpacts.reduce((best, cur)=>{
      return (IMPACT_LEVEL_ORDER[cur.impact_level] ?? 6) < (IMPACT_LEVEL_ORDER[best.impact_level] ?? 6) ? cur : best;
    }) : null;
    const effectiveAt = event.effective_at ?? null;
    const affectedDate = primaryImpact?.affected_date ?? null;
    const { bucket: timeToImpactBucket, minutes: minutesToImpact } = calculateTimeToImpact(effectiveAt, affectedDate);
    const tripData = {
      start_date: trip.start_date ?? undefined,
      end_date: trip.end_date ?? undefined
    };
    const { breakdown, escalation_applied, escalation_reason, confidence_ceiling_applied } = calculateImpactScore({
      event_type: event.event_type,
      confidence: event.confidence
    }, activeImpacts, timeToImpactBucket, tripData);
    const priority = scoreToPriority(breakdown.total);
    const urgencyBreakdown = calculateUrgencyScore(timeToImpactBucket, priority);
    const urgency = urgencyBreakdown.urgency;
    const fingerprint = `alert_${event.id}_${priority}`;
    const { data: existingAlert } = await supabase.from('travel_alerts').select('id, status').eq('fingerprint', fingerprint).eq('status', 'ACTIVE').maybeSingle();
    let aiContent;
    try {
      aiContent = await generateAlertContentWithAI(event, activeImpacts, reservation, priority, urgency, timeToImpactBucket);
    } catch (e) {
      console.error('AI content generation failed, using fallback:', e);
      aiContent = buildFallbackContent(event, priority);
    }
    const affectedEntities = activeImpacts.map((i)=>({
        type: i.affected_entity_type ?? 'OTHER',
        id: i.affected_entity_id ?? null,
        description: i.explanation ?? ''
      }));
    const impactIds = activeImpacts.map((i)=>i.id).filter(Boolean);
    const scoreCalculatedAt = new Date().toISOString();
    const alertData = {
      user_id: ownerUserId,
      trip_id,
      monitoring_event_id,
      primary_impact_id: primaryImpact?.id ?? null,
      itinerary_version_id: event.itinerary_version_id ?? null,
      alert_type: aiContent.alert_type ?? event.event_type ?? 'OTHER',
      priority,
      urgency,
      confidence: event.confidence ?? 'UNKNOWN',
      title: aiContent.title ?? 'Travel Alert',
      summary: aiContent.summary ?? 'A travel change has been detected.',
      explanation: aiContent.explanation ?? null,
      affected_entities: affectedEntities,
      recommended_next_step_type: aiContent.recommended_next_step_type ?? 'REVIEW',
      time_to_impact: timeToImpactBucket,
      minutes_to_impact: minutesToImpact,
      first_detected_at: event.detected_at ?? new Date().toISOString(),
      last_updated_at: scoreCalculatedAt,
      status: 'ACTIVE',
      fingerprint,
      unread: true,
      impact_ids: impactIds.length > 0 ? impactIds : null,
      copilot_context_available: true,
      impact_score: breakdown.total,
      urgency_score: urgencyBreakdown.urgency_score,
      score_breakdown: {
        ...breakdown,
        urgency_score: urgencyBreakdown.urgency_score,
        confidence_ceiling_applied,
        escalation_applied,
        escalation_reason,
        calculated_at: scoreCalculatedAt
      },
      escalation_applied,
      escalation_reason,
      confidence_ceiling_applied,
      score_calculated_at: scoreCalculatedAt
    };
    if (existingAlert) {
      const { error: updateErr } = await supabase.from('travel_alerts').update({
        last_updated_at: scoreCalculatedAt,
        title: alertData.title,
        summary: alertData.summary,
        explanation: alertData.explanation,
        priority: alertData.priority,
        urgency: alertData.urgency,
        time_to_impact: alertData.time_to_impact,
        minutes_to_impact: alertData.minutes_to_impact,
        affected_entities: alertData.affected_entities,
        recommended_next_step_type: alertData.recommended_next_step_type,
        impact_ids: alertData.impact_ids,
        unread: true,
        read_at: null,
        impact_score: alertData.impact_score,
        urgency_score: alertData.urgency_score,
        score_breakdown: alertData.score_breakdown,
        escalation_applied: alertData.escalation_applied,
        escalation_reason: alertData.escalation_reason,
        confidence_ceiling_applied: alertData.confidence_ceiling_applied,
        score_calculated_at: alertData.score_calculated_at
      }).eq('id', existingAlert.id);
      if (updateErr) {
        return ok({
          error: updateErr.message
        }, 500);
      }
      // Fire-and-forget eligibility re-evaluation for updated alert
      const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
      const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
      fetch(`${SUPABASE_URL}/functions/v1/evaluate-alert-eligibility`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`
        },
        body: JSON.stringify({
          alert_id: existingAlert.id,
          trip_id
        })
      }).catch(()=>{});
      return ok({
        alert: {
          id: existingAlert.id,
          ...alertData
        },
        was_duplicate: true,
        impacts_count: activeImpacts.length
      });
    }
    // Insert new alert
    const { data: newAlert, error: insertErr } = await supabase.from('travel_alerts').insert(alertData).select().single();
    if (insertErr) {
      return ok({
        error: insertErr.message
      }, 500);
    }
    // Fire-and-forget eligibility evaluation via dedicated function
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
    const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    fetch(`${SUPABASE_URL}/functions/v1/evaluate-alert-eligibility`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`
      },
      body: JSON.stringify({
        alert_id: newAlert.id,
        trip_id
      })
    }).catch(()=>{});
    return ok({
      alert: newAlert,
      was_duplicate: false,
      impacts_count: activeImpacts.length
    }, 201);
  }
  return ok({
    error: 'Method not allowed'
  }, 405);
});

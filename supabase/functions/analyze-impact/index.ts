// ITINERARY RECONCILIATION 2026-09-24 — the POST analysis reads the live
// itinerary from itinerary_items (grouped into days by date in the trip's
// primary_tz) instead of the legacy generated_itineraries table. This also
// fixes the old `.days`-on-array bug: GI.itinerary was already a days ARRAY,
// so `itinerary_data.days` was always undefined and every prompt said
// "No itinerary available". Activity ids given to the model are real
// itinerary_items ids. GET and all other steps are unchanged.
//
// SECURITY 2026-09-17 — Two independent defects in the POST handler:
//
// 1. `if (monEvent.user_id !== user.id) return Forbidden` referenced a column
//    that does not exist on monitoring_events (it has no user_id at all —
//    confirmed against information_schema.columns). `monEvent.user_id` was
//    therefore always `undefined`, and `undefined !== <uuid>` is always true.
//    Every single POST call — from a real trip owner or from the pipeline —
//    has returned 403 Forbidden unconditionally since this function's first
//    version. Impact analysis has never produced a result for a real user
//    request. Fixed by comparing `monEvent.trip_id` (a real column) against
//    the caller-supplied trip_id instead, which is also the correct ownership
//    check: it stops a caller from pointing a trip_id they own at a
//    monitoring_event_id that belongs to someone else's trip (the dead check
//    coincidentally happened to fail closed on that too, but for the wrong
//    reason and with no way to ever succeed).
//
// 2. run-impact-pipeline calls this function with
//    `Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>`, but the handler
//    required a real user JWT (`supabase.auth.getUser(jwt)` against the
//    service-role key fails). Every pipeline-triggered impact analysis has
//    therefore failed with 401, on top of defect 1. Fixed with
//    `requireUserOrService`; a service caller's identity for the inserted
//    trip_impacts rows is resolved from the trip's own owner instead of a
//    user token that does not exist for that call.
//
// Also scoped the monitored_entity and source-reservation lookups to the
// validated trip_id so a service caller (which skips the trip-ownership
// check) cannot be pointed at another trip's reservation data.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { requireUser, requireUserOrService, serviceClient, corsHeaders } from "./_shared/auth.ts";
// ── itinerary_items → days (ITINERARY RECONCILIATION 2026-09-24) ─────────
// itinerary_items.start_time / end_time are timestamptz (stored UTC). Days
// are grouped by the item's `date` column (the trip-local calendar date);
// when that is missing the date is derived from start_time in the trip's
// primary_tz. Times are rendered as local "HH:MM" in the same zone. Items
// with neither a date nor a start_time are grouped under date null.
function validTz(tz) {
  if (!tz) return null;
  try {
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz
    });
    return tz;
  } catch  {
    return null;
  }
}
function localParts(ts, tz) {
  if (!ts) return null;
  const d = new Date(String(ts).trim().replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
  if (isNaN(d.getTime())) return null;
  const p = {};
  for (const part of new Intl.DateTimeFormat('en-US', {
    timeZone: tz ?? 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(d))p[part.type] = part.value;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${p.hour}:${p.minute}`
  };
}
function itemsToDays(items, tzRaw, tripStart) {
  const tz = validTz(tzRaw);
  const byDate = new Map();
  for (const it of items){
    const start = localParts(it.start_time, tz);
    const date = it.date ?? start?.date ?? '';
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(it);
  }
  const dates = [
    ...byDate.keys()
  ].sort((a, b)=>a === '' ? 1 : b === '' ? -1 : a.localeCompare(b));
  const startMs = tripStart ? Date.parse(`${tripStart}T00:00:00Z`) : NaN;
  return dates.map((date, i)=>{
    const rows = byDate.get(date).slice().sort((a, b)=>String(a.start_time ?? '￿').localeCompare(String(b.start_time ?? '￿')));
    let dayNumber = i + 1;
    if (date && !isNaN(startMs)) {
      const n = Math.round((Date.parse(`${date}T00:00:00Z`) - startMs) / 86400000) + 1;
      if (n >= 1) dayNumber = n;
    }
    return {
      day_number: dayNumber,
      date: date || null,
      items: rows
    };
  });
}
function itemLocalTime(it, tzRaw, field = 'start_time') {
  return localParts(it[field], validTz(tzRaw))?.time ?? null;
}
const IMPACT_LEVEL_ORDER = {
  CRITICAL: 0,
  HIGH: 1,
  MODERATE: 2,
  LOW: 3,
  POSSIBLE: 4,
  NONE: 5,
  UNKNOWN: 6
};
function highestLevel(levels) {
  if (!levels.length) return 'UNKNOWN';
  return levels.reduce((best, cur)=>(IMPACT_LEVEL_ORDER[cur] ?? 6) < (IMPACT_LEVEL_ORDER[best] ?? 6) ? cur : best, 'UNKNOWN');
}
Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders
    });
  }
  const supabase = serviceClient();
  // ── GET: fetch active impacts for a trip (client-facing only) ─────
  if (req.method === 'GET') {
    const caller = await requireUser(req);
    if (caller instanceof Response) return caller;
    const { userId } = caller;
    const url = new URL(req.url);
    const trip_id = url.searchParams.get('trip_id');
    if (!trip_id) {
      return new Response(JSON.stringify({
        error: 'trip_id is required'
      }), {
        status: 400,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // Verify trip ownership
    // ERROR-HANDLING FIX 2026-09-19 — was `if (tripErr || !trip) return 404`,
    // which reported a failed query as a missing trip.
    const { data: trip, error: tripErr } = await supabase.from('trips').select('id, user_id').eq('id', trip_id).eq('user_id', userId).maybeSingle();
    if (tripErr) {
      console.error('[analyze-impact] trip lookup failed:', tripErr.message);
      return new Response(JSON.stringify({
        error: 'Trip lookup failed',
        detail: tripErr.message
      }), {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    if (!trip) {
      return new Response(JSON.stringify({
        error: 'Trip not found'
      }), {
        status: 404,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    const { data: impacts, error: impactsErr } = await supabase.from('trip_impacts').select('*').eq('trip_id', trip_id).eq('status', 'ACTIVE').order('impact_level', {
      ascending: true
    }).limit(50);
    if (impactsErr) {
      return new Response(JSON.stringify({
        error: impactsErr.message
      }), {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    const impactList = impacts ?? [];
    const impactTypes = [
      ...new Set(impactList.map((i)=>i.impact_type))
    ];
    const highest = highestLevel(impactList.map((i)=>i.impact_level));
    return new Response(JSON.stringify({
      impacts: impactList,
      summary: {
        active_count: impactList.length,
        highest_level: impactList.length > 0 ? highest : null,
        impact_types: impactTypes
      }
    }), {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
  // ── POST: run full impact analysis (client or pipeline) ──────────
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({
      error: 'Method not allowed'
    }), {
      status: 405,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
  const caller = await requireUserOrService(req);
  if (caller instanceof Response) return caller;
  let body;
  try {
    body = await req.json();
  } catch  {
    return new Response(JSON.stringify({
      error: 'Invalid JSON body'
    }), {
      status: 400,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
  const { monitoring_event_id, trip_id } = body;
  if (!monitoring_event_id || !trip_id) {
    return new Response(JSON.stringify({
      error: 'monitoring_event_id and trip_id are required'
    }), {
      status: 400,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
  // Verify trip ownership (or, for a service caller, just that the trip
  // exists — the pipeline already resolved trip_id from a verified owner
  // upstream, and there is no user token left here to check against).
  // ERROR-HANDLING FIX 2026-09-19 — was `if (tripErr || !trip) return 404`.
  const { data: trip, error: tripErr } = await supabase.from('trips').select('*').eq('id', trip_id).maybeSingle();
  if (tripErr) {
    console.error('[analyze-impact] trip lookup failed:', tripErr.message);
    return new Response(JSON.stringify({
      error: 'Trip lookup failed',
      detail: tripErr.message
    }), {
      status: 500,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
  if (!trip) {
    return new Response(JSON.stringify({
      error: 'Trip not found'
    }), {
      status: 404,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
  if (caller.kind === 'user' && trip.user_id !== caller.userId) {
    return new Response(JSON.stringify({
      error: 'Trip not found'
    }), {
      status: 404,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
  const effectiveUserId = caller.kind === 'user' ? caller.userId : trip.user_id;
  // 1. Fetch monitoring event
  // ERROR-HANDLING FIX 2026-09-19 — was `if (evErr || !monEvent) return 404`.
  const { data: monEvent, error: evErr } = await supabase.from('monitoring_events').select('*').eq('id', monitoring_event_id).maybeSingle();
  if (evErr) {
    console.error('[analyze-impact] monitoring event lookup failed:', evErr.message);
    return new Response(JSON.stringify({
      error: 'Monitoring event lookup failed',
      detail: evErr.message
    }), {
      status: 500,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
  if (!monEvent) {
    return new Response(JSON.stringify({
      error: 'Monitoring event not found'
    }), {
      status: 404,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
  // monitoring_events has no user_id column — the real ownership tie is
  // trip_id. Without this check, a service caller (which skips the trip
  // ownership check above) or a mismatched trip_id/monitoring_event_id pair
  // from any caller could pull another trip's monitoring event and, below,
  // its reservation data into this trip's impact analysis.
  if (monEvent.trip_id !== trip_id) {
    return new Response(JSON.stringify({
      error: 'Monitoring event not found'
    }), {
      status: 404,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
  // 2. Fetch monitored entity (scoped to this trip)
  let monEntity = null;
  if (monEvent.monitored_entity_id) {
    const { data, error: entityErr } = await supabase.from('monitored_entities').select('*').eq('id', monEvent.monitored_entity_id).eq('trip_id', trip_id).maybeSingle();
    if (entityErr) {
      console.error('[analyze-impact] monitored entity lookup failed:', entityErr.message);
      return new Response(JSON.stringify({
        error: 'Monitored entity lookup failed',
        detail: entityErr.message
      }), {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    monEntity = data ?? null;
  }
  // 3. Fetch source reservation (scoped to this trip)
  let sourceReservation = null;
  const sourceResId = monEntity?.reservation_id ?? monEvent.reservation_id ?? null;
  if (sourceResId) {
    const { data, error: sourceResErr } = await supabase.from('reservations').select('*').eq('id', sourceResId).eq('trip_id', trip_id).maybeSingle();
    if (sourceResErr) {
      console.error('[analyze-impact] source reservation lookup failed:', sourceResErr.message);
      return new Response(JSON.stringify({
        error: 'Source reservation lookup failed',
        detail: sourceResErr.message
      }), {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    sourceReservation = data ?? null;
  }
  // 4. Fetch all trip reservations
  const { data: allReservations, error: allReservationsErr } = await supabase.from('reservations').select('id, reservation_type, provider_name, confirmation_number, reservation_status, start_date, start_time, end_date, end_time, timezone, location_name, city, country, details, notes').eq('trip_id', trip_id).eq('user_id', effectiveUserId).order('start_date', {
    ascending: true,
    nullsFirst: false
  }).order('start_time', {
    ascending: true,
    nullsFirst: false
  });
  if (allReservationsErr) {
    console.error('[analyze-impact] reservations lookup failed:', allReservationsErr.message);
    return new Response(JSON.stringify({
      error: 'Reservations lookup failed',
      detail: allReservationsErr.message
    }), {
      status: 500,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
  // 5. Fetch the live itinerary (itinerary_items)
  const { data: itemRows, error: itemsErr } = await supabase.from('itinerary_items').select('id, title, type, category, status, date, start_time, end_time, location, fixed, must_do').eq('trip_id', trip_id).order('date', {
    ascending: true,
    nullsFirst: false
  }).order('start_time', {
    ascending: true,
    nullsFirst: false
  });
  if (itemsErr) {
    console.error('[analyze-impact] itinerary items lookup failed:', itemsErr.message);
    return new Response(JSON.stringify({
      error: 'Itinerary lookup failed',
      detail: itemsErr.message
    }), {
      status: 500,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
  const tripTz = trip.primary_tz ?? null;
  const itineraryDaysFromItems = itemsToDays(itemRows ?? [], tripTz, trip.start_date);
  // 6. Fetch trip assembly
  const { data: assembly, error: assemblyErr } = await supabase.from('trip_assemblies').select('travel_segments, accommodation_periods, open_windows, assembly_status, confidence').eq('trip_id', trip_id).maybeSingle();
  if (assemblyErr) {
    console.error('[analyze-impact] trip assembly lookup failed:', assemblyErr.message);
    return new Response(JSON.stringify({
      error: 'Trip assembly lookup failed',
      detail: assemblyErr.message
    }), {
      status: 500,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
  // 7. Supersede existing ACTIVE impacts for this event
  const { error: supersedeErr } = await supabase.from('trip_impacts').update({
    status: 'SUPERSEDED'
  }).eq('monitoring_event_id', monitoring_event_id).eq('status', 'ACTIVE');
  if (supersedeErr) {
    console.error('[analyze-impact] superseding previous impacts failed:', supersedeErr.message);
    return new Response(JSON.stringify({
      error: 'Failed to supersede previous impacts',
      detail: supersedeErr.message
    }), {
      status: 500,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
  // 8. Build AI prompt
  const itinerarySummary = itineraryDaysFromItems.map((d)=>({
      day_number: d.day_number,
      date: d.date,
      activities: d.items.map((a)=>({
          id: a.id ?? null,
          name: a.title ?? null,
          time: itemLocalTime(a, tripTz),
          end_time: itemLocalTime(a, tripTz, 'end_time'),
          location: a.location ?? null,
          category: a.category ?? a.type ?? null,
          is_confirmed: a.fixed === true || String(a.status ?? '').toLowerCase() === 'confirmed',
          must_do: a.must_do === true
        }))
    }));
  const systemPrompt = `You are a travel impact analysis engine for TravelOS. Your job is to analyze a travel monitoring event and determine what parts of the traveler's trip may be affected.

CRITICAL RULES:
1. Only identify impacts supported by the available data
2. Do not fabricate distances, travel times, or transportation assumptions
3. Use cautious language: "may be affected", "potential impact", "could affect"
4. Do not claim a connection is impossible unless data supports it
5. Unknown information must remain UNKNOWN — never convert to known
6. Do not modify reservations or itinerary
7. Respond with ONLY valid JSON`;
  const userPrompt = `Analyze this monitoring event and identify potential trip impacts.

MONITORING EVENT:
- Event type: ${monEvent.event_type ?? 'UNKNOWN'}
- Change: ${JSON.stringify(monEvent.previous_value)} → ${JSON.stringify(monEvent.new_value)}
- Changed fields: ${JSON.stringify(monEvent.changed_fields ?? [])}
- Change magnitude: ${monEvent.change_magnitude ?? 'UNKNOWN'}
- Confidence: ${monEvent.confidence ?? 'UNKNOWN'}
- Effective at: ${monEvent.effective_at ?? monEvent.created_at ?? 'UNKNOWN'}

SOURCE RESERVATION (what changed):
${sourceReservation ? JSON.stringify({
    id: sourceReservation.id,
    type: sourceReservation.reservation_type,
    provider: sourceReservation.provider_name,
    start_date: sourceReservation.start_date,
    start_time: sourceReservation.start_time,
    end_date: sourceReservation.end_date,
    end_time: sourceReservation.end_time,
    city: sourceReservation.city,
    country: sourceReservation.country,
    details: sourceReservation.details
  }) : 'No source reservation available'}

ALL TRIP RESERVATIONS:
${JSON.stringify((allReservations ?? []).map((r)=>({
      id: r.id,
      reservation_type: r.reservation_type,
      provider_name: r.provider_name,
      start_date: r.start_date,
      start_time: r.start_time,
      end_date: r.end_date,
      end_time: r.end_time,
      city: r.city,
      country: r.country,
      location_name: r.location_name,
      details: r.details
    })))}

ACTIVE ITINERARY (if available; times are local to ${tripTz ?? 'UTC (trip time zone unknown)'}):
${itinerarySummary.length > 0 ? JSON.stringify(itinerarySummary) : 'No itinerary available'}

TRIP ASSEMBLY:
${assembly ? JSON.stringify({
    travel_segments: assembly.travel_segments,
    accommodation_periods: assembly.accommodation_periods,
    open_windows: assembly.open_windows
  }) : 'No assembly data available'}

Identify all potential trip impacts. For each impact return:
{
  "impacts": [
    {
      "impact_type": "TEMPORAL" | "GEOGRAPHIC" | "RESERVATION" | "TRANSPORTATION" | "ACCOMMODATION" | "ITINERARY" | "DOCUMENT" | "REQUIREMENT" | "SEQUENCE" | "CONNECTION" | "OTHER",
      "impact_level": "NONE" | "POSSIBLE" | "LOW" | "MODERATE" | "HIGH" | "CRITICAL" | "UNKNOWN",
      "affected_entity_type": "RESERVATION" | "ITINERARY_ACTIVITY" | "DOCUMENT" | "REQUIREMENT" | "TRANSPORTATION" | "ACCOMMODATION" | "TOUR" | "ACTIVITY" | "OTHER",
      "affected_entity_id": "reservation id or activity id or null",
      "affected_day": number or null,
      "affected_date": "YYYY-MM-DD or null",
      "relationship_type": "string describing the dependency (e.g. FLIGHT_ARRIVAL_TO_HOTEL_CHECKIN)",
      "time_relationship": {
        "original_gap_minutes": number or null,
        "new_gap_minutes": number or null,
        "change_minutes": number or null
      } or null,
      "explanation": "plain language explanation using cautious language",
      "evidence": [
        { "type": "RESERVATION" | "ITINERARY" | "TIMING" | "GEOGRAPHIC", "reference": "id or description", "description": "what this evidence shows" }
      ],
      "confidence": "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN"
    }
  ],
  "overall_impact_level": "NONE" | "POSSIBLE" | "LOW" | "MODERATE" | "HIGH" | "CRITICAL" | "UNKNOWN",
  "analysis_notes": "brief summary of the analysis"
}

If no meaningful impacts exist, return { "impacts": [], "overall_impact_level": "NONE", "analysis_notes": "No dependent trip components identified." }`;
  // Call OpenRouter (Gemini 2.0 Flash)
  let aiResult = null;
  let aiError = false;
  try {
    const openrouterRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${Deno.env.get('OPENROUTER_API_KEY')}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://travelos.app',
        'X-Title': 'TravelOS Impact Analysis'
      },
      body: JSON.stringify({
        model: 'google/gemini-3.5-flash',
        messages: [
          {
            role: 'system',
            content: systemPrompt
          },
          {
            role: 'user',
            content: userPrompt
          }
        ],
        max_tokens: 2000,
        temperature: 0.1,
        response_format: {
          type: 'json_object'
        }
      })
    });
    if (!openrouterRes.ok) {
      console.error('OpenRouter error:', openrouterRes.status, await openrouterRes.text());
      aiError = true;
    } else {
      const aiData = await openrouterRes.json();
      const rawContent = aiData?.choices?.[0]?.message?.content ?? '{}';
      const parsed = typeof rawContent === 'string' ? JSON.parse(rawContent) : rawContent;
      aiResult = parsed;
    }
  } catch (e) {
    console.error('AI call failed:', e);
    aiError = true;
  }
  // 9. Build impact records
  const impactRecords = [];
  if (aiError || !aiResult) {
    // Fallback: single UNKNOWN impact
    impactRecords.push({
      user_id: effectiveUserId,
      trip_id,
      monitoring_event_id,
      monitored_entity_id: monEvent.monitored_entity_id ?? null,
      reservation_id: sourceResId ?? null,
      impact_type: 'OTHER',
      impact_level: 'UNKNOWN',
      explanation: 'Impact analysis could not be completed due to an AI service error.',
      evidence: [],
      confidence: 'UNKNOWN',
      status: 'ACTIVE'
    });
  } else {
    const impacts = Array.isArray(aiResult.impacts) ? aiResult.impacts : [];
    for (const impact of impacts){
      const imp = impact;
      impactRecords.push({
        user_id: effectiveUserId,
        trip_id,
        monitoring_event_id,
        monitored_entity_id: monEvent.monitored_entity_id ?? null,
        reservation_id: sourceResId ?? null,
        impact_type: imp.impact_type ?? 'OTHER',
        impact_level: imp.impact_level ?? 'UNKNOWN',
        affected_entity_type: imp.affected_entity_type ?? null,
        affected_entity_id: imp.affected_entity_id ? String(imp.affected_entity_id) : null,
        affected_day: imp.affected_day != null ? Number(imp.affected_day) : null,
        affected_date: imp.affected_date ?? null,
        relationship_type: imp.relationship_type ?? null,
        time_relationship: imp.time_relationship ?? null,
        explanation: String(imp.explanation ?? 'No explanation provided'),
        evidence: Array.isArray(imp.evidence) ? imp.evidence : [],
        confidence: imp.confidence ?? 'UNKNOWN',
        status: 'ACTIVE'
      });
    }
    // If AI returned empty impacts, insert a NONE record so we have a record of the analysis
    if (impactRecords.length === 0) {
      impactRecords.push({
        user_id: effectiveUserId,
        trip_id,
        monitoring_event_id,
        monitored_entity_id: monEvent.monitored_entity_id ?? null,
        reservation_id: sourceResId ?? null,
        impact_type: 'OTHER',
        impact_level: 'NONE',
        explanation: aiResult.analysis_notes ?? 'No dependent trip components identified.',
        evidence: [],
        confidence: 'HIGH',
        status: 'ACTIVE'
      });
    }
  }
  // 10. Insert impact records
  const { data: insertedImpacts, error: insertErr } = await supabase.from('trip_impacts').insert(impactRecords).select();
  if (insertErr) {
    console.error('Insert error:', insertErr);
    return new Response(JSON.stringify({
      error: 'Failed to save impact analysis'
    }), {
      status: 500,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
  // 11. Return result
  return new Response(JSON.stringify({
    impacts: insertedImpacts ?? [],
    overall_impact_level: aiResult?.overall_impact_level ?? 'UNKNOWN',
    analysis_notes: aiResult?.analysis_notes ?? 'Analysis could not be completed.',
    event_id: monitoring_event_id
  }), {
    status: 200,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json'
    }
  });
});

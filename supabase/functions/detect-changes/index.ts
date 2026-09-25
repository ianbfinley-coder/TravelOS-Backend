// SECURITY 2026-09-17 — This function is called exclusively by
// process-snapshot-pipeline, which forwards `Authorization: Bearer
// <SUPABASE_SERVICE_ROLE_KEY>`. The previous handler only accepted a real
// user JWT (`supabase.auth.getUser(jwt)` against the service-role key fails,
// since the service key's `sub` is not a row in auth.users). That made every
// call from the pipeline return 401, which the pipeline then recorded as a
// CHECK_FAILED / FAILED snapshot — change detection has never actually run
// for a single snapshot processed through the pipeline. Fixed by accepting
// either a real user or the service-role key (`requireUserOrService`). For a
// service caller we trust `monitored_entity_id` from the body (the pipeline
// already verified ownership before invoking this function) instead of
// requiring a `user_id` match that a service caller cannot produce.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { requireUserOrService, serviceClient, corsHeaders } from './_shared/auth.ts';
// ─── Normalization ────────────────────────────────────────────────────────────
function tryParseDate(str) {
  const formats = [
    /^(\d{4})-(\d{2})-(\d{2})$/,
    /^(\d{2})\/(\d{2})\/(\d{4})$/
  ];
  for(let i = 0; i < formats.length; i++){
    const m = str.match(formats[i]);
    if (m) {
      if (i === 0) return str;
      if (i === 1) return `${m[3]}-${m[1]}-${m[2]}`;
    }
  }
  try {
    const d = new Date(str);
    if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
  } catch  {}
  return null;
}
function tryParseTime(str) {
  const ampm = str.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (ampm) {
    let h = parseInt(ampm[1]);
    const m = ampm[2];
    const period = ampm[3].toUpperCase();
    if (period === 'PM' && h !== 12) h += 12;
    if (period === 'AM' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${m}`;
  }
  const hhmm = str.match(/^(\d{1,2}):(\d{2})$/);
  if (hhmm) return `${String(parseInt(hhmm[1])).padStart(2, '0')}:${hhmm[2]}`;
  return null;
}
function normalizeState(state) {
  const normalized = {};
  for (const [key, value] of Object.entries(state)){
    if (value === null || value === undefined || value === '' || value === 'UNKNOWN') {
      normalized[key] = null;
      continue;
    }
    const str = String(value).trim();
    if (key.includes('date')) {
      const parsed = tryParseDate(str);
      normalized[key] = parsed || str.toLowerCase();
      continue;
    }
    if (key.includes('time') && !key.includes('date')) {
      const parsed = tryParseTime(str);
      normalized[key] = parsed || str.toLowerCase();
      continue;
    }
    if (key.includes('status')) {
      normalized[key] = str.toUpperCase().replace(/[\s-]/g, '_');
      continue;
    }
    if (key.includes('airport') || key.includes('iata')) {
      normalized[key] = str.toUpperCase().trim();
      continue;
    }
    normalized[key] = str.toLowerCase().trim();
  }
  return normalized;
}
// ─── Comparison ───────────────────────────────────────────────────────────────
function timeToMinutes(timeStr) {
  const m = timeStr.match(/^(\d{2}):(\d{2})$/);
  if (!m) return null;
  return parseInt(m[1]) * 60 + parseInt(m[2]);
}
function classifyFieldChange(field, prev, next) {
  const fieldLower = field.toLowerCase();
  if (fieldLower.includes('status')) {
    if (next?.includes('CANCEL')) {
      return {
        field,
        previousValue: prev,
        newValue: next,
        significance: 'MEANINGFUL',
        eventType: 'CANCELLATION'
      };
    }
    return {
      field,
      previousValue: prev,
      newValue: next,
      significance: 'MEANINGFUL',
      eventType: 'RESERVATION_CHANGE'
    };
  }
  if ((fieldLower.includes('departure_time') || fieldLower.includes('arrival_time')) && prev && next) {
    const prevMins = timeToMinutes(prev);
    const nextMins = timeToMinutes(next);
    const changeMagnitude = prevMins !== null && nextMins !== null ? {
      change_minutes: nextMins - prevMins,
      direction: nextMins > prevMins ? 'LATER' : 'EARLIER'
    } : undefined;
    return {
      field,
      previousValue: prev,
      newValue: next,
      significance: 'MEANINGFUL',
      eventType: 'SCHEDULE_CHANGE',
      changeMagnitude
    };
  }
  if (fieldLower.includes('departure_date') || fieldLower.includes('arrival_date') || fieldLower.includes('check_in') || fieldLower.includes('check_out')) {
    return {
      field,
      previousValue: prev,
      newValue: next,
      significance: 'MEANINGFUL',
      eventType: 'SCHEDULE_CHANGE'
    };
  }
  if (fieldLower.includes('airport')) {
    return {
      field,
      previousValue: prev,
      newValue: next,
      significance: 'MEANINGFUL',
      eventType: 'AIRPORT_CHANGE'
    };
  }
  if (fieldLower.includes('terminal')) {
    return {
      field,
      previousValue: prev,
      newValue: next,
      significance: 'INFORMATIONAL',
      eventType: 'TERMINAL_CHANGE'
    };
  }
  if (fieldLower.includes('gate')) {
    return {
      field,
      previousValue: prev,
      newValue: next,
      significance: 'INFORMATIONAL',
      eventType: 'GATE_CHANGE'
    };
  }
  if (fieldLower.includes('location') || fieldLower.includes('address') || fieldLower.includes('city')) {
    return {
      field,
      previousValue: prev,
      newValue: next,
      significance: 'MEANINGFUL',
      eventType: 'LOCATION_CHANGE'
    };
  }
  return {
    field,
    previousValue: prev,
    newValue: next,
    significance: 'INFORMATIONAL',
    eventType: 'OTHER'
  };
}
function compareStates(prev, next) {
  const allKeys = new Set([
    ...Object.keys(prev),
    ...Object.keys(next)
  ]);
  const differences = [];
  for (const key of allKeys){
    const prevVal = prev[key] ?? null;
    const nextVal = next[key] ?? null;
    if (prevVal === nextVal) continue;
    if (prevVal === null && nextVal === null) continue;
    const diff = classifyFieldChange(key, prevVal, nextVal);
    if (diff.significance !== 'NON_CHANGE') {
      differences.push(diff);
    }
  }
  return differences;
}
// ─── Grouping ─────────────────────────────────────────────────────────────────
function groupRelatedChanges(diffs) {
  const groups = {};
  for (const diff of diffs){
    const key = diff.eventType;
    if (!groups[key]) groups[key] = [];
    groups[key].push(diff);
  }
  return Object.values(groups);
}
// ─── Fingerprint ──────────────────────────────────────────────────────────────
function generateFingerprint(entityId, group) {
  const sorted = [
    ...group
  ].sort((a, b)=>a.field.localeCompare(b.field));
  const parts = [
    entityId,
    sorted[0]?.eventType || 'OTHER',
    ...sorted.map((d)=>`${d.field}:${d.previousValue ?? 'null'}→${d.newValue ?? 'null'}`)
  ];
  const str = parts.join('|');
  let hash = 5381;
  for(let i = 0; i < str.length; i++){
    hash = (hash << 5) + hash + str.charCodeAt(i);
    hash = hash & hash;
  }
  return `fp_${Math.abs(hash).toString(16)}_${sorted[0]?.eventType || 'OTHER'}`;
}
// ─── DB helpers ───────────────────────────────────────────────────────────────
async function fetchSnapshot(supabase, snapshotId) {
  const { data, error } = await supabase.from('monitoring_snapshots').select('*').eq('id', snapshotId).single();
  if (error) throw new Error(`Failed to fetch snapshot: ${error.message}`);
  return data;
}
async function fetchPreviousSnapshot(supabase, monitoredEntityId, excludeSnapshotId) {
  const { data, error } = await supabase.from('monitoring_snapshots').select('*').eq('monitored_entity_id', monitoredEntityId).neq('id', excludeSnapshotId).order('captured_at', {
    ascending: false
  }).limit(1).maybeSingle();
  if (error) throw new Error(`Failed to fetch previous snapshot: ${error.message}`);
  return data;
}
async function updateSnapshot(supabase, snapshotId, updates) {
  const { error } = await supabase.from('monitoring_snapshots').update(updates).eq('id', snapshotId);
  if (error) throw new Error(`Failed to update snapshot: ${error.message}`);
}
async function findExistingEvent(supabase, monitoredEntityId, fingerprint) {
  const { data, error } = await supabase.from('monitoring_events').select('*').eq('monitored_entity_id', monitoredEntityId).eq('fingerprint', fingerprint).neq('status', 'RESOLVED').order('created_at', {
    ascending: false
  }).limit(1).maybeSingle();
  if (error) throw new Error(`Failed to query existing events: ${error.message}`);
  return data;
}
async function updateEvent(supabase, eventId, updates) {
  const { error } = await supabase.from('monitoring_events').update({
    ...updates,
    updated_at: new Date().toISOString()
  }).eq('id', eventId);
  if (error) throw new Error(`Failed to update event: ${error.message}`);
}
async function createEvent(supabase, monitoredEntityId, tripId, group, fingerprint, snapshot) {
  const hasMeaningful = group.some((d)=>d.significance === 'MEANINGFUL');
  const primaryDiff = group[0];
  const timeDiff = group.find((d)=>d.changeMagnitude);
  // Build previous_value and new_value maps
  const previousValue = {};
  const newValue = {};
  for (const d of group){
    previousValue[d.field] = d.previousValue;
    newValue[d.field] = d.newValue;
  }
  const eventType = primaryDiff.eventType;
  // Map to valid monitoring_events event_type values
  const validEventTypes = [
    'SCHEDULE_CHANGE',
    'DELAY',
    'CANCELLATION',
    'LOCATION_CHANGE',
    'AIRPORT_CHANGE',
    'TERMINAL_CHANGE',
    'GATE_CHANGE',
    'RESERVATION_CHANGE',
    'CHECK_IN_CHANGE',
    'CHECK_OUT_CHANGE',
    'REQUIREMENT_CHANGE',
    'WEATHER_ALERT',
    'TRANSPORTATION_DISRUPTION',
    'OTHER'
  ];
  const resolvedEventType = validEventTypes.includes(eventType) ? eventType : 'OTHER';
  const { data, error } = await supabase.from('monitoring_events').insert({
    trip_id: tripId,
    monitored_entity_id: monitoredEntityId,
    event_type: resolvedEventType,
    event_source: 'SNAPSHOT_COMPARISON',
    previous_value: previousValue,
    new_value: newValue,
    changed_fields: group.map((d)=>d.field),
    change_category: hasMeaningful ? 'MEANINGFUL' : 'INFORMATIONAL',
    change_magnitude: timeDiff?.changeMagnitude ?? null,
    fingerprint,
    detection_method: 'SNAPSHOT_COMPARISON',
    is_duplicate: false,
    severity: hasMeaningful ? 'MEDIUM' : 'LOW',
    confidence: snapshot.source_timestamp ? 'HIGH' : 'MEDIUM',
    status: 'NEW',
    detected_at: new Date().toISOString(),
    source_reference: snapshot.source_reference ?? null,
    source_timestamp: snapshot.source_timestamp ?? null
  }).select().single();
  if (error) throw new Error(`Failed to create event: ${error.message}`);
  return data;
}
// ─── Core algorithm ───────────────────────────────────────────────────────────
async function detectChanges(supabase, monitoredEntityId, newSnapshotId, tripId) {
  // 1. Fetch new snapshot
  const newSnapshot = await fetchSnapshot(supabase, newSnapshotId);
  // 2. Fetch previous snapshot
  const prevSnapshot = await fetchPreviousSnapshot(supabase, monitoredEntityId, newSnapshotId);
  // 3. First snapshot
  if (!prevSnapshot) {
    await updateSnapshot(supabase, newSnapshotId, {
      check_result: 'FIRST_SNAPSHOT',
      check_notes: 'No previous snapshot to compare'
    });
    return {
      result: 'FIRST_SNAPSHOT',
      events: [],
      differences_found: 0,
      events_created: 0,
      events_deduplicated: 0
    };
  }
  // 4. Stale check
  if (newSnapshot.source_timestamp && prevSnapshot.source_timestamp) {
    if (new Date(newSnapshot.source_timestamp) < new Date(prevSnapshot.source_timestamp)) {
      await updateSnapshot(supabase, newSnapshotId, {
        is_stale: true,
        check_result: 'STALE',
        check_notes: 'Snapshot is older than existing state'
      });
      return {
        result: 'STALE',
        events: [],
        differences_found: 0,
        events_created: 0,
        events_deduplicated: 0
      };
    }
  }
  // 5. Normalize
  const prevNormalized = normalizeState(prevSnapshot.normalized_state);
  const newNormalized = normalizeState(newSnapshot.normalized_state);
  // 6. Compare
  const differences = compareStates(prevNormalized, newNormalized);
  // 7. No change
  if (differences.length === 0) {
    await updateSnapshot(supabase, newSnapshotId, {
      check_result: 'NO_CHANGE'
    });
    return {
      result: 'NO_CHANGE',
      events: [],
      differences_found: 0,
      events_created: 0,
      events_deduplicated: 0
    };
  }
  // 8. Classify
  const meaningful = differences.filter((d)=>d.significance === 'MEANINGFUL');
  const informational = differences.filter((d)=>d.significance === 'INFORMATIONAL');
  // 9. Group
  const eventGroups = groupRelatedChanges([
    ...meaningful,
    ...informational
  ]);
  // 10. Deduplicate and create events
  const events = [];
  let eventsCreated = 0;
  let eventsDeduplicated = 0;
  for (const group of eventGroups){
    const fingerprint = generateFingerprint(monitoredEntityId, group);
    const existing = await findExistingEvent(supabase, monitoredEntityId, fingerprint);
    if (existing) {
      await updateEvent(supabase, existing.id, {
        last_seen_at: new Date().toISOString()
      });
      events.push({
        ...existing,
        is_duplicate: true
      });
      eventsDeduplicated++;
    } else {
      const event = await createEvent(supabase, monitoredEntityId, tripId, group, fingerprint, newSnapshot);
      events.push(event);
      eventsCreated++;
    }
  }
  await updateSnapshot(supabase, newSnapshotId, {
    check_result: 'CHANGE_DETECTED'
  });
  return {
    result: 'CHANGE_DETECTED',
    events,
    differences_found: differences.length,
    events_created: eventsCreated,
    events_deduplicated: eventsDeduplicated
  };
}
// ─── Handler ──────────────────────────────────────────────────────────────────
Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: corsHeaders
    });
  }
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
  // Auth — accepts either a real user's JWT (client-triggered recheck) or the
  // service-role key (process-snapshot-pipeline). See SECURITY note above.
  const caller = await requireUserOrService(req);
  if (caller instanceof Response) return caller;
  const supabase = serviceClient();
  let body;
  try {
    body = await req.json();
  } catch  {
    return new Response(JSON.stringify({
      result: 'CHECK_FAILED',
      error: 'Invalid JSON body'
    }), {
      status: 400,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
  const { monitored_entity_id, new_snapshot_id } = body;
  if (!monitored_entity_id || !new_snapshot_id) {
    return new Response(JSON.stringify({
      result: 'CHECK_FAILED',
      error: 'monitored_entity_id and new_snapshot_id are required'
    }), {
      status: 400,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
  // Verify entity belongs to the caller. A real user must own the entity; a
  // service caller is trusted (the pipeline already verified ownership of
  // this monitored_entity_id against its own authenticated user before
  // calling here — there is no user token left to check it against).
  let entityQuery = supabase.from('monitored_entities').select('id, trip_id, user_id').eq('id', monitored_entity_id);
  if (caller.kind === 'user') {
    entityQuery = entityQuery.eq('user_id', caller.userId);
  }
  const { data: entity, error: entityError } = await entityQuery.single();
  if (entityError || !entity) {
    return new Response(JSON.stringify({
      error: 'Monitored entity not found or access denied'
    }), {
      status: 404,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
  try {
    const result = await detectChanges(supabase, monitored_entity_id, new_snapshot_id, entity.trip_id);
    return new Response(JSON.stringify({
      ...result,
      snapshot_id: new_snapshot_id,
      entity_id: monitored_entity_id
    }), {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    // Mark snapshot as failed
    try {
      await supabase.from('monitoring_snapshots').update({
        check_result: 'CHECK_FAILED',
        check_notes: message
      }).eq('id', new_snapshot_id);
    } catch  {}
    return new Response(JSON.stringify({
      result: 'CHECK_FAILED',
      error: message,
      snapshot_id: new_snapshot_id,
      entity_id: monitored_entity_id
    }), {
      status: 500,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
});

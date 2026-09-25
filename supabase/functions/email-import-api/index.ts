import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');
function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin ?? '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  };
}
function json(data, status = 200, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin)
    }
  });
}
async function getUser(req) {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return null;
  const jwt = authHeader.replace('Bearer ', '');
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: { user }, error } = await supabase.auth.getUser(jwt);
  if (error || !user) return null;
  return user;
}
// SECURITY 2026-09-17 — every route here was already scoped correctly by
// `.eq('user_id', user.id)` on reads and on the imports it owns. The one gap:
// `process_text` wrote a new `email_message_imports` row with
// `matched_trip_id: tripId` straight from the request body, with no check
// that tripId belonged to the caller. `confirm_import` later reads that same
// matched_trip_id and forwards it to reservations-api to create reservations
// — so a forged tripId here would have tried to plant reservations under a
// trip the caller does not own (reservations-api's own trip-ownership check,
// fixed the same day, is what actually stops the write, but this function
// should not manufacture a cross-tenant reference in the first place).
async function verifyTripOwnership(supabase, tripId, userId) {
  const { data } = await supabase.from('trips').select('id').eq('id', tripId).eq('user_id', userId).maybeSingle();
  return !!data;
}
Deno.serve(async (req)=>{
  const origin = req.headers.get('origin') ?? undefined;
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(origin)
    });
  }
  const user = await getUser(req);
  if (!user) return json({
    error: 'Unauthorized'
  }, 403, origin);
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const url = new URL(req.url);
  // ── GET routes ────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const action = url.searchParams.get('action');
    // GET ?action=connection
    if (action === 'connection') {
      const { data: connection } = await supabase.from('email_connections').select('id, provider, account_identifier, connection_status, import_preferences, last_sync_at, connected_at').eq('user_id', user.id).order('created_at', {
        ascending: false
      }).limit(1).maybeSingle();
      return json({
        connection: connection ?? null,
        available_providers: [
          'GMAIL',
          'OUTLOOK',
          'ICLOUD'
        ],
        integration_status: 'COMING_SOON'
      }, 200, origin);
    }
    // GET ?action=inbox&trip_id=<uuid>
    if (action === 'inbox') {
      const tripId = url.searchParams.get('trip_id');
      if (!tripId) return json({
        error: 'trip_id is required'
      }, 400, origin);
      const { data: imports, error } = await supabase.from('email_message_imports').select('id, sender, subject, received_at, detected_travel_relevance, detected_reservation_types, extraction_status, confidence, created_at').eq('user_id', user.id).eq('matched_trip_id', tripId).order('created_at', {
        ascending: false
      }).limit(50);
      if (error) return json({
        error: 'Failed to fetch inbox'
      }, 500, origin);
      const readyCount = (imports ?? []).filter((i)=>i.extraction_status === 'READY_FOR_REVIEW').length;
      return json({
        imports: imports ?? [],
        total_count: (imports ?? []).length,
        ready_for_review_count: readyCount
      }, 200, origin);
    }
    // GET ?action=history
    if (action === 'history') {
      const { data: history, error } = await supabase.from('email_import_history').select('import_date, messages_reviewed, imported_count, duplicate_count, ready_for_review_count').eq('user_id', user.id).limit(30);
      if (error) return json({
        error: 'Failed to fetch history'
      }, 500, origin);
      return json({
        history: history ?? []
      }, 200, origin);
    }
    return json({
      error: 'Unknown action'
    }, 400, origin);
  }
  // ── POST routes ────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    let body;
    try {
      body = await req.json();
    } catch  {
      return json({
        error: 'Invalid JSON body'
      }, 400, origin);
    }
    const action = body.action;
    // POST update_preferences
    if (action === 'update_preferences') {
      const preferences = body.preferences;
      if (!preferences) return json({
        error: 'preferences is required'
      }, 400, origin);
      // Upsert: find existing or create
      const { data: existing } = await supabase.from('email_connections').select('id').eq('user_id', user.id).limit(1).maybeSingle();
      let result;
      if (existing) {
        const { data, error } = await supabase.from('email_connections').update({
          import_preferences: preferences
        }).eq('id', existing.id).select('import_preferences').single();
        if (error) return json({
          error: 'Failed to update preferences'
        }, 500, origin);
        result = data;
      } else {
        const { data, error } = await supabase.from('email_connections').insert({
          user_id: user.id,
          provider: 'OTHER',
          connection_status: 'DISCONNECTED',
          import_preferences: preferences
        }).select('import_preferences').single();
        if (error) return json({
          error: 'Failed to create connection record'
        }, 500, origin);
        result = data;
      }
      return json({
        success: true,
        preferences: result.import_preferences
      }, 200, origin);
    }
    // POST process_text
    if (action === 'process_text') {
      const text = body.text;
      const tripId = body.trip_id;
      const subject = body.subject ?? null;
      const sender = body.sender ?? null;
      if (!text) return json({
        error: 'text is required'
      }, 400, origin);
      if (!tripId) return json({
        error: 'trip_id is required'
      }, 400, origin);
      const ownsTrip = await verifyTripOwnership(supabase, tripId, user.id);
      if (!ownsTrip) return json({
        error: 'Trip not found'
      }, 404, origin);
      // 1. Create import record with ANALYZING status
      const { data: importRecord, error: insertError } = await supabase.from('email_message_imports').insert({
        user_id: user.id,
        sender,
        subject,
        body_available: true,
        extraction_status: 'ANALYZING',
        matched_trip_id: tripId
      }).select().single();
      if (insertError || !importRecord) {
        return json({
          error: 'Failed to create import record'
        }, 500, origin);
      }
      const importId = importRecord.id;
      try {
        // 2. Call parse-reservation function
        const authHeader = req.headers.get('Authorization');
        const parseRes = await fetch(`${SUPABASE_URL}/functions/v1/parse-reservation`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': authHeader,
            'apikey': SUPABASE_ANON_KEY
          },
          body: JSON.stringify({
            text,
            trip_id: tripId
          })
        });
        if (!parseRes.ok) {
          throw new Error(`parse-reservation returned ${parseRes.status}`);
        }
        const parseResult = await parseRes.json();
        const reservations = parseResult.reservations ?? [];
        const reservationCount = reservations.length;
        // 3. Classify travel relevance
        let travelRelevance;
        let extractionStatus;
        if (reservationCount > 0) {
          travelRelevance = 'TRAVEL_RELEVANT';
          extractionStatus = 'READY_FOR_REVIEW';
        } else if (parseResult.possibly_travel_relevant) {
          travelRelevance = 'POSSIBLY_TRAVEL_RELEVANT';
          extractionStatus = 'READY_FOR_REVIEW';
        } else {
          travelRelevance = 'NOT_TRAVEL_RELEVANT';
          extractionStatus = 'READY_FOR_REVIEW';
        }
        // 4. Trip matching — fetch trip to check dates/destination
        let tripMatchConfidence = 'UNKNOWN';
        const { data: trip } = await supabase.from('trips').select('id, destination, start_date, end_date').eq('id', tripId).eq('user_id', user.id).maybeSingle();
        if (trip && reservationCount > 0) {
          // Simple heuristic: if trip destination appears in text, HIGH confidence
          const destMatch = trip.destination && text.toLowerCase().includes(trip.destination.toLowerCase());
          if (destMatch) {
            tripMatchConfidence = 'HIGH';
          } else {
            tripMatchConfidence = 'MEDIUM';
          }
        } else if (trip) {
          tripMatchConfidence = 'LOW';
        }
        // 5. Detect reservation types
        const detectedTypes = [];
        if (Array.isArray(reservations)) {
          for (const r of reservations){
            const t = r.type;
            if (t && !detectedTypes.includes(t)) detectedTypes.push(t);
          }
        }
        // 6. Overall confidence
        const overallConfidence = parseResult.overall_confidence ?? (reservationCount > 0 ? 'MEDIUM' : 'LOW');
        // 7. Update import record
        await supabase.from('email_message_imports').update({
          extraction_status: extractionStatus,
          detected_travel_relevance: travelRelevance,
          detected_reservation_types: detectedTypes,
          trip_match_confidence: tripMatchConfidence,
          confidence: overallConfidence,
          extraction_result: parseResult,
          matched_trip_id: tripId
        }).eq('id', importId);
        return json({
          import_id: importId,
          extraction_status: extractionStatus,
          detected_travel_relevance: travelRelevance,
          reservations_found: reservationCount,
          overall_confidence: overallConfidence,
          extraction_notes: parseResult.extraction_notes ?? null,
          reservations,
          matched_trip_id: tripId,
          trip_match_confidence: tripMatchConfidence
        }, 200, origin);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : 'Unknown error';
        await supabase.from('email_message_imports').update({
          extraction_status: 'ERROR',
          error_message: errMsg
        }).eq('id', importId);
        return json({
          import_id: importId,
          extraction_status: 'ERROR',
          detected_travel_relevance: 'UNKNOWN',
          reservations_found: 0,
          overall_confidence: 'LOW',
          extraction_notes: errMsg,
          reservations: [],
          matched_trip_id: tripId,
          trip_match_confidence: 'UNKNOWN'
        }, 200, origin);
      }
    }
    // POST confirm_import
    if (action === 'confirm_import') {
      const importId = body.import_id;
      const selectedReservations = body.selected_reservations;
      if (!importId) return json({
        error: 'import_id is required'
      }, 400, origin);
      if (!Array.isArray(selectedReservations)) return json({
        error: 'selected_reservations must be an array'
      }, 400, origin);
      // Verify import belongs to user
      const { data: importRecord } = await supabase.from('email_message_imports').select('id, matched_trip_id').eq('id', importId).eq('user_id', user.id).maybeSingle();
      if (!importRecord) return json({
        error: 'Import not found'
      }, 404, origin);
      const authHeader = req.headers.get('Authorization');
      const createdIds = [];
      // Save each selected reservation via reservations-api
      for (const reservation of selectedReservations){
        try {
          const resPayload = {
            ...reservation,
            trip_id: importRecord.matched_trip_id,
            source_type: 'OTHER',
            source_reference: `EMAIL_IMPORT:${importId}`
          };
          const resResponse = await fetch(`${SUPABASE_URL}/functions/v1/reservations-api`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': authHeader,
              'apikey': SUPABASE_ANON_KEY
            },
            body: JSON.stringify(resPayload)
          });
          if (resResponse.ok) {
            const resData = await resResponse.json();
            const newId = resData.id ?? resData.reservation?.id;
            if (newId) createdIds.push(newId);
          }
        } catch  {
        // Continue with remaining reservations
        }
      }
      // Update import record
      await supabase.from('email_message_imports').update({
        extraction_status: 'IMPORTED',
        imported_reservation_ids: createdIds
      }).eq('id', importId);
      // Fire-and-forget: analyze trip health
      if (importRecord.matched_trip_id) {
        const tripId = importRecord.matched_trip_id;
        fetch(`${SUPABASE_URL}/functions/v1/analyze-trip-health`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': authHeader,
            'apikey': SUPABASE_ANON_KEY
          },
          body: JSON.stringify({
            trip_id: tripId
          })
        }).catch(()=>{});
        fetch(`${SUPABASE_URL}/functions/v1/detect-trip-issues`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': authHeader,
            'apikey': SUPABASE_ANON_KEY
          },
          body: JSON.stringify({
            trip_id: tripId
          })
        }).catch(()=>{});
      }
      return json({
        success: true,
        imported_count: createdIds.length,
        reservation_ids: createdIds,
        import_id: importId
      }, 200, origin);
    }
    // POST ignore_import
    if (action === 'ignore_import') {
      const importId = body.import_id;
      if (!importId) return json({
        error: 'import_id is required'
      }, 400, origin);
      const { error } = await supabase.from('email_message_imports').update({
        extraction_status: 'IGNORED'
      }).eq('id', importId).eq('user_id', user.id);
      if (error) return json({
        error: 'Failed to update import'
      }, 500, origin);
      return json({
        success: true
      }, 200, origin);
    }
    return json({
      error: 'Unknown action'
    }, 400, origin);
  }
  return json({
    error: 'Method not allowed'
  }, 405, origin);
});

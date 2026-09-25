import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const OPENROUTER_API_KEY = Deno.env.get('OPENROUTER_API_KEY');
const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/pdf'
];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};
const SYSTEM_PROMPT = `You are a travel reservation extraction assistant. Analyze the provided document and extract any travel reservation information.

CRITICAL RULES:
1. NEVER invent, guess, or fabricate any information not clearly visible in the document
2. If text is unclear or unreadable, mark it as UNKNOWN
3. Do not infer dates from context
4. Do not guess confirmation numbers or identifiers
5. If the image quality is poor, note it in quality_warning
6. Payment card numbers should be excluded
7. Respond with ONLY valid JSON

If this is not a travel document, set reservations_found to 0.`;
const EXTRACTION_PROMPT = `Analyze this document and extract any travel reservation information. Return JSON in this exact format:
{
  "is_travel_document": boolean,
  "travel_relevance": "TRAVEL_RELEVANT" | "POSSIBLY_TRAVEL_RELEVANT" | "NOT_TRAVEL_RELEVANT",
  "quality_warning": "string or null",
  "reservations_found": number,
  "overall_confidence": "HIGH" | "MEDIUM" | "LOW",
  "extraction_notes": "string",
  "reservations": [
    {
      "reservation_type": "FLIGHT" | "HOTEL" | "RENTAL_CAR" | "TRAIN" | "BUS" | "RESTAURANT" | "TOUR" | "ACTIVITY" | "EVENT" | "CRUISE" | "TRANSFER" | "OTHER",
      "provider_name": "string or null",
      "confirmation_number": "string or null",
      "reservation_status": "CONFIRMED" | "PENDING" | "CANCELLED" | "UNKNOWN",
      "traveler_names": ["string"] or null,
      "start_date": "YYYY-MM-DD or null",
      "start_time": "HH:MM or null",
      "end_date": "YYYY-MM-DD or null",
      "end_time": "HH:MM or null",
      "timezone": "string or null",
      "location_name": "string or null",
      "city": "string or null",
      "country": "string or null",
      "notes": "string or null",
      "confidence": "HIGH" | "MEDIUM" | "LOW",
      "field_confidence": {
        "provider_name": "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN",
        "confirmation_number": "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN",
        "start_date": "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN",
        "start_time": "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN",
        "end_date": "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN",
        "end_time": "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN",
        "location": "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN"
      },
      "details": {},
      "date_ambiguity": "string or null",
      "missing_critical_fields": ["string"]
    }
  ]
}`;
function parseAIResponse(text) {
  // Strip markdown code blocks if present
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
  }
  return JSON.parse(cleaned);
}
async function callOpenRouter(messages) {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://travelos.app',
      'X-Title': 'TravelOS Document Import'
    },
    body: JSON.stringify({
      model: 'google/gemini-3.5-flash',
      messages,
      max_tokens: 2000,
      temperature: 0.1
    })
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenRouter error ${response.status}: ${err}`);
  }
  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty response from AI');
  return parseAIResponse(content);
}
async function processImage(fileData, mimeType) {
  const arrayBuffer = await fileData.arrayBuffer();
  const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
  return callOpenRouter([
    {
      role: 'system',
      content: SYSTEM_PROMPT
    },
    {
      role: 'user',
      content: [
        {
          type: 'image_url',
          image_url: {
            url: `data:${mimeType};base64,${base64}`
          }
        },
        {
          type: 'text',
          text: EXTRACTION_PROMPT
        }
      ]
    }
  ]);
}
async function processPDF(fileData, filename) {
  const arrayBuffer = await fileData.arrayBuffer();
  const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
  // Try file content type first (Gemini supports PDF natively via OpenRouter)
  try {
    return await callOpenRouter([
      {
        role: 'system',
        content: SYSTEM_PROMPT
      },
      {
        role: 'user',
        content: [
          {
            type: 'file',
            file: {
              filename: filename || 'document.pdf',
              file_data: `data:application/pdf;base64,${base64}`
            }
          },
          {
            type: 'text',
            text: EXTRACTION_PROMPT
          }
        ]
      }
    ]);
  } catch (_e) {
    // Fallback: send as image_url with pdf mime type
    try {
      return await callOpenRouter([
        {
          role: 'system',
          content: SYSTEM_PROMPT
        },
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url: `data:application/pdf;base64,${base64}`
              }
            },
            {
              type: 'text',
              text: EXTRACTION_PROMPT
            }
          ]
        }
      ]);
    } catch (_e2) {
      // Final fallback: extract readable ASCII text from PDF bytes and use text-based parsing
      const bytes = new Uint8Array(arrayBuffer);
      let text = '';
      for(let i = 0; i < bytes.length; i++){
        const c = bytes[i];
        if (c >= 32 && c < 127) text += String.fromCharCode(c);
        else if (c === 10 || c === 13) text += ' ';
      }
      // Clean up repeated whitespace
      const cleanText = text.replace(/\s+/g, ' ').substring(0, 8000);
      return callOpenRouter([
        {
          role: 'system',
          content: SYSTEM_PROMPT
        },
        {
          role: 'user',
          content: `Here is the extracted text from a PDF document. Extract any travel reservation information.\n\nDocument text:\n${cleanText}\n\n${EXTRACTION_PROMPT}`
        }
      ]);
    }
  }
}
async function checkDuplicates(supabase, userId, tripId, reservation) {
  if (!reservation.confirmation_number) return false;
  const { data } = await supabase.from('reservations').select('id').eq('user_id', userId).eq('trip_id', tripId).eq('confirmation_number', reservation.confirmation_number).limit(1);
  return (data?.length ?? 0) > 0;
}
// SECURITY 2026-09-17 — `process`, `confirm_import`, `ignore`, and GET list
// all correctly resolved the document_imports row by id AND `user_id`
// before touching it. `upload_url` was the one write that took `trip_id`
// straight from the request body with no check that the trip belonged to
// the caller, letting a caller create a document_imports row (owned by
// themselves) tagged with someone else's trip_id. Fixed the same way as the
// sibling document/reservation endpoints: verify ownership before writing.
async function verifyTripOwnership(supabase, tripId, userId) {
  const { data } = await supabase.from('trips').select('id').eq('id', tripId).eq('user_id', userId).maybeSingle();
  return !!data;
}
Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: corsHeaders
    });
  }
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response(JSON.stringify({
      error: 'Unauthorized'
    }), {
      status: 401,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
  const jwt = authHeader.replace('Bearer ', '');
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: { user }, error: authError } = await supabase.auth.getUser(jwt);
  if (authError || !user) {
    return new Response(JSON.stringify({
      error: 'Unauthorized'
    }), {
      status: 401,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
  const userId = user.id;
  const url = new URL(req.url);
  try {
    // ── GET: list imports ───────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const action = url.searchParams.get('action');
      const tripId = url.searchParams.get('trip_id');
      if (action !== 'list' || !tripId) {
        return new Response(JSON.stringify({
          error: 'Invalid request'
        }), {
          status: 400,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      const { data: imports, error } = await supabase.from('document_imports').select('*').eq('user_id', userId).eq('trip_id', tripId).order('created_at', {
        ascending: false
      });
      if (error) throw error;
      return new Response(JSON.stringify({
        imports: imports ?? [],
        total_count: imports?.length ?? 0
      }), {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // ── POST actions ─────────────────────────────────────────────────────
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
    const body = await req.json();
    const action = body.action;
    // ── upload_url ────────────────────────────────────────────────────────
    if (action === 'upload_url') {
      const { trip_id, filename, mime_type, file_size_bytes, source_type } = body;
      if (!trip_id || !filename || !mime_type || !file_size_bytes) {
        return new Response(JSON.stringify({
          error: 'Missing required fields: trip_id, filename, mime_type, file_size_bytes'
        }), {
          status: 400,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      const ownsTrip = await verifyTripOwnership(supabase, trip_id, userId);
      if (!ownsTrip) {
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
      if (!ALLOWED_MIME_TYPES.includes(mime_type)) {
        return new Response(JSON.stringify({
          error: `Unsupported file type: ${mime_type}. Allowed: ${ALLOWED_MIME_TYPES.join(', ')}`
        }), {
          status: 400,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      if (file_size_bytes > MAX_FILE_SIZE) {
        return new Response(JSON.stringify({
          error: 'File too large. Maximum size is 10MB.'
        }), {
          status: 400,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      // Determine source_type from mime_type if not provided
      let resolvedSourceType = source_type ?? 'OTHER';
      if (!source_type) {
        if (mime_type === 'application/pdf') resolvedSourceType = 'PDF';
        else if (mime_type.startsWith('image/')) resolvedSourceType = 'IMAGE';
      }
      // Create document_imports record
      const { data: importRecord, error: insertError } = await supabase.from('document_imports').insert({
        user_id: userId,
        trip_id,
        source_type: resolvedSourceType,
        filename,
        mime_type,
        file_size_bytes,
        processing_status: 'UPLOADED'
      }).select().single();
      if (insertError || !importRecord) {
        throw insertError ?? new Error('Failed to create import record');
      }
      const importId = importRecord.id;
      const storagePath = `${userId}/${importId}/${filename}`;
      // Generate signed upload URL
      const { data: signedData, error: signedError } = await supabase.storage.from('document-imports').createSignedUploadUrl(storagePath);
      if (signedError || !signedData) {
        throw signedError ?? new Error('Failed to create signed upload URL');
      }
      // Update record with storage_path
      await supabase.from('document_imports').update({
        storage_path: storagePath
      }).eq('id', importId);
      return new Response(JSON.stringify({
        import_id: importId,
        upload_url: signedData.signedUrl,
        storage_path: storagePath,
        expires_in: 300
      }), {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // ── process ───────────────────────────────────────────────────────────
    if (action === 'process') {
      const { import_id } = body;
      if (!import_id) {
        return new Response(JSON.stringify({
          error: 'Missing import_id'
        }), {
          status: 400,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      // Fetch record and verify ownership
      const { data: record, error: fetchError } = await supabase.from('document_imports').select('*').eq('id', import_id).eq('user_id', userId).single();
      if (fetchError || !record) {
        return new Response(JSON.stringify({
          error: 'Document import not found'
        }), {
          status: 404,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      if (!record.storage_path) {
        return new Response(JSON.stringify({
          error: 'File not yet uploaded'
        }), {
          status: 400,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      // Update status to PROCESSING
      await supabase.from('document_imports').update({
        processing_status: 'PROCESSING'
      }).eq('id', import_id);
      // Download file from storage
      const { data: fileData, error: downloadError } = await supabase.storage.from('document-imports').download(record.storage_path);
      if (downloadError || !fileData) {
        await supabase.from('document_imports').update({
          processing_status: 'FAILED',
          error_message: 'Failed to download file from storage',
          processed_at: new Date().toISOString()
        }).eq('id', import_id);
        return new Response(JSON.stringify({
          error: 'Failed to download file from storage'
        }), {
          status: 500,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      // Call AI based on mime type
      let extractionResult;
      try {
        if (record.mime_type === 'application/pdf') {
          extractionResult = await processPDF(fileData, record.filename ?? 'document.pdf');
        } else {
          extractionResult = await processImage(fileData, record.mime_type);
        }
      } catch (aiError) {
        const errMsg = aiError instanceof Error ? aiError.message : 'AI processing failed';
        await supabase.from('document_imports').update({
          processing_status: 'FAILED',
          error_message: errMsg,
          processed_at: new Date().toISOString()
        }).eq('id', import_id);
        return new Response(JSON.stringify({
          error: 'Document processing failed',
          details: errMsg
        }), {
          status: 500,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      // Run duplicate detection
      const reservations = extractionResult.reservations ?? [];
      const deduplicatedReservations = await Promise.all(reservations.map(async (res)=>{
        const isDuplicate = await checkDuplicates(supabase, userId, record.trip_id, res);
        return {
          ...res,
          is_duplicate: isDuplicate
        };
      }));
      extractionResult.reservations = deduplicatedReservations;
      const reservationsFound = extractionResult.reservations_found ?? reservations.length;
      const processingStatus = reservationsFound > 0 ? 'READY_FOR_REVIEW' : 'NO_RESERVATION_FOUND';
      // Map overall_confidence to extraction_confidence enum
      const confidenceMap = {
        HIGH: 'HIGH',
        MEDIUM: 'MEDIUM',
        LOW: 'LOW'
      };
      const extractionConfidence = confidenceMap[extractionResult.overall_confidence] ?? 'UNKNOWN';
      // Update document_imports record
      await supabase.from('document_imports').update({
        processing_status: processingStatus,
        travel_relevance: extractionResult.travel_relevance ?? 'UNKNOWN',
        extraction_confidence: extractionConfidence,
        extraction_notes: extractionResult.extraction_notes ?? null,
        reservations_found: reservationsFound,
        extracted_data: extractionResult,
        quality_warning: extractionResult.quality_warning ?? null,
        processed_at: new Date().toISOString()
      }).eq('id', import_id);
      return new Response(JSON.stringify({
        import_id,
        processing_status: processingStatus,
        ...extractionResult
      }), {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // ── confirm_import ────────────────────────────────────────────────────
    if (action === 'confirm_import') {
      const { import_id, selected_reservations } = body;
      if (!import_id || !Array.isArray(selected_reservations)) {
        return new Response(JSON.stringify({
          error: 'Missing import_id or selected_reservations'
        }), {
          status: 400,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      // Fetch record and verify ownership
      const { data: record, error: fetchError } = await supabase.from('document_imports').select('*').eq('id', import_id).eq('user_id', userId).single();
      if (fetchError || !record) {
        return new Response(JSON.stringify({
          error: 'Document import not found'
        }), {
          status: 404,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      const reservationIds = [];
      // Save each selected reservation via reservations-api
      for (const res of selected_reservations){
        try {
          const resResponse = await fetch(`${SUPABASE_URL}/functions/v1/reservations-api`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${jwt}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              action: 'create',
              trip_id: record.trip_id,
              reservation_type: res.reservation_type ?? 'OTHER',
              provider_name: res.provider_name ?? null,
              confirmation_number: res.confirmation_number ?? null,
              reservation_status: res.reservation_status ?? 'CONFIRMED',
              traveler_names: res.traveler_names ?? null,
              start_date: res.start_date ?? null,
              start_time: res.start_time ?? null,
              end_date: res.end_date ?? null,
              end_time: res.end_time ?? null,
              timezone: res.timezone ?? null,
              location_name: res.location_name ?? null,
              city: res.city ?? null,
              country: res.country ?? null,
              notes: res.notes ?? null,
              source_type: 'OTHER',
              source_reference: `DOCUMENT_IMPORT:${import_id}`,
              extraction_confidence: res.confidence ?? 'UNKNOWN',
              field_confidence: res.field_confidence ?? null,
              details: res.details ?? {}
            })
          });
          if (resResponse.ok) {
            const resData = await resResponse.json();
            const resId = resData?.reservation?.id ?? resData?.id;
            if (resId) reservationIds.push(resId);
          }
        } catch (_e) {
        // Continue with other reservations even if one fails
        }
      }
      // Update document_imports record
      await supabase.from('document_imports').update({
        processing_status: 'IMPORTED',
        extracted_reservation_ids: reservationIds
      }).eq('id', import_id);
      // Fire-and-forget: analyze-trip-health and detect-trip-issues
      const tripId = record.trip_id;
      Promise.all([
        fetch(`${SUPABASE_URL}/functions/v1/analyze-trip-health`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${jwt}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            trip_id: tripId
          })
        }).catch(()=>{}),
        fetch(`${SUPABASE_URL}/functions/v1/detect-trip-issues`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${jwt}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            trip_id: tripId
          })
        }).catch(()=>{})
      ]);
      return new Response(JSON.stringify({
        success: true,
        imported_count: reservationIds.length,
        reservation_ids: reservationIds,
        import_id
      }), {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // ── ignore ───────────────────────────────────────────────────────────
    if (action === 'ignore') {
      const { import_id } = body;
      if (!import_id) {
        return new Response(JSON.stringify({
          error: 'Missing import_id'
        }), {
          status: 400,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      const { error: updateError } = await supabase.from('document_imports').update({
        processing_status: 'NO_RESERVATION_FOUND'
      }).eq('id', import_id).eq('user_id', userId);
      if (updateError) throw updateError;
      return new Response(JSON.stringify({
        success: true,
        import_id
      }), {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    return new Response(JSON.stringify({
      error: `Unknown action: ${action}`
    }), {
      status: 400,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error('process-document error:', message);
    return new Response(JSON.stringify({
      error: 'Internal server error'
    }), {
      status: 500,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
});

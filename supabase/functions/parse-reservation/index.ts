import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
const systemPrompt = `You are a reservation data extraction assistant for a travel planning app.

Your job is to analyze pasted booking confirmation text and extract structured reservation information.

CRITICAL RULES:
1. NEVER invent, guess, or fabricate any information not explicitly present in the text
2. If a field is not clearly present, set it to null
3. Do not infer dates from context (e.g. if year is missing, set year to null)
4. Do not guess confirmation numbers, flight numbers, or any identifiers
5. Do not assume reservation status unless explicitly stated (e.g. "confirmed", "pending")
6. Preserve exact times and dates as found in the text
7. If timezone is not explicitly stated, set it to null
8. Payment card numbers should be redacted - do not include them in output
9. Passwords, tokens, or credentials should be excluded

You must respond with ONLY valid JSON matching the schema below. No explanation text.`;
function buildUserPrompt(text) {
  return `Analyze this booking confirmation text and extract all reservation information.

TEXT:
"""
${text}
"""

Respond with this exact JSON structure:
{
  "reservations_found": number,
  "overall_confidence": "HIGH" | "MEDIUM" | "LOW",
  "extraction_notes": "brief note about extraction quality or issues",
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
      "address": "string or null",
      "city": "string or null",
      "state_or_region": "string or null",
      "country": "string or null",
      "notes": "any additional relevant information not captured elsewhere, or null",
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
      "missing_critical_fields": ["list of field names that are missing but important for this reservation type"]
    }
  ]
}

If no reservation information can be identified, return:
{
  "reservations_found": 0,
  "overall_confidence": "LOW",
  "extraction_notes": "No reservation information could be identified in the provided text",
  "reservations": []
}`;
}
function sanitizeText(text) {
  return text.replace(/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, '[REDACTED]').replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED]');
}
function extractJsonFromAiResponse(content) {
  // Strip markdown code blocks if present
  const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }
  return content.trim();
}
// DEFECT 2026-09-19 (silent duplicate-check failure) — the duplicate lookup
// below interpolated model-extracted strings straight into a PostgREST `.or()`
// filter:
//   `confirmation_number.eq.${confirmationNumber}`
//   `and(reservation_type.eq.${t},start_date.eq.${d},provider_name.eq.${p})`
// PostgREST parses that filter as a comma-separated grammar, so ANY comma,
// parenthesis or period in the value broke it and the whole request came back
// 400 (PGRST100). Provider names contain commas constantly — "Marriott Hotels,
// Inc.", "Hertz (Downtown)", "Booking.com" — as do plenty of confirmation
// numbers. Worse, the result was destructured `const { data: duplicate }`, so
// the error was thrown away and `duplicate` came back null, which the code
// reads as "no duplicate exists". The user was then told a reservation they
// had already imported was new, and imported it a second time. Values are now
// double-quoted (PostgREST's own escaping for filter values), the error is
// captured, and a check that could not be performed reports itself instead of
// masquerading as a clean result.
function quoteFilterValue(value) {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
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
  // Auth
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return new Response(JSON.stringify({
      error: 'Missing authorization header'
    }), {
      status: 401,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
  const supabase = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_ANON_KEY'), {
    global: {
      headers: {
        Authorization: authHeader
      }
    }
  });
  const jwt = authHeader.replace('Bearer ', '');
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
  const { text, trip_id } = body;
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
  // Verify trip ownership.
  //
  // DEFECT 2026-09-19 (failure-looks-like-absence) — this was `.single()` with
  // `if (tripError || !trip) return 403`. A failed query was reported to the
  // user as "Trip not found or access denied" — telling them they lack access
  // to their own trip — and the real error was discarded. Split: query failure
  // is a 500 that names it; a genuine non-match stays 403 as before.
  const { data: trip, error: tripError } = await supabase.from('trips').select('id').eq('id', trip_id).eq('user_id', user.id).maybeSingle();
  if (tripError) {
    console.error('[parse-reservation] trip lookup failed:', tripError.code, tripError.message);
    return new Response(JSON.stringify({
      error: 'Failed to verify trip',
      detail: tripError.message
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
      error: 'Trip not found or access denied'
    }), {
      status: 403,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
  // Handle empty/short text
  if (!text || text.trim().length < 10) {
    return new Response(JSON.stringify({
      reservations_found: 0,
      extraction_notes: 'No text provided',
      reservations: [],
      trip_id
    }), {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
  // Truncate if too long
  let processedText = text;
  let truncationNote = '';
  if (text.length > 10000) {
    processedText = text.slice(0, 10000);
    truncationNote = ' (Note: input was truncated to 10,000 characters)';
  }
  // Sanitize input text
  processedText = sanitizeText(processedText);
  // Call OpenRouter
  const userPrompt = buildUserPrompt(processedText);
  let aiResult;
  try {
    const aiResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${Deno.env.get('OPENROUTER_API_KEY')}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://travelos.app',
        'X-Title': 'TravelOS Reservation Parser'
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
        temperature: 0.1
      })
    });
    if (!aiResponse.ok) {
      const errText = await aiResponse.text().catch(()=>'<unreadable>');
      throw new Error(`OpenRouter returned ${aiResponse.status}: ${errText.slice(0, 300)}`);
    }
    const aiData = await aiResponse.json();
    const rawContent = aiData?.choices?.[0]?.message?.content;
    if (!rawContent) {
      throw new Error('Empty response from AI');
    }
    const jsonStr = extractJsonFromAiResponse(rawContent);
    aiResult = JSON.parse(jsonStr);
  } catch (err) {
    console.error('AI call failed:', err);
    return new Response(JSON.stringify({
      error: 'Analysis failed. Please try again.'
    }), {
      status: 500,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
  // Apply truncation note if needed
  if (truncationNote && aiResult.extraction_notes) {
    aiResult.extraction_notes += truncationNote;
  } else if (truncationNote) {
    aiResult.extraction_notes = truncationNote.trim();
  }
  // Duplicate check for each reservation
  const reservations = aiResult.reservations ?? [];
  const enrichedReservations = await Promise.all(reservations.map(async (res)=>{
    const confirmationNumber = typeof res.confirmation_number === 'string' && res.confirmation_number.trim() ? res.confirmation_number.trim() : null;
    const reservationType = typeof res.reservation_type === 'string' ? res.reservation_type : null;
    const startDate = typeof res.start_date === 'string' ? res.start_date : null;
    const providerName = typeof res.provider_name === 'string' && res.provider_name.trim() ? res.provider_name.trim() : null;
    const clauses = [];
    if (confirmationNumber) {
      clauses.push(`confirmation_number.eq.${quoteFilterValue(confirmationNumber)}`);
    }
    if (reservationType && startDate && providerName) {
      clauses.push(`and(reservation_type.eq.${quoteFilterValue(reservationType)},` + `start_date.eq.${quoteFilterValue(startDate)},` + `provider_name.eq.${quoteFilterValue(providerName)})`);
    }
    // Previously an empty clause list still ran the query with `.or('')`,
    // which PostgREST rejects outright — another 400 swallowed into "no
    // duplicate". With nothing to match on, there is simply nothing to check.
    if (clauses.length === 0) {
      return {
        ...res,
        possible_duplicate_id: null,
        possible_duplicate_info: null,
        duplicate_check: 'skipped_insufficient_data'
      };
    }
    const { data: duplicate, error: duplicateError } = await supabase.from('reservations').select('id, reservation_type, provider_name, confirmation_number, start_date').eq('trip_id', trip_id).or(clauses.join(',')).limit(1).maybeSingle();
    if (duplicateError) {
      // Do NOT report "not a duplicate" when the check itself failed — that
      // is precisely how duplicates got imported before.
      console.error('[parse-reservation] duplicate check failed:', duplicateError.code, duplicateError.message);
      return {
        ...res,
        possible_duplicate_id: null,
        possible_duplicate_info: null,
        duplicate_check: 'failed',
        duplicate_check_error: duplicateError.message
      };
    }
    return {
      ...res,
      possible_duplicate_id: duplicate?.id ?? null,
      possible_duplicate_info: duplicate ? `${duplicate.provider_name ?? 'Unknown'} on ${duplicate.start_date ?? 'unknown date'}` : null,
      duplicate_check: 'performed'
    };
  }));
  const responsePayload = {
    reservations_found: aiResult.reservations_found ?? enrichedReservations.length,
    overall_confidence: aiResult.overall_confidence ?? 'LOW',
    extraction_notes: aiResult.extraction_notes ?? '',
    reservations: enrichedReservations,
    duplicate_check_failures: enrichedReservations.filter((r)=>r.duplicate_check === 'failed').length,
    trip_id
  };
  return new Response(JSON.stringify(responsePayload), {
    status: 200,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json'
    }
  });
});

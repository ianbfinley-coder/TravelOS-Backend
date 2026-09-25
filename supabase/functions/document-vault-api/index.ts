import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// CHANGE 2026-09-25 (shared-trip vault access) — `upload_url`, `create_info`,
// `save` and PATCH used to accept a trip_id only when trips.user_id was the
// caller, so members of a shared trip could not keep their own documents or
// notes against it. The rule is now verifyTripAccess(): the caller owns the
// trip OR holds an active ACCOUNT membership in it (trip_members kind
// 'account', removed_at IS NULL, any role: owner/organizer/member/viewer),
// resolved through auth_identities.provider_subject = auth uid. Viewers are
// included on purpose: the rows created are still user_id = caller and stay
// private to the caller — every read (list/get/search), analyze, replace,
// update and delete is still filtered/checked on user_id = caller exactly as
// before, so nothing here lets one member see another member's documents.
// Non-members get the same 404 "Trip not found" as before. Storage paths are
// unchanged (`<caller uid>/<doc id>/document.<ext>`), matching the
// travel-documents bucket policies (foldername[1] = auth.uid()).
// Import moved from jsr: to esm.sh (house convention for edge deploys).
//
// CHANGE 2026-09-25 (b) — PATCH info_id passed the whole request body into the
// update, so a caller could rewrite user_id/id/created_at on their own row or
// move it under ANY trip_id with no check. It now applies only the fields in
// INFO_PATCH_FIELDS, and a non-null trip_id must pass verifyTripAccess like
// every other write. Also: a trip_id that is not a UUID now returns 400
// "Invalid trip_id" in list/upload_url/save/create_info/PATCH instead of
// reaching Postgres and coming back as a 500 (22P02).
// PATCH document_id had the same whole-body update, which was worse: setting
// storage_path to another user's object and then calling `get` would have
// returned a service-role signed URL for THEIR file (and DELETE would have
// removed it); user_id/replaced_by_id/source/file_* were also writable. It now
// applies only DOC_PATCH_FIELDS; status stays computed server-side. (Checked
// 2026-09-25: secure_documents had 0 rows, so nothing was ever exposed.)
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY");
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
  };
}
function jsonRes(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders()
    }
  });
}
// DEFECT 2026-09-19 (42703-class: broken query indistinguishable from empty)
// — almost every query in this file discarded its error object. Reads used
// `res.data ?? []`, so a failed query rendered the traveller's document vault
// as EMPTY — no passport, no visa, no insurance, summary counts all zero —
// with nothing logged and a 200 returned. Writes ignored the error entirely and
// returned `{ success: true }`, so a failed save, a failed replace and a failed
// delete all told the user the operation had worked. For a vault holding
// passport scans and boarding passes, both directions of that are serious: a
// document shown as gone that is still stored, and a document shown as stored
// that was never written. Every query below now captures its error, logs it,
// and reports a failure as a failure.
function dbFailure(context, error) {
  console.error(`[document-vault-api] ${context} failed:`, error.code, error.message);
  return jsonRes({
    error: `Failed to ${context}`,
    detail: error.message
  }, 500);
}
// DEFECT 2026-09-19 — the search action interpolated the raw user query into a
// PostgREST `.or()` filter:
//   .or(`document_name.ilike.%${query}%,document_type.ilike.%${query}%,...`)
// PostgREST parses that string as a comma-separated grammar, so a query
// containing a comma, parenthesis or period broke the filter and the request
// came back 400 — which, with the error discarded, was rendered as "no results".
// Searching the vault for `Smith, John` or `Booking.com` silently reported that
// the user owned no such document. Values are now double-quoted, which is
// PostgREST's own escaping for filter values.
function quoteFilterValue(value) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
// DEFECT 2026-09-19 — the analyze action built its base64 payload with
//   btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)))
// The spread passes one argument per byte, so any document beyond roughly a
// hundred kilobytes exceeded the JavaScript argument limit and threw
// RangeError: Maximum call stack size exceeded. That throw was OUTSIDE the
// try/catch around the AI call, so it escaped the handler entirely and the
// caller got a bare 500 with no explanation. Since a phone photo of a passport
// is several megabytes, document analysis failed for essentially every real
// upload while appearing to work for tiny test files. Converted in chunks now.
function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = "";
  for(let i = 0; i < bytes.length; i += CHUNK){
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
function calcDocumentStatus(expiration_date, extraction_confidence) {
  if (!expiration_date) {
    if (extraction_confidence === 'LOW' || extraction_confidence === 'UNKNOWN') return 'NEEDS_REVIEW';
    return 'CURRENT';
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const exp = new Date(expiration_date);
  exp.setHours(0, 0, 0, 0);
  if (exp < today) return 'EXPIRED';
  const ninetyDays = new Date(today);
  ninetyDays.setDate(ninetyDays.getDate() + 90);
  if (exp <= ninetyDays) return 'EXPIRING_SOON';
  return 'CURRENT';
}
// SECURITY 2026-09-17 — every read/write keyed off document_id or info_id
// already checked `.user_id !== userId` before touching the row, which is
// the right shape for a document vault holding passport scans and boarding
// passes. The gap was narrower but still real: `upload_url` and
// `create_info` accept an optional `trip_id` straight from the request body
// and store it with no check that the trip belongs to the caller. Since the
// document/info row is still owned by the caller (user_id: userId), this was
// not a read leak, but it let a caller plant a document or an
// "important_information" contact record under a trip_id it does not own —
// data other trip-scoped functions (offline pack, itinerary assembly) read
// by trip_id and could surface as if it belonged there. Fix: verify trip_id
// resolves to a trip owned by the caller before it is attached to any new
// row. Also fixed: the `replace` action verified the OLD document belonged
// to the caller but never checked the NEW (replacement) document, so a
// caller could point their own old document's `replaced_by_id` at a
// document they do not own.
//
// DEFECT 2026-09-19 — this helper discarded its error and returned false, so a
// failed lookup was reported to the user as "Trip not found": their own trip
// appeared to vanish whenever the query failed. It now distinguishes the two.
async function verifyTripOwnership(supabase, tripId, userId) {
  const { data, error } = await supabase.from("trips").select("id").eq("id", tripId).eq("user_id", userId).maybeSingle();
  if (error) return {
    owns: false,
    error
  };
  return {
    owns: !!data,
    error: null
  };
}
// 2026-09-25 — owner OR active account member (any role). Result keeps the
// { owns, error } shape so call sites only swap the function name.
async function verifyTripAccess(supabase, tripId, userId) {
  const owner = await verifyTripOwnership(supabase, tripId, userId);
  if (owner.error || owner.owns) return owner;
  // One auth user can hold several auth_identities rows (one per sign-in
  // method), so read them all rather than .maybeSingle().
  const { data: idents, error: identErr } = await supabase.from("auth_identities").select("user_id").eq("provider_subject", userId);
  if (identErr) return {
    owns: false,
    error: identErr
  };
  const platformIds = [
    ...new Set((idents ?? []).map((r)=>r.user_id).filter(Boolean))
  ];
  if (platformIds.length === 0) return {
    owns: false,
    error: null
  };
  const { data: members, error: memErr } = await supabase.from("trip_members").select("id").eq("trip_id", tripId).in("user_id", platformIds).eq("kind", "account").is("removed_at", null).limit(1);
  if (memErr) return {
    owns: false,
    error: memErr
  };
  return {
    owns: (members ?? []).length > 0,
    error: null
  };
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 400 response when a supplied (non-null) trip_id is not a UUID, else null. */ function invalidTripId(tripId) {
  if (tripId === undefined || tripId === null) return null;
  if (typeof tripId === "string" && UUID_RE.test(tripId)) return null;
  return jsonRes({
    error: "Invalid trip_id"
  }, 400);
}
// Columns a caller may change on their own important_information row.
// id, user_id, created_at (and updated_at) are never taken from the request.
const INFO_PATCH_FIELDS = [
  "trip_id",
  "reservation_id",
  "information_type",
  "title",
  "contact_name",
  "organization",
  "phone",
  "email",
  "address",
  "website",
  "information_text",
  "notes"
];
// Columns a caller may change on their own secure_documents row. storage_path,
// user_id, id, file_type, file_size_bytes, source, replaced_by_id (see the
// `replace` action), status (computed below), created_at and updated_at are
// never taken from the request.
const DOC_PATCH_FIELDS = [
  "trip_id",
  "reservation_id",
  "document_type",
  "document_name",
  "issuer",
  "issue_date",
  "expiration_date",
  "reference_number",
  "extraction_confidence",
  "scope",
  "is_active",
  "notes"
];
/**
 * Loads a row the caller must own, keeping three outcomes apart that the old
 * code collapsed into one 403: the query failed (500), the row does not exist
 * (404/403 as before), and the row belongs to someone else (403).
 */ async function loadOwned(supabase, table, id, userId, columns, notFoundBody, notFoundStatus) {
  const { data, error } = await supabase.from(table).select(columns).eq("id", id).maybeSingle();
  if (error) {
    return {
      response: dbFailure(`load ${table}`, error)
    };
  }
  if (!data) {
    return {
      response: jsonRes(notFoundBody, notFoundStatus)
    };
  }
  if (data.user_id !== userId) {
    return {
      response: jsonRes(notFoundBody, notFoundStatus === 404 ? 403 : notFoundStatus)
    };
  }
  return {
    row: data
  };
}
Deno.serve(async (req)=>{
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders()
    });
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) {
    return jsonRes({
      error: "Missing authorization"
    }, 401);
  }
  const { data: { user }, error: authError } = await supabase.auth.getUser(jwt);
  if (authError || !user) {
    return jsonRes({
      error: "Unauthorized"
    }, 401);
  }
  const userId = user.id;
  const url = new URL(req.url);
  if (req.method === "GET") {
    const action = url.searchParams.get("action");
    if (action === "list") {
      const trip_id = url.searchParams.get("trip_id");
      if (!trip_id) {
        return jsonRes({
          error: "trip_id is required"
        }, 400);
      }
      const badListTrip = invalidTripId(trip_id);
      if (badListTrip) return badListTrip;
      const [docsRes, travelerDocsRes, infoRes] = await Promise.all([
        supabase.from("secure_documents").select("*").eq("trip_id", trip_id).eq("user_id", userId).eq("is_active", true).order("created_at", {
          ascending: false
        }),
        supabase.from("secure_documents").select("*").eq("user_id", userId).eq("scope", "TRAVELER").eq("is_active", true).order("created_at", {
          ascending: false
        }),
        supabase.from("important_information").select("*").eq("trip_id", trip_id).eq("user_id", userId).order("information_type").order("title")
      ]);
      // An empty vault and a vault we could not read are different answers.
      if (docsRes.error) return dbFailure("list trip documents", docsRes.error);
      if (travelerDocsRes.error) return dbFailure("list traveler documents", travelerDocsRes.error);
      if (infoRes.error) return dbFailure("list important information", infoRes.error);
      const documents = (docsRes.data ?? []).map((doc)=>({
          ...doc,
          status: calcDocumentStatus(doc.expiration_date, doc.extraction_confidence)
        }));
      const travelerDocuments = (travelerDocsRes.data ?? []).map((doc)=>({
          ...doc,
          status: calcDocumentStatus(doc.expiration_date, doc.extraction_confidence)
        }));
      const importantInformation = infoRes.data ?? [];
      const allDocs = [
        ...documents,
        ...travelerDocuments
      ];
      const summary = {
        document_count: allDocs.length,
        needs_review_count: allDocs.filter((d)=>d.status === 'NEEDS_REVIEW').length,
        expiring_soon_count: allDocs.filter((d)=>d.status === 'EXPIRING_SOON').length,
        expired_count: allDocs.filter((d)=>d.status === 'EXPIRED').length,
        info_count: importantInformation.length
      };
      return jsonRes({
        documents,
        traveler_documents: travelerDocuments,
        important_information: importantInformation,
        summary
      }, 200);
    }
    if (action === "get") {
      const document_id = url.searchParams.get("document_id");
      if (!document_id) {
        return jsonRes({
          error: "document_id is required"
        }, 400);
      }
      const { data: doc, error: docError } = await supabase.from("secure_documents").select("*").eq("id", document_id).maybeSingle();
      if (docError) return dbFailure("load document", docError);
      if (!doc) return jsonRes({
        error: "Document not found"
      }, 404);
      if (doc.user_id !== userId) return jsonRes({
        error: "Forbidden"
      }, 403);
      let download_url = null;
      let download_url_error = null;
      if (doc.storage_path) {
        const { data: signedData, error: signError } = await supabase.storage.from("travel-documents").createSignedUrl(doc.storage_path, 3600);
        if (signError) {
          // Previously discarded: the document came back with download_url null,
          // which the app reads as "no file attached" rather than "we could not
          // produce a link for the file that is there".
          console.error("[document-vault-api] signed URL failed:", signError.message);
          download_url_error = signError.message;
        }
        download_url = signedData?.signedUrl ?? null;
      }
      const document = {
        ...doc,
        status: calcDocumentStatus(doc.expiration_date, doc.extraction_confidence)
      };
      return jsonRes({
        document,
        download_url,
        download_url_error
      }, 200);
    }
    if (action === "search") {
      const query = url.searchParams.get("query") ?? "";
      if (!query.trim()) {
        return jsonRes({
          documents: [],
          information: []
        }, 200);
      }
      const pattern = quoteFilterValue(`%${query.trim()}%`);
      const [docsRes, infoRes] = await Promise.all([
        supabase.from("secure_documents").select("*").eq("user_id", userId).eq("is_active", true).or(`document_name.ilike.${pattern},document_type.ilike.${pattern},` + `issuer.ilike.${pattern},reference_number.ilike.${pattern}`),
        supabase.from("important_information").select("*").eq("user_id", userId).or(`title.ilike.${pattern},organization.ilike.${pattern},` + `information_type.ilike.${pattern}`)
      ]);
      // "Nothing matched" and "the search did not run" must not look alike.
      if (docsRes.error) return dbFailure("search documents", docsRes.error);
      if (infoRes.error) return dbFailure("search important information", infoRes.error);
      const documents = (docsRes.data ?? []).map((doc)=>({
          ...doc,
          status: calcDocumentStatus(doc.expiration_date, doc.extraction_confidence)
        }));
      return jsonRes({
        documents,
        information: infoRes.data ?? []
      }, 200);
    }
    return jsonRes({
      error: "Unknown action"
    }, 400);
  }
  if (req.method === "POST") {
    let body;
    try {
      body = await req.json();
    } catch  {
      return jsonRes({
        error: "Invalid JSON"
      }, 400);
    }
    const action = body.action;
    if (action === "upload_url") {
      const { trip_id, document_type, document_name, file_type, file_size_bytes, scope } = body;
      if (!document_type || !document_name || !file_type || !file_size_bytes) {
        return jsonRes({
          error: "document_type, document_name, file_type, file_size_bytes are required"
        }, 400);
      }
      const badUploadTrip = invalidTripId(trip_id);
      if (badUploadTrip) return badUploadTrip;
      if (trip_id) {
        const { owns, error } = await verifyTripAccess(supabase, trip_id, userId);
        if (error) return dbFailure("verify trip access", error);
        if (!owns) return jsonRes({
          error: "Trip not found"
        }, 404);
      }
      const MAX_SIZE = 20 * 1024 * 1024;
      if (file_size_bytes > MAX_SIZE) {
        return jsonRes({
          error: "File size exceeds 20MB limit"
        }, 400);
      }
      const { data: doc, error: insertError } = await supabase.from("secure_documents").insert({
        user_id: userId,
        trip_id: trip_id ?? null,
        document_type: document_type ?? "OTHER",
        document_name,
        file_type,
        file_size_bytes,
        scope: scope ?? "TRIP",
        source: "UPLOAD",
        status: "NEEDS_REVIEW",
        extraction_confidence: "UNKNOWN"
      }).select().single();
      if (insertError || !doc) {
        return jsonRes({
          error: "Failed to create document record",
          details: insertError?.message
        }, 500);
      }
      const ext = file_type === "application/pdf" ? "pdf" : file_type === "image/png" ? "png" : file_type === "image/webp" ? "webp" : file_type === "image/heic" ? "heic" : file_type === "image/heif" ? "heif" : "jpg";
      const storage_path = `${userId}/${doc.id}/document.${ext}`;
      // DEFECT 2026-09-19 — this update's error was discarded. If it failed the
      // function still handed back a signed upload URL, the client uploaded the
      // file, and the row kept storage_path NULL forever: the document was
      // stored but permanently unreachable, and both `get` and `analyze`
      // reported it as having no file uploaded. Fail before issuing the URL.
      const { error: pathError } = await supabase.from("secure_documents").update({
        storage_path
      }).eq("id", doc.id);
      if (pathError) {
        return dbFailure("record document storage path", pathError);
      }
      const { data: uploadData, error: uploadError } = await supabase.storage.from("travel-documents").createSignedUploadUrl(storage_path);
      if (uploadError || !uploadData) {
        return jsonRes({
          error: "Failed to create upload URL",
          details: uploadError?.message
        }, 500);
      }
      return jsonRes({
        document_id: doc.id,
        upload_url: uploadData.signedUrl,
        storage_path
      }, 200);
    }
    if (action === "analyze") {
      const { document_id } = body;
      if (!document_id) {
        return jsonRes({
          error: "document_id is required"
        }, 400);
      }
      const { data: doc, error: docError } = await supabase.from("secure_documents").select("*").eq("id", document_id).maybeSingle();
      if (docError) return dbFailure("load document", docError);
      if (!doc) return jsonRes({
        error: "Document not found"
      }, 404);
      if (doc.user_id !== userId) return jsonRes({
        error: "Forbidden"
      }, 403);
      if (!doc.storage_path) {
        return jsonRes({
          error: "Document has no file uploaded"
        }, 400);
      }
      const { data: fileData, error: downloadError } = await supabase.storage.from("travel-documents").download(doc.storage_path);
      if (downloadError || !fileData) {
        return jsonRes({
          error: "Failed to download document for analysis",
          detail: downloadError?.message
        }, 500);
      }
      let base64;
      try {
        base64 = toBase64(await fileData.arrayBuffer());
      } catch (e) {
        console.error("[document-vault-api] base64 encode failed:", e);
        return jsonRes({
          error: "Failed to read document for analysis"
        }, 500);
      }
      const mimeType = doc.file_type ?? "image/jpeg";
      const systemPrompt = `You are a travel document metadata extraction assistant. Extract metadata from the provided travel document image or PDF.

CRITICAL RULES:
1. NEVER invent or fabricate any information
2. Only extract information clearly visible in the document
3. Do not make legal determinations about document validity
4. If information is unclear, mark confidence as LOW or UNKNOWN
5. Redact payment card numbers
6. Respond with ONLY valid JSON`;
      const userPrompt = `Extract metadata from this travel document. Return JSON:\n{\n  "document_type": "PASSPORT" | "GOVERNMENT_ID" | "DRIVER_LICENSE" | "VISA_ENTRY_DOCUMENT" | "TRAVEL_INSURANCE" | "FLIGHT_DOCUMENT" | "BOARDING_PASS" | "HOTEL_DOCUMENT" | "RENTAL_CAR_DOCUMENT" | "TRAIN_DOCUMENT" | "BUS_DOCUMENT" | "TOUR_ACTIVITY_DOCUMENT" | "CRUISE_DOCUMENT" | "TRAVEL_AUTHORIZATION" | "OTHER",\n  "document_name": "suggested name for this document",\n  "issuer": "string or null",\n  "issue_date": "YYYY-MM-DD or null",\n  "expiration_date": "YYYY-MM-DD or null",\n  "reference_number": "string or null",\n  "extraction_confidence": "HIGH" | "MEDIUM" | "LOW",\n  "field_confidence": {\n    "document_type": "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN",\n    "expiration_date": "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN",\n    "reference_number": "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN"\n  },\n  "notes": "any important observations about this document"\n}`;
      let aiResult = null;
      let analysisError = null;
      try {
        const aiResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${OPENROUTER_API_KEY}`,
            "HTTP-Referer": "https://travelos.app",
            "X-Title": "TravelOS"
          },
          body: JSON.stringify({
            model: "google/gemini-3.5-flash",
            messages: [
              {
                role: "system",
                content: systemPrompt
              },
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: userPrompt
                  },
                  {
                    type: "image_url",
                    image_url: {
                      url: `data:${mimeType};base64,${base64}`
                    }
                  }
                ]
              }
            ],
            max_tokens: 1000,
            temperature: 0.1,
            response_format: {
              type: "json_object"
            }
          })
        });
        if (aiResponse.ok) {
          const aiData = await aiResponse.json();
          const content = aiData?.choices?.[0]?.message?.content ?? "{}";
          const parsed = JSON.parse(typeof content === "string" ? content : JSON.stringify(content));
          if (parsed && typeof parsed === "object") aiResult = parsed;
        } else {
          // Previously this branch did nothing at all — not even a log line.
          const errText = await aiResponse.text().catch(()=>"<unreadable>");
          analysisError = `extraction service returned ${aiResponse.status}`;
          console.error("[document-vault-api] analyze upstream failed:", aiResponse.status, errText.slice(0, 300));
        }
      } catch (e) {
        analysisError = "extraction service call failed";
        console.error("[document-vault-api] analyze threw:", e instanceof Error ? e.message : String(e));
      }
      const updatePayload = {
        extraction_confidence: aiResult?.extraction_confidence ?? "UNKNOWN",
        updated_at: new Date().toISOString()
      };
      if (aiResult) {
        if (aiResult.document_type) updatePayload.document_type = aiResult.document_type;
        if (aiResult.document_name) updatePayload.document_name = aiResult.document_name;
        if (aiResult.issuer !== undefined) updatePayload.issuer = aiResult.issuer;
        if (aiResult.issue_date !== undefined) updatePayload.issue_date = aiResult.issue_date;
        if (aiResult.expiration_date !== undefined) updatePayload.expiration_date = aiResult.expiration_date;
        if (aiResult.reference_number !== undefined) updatePayload.reference_number = aiResult.reference_number;
        if (aiResult.notes) updatePayload.notes = aiResult.notes;
      }
      const newStatus = calcDocumentStatus(updatePayload.expiration_date ?? doc.expiration_date, updatePayload.extraction_confidence);
      updatePayload.status = newStatus;
      // DEFECT 2026-09-19 (failure presented as success) — the error was
      // discarded and the fallback returned `{ ...doc, ...updatePayload }`,
      // i.e. the document as it WOULD have looked had the write succeeded. The
      // app then displayed extracted passport details — expiry date, reference
      // number — that were never stored, and they silently reverted on reload.
      const { data: updatedDoc, error: updateError } = await supabase.from("secure_documents").update(updatePayload).eq("id", document_id).select().single();
      if (updateError || !updatedDoc) {
        return dbFailure("save document analysis", updateError ?? {
          message: "no row returned"
        });
      }
      return jsonRes({
        document: updatedDoc,
        analysis_error: analysisError
      }, 200);
    }
    if (action === "save") {
      const { document_id, document_type, document_name, issuer, issue_date, expiration_date, reference_number, notes, trip_id, reservation_id, scope } = body;
      if (!document_id) {
        return jsonRes({
          error: "document_id is required"
        }, 400);
      }
      const owned = await loadOwned(supabase, "secure_documents", document_id, userId, "user_id, expiration_date, extraction_confidence", {
        error: "Document not found or forbidden"
      }, 403);
      if ("response" in owned) return owned.response;
      const existing = owned.row;
      const badSaveTrip = invalidTripId(trip_id);
      if (badSaveTrip) return badSaveTrip;
      if (trip_id !== undefined && trip_id !== null) {
        const { owns, error } = await verifyTripAccess(supabase, trip_id, userId);
        if (error) return dbFailure("verify trip access", error);
        if (!owns) return jsonRes({
          error: "Trip not found"
        }, 404);
      }
      const updateFields = {};
      if (document_type !== undefined) updateFields.document_type = document_type;
      if (document_name !== undefined) updateFields.document_name = document_name;
      if (issuer !== undefined) updateFields.issuer = issuer;
      if (issue_date !== undefined) updateFields.issue_date = issue_date;
      if (expiration_date !== undefined) updateFields.expiration_date = expiration_date;
      if (reference_number !== undefined) updateFields.reference_number = reference_number;
      if (notes !== undefined) updateFields.notes = notes;
      if (trip_id !== undefined) updateFields.trip_id = trip_id;
      if (reservation_id !== undefined) updateFields.reservation_id = reservation_id;
      if (scope !== undefined) updateFields.scope = scope;
      const finalExpiry = expiration_date ?? existing.expiration_date;
      updateFields.status = calcDocumentStatus(finalExpiry, existing.extraction_confidence);
      // Previously `const { data: updatedDoc }` — a failed save returned HTTP
      // 200 with `{ "document": undefined }`.
      const { data: updatedDoc, error: updateError } = await supabase.from("secure_documents").update(updateFields).eq("id", document_id).select().single();
      if (updateError || !updatedDoc) {
        return dbFailure("save document", updateError ?? {
          message: "no row returned"
        });
      }
      return jsonRes({
        document: updatedDoc
      }, 200);
    }
    if (action === "replace") {
      const { old_document_id, new_document_id } = body;
      if (!old_document_id || !new_document_id) {
        return jsonRes({
          error: "old_document_id and new_document_id are required"
        }, 400);
      }
      const oldOwned = await loadOwned(supabase, "secure_documents", old_document_id, userId, "user_id", {
        error: "Document not found or forbidden"
      }, 403);
      if ("response" in oldOwned) return oldOwned.response;
      const newOwned = await loadOwned(supabase, "secure_documents", new_document_id, userId, "user_id", {
        error: "Replacement document not found or forbidden"
      }, 403);
      if ("response" in newOwned) return newOwned.response;
      // Previously the error here was discarded and `{ success: true }` was
      // returned regardless — the user was told the old passport had been
      // superseded when nothing had changed, leaving both marked active.
      const { error: replaceError } = await supabase.from("secure_documents").update({
        is_active: false,
        replaced_by_id: new_document_id
      }).eq("id", old_document_id);
      if (replaceError) return dbFailure("replace document", replaceError);
      return jsonRes({
        success: true
      }, 200);
    }
    if (action === "create_info") {
      const { trip_id, information_type, title, contact_name, organization, phone, email, address, website, information_text, notes, reservation_id } = body;
      if (!information_type || !title) {
        return jsonRes({
          error: "information_type and title are required"
        }, 400);
      }
      const badInfoTrip = invalidTripId(trip_id);
      if (badInfoTrip) return badInfoTrip;
      if (trip_id) {
        const { owns, error } = await verifyTripAccess(supabase, trip_id, userId);
        if (error) return dbFailure("verify trip access", error);
        if (!owns) return jsonRes({
          error: "Trip not found"
        }, 404);
      }
      const { data: info, error: insertError } = await supabase.from("important_information").insert({
        user_id: userId,
        trip_id: trip_id ?? null,
        reservation_id: reservation_id ?? null,
        information_type,
        title,
        contact_name: contact_name ?? null,
        organization: organization ?? null,
        phone: phone ?? null,
        email: email ?? null,
        address: address ?? null,
        website: website ?? null,
        information_text: information_text ?? null,
        notes: notes ?? null
      }).select().single();
      if (insertError || !info) {
        return jsonRes({
          error: "Failed to create info",
          details: insertError?.message
        }, 500);
      }
      return jsonRes({
        info
      }, 201);
    }
    return jsonRes({
      error: "Unknown action"
    }, 400);
  }
  if (req.method === "PATCH") {
    let body;
    try {
      body = await req.json();
    } catch  {
      return jsonRes({
        error: "Invalid JSON"
      }, 400);
    }
    if (body.document_id) {
      const { document_id } = body;
      const owned = await loadOwned(supabase, "secure_documents", document_id, userId, "user_id, expiration_date, extraction_confidence", {
        error: "Document not found or forbidden"
      }, 403);
      if ("response" in owned) return owned.response;
      const existing = owned.row;
      const fields = {};
      for (const key of DOC_PATCH_FIELDS){
        if (body[key] !== undefined) fields[key] = body[key];
      }
      if (Object.keys(fields).length === 0) {
        return jsonRes({
          error: "No updatable fields supplied"
        }, 400);
      }
      const badPatchTrip = invalidTripId(fields.trip_id);
      if (badPatchTrip) return badPatchTrip;
      if (fields.trip_id) {
        const { owns, error } = await verifyTripAccess(supabase, fields.trip_id, userId);
        if (error) return dbFailure("verify trip access", error);
        if (!owns) return jsonRes({
          error: "Trip not found"
        }, 404);
      }
      const finalExpiry = fields.expiration_date ?? existing.expiration_date;
      const finalConfidence = fields.extraction_confidence ?? existing.extraction_confidence;
      fields.status = calcDocumentStatus(finalExpiry, finalConfidence);
      const { data: updatedDoc, error: updateError } = await supabase.from("secure_documents").update(fields).eq("id", document_id).select().single();
      if (updateError || !updatedDoc) {
        return dbFailure("update document", updateError ?? {
          message: "no row returned"
        });
      }
      return jsonRes({
        document: updatedDoc
      }, 200);
    }
    if (body.info_id) {
      const { info_id } = body;
      const owned = await loadOwned(supabase, "important_information", info_id, userId, "user_id", {
        error: "Info not found or forbidden"
      }, 403);
      if ("response" in owned) return owned.response;
      const fields = {};
      for (const key of INFO_PATCH_FIELDS){
        if (body[key] !== undefined) fields[key] = body[key];
      }
      if (Object.keys(fields).length === 0) {
        return jsonRes({
          error: "No updatable fields supplied"
        }, 400);
      }
      const badInfoPatchTrip = invalidTripId(fields.trip_id);
      if (badInfoPatchTrip) return badInfoPatchTrip;
      if (fields.trip_id !== undefined && fields.trip_id !== null) {
        const { owns, error } = await verifyTripAccess(supabase, fields.trip_id, userId);
        if (error) return dbFailure("verify trip access", error);
        if (!owns) return jsonRes({
          error: "Trip not found"
        }, 404);
      }
      const { data: updatedInfo, error: updateError } = await supabase.from("important_information").update(fields).eq("id", info_id).select().single();
      if (updateError || !updatedInfo) {
        return dbFailure("update important information", updateError ?? {
          message: "no row returned"
        });
      }
      return jsonRes({
        info: updatedInfo
      }, 200);
    }
    return jsonRes({
      error: "document_id or info_id is required"
    }, 400);
  }
  if (req.method === "DELETE") {
    let body;
    try {
      body = await req.json();
    } catch  {
      return jsonRes({
        error: "Invalid JSON"
      }, 400);
    }
    if (body.document_id) {
      const { document_id } = body;
      const owned = await loadOwned(supabase, "secure_documents", document_id, userId, "user_id, storage_path", {
        error: "Document not found or forbidden"
      }, 403);
      if ("response" in owned) return owned.response;
      const doc = owned.row;
      // DEFECT 2026-09-19 — both of these errors were discarded and
      // `{ success: true }` was returned unconditionally. A traveller deleting a
      // passport scan was told it was gone while the row and the stored file
      // both remained — the worst possible direction for a delete on sensitive
      // documents to fail in.
      if (doc.storage_path) {
        const { error: removeError } = await supabase.storage.from("travel-documents").remove([
          doc.storage_path
        ]);
        if (removeError) {
          console.error("[document-vault-api] storage remove failed:", removeError.message);
          return jsonRes({
            error: "Failed to delete the stored file",
            detail: removeError.message
          }, 500);
        }
      }
      const { error: deleteError } = await supabase.from("secure_documents").delete().eq("id", document_id);
      if (deleteError) return dbFailure("delete document", deleteError);
      return jsonRes({
        success: true
      }, 200);
    }
    if (body.info_id) {
      const { info_id } = body;
      const owned = await loadOwned(supabase, "important_information", info_id, userId, "user_id", {
        error: "Info not found or forbidden"
      }, 403);
      if ("response" in owned) return owned.response;
      const { error: deleteError } = await supabase.from("important_information").delete().eq("id", info_id);
      if (deleteError) return dbFailure("delete important information", deleteError);
      return jsonRes({
        success: true
      }, 200);
    }
    return jsonRes({
      error: "document_id or info_id is required"
    }, 400);
  }
  return jsonRes({
    error: "Method not allowed"
  }, 405);
});

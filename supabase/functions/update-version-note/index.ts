import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};
serve(async (req)=>{
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: CORS_HEADERS
    });
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  try {
    // Auth check
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({
        error: "Missing authorization header"
      }), {
        status: 401,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/json"
        }
      });
    }
    const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY") || SUPABASE_SERVICE_ROLE_KEY, {
      global: {
        headers: {
          Authorization: authHeader
        }
      }
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({
        error: "Unauthorized"
      }), {
        status: 401,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/json"
        }
      });
    }
    let body;
    try {
      body = await req.json();
    } catch  {
      return new Response(JSON.stringify({
        error: "invalid_json"
      }), {
        status: 400,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/json"
        }
      });
    }
    const { version_id, note } = body;
    if (!version_id) {
      return new Response(JSON.stringify({
        error: "version_id is required"
      }), {
        status: 400,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/json"
        }
      });
    }
    // Update user_note, scoped to this caller's own versions.
    //
    // DEFECT 2026-09-19 (failure-looks-like-success) — this update ran without
    // `.select()`, so the only thing checked was `updateError`. A PostgREST
    // UPDATE that matches ZERO rows is not an error: it succeeds and affects
    // nothing. So when version_id did not exist, or belonged to a different
    // user, or had been deleted, this function wrote nothing at all and still
    // returned `{ success: true }` — the app showed the traveller's note as
    // saved, and it was silently gone the next time they opened the version.
    // The update now returns the rows it touched and an empty result is a 404.
    // (The comment here used to claim "RLS ensures user can only update their
    // own versions"; it does not — this is a service-role client, which
    // bypasses RLS entirely. The `.eq("user_id", user.id)` filter below is the
    // only thing enforcing ownership, so it must stay.)
    const { data: updated, error: updateError } = await supabase.from("itinerary_versions").update({
      user_note: note ?? null
    }).eq("id", version_id).eq("user_id", user.id).select("id");
    if (updateError) {
      throw new Error(`Failed to update note: ${updateError.message}`);
    }
    if (!updated || updated.length === 0) {
      return new Response(JSON.stringify({
        error: "Itinerary version not found"
      }), {
        status: 404,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/json"
        }
      });
    }
    return new Response(JSON.stringify({
      success: true,
      version_id: updated[0].id
    }), {
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/json"
      }
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[update-version-note] Error:", message);
    return new Response(JSON.stringify({
      error: "Internal server error"
    }), {
      status: 500,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/json"
      }
    });
  }
});

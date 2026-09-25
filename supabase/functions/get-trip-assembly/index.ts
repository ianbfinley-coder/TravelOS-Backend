import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
  };
}
Deno.serve(async (req)=>{
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders()
    });
  }
  if (req.method !== "GET") {
    return new Response(JSON.stringify({
      error: "Method not allowed"
    }), {
      status: 405,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders()
      }
    });
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  // Auth
  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) {
    return new Response(JSON.stringify({
      error: "Missing authorization"
    }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders()
      }
    });
  }
  const { data: { user }, error: authError } = await supabase.auth.getUser(jwt);
  if (authError || !user) {
    return new Response(JSON.stringify({
      error: "Unauthorized"
    }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders()
      }
    });
  }
  const url = new URL(req.url);
  const trip_id = url.searchParams.get("trip_id");
  if (!trip_id) {
    return new Response(JSON.stringify({
      error: "trip_id is required"
    }), {
      status: 400,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders()
      }
    });
  }
  // Verify trip ownership
  const { data: trip } = await supabase.from("trips").select("id, user_id").eq("id", trip_id).single();
  if (!trip || trip.user_id !== user.id) {
    return new Response(JSON.stringify({
      error: "Trip not found"
    }), {
      status: 404,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders()
      }
    });
  }
  // Try to fetch existing assembly
  const { data: assembly } = await supabase.from("trip_assemblies").select("*").eq("trip_id", trip_id).maybeSingle();
  if (assembly) {
    return new Response(JSON.stringify({
      assembly
    }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders()
      }
    });
  }
  // No assembly exists — trigger calculation via assemble-trip
  try {
    const assembleRes = await fetch(`${SUPABASE_URL}/functions/v1/assemble-trip`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
      },
      body: JSON.stringify({
        trip_id
      })
    });
    if (assembleRes.ok) {
      const result = await assembleRes.json();
      return new Response(JSON.stringify({
        assembly: result.assembly ?? null
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders()
        }
      });
    }
  } catch  {
  // fall through
  }
  return new Response(JSON.stringify({
    assembly: null
  }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders()
    }
  });
});

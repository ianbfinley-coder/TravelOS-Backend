import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
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
  if (req.method === "GET") {
    const url = new URL(req.url);
    const trip_id = url.searchParams.get("trip_id");
    const type = url.searchParams.get("type") ?? "all";
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
    const result = {};
    if (type === "items" || type === "all") {
      const { data, error } = await supabase.from("readiness_items").select("*").eq("trip_id", trip_id).eq("user_id", user.id).order("priority", {
        ascending: true
      }).order("created_at", {
        ascending: false
      });
      if (error) return new Response(JSON.stringify({
        error: error.message
      }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders()
        }
      });
      result.items = data ?? [];
    }
    if (type === "tasks" || type === "all") {
      const { data, error } = await supabase.from("pre_trip_tasks").select("*").eq("trip_id", trip_id).eq("user_id", user.id).order("created_at", {
        ascending: false
      });
      if (error) return new Response(JSON.stringify({
        error: error.message
      }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders()
        }
      });
      result.tasks = data ?? [];
    }
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders()
      }
    });
  }
  if (req.method === "POST") {
    let body;
    try {
      body = await req.json();
    } catch  {
      return new Response(JSON.stringify({
        error: "Invalid JSON"
      }), {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders()
        }
      });
    }
    const { action } = body;
    if (action === "update_item_status") {
      const { item_id, status, user_explanation } = body;
      if (!item_id || !status) {
        return new Response(JSON.stringify({
          error: "item_id and status are required"
        }), {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders()
          }
        });
      }
      const { data: existing, error: fetchErr } = await supabase.from("readiness_items").select("id, user_id").eq("id", item_id).single();
      if (fetchErr || !existing || existing.user_id !== user.id) {
        return new Response(JSON.stringify({
          error: "Item not found"
        }), {
          status: 404,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders()
          }
        });
      }
      const updatePayload = {
        status
      };
      if (user_explanation) updatePayload.user_explanation = user_explanation;
      if (status === "DISMISSED") updatePayload.dismissed_at = new Date().toISOString();
      if (status === "RESOLVED" || status === "COMPLETED") updatePayload.resolved_at = new Date().toISOString();
      const { data: updated, error: updateErr } = await supabase.from("readiness_items").update(updatePayload).eq("id", item_id).eq("user_id", user.id).select().single();
      if (updateErr) return new Response(JSON.stringify({
        error: updateErr.message
      }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders()
        }
      });
      return new Response(JSON.stringify(updated), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders()
        }
      });
    }
    if (action === "create_task") {
      const { trip_id, title, description, category, due_date, priority } = body;
      if (!trip_id || !title) {
        return new Response(JSON.stringify({
          error: "trip_id and title are required"
        }), {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders()
          }
        });
      }
      // SECURITY 2026-09-17 — create_task inserted a pre_trip_tasks row for
      // whatever trip_id the caller put in the body, with no check that the
      // caller owned that trip. Because this function uses the service-role
      // client, any signed-in user could attach a task (and, indirectly, read
      // its presence back through this same trip_id) to a trip belonging to
      // someone else. Gate is now: trips.user_id must equal the caller's
      // verified auth.uid() before the insert runs. 404, not 403, so a caller
      // cannot use the response to probe which trip ids exist.
      const { data: ownedTrip } = await supabase.from("trips").select("id, user_id").eq("id", trip_id).maybeSingle();
      if (!ownedTrip || ownedTrip.user_id !== user.id) {
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
      const { data: created, error: insertErr } = await supabase.from("pre_trip_tasks").insert({
        user_id: user.id,
        trip_id,
        title,
        description: description ?? null,
        category: category ?? "OTHER",
        source: "USER_CREATED",
        due_date: due_date ?? null,
        priority: priority ?? "MEDIUM",
        status: "OPEN"
      }).select().single();
      if (insertErr) return new Response(JSON.stringify({
        error: insertErr.message
      }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders()
        }
      });
      return new Response(JSON.stringify(created), {
        status: 201,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders()
        }
      });
    }
    if (action === "update_task") {
      const { task_id, status, title, description, due_date, priority } = body;
      if (!task_id) {
        return new Response(JSON.stringify({
          error: "task_id is required"
        }), {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders()
          }
        });
      }
      const { data: existing, error: fetchErr } = await supabase.from("pre_trip_tasks").select("id, user_id").eq("id", task_id).single();
      if (fetchErr || !existing || existing.user_id !== user.id) {
        return new Response(JSON.stringify({
          error: "Task not found"
        }), {
          status: 404,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders()
          }
        });
      }
      const updatePayload = {};
      if (status !== undefined) updatePayload.status = status;
      if (title !== undefined) updatePayload.title = title;
      if (description !== undefined) updatePayload.description = description;
      if (due_date !== undefined) updatePayload.due_date = due_date;
      if (priority !== undefined) updatePayload.priority = priority;
      if (status === "COMPLETED") updatePayload.completed_at = new Date().toISOString();
      const { data: updated, error: updateErr } = await supabase.from("pre_trip_tasks").update(updatePayload).eq("id", task_id).eq("user_id", user.id).select().single();
      if (updateErr) return new Response(JSON.stringify({
        error: updateErr.message
      }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders()
        }
      });
      return new Response(JSON.stringify(updated), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders()
        }
      });
    }
    if (action === "delete_task") {
      const { task_id } = body;
      if (!task_id) {
        return new Response(JSON.stringify({
          error: "task_id is required"
        }), {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders()
          }
        });
      }
      const { data: existing, error: fetchErr } = await supabase.from("pre_trip_tasks").select("id, user_id, source").eq("id", task_id).single();
      if (fetchErr || !existing || existing.user_id !== user.id) {
        return new Response(JSON.stringify({
          error: "Task not found"
        }), {
          status: 404,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders()
          }
        });
      }
      if (existing.source !== "USER_CREATED") {
        return new Response(JSON.stringify({
          error: "Only user-created tasks can be deleted"
        }), {
          status: 403,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders()
          }
        });
      }
      const { error: deleteErr } = await supabase.from("pre_trip_tasks").delete().eq("id", task_id).eq("user_id", user.id);
      if (deleteErr) return new Response(JSON.stringify({
        error: deleteErr.message
      }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders()
        }
      });
      return new Response(JSON.stringify({
        success: true
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders()
        }
      });
    }
    return new Response(JSON.stringify({
      error: "Unknown action"
    }), {
      status: 400,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders()
      }
    });
  }
  return new Response(JSON.stringify({
    error: "Method not allowed"
  }), {
    status: 405,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders()
    }
  });
});

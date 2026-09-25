// SECURITY 2026-09-16 — calendar-share authorization fix
//
// WHAT WAS WRONG: `create_share_link` and `send_invitation` verified only
// that the caller held a valid session (via the local getAuthUser check),
// never that the caller owned the trip named in the request body's
// `trip_id`. Both actions insert a new row (`shareable_calendars` /
// `calendar_invitations`) keyed only by the caller's own id
// (`created_by` / `sent_by`) and a `trip_id` taken verbatim from the
// request body, with no ownership check in between.
//
// WHAT AN ATTACKER COULD DO: any authenticated TravelOS user could pass an
// arbitrary trip_id — someone else's trip — to `create_share_link` and
// receive back a working, unauthenticated `share_token` for that
// stranger's itinerary (redeemable via `verify_token`, which is
// intentionally anonymous), or call `send_invitation` to mint and email an
// `invite_token` for it. Either token hands a stranger's full itinerary to
// anyone holding the link, with no further authentication required.
//
// THE FIX: `create_share_link` and `send_invitation` now call
// `requireUser` to establish the caller's verified auth.uid(), then
// `requireTripOwner` to confirm that uid owns `trip_id` (trips.id /
// trips.user_id, both uuid, compared directly) before any insert.
// Ownership failure returns 404, not 403, so a caller cannot use the
// response to enumerate which trip ids exist.
//
// LEFT ANONYMOUS, DELIBERATELY: `verify_token` and `accept_invitation` are
// the redemption paths — the entire point of a share link or invitation is
// that the person opening the URL has no TravelOS session. Gating either
// one behind requireUser would break sharing itself.
//
// NOTICED BUT NOT CHANGED: `get_share_link`, `get_invitations`, and
// `revoke_share_link` do not call requireTripOwner either, but each scopes
// its query to rows the caller themselves created (`created_by = user.id`
// / `sent_by = user.id`), so none of them can return or delete another
// user's data even without an explicit trip-owner check. Left as-is per
// the surgical scope of this fix; flagged in the report for anyone who
// wants to harden them to the same pattern for consistency.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { requireUser, requireTripOwner } from "./_shared/auth.ts";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json"
    }
  });
}
function generateId() {
  return crypto.randomUUID().replace(/-/g, "");
}
function generateToken() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 20);
}
async function getAuthUser(req, supabase) {
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;
  return user;
}
Deno.serve(async (req)=>{
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: corsHeaders
    });
  }
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  let body;
  try {
    body = await req.json();
  } catch  {
    return json({
      error: "invalid_json"
    }, 400);
  }
  const { action, ...params } = body;
  // ── create_share_link ──────────────────────────────────────────────────────
  if (action === "create_share_link") {
    const caller = await requireUser(req);
    if (caller instanceof Response) return caller;
    const { trip_id, access_level = "view" } = params;
    const gate = await requireTripOwner(supabase, trip_id, caller.userId);
    if (gate instanceof Response) return gate;
    const share_token = generateToken();
    const id = generateId();
    const { data, error } = await supabase.from("shareable_calendars").insert({
      id,
      trip_id,
      share_token,
      access_level,
      created_by: caller.userId
    }).select().single();
    if (error) return json({
      error: error.message
    }, 500);
    return json({
      share_token: data.share_token,
      expires_at: data.expires_at,
      access_level: data.access_level,
      share_url: `https://travelos.app/calendar/shared/${data.share_token}`
    });
  }
  // ── get_share_link ─────────────────────────────────────────────────────────
  if (action === "get_share_link") {
    const user = await getAuthUser(req, supabase);
    if (!user) return json({
      error: "unauthorized"
    }, 401);
    const { trip_id } = params;
    const { data, error } = await supabase.from("shareable_calendars").select().eq("trip_id", trip_id).eq("created_by", user.id).gt("expires_at", new Date().toISOString()).maybeSingle();
    if (error) return json({
      error: error.message
    }, 500);
    if (!data) return json({
      share_link: null
    });
    return json({
      share_token: data.share_token,
      expires_at: data.expires_at,
      access_level: data.access_level,
      share_url: `https://travelos.app/calendar/shared/${data.share_token}`,
      view_count: data.view_count
    });
  }
  // ── verify_token ───────────────────────────────────────────────────────────
  if (action === "verify_token") {
    const { share_token } = params;
    const { data, error } = await supabase.from("shareable_calendars").select().eq("share_token", share_token).gt("expires_at", new Date().toISOString()).maybeSingle();
    if (error) return json({
      error: error.message
    }, 500);
    if (!data) return json({
      error: "invalid_token"
    }, 404);
    // Increment view_count
    await supabase.from("shareable_calendars").update({
      view_count: data.view_count + 1
    }).eq("id", data.id);
    return json({
      ...data,
      view_count: data.view_count + 1
    });
  }
  // ── send_invitation ────────────────────────────────────────────────────────
  if (action === "send_invitation") {
    const caller = await requireUser(req);
    if (caller instanceof Response) return caller;
    const { trip_id, recipient_email, access_level = "view", ics_content } = params;
    const gate = await requireTripOwner(supabase, trip_id, caller.userId);
    if (gate instanceof Response) return gate;
    const invite_token = generateToken();
    const id = generateId();
    const { data, error } = await supabase.from("calendar_invitations").insert({
      id,
      trip_id,
      recipient_email,
      access_level,
      invite_token,
      sent_by: caller.userId
    }).select().single();
    if (error) return json({
      error: error.message
    }, 500);
    const sendgridKey = Deno.env.get("SENDGRID_API_KEY");
    let emailStatus = "queued";
    if (sendgridKey) {
      const acceptUrl = `https://travelos.app/calendar/invite/${invite_token}/accept`;
      const htmlBody = `
        <h2>You're invited to view a TravelOS trip calendar</h2>
        <p>You have been invited to access a trip calendar with <strong>${access_level}</strong> permissions.</p>
        <p><a href="${acceptUrl}" style="background:#4F46E5;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;">Accept Invitation</a></p>
        <p>Or copy this link: ${acceptUrl}</p>
        <p>This invitation expires in 7 days.</p>
      `;
      const attachments = [];
      if (ics_content) {
        attachments.push({
          content: btoa(ics_content),
          filename: "calendar.ics",
          type: "text/calendar",
          disposition: "attachment"
        });
      }
      const sgPayload = {
        personalizations: [
          {
            to: [
              {
                email: recipient_email
              }
            ]
          }
        ],
        from: {
          email: "noreply@travelos.app",
          name: "TravelOS"
        },
        subject: "You're invited to view a TravelOS trip calendar",
        content: [
          {
            type: "text/html",
            value: htmlBody
          }
        ]
      };
      if (attachments.length > 0) sgPayload.attachments = attachments;
      try {
        const sgRes = await fetch("https://api.sendgrid.com/v3/mail/send", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${sendgridKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(sgPayload)
        });
        if (sgRes.ok || sgRes.status === 202) {
          emailStatus = "sent";
        }
      } catch  {
      // SendGrid failed — invitation is still saved, status stays 'queued'
      }
    }
    return json({
      invite_token: data.invite_token,
      status: emailStatus
    });
  }
  // ── accept_invitation ──────────────────────────────────────────────────────
  if (action === "accept_invitation") {
    const { invite_token } = params;
    const { data: existing, error: fetchError } = await supabase.from("calendar_invitations").select().eq("invite_token", invite_token).gt("expires_at", new Date().toISOString()).maybeSingle();
    if (fetchError) return json({
      error: fetchError.message
    }, 500);
    if (!existing) return json({
      error: "invalid_or_expired_token"
    }, 404);
    const { error: updateError } = await supabase.from("calendar_invitations").update({
      status: "accepted",
      accepted_at: new Date().toISOString()
    }).eq("invite_token", invite_token);
    if (updateError) return json({
      error: updateError.message
    }, 500);
    return json({
      success: true
    });
  }
  // ── get_invitations ────────────────────────────────────────────────────────
  if (action === "get_invitations") {
    const user = await getAuthUser(req, supabase);
    if (!user) return json({
      error: "unauthorized"
    }, 401);
    const { trip_id } = params;
    const { data, error } = await supabase.from("calendar_invitations").select().eq("trip_id", trip_id).eq("sent_by", user.id).order("sent_at", {
      ascending: false
    });
    if (error) return json({
      error: error.message
    }, 500);
    return json({
      invitations: data
    });
  }
  // ── revoke_share_link ──────────────────────────────────────────────────────
  if (action === "revoke_share_link") {
    const user = await getAuthUser(req, supabase);
    if (!user) return json({
      error: "unauthorized"
    }, 401);
    const { share_token } = params;
    const { error } = await supabase.from("shareable_calendars").delete().eq("share_token", share_token).eq("created_by", user.id);
    if (error) return json({
      error: error.message
    }, 500);
    return json({
      success: true
    });
  }
  return json({
    error: "unknown_action"
  }, 400);
});

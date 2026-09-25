// DEFECT 2026-09-19 (42703 — whole feature dead) — every query in this
// function named columns that do not exist on `copilot_messages`.
//
// The table is (id, thread_id, role, content, tool_calls, tool_results,
// draft_id, created_at). This function was selecting
//   .select('id, role, content, suggestions, created_at')
//   .eq('user_id', user.id).eq('trip_id', trip_id)
// and inserting { user_id, trip_id, role, content, suggestions }.
//
// `user_id`, `trip_id` and `suggestions` are all absent. PostgREST rejects the
// ENTIRE request when any selected, filtered or inserted column is unknown, so
// BOTH verbs failed outright with a 42703 on every single call: GET returned
// "Failed to fetch messages" (500) and POST returned "Failed to save message"
// (500), for every user, for every trip, always. Copilot conversation history
// has never worked — no message has ever been read or written by this
// endpoint, which is why copilot_threads and copilot_messages are both empty.
//
// The real model is two tables: `copilot_threads` (id, trip_id, user_id,
// title, created_at, last_message_at, deleted_at) holds one conversation per
// trip per user, and `copilot_messages` hangs off it by thread_id. Note the
// identity split that made this easy to get wrong: copilot_threads.user_id is
// the platform TEXT id space (usr_<hex>), NOT auth.uid(). Comparing auth.uid()
// to it is a 22P02, not an empty result, so it is bridged through
// auth_identities.provider_subject below.
//
// Neither table's `id` has a database default — both are TEXT and must be
// generated here, following the project's <prefix>_<20 hex> convention.
//
// `suggestions` has no equivalent column anywhere. Rather than silently drop a
// caller's suggestions on insert (which would report success while losing
// them) a non-empty suggestions array is rejected with a 400 that says why,
// and reads no longer claim a suggestions field they cannot populate.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json'
    }
  });
}
/** Project id convention: <prefix>_<20 lowercase hex chars>, as used by mem_/usr_. */ function newId(prefix) {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes).map((b)=>b.toString(16).padStart(2, '0')).join('')}`;
}
/**
 * Bridges auth.uid() to the platform TEXT user id.
 *
 * Match on provider_subject ALONE — auth_identities.provider varies by sign-in
 * method, so filtering on a fixed value matches nothing and silently denies
 * everyone.
 */ async function resolvePlatformUserId(supabase, authUserId) {
  const { data, error } = await supabase.from('auth_identities').select('user_id').eq('provider_subject', authUserId).maybeSingle();
  if (error) return {
    id: null,
    error: error.message
  };
  return {
    id: data?.user_id ?? null,
    error: null
  };
}
/** True when this caller may use the copilot on this trip. */ async function canAccessTrip(supabase, tripId, authUserId, platformUserId) {
  // trips.user_id is a uuid matching auth.uid() directly.
  const owner = await supabase.from('trips').select('id').eq('id', tripId).eq('user_id', authUserId).maybeSingle();
  if (owner.error) return {
    ok: false,
    error: owner.error.message
  };
  if (owner.data) return {
    ok: true,
    error: null
  };
  if (!platformUserId) return {
    ok: false,
    error: null
  };
  // trip_members.user_id is the platform TEXT id space.
  const member = await supabase.from('trip_members').select('id').eq('trip_id', tripId).eq('user_id', platformUserId).is('removed_at', null).maybeSingle();
  if (member.error) return {
    ok: false,
    error: member.error.message
  };
  return {
    ok: !!member.data,
    error: null
  };
}
Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: corsHeaders
    });
  }
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  // Auth
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return json({
      error: 'Unauthorized'
    }, 401);
  }
  const jwt = authHeader.replace('Bearer ', '');
  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const { data: { user }, error: authError } = await supabase.auth.getUser(jwt);
  if (authError || !user) {
    return json({
      error: 'Unauthorized'
    }, 401);
  }
  const { id: platformUserId, error: identityError } = await resolvePlatformUserId(supabase, user.id);
  if (identityError) {
    console.error('[copilot-conversations] identity bridge failed:', identityError);
    return json({
      error: 'Failed to resolve account identity',
      detail: identityError
    }, 500);
  }
  if (!platformUserId) {
    // The account exists in Supabase auth but has no platform identity row, so
    // it owns no copilot threads. This is a real, explainable state — not an
    // empty conversation.
    return json({
      error: 'No platform identity for this account',
      detail: 'auth_identities has no row bridging this user to the platform id space.'
    }, 409);
  }
  // GET — fetch conversation history
  if (req.method === 'GET') {
    const url = new URL(req.url);
    const trip_id = url.searchParams.get('trip_id');
    const limitRaw = parseInt(url.searchParams.get('limit') ?? '50', 10);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 50;
    if (!trip_id) {
      return json({
        error: 'trip_id is required'
      }, 400);
    }
    const access = await canAccessTrip(supabase, trip_id, user.id, platformUserId);
    if (access.error) {
      console.error('[copilot-conversations] trip access check failed:', access.error);
      return json({
        error: 'Failed to check trip access',
        detail: access.error
      }, 500);
    }
    if (!access.ok) return json({
      error: 'Trip not found'
    }, 404);
    const { data: thread, error: threadError } = await supabase.from('copilot_threads').select('id, title, created_at, last_message_at').eq('trip_id', trip_id).eq('user_id', platformUserId).is('deleted_at', null).order('last_message_at', {
      ascending: false
    }).limit(1).maybeSingle();
    if (threadError) {
      console.error('[copilot-conversations] thread lookup failed:', threadError.code, threadError.message);
      return json({
        error: 'Failed to load conversation',
        detail: threadError.message
      }, 500);
    }
    // No thread yet is genuinely "no conversation", distinct from a failure.
    if (!thread) {
      return json({
        messages: [],
        thread_id: null
      }, 200);
    }
    const { data: messages, error: fetchError } = await supabase.from('copilot_messages').select('id, role, content, tool_calls, tool_results, draft_id, created_at').eq('thread_id', thread.id).order('created_at', {
      ascending: true
    }).limit(limit);
    if (fetchError) {
      console.error('[copilot-conversations] fetch messages failed:', fetchError.code, fetchError.message);
      return json({
        error: 'Failed to fetch messages',
        detail: fetchError.message
      }, 500);
    }
    return json({
      messages: messages ?? [],
      thread_id: thread.id,
      thread_title: thread.title
    }, 200);
  }
  // POST — save a message
  if (req.method === 'POST') {
    let body;
    try {
      body = await req.json();
    } catch  {
      return json({
        error: 'Invalid JSON body'
      }, 400);
    }
    const { trip_id, role, content, suggestions = [], tool_calls = null, tool_results = null, draft_id = null } = body;
    if (!trip_id || !role || !content) {
      return json({
        error: 'trip_id, role, and content are required'
      }, 400);
    }
    if (![
      'user',
      'assistant',
      'system'
    ].includes(role)) {
      return json({
        error: 'role must be user, assistant, or system'
      }, 400);
    }
    // See the header note: there is no column to put these in. Refusing is the
    // only honest option — the previous behaviour would have discarded them.
    if (Array.isArray(suggestions) && suggestions.length > 0) {
      return json({
        error: 'suggestions cannot be stored',
        detail: 'copilot_messages has no suggestions column. Send structured assistant output in tool_calls or tool_results instead.'
      }, 400);
    }
    const access = await canAccessTrip(supabase, trip_id, user.id, platformUserId);
    if (access.error) {
      console.error('[copilot-conversations] trip access check failed:', access.error);
      return json({
        error: 'Failed to check trip access',
        detail: access.error
      }, 500);
    }
    if (!access.ok) return json({
      error: 'Trip not found'
    }, 404);
    // Find the live thread for this (user, trip), or open one.
    const { data: existingThread, error: threadError } = await supabase.from('copilot_threads').select('id').eq('trip_id', trip_id).eq('user_id', platformUserId).is('deleted_at', null).order('last_message_at', {
      ascending: false
    }).limit(1).maybeSingle();
    if (threadError) {
      console.error('[copilot-conversations] thread lookup failed:', threadError.code, threadError.message);
      return json({
        error: 'Failed to load conversation',
        detail: threadError.message
      }, 500);
    }
    let threadId = existingThread?.id;
    if (!threadId) {
      const newThreadId = newId('thr');
      const { data: createdThread, error: createError } = await supabase.from('copilot_threads').insert({
        id: newThreadId,
        trip_id,
        user_id: platformUserId,
        title: null
      }).select('id').single();
      if (createError || !createdThread) {
        console.error('[copilot-conversations] thread create failed:', createError?.code, createError?.message);
        return json({
          error: 'Failed to start conversation',
          detail: createError?.message
        }, 500);
      }
      threadId = createdThread.id;
    }
    const { data: inserted, error: insertError } = await supabase.from('copilot_messages').insert({
      id: newId('msg'),
      thread_id: threadId,
      role,
      content,
      tool_calls,
      tool_results,
      draft_id
    }).select('id').single();
    if (insertError || !inserted) {
      console.error('[copilot-conversations] insert message failed:', insertError?.code, insertError?.message);
      return json({
        error: 'Failed to save message',
        detail: insertError?.message
      }, 500);
    }
    // Keep the thread ordering meaningful. A failure here does not lose the
    // message, so it is logged rather than surfaced as a failed write — but it
    // is logged, not swallowed.
    const { error: touchError } = await supabase.from('copilot_threads').update({
      last_message_at: new Date().toISOString()
    }).eq('id', threadId);
    if (touchError) {
      console.error('[copilot-conversations] failed to bump last_message_at:', touchError.code, touchError.message);
    }
    return json({
      id: inserted.id,
      thread_id: threadId,
      success: true
    }, 201);
  }
  return json({
    error: 'Method not allowed'
  }, 405);
});

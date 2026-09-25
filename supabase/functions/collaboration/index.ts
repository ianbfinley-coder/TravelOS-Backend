import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS,
      'Content-Type': 'application/json'
    }
  });
}
function err(msg, status, code) {
  return json({
    error: msg,
    ...code ? {
      code
    } : {}
  }, status);
}
// DEFECT 2026-09-19 (weak ids) — generateId() was
//     `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2,12)}`
// Math.random() is not a CSPRNG, the base36 tail is only ~10 chars, and the
// timestamp prefix means two ids minted in the same millisecond differ only in
// that tail. These ids are primary keys (comments.id, activity_events.id,
// polls_v2.id, change_proposals.id) and, for polls, appear in URLs handed to
// other trip members. Switched to crypto.getRandomValues and the project's
// `<prefix>_<20 lowercase hex>` convention used everywhere else.
function generateId(prefix) {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes).map((b)=>b.toString(16).padStart(2, '0')).join('')}`;
}
// ── Restore tokens ──────────────────────────────────────────────────
//
// DEFECT 2026-09-19 (failure looks like absence) — restore tokens used to live
// in a module-level `Map`:
//     const restoreTokens = new Map<string, {...}>();
// Edge functions run in short-lived, horizontally-scaled isolates. The isolate
// that served POST /restore is very often NOT the isolate that serves the
// POST /restore/apply moments later, and any isolate can be torn down between
// the two calls. The token then is not in the Map and apply answered
// 'Invalid or expired restore token' — a message that tells the user their
// token was bad when in truth the server had simply forgotten it. Restore
// appeared to work intermittently and nobody could reproduce it.
//
// The token is now self-contained and HMAC-signed with the service role key,
// so any isolate can verify one minted by any other. Nothing is stored.
const RESTORE_TOKEN_TTL_MS = 10 * 60 * 1000;
let restoreKeyPromise = null;
function restoreKey() {
  if (!restoreKeyPromise) {
    restoreKeyPromise = crypto.subtle.importKey('raw', new TextEncoder().encode(SUPABASE_SERVICE_ROLE_KEY), {
      name: 'HMAC',
      hash: 'SHA-256'
    }, false, [
      'sign',
      'verify'
    ]);
  }
  return restoreKeyPromise;
}
function b64urlFromBytes(bytes) {
  let bin = '';
  for(let i = 0; i < bytes.length; i += 0x8000){
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function bytesFromB64url(s) {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for(let i = 0; i < bin.length; i++)out[i] = bin.charCodeAt(i);
  return out;
}
async function signRestoreToken(payload) {
  const body = b64urlFromBytes(new TextEncoder().encode(JSON.stringify(payload)));
  const mac = await crypto.subtle.sign('HMAC', await restoreKey(), new TextEncoder().encode(body));
  return `${body}.${b64urlFromBytes(new Uint8Array(mac))}`;
}
async function verifyRestoreToken(token) {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  let mac;
  try {
    mac = bytesFromB64url(token.slice(dot + 1));
  } catch  {
    return null;
  }
  const ok = await crypto.subtle.verify('HMAC', await restoreKey(), mac, new TextEncoder().encode(body));
  if (!ok) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(bytesFromB64url(body)));
    if (typeof payload.e !== 'number' || Date.now() > payload.e) return null;
    return payload;
  } catch  {
    return null;
  }
}
async function verifyJWT(req) {
  const authHeader = req.headers.get('authorization');
  if (!authHeader) return null;
  const token = authHeader.replace('Bearer ', '');
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: {
      headers: {
        Authorization: `Bearer ${token}`
      }
    }
  });
  const { data: { user }, error } = await userClient.auth.getUser();
  if (error || !user) return null;
  return {
    userId: user.id,
    client: userClient
  };
}
function svc() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
}
// SECURITY 2026-09-18: TravelOS runs two id spaces for users — auth.uid()
// (a uuid, what a JWT carries) and platform_users.id (TEXT, "usr_<hex>"),
// which is what trip_members.user_id actually holds. getMember() and
// checkTripMembership() below used to filter trip_members.user_id directly
// on the caller's raw auth uuid, which can never match a "usr_..." value —
// every membership check silently returned zero rows and denied every real
// member. auth_identities.provider_subject holds the auth uuid as text and
// bridges to auth_identities.user_id (the platform "usr_" id); this mirrors
// _shared/auth.ts's resolvePlatformUserId(), inlined here since this
// function does not bundle _shared/auth.ts. Match on provider_subject
// ALONE — the provider column varies by sign-in method.
//
// DEFECT 2026-09-19 (failure looks like absence) — this and the two helpers
// below discarded their `error` and returned null/false, so a transport
// failure or a schema error was indistinguishable from "this person is not on
// this trip" and every route answered 404 'Not a trip member'. They now
// report the failure separately so requireMember() can answer 500.
async function resolvePlatformUserId(authUserId) {
  const db = svc();
  const { data, error } = await db.from('auth_identities').select('user_id').eq('provider_subject', authUserId).maybeSingle();
  if (error) {
    console.error('[collaboration] auth_identities lookup failed:', error.message);
    return {
      failed: error.message
    };
  }
  return {
    id: data?.user_id ?? null
  };
}
// SECURITY 2026-09-16: this previously fabricated a member record when no
// trip_members row existed, handing the caller role 'member' on a trip they may
// have nothing to do with. It now returns null and every call site must handle
// that. Reachable only after checkTripMembership has already passed.
//
// Takes the platform user id (trip_members.user_id's id space), not the raw
// auth uuid — see resolvePlatformUserId() above.
async function getMember(tripId, platformUserId) {
  const db = svc();
  const { data, error } = await db.from('trip_members').select('id, trip_id, user_id, kind, role, display_name, removed_at').eq('trip_id', tripId).eq('user_id', platformUserId).is('removed_at', null).maybeSingle();
  if (error) {
    console.error('[collaboration] trip_members lookup failed:', error.message);
    return {
      failed: error.message
    };
  }
  return {
    member: data ?? null
  };
}
// SECURITY 2026-09-16: FAIL CLOSED.
//
// This function previously ended with:
//     // If no trip_members rows at all, allow (fallback mode)
//     if ((count ?? 0) === 0) return true;
//
// trip_members is empty, so that branch was taken on EVERY call and any
// authenticated user passed the membership check for any trip id. The fallback
// was presumably scaffolding from before trip_members was wired up; it is an
// authentication bypass and has been removed. Membership is now proven or denied.
//
// Resolves membership and the member record in one step. Returns either the
// member or the Response to return. Use this instead of calling the helpers
// separately, so a route can never check one and forget the other.
//
// `userId` here is the raw auth.uid() from the caller's JWT. It is resolved
// to the platform user id exactly once per request.
async function requireMember(tripId, userId) {
  const resolved = await resolvePlatformUserId(userId);
  if ('failed' in resolved) {
    return {
      deny: err('Could not verify trip membership', 500, 'MEMBERSHIP_CHECK_FAILED')
    };
  }
  if (!resolved.id) return {
    deny: err('Not a trip member', 404)
  };
  const found = await getMember(tripId, resolved.id);
  if ('failed' in found) {
    return {
      deny: err('Could not verify trip membership', 500, 'MEMBERSHIP_CHECK_FAILED')
    };
  }
  if (!found.member) return {
    deny: err('Not a trip member', 404)
  };
  return {
    member: found.member
  };
}
// DEFECT 2026-09-19 (schema mismatch) — this read:
//     if (perm === ...) return role === 'organizer' || kind === 'organizer';
// trip_members.role is the member_role enum (owner|organizer|member|viewer)
// and trip_members.kind is the member_kind enum (account|guest). So
// `kind === 'organizer'` can never be true for any row in the table, and —
// the real damage — the trip's OWNER is not 'organizer' either, so the person
// who created the trip was refused content.delete_any, content.update_any and
// trip.update on their own trip: they could not resolve a comment thread,
// delete anyone else's comment, restore a previous version, or approve a
// change proposal. Owner now carries at least organizer's authority, and the
// impossible kind test is gone.
const ELEVATED_ROLES = new Set([
  'owner',
  'organizer'
]);
function hasPermission(member, perm) {
  const role = member.role ?? 'member';
  if (perm === 'content.delete_any' || perm === 'content.update_any' || perm === 'trip.update') {
    return ELEVATED_ROLES.has(role);
  }
  return true;
}
function extractMentions(body) {
  const re = /@\[([^\]]+)\]/g;
  const names = [];
  let m;
  while((m = re.exec(body)) !== null)names.push(m[1]);
  return names;
}
async function resolveMentions(tripId, names) {
  if (!names.length) return [];
  const db = svc();
  const { data, error } = await db.from('trip_members').select('id, display_name').eq('trip_id', tripId).in('display_name', names);
  // DEFECT 2026-09-19 (discarded error) — the error was dropped, so a failed
  // lookup silently produced a comment with nobody mentioned. Still
  // non-fatal for the comment itself, but now it is visible in the logs.
  if (error) {
    console.error('[collaboration] mention resolution failed:', error.message);
    return [];
  }
  return (data ?? []).map((m)=>m.id);
}
// DEFECT 2026-09-19 (discarded error) — writeActivity() awaited an insert and
// threw the result away. activity_events.verb carries a CHECK constraint and
// the table requires target_title and summary; any violation vanished and the
// trip feed simply missed the event with no trace. Failures are now logged
// with the offending verb; the caller's own write still succeeds.
async function writeActivity(params) {
  const db = svc();
  const { error } = await db.from('activity_events').insert({
    id: generateId('act'),
    trip_id: params.tripId,
    actor_member_id: params.actorMemberId,
    verb: params.verb,
    target_type: params.targetType,
    target_id: params.targetId,
    target_title: params.targetTitle,
    summary: params.summary,
    group_key: params.groupKey ?? null,
    visible_to: params.visibleTo ?? 'all'
  });
  if (error) {
    console.error(`[collaboration] activity_events insert failed (verb=${params.verb}):`, error.message);
  }
}
// DEFECT 2026-09-19 (schema mismatch) — every poll this function creates used
// to be written as:
//     db.from('polls_v2').insert({ id, trip_id, question, strategy, status,
//                                  created_by, options: [...] })
// polls_v2 has NO `options` column — its options live in poll_options_v2
// (id, poll_id, label, linked_ref, cost_per_person_minor, cost_currency,
// opt_in, sort). PostgREST rejects the whole INSERT with 42703, and both call
// sites discarded the error (`.select().maybeSingle()` with no destructuring
// of `error`). So:
//   * POST /comments/:id/to-poll returned { pollId, pollUrl } for a poll that
//     did not exist — the member clicked through to a dead link;
//   * POST /proposals with approvalMode 'poll' stored a change_proposals row
//     whose poll_id pointed at nothing, so the proposal could never be voted
//     on and sat open forever.
// Neither has ever created a poll: polls_v2 is empty.
//
// createPoll() now inserts the poll and its options into their real tables and
// reports failure. If the options insert fails the poll row is deleted again,
// so no caller is handed an id for a poll with no way to answer it.
async function createPoll(params) {
  const db = svc();
  const pollId = generateId('poll');
  const { error: pollErr } = await db.from('polls_v2').insert({
    id: pollId,
    trip_id: params.tripId,
    question: params.question,
    strategy: params.strategy,
    status: 'open',
    created_by: params.createdBy
  });
  if (pollErr) {
    console.error('[collaboration] polls_v2 insert failed:', pollErr.message);
    return {
      failed: pollErr.message
    };
  }
  if (params.options.length) {
    const rows = params.options.map((label, i)=>({
        id: generateId('opt'),
        poll_id: pollId,
        label,
        sort: i
      }));
    const { error: optErr } = await db.from('poll_options_v2').insert(rows);
    if (optErr) {
      console.error('[collaboration] poll_options_v2 insert failed:', optErr.message);
      const { error: rollbackErr } = await db.from('polls_v2').delete().eq('id', pollId);
      if (rollbackErr) {
        console.error(`[collaboration] could not roll back orphaned poll ${pollId}:`, rollbackErr.message);
      }
      return {
        failed: optErr.message
      };
    }
  }
  return {
    pollId
  };
}
async function getReactionCounts(commentId) {
  const db = svc();
  const { data, error } = await db.from('comment_reactions').select('emoji').eq('comment_id', commentId);
  if (error) {
    console.error('[collaboration] reaction count read failed:', error.message);
    return {};
  }
  const counts = {};
  for (const row of data ?? []){
    counts[row.emoji] = (counts[row.emoji] ?? 0) + 1;
  }
  return counts;
}
function formatComment(c, reactions) {
  if (c.deleted_at) {
    return {
      id: c.id,
      deleted: true,
      body: 'Comment removed',
      author_member_id: c.author_member_id,
      created_at: c.created_at,
      thread_id: c.thread_id,
      reactions: reactions ?? {}
    };
  }
  return {
    ...c,
    reactions: reactions ?? {}
  };
}
function computeDiff(before, after) {
  const changes = [];
  const allKeys = new Set([
    ...Object.keys(before ?? {}),
    ...Object.keys(after ?? {})
  ]);
  for (const key of allKeys){
    const bVal = before?.[key];
    const aVal = after?.[key];
    if (JSON.stringify(bVal) === JSON.stringify(aVal)) continue;
    if (bVal === undefined) {
      changes.push({
        field: key,
        from: null,
        to: aVal,
        kind: 'added'
      });
    } else if (aVal === undefined) {
      changes.push({
        field: key,
        from: bVal,
        to: null,
        kind: 'removed'
      });
    } else {
      changes.push({
        field: key,
        from: bVal,
        to: aVal,
        kind: 'changed'
      });
    }
  }
  return changes;
}
Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: CORS
    });
  }
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/collaboration/, '').replace(/^\/?/, '/');
  const method = req.method;
  console.log('[collaboration]', method, path);
  // ── Auth ───────────────────────────────────────────────────────────
  const auth = await verifyJWT(req);
  if (!auth) return err('Missing or invalid JWT', 401);
  const { userId } = auth;
  // ── Route dispatch ────────────────────────────────────────────────
  // GET /comments
  if (method === 'GET' && path === '/comments') {
    const tripId = url.searchParams.get('tripId');
    const targetType = url.searchParams.get('targetType');
    const targetId = url.searchParams.get('targetId');
    if (!tripId || !targetType || !targetId) return err('Missing params', 400);
    const gate = await requireMember(tripId, userId);
    if ('deny' in gate) return gate.deny;
    const db = svc();
    const { data: comments, error } = await db.from('comments').select('*').eq('trip_id', tripId).eq('target_type', targetType).eq('target_id', targetId).order('created_at', {
      ascending: true
    });
    if (error) return err(error.message, 500);
    const allIds = (comments ?? []).map((c)=>c.id);
    const { data: allReactions, error: reactionErr } = await db.from('comment_reactions').select('comment_id, emoji').in('comment_id', allIds.length ? allIds : [
      '__none__'
    ]);
    // DEFECT 2026-09-19 (discarded error) — a failed reaction read used to be
    // indistinguishable from "nobody has reacted": every thread came back with
    // an empty reactions map. It now fails the request rather than lying.
    if (reactionErr) return err(reactionErr.message, 500);
    const reactionMap = {};
    for (const r of allReactions ?? []){
      if (!reactionMap[r.comment_id]) reactionMap[r.comment_id] = {};
      reactionMap[r.comment_id][r.emoji] = (reactionMap[r.comment_id][r.emoji] ?? 0) + 1;
    }
    const roots = {};
    const replies = {};
    for (const c of comments ?? []){
      const formatted = formatComment(c, reactionMap[c.id] ?? {});
      if (c.thread_id === c.id) {
        roots[c.id] = formatted;
      } else {
        if (!replies[c.thread_id]) replies[c.thread_id] = [];
        replies[c.thread_id].push(formatted);
      }
    }
    const threads = Object.values(roots).map((root)=>({
        root,
        replies: replies[root.id] ?? [],
        resolved: !!root.resolved_at
      }));
    return json({
      threads
    });
  }
  // POST /comments
  if (method === 'POST' && path === '/comments') {
    const body = await req.json().catch(()=>null);
    if (!body || typeof body !== 'object') return err('Invalid JSON body', 400);
    const { tripId, targetType, targetId, body: commentBody, threadId, mentions } = body;
    if (!tripId || !targetType || !targetId || !commentBody) return err('Missing params', 400);
    if (typeof commentBody !== 'string') return err('body must be a string', 400);
    if (commentBody.length > 2000) return err('Body too long', 400);
    const gate = await requireMember(tripId, userId);
    if ('deny' in gate) return gate.deny;
    const member = gate.member;
    const commentId = generateId('cmt');
    const resolvedThreadId = threadId ?? commentId;
    const mentionNames = extractMentions(commentBody);
    const resolvedMentions = await resolveMentions(tripId, mentionNames);
    const allMentions = [
      ...new Set([
        ...mentions ?? [],
        ...resolvedMentions
      ])
    ];
    const db = svc();
    const { data: comment, error } = await db.from('comments').insert({
      id: commentId,
      trip_id: tripId,
      target_type: targetType,
      target_id: targetId,
      thread_id: resolvedThreadId,
      author_member_id: member.id,
      body: commentBody,
      mentions: allMentions
    }).select().single();
    if (error) return err(error.message, 500);
    await writeActivity({
      tripId,
      actorMemberId: member.id,
      verb: 'commented',
      targetType,
      targetId,
      targetTitle: targetId,
      summary: `${member.display_name} commented on ${targetId}`,
      groupKey: `comment:${targetType}:${targetId}`
    });
    return json(formatComment(comment, {}), 201);
  }
  // PATCH /comments/:id
  const patchCommentMatch = path.match(/^\/comments\/([^/]+)$/);
  if (method === 'PATCH' && patchCommentMatch) {
    const commentId = patchCommentMatch[1];
    const body = await req.json().catch(()=>null);
    if (!body || typeof body !== 'object') return err('Invalid JSON body', 400);
    const { body: newBody } = body;
    if (!newBody) return err('Missing body', 400);
    if (typeof newBody !== 'string') return err('body must be a string', 400);
    if (newBody.length > 2000) return err('Body too long', 400);
    const db = svc();
    const { data: existing, error: fetchErr } = await db.from('comments').select('*').eq('id', commentId).maybeSingle();
    // DEFECT 2026-09-19 (failure looks like absence) — this was
    //     if (fetchErr || !existing) return err('Comment not found', 404);
    // which told the editor their comment had been deleted whenever the read
    // itself failed. The two cases are now separated (same split applied to
    // the DELETE, resolve, reactions and to-poll routes below).
    if (fetchErr) return err(fetchErr.message, 500, 'COMMENT_LOOKUP_FAILED');
    if (!existing) return err('Comment not found', 404);
    const gate = await requireMember(existing.trip_id, userId);
    if ('deny' in gate) return gate.deny;
    const member = gate.member;
    if (existing.author_member_id !== member.id) return err('Forbidden', 403);
    const createdAt = new Date(existing.created_at).getTime();
    const windowMs = 15 * 60 * 1000;
    if (Date.now() - createdAt > windowMs) return err('Edit window closed', 409, 'EDIT_WINDOW_CLOSED');
    const { data: updated, error: updateErr } = await db.from('comments').update({
      body: newBody,
      edited_at: new Date().toISOString()
    }).eq('id', commentId).select().single();
    if (updateErr) return err(updateErr.message, 500);
    return json(formatComment(updated, await getReactionCounts(commentId)));
  }
  // DELETE /comments/:id
  const deleteCommentMatch = path.match(/^\/comments\/([^/]+)$/);
  if (method === 'DELETE' && deleteCommentMatch) {
    const commentId = deleteCommentMatch[1];
    const db = svc();
    const { data: existing, error: fetchErr } = await db.from('comments').select('*').eq('id', commentId).maybeSingle();
    if (fetchErr) return err(fetchErr.message, 500, 'COMMENT_LOOKUP_FAILED');
    if (!existing) return err('Comment not found', 404);
    const gate = await requireMember(existing.trip_id, userId);
    if ('deny' in gate) return gate.deny;
    const member = gate.member;
    const isAuthor = existing.author_member_id === member.id;
    const canDeleteAny = hasPermission(member, 'content.delete_any');
    if (!isAuthor && !canDeleteAny) return err('Forbidden', 403);
    const { error: updateErr } = await db.from('comments').update({
      deleted_at: new Date().toISOString(),
      body: 'Comment removed'
    }).eq('id', commentId);
    if (updateErr) return err(updateErr.message, 500);
    return json({
      success: true
    });
  }
  // POST /comments/:id/resolve
  const resolveMatch = path.match(/^\/comments\/([^/]+)\/resolve$/);
  if (method === 'POST' && resolveMatch) {
    const commentId = resolveMatch[1];
    const body = await req.json().catch(()=>null);
    if (!body || typeof body !== 'object') return err('Invalid JSON body', 400);
    const { resolved } = body;
    const db = svc();
    const { data: existing, error: fetchErr } = await db.from('comments').select('*').eq('id', commentId).maybeSingle();
    if (fetchErr) return err(fetchErr.message, 500, 'COMMENT_LOOKUP_FAILED');
    if (!existing) return err('Comment not found', 404);
    const gate = await requireMember(existing.trip_id, userId);
    if ('deny' in gate) return gate.deny;
    const member = gate.member;
    if (!hasPermission(member, 'content.update_any')) return err('Forbidden', 403);
    const update = resolved ? {
      resolved_at: new Date().toISOString(),
      resolved_by: member.id
    } : {
      resolved_at: null,
      resolved_by: null
    };
    const { data: updated, error: updateErr } = await db.from('comments').update(update).eq('id', commentId).select().single();
    if (updateErr) return err(updateErr.message, 500);
    return json(formatComment(updated, await getReactionCounts(commentId)));
  }
  // POST /comments/:id/reactions
  const reactionsMatch = path.match(/^\/comments\/([^/]+)\/reactions$/);
  if (method === 'POST' && reactionsMatch) {
    const commentId = reactionsMatch[1];
    const body = await req.json().catch(()=>null);
    if (!body || typeof body !== 'object') return err('Invalid JSON body', 400);
    const { emoji } = body;
    if (!emoji) return err('Missing emoji', 400);
    const db = svc();
    const { data: existing, error: existingErr } = await db.from('comments').select('trip_id').eq('id', commentId).maybeSingle();
    if (existingErr) return err(existingErr.message, 500, 'COMMENT_LOOKUP_FAILED');
    if (!existing) return err('Comment not found', 404);
    // SECURITY 2026-09-16: this route previously called getMember() with no
    // membership check at all, so a caller who knew a comment id could react to
    // it on any trip. Now gated like every other route.
    const gate = await requireMember(existing.trip_id, userId);
    if ('deny' in gate) return gate.deny;
    const member = gate.member;
    const { data: existingReaction, error: lookupErr } = await db.from('comment_reactions').select('comment_id').eq('comment_id', commentId).eq('member_id', member.id).eq('emoji', emoji).maybeSingle();
    if (lookupErr) return err(lookupErr.message, 500);
    // DEFECT 2026-09-19 (discarded error) — the toggle's insert and delete both
    // threw their result away and the route then re-read the counts, so a
    // rejected write (comment_reactions is keyed on (comment_id, member_id,
    // emoji) and its comment_id is a FK) came back as "your reaction did not
    // register, try again" with a 200. Both halves now fail loudly.
    if (existingReaction) {
      const { error: delErr } = await db.from('comment_reactions').delete().eq('comment_id', commentId).eq('member_id', member.id).eq('emoji', emoji);
      if (delErr) return err(delErr.message, 500);
    } else {
      const { error: insErr } = await db.from('comment_reactions').insert({
        comment_id: commentId,
        member_id: member.id,
        emoji
      });
      if (insErr) return err(insErr.message, 500);
    }
    const reactions = await getReactionCounts(commentId);
    return json({
      reactions
    });
  }
  // POST /comments/:id/to-poll
  const toPollMatch = path.match(/^\/comments\/([^/]+)\/to-poll$/);
  if (method === 'POST' && toPollMatch) {
    const commentId = toPollMatch[1];
    const body = await req.json().catch(()=>null);
    if (!body || typeof body !== 'object') return err('Invalid JSON body', 400);
    const { tripId, options } = body;
    if (!tripId) return err('Missing tripId', 400);
    const db = svc();
    const { data: comment, error: commentErr } = await db.from('comments').select('*').eq('id', commentId).maybeSingle();
    if (commentErr) return err(commentErr.message, 500, 'COMMENT_LOOKUP_FAILED');
    if (!comment) return err('Comment not found', 404);
    const gate = await requireMember(tripId, userId);
    if ('deny' in gate) return gate.deny;
    const member = gate.member;
    // The caller may supply the answer options; a poll with none is a poll
    // nobody can answer, so default to yes/no rather than creating an empty one.
    const labels = Array.isArray(options) && options.length ? options.map((o)=>typeof o === 'string' ? o : String(o?.label ?? '')).filter((s)=>s.length > 0) : [
      'Yes',
      'No'
    ];
    const created = await createPoll({
      tripId,
      question: comment.body,
      strategy: 'majority',
      createdBy: member.id,
      options: labels
    });
    if ('failed' in created) {
      return err(`Could not create the poll: ${created.failed}`, 500, 'POLL_CREATE_FAILED');
    }
    return json({
      pollId: created.pollId,
      pollUrl: `/trip/${tripId}/poll/${created.pollId}`
    });
  }
  // GET /activity
  if (method === 'GET' && path === '/activity') {
    const tripId = url.searchParams.get('tripId');
    const filter = url.searchParams.get('filter') ?? 'all';
    const cursor = url.searchParams.get('cursor');
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10), 100);
    if (!tripId) return err('Missing tripId', 400);
    const gate = await requireMember(tripId, userId);
    if ('deny' in gate) return gate.deny;
    const member = gate.member;
    const db = svc();
    let query = db.from('activity_events').select('*').eq('trip_id', tripId).order('at', {
      ascending: false
    }).limit(limit + 1);
    if (cursor) query = query.lt('at', cursor);
    const isGuest = member.kind === 'guest';
    if (isGuest) query = query.eq('visible_to', 'all');
    const { data: events, error } = await query;
    if (error) return err(error.message, 500);
    let filtered = events ?? [];
    if (filter === 'mentions') {
      filtered = filtered.filter((e)=>e.summary?.includes(`@${member.display_name}`) || e.summary?.includes(member.id));
    } else if (filter === 'plan') {
      filtered = filtered.filter((e)=>[
          'added',
          'moved',
          'edited',
          'removed',
          'restored'
        ].includes(e.verb));
    } else if (filter === 'money') {
      filtered = filtered.filter((e)=>[
          'booked',
          'paid'
        ].includes(e.verb));
    } else if (filter === 'decisions') {
      filtered = filtered.filter((e)=>[
          'voted',
          'decided',
          'proposed',
          'approved',
          'rejected'
        ].includes(e.verb));
    }
    const collapsed = [];
    for (const event of filtered){
      const last = collapsed[collapsed.length - 1];
      if (last && last.group_key && last.group_key === event.group_key && last.actor_member_id === event.actor_member_id && Math.abs(new Date(last.at).getTime() - new Date(event.at).getTime()) < 5 * 60 * 1000) {
        continue;
      }
      collapsed.push(event);
    }
    const hasMore = collapsed.length > limit;
    const page = hasMore ? collapsed.slice(0, limit) : collapsed;
    const nextCursor = hasMore ? page[page.length - 1].at : null;
    const { data: marker, error: markerErr } = await db.from('activity_read_markers').select('last_read_at').eq('trip_id', tripId).eq('member_id', member.id).maybeSingle();
    if (markerErr) return err(markerErr.message, 500);
    const lastReadAt = marker?.last_read_at ?? new Date(0).toISOString();
    // DEFECT 2026-09-19 (wrong result) — the unread count ignored visible_to,
    // so a guest was shown a badge counting members_only events they are not
    // allowed to see and which therefore never appeared when they opened the
    // feed: the badge could not be cleared by reading. It now applies the same
    // visibility filter as the feed query above.
    let unreadQuery = db.from('activity_events').select('id', {
      count: 'exact',
      head: true
    }).eq('trip_id', tripId).gt('at', lastReadAt);
    if (isGuest) unreadQuery = unreadQuery.eq('visible_to', 'all');
    const { count: unreadCount, error: unreadErr } = await unreadQuery;
    if (unreadErr) return err(unreadErr.message, 500);
    // DEFECT 2026-09-19 (discarded error) — the read-marker upsert dropped its
    // error. When it failed the marker never advanced and the unread badge
    // stayed at the same number no matter how often the feed was opened.
    const { error: upsertErr } = await db.from('activity_read_markers').upsert({
      trip_id: tripId,
      member_id: member.id,
      last_read_at: new Date().toISOString()
    });
    if (upsertErr) {
      console.error('[collaboration] read marker upsert failed:', upsertErr.message);
    }
    return json({
      events: page,
      nextCursor,
      unreadCount: unreadCount ?? 0,
      readMarkerAdvanced: !upsertErr
    });
  }
  // POST /activity
  if (method === 'POST' && path === '/activity') {
    const body = await req.json().catch(()=>null);
    if (!body || typeof body !== 'object') return err('Invalid JSON body', 400);
    const { tripId, verb, targetType, targetId, targetTitle, summary, groupKey } = body;
    if (!tripId || !verb || !targetType || !targetId || !targetTitle || !summary) {
      return err('Missing params', 400);
    }
    const gate = await requireMember(tripId, userId);
    if ('deny' in gate) return gate.deny;
    const member = gate.member;
    const db = svc();
    const eventId = generateId('act');
    const { data: event, error } = await db.from('activity_events').insert({
      id: eventId,
      trip_id: tripId,
      actor_member_id: member.id,
      verb,
      target_type: targetType,
      target_id: targetId,
      target_title: targetTitle,
      summary,
      group_key: groupKey ?? null
    }).select().single();
    if (error) return err(error.message, 500);
    return json(event, 201);
  }
  // GET /items/:itemId/history
  const historyMatch = path.match(/^\/items\/([^/]+)\/history$/);
  if (method === 'GET' && historyMatch) {
    const itemId = historyMatch[1];
    const tripId = url.searchParams.get('tripId');
    if (!tripId) return err('Missing tripId', 400);
    const gate = await requireMember(tripId, userId);
    if ('deny' in gate) return gate.deny;
    const db = svc();
    const { data: logs, error } = await db.from('audit_log').select('*').eq('entity_id', itemId).eq('trip_id', tripId).order('created_at', {
      ascending: false
    });
    if (error) return err(error.message, 500);
    // audit_log.actor_member_id is nullable (system-written rows have none);
    // a null in the .in() list is not a valid filter value, so drop them.
    const actorIds = [
      ...new Set((logs ?? []).map((l)=>l.actor_member_id).filter((id)=>typeof id === 'string' && id.length > 0))
    ];
    const { data: members, error: membersErr } = await db.from('trip_members').select('id, display_name').in('id', actorIds.length ? actorIds : [
      '__none__'
    ]);
    // DEFECT 2026-09-19 (discarded error) — a failed member read fell through
    // to `memberMap[...] ?? log.actor_member_id`, so the history rendered
    // every change as having been made by a raw "mem_..." id. The caller is
    // now told the names are missing instead of being shown ids as if they
    // were names.
    if (membersErr) {
      console.error('[collaboration] history actor lookup failed:', membersErr.message);
    }
    const memberMap = {};
    for (const m of members ?? [])memberMap[m.id] = m.display_name;
    const versions = (logs ?? []).map((log)=>{
      const before = log.before ?? {};
      const after = log.after ?? {};
      const changes = computeDiff(before, after);
      const actorId = log.actor_member_id;
      return {
        id: log.id,
        at: log.created_at,
        actorMemberId: actorId,
        actorName: actorId ? memberMap[actorId] ?? null : null,
        changes,
        before,
        after
      };
    });
    return json({
      versions,
      actorNamesResolved: !membersErr
    });
  }
  // GET /days/:date/snapshots
  const snapshotsMatch = path.match(/^\/days\/([^/]+)\/snapshots$/);
  if (method === 'GET' && snapshotsMatch) {
    const date = snapshotsMatch[1];
    const tripId = url.searchParams.get('tripId');
    if (!tripId) return err('Missing tripId', 400);
    const gate = await requireMember(tripId, userId);
    if ('deny' in gate) return gate.deny;
    const db = svc();
    const { data: snapshots, error } = await db.from('day_snapshots').select('*').eq('trip_id', tripId).eq('date', date).order('created_at', {
      ascending: false
    });
    if (error) return err(error.message, 500);
    return json({
      snapshots: snapshots ?? []
    });
  }
  // POST /restore
  if (method === 'POST' && path === '/restore') {
    const body = await req.json().catch(()=>null);
    if (!body || typeof body !== 'object') return err('Invalid JSON body', 400);
    const { tripId, source } = body;
    if (!tripId || !source) return err('Missing params', 400);
    const gate = await requireMember(tripId, userId);
    if ('deny' in gate) return gate.deny;
    const member = gate.member;
    if (!hasPermission(member, 'content.update_any')) return err('Forbidden', 403);
    // DEFECT 2026-09-19 (not implemented, reported as success) — a snapshot
    // restore was accepted here and produced a restoreToken, but
    // POST /restore/apply only ever handled `source.itemId`: with a
    // snapshotId it wrote nothing at all and still answered
    // { success: true, appliedAt }. An organiser could "restore" a whole day
    // and be told it had worked while the itinerary was untouched. Day
    // snapshot restore is refused explicitly until it is implemented.
    if (source.snapshotId && !source.itemId) {
      return err('Restoring a whole day from a snapshot is not implemented. Restore the individual items instead.', 501, 'SNAPSHOT_RESTORE_UNSUPPORTED');
    }
    const db = svc();
    let targetState = null;
    let changes = [];
    const conflicts = [];
    if (source.itemId && source.version) {
      const { data: log, error: logErr } = await db.from('audit_log').select('*').eq('entity_id', source.itemId).eq('trip_id', tripId).order('created_at', {
        ascending: false
      }).limit(1).maybeSingle();
      if (logErr) return err(logErr.message, 500, 'HISTORY_READ_FAILED');
      const { data: targetLog, error: targetErr } = await db.from('audit_log').select('*').eq('id', source.version).maybeSingle();
      // DEFECT 2026-09-19 (failure looks like absence) — both reads discarded
      // their error and the route then answered 'Target version not found'
      // (404). A broken history read was presented to the organiser as a
      // version that does not exist.
      if (targetErr) return err(targetErr.message, 500, 'HISTORY_READ_FAILED');
      if (targetLog) {
        targetState = targetLog.before;
        if (log) {
          changes = computeDiff(log.after, targetState ?? {});
        }
      }
    } else {
      return err('source must carry itemId and version', 400);
    }
    if (!targetState) return err('Target version not found', 404);
    const restoreToken = await signRestoreToken({
      t: tripId,
      s: source,
      x: targetState,
      e: Date.now() + RESTORE_TOKEN_TTL_MS
    });
    return json({
      preview: {
        changes,
        conflicts
      },
      restoreToken
    });
  }
  // POST /restore/apply
  if (method === 'POST' && path === '/restore/apply') {
    const body = await req.json().catch(()=>null);
    if (!body || typeof body !== 'object') return err('Invalid JSON body', 400);
    const { tripId, restoreToken } = body;
    if (!tripId || !restoreToken) return err('Missing params', 400);
    const gate = await requireMember(tripId, userId);
    if ('deny' in gate) return gate.deny;
    const member = gate.member;
    if (!hasPermission(member, 'content.update_any')) return err('Forbidden', 403);
    const tokenData = await verifyRestoreToken(String(restoreToken));
    if (!tokenData || tokenData.t !== tripId) {
      return err('Invalid or expired restore token', 400, 'RESTORE_TOKEN_INVALID');
    }
    const source = tokenData.s;
    const targetState = {
      ...tokenData.x
    };
    // Identity and provenance columns are not part of the restorable state.
    delete targetState.id;
    delete targetState.trip_id;
    delete targetState.created_at;
    const itemId = source.itemId;
    if (!itemId) return err('Restore token carries no item to restore', 400);
    const db = svc();
    const appliedAt = new Date().toISOString();
    const { data: current, error: currentErr } = await db.from('itinerary_items').select('*').eq('id', itemId).maybeSingle();
    if (currentErr) return err(currentErr.message, 500, 'ITEM_READ_FAILED');
    if (!current) return err('The item being restored no longer exists', 404);
    // DEFECT 2026-09-19 (failure looks like success) — this was
    //     await db.from('itinerary_items').update(targetState).eq('id', source.itemId);
    // with the result discarded, followed unconditionally by
    //     return json({ success: true, appliedAt });
    // targetState is a jsonb blob replayed out of audit_log; if it carries a
    // key that is no longer a column on itinerary_items the whole UPDATE is
    // rejected with 42703, and a zero-row UPDATE is not an error at all. Either
    // way the organiser was told the restore had been applied while the item
    // still held its current values. The write is now checked and the number of
    // rows it touched is confirmed before anything claims success.
    const { data: restored, error: updateErr } = await db.from('itinerary_items').update(targetState).eq('id', itemId).select('id');
    if (updateErr) return err(updateErr.message, 500, 'RESTORE_FAILED');
    if (!restored || restored.length === 0) {
      return err('The restore did not write to any row', 500, 'RESTORE_NO_ROWS');
    }
    const { error: auditErr } = await db.from('audit_log').insert({
      id: generateId('aud'),
      trip_id: tripId,
      actor_member_id: member.id,
      action: 'restored',
      entity_type: 'itinerary_item',
      entity_id: itemId,
      before: current,
      after: targetState
    });
    if (auditErr) {
      console.error('[collaboration] restore audit_log insert failed:', auditErr.message);
    }
    await writeActivity({
      tripId,
      actorMemberId: member.id,
      verb: 'restored',
      targetType: 'itinerary_item',
      targetId: itemId,
      targetTitle: targetState.title ?? 'item',
      summary: `${member.display_name} restored a previous version`
    });
    return json({
      success: true,
      appliedAt,
      auditRecorded: !auditErr
    });
  }
  // POST /presence
  if (method === 'POST' && path === '/presence') {
    const body = await req.json().catch(()=>null);
    if (!body || typeof body !== 'object') return err('Invalid JSON body', 400);
    const { tripId, view, editingItemId } = body;
    if (!tripId || !view) return err('Missing params', 400);
    const gate = await requireMember(tripId, userId);
    if ('deny' in gate) return gate.deny;
    const member = gate.member;
    const db = svc();
    // DEFECT 2026-09-19 (discarded error) — the presence upsert dropped its
    // error and answered { success: true } regardless, so a trip could show
    // "nobody else is here" while everyone was in fact posting presence that
    // never landed.
    const { error: presenceErr } = await db.from('presence').upsert({
      trip_id: tripId,
      member_id: member.id,
      view,
      editing_item_id: editingItemId ?? null,
      last_seen_at: new Date().toISOString()
    });
    if (presenceErr) return err(presenceErr.message, 500);
    return json({
      success: true
    });
  }
  // GET /presence
  if (method === 'GET' && path === '/presence') {
    const tripId = url.searchParams.get('tripId');
    if (!tripId) return err('Missing tripId', 400);
    const gate = await requireMember(tripId, userId);
    if ('deny' in gate) return gate.deny;
    const db = svc();
    const cutoff = new Date(Date.now() - 60 * 1000).toISOString();
    const { data: presenceRows, error } = await db.from('presence').select('*').eq('trip_id', tripId).gte('last_seen_at', cutoff);
    if (error) return err(error.message, 500);
    const memberIds = (presenceRows ?? []).map((p)=>p.member_id);
    const { data: memberRows, error: memberErr } = await db.from('trip_members').select('id, display_name').in('id', memberIds.length ? memberIds : [
      '__none__'
    ]);
    if (memberErr) return err(memberErr.message, 500);
    const memberMap = {};
    for (const m of memberRows ?? [])memberMap[m.id] = m.display_name;
    // DEFECT 2026-09-19 (fabricated data) — displayName used to fall back to
    // `p.member_id`, so when the name lookup came up short the presence bar
    // showed a raw "mem_1741b183df5f277d4571" in the place a person's name
    // goes, as though someone were called that. It is now null and the caller
    // can render the absence however it likes.
    const members = (presenceRows ?? []).map((p)=>({
        memberId: p.member_id,
        displayName: memberMap[p.member_id] ?? null,
        view: p.view,
        editingItemId: p.editing_item_id,
        lastSeenAt: p.last_seen_at
      }));
    return json({
      members
    });
  }
  // POST /proposals
  if (method === 'POST' && path === '/proposals') {
    const body = await req.json().catch(()=>null);
    if (!body || typeof body !== 'object') return err('Invalid JSON body', 400);
    const { tripId, ops, preview, note, approvalMode, baseVersion } = body;
    if (!tripId || !ops || !preview || !approvalMode || baseVersion === undefined) {
      return err('Missing params', 400);
    }
    if (approvalMode !== 'organizer' && approvalMode !== 'poll') {
      return err("approvalMode must be 'organizer' or 'poll'", 400);
    }
    const gate = await requireMember(tripId, userId);
    if ('deny' in gate) return gate.deny;
    const member = gate.member;
    if (hasPermission(member, 'trip.update')) {
      return err('Organizers should apply changes directly', 400);
    }
    const db = svc();
    const proposalId = generateId('prop');
    let pollId = null;
    if (approvalMode === 'poll') {
      const created = await createPoll({
        tripId,
        question: `Approve proposal: ${note ?? proposalId}`,
        strategy: 'majority',
        createdBy: member.id,
        options: [
          'Approve',
          'Reject'
        ]
      });
      // DEFECT 2026-09-19 (failure looks like success) — the poll insert's
      // error was discarded and the proposal was stored anyway with a poll_id
      // pointing at a poll that had never been created. The proposal then sat
      // open forever with no way for anyone to vote on it. A proposal that
      // needs a poll is now not created at all if the poll cannot be.
      if ('failed' in created) {
        return err(`Could not create the approval poll, so the proposal was not raised: ${created.failed}`, 500, 'POLL_CREATE_FAILED');
      }
      pollId = created.pollId;
    }
    const { data: proposal, error } = await db.from('change_proposals').insert({
      id: proposalId,
      trip_id: tripId,
      proposer_member_id: member.id,
      ops,
      preview,
      note: note ?? null,
      approval_mode: approvalMode,
      poll_id: pollId,
      base_version: baseVersion
    }).select().single();
    if (error) {
      // Do not leave the poll behind with no proposal attached to it.
      if (pollId) {
        const { error: rollbackErr } = await db.from('polls_v2').delete().eq('id', pollId);
        if (rollbackErr) {
          console.error(`[collaboration] could not roll back poll ${pollId} after proposal insert failed:`, rollbackErr.message);
        }
      }
      return err(error.message, 500);
    }
    await writeActivity({
      tripId,
      actorMemberId: member.id,
      verb: 'proposed',
      targetType: 'proposal',
      targetId: proposalId,
      targetTitle: note ?? proposalId,
      summary: `${member.display_name} proposed a change`
    });
    return json(proposal, 201);
  }
  // POST /proposals/:id/approve
  const approveMatch = path.match(/^\/proposals\/([^/]+)\/approve$/);
  if (method === 'POST' && approveMatch) {
    const proposalId = approveMatch[1];
    const body = await req.json().catch(()=>null);
    if (!body || typeof body !== 'object') return err('Invalid JSON body', 400);
    const { tripId } = body;
    if (!tripId) return err('Missing tripId', 400);
    const gate = await requireMember(tripId, userId);
    if ('deny' in gate) return gate.deny;
    const member = gate.member;
    if (!hasPermission(member, 'trip.update')) return err('Forbidden', 403);
    const db = svc();
    const { data: proposal, error: proposalErr } = await db.from('change_proposals').select('*').eq('id', proposalId).eq('trip_id', tripId).maybeSingle();
    if (proposalErr) return err(proposalErr.message, 500, 'PROPOSAL_LOOKUP_FAILED');
    if (!proposal) return err('Proposal not found', 404);
    if (proposal.status && proposal.status !== 'open') {
      return err(`Proposal is already ${proposal.status}`, 409, 'PROPOSAL_NOT_OPEN');
    }
    // DEFECT 2026-09-19 (failure looks like success) — the loop below was
    //     await db.from('itinerary_items').update(op.patch).eq('id', op.itemId);
    // with no error capture, and the proposal was then marked 'approved'
    // unconditionally. `ops` is caller-supplied jsonb, so a patch naming a
    // column that does not exist on itinerary_items is rejected with 42703,
    // and a patch aimed at a deleted item updates zero rows without erroring.
    // In both cases the proposer and the organiser saw "approved" on a
    // proposal none of whose changes had been made. Every op is now checked,
    // and the proposal is only marked approved if all of them actually landed.
    const ops = proposal.ops;
    const failures = [];
    let applied = 0;
    if (Array.isArray(ops)) {
      for (const op of ops){
        if (!op?.itemId || !op?.patch) {
          failures.push({
            itemId: String(op?.itemId ?? '?'),
            reason: 'op is missing itemId or patch'
          });
          continue;
        }
        const { data: touched, error: opErr } = await db.from('itinerary_items').update(op.patch).eq('id', op.itemId).eq('trip_id', tripId).select('id');
        if (opErr) {
          failures.push({
            itemId: op.itemId,
            reason: opErr.message
          });
        } else if (!touched || touched.length === 0) {
          failures.push({
            itemId: op.itemId,
            reason: 'no such item on this trip'
          });
        } else {
          applied += touched.length;
        }
      }
    }
    if (failures.length) {
      return json({
        error: 'The proposal was not approved because some of its changes could not be applied',
        code: 'PROPOSAL_APPLY_FAILED',
        appliedCount: applied,
        failures
      }, 409);
    }
    const { data: decided, error: decideErr } = await db.from('change_proposals').update({
      status: 'approved',
      decided_at: new Date().toISOString(),
      decided_by: member.id
    }).eq('id', proposalId).eq('trip_id', tripId).select('id');
    if (decideErr) return err(decideErr.message, 500);
    if (!decided || decided.length === 0) {
      return err('The proposal could not be marked approved', 500, 'PROPOSAL_DECIDE_FAILED');
    }
    await writeActivity({
      tripId,
      actorMemberId: member.id,
      verb: 'approved',
      targetType: 'proposal',
      targetId: proposalId,
      targetTitle: proposal.note ?? proposalId,
      summary: `${member.display_name} approved a change proposal`
    });
    return json({
      success: true,
      appliedCount: applied
    });
  }
  // POST /proposals/:id/reject
  const rejectMatch = path.match(/^\/proposals\/([^/]+)\/reject$/);
  if (method === 'POST' && rejectMatch) {
    const proposalId = rejectMatch[1];
    const body = await req.json().catch(()=>null);
    if (!body || typeof body !== 'object') return err('Invalid JSON body', 400);
    const { tripId, reason } = body;
    if (!tripId) return err('Missing tripId', 400);
    const gate = await requireMember(tripId, userId);
    if ('deny' in gate) return gate.deny;
    const member = gate.member;
    if (!hasPermission(member, 'trip.update')) return err('Forbidden', 403);
    const db = svc();
    const { data: proposal, error: proposalErr } = await db.from('change_proposals').select('*').eq('id', proposalId).eq('trip_id', tripId).maybeSingle();
    if (proposalErr) return err(proposalErr.message, 500, 'PROPOSAL_LOOKUP_FAILED');
    if (!proposal) return err('Proposal not found', 404);
    // DEFECT 2026-09-19 (failure looks like success) — the status update's
    // error was discarded and { success: true } returned regardless, so a
    // proposal could be reported rejected and still be sitting open.
    const { data: decided, error: decideErr } = await db.from('change_proposals').update({
      status: 'rejected',
      decided_at: new Date().toISOString(),
      decided_by: member.id
    }).eq('id', proposalId).eq('trip_id', tripId).select('id');
    if (decideErr) return err(decideErr.message, 500);
    if (!decided || decided.length === 0) {
      return err('The proposal could not be marked rejected', 500, 'PROPOSAL_DECIDE_FAILED');
    }
    await writeActivity({
      tripId,
      actorMemberId: member.id,
      verb: 'rejected',
      targetType: 'proposal',
      targetId: proposalId,
      targetTitle: proposal.note ?? proposalId,
      summary: `${member.display_name} rejected a change proposal${reason ? `: ${reason}` : ''}`
    });
    return json({
      success: true
    });
  }
  // POST /proposals/:id/withdraw
  const withdrawMatch = path.match(/^\/proposals\/([^/]+)\/withdraw$/);
  if (method === 'POST' && withdrawMatch) {
    const proposalId = withdrawMatch[1];
    const body = await req.json().catch(()=>null);
    if (!body || typeof body !== 'object') return err('Invalid JSON body', 400);
    const { tripId } = body;
    if (!tripId) return err('Missing tripId', 400);
    const gate = await requireMember(tripId, userId);
    if ('deny' in gate) return gate.deny;
    const member = gate.member;
    const db = svc();
    const { data: proposal, error: proposalErr } = await db.from('change_proposals').select('*').eq('id', proposalId).eq('trip_id', tripId).maybeSingle();
    if (proposalErr) return err(proposalErr.message, 500, 'PROPOSAL_LOOKUP_FAILED');
    if (!proposal) return err('Proposal not found', 404);
    if (proposal.proposer_member_id !== member.id) return err('Forbidden', 403);
    const { data: withdrawn, error: withdrawErr } = await db.from('change_proposals').update({
      status: 'withdrawn'
    }).eq('id', proposalId).eq('trip_id', tripId).select('id');
    if (withdrawErr) return err(withdrawErr.message, 500);
    if (!withdrawn || withdrawn.length === 0) {
      return err('The proposal could not be withdrawn', 500, 'PROPOSAL_DECIDE_FAILED');
    }
    return json({
      success: true
    });
  }
  // GET /decisions
  if (method === 'GET' && path === '/decisions') {
    const tripId = url.searchParams.get('tripId');
    const cursor = url.searchParams.get('cursor');
    const limit = 50;
    if (!tripId) return err('Missing tripId', 400);
    const gate = await requireMember(tripId, userId);
    if ('deny' in gate) return gate.deny;
    const db = svc();
    // DEFECT 2026-09-19 (schema mismatch) — the poll half of this route read:
    //     .in('status', ['closed', 'decided'])
    //     .order('updated_at', { ascending: false })
    //     ... and the cursor applied .lt('updated_at', cursor)
    // polls_v2 has NO `updated_at` column, so PostgREST rejected the entire
    // query with 42703; the error was discarded via `const { data: polls }`
    // and the route carried on with polls == null. Every decision log this
    // function has ever served contained change proposals only — no poll has
    // ever appeared in it, on any trip. ('decided' is also not one of the
    // statuses polls_v2 allows: the CHECK is open|closed|cancelled.)
    //
    // The mapping below was reading p.outcome, p.participation,
    // p.tie_break_step, p.explanation and p.affected_item_ids, none of which
    // are columns either; under select('*') they simply arrived undefined and
    // were emitted as null, so the UI's "how was this decided" fields were
    // permanently blank. They now come from polls_v2.result, the jsonb the
    // tally is actually written to, and anything the tally did not record is
    // reported as absent rather than invented.
    let pollQuery = db.from('polls_v2').select('id, question, strategy, status, result, closes_at, closed_at, created_at').eq('trip_id', tripId).eq('status', 'closed').order('closed_at', {
      ascending: false,
      nullsFirst: false
    }).limit(limit);
    if (cursor) pollQuery = pollQuery.lt('closed_at', cursor);
    const { data: polls, error: pollErr } = await pollQuery;
    if (pollErr) return err(pollErr.message, 500, 'DECISIONS_READ_FAILED');
    let propQuery = db.from('change_proposals').select('*').eq('trip_id', tripId).in('status', [
      'approved',
      'rejected'
    ]).order('decided_at', {
      ascending: false,
      nullsFirst: false
    }).limit(limit);
    if (cursor) propQuery = propQuery.lt('decided_at', cursor);
    const { data: proposals, error: propErr } = await propQuery;
    // DEFECT 2026-09-19 (discarded error) — same treatment: a failed proposal
    // read produced an empty decision log rather than an error.
    if (propErr) return err(propErr.message, 500, 'DECISIONS_READ_FAILED');
    const pollDecisions = (polls ?? []).map((p)=>{
      const result = p.result ?? null;
      return {
        kind: 'poll',
        id: p.id,
        question: p.question,
        outcome: result?.outcome ?? result?.winner ?? null,
        strategy: p.strategy,
        participation: result?.participation ?? null,
        tieBreakStep: result?.tie_break_step ?? null,
        explanation: result?.explanation ?? null,
        affectedItemIds: result?.affected_item_ids ?? [],
        decidedAt: p.closed_at ?? null
      };
    });
    const proposalDecisions = (proposals ?? []).map((p)=>({
        kind: 'proposal',
        id: p.id,
        question: p.note ?? p.id,
        outcome: p.status,
        strategy: null,
        participation: null,
        tieBreakStep: null,
        explanation: null,
        affectedItemIds: [],
        decidedAt: p.decided_at
      }));
    const all = [
      ...pollDecisions,
      ...proposalDecisions
    ].sort((a, b)=>{
      const aTime = a.decidedAt ? new Date(a.decidedAt).getTime() : 0;
      const bTime = b.decidedAt ? new Date(b.decidedAt).getTime() : 0;
      return bTime - aTime;
    });
    const page = all.slice(0, limit);
    const nextCursor = all.length > limit ? page[page.length - 1].decidedAt : null;
    return json({
      decisions: page,
      nextCursor
    });
  }
  return err('Not found', 404);
});

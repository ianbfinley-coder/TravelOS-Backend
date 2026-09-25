import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { requireUser, serviceClient, json, fail, corsHeaders } from './_shared/auth.ts';
// SECURITY 2026-09-16 — three actions had no group-membership check at all.
//
// Every other action in this file called verifyMember(groupId) before
// touching the database. toggle_reaction, set_typing and get_typing did not:
//
//   - toggle_reaction took messageId/emoji straight from the body and wrote
//     to message_reactions with no check that the message existed or that
//     the caller belonged to its group. Any signed-in caller could add or
//     remove a reaction on any message in any group.
//   - set_typing took groupId straight from the body and upserted a
//     typing_indicators row with no membership check. Any signed-in caller
//     could broadcast a typing indicator into any group's chat.
//   - get_typing had the same hole on the read side: any signed-in caller
//     could list who is typing in any group.
//
// Fix: a single requireGroupMember(groupId) helper, modelled on the one in
// expense-tracking (group_members filtered on group_id + the caller's
// verified uuid + status = 'active', 404 rather than 403 when there is no
// row, so a caller can't tell a real group id from a fake one), is now
// called at the top of every action, including these three. edit_message
// previously checked only message authorship with no group check at all, so
// a member removed from the group could still edit a message they wrote
// before removal; it now also requires active membership in the message's
// group. No action reads an identity from the request body for write
// attribution — every insert/update uses the verified caller id (userId),
// never a body-supplied user id.
function generateId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
serve(async (req)=>{
  if (req.method === 'OPTIONS') return new Response('ok', {
    headers: corsHeaders
  });
  try {
    const caller = await requireUser(req);
    if (caller instanceof Response) return caller;
    const userId = caller.userId;
    const service = serviceClient();
    let body;
    try {
      body = await req.json();
    } catch  {
      return fail('invalid_json', 400);
    }
    const { action } = body;
    // Helper: get caller's display name IN THIS GROUP.
    //
    // DEFECT 2026-09-19 — this was
    //   .from('group_members').select('display_name, email')
    //     .eq('user_id', userId).limit(1).single()
    // with no group filter at all. A user who belongs to several trip groups
    // got whichever row the database happened to return first, so a message
    // sent to one group could be stamped with the display name they use in a
    // different one. And `.single()` raises PGRST116 when the user has no
    // group_members row; the error was discarded and the author was recorded
    // as the literal string 'Unknown'. Scoped to the group, and a name we
    // cannot determine is now reported rather than replaced with a placeholder.
    async function getDisplayName(groupId) {
      const { data: member, error } = await service.from('group_members').select('display_name, email').eq('group_id', groupId).eq('user_id', userId).eq('status', 'active').maybeSingle();
      if (error) {
        console.error('[group-chat] display name lookup failed:', error.code, error.message);
        return null;
      }
      return member?.display_name || member?.email?.split('@')[0] || null;
    }
    /** Caller's active membership row for a group, or a 404 Response. */ async function requireGroupMember(groupId) {
      if (!groupId) return fail('groupId is required', 400);
      // DEFECT 2026-09-19 — the error was discarded, so a failed read told a
      // genuine member they were not in the group.
      const { data, error } = await service.from('group_members').select('role').eq('group_id', groupId).eq('user_id', userId).eq('status', 'active').maybeSingle();
      if (error) {
        console.error('[group-chat] membership check failed:', error.code, error.message);
        return fail('Failed to check group membership', 500);
      }
      if (!data) return fail('Not an active group member', 404);
      return {
        role: data.role
      };
    }
    /**
     * Loads a message and the group it belongs to, keeping a failed lookup
     * distinct from a message that does not exist. Previously every one of
     * these was `const { data: existing } = ...` and a broken query surfaced
     * to the user as "Message not found".
     */ async function loadMessage(messageId, columns, liveOnly = false) {
      if (!messageId) return fail('messageId is required', 400);
      let q = service.from('group_messages').select(columns).eq('id', messageId);
      if (liveOnly) q = q.is('deleted_at', null);
      const { data, error } = await q.maybeSingle();
      if (error) {
        console.error('[group-chat] message lookup failed:', error.code, error.message);
        return fail('Failed to load message', 500);
      }
      if (!data) return fail('Message not found', 404);
      return data;
    }
    // ── send_message ──────────────────────────────────────────────
    if (action === 'send_message') {
      const { groupId, content, type = 'message', attachments } = body;
      if (!groupId || !content?.trim()) return fail('groupId and content required', 400);
      const member = await requireGroupMember(groupId);
      if (member instanceof Response) return member;
      // Announcements require organizer/planner
      if (type === 'announcement' && ![
        'organizer',
        'planner'
      ].includes(member.role)) {
        return fail('Only organizer or planner can send announcements', 403);
      }
      const displayName = await getDisplayName(groupId);
      const msgId = generateId('msg');
      const { data: message, error: mErr } = await service.from('group_messages').insert({
        id: msgId,
        group_id: groupId,
        user_id: userId,
        display_name: displayName,
        content: content.trim(),
        type,
        version: 1
      }).select().single();
      if (mErr) throw mErr;
      // Insert attachments if provided.
      //
      // DEFECT 2026-09-19 — this insert's error was discarded and the response
      // echoed `attachments: attachments || []` from the REQUEST, so a failed
      // write showed the sender their attachments on the message while nothing
      // had been stored; they vanished for everyone on the next load.
      let attachmentsStored = null;
      if (attachments?.length) {
        const { error: attErr } = await service.from('message_attachments').insert(attachments.map((a)=>({
            message_id: msgId,
            filename: a.filename,
            url: a.url,
            mime_type: a.mimeType,
            size_bytes: a.size
          })));
        if (attErr) {
          console.error('[group-chat] message_attachments insert failed:', attErr.code, attErr.message);
        }
        attachmentsStored = !attErr;
      }
      return json({
        message: {
          ...message,
          reactions: {},
          attachments: attachmentsStored === false ? [] : attachments || []
        },
        attachments_stored: attachmentsStored,
        display_name_resolved: displayName !== null
      });
    }
    // ── get_messages ──────────────────────────────────────────────
    if (action === 'get_messages') {
      const { groupId, limit = 50, offset = 0, since, search } = body;
      const member = await requireGroupMember(groupId);
      if (member instanceof Response) return member;
      let query = service.from('group_messages').select(`*, message_reactions(emoji, user_id), message_attachments(*)`).eq('group_id', groupId).is('deleted_at', null);
      if (since) query = query.gt('created_at', since);
      if (search) query = query.ilike('content', `%${search}%`);
      const { data, error } = await query.order('created_at', {
        ascending: false
      }).range(offset, offset + limit - 1);
      if (error) throw error;
      // Transform reactions into Record<emoji, userId[]>
      const messages = (data || []).reverse().map((msg)=>{
        const reactions = {};
        for (const r of msg.message_reactions || []){
          if (!reactions[r.emoji]) reactions[r.emoji] = [];
          reactions[r.emoji].push(r.user_id);
        }
        return {
          ...msg,
          reactions,
          message_reactions: undefined
        };
      });
      return json({
        messages,
        hasMore: (data || []).length === limit
      });
    }
    // ── get_pinned ────────────────────────────────────────────────
    if (action === 'get_pinned') {
      const { groupId } = body;
      const member = await requireGroupMember(groupId);
      if (member instanceof Response) return member;
      const { data, error } = await service.from('group_messages').select(`*, message_reactions(emoji, user_id)`).eq('group_id', groupId).eq('pinned', true).is('deleted_at', null).order('pinned_at', {
        ascending: false
      });
      if (error) throw error;
      const messages = (data || []).map((msg)=>{
        const reactions = {};
        for (const r of msg.message_reactions || []){
          if (!reactions[r.emoji]) reactions[r.emoji] = [];
          reactions[r.emoji].push(r.user_id);
        }
        return {
          ...msg,
          reactions,
          message_reactions: undefined
        };
      });
      return json({
        messages
      });
    }
    // ── edit_message ──────────────────────────────────────────────
    if (action === 'edit_message') {
      const { messageId, content } = body;
      if (!content?.trim()) return fail('content required', 400);
      const existing = await loadMessage(messageId, 'user_id, group_id, version');
      if (existing instanceof Response) return existing;
      // Only author can edit
      if (existing.user_id !== userId) return fail('Only author can edit message', 403);
      // Author must still be an active member of the group.
      const member = await requireGroupMember(existing.group_id);
      if (member instanceof Response) return member;
      // The version filter makes this a compare-and-set: two concurrent edits
      // can no longer silently overwrite one another at the same version number.
      const { data, error } = await service.from('group_messages').update({
        content: content.trim(),
        edited_at: new Date().toISOString(),
        version: (existing.version || 1) + 1
      }).eq('id', messageId).eq('version', existing.version || 1).select().maybeSingle();
      if (error) throw error;
      if (!data) return fail('Message was edited by someone else; reload and try again', 409);
      return json({
        message: data
      });
    }
    // ── delete_message ────────────────────────────────────────────
    if (action === 'delete_message') {
      const { messageId } = body;
      const existing = await loadMessage(messageId, 'user_id, group_id');
      if (existing instanceof Response) return existing;
      const member = await requireGroupMember(existing.group_id);
      if (member instanceof Response) return member;
      if (existing.user_id !== userId && member.role !== 'organizer') {
        return fail('Only author or organizer can delete', 403);
      }
      // DEFECT 2026-09-19 — the error was discarded and `{ deleted: true }`
      // returned regardless, so a failed delete left the message visible to the
      // whole group while the person who deleted it believed it was gone.
      const { data: deleted, error: delErr } = await service.from('group_messages').update({
        deleted_at: new Date().toISOString()
      }).eq('id', messageId).is('deleted_at', null).select('id');
      if (delErr) {
        console.error('[group-chat] message delete failed:', delErr.code, delErr.message);
        return fail(`Failed to delete message: ${delErr.message}`, 500);
      }
      if (!deleted || deleted.length === 0) {
        return fail('Message not found or already deleted', 404);
      }
      return json({
        deleted: true
      });
    }
    // ── pin_message ───────────────────────────────────────────────
    if (action === 'pin_message') {
      const { messageId, unpin = false } = body;
      const existing = await loadMessage(messageId, 'group_id');
      if (existing instanceof Response) return existing;
      const member = await requireGroupMember(existing.group_id);
      if (member instanceof Response) return member;
      if (![
        'organizer',
        'planner'
      ].includes(member.role)) {
        return fail('Only organizer or planner can pin messages', 403);
      }
      const updates = unpin ? {
        pinned: false,
        pinned_by: null,
        pinned_at: null
      } : {
        pinned: true,
        pinned_by: userId,
        pinned_at: new Date().toISOString()
      };
      const { data, error } = await service.from('group_messages').update(updates).eq('id', messageId).select().single();
      if (error) throw error;
      return json({
        message: data
      });
    }
    // ── toggle_reaction ────────────────────────────────────────────
    if (action === 'toggle_reaction') {
      const { messageId, emoji } = body;
      if (!emoji) return fail('emoji required', 400);
      const existingMessage = await loadMessage(messageId, 'group_id', true);
      if (existingMessage instanceof Response) return existingMessage;
      const member = await requireGroupMember(existingMessage.group_id);
      if (member instanceof Response) return member;
      // Check if reaction exists
      const { data: existing, error: existingErr } = await service.from('message_reactions').select('id').eq('message_id', messageId).eq('user_id', userId).eq('emoji', emoji).maybeSingle();
      if (existingErr) {
        console.error('[group-chat] reaction lookup failed:', existingErr.code, existingErr.message);
        return fail('Failed to check the existing reaction', 500);
      }
      // DEFECT 2026-09-19 — neither the insert nor the delete checked its error,
      // so `{ added: true }` / `{ added: false }` was returned whatever happened
      // and the client's optimistic reaction state drifted out of step with the
      // database until the next full reload.
      if (existing) {
        const { error: delErr } = await service.from('message_reactions').delete().eq('message_id', messageId).eq('user_id', userId).eq('emoji', emoji);
        if (delErr) {
          console.error('[group-chat] reaction delete failed:', delErr.code, delErr.message);
          return fail(`Failed to remove reaction: ${delErr.message}`, 500);
        }
        return json({
          added: false,
          emoji
        });
      } else {
        const { error: insErr } = await service.from('message_reactions').insert({
          message_id: messageId,
          user_id: userId,
          emoji
        });
        if (insErr) {
          console.error('[group-chat] reaction insert failed:', insErr.code, insErr.message);
          return fail(`Failed to add reaction: ${insErr.message}`, 500);
        }
        return json({
          added: true,
          emoji
        });
      }
    }
    // ── set_typing ────────────────────────────────────────────────
    if (action === 'set_typing') {
      const { groupId, isTyping } = body;
      const member = await requireGroupMember(groupId);
      if (member instanceof Response) return member;
      let typingError = null;
      if (isTyping) {
        const displayName = await getDisplayName(groupId);
        const { error } = await service.from('typing_indicators').upsert({
          group_id: groupId,
          user_id: userId,
          display_name: displayName,
          updated_at: new Date().toISOString()
        }, {
          onConflict: 'group_id,user_id'
        });
        if (error) {
          console.error('[group-chat] typing upsert failed:', error.code, error.message);
          typingError = error.message;
        }
      } else {
        const { error } = await service.from('typing_indicators').delete().eq('group_id', groupId).eq('user_id', userId);
        if (error) {
          console.error('[group-chat] typing delete failed:', error.code, error.message);
          typingError = error.message;
        }
      }
      // Previously always `{ ok: true }`.
      return json({
        ok: !typingError,
        error: typingError
      });
    }
    // ── get_typing ────────────────────────────────────────────────
    if (action === 'get_typing') {
      const { groupId } = body;
      const member = await requireGroupMember(groupId);
      if (member instanceof Response) return member;
      // Only return indicators updated in last 5 seconds
      const cutoff = new Date(Date.now() - 5000).toISOString();
      const { data, error } = await service.from('typing_indicators').select('user_id, display_name').eq('group_id', groupId).gt('updated_at', cutoff).neq('user_id', userId);
      // Previously discarded: a failed read rendered as "nobody is typing".
      if (error) {
        console.error('[group-chat] typing read failed:', error.code, error.message);
        return fail('Failed to load typing indicators', 500);
      }
      return json({
        typing: (data || []).map((t)=>({
            userId: t.user_id,
            displayName: t.display_name
          }))
      });
    }
    // ── search_messages ────────────────────────────────────────────
    if (action === 'search_messages') {
      const { groupId, query: searchQuery, limit = 20 } = body;
      if (!searchQuery?.trim()) return json({
        messages: []
      });
      const member = await requireGroupMember(groupId);
      if (member instanceof Response) return member;
      const { data, error } = await service.from('group_messages').select('id, content, display_name, type, created_at, pinned').eq('group_id', groupId).is('deleted_at', null).ilike('content', `%${searchQuery.trim()}%`).order('created_at', {
        ascending: false
      }).limit(limit);
      if (error) throw error;
      return json({
        messages: data || []
      });
    }
    return fail('Unknown action', 400);
  } catch (e) {
    console.error('[group-chat] unhandled:', e instanceof Error ? e.message : String(e));
    return fail('Internal server error', 500);
  }
});

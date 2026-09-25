import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { requireUser, resolvePlatformUserId, serviceClient, json, fail, corsHeaders } from './_shared/auth.ts';
// SECURITY 2026-09-16 — group-management read every table through a client
// authenticated as the caller (the anon key with the caller's Authorization
// header forwarded), with row access "clamped" only by whatever RLS policy
// exists on trip_groups / group_members. verify_jwt is false on this
// function, and RLS is not something this codebase can rely on as the only
// gate (see expense-tracking's fix, same day). Moving onto the shared
// service-role client removes that RLS clamp entirely, so every read below
// now carries its own explicit, in-code check:
//
//   - get_groups: with no tripId the query was `select * from trip_groups`
//     with NO filter at all — every group on the platform, every trip,
//     every member roster, to any signed-in caller. Now scoped to the
//     groups the caller has an active group_members row in.
//   - get_group: took an arbitrary groupId with no membership check — a
//     plain IDOR returning a group's full roster and every member's
//     preferences to any signed-in caller who knew or guessed the id. Now
//     requires active membership, and returns 404 (not 403) otherwise, so a
//     caller can't use the response to tell a real group id from a fake one.
//   - invite_member, remove_member, change_role, and get_preferences
//     (reading someone else's) all checked the caller's role in
//     group_members WITHOUT `status = 'active'`. A member removed from the
//     group (row kept, status changed off 'active') who had been organizer
//     or planner kept those powers indefinitely. All four now go through
//     the same active-membership check.
//   - update_preferences previously upserted a preferences row for any
//     groupId the caller supplied, with no check they belonged to that
//     group at all. Now requires active membership first.
//   - check_permission had the same missing status filter. Fixed in place
//     with the same eq('status','active') rather than switched to the 404
//     helper, because {allowed:false, role:null} for a non-member is this
//     action's existing, intentional contract.
//
// No write in this file takes its actor's identity from the request body —
// every insert/update that records "who did this" uses the verified caller
// id (userId), and remove_member/change_role/invite_member's target user is
// always a value an already-authorized caller (organizer/planner) is
// choosing to act on, not an identity they're acting AS.
//
// SECURITY 2026-09-17 — create_group accepted an arbitrary tripId from the
// request body with no check that the caller had any relationship to that
// trip. Every other action here is gated by requireGroupMember, but no
// group exists yet at this point, so membership is the wrong check — this
// needed to be a TRIP-membership check instead.
//
// CORRECTION 2026-09-19 — the note that stood here previously argued at
// length that `trip_groups.trip_id` is TEXT and therefore lives in the
// platform id space pointing at `platform_trips.id`. That is wrong, and the
// reasoning was wrong too. Checked against information_schema:
//
//     trip_groups.trip_id    uuid          trip_groups.id     text
//     trip_members.trip_id   uuid          trip_members.id    text
//     trips.id               uuid          trip_members.user_id  text
//
// The TEXT column on both tables is `id` (and, on trip_members, `user_id`) —
// not `trip_id`. Both trip_id columns are uuid, in the same id space as
// trips.id. The membership check below happens to be correct anyway, because
// it compares tripId against trip_members.trip_id (uuid to uuid) and the
// resolved platform user id against trip_members.user_id (text to text), but
// a future reader acting on the old note would have introduced a 22P02 by
// "fixing" trip_id to the text space. The identity split in this schema is on
// the USER axis, not the trip axis.
//
// The check: resolve the caller's auth uid to a platform_users.id via
// resolvePlatformUserId, then require a `trip_members` row for that
// platform user id and this tripId with `removed_at is null` (trip_members
// has no status column — removal is tracked by that timestamp). No match —
// including a caller with no platform identity at all — returns 404, not
// 403, so a tripId can't be enumerated by the error code. This runs before
// the group or its organizer membership row is created.
const ROLE_PERMISSIONS = {
  organizer: [
    'view_trip',
    'edit_itinerary',
    'add_reservation',
    'remove_reservation',
    'modify_reservation',
    'manage_members',
    'create_poll',
    'vote_poll',
    'view_expenses',
    'add_expense',
    'split_expense',
    'manage_group'
  ],
  planner: [
    'view_trip',
    'edit_itinerary',
    'add_reservation',
    'remove_reservation',
    'modify_reservation',
    'create_poll',
    'vote_poll',
    'view_expenses',
    'add_expense',
    'split_expense'
  ],
  participant: [
    'view_trip',
    'vote_poll',
    'view_expenses',
    'add_expense'
  ],
  viewer: [
    'view_trip',
    'view_expenses'
  ]
};
// group_members_role_check permits exactly these. An unrecognised role used to
// be written straight through: the insert/update failed with 23514, the error
// was discarded, and the caller got HTTP 200 with `{"member": undefined}` — a
// role change that silently did not happen.
const VALID_ROLES = Object.keys(ROLE_PERMISSIONS);
// member_preferences CHECK constraints. Used to reject bad input up front
// rather than let a 23514 be swallowed.
const PREFERENCE_DOMAINS = {
  pace: [
    'slow',
    'moderate',
    'fast'
  ],
  budget: [
    'budget',
    'moderate',
    'luxury'
  ],
  mobility: [
    'none',
    'limited',
    'wheelchair'
  ]
};
function generateToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16))).map((b)=>b.toString(16).padStart(2, '0')).join('');
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
    // Lazily fetches the full auth user (email, user_metadata) via the
    // caller's own session, for display-name / email defaults. Consolidates
    // what used to be two separate auth.getUser() calls (one at the top,
    // one duplicated inside create_group) into one, fetched only when needed.
    let fullUser = null;
    async function getCallerUser() {
      if (!fullUser) {
        const { data } = await caller.client.auth.getUser();
        fullUser = data.user;
      }
      return fullUser;
    }
    let body;
    try {
      body = await req.json();
    } catch  {
      return fail('invalid_json', 400);
    }
    const { action } = body;
    /** Caller's active membership row for a group, or a 404/500 Response. */ async function requireGroupMember(groupId) {
      if (!groupId) return fail('groupId is required', 400);
      // DEFECT 2026-09-19 — the error was discarded, so a failed membership
      // read told an actual member "Group not found".
      const { data, error } = await service.from('group_members').select('role').eq('group_id', groupId).eq('user_id', userId).eq('status', 'active').maybeSingle();
      if (error) {
        console.error('[group-management] membership check failed:', error.code, error.message);
        return fail('Failed to check group membership', 500);
      }
      if (!data) return fail('Group not found', 404);
      return {
        role: data.role
      };
    }
    /**
     * Confirms the caller is a current member of the trip. See the CORRECTION
     * note above: trip_members.trip_id is uuid (same space as trips.id) and
     * trip_members.user_id is the platform TEXT id, hence the bridge.
     */ async function requireTripMembership(tripId) {
      if (!tripId) return fail('tripId is required', 400);
      const platformUserId = await resolvePlatformUserId(service, userId);
      if (!platformUserId) return fail('Trip not found', 404);
      const { data, error } = await service.from('trip_members').select('id').eq('trip_id', tripId).eq('user_id', platformUserId).is('removed_at', null).maybeSingle();
      if (error) {
        console.error('[group-management] trip membership check failed:', error.code, error.message);
        return fail('Failed to check trip membership', 500);
      }
      if (!data) return fail('Trip not found', 404);
      return true;
    }
    // ── create_group ────────────────────────────────────────────────
    if (action === 'create_group') {
      const { tripId, name, description } = body;
      if (!tripId || !name) return fail('tripId and name required', 400);
      const membership = await requireTripMembership(tripId);
      if (membership instanceof Response) return membership;
      const groupId = `group_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const { data: group, error: gErr } = await service.from('trip_groups').insert({
        id: groupId,
        trip_id: tripId,
        name,
        description,
        created_by: userId
      }).select().single();
      if (gErr) throw gErr;
      const user = await getCallerUser();
      // Add creator as organizer.
      //
      // DEFECT 2026-09-19 — this insert's error was discarded. When it failed
      // the group row still existed and `{ group }` was returned as success,
      // but the group had NO members at all — and since every other action
      // here requires an active group_members row, the person who had just
      // created it was locked out of their own group with no way back in. The
      // orphaned group is now cleaned up and the failure reported.
      const { error: memberErr } = await service.from('group_members').insert({
        group_id: groupId,
        user_id: userId,
        email: user?.email || '',
        display_name: user?.user_metadata?.full_name || user?.email?.split('@')[0] || 'Organizer',
        role: 'organizer',
        status: 'active',
        joined_at: new Date().toISOString()
      });
      if (memberErr) {
        console.error('[group-management] organizer membership insert failed:', memberErr.code, memberErr.message);
        await service.from('trip_groups').delete().eq('id', groupId);
        return fail(`Failed to create group: could not add you as organizer (${memberErr.message})`, 500);
      }
      // DEFECT 2026-09-19 (fabricated data) — this used to insert a
      // member_preferences row with `timezone: 'UTC'`, asserting that the
      // organizer is in UTC. Nobody said that. A member with no stated
      // preferences should have no preferences row, so get_preferences can say
      // "not set" instead of reporting invented ones. No row is created here
      // any more.
      return json({
        group
      });
    }
    // ── get_groups ────────────────────────────────────────────────
    if (action === 'get_groups') {
      const { tripId } = body;
      // Scope to groups the caller is an active member of. Previously this
      // ran with no filter at all when tripId was omitted.
      //
      // DEFECT 2026-09-19 — the error was discarded, so a failed membership
      // read produced an empty groupIds array and this returned
      // `{ groups: [] }` with HTTP 200: the user was shown that they belong to
      // no groups at all, which is indistinguishable from the truth.
      const { data: myMemberships, error: membershipErr } = await service.from('group_members').select('group_id').eq('user_id', userId).eq('status', 'active');
      if (membershipErr) {
        console.error('[group-management] get_groups membership read failed:', membershipErr.code, membershipErr.message);
        return fail('Failed to load your groups', 500);
      }
      const groupIds = (myMemberships || []).map((m)=>m.group_id);
      if (groupIds.length === 0) return json({
        groups: []
      });
      let query = service.from('trip_groups').select(`
        *,
        group_members(*)
      `).in('id', groupIds);
      if (tripId) query = query.eq('trip_id', tripId);
      const { data, error } = await query.order('created_at', {
        ascending: false
      });
      if (error) throw error;
      return json({
        groups: data || []
      });
    }
    // ── get_group ─────────────────────────────────────────────────
    if (action === 'get_group') {
      const { groupId } = body;
      const member = await requireGroupMember(groupId);
      if (member instanceof Response) return member;
      const { data, error } = await service.from('trip_groups').select(`*, group_members(*, member_preferences(*))`).eq('id', groupId).maybeSingle();
      if (error) throw error;
      if (!data) return fail('Group not found', 404);
      return json({
        group: data
      });
    }
    // ── invite_member ─────────────────────────────────────────────
    if (action === 'invite_member') {
      const { groupId, email, role = 'participant' } = body;
      if (!email) return fail('email is required', 400);
      if (!VALID_ROLES.includes(role)) {
        return fail(`role must be one of ${VALID_ROLES.join(', ')}`, 400);
      }
      // Check caller is organizer or planner
      const callerMember = await requireGroupMember(groupId);
      if (callerMember instanceof Response) return callerMember;
      if (![
        'organizer',
        'planner'
      ].includes(callerMember.role)) {
        return fail('Only organizer or planner can invite members', 403);
      }
      // Check not already a member.
      //
      // DEFECT 2026-09-19 — `.single()` with the error discarded. When no row
      // existed this raised PGRST116, which was thrown away, and the code read
      // `existing` as undefined — accidentally correct. But a genuine query
      // failure produced the same undefined and led to an INSERT that then
      // collided with UNIQUE(group_id, email).
      const { data: existing, error: existingErr } = await service.from('group_members').select('id, status').eq('group_id', groupId).eq('email', email).maybeSingle();
      if (existingErr) {
        console.error('[group-management] existing member lookup failed:', existingErr.code, existingErr.message);
        return fail('Failed to check existing membership', 500);
      }
      if (existing && existing.status === 'active') {
        return fail('User is already an active member', 409);
      }
      const inviteToken = generateToken();
      const inviteExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      // DEFECT 2026-09-19 — both branches discarded their error, so a failed
      // write returned HTTP 200 with `{"member": undefined, inviteToken}` AND
      // still sent the invitation email, handing the recipient a token that was
      // never stored and could never be accepted.
      let member;
      if (existing) {
        // Re-invite declined member
        const { data, error } = await service.from('group_members').update({
          role,
          status: 'invited',
          invite_token: inviteToken,
          invite_expires_at: inviteExpiry
        }).eq('id', existing.id).select().single();
        if (error || !data) {
          console.error('[group-management] re-invite update failed:', error?.code, error?.message);
          return fail(`Failed to re-invite member: ${error?.message ?? 'no row updated'}`, 500);
        }
        member = data;
      } else {
        const { data, error } = await service.from('group_members').insert({
          group_id: groupId,
          email,
          role,
          status: 'invited',
          invite_token: inviteToken,
          invite_expires_at: inviteExpiry
        }).select().single();
        if (error || !data) {
          console.error('[group-management] invite insert failed:', error?.code, error?.message);
          return fail(`Failed to invite member: ${error?.message ?? 'no row inserted'}`, 500);
        }
        member = data;
      }
      // Get group name for email
      const { data: group } = await service.from('trip_groups').select('name').eq('id', groupId).maybeSingle();
      // Send invitation email via SendGrid if SENDGRID_API_KEY is set.
      //
      // DEFECT 2026-09-19 — two problems, and together they made invitation
      // email a silently dead feature:
      //   1. The payload was malformed. SendGrid v3 requires recipients under
      //      `personalizations: [{ to: [...] }]`; a top-level `to` is rejected
      //      with HTTP 400. No invitation email this endpoint sent could ever
      //      have been delivered.
      //   2. The only error handling was `.catch(e => console.error(...))`. A
      //      400 from SendGrid is a RESOLVED fetch, so the catch never fired
      //      and the failure produced no log line at all, while the caller was
      //      told the invitation had been sent.
      // The payload shape is corrected and the response status is checked.
      let emailSent = false;
      let emailError = null;
      const sendgridKey = Deno.env.get('SENDGRID_API_KEY');
      if (sendgridKey) {
        const inviteUrl = `https://travelos.app/invite?group=${groupId}&token=${inviteToken}`;
        try {
          const sgRes = await fetch('https://api.sendgrid.com/v3/mail/send', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${sendgridKey}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              personalizations: [
                {
                  to: [
                    {
                      email
                    }
                  ]
                }
              ],
              from: {
                email: 'noreply@travelos.app',
                name: 'TravelOS'
              },
              subject: `You're invited to join "${group?.name || 'a trip group'}"`,
              content: [
                {
                  type: 'text/html',
                  value: `<p>You've been invited as a <strong>${role}</strong>.</p><p><a href="${inviteUrl}">Accept Invitation</a></p><p>This link expires in 7 days.</p>`
                }
              ]
            })
          });
          if (sgRes.ok) {
            emailSent = true;
          } else {
            const text = await sgRes.text().catch(()=>'<unreadable>');
            emailError = `SendGrid returned ${sgRes.status}`;
            console.error('[group-management] SendGrid send failed:', sgRes.status, text.slice(0, 300));
          }
        } catch (e) {
          emailError = 'SendGrid request failed';
          console.error('[group-management] SendGrid request threw:', e instanceof Error ? e.message : String(e));
        }
      } else {
        emailError = 'SENDGRID_API_KEY is not configured';
      }
      // The invitation record exists either way, so this is a 200 — but the
      // caller is told plainly whether the email actually went out, instead of
      // being left to assume it did.
      return json({
        member,
        inviteToken,
        email_sent: emailSent,
        email_error: emailError
      });
    }
    // ── accept_invitation ───────────────────────────────────────────
    if (action === 'accept_invitation') {
      const { groupId, inviteToken } = body;
      const { data: member, error } = await service.from('group_members').select('*').eq('group_id', groupId).eq('invite_token', inviteToken).eq('status', 'invited').maybeSingle();
      if (error) {
        console.error('[group-management] invitation lookup failed:', error.code, error.message);
        return fail('Failed to look up invitation', 500);
      }
      if (!member) return fail('Invalid or expired invitation', 404);
      // Check expiry
      if (member.invite_expires_at && new Date(member.invite_expires_at) < new Date()) {
        return fail('Invitation has expired', 410);
      }
      const user = await getCallerUser();
      // DEFECT 2026-09-19 — the error was discarded and `{ member: undefined }`
      // was returned with HTTP 200, so a failed accept looked to the client
      // like a successful join. The token filter is repeated in the update so
      // two concurrent accepts cannot both claim the invitation.
      const { data: updated, error: updateErr } = await service.from('group_members').update({
        user_id: userId,
        email: user?.email || member.email,
        display_name: user?.user_metadata?.full_name || user?.email?.split('@')[0] || 'Member',
        status: 'active',
        joined_at: new Date().toISOString(),
        invite_token: null
      }).eq('id', member.id).eq('invite_token', inviteToken).select().single();
      if (updateErr || !updated) {
        console.error('[group-management] accept invitation update failed:', updateErr?.code, updateErr?.message);
        return fail(`Failed to accept invitation: ${updateErr?.message ?? 'invitation was already used'}`, 500);
      }
      // DEFECT 2026-09-19 (fabricated data) — this used to upsert a
      // member_preferences row with `timezone: 'UTC'`. Joining a group is not a
      // statement about where you live. No preferences row is created here.
      return json({
        member: updated
      });
    }
    // ── decline_invitation ─────────────────────────────────────────
    if (action === 'decline_invitation') {
      const { groupId, inviteToken } = body;
      // DEFECT 2026-09-19 — no error check and no affected-row check, so
      // `{ declined: true }` came back for a token that matched nothing at all.
      const { data: declined, error } = await service.from('group_members').update({
        status: 'declined'
      }).eq('group_id', groupId).eq('invite_token', inviteToken).eq('status', 'invited').select('id');
      if (error) {
        console.error('[group-management] decline update failed:', error.code, error.message);
        return fail('Failed to decline invitation', 500);
      }
      if (!declined || declined.length === 0) {
        return fail('Invalid or already-answered invitation', 404);
      }
      return json({
        declined: true
      });
    }
    // ── remove_member ─────────────────────────────────────────────
    if (action === 'remove_member') {
      const { groupId, targetUserId } = body;
      if (!targetUserId) return fail('targetUserId is required', 400);
      // Check caller is organizer
      const callerMember = await requireGroupMember(groupId);
      if (callerMember instanceof Response) return callerMember;
      if (callerMember.role !== 'organizer') return fail('Only organizer can remove members', 403);
      // DEFECT 2026-09-19 — this used `.single()` with the error discarded and
      // then tested `targetMember?.role === 'organizer'`. A failed lookup left
      // targetMember undefined, the guard passed, and the DELETE below ran —
      // so a transient read failure could delete the group's ORGANIZER, the
      // one member this guard exists to protect. The row must now be read
      // successfully before anything is deleted.
      const { data: targetMember, error: targetErr } = await service.from('group_members').select('role').eq('group_id', groupId).eq('user_id', targetUserId).maybeSingle();
      if (targetErr) {
        console.error('[group-management] target member lookup failed:', targetErr.code, targetErr.message);
        return fail('Failed to look up the member to remove', 500);
      }
      if (!targetMember) return fail('Member not found in this group', 404);
      if (targetMember.role === 'organizer') return fail('Cannot remove organizer', 400);
      // Previously both deletes discarded their errors and `{ removed: true }`
      // was returned regardless.
      const { data: removed, error: removeErr } = await service.from('group_members').delete().eq('group_id', groupId).eq('user_id', targetUserId).select('id');
      if (removeErr) {
        console.error('[group-management] member delete failed:', removeErr.code, removeErr.message);
        return fail(`Failed to remove member: ${removeErr.message}`, 500);
      }
      if (!removed || removed.length === 0) {
        return fail('Member not found in this group', 404);
      }
      const { error: prefErr } = await service.from('member_preferences').delete().eq('group_id', groupId).eq('user_id', targetUserId);
      if (prefErr) {
        console.error('[group-management] member preferences delete failed:', prefErr.code, prefErr.message);
      }
      return json({
        removed: true,
        preferences_cleared: !prefErr
      });
    }
    // ── change_role ───────────────────────────────────────────────
    if (action === 'change_role') {
      const { groupId, targetUserId, newRole } = body;
      if (!targetUserId) return fail('targetUserId is required', 400);
      // DEFECT 2026-09-19 — newRole was never validated. group_members has a
      // CHECK constraint on role, so an unrecognised value failed with 23514 —
      // and since the update's error was discarded, the caller got HTTP 200
      // with `{"member": undefined}` and the role was unchanged.
      if (!VALID_ROLES.includes(newRole)) {
        return fail(`newRole must be one of ${VALID_ROLES.join(', ')}`, 400);
      }
      const callerMember = await requireGroupMember(groupId);
      if (callerMember instanceof Response) return callerMember;
      if (callerMember.role !== 'organizer') return fail('Only organizer can change roles', 403);
      const { data: targetMember, error: targetErr } = await service.from('group_members').select('role').eq('group_id', groupId).eq('user_id', targetUserId).maybeSingle();
      if (targetErr) {
        console.error('[group-management] target member lookup failed:', targetErr.code, targetErr.message);
        return fail('Failed to look up the member', 500);
      }
      if (!targetMember) return fail('Member not found in this group', 404);
      if (targetMember.role === 'organizer') return fail('Cannot change organizer role', 400);
      const { data, error: roleErr } = await service.from('group_members').update({
        role: newRole
      }).eq('group_id', groupId).eq('user_id', targetUserId).select().single();
      if (roleErr || !data) {
        console.error('[group-management] role update failed:', roleErr?.code, roleErr?.message);
        return fail(`Failed to change role: ${roleErr?.message ?? 'no row updated'}`, 500);
      }
      return json({
        member: data
      });
    }
    // ── get_preferences ─────────────────────────────────────────────
    if (action === 'get_preferences') {
      const { groupId, targetUserId } = body;
      const uid = targetUserId || userId;
      // Check permission: own prefs or organizer/planner
      if (uid !== userId) {
        const callerMember = await requireGroupMember(groupId);
        if (callerMember instanceof Response) return callerMember;
        if (![
          'organizer',
          'planner'
        ].includes(callerMember.role)) {
          return fail('Permission denied', 403);
        }
      }
      const { data, error } = await service.from('member_preferences').select('*').eq('group_id', groupId).eq('user_id', uid).maybeSingle();
      if (error) {
        console.error('[group-management] preferences read failed:', error.code, error.message);
        return fail('Failed to load preferences', 500);
      }
      // DEFECT 2026-09-19 (fabricated data) — this used to return
      //   data || { pace: 'moderate', budget: 'moderate', interests: [],
      //             dietary: [], mobility: 'none', timezone: 'UTC' }
      // whenever there was no row (and, because the error was discarded, also
      // whenever the query failed). A group planner reading a member's
      // preferences was shown "moderate pace, moderate budget, no dietary
      // requirements, no mobility needs" for someone who had never answered —
      // and "no dietary requirements" invented for a member with an allergy is
      // the kind of fabrication that ends up on a dinner booking. Unset is now
      // reported as unset.
      return json({
        preferences: data ?? null,
        preferences_set: !!data
      });
    }
    // ── update_preferences ─────────────────────────────────────────
    if (action === 'update_preferences') {
      const { groupId, preferences } = body;
      // Caller must be an active member of the group they're setting
      // preferences for. Previously unchecked.
      const member = await requireGroupMember(groupId);
      if (member instanceof Response) return member;
      if (!preferences || typeof preferences !== 'object') {
        return fail('preferences object is required', 400);
      }
      // DEFECT 2026-09-19 (fabricated data + data loss) — this upserted a FULL
      // row every time, filling anything the caller omitted with invented
      // values:
      //   pace: preferences.pace || 'moderate'
      //   budget: preferences.budget || 'moderate'
      //   interests: preferences.interests || []
      //   dietary: preferences.dietary || []
      //   mobility: preferences.mobility || 'none'
      //   timezone: preferences.timezone || 'UTC'
      // Two separate harms. First, a member who set only their budget was
      // recorded as wanting a moderate pace, having no dietary requirements and
      // living in UTC — none of which they said. Second, because an upsert
      // replaces the row, a later partial update WIPED previously saved real
      // answers back to those defaults: a member who had recorded a nut allergy
      // and then changed only their pace silently lost the allergy.
      // Only the keys the caller actually supplied are written now.
      const payload = {
        group_id: groupId,
        user_id: userId,
        updated_at: new Date().toISOString()
      };
      for (const key of [
        'pace',
        'budget',
        'mobility'
      ]){
        if (preferences[key] !== undefined && preferences[key] !== null) {
          if (!PREFERENCE_DOMAINS[key].includes(preferences[key])) {
            return fail(`${key} must be one of ${PREFERENCE_DOMAINS[key].join(', ')}`, 400);
          }
          payload[key] = preferences[key];
        }
      }
      for (const key of [
        'interests',
        'dietary'
      ]){
        if (preferences[key] !== undefined && preferences[key] !== null) {
          if (!Array.isArray(preferences[key])) {
            return fail(`${key} must be an array`, 400);
          }
          payload[key] = preferences[key];
        }
      }
      if (preferences.timezone !== undefined && preferences.timezone !== null) {
        payload.timezone = preferences.timezone;
      }
      if (Object.keys(payload).length === 3) {
        return fail('No recognised preference fields were supplied', 400);
      }
      const { data, error } = await service.from('member_preferences').upsert(payload, {
        onConflict: 'group_id,user_id'
      }).select().single();
      if (error) throw error;
      return json({
        preferences: data
      });
    }
    // ── check_permission ───────────────────────────────────────────
    if (action === 'check_permission') {
      const { groupId, permission } = body;
      const { data: member, error } = await service.from('group_members').select('role').eq('group_id', groupId).eq('user_id', userId).eq('status', 'active').maybeSingle();
      // Failing closed is right for a permission check, but it was previously
      // doing so silently — a member denied by a broken query looked exactly
      // like a non-member. A read failure is now an explicit 500 so the caller
      // does not record it as a considered denial.
      if (error) {
        console.error('[group-management] permission check read failed:', error.code, error.message);
        return fail('Failed to check permissions', 500);
      }
      if (!member) return json({
        allowed: false,
        role: null
      });
      const allowed = ROLE_PERMISSIONS[member.role]?.includes(permission) || false;
      return json({
        allowed,
        role: member.role,
        permissions: ROLE_PERMISSIONS[member.role] || []
      });
    }
    // ── get_role_permissions ────────────────────────────────────────
    if (action === 'get_role_permissions') {
      return json({
        permissions: ROLE_PERMISSIONS
      });
    }
    return fail('Unknown action', 400);
  } catch (e) {
    console.error('group-management error:', e);
    return fail('Internal server error', 500);
  }
});

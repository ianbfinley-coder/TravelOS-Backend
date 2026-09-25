// SECURITY 2026-09-16 — no membership checks on most actions; unsafe key fallback.
//
// What was wrong: this function ran every query on a supabaseAdmin client
// built with
//   Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_ANON_KEY')!
// which silently degrades to an anon client (RLS-restricted, but a false
// sense of safety, since RLS was never assumed here) if the service-role env
// var is ever unset — a config error would then quietly change the security
// model instead of failing loudly.
//
// More seriously, most actions never checked that the caller belonged to the
// poll's group at all:
//   - get_polls had no required groupId. Called with only a tripId (or
//     nothing), it returned every group's polls, unfiltered.
//   - get_poll, get_results and get_my_vote took only a pollId and did no
//     membership check whatsoever — any signed-in user could read any poll's
//     question, options, vote distribution, or another member's individual
//     vote choices by id.
//   - create_poll and close_poll looked up the caller's group_members role
//     without `.eq('status', 'active')`, so a member who had been removed
//     from the group (status != 'active') kept the ability to create or
//     close polls for it.
//
// Fix: requireGroupMember (copied from expense-tracking's pattern) checks
// group_id + the caller's verified uuid user id + status = 'active', and
// returns 404 (not 403) on failure so a caller cannot enumerate which group
// ids exist. requirePollAccess resolves a poll to its group first, then runs
// the same check, so get_poll/get_results/get_my_vote/close_poll can no
// longer be reached for a poll outside the caller's group. get_polls now
// requires groupId. supabaseAdmin is built from SUPABASE_SERVICE_ROLE_KEY
// alone (via the shared serviceClient() in _shared/auth.ts, which asserts the
// env var non-null) — no anon-key fallback.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { serviceClient } from './_shared/auth.ts';
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
const json = (data, status = 200)=>new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json'
    }
  });
const err = (code, message, status, details)=>json({
    error: code,
    message,
    ...details ? {
      details
    } : {}
  }, status);
function generateId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}
function calculateMajorityResult(options, threshold) {
  const totalVotes = options.reduce((sum, o)=>sum + (o.vote_count || 0), 0);
  if (totalVotes === 0) {
    return {
      winner: null,
      winnerText: null,
      consensus: false,
      distribution: {},
      voteCounts: {},
      threshold,
      threshold_met: false,
      totalVotes: 0
    };
  }
  const distribution = {};
  const voteCounts = {};
  let maxVotes = 0;
  for (const opt of options){
    const pct = Math.round(opt.vote_count / totalVotes * 1000) / 10;
    distribution[opt.id] = pct;
    voteCounts[opt.id] = opt.vote_count;
    if (opt.vote_count > maxVotes) maxVotes = opt.vote_count;
  }
  const topOptions = options.filter((o)=>o.vote_count === maxVotes);
  const tied = topOptions.length > 1;
  const winnerPct = maxVotes > 0 ? maxVotes / totalVotes * 100 : 0;
  const threshold_met = !tied && winnerPct >= threshold;
  return {
    winner: tied ? null : topOptions[0]?.id ?? null,
    winnerText: tied ? null : topOptions[0]?.text ?? null,
    consensus: false,
    distribution,
    voteCounts,
    threshold,
    threshold_met,
    totalVotes,
    ...tied ? {
      tied: true,
      tiedOptions: topOptions.map((o)=>o.id)
    } : {}
  };
}
function calculateConsensusResult(options, threshold, totalVoters) {
  const totalVotes = options.reduce((sum, o)=>sum + (o.vote_count || 0), 0);
  if (totalVotes === 0) {
    return {
      winner: null,
      winnerText: null,
      consensus: false,
      distribution: {},
      voteCounts: {},
      threshold,
      threshold_met: false,
      totalVotes: 0
    };
  }
  const distribution = {};
  const voteCounts = {};
  let consensusOption = null;
  for (const opt of options){
    const pct = totalVoters > 0 ? Math.round(opt.vote_count / totalVoters * 1000) / 10 : 0;
    distribution[opt.id] = pct;
    voteCounts[opt.id] = opt.vote_count;
    if (pct >= threshold) consensusOption = {
      id: opt.id,
      text: opt.text
    };
  }
  return {
    winner: consensusOption?.id ?? null,
    winnerText: consensusOption?.text ?? null,
    consensus: !!consensusOption,
    distribution,
    voteCounts,
    threshold,
    threshold_met: !!consensusOption,
    totalVotes
  };
}
function calculateRankedChoiceResult(options, votes, threshold) {
  const totalVoters = new Set(votes.map((v)=>v.user_id)).size;
  if (totalVoters === 0) {
    return {
      winner: null,
      winnerText: null,
      consensus: false,
      distribution: {},
      voteCounts: {},
      threshold,
      threshold_met: false,
      totalVotes: 0
    };
  }
  const voterPrefs = {};
  for (const vote of votes){
    if (!voterPrefs[vote.user_id]) voterPrefs[vote.user_id] = [];
    // rank is 1-based index
    voterPrefs[vote.user_id][vote.rank - 1] = vote.option_id;
  }
  let remaining = options.map((o)=>o.id);
  let rounds = 0;
  while(remaining.length > 1 && rounds < options.length){
    rounds++;
    const firstChoiceCounts = {};
    for (const id of remaining)firstChoiceCounts[id] = 0;
    for (const prefs of Object.values(voterPrefs)){
      const firstValid = prefs.find((p)=>p && remaining.includes(p));
      if (firstValid) firstChoiceCounts[firstValid] = (firstChoiceCounts[firstValid] || 0) + 1;
    }
    const totalFirstChoices = Object.values(firstChoiceCounts).reduce((a, b)=>a + b, 0);
    if (totalFirstChoices === 0) break;
    const winner = remaining.find((id)=>firstChoiceCounts[id] / totalFirstChoices * 100 >= threshold);
    if (winner) {
      const distribution = {};
      const voteCounts = {};
      for (const id of remaining){
        distribution[id] = Math.round((firstChoiceCounts[id] || 0) / totalFirstChoices * 1000) / 10;
        voteCounts[id] = firstChoiceCounts[id] || 0;
      }
      const winnerOpt = options.find((o)=>o.id === winner);
      return {
        winner,
        winnerText: winnerOpt?.text ?? null,
        consensus: false,
        distribution,
        voteCounts,
        threshold,
        threshold_met: true,
        totalVotes: totalFirstChoices
      };
    }
    const minVotes = Math.min(...remaining.map((id)=>firstChoiceCounts[id] || 0));
    const toEliminate = remaining.find((id)=>(firstChoiceCounts[id] || 0) === minVotes);
    if (toEliminate) remaining = remaining.filter((id)=>id !== toEliminate);
  }
  return {
    winner: null,
    winnerText: null,
    consensus: false,
    distribution: {},
    voteCounts: {},
    threshold,
    threshold_met: false,
    totalVotes: totalVoters
  };
}
function computeResult(poll, allVotes) {
  const options = poll.poll_options || [];
  // NOTE 2026-09-19: `poll.voting_threshold || 50` silently substitutes 50%
  // for a poll whose threshold was never recorded (and for a legitimate
  // threshold of 0, which `||` also discards). create_poll always writes one,
  // so this should not fire; when it does, the result now says the threshold
  // was assumed rather than presenting 50 as the group's chosen rule.
  const thresholdAssumed = typeof poll.voting_threshold !== 'number';
  const threshold = thresholdAssumed ? 50 : poll.voting_threshold;
  const totalVoters = new Set(allVotes.map((v)=>v.user_id)).size;
  let result;
  if (poll.strategy === 'ranked-choice') result = calculateRankedChoiceResult(options, allVotes, threshold);
  else if (poll.strategy === 'consensus') result = calculateConsensusResult(options, threshold, totalVoters);
  else result = calculateMajorityResult(options, threshold);
  return thresholdAssumed ? {
    ...result,
    thresholdAssumed: true
  } : result;
}
// DEFECT 2026-09-19 — closing a poll recorded a RESULT COMPUTED FROM DATA IT
// FAILED TO READ.
//
// This helper ran three queries and discarded every error:
//   const { data: freshOptions } = ...poll_options...
//   const { data: allVotes }     = ...poll_votes...
//   const { data: updated }      = ...polls.update(...)
// A failed poll_votes read gave `allVotes = []`. For a consensus or
// ranked-choice poll, computeResult over an empty vote list returns "no
// winner, threshold not met" — and that was then WRITTEN to the poll along
// with status 'closed'. The group's decision was permanently recorded as "no
// consensus reached" because one SELECT failed, with the poll locked so nobody
// could vote again. A failed options read fell back to a possibly stale copy of
// the options carrying old vote counts, and a failed UPDATE meant the caller
// was told the poll had closed when it was still open.
//
// Every read is now required to succeed before a result is written, and the
// update is verified.
async function closeAndCalculate(supabase, pollId, poll) {
  const { data: freshOptions, error: optionsErr } = await supabase.from('poll_options').select('*').eq('poll_id', pollId);
  if (optionsErr) {
    throw new Error(`Cannot close poll: failed to read options (${optionsErr.message})`);
  }
  const { data: allVotes, error: votesErr } = await supabase.from('poll_votes').select('user_id, option_id, rank').eq('poll_id', pollId);
  if (votesErr) {
    throw new Error(`Cannot close poll: failed to read votes (${votesErr.message})`);
  }
  const pollWithFresh = {
    ...poll,
    poll_options: freshOptions ?? []
  };
  const result = computeResult(pollWithFresh, allVotes ?? []);
  const { data: updated, error: updateErr } = await supabase.from('polls').update({
    status: 'closed',
    closed_at: new Date().toISOString(),
    result_winner: result.winner || null,
    result_consensus: result.consensus,
    result_distribution: result.distribution,
    result_threshold_met: result.threshold_met,
    updated_at: new Date().toISOString()
  }).eq('id', pollId).select(`*, poll_options(*)`).single();
  if (updateErr || !updated) {
    throw new Error(`Failed to close poll: ${updateErr?.message ?? 'no row updated'}`);
  }
  return {
    ...updated,
    results: result
  };
}
// ─── Main handler ───────────────────────────────────────────────
serve(async (req)=>{
  if (req.method === 'OPTIONS') return new Response('ok', {
    headers: corsHeaders
  });
  try {
    const supabaseAdmin = serviceClient();
    const supabase = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_ANON_KEY'), {
      global: {
        headers: {
          Authorization: req.headers.get('Authorization') || ''
        }
      }
    });
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return err('UNAUTHORIZED', 'Authentication required', 401);
    /**
     * THE CHECK THAT WAS MISSING FROM MOST ACTIONS.
     *
     * Returns the caller's active membership row, or a 404 Response. 404
     * rather than 403 so a caller cannot enumerate which group ids exist.
     * `status = 'active'` matters: a removed member must lose access —
     * create_poll and close_poll previously omitted it.
     *
     * DEFECT 2026-09-19 — the error was discarded, so a failed membership read
     * told a genuine member "Group not found".
     */ async function requireGroupMember(groupId) {
      if (!groupId) return err('GROUP_REQUIRED', 'groupId is required', 400);
      const { data, error } = await supabaseAdmin.from('group_members').select('role').eq('group_id', groupId).eq('user_id', user.id).eq('status', 'active').maybeSingle();
      if (error) {
        console.error('[voting-system] membership check failed:', error.code, error.message);
        return err('INTERNAL_ERROR', 'Failed to check group membership', 500);
      }
      if (!data) return err('GROUP_NOT_FOUND', 'Group not found', 404);
      return {
        role: data.role ?? 'member'
      };
    }
    /** Resolves a poll to its group, then checks membership. 404 if either fails. */ async function requirePollAccess(pollId) {
      if (!pollId) return err('POLL_REQUIRED', 'pollId is required', 400);
      const { data: poll, error } = await supabaseAdmin.from('polls').select(`*, poll_options(*)`).eq('id', pollId).maybeSingle();
      if (error) {
        console.error('[voting-system] poll lookup failed:', error.code, error.message);
        return err('INTERNAL_ERROR', 'Failed to load poll', 500);
      }
      if (!poll) return err('POLL_NOT_FOUND', 'Poll not found', 404);
      const member = await requireGroupMember(poll.group_id);
      if (member instanceof Response) {
        // Preserve a real 500; only a genuine access failure becomes a 404.
        if (member.status === 500) return member;
        return err('POLL_NOT_FOUND', 'Poll not found', 404);
      }
      return {
        poll,
        role: member.role
      };
    }
    let body;
    try {
      body = await req.json();
    } catch  {
      return err('INVALID_JSON', 'Request body must be valid JSON', 400);
    }
    const { action } = body;
    // ── create_poll ───────────────────────────────────────────────
    if (action === 'create_poll') {
      const { groupId, tripId, question, description, options, strategy = 'majority', votingThreshold = 50 } = body;
      if (!groupId || !tripId || !question) return err('INVALID_POLL', 'groupId, tripId, and question required', 400);
      if (!options || options.length < 2) return err('TOO_FEW_OPTIONS', 'Poll must have at least 2 options', 422, {
        minOptions: 2,
        provided: options?.length ?? 0
      });
      if (options.length > 10) return err('TOO_MANY_OPTIONS', 'Poll cannot have more than 10 options', 422, {
        maxOptions: 10,
        provided: options.length
      });
      if (question.length > 500) return err('QUESTION_TOO_LONG', 'Question must be 500 characters or less', 422);
      if (votingThreshold < 0 || votingThreshold > 100) return err('INVALID_THRESHOLD', 'Voting threshold must be between 0 and 100', 400);
      if (![
        'majority',
        'consensus',
        'ranked-choice'
      ].includes(strategy)) return err('INVALID_STRATEGY', 'Strategy must be majority, consensus, or ranked-choice', 400);
      // Validate option texts
      for (const opt of options){
        if (!opt || (typeof opt === 'string' ? opt : opt.text)?.length > 200) {
          return err('OPTION_TEXT_TOO_LONG', 'Option text must be 200 characters or less', 422);
        }
      }
      // Check for duplicate option texts (case-insensitive)
      const optionTexts = options.map((o)=>(typeof o === 'string' ? o : o.text).toLowerCase().trim());
      const uniqueTexts = new Set(optionTexts);
      if (uniqueTexts.size !== optionTexts.length) {
        return err('DUPLICATE_OPTION_TEXT', 'Poll options must have unique text', 409);
      }
      // Check permission: must be an active organizer or planner
      const member = await requireGroupMember(groupId);
      if (member instanceof Response) return member;
      if (![
        'organizer',
        'planner'
      ].includes(member.role)) {
        return err('UNAUTHORIZED', 'Only organizer or planner can create polls', 403);
      }
      const pollId = generateId('poll');
      const { data: poll, error: pErr } = await supabaseAdmin.from('polls').insert({
        id: pollId,
        group_id: groupId,
        trip_id: tripId,
        question,
        description,
        strategy,
        voting_threshold: votingThreshold,
        created_by: user.id,
        status: 'open'
      }).select().single();
      if (pErr) throw pErr;
      const optionRows = options.map((o, i)=>({
          id: generateId('opt'),
          poll_id: pollId,
          text: typeof o === 'string' ? o : o.text,
          display_order: i,
          vote_count: 0
        }));
      const { data: insertedOptions, error: oErr } = await supabaseAdmin.from('poll_options').insert(optionRows).select();
      if (oErr) {
        // A poll with no options can never be voted on. Roll it back rather
        // than leaving a dead poll in the group's list.
        await supabaseAdmin.from('polls').delete().eq('id', pollId);
        throw oErr;
      }
      return json({
        poll: {
          ...poll,
          options: insertedOptions
        }
      }, 201);
    }
    // ── get_polls ─────────────────────────────────────────────────
    if (action === 'get_polls') {
      const { groupId, tripId, status, limit = 20, offset = 0 } = body;
      // groupId is now MANDATORY. It used to be optional, and with it omitted
      // this returned every group's polls, unfiltered.
      const member = await requireGroupMember(groupId);
      if (member instanceof Response) return member;
      let query = supabaseAdmin.from('polls').select(`*, poll_options(*)`).eq('group_id', groupId);
      if (tripId) query = query.eq('trip_id', tripId);
      if (status) query = query.eq('status', status);
      const { data, error } = await query.order('created_at', {
        ascending: false
      }).range(offset, offset + limit - 1);
      if (error) throw error;
      const pollIds = (data || []).map((p)=>p.id);
      let votesByPoll = {};
      if (pollIds.length > 0) {
        // DEFECT 2026-09-19 — the error was discarded, so a failed read made
        // every poll show the caller as not having voted, inviting a duplicate
        // vote that then bounced off the unique constraint.
        const { data: userVotes, error: votesErr } = await supabaseAdmin.from('poll_votes').select('poll_id, option_id, rank').eq('user_id', user.id).in('poll_id', pollIds);
        if (votesErr) {
          console.error('[voting-system] user votes read failed:', votesErr.code, votesErr.message);
          return err('INTERNAL_ERROR', 'Failed to load your votes', 500);
        }
        for (const v of userVotes || []){
          if (!votesByPoll[v.poll_id]) votesByPoll[v.poll_id] = [];
          votesByPoll[v.poll_id].push(v);
        }
      }
      return json({
        polls: (data || []).map((p)=>({
            ...p,
            userVotes: votesByPoll[p.id] || []
          })),
        total: (data || []).length,
        limit,
        offset
      });
    }
    // ── get_poll ──────────────────────────────────────────────────
    if (action === 'get_poll') {
      const { pollId } = body;
      const access = await requirePollAccess(pollId);
      if (access instanceof Response) return access;
      const { data: userVotes, error: votesErr } = await supabaseAdmin.from('poll_votes').select('option_id, rank').eq('poll_id', pollId).eq('user_id', user.id);
      if (votesErr) {
        console.error('[voting-system] user votes read failed:', votesErr.code, votesErr.message);
        return err('INTERNAL_ERROR', 'Failed to load your votes', 500);
      }
      return json({
        poll: {
          ...access.poll,
          userVotes: userVotes || []
        }
      });
    }
    // ── get_my_vote ───────────────────────────────────────────────
    if (action === 'get_my_vote') {
      const { pollId } = body;
      const access = await requirePollAccess(pollId);
      if (access instanceof Response) return access;
      // Previously the error was discarded and a failed read was reported as
      // NOT_VOTED — telling a member who had voted that they had not.
      const { data: votes, error: votesErr } = await supabaseAdmin.from('poll_votes').select('option_id, rank, created_at').eq('poll_id', pollId).eq('user_id', user.id);
      if (votesErr) {
        console.error('[voting-system] my vote read failed:', votesErr.code, votesErr.message);
        return err('INTERNAL_ERROR', 'Failed to load your vote', 500);
      }
      if (!votes?.length) return err('NOT_VOTED', 'User has not voted on this poll', 404);
      return json({
        pollId,
        userId: user.id,
        choices: votes.map((v)=>({
            optionId: v.option_id,
            rank: v.rank
          })),
        timestamp: votes[0].created_at
      });
    }
    // ── cast_vote ─────────────────────────────────────────────────
    if (action === 'cast_vote') {
      const { pollId, choices } = body;
      if (!pollId || !choices?.length) return err('INVALID_VOTE_CHOICES', 'pollId and choices required', 400);
      const { data: poll, error: pErr } = await supabaseAdmin.from('polls').select(`*, poll_options(*)`).eq('id', pollId).maybeSingle();
      if (pErr) {
        console.error('[voting-system] poll lookup failed:', pErr.code, pErr.message);
        return err('INTERNAL_ERROR', 'Failed to load poll', 500);
      }
      if (!poll) return err('POLL_NOT_FOUND', 'Poll not found', 404);
      if (poll.status === 'closed') return err('POLL_CLOSED', 'Poll is no longer accepting votes', 410, {
        autoClosedAt: poll.closed_at
      });
      const { data: member, error: memberErr } = await supabaseAdmin.from('group_members').select('role').eq('group_id', poll.group_id).eq('user_id', user.id).eq('status', 'active').maybeSingle();
      if (memberErr) {
        console.error('[voting-system] voter membership check failed:', memberErr.code, memberErr.message);
        return err('INTERNAL_ERROR', 'Failed to check group membership', 500);
      }
      if (!member) return err('NOT_GROUP_MEMBER', 'Not an active group member', 403);
      // Check duplicate vote
      if (poll.strategy !== 'ranked-choice') {
        const { data: existing, error: existingErr } = await supabaseAdmin.from('poll_votes').select('id').eq('poll_id', pollId).eq('user_id', user.id).limit(1);
        if (existingErr) {
          console.error('[voting-system] duplicate vote check failed:', existingErr.code, existingErr.message);
          return err('INTERNAL_ERROR', 'Failed to check for an existing vote', 500);
        }
        if (existing?.length) return err('ALREADY_VOTED', 'User has already voted on this poll', 409);
      }
      // Validate option IDs
      const validOptionIds = poll.poll_options.map((o)=>o.id);
      for (const choice of choices){
        if (!validOptionIds.includes(choice.optionId)) {
          return err('OPTION_MISMATCH', `Invalid option: ${choice.optionId}`, 400);
        }
      }
      const votesToInsert = poll.strategy === 'ranked-choice' ? choices.map((c)=>({
          poll_id: pollId,
          user_id: user.id,
          option_id: c.optionId,
          rank: c.rank || 1
        })) : [
        {
          poll_id: pollId,
          user_id: user.id,
          option_id: choices[0].optionId,
          rank: 1
        }
      ];
      const { error: vErr } = await supabaseAdmin.from('poll_votes').insert(votesToInsert);
      if (vErr) {
        if (vErr.code === '23505') return err('ALREADY_VOTED', 'User has already voted on this poll', 409);
        throw vErr;
      }
      // Recalculate vote counts.
      //
      // DEFECT 2026-09-19 — this used to run one COUNT query per option and
      // write `vote_count: count || 0`, with the query's error discarded. A
      // failed count returns `count === null`, so `|| 0` WROTE ZERO to that
      // option's tally — silently destroying every vote already cast for it,
      // and doing so inside the same request that had just added one. The
      // update's own error was discarded too. The votes are now read once and
      // counted in memory, so a zero is only ever written when the read
      // succeeded and the option genuinely has no votes.
      const { data: allVotesAfter, error: tallyErr } = await supabaseAdmin.from('poll_votes').select('user_id, option_id').eq('poll_id', pollId);
      if (tallyErr) {
        console.error('[voting-system] tally read failed:', tallyErr.code, tallyErr.message);
        return json({
          voted: true,
          autoClosedPoll: false,
          tally_updated: false,
          warning: 'Your vote was recorded but the displayed totals could not be refreshed.'
        }, 201);
      }
      const counts = new Map();
      for (const v of allVotesAfter ?? []){
        counts.set(v.option_id, (counts.get(v.option_id) ?? 0) + 1);
      }
      let tallyUpdated = true;
      for (const opt of poll.poll_options){
        const { error: countErr } = await supabaseAdmin.from('poll_options').update({
          vote_count: counts.get(opt.id) ?? 0
        }).eq('id', opt.id);
        if (countErr) {
          tallyUpdated = false;
          console.error('[voting-system] vote_count update failed for', opt.id, countErr.code, countErr.message);
        }
      }
      // Auto-close check.
      //
      // DEFECT 2026-09-19 — this was:
      //   const { count: activeMembers } = await ...group_members...count...
      //   if (uniqueVoters >= (activeMembers || 0)) { close }
      // with the error discarded. A failed count gives `activeMembers === null`,
      // `(null || 0)` is 0, and `uniqueVoters >= 0` is ALWAYS TRUE — so the
      // poll closed on the very first vote cast, locking in a one-person result
      // for the whole group and refusing every later vote with POLL_CLOSED.
      // Auto-close now requires a successfully read, positive member count.
      const { count: activeMembers, error: memberCountErr } = await supabaseAdmin.from('group_members').select('*', {
        count: 'exact',
        head: true
      }).eq('group_id', poll.group_id).eq('status', 'active');
      const uniqueVoters = new Set((allVotesAfter ?? []).map((v)=>v.user_id)).size;
      let autoClosed = false;
      if (memberCountErr) {
        console.error('[voting-system] active member count failed; not auto-closing:', memberCountErr.code, memberCountErr.message);
      } else if (typeof activeMembers === 'number' && activeMembers > 0 && uniqueVoters >= activeMembers) {
        await closeAndCalculate(supabaseAdmin, pollId, poll);
        autoClosed = true;
      }
      return json({
        voted: true,
        autoClosedPoll: autoClosed,
        tally_updated: tallyUpdated
      }, 201);
    }
    // ── close_poll ───────────────────────────────────────────────
    if (action === 'close_poll') {
      const { pollId } = body;
      const { data: poll, error: pErr } = await supabaseAdmin.from('polls').select(`*, poll_options(*)`).eq('id', pollId).maybeSingle();
      if (pErr) {
        console.error('[voting-system] poll lookup failed:', pErr.code, pErr.message);
        return err('INTERNAL_ERROR', 'Failed to load poll', 500);
      }
      if (!poll) return err('POLL_NOT_FOUND', 'Poll not found', 404);
      if (poll.status === 'closed') {
        return err('POLL_CLOSED', 'Poll is already closed', 409, {
          closedAt: poll.closed_at
        });
      }
      // `.eq('status', 'active')` was missing here: a removed organizer kept
      // the power to close (and thus lock the result of) a group's polls.
      //
      // DEFECT 2026-09-19 — the creator branch had the same hole from the other
      // direction: `poll.created_by !== user.id` was checked WITHOUT any
      // membership requirement, so someone removed from the group entirely
      // could still close any poll they had created while a member. Active
      // membership is now required for both paths.
      const member = await requireGroupMember(poll.group_id);
      if (member instanceof Response) return member;
      if (member.role !== 'organizer' && poll.created_by !== user.id) {
        return err('UNAUTHORIZED', 'Only poll creator or organizer can close poll', 403);
      }
      const result = await closeAndCalculate(supabaseAdmin, pollId, poll);
      return json({
        poll: result
      });
    }
    // ── get_results ───────────────────────────────────────────────
    if (action === 'get_results') {
      const { pollId } = body;
      const access = await requirePollAccess(pollId);
      if (access instanceof Response) return access;
      const poll = access.poll;
      // DEFECT 2026-09-19 — the error was discarded, so a failed votes read
      // produced a results payload computed from an empty vote list: "no
      // winner, 0 votes", shown to the group as the state of their poll.
      const { data: allVotes, error: votesErr } = await supabaseAdmin.from('poll_votes').select('user_id, option_id, rank').eq('poll_id', pollId);
      if (votesErr) {
        console.error('[voting-system] results votes read failed:', votesErr.code, votesErr.message);
        return err('INTERNAL_ERROR', 'Failed to load votes for this poll', 500);
      }
      const result = computeResult(poll, allVotes || []);
      return json({
        results: result,
        poll
      });
    }
    return err('UNKNOWN_ACTION', 'Unknown action', 400);
  } catch (e) {
    console.error('[voting-system] unhandled:', e instanceof Error ? e.message : String(e));
    return err('INTERNAL_ERROR', 'Internal server error', 500);
  }
});

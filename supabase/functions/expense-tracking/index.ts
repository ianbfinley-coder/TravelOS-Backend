import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
// SECURITY 2026-09-16 — this function handles money and had five holes.
//
// It authenticated the caller (good) and then never once checked that the
// caller belonged to the group whose money it was operating on (bad). Every
// query ran through a service_role client, which bypasses RLS, so the database
// was not going to save it either.
//
//   1. mark_settled  — `.eq('user_id', userId || user.id)` with NO payer,
//                      membership or ownership check. Any signed-in user could
//                      mark ANY split on ANY expense as paid. This is the one
//                      that moves money: a debt marked settled is a debt
//                      forgiven, and `get_balances` skips settled splits.
//   2. get_expenses  — groupId and tripId were both OPTIONAL. Omit both and the
//                      query is `select * from expenses where deleted_at is
//                      null limit 50` — every group's spending, descriptions,
//                      receipts and member ids, to any signed-in caller.
//   3. get_expense   — plain IDOR. Any expenseId, no membership check.
//   4. get_balances  — any groupId. Who owes whom, across tenants.
//   5. calculate_splits — read group_members for an arbitrary group, which
//                      leaks the member roster.
//
// Also fixed: update_expense and delete_expense looked up the caller's role
// without `status = 'active'`, so a REMOVED organizer kept their powers.
//
// The fix is one helper — requireGroupMember — applied to every action, and a
// deliberate narrowing of who may settle a debt (see mark_settled).
//
// DEFECT 2026-09-19 (PGRST200 — EXPENSE SPLITTING HAS NEVER WORKED).
//
// Both calculate_splits and add_expense loaded participants with:
//
//     .from('group_members').select('user_id, member_preferences(budget)')
//
// That embedded select asks PostgREST to follow a relationship from
// group_members to member_preferences. No such relationship exists. Checked
// against pg_constraint: member_preferences' only foreign keys are
// group_id -> trip_groups(id) and user_id -> auth.users(id). There is no FK in
// either direction between member_preferences and group_members, so PostgREST
// rejects the whole request with PGRST200 ("Could not find a relationship...").
// The error was destructured away (`const { data: members } = ...`), leaving
// `members` null, and the consequences ran right through the money path:
//
//   - equal / proportional: memberInfos was [], splitEqual([]) returns [], so
//     the expense was INSERTED WITH NO SPLIT ROWS AT ALL and returned 201.
//     The expense appeared in the group's list, counted towards the total, and
//     nobody owed a penny of it. get_balances showed nothing.
//   - custom / itemized: memberIdSet was empty, so the "splits may only name
//     active group members" guard treated EVERY named member as a stranger and
//     rejected the request with 400 INVALID_SPLIT_MEMBER.
//
// So splitting an expense either silently recorded no debts or refused
// outright, for every group, always. The two tables are now read separately
// and joined in memory, and every read on the money path checks its error.
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
// Equal split: floor to cents, distribute remainder to first N people
function splitEqual(members, totalAmount) {
  if (members.length === 0) return [];
  const totalCents = Math.round(totalAmount * 100);
  const perPersonCents = Math.floor(totalCents / members.length);
  const remainderCents = totalCents % members.length;
  return members.map((m, i)=>{
    const cents = perPersonCents + (i < remainderCents ? 1 : 0);
    return {
      user_id: m.user_id,
      amount: cents / 100,
      percentage: Math.round(cents / totalCents * 10000) / 100
    };
  });
}
// Proportional split: budget weights (luxury=3, moderate=2, budget=1).
//
// DEFECT 2026-09-19 (fabricated data, on the money path) — the weight used to
// be `weightMap[m.budget_preference || 'moderate'] || 2`, so a member who had
// never recorded a budget preference was silently assigned "moderate" and
// charged twice what a "budget" member paid for the same dinner. That is an
// invented answer to a question nobody asked them, and it changes what they
// owe. Callers must now resolve missing preferences before a proportional
// split can be computed; see the guard in requireProportionalWeights.
function splitProportional(members, totalAmount) {
  const weightMap = {
    luxury: 3,
    moderate: 2,
    budget: 1
  };
  const weights = members.map((m)=>weightMap[m.budget_preference]);
  const totalWeight = weights.reduce((a, b)=>a + b, 0);
  const totalCents = Math.round(totalAmount * 100);
  // Calculate base cents per person
  const baseCents = weights.map((w)=>Math.floor(w / totalWeight * totalCents));
  const sumBase = baseCents.reduce((a, b)=>a + b, 0);
  const remainder = totalCents - sumBase;
  // Distribute remainder cents to those with largest fractional parts
  const fractionals = weights.map((w, i)=>({
      index: i,
      frac: w / totalWeight * totalCents - baseCents[i]
    })).sort((a, b)=>b.frac - a.frac);
  const finalCents = [
    ...baseCents
  ];
  for(let i = 0; i < remainder; i++){
    finalCents[fractionals[i].index]++;
  }
  return members.map((m, i)=>({
      user_id: m.user_id,
      amount: finalCents[i] / 100,
      percentage: Math.round(finalCents[i] / totalCents * 10000) / 100
    }));
}
/** Members with no recorded budget preference cannot be weighted. */ function membersMissingBudget(members) {
  const known = [
    'luxury',
    'moderate',
    'budget'
  ];
  return members.filter((m)=>!m.budget_preference || !known.includes(m.budget_preference)).map((m)=>m.user_id);
}
// Itemized split
function splitItemized(lineItems, allMemberIds) {
  const totalsCents = {};
  for (const id of allMemberIds)totalsCents[id] = 0;
  for (const item of lineItems){
    const sharers = item.split_among.length > 0 ? item.split_among : allMemberIds;
    const itemCents = Math.round(item.amount * 100);
    const perPersonCents = Math.floor(itemCents / sharers.length);
    const remainderCents = itemCents % sharers.length;
    sharers.forEach((uid, i)=>{
      totalsCents[uid] = (totalsCents[uid] || 0) + perPersonCents + (i < remainderCents ? 1 : 0);
    });
  }
  const totalCents = Object.values(totalsCents).reduce((a, b)=>a + b, 0);
  return Object.entries(totalsCents).map(([user_id, cents])=>({
      user_id,
      amount: cents / 100,
      percentage: totalCents > 0 ? Math.round(cents / totalCents * 10000) / 100 : 0
    }));
}
// Custom split validation
function splitCustom(customSplits, totalAmount) {
  const totalCents = Math.round(totalAmount * 100);
  const sumCents = customSplits.reduce((s, x)=>s + Math.round(x.amount * 100), 0);
  return customSplits.map((s)=>({
      user_id: s.user_id,
      amount: Math.round(s.amount * 100) / 100,
      percentage: sumCents > 0 ? Math.round(Math.round(s.amount * 100) / totalCents * 10000) / 100 : 0
    }));
}
// ─── Main handler ───────────────────────────────────────────────
serve(async (req)=>{
  if (req.method === 'OPTIONS') return new Response('ok', {
    headers: corsHeaders
  });
  try {
    const supabaseAdmin = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));
    const supabase = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_ANON_KEY'), {
      global: {
        headers: {
          Authorization: req.headers.get('Authorization') || ''
        }
      }
    });
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return err('UNAUTHORIZED', 'Authentication required', 401);
    let body;
    try {
      body = await req.json();
    } catch  {
      return err('INVALID_JSON', 'Request body must be valid JSON', 400);
    }
    const { action } = body;
    /**
     * THE CHECK THAT WAS MISSING EVERYWHERE.
     *
     * Returns the caller's active membership row, or an error Response.
     * 404 rather than 403 so a caller cannot enumerate which group ids exist.
     * `status = 'active'` matters: a removed member must lose access, and two
     * actions below previously omitted it.
     *
     * DEFECT 2026-09-19 — the error was discarded, so a failed read told a
     * genuine member "Group not found".
     */ async function requireGroupMember(groupId) {
      if (!groupId) return err('GROUP_REQUIRED', 'groupId is required', 400);
      const { data, error } = await supabaseAdmin.from('group_members').select('role').eq('group_id', groupId).eq('user_id', user.id).eq('status', 'active').maybeSingle();
      if (error) {
        console.error('[expense-tracking] membership check failed:', error.code, error.message);
        return err('INTERNAL_ERROR', 'Failed to check group membership', 500);
      }
      if (!data) return err('GROUP_NOT_FOUND', 'Group not found', 404);
      return {
        role: data.role ?? 'member'
      };
    }
    /**
     * Active members of a group with their budget preference, joined in
     * memory. See the PGRST200 note at the top of this file: the embedded
     * `member_preferences(budget)` select this replaces could never resolve.
     */ async function loadGroupMembers(client, groupId, restrictTo) {
      let memberQuery = client.from('group_members').select('user_id').eq('group_id', groupId).eq('status', 'active');
      if (restrictTo && restrictTo.length > 0) {
        memberQuery = memberQuery.in('user_id', restrictTo);
      }
      const { data: members, error: membersErr } = await memberQuery;
      if (membersErr) {
        console.error('[expense-tracking] group_members read failed:', membersErr.code, membersErr.message);
        return err('INTERNAL_ERROR', 'Failed to load group members', 500);
      }
      const ids = (members ?? []).map((m)=>m.user_id).filter(Boolean);
      if (ids.length === 0) return [];
      const { data: prefs, error: prefsErr } = await client.from('member_preferences').select('user_id, budget').eq('group_id', groupId).in('user_id', ids);
      if (prefsErr) {
        console.error('[expense-tracking] member_preferences read failed:', prefsErr.code, prefsErr.message);
        return err('INTERNAL_ERROR', 'Failed to load member preferences', 500);
      }
      const budgetByUser = new Map();
      for (const p of prefs ?? [])budgetByUser.set(p.user_id, p.budget ?? null);
      return ids.map((id)=>({
          user_id: id,
          // Previously `|| 'moderate'`. Unknown stays unknown; see splitProportional.
          budget_preference: budgetByUser.get(id) ?? null
        }));
    }
    /** Resolves an expense to its group, then checks membership. */ async function requireExpenseAccess(expenseId) {
      if (!expenseId) return err('EXPENSE_REQUIRED', 'expenseId is required', 400);
      const { data: expense, error } = await supabaseAdmin.from('expenses').select('*').eq('id', expenseId).is('deleted_at', null).maybeSingle();
      if (error) {
        console.error('[expense-tracking] expense lookup failed:', error.code, error.message);
        return err('INTERNAL_ERROR', 'Failed to load expense', 500);
      }
      if (!expense) return err('EXPENSE_NOT_FOUND', 'Expense not found', 404);
      const member = await requireGroupMember(expense.group_id);
      if (member instanceof Response) {
        if (member.status === 500) return member;
        return err('EXPENSE_NOT_FOUND', 'Expense not found', 404);
      }
      return {
        expense,
        role: member.role
      };
    }
    // Helper: check if settlements exist for group (blocks expense modification).
    //
    // DEFECT 2026-09-19 — `const { count } = ...` discarded the error and
    // `(count || 0) > 0` then evaluated to FALSE on a failed query, so the
    // guard FAILED OPEN: an expense could be edited or deleted after the
    // group's settlements had already been calculated from it, quietly
    // invalidating who owed whom. It now returns the error and callers refuse.
    async function hasSettlements(groupId) {
      const { count, error } = await supabaseAdmin.from('settlements').select('*', {
        count: 'exact',
        head: true
      }).eq('group_id', groupId).in('status', [
        'pending',
        'settled'
      ]);
      if (error) {
        console.error('[expense-tracking] settlements check failed:', error.code, error.message);
        return err('INTERNAL_ERROR', 'Could not check whether settlements exist for this group', 500);
      }
      return (count || 0) > 0;
    }
    /** Resolves the currency for a new expense without inventing one. */ async function resolveCurrency(supplied, tripId) {
      if (typeof supplied === 'string' && supplied.trim()) {
        const c = supplied.trim().toUpperCase();
        if (c.length !== 3) return err('INVALID_CURRENCY', 'Currency must be a 3-letter ISO 4217 code', 400);
        return c;
      }
      // DEFECT 2026-09-19 (fabricated data) — `currency = 'USD'` as a default
      // parameter labelled every unlabelled expense as US dollars. A group
      // splitting costs in euros saw their totals and balances denominated in
      // dollars. The trip's own base currency is consulted first; if that is
      // unknown too, the caller is asked rather than guessed at.
      const { data: trip, error } = await supabaseAdmin.from('trips').select('base_currency').eq('id', tripId).maybeSingle();
      if (error) {
        console.error('[expense-tracking] trip currency lookup failed:', error.code, error.message);
        return err('INTERNAL_ERROR', 'Failed to determine the currency for this expense', 500);
      }
      const base = trip?.base_currency;
      if (base && base.trim().length === 3) return base.trim().toUpperCase();
      return err('CURRENCY_REQUIRED', 'No currency was supplied and this trip has no base currency recorded', 400);
    }
    // ── calculate_splits (preview only, no DB write) ────────────────────────
    if (action === 'calculate_splits') {
      const { groupId, amount, splitMethod, participants, lineItems, customSplits } = body;
      const member = await requireGroupMember(groupId);
      if (member instanceof Response) return member;
      if (!amount || amount <= 0) return err('INVALID_AMOUNT', 'Amount must be positive', 400);
      if (!splitMethod) return err('INVALID_SPLIT_METHOD', 'splitMethod required', 400);
      const memberInfos = await loadGroupMembers(supabaseAdmin, groupId, participants ?? null);
      if (memberInfos instanceof Response) return memberInfos;
      if (memberInfos.length === 0 && (splitMethod === 'equal' || splitMethod === 'proportional')) {
        return err('NO_PARTICIPANTS', 'No active group members matched the participants given', 400);
      }
      let splits = [];
      if (splitMethod === 'equal') {
        splits = splitEqual(memberInfos, amount);
      } else if (splitMethod === 'proportional') {
        const missing = membersMissingBudget(memberInfos);
        if (missing.length > 0) {
          return err('MISSING_BUDGET_PREFERENCE', 'A proportional split weights each person by their recorded budget preference. These members have not recorded one, and assuming a value for them would change what they owe.', 422, {
            members_without_budget_preference: missing
          });
        }
        splits = splitProportional(memberInfos, amount);
      } else if (splitMethod === 'itemized') {
        if (!lineItems?.length) return err('INVALID_SPLITS', 'lineItems required for itemized split', 400);
        splits = splitItemized(lineItems, memberInfos.map((m)=>m.user_id));
      } else if (splitMethod === 'custom') {
        if (!customSplits?.length) return err('INVALID_SPLITS', 'customSplits required for custom split', 400);
        splits = splitCustom(customSplits, amount);
      }
      const totalSplits = splits.reduce((s, x)=>s + x.amount, 0);
      return json({
        splits,
        splitMethod,
        totalSplits: Math.round(totalSplits * 100) / 100
      });
    }
    // ── add_expense ───────────────────────────────────────────────
    if (action === 'add_expense') {
      const { groupId, tripId, description, amount, category = 'other', paidBy, paidAt, splitMethod = 'equal', lineItems, customSplits, receiptUrl, notes } = body;
      // Validation
      if (!groupId || !tripId || !description || !paidBy) return err('INVALID_EXPENSE', 'groupId, tripId, description, paidBy required', 400);
      if (!description || description.length < 1 || description.length > 500) return err('INVALID_DESCRIPTION', 'Description must be 1-500 characters', 400);
      if (!amount || amount <= 0) return err('INVALID_AMOUNT', 'Amount must be positive', 400);
      if (![
        'accommodation',
        'food',
        'transport',
        'activity',
        'other'
      ].includes(category)) return err('INVALID_CATEGORY', 'Invalid category', 400);
      if (![
        'equal',
        'proportional',
        'itemized',
        'custom'
      ].includes(splitMethod)) return err('INVALID_SPLIT_METHOD', 'Invalid split method', 400);
      // Verify caller is active group member
      const callerMember = await requireGroupMember(groupId);
      if (callerMember instanceof Response) return callerMember;
      const currency = await resolveCurrency(body.currency, tripId);
      if (currency instanceof Response) return currency;
      // Verify paidBy is a group member
      const { data: payerMember, error: payerErr } = await supabaseAdmin.from('group_members').select('user_id').eq('group_id', groupId).eq('user_id', paidBy).eq('status', 'active').maybeSingle();
      if (payerErr) {
        console.error('[expense-tracking] payer check failed:', payerErr.code, payerErr.message);
        return err('INTERNAL_ERROR', 'Failed to verify the payer', 500);
      }
      if (!payerMember) return err('INVALID_PAYER', 'Payer must be an active group member', 400);
      // Get active members + preferences
      const memberInfos = await loadGroupMembers(supabaseAdmin, groupId, null);
      if (memberInfos instanceof Response) return memberInfos;
      if (memberInfos.length === 0) {
        return err('NO_PARTICIPANTS', 'This group has no active members to split the expense between', 409);
      }
      // A custom or itemized split may only name people who are in the group.
      // Without this an attacker (or a stale client) writes expense_splits rows
      // for arbitrary user ids, which then show up in that person's balances.
      const memberIdSet = new Set(memberInfos.map((m)=>m.user_id));
      const namedIds = splitMethod === 'custom' ? (customSplits || []).map((s)=>s.user_id) : splitMethod === 'itemized' ? (lineItems || []).flatMap((i)=>i.split_among || []) : [];
      const stranger = namedIds.find((id)=>!memberIdSet.has(id));
      if (stranger) return err('INVALID_SPLIT_MEMBER', 'Splits may only name active group members', 400);
      // Calculate splits
      let splits = [];
      if (splitMethod === 'equal') {
        splits = splitEqual(memberInfos, amount);
      } else if (splitMethod === 'proportional') {
        const missing = membersMissingBudget(memberInfos);
        if (missing.length > 0) {
          return err('MISSING_BUDGET_PREFERENCE', 'A proportional split weights each person by their recorded budget preference. These members have not recorded one, and assuming a value for them would change what they owe.', 422, {
            members_without_budget_preference: missing
          });
        }
        splits = splitProportional(memberInfos, amount);
      } else if (splitMethod === 'itemized') {
        if (!lineItems?.length) return err('INVALID_SPLITS', 'lineItems required for itemized split', 400);
        const itemTotal = lineItems.reduce((s, i)=>s + i.amount, 0);
        if (Math.abs(itemTotal - amount) > 0.01) return err('SPLIT_MISMATCH', `Line items total (${itemTotal}) must equal expense amount (${amount})`, 422, {
          amount,
          splitSum: itemTotal,
          difference: Math.abs(itemTotal - amount)
        });
        splits = splitItemized(lineItems, memberInfos.map((m)=>m.user_id));
      } else if (splitMethod === 'custom') {
        if (!customSplits?.length) return err('INVALID_SPLITS', 'customSplits required for custom split', 400);
        // Check for duplicate users
        const userIds = customSplits.map((s)=>s.user_id);
        if (new Set(userIds).size !== userIds.length) return err('DUPLICATE_SPLIT', 'Each user can only appear once in splits', 409);
        const customTotal = customSplits.reduce((s, x)=>s + x.amount, 0);
        if (Math.abs(customTotal - amount) > 0.01) return err('SPLIT_MISMATCH', `Custom splits total (${customTotal}) must equal expense amount (${amount})`, 422, {
          amount,
          splitSum: customTotal,
          difference: Math.abs(customTotal - amount)
        });
        splits = splitCustom(customSplits, amount);
      }
      // An expense with no splits records a cost nobody owes. Refuse it rather
      // than writing one — this is what the PGRST200 defect above produced.
      if (splits.length === 0) {
        return err('NO_SPLITS_COMPUTED', 'The split calculation produced no shares; the expense was not recorded', 422);
      }
      // Insert expense
      const expenseId = generateId('exp');
      const { data: expense, error: eErr } = await supabaseAdmin.from('expenses').insert({
        id: expenseId,
        group_id: groupId,
        trip_id: tripId,
        description,
        amount,
        currency,
        category,
        paid_by: paidBy,
        paid_at: paidAt || new Date().toISOString(),
        split_method: splitMethod,
        receipt_url: receiptUrl,
        notes
      }).select().single();
      if (eErr) throw eErr;
      // Insert splits (payer's own share auto-settled).
      //
      // DEFECT 2026-09-19 — this insert's error was discarded and the handler
      // returned 201 with `splits: splitRows` regardless, so a failed write
      // produced an expense that everyone could see and nobody owed, with the
      // response listing shares that were never stored. The expense is now
      // rolled back if its splits cannot be written.
      const splitRows = splits.map((s)=>({
          expense_id: expenseId,
          user_id: s.user_id,
          amount: s.amount,
          percentage: s.percentage,
          settled: s.user_id === paidBy
        }));
      const { error: splitsErr } = await supabaseAdmin.from('expense_splits').insert(splitRows);
      if (splitsErr) {
        console.error('[expense-tracking] expense_splits insert failed:', splitsErr.code, splitsErr.message);
        await supabaseAdmin.from('expenses').delete().eq('id', expenseId);
        return err('INTERNAL_ERROR', `Failed to record who owes what; the expense was not saved (${splitsErr.message})`, 500);
      }
      // Insert line items if itemized
      if (splitMethod === 'itemized' && lineItems?.length) {
        const { error: itemsErr } = await supabaseAdmin.from('expense_line_items').insert(lineItems.map((item)=>({
            expense_id: expenseId,
            description: item.description,
            amount: item.amount,
            split_among: item.split_among || []
          })));
        if (itemsErr) {
          console.error('[expense-tracking] expense_line_items insert failed:', itemsErr.code, itemsErr.message);
          await supabaseAdmin.from('expense_splits').delete().eq('expense_id', expenseId);
          await supabaseAdmin.from('expenses').delete().eq('id', expenseId);
          return err('INTERNAL_ERROR', `Failed to record the itemised lines; the expense was not saved (${itemsErr.message})`, 500);
        }
      }
      return json({
        expense: {
          ...expense,
          splits: splitRows
        }
      }, 201);
    }
    // ── get_expenses ───────────────────────────────────────────────
    if (action === 'get_expenses') {
      const { groupId, tripId, category, startDate, endDate, sortBy = 'date', limit = 50, offset = 0 } = body;
      // groupId is now MANDATORY. It used to be optional, and with both groupId
      // and tripId omitted this query returned every expense in the database.
      const member = await requireGroupMember(groupId);
      if (member instanceof Response) return member;
      let query = supabaseAdmin.from('expenses').select(`*, expense_splits(*), expense_line_items(*)`).eq('group_id', groupId).is('deleted_at', null);
      if (tripId) query = query.eq('trip_id', tripId);
      if (category) query = query.eq('category', category);
      if (startDate) query = query.gte('paid_at', startDate);
      if (endDate) query = query.lte('paid_at', endDate);
      const orderCol = sortBy === 'amount' ? 'amount' : 'paid_at';
      const { data, error } = await query.order(orderCol, {
        ascending: false
      }).range(offset, offset + limit - 1);
      if (error) throw error;
      const expenses = data || [];
      const totalAmount = expenses.reduce((s, e)=>s + parseFloat(e.amount), 0);
      const myTotal = expenses.reduce((s, e)=>{
        const mySplit = e.expense_splits?.find((sp)=>sp.user_id === user.id);
        return s + (mySplit ? parseFloat(mySplit.amount) : 0);
      }, 0);
      const myUnsettled = expenses.reduce((s, e)=>{
        const mySplit = e.expense_splits?.find((sp)=>sp.user_id === user.id && !sp.settled);
        return s + (mySplit ? parseFloat(mySplit.amount) : 0);
      }, 0);
      // Category breakdown
      const byCategory = {};
      for (const e of expenses){
        byCategory[e.category] = Math.round(((byCategory[e.category] || 0) + parseFloat(e.amount)) * 100) / 100;
      }
      // These totals mix currencies if the group has recorded expenses in more
      // than one. Naming the currencies present is honest; silently summing
      // them is not.
      const currencies = Array.from(new Set(expenses.map((e)=>e.currency).filter(Boolean)));
      return json({
        expenses,
        summary: {
          total: Math.round(totalAmount * 100) / 100,
          myTotal: Math.round(myTotal * 100) / 100,
          myUnsettled: Math.round(myUnsettled * 100) / 100,
          count: expenses.length,
          byCategory,
          currencies,
          mixed_currencies: currencies.length > 1
        },
        pagination: {
          limit,
          offset,
          total: expenses.length
        }
      });
    }
    // ── get_expense ───────────────────────────────────────────────
    if (action === 'get_expense') {
      const { expenseId } = body;
      const access = await requireExpenseAccess(expenseId);
      if (access instanceof Response) return access;
      const { data, error } = await supabaseAdmin.from('expenses').select(`*, expense_splits(*), expense_line_items(*)`).eq('id', expenseId).is('deleted_at', null).maybeSingle();
      if (error) {
        console.error('[expense-tracking] expense detail read failed:', error.code, error.message);
        return err('INTERNAL_ERROR', 'Failed to load expense', 500);
      }
      if (!data) return err('EXPENSE_NOT_FOUND', 'Expense not found', 404);
      return json({
        expense: data
      });
    }
    // ── update_expense ────────────────────────────────────────────
    if (action === 'update_expense') {
      const { expenseId, description, amount, currency, category, receiptUrl, notes } = body;
      const access = await requireExpenseAccess(expenseId);
      if (access instanceof Response) return access;
      const existing = access.expense;
      // Check settlements guard
      const settled = await hasSettlements(existing.group_id);
      if (settled instanceof Response) return settled;
      if (settled) {
        return err('SETTLEMENT_EXISTS', 'Cannot modify expense after settlements calculated', 409, {
          reason: 'Modifying would require recalculating settlements'
        });
      }
      if (existing.paid_by !== user.id && access.role !== 'organizer') {
        return err('UNAUTHORIZED', 'Only payer or organizer can update expense', 403);
      }
      if (description !== undefined && (description.length < 1 || description.length > 500)) return err('INVALID_DESCRIPTION', 'Description must be 1-500 characters', 400);
      if (amount !== undefined && amount <= 0) return err('INVALID_AMOUNT', 'Amount must be positive', 400);
      if (category !== undefined && ![
        'accommodation',
        'food',
        'transport',
        'activity',
        'other'
      ].includes(category)) return err('INVALID_CATEGORY', 'Invalid category', 400);
      if (currency !== undefined && (typeof currency !== 'string' || currency.trim().length !== 3)) return err('INVALID_CURRENCY', 'Currency must be a 3-letter ISO 4217 code', 400);
      const updates = {
        updated_at: new Date().toISOString()
      };
      if (description !== undefined) updates.description = description;
      if (amount !== undefined) updates.amount = amount;
      if (currency !== undefined) updates.currency = currency.trim().toUpperCase();
      if (category !== undefined) updates.category = category;
      if (receiptUrl !== undefined) updates.receipt_url = receiptUrl;
      if (notes !== undefined) updates.notes = notes;
      // NOTE 2026-09-19: changing `amount` here does NOT recalculate
      // expense_splits, so the shares will no longer add up to the expense.
      // That is pre-existing behaviour and out of scope for this sweep, but it
      // is now at least visible in the response rather than silent.
      const amountChanged = amount !== undefined;
      const { data, error } = await supabaseAdmin.from('expenses').update(updates).eq('id', expenseId).select().single();
      if (error) throw error;
      return json({
        expense: data,
        ...amountChanged ? {
          warning: 'The amount changed but the existing splits were not recalculated; they no longer sum to the expense total.'
        } : {}
      });
    }
    // ── delete_expense ────────────────────────────────────────────
    if (action === 'delete_expense') {
      const { expenseId } = body;
      const access = await requireExpenseAccess(expenseId);
      if (access instanceof Response) return access;
      const existing = access.expense;
      // Check settlements guard
      const settled = await hasSettlements(existing.group_id);
      if (settled instanceof Response) return settled;
      if (settled) {
        return err('SETTLEMENT_EXISTS', 'Cannot delete expense after settlements calculated', 409);
      }
      if (existing.paid_by !== user.id && access.role !== 'organizer') {
        return err('UNAUTHORIZED', 'Only payer or organizer can delete expense', 403);
      }
      // DEFECT 2026-09-19 — the error was discarded and `{ deleted: true }` was
      // returned regardless, so a failed soft-delete told the group the expense
      // was gone while it stayed in their balances. It was also returned with
      // HTTP 204, which has no body by definition, so that payload was
      // discarded by the client anyway; 200 now.
      const { data: deleted, error: deleteErr } = await supabaseAdmin.from('expenses').update({
        deleted_at: new Date().toISOString()
      }).eq('id', expenseId).is('deleted_at', null).select('id');
      if (deleteErr) {
        console.error('[expense-tracking] expense delete failed:', deleteErr.code, deleteErr.message);
        return err('INTERNAL_ERROR', `Failed to delete expense: ${deleteErr.message}`, 500);
      }
      if (!deleted || deleted.length === 0) {
        return err('EXPENSE_NOT_FOUND', 'Expense not found or already deleted', 404);
      }
      return json({
        deleted: true,
        expenseId
      }, 200);
    }
    // ── get_balances ───────────────────────────────────────────────
    if (action === 'get_balances') {
      const { groupId } = body;
      const member = await requireGroupMember(groupId);
      if (member instanceof Response) return member;
      // DEFECT 2026-09-19 — the error was discarded. A failed read produced
      // `expenses = []` and therefore `balances: {}` with HTTP 200: the group
      // was shown that nobody owes anybody anything. On a shared-cost ledger
      // that is the most damaging possible way to fail.
      const { data: expenses, error: balErr } = await supabaseAdmin.from('expenses').select(`id, amount, currency, paid_by, expense_splits(user_id, amount, settled)`).eq('group_id', groupId).is('deleted_at', null);
      if (balErr) {
        console.error('[expense-tracking] balances read failed:', balErr.code, balErr.message);
        return err('INTERNAL_ERROR', 'Failed to load balances', 500);
      }
      const balances = {};
      const currencies = new Set();
      for (const expense of expenses || []){
        if (expense.currency) currencies.add(expense.currency);
        const paidBy = expense.paid_by;
        if (!paidBy) continue;
        if (!balances[paidBy]) balances[paidBy] = 0;
        balances[paidBy] = Math.round((balances[paidBy] + parseFloat(expense.amount)) * 100) / 100;
        for (const split of expense.expense_splits || []){
          if (split.settled) continue;
          if (!balances[split.user_id]) balances[split.user_id] = 0;
          balances[split.user_id] = Math.round((balances[split.user_id] - parseFloat(split.amount)) * 100) / 100;
        }
      }
      return json({
        balances,
        currencies: Array.from(currencies),
        // These balances add amounts together without converting them. Saying
        // so beats presenting a single number that silently mixes currencies.
        mixed_currencies: currencies.size > 1
      });
    }
    // ── mark_settled ───────────────────────────────────────────────
    if (action === 'mark_settled') {
      const { expenseId, userId } = body;
      const access = await requireExpenseAccess(expenseId);
      if (access instanceof Response) return access;
      const expense = access.expense;
      // WHO MAY DECLARE A DEBT PAID.
      //
      // The old code let anyone settle anyone's split. The obvious narrowing —
      // "you can settle your own" — is still wrong, because the debtor
      // confirming their own payment is exactly the abuse: I owe you $40, I
      // call mark_settled on myself, get_balances now shows nothing owed.
      //
      // The person who is owed the money confirms receipt. That is the payer.
      // An organizer may also settle, for the offline case where the payer has
      // left the group or is unreachable.
      const isPayer = expense.paid_by === user.id;
      const isOrganizer = access.role === 'organizer';
      if (!isPayer && !isOrganizer) {
        return err('UNAUTHORIZED', 'Only the person who paid (or a group organizer) can mark a share as settled', 403);
      }
      // The target must actually have a split on THIS expense. Without the
      // expense_id filter plus an existence check, a bad userId silently
      // succeeded and reported `settled: true` having changed nothing.
      const target = userId || user.id;
      const { data: split, error: splitErr } = await supabaseAdmin.from('expense_splits').select('user_id, settled').eq('expense_id', expenseId).eq('user_id', target).maybeSingle();
      if (splitErr) {
        console.error('[expense-tracking] split lookup failed:', splitErr.code, splitErr.message);
        return err('INTERNAL_ERROR', 'Failed to look up that share', 500);
      }
      if (!split) return err('SPLIT_NOT_FOUND', 'That member has no share of this expense', 404);
      // Previously the update's affected-row count was not checked either.
      const { data: updated, error: sErr } = await supabaseAdmin.from('expense_splits').update({
        settled: true,
        settled_at: new Date().toISOString()
      }).eq('expense_id', expenseId).eq('user_id', target).select('user_id');
      if (sErr) throw sErr;
      if (!updated || updated.length === 0) {
        return err('SPLIT_NOT_FOUND', 'That share could not be marked settled', 404);
      }
      return json({
        settled: true,
        expenseId,
        userId: target,
        settledBy: user.id,
        was_already_settled: !!split.settled
      });
    }
    return err('UNKNOWN_ACTION', 'Unknown action', 400);
  } catch (e) {
    console.error('[expense-tracking] unhandled:', e instanceof Error ? e.message : String(e));
    return err('INTERNAL_ERROR', 'Internal server error', 500);
  }
});

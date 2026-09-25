import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json'
    }
  });
}
function err(code, message, status = 400) {
  return json({
    error: code,
    message
  }, status);
}
function fmt(n) {
  return parseFloat(n.toFixed(2));
}
const EPSILON = 0.01;
// Greedy debt-minimization algorithm
function minimizeDebts(balances) {
  const debtors = [];
  const creditors = [];
  for (const [id, bal] of balances){
    const b = fmt(bal);
    if (b < -EPSILON) debtors.push({
      id,
      amount: Math.abs(b)
    });
    else if (b > EPSILON) creditors.push({
      id,
      amount: b
    });
  }
  // Sort descending by amount
  debtors.sort((a, b)=>b.amount - a.amount);
  creditors.sort((a, b)=>b.amount - a.amount);
  const settlements = [];
  let di = 0;
  let ci = 0;
  while(di < debtors.length && ci < creditors.length){
    const d = debtors[di];
    const c = creditors[ci];
    const transfer = fmt(Math.min(d.amount, c.amount));
    if (transfer >= EPSILON) {
      settlements.push({
        from: d.id,
        to: c.id,
        amount: transfer
      });
    }
    d.amount = fmt(d.amount - transfer);
    c.amount = fmt(c.amount - transfer);
    if (d.amount < EPSILON) di++;
    if (c.amount < EPSILON) ci++;
  }
  return settlements;
}
Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: corsHeaders
    });
  }
  const supabase = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: {
      persistSession: false
    }
  });
  // Auth
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return err('UNAUTHORIZED', 'Missing authorization header', 401);
  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return err('UNAUTHORIZED', 'Invalid token', 401);
  let body;
  try {
    body = await req.json();
  } catch  {
    return err('INVALID_BODY', 'Request body must be JSON');
  }
  const { action } = body;
  // SECURITY 2026-09-17 — this function moves money between named people and
  // had four holes.
  //
  //   1. mark_settled required `settlement.from_user === user.id` — from_user
  //      is the DEBTOR. That let the person who owes money declare their own
  //      debt paid with no confirmation from the person owed it: I owe you
  //      $40, I call mark_settled on myself, get_my_settlements now shows I
  //      owe nothing. The party who should confirm a payment was received is
  //      the creditor (to_user), matching the fix already deployed on
  //      expense-tracking's mark_settled (only the payer or an organizer
  //      confirms). An organizer may also settle, for the case where the
  //      creditor has left the group.
  //   2. get_settlements had NO group-membership check at all: any groupId +
  //      tripId, from any signed-in caller, returned that group's full
  //      settlement list — who owes whom and how much.
  //   3. get_balance_summary had the same gap, and additionally joined
  //      group_members to attach each balance's display_name and email —
  //      an unauthenticated-relative-to-this-group caller got the roster's
  //      PII along with the money.
  //   4. get_settlement_history took a bare settlementId with no check that
  //      the caller was a party to that settlement or a member of its group.
  //
  // Also: calculate_settlements and resolve_dispute checked group_members
  // without `status = 'active'`, so a REMOVED member kept the ability to
  // recompute a group's settlements or adjudicate its disputes.
  //
  // The fix is a single requireGroupMember helper (same shape as
  // expense-tracking's), applied to every group-scoped action, plus a
  // requireSettlementParty helper for the two actions that key off a bare
  // settlementId.
  async function requireGroupMember(groupId) {
    if (!groupId) return err('MISSING_PARAMS', 'groupId is required', 400);
    // DEFECT 2026-09-19 — the error was discarded, so a failed membership read
    // told a genuine member "Group not found".
    const { data, error } = await supabase.from('group_members').select('role').eq('group_id', groupId).eq('user_id', user.id).eq('status', 'active').maybeSingle();
    if (error) {
      console.error('[settlement-manager] membership check failed:', error.code, error.message);
      return err('DB_ERROR', 'Failed to check group membership', 500);
    }
    if (!data) return err('NOT_FOUND', 'Group not found', 404);
    return {
      role: data.role ?? 'member'
    };
  }
  /** Resolves a settlement to its group, then requires the caller be a member of it. */ async function requireSettlementAccess(settlementId) {
    if (!settlementId) return err('MISSING_PARAMS', 'settlementId required', 400);
    const { data: settlement, error } = await supabase.from('settlements').select('*').eq('id', settlementId).maybeSingle();
    if (error) {
      console.error('[settlement-manager] settlement lookup failed:', error.code, error.message);
      return err('DB_ERROR', 'Failed to load settlement', 500);
    }
    if (!settlement) return err('NOT_FOUND', 'Settlement not found', 404);
    const member = await requireGroupMember(settlement.group_id);
    if (member instanceof Response) {
      if (member.status === 500) return member;
      return err('NOT_FOUND', 'Settlement not found', 404);
    }
    return {
      settlement,
      role: member.role
    };
  }
  /** Records a status transition, reporting rather than swallowing a failure. */ async function recordHistory(settlementId, statusFrom, statusTo, changeReason) {
    // DEFECT 2026-09-19 — every settlement_history insert in this file
    // discarded its error, so the audit trail for a money transfer could be
    // missing entries with nothing anywhere recording that fact.
    const { error } = await supabase.from('settlement_history').insert({
      settlement_id: settlementId,
      status_from: statusFrom,
      status_to: statusTo,
      changed_by: user.id,
      change_reason: changeReason
    });
    if (error) {
      console.error('[settlement-manager] settlement_history insert failed:', error.code, error.message);
      return false;
    }
    return true;
  }
  // ─── calculate_settlements ──────────────────────────────────────────
  if (action === 'calculate_settlements') {
    const { groupId, tripId, force = false } = body;
    if (!groupId || !tripId) return err('MISSING_PARAMS', 'groupId and tripId required');
    const membership = await requireGroupMember(groupId);
    if (membership instanceof Response) return membership;
    // Check existing settlements.
    //
    // DEFECT 2026-09-19 — the error was discarded, so a failed read made
    // `existing` null, the SETTLEMENTS_EXIST guard never fired, and a second
    // full set of settlements was inserted alongside the first — every debt in
    // the group counted twice.
    const { data: existing, error: existingErr } = await supabase.from('settlements').select('id').eq('trip_id', tripId).eq('group_id', groupId).eq('status', 'pending');
    if (existingErr) {
      console.error('[settlement-manager] existing settlements read failed:', existingErr.code, existingErr.message);
      return err('DB_ERROR', 'Failed to check for existing settlements', 500);
    }
    if (existing && existing.length > 0 && !force) {
      return json({
        error: 'SETTLEMENTS_EXIST',
        existingCount: existing.length
      }, 409);
    }
    // Fetch all expenses for the trip. `currency` is selected because the
    // settlements derived from them must carry the same one — see below.
    const { data: expenses, error: expErr } = await supabase.from('expenses').select('id, paid_by, amount, currency').eq('trip_id', tripId).eq('group_id', groupId).is('deleted_at', null);
    if (expErr) return err('DB_ERROR', expErr.message, 500);
    // Fetch all splits for those expenses
    const expenseIds = (expenses ?? []).map((e)=>e.id);
    let splits = [];
    if (expenseIds.length > 0) {
      const { data: splitData, error: splitErr } = await supabase.from('expense_splits').select('expense_id, user_id, amount').in('expense_id', expenseIds);
      if (splitErr) return err('DB_ERROR', splitErr.message, 500);
      splits = splitData ?? [];
    }
    // DEFECT 2026-09-19 (fabricated data, on the money path) — every settlement
    // row was inserted with a hardcoded `currency: 'USD'`, regardless of what
    // the underlying expenses were actually denominated in. A group splitting
    // costs in euros or yen was handed a settlement list telling each member to
    // pay the other a number of US dollars that was never a dollar figure.
    // The currency is now taken from the expenses the settlement is computed
    // from, and a ledger mixing currencies is refused outright rather than
    // summed into a meaningless single number.
    const currencies = Array.from(new Set((expenses ?? []).map((e)=>e.currency).filter(Boolean)));
    if ((expenses ?? []).length > 0 && currencies.length === 0) {
      return err('CURRENCY_UNKNOWN', 'The expenses for this trip have no currency recorded, so settlements cannot be denominated', 422);
    }
    if (currencies.length > 1) {
      return json({
        error: 'MIXED_CURRENCIES',
        message: 'This trip has expenses in more than one currency. Settling them would require converting between them, which this function does not do.',
        currencies
      }, 422);
    }
    const currency = currencies[0] ?? null;
    // Build net balances
    const balances = new Map();
    for (const expense of expenses ?? []){
      if (!expense.paid_by) continue;
      const prev = balances.get(expense.paid_by) ?? 0;
      balances.set(expense.paid_by, prev + Number(expense.amount));
    }
    for (const split of splits){
      if (!split.user_id) continue;
      const prev = balances.get(split.user_id) ?? 0;
      balances.set(split.user_id, prev - Number(split.amount));
    }
    // Run greedy algorithm
    const computed = minimizeDebts(balances);
    // Delete old pending settlements if force.
    //
    // DEFECT 2026-09-19 — this delete's error was discarded, and the insert
    // below then ran unconditionally. A failed delete left the previous set of
    // pending settlements in place AND added a fresh set, so every member's
    // debt appeared twice and the group was told to pay each other double.
    if (force && existing && existing.length > 0) {
      const { error: deleteErr } = await supabase.from('settlements').delete().eq('trip_id', tripId).eq('group_id', groupId).eq('status', 'pending');
      if (deleteErr) {
        console.error('[settlement-manager] force delete failed:', deleteErr.code, deleteErr.message);
        return err('DB_ERROR', `Could not clear the previous settlements, so no new ones were created: ${deleteErr.message}`, 500);
      }
    }
    // Insert new settlements
    const now = new Date().toISOString();
    const toInsert = computed.map((s)=>({
        id: crypto.randomUUID(),
        group_id: groupId,
        trip_id: tripId,
        from_user: s.from,
        to_user: s.to,
        amount: s.amount,
        currency,
        status: 'pending',
        created_at: now,
        updated_at: now
      }));
    let insertedSettlements = [];
    if (toInsert.length > 0) {
      const { data: inserted, error: insErr } = await supabase.from('settlements').insert(toInsert).select();
      if (insErr) return err('DB_ERROR', insErr.message, 500);
      insertedSettlements = inserted ?? [];
    }
    // Upsert calculation metadata. Previously the error was discarded, so the
    // record of how and when settlements were computed could be silently
    // absent while the settlements themselves existed.
    const { error: calcErr } = await supabase.from('settlement_calculations').upsert({
      trip_id: tripId,
      group_id: groupId,
      calculation_metadata: {
        algorithm: 'greedy',
        version: '1.0',
        calculatedAt: now,
        transactionCount: toInsert.length,
        currency
      }
    }, {
      onConflict: 'trip_id'
    });
    if (calcErr) {
      console.error('[settlement-manager] settlement_calculations upsert failed:', calcErr.code, calcErr.message);
    }
    const totalAmount = fmt(computed.reduce((sum, s)=>sum + s.amount, 0));
    return json({
      settlements: insertedSettlements,
      summary: {
        totalTransactions: toInsert.length,
        totalAmount,
        currency,
        optimized: true,
        timestamp: now,
        calculation_recorded: !calcErr
      }
    });
  }
  // ─── get_settlements ──────────────────────────────────────────────
  if (action === 'get_settlements') {
    const { groupId, tripId, status } = body;
    if (!groupId || !tripId) return err('MISSING_PARAMS', 'groupId and tripId required');
    const membership = await requireGroupMember(groupId);
    if (membership instanceof Response) return membership;
    let query = supabase.from('settlements').select('*').eq('group_id', groupId).eq('trip_id', tripId);
    if (status) query = query.eq('status', status);
    const { data: settlements, error: sErr } = await query.order('created_at', {
      ascending: false
    });
    if (sErr) return err('DB_ERROR', sErr.message, 500);
    const list = settlements ?? [];
    const pendingCount = list.filter((s)=>s.status === 'pending').length;
    const settledCount = list.filter((s)=>s.status === 'settled').length;
    const disputedCount = list.filter((s)=>s.status === 'disputed').length;
    const totalPending = fmt(list.filter((s)=>s.status === 'pending').reduce((sum, s)=>sum + Number(s.amount), 0));
    const currencies = Array.from(new Set(list.map((s)=>s.currency).filter(Boolean)));
    return json({
      settlements: list,
      summary: {
        pendingCount,
        settledCount,
        disputedCount,
        totalPending,
        currencies,
        mixed_currencies: currencies.length > 1
      }
    });
  }
  // ─── get_my_settlements ───────────────────────────────────────────
  if (action === 'get_my_settlements') {
    const { groupId, tripId } = body;
    if (!groupId || !tripId) return err('MISSING_PARAMS', 'groupId and tripId required');
    const membership = await requireGroupMember(groupId);
    if (membership instanceof Response) return membership;
    const { data: settlements, error: sErr } = await supabase.from('settlements').select('*').eq('group_id', groupId).eq('trip_id', tripId).or(`from_user.eq.${user.id},to_user.eq.${user.id}`);
    if (sErr) return err('DB_ERROR', sErr.message, 500);
    const list = settlements ?? [];
    const iOwe = list.filter((s)=>s.from_user === user.id);
    const owedToMe = list.filter((s)=>s.to_user === user.id);
    const totalIOwe = fmt(iOwe.filter((s)=>s.status === 'pending').reduce((sum, s)=>sum + Number(s.amount), 0));
    const totalOwedToMe = fmt(owedToMe.filter((s)=>s.status === 'pending').reduce((sum, s)=>sum + Number(s.amount), 0));
    const currencies = Array.from(new Set(list.map((s)=>s.currency).filter(Boolean)));
    return json({
      iOwe,
      owedToMe,
      totalIOwe,
      totalOwedToMe,
      currencies,
      mixed_currencies: currencies.length > 1
    });
  }
  // ─── mark_settled ─────────────────────────────────────────────────
  if (action === 'mark_settled') {
    const { settlementId, proofUrl, notes, paymentMethod } = body;
    if (!settlementId) return err('MISSING_PARAMS', 'settlementId required');
    const access = await requireSettlementAccess(settlementId);
    if (access instanceof Response) return access;
    const settlement = access.settlement;
    // WHO MAY DECLARE A DEBT PAID: the person who is owed the money (to_user)
    // confirms receipt, or a group organizer can settle on their behalf. The
    // debtor (from_user) cannot self-attest — see the SECURITY note above.
    const isCreditor = settlement.to_user === user.id;
    const isOrganizer = access.role === 'organizer';
    if (!isCreditor && !isOrganizer) {
      return err('FORBIDDEN', 'Only the person owed the money (or a group organizer) can mark a settlement as settled', 403);
    }
    // Previously unchecked: a settlement already settled could be settled again,
    // writing a second history row claiming a pending -> settled transition
    // that had already happened.
    if (settlement.status === 'settled') {
      return json({
        error: 'ALREADY_SETTLED',
        message: 'This settlement is already marked settled'
      }, 409);
    }
    const now = new Date().toISOString();
    const updatePayload = {
      status: 'settled',
      settled_at: now,
      updated_at: now
    };
    if (notes) updatePayload.notes = notes;
    if (proofUrl) updatePayload.proof_url = proofUrl;
    // The status filter makes this a compare-and-set, so two concurrent
    // confirmations cannot both record a transition.
    const { data: updated, error: upErr } = await supabase.from('settlements').update(updatePayload).eq('id', settlementId).neq('status', 'settled').select().maybeSingle();
    if (upErr) return err('DB_ERROR', upErr.message, 500);
    if (!updated) {
      return json({
        error: 'ALREADY_SETTLED',
        message: 'This settlement was settled by someone else first'
      }, 409);
    }
    // Upsert proof if provided. Previously the error was discarded, so the
    // settlement could be marked settled with a proof_url pointing at a record
    // that was never stored.
    let proofStored = null;
    if (proofUrl) {
      const { error: proofErr } = await supabase.from('settlement_proofs').upsert({
        settlement_id: settlementId,
        proof_url: proofUrl,
        uploaded_by: user.id,
        uploaded_at: now
      }, {
        onConflict: 'settlement_id'
      });
      if (proofErr) {
        console.error('[settlement-manager] settlement_proofs upsert failed:', proofErr.code, proofErr.message);
      }
      proofStored = !proofErr;
    }
    // DEFECT 2026-09-19 — this recorded `status_from: 'pending'` unconditionally.
    // A settlement moving from 'disputed' to 'settled' was logged as having
    // come from 'pending', so the audit trail stated a transition that never
    // happened and lost the fact that it had been disputed at all.
    const historyRecorded = await recordHistory(settlementId, settlement.status ?? null, 'settled', paymentMethod ? `Payment method: ${paymentMethod}` : null);
    return json({
      settlement: updated,
      proof_stored: proofStored,
      history_recorded: historyRecorded
    });
  }
  // ─── dispute_settlement ───────────────────────────────────────────
  if (action === 'dispute_settlement') {
    const { settlementId, reason, notes, evidenceUrl } = body;
    if (!settlementId || !reason) return err('MISSING_PARAMS', 'settlementId and reason required');
    const access = await requireSettlementAccess(settlementId);
    if (access instanceof Response) return access;
    const settlement = access.settlement;
    // Either from_user or to_user can dispute
    if (settlement.from_user !== user.id && settlement.to_user !== user.id) {
      return err('FORBIDDEN', 'Only parties to this settlement can dispute it', 403);
    }
    // Cannot dispute an already-settled settlement
    if (settlement.status === 'settled') {
      return json({
        error: 'ALREADY_SETTLED',
        message: 'Cannot dispute a settled settlement'
      }, 409);
    }
    const now = new Date().toISOString();
    const { data: updated, error: upErr } = await supabase.from('settlements').update({
      status: 'disputed',
      dispute_reason: reason,
      updated_at: now
    }).eq('id', settlementId).select().single();
    if (upErr) return err('DB_ERROR', upErr.message, 500);
    // Insert dispute record.
    //
    // DEFECT 2026-09-19 — the error was discarded and the response returned
    // `dispute: undefined` with HTTP 200, leaving the settlement marked
    // 'disputed' with no dispute record for anyone to resolve. The settlement
    // status is rolled back if the record cannot be written.
    const { data: dispute, error: disputeErr } = await supabase.from('settlement_disputes').insert({
      settlement_id: settlementId,
      disputed_by: user.id,
      reason,
      notes: notes ?? null,
      evidence_url: evidenceUrl ?? null
    }).select().single();
    if (disputeErr || !dispute) {
      console.error('[settlement-manager] settlement_disputes insert failed:', disputeErr?.code, disputeErr?.message);
      await supabase.from('settlements').update({
        status: settlement.status,
        dispute_reason: null,
        updated_at: new Date().toISOString()
      }).eq('id', settlementId);
      return err('DB_ERROR', `Could not record the dispute, so the settlement was left unchanged: ${disputeErr?.message ?? 'no row inserted'}`, 500);
    }
    const historyRecorded = await recordHistory(settlementId, settlement.status ?? null, 'disputed', reason);
    return json({
      settlement: updated,
      dispute,
      history_recorded: historyRecorded
    });
  }
  // ─── resolve_dispute ──────────────────────────────────────────────
  if (action === 'resolve_dispute') {
    const { settlementId, resolution, notes, adjustmentAmount } = body;
    if (!settlementId || !resolution) {
      return err('MISSING_PARAMS', 'settlementId and resolution required');
    }
    if (![
      'approved',
      'rejected',
      'split'
    ].includes(resolution)) {
      return err('INVALID_RESOLUTION', 'resolution must be approved, rejected, or split', 400);
    }
    if (adjustmentAmount !== undefined && (typeof adjustmentAmount !== 'number' || !(adjustmentAmount > 0))) {
      // settlements_amount_check requires amount > 0; without this the update
      // failed with 23514 and surfaced as an opaque DB_ERROR.
      return err('INVALID_AMOUNT', 'adjustmentAmount must be a positive number', 400);
    }
    // Auth: only group organizer/admin can resolve — requireSettlementAccess
    // already confirms active group membership; role is enforced below.
    const access = await requireSettlementAccess(settlementId);
    if (access instanceof Response) return access;
    const settlement = access.settlement;
    if (![
      'organizer',
      'planner'
    ].includes(access.role)) {
      return err('FORBIDDEN', 'Only group organizers can resolve disputes', 403);
    }
    const now = new Date().toISOString();
    let newStatus;
    if (resolution === 'approved' || resolution === 'split') {
      newStatus = 'settled';
    } else {
      newStatus = 'pending';
    }
    const updatePayload = {
      status: newStatus,
      updated_at: now
    };
    if (newStatus === 'settled') updatePayload.settled_at = now;
    if (adjustmentAmount !== undefined) updatePayload.amount = fmt(adjustmentAmount);
    const { data: updated, error: upErr } = await supabase.from('settlements').update(updatePayload).eq('id', settlementId).select().single();
    if (upErr) return err('DB_ERROR', upErr.message, 500);
    // Update dispute record. Previously the error was discarded, so a dispute
    // could remain open forever while the settlement showed as resolved.
    const { data: resolvedDisputes, error: disputeErr } = await supabase.from('settlement_disputes').update({
      resolved_at: now,
      resolution_notes: notes ?? null,
      resolved_by: user.id,
      resolution
    }).eq('settlement_id', settlementId).is('resolved_at', null).select('id');
    if (disputeErr) {
      console.error('[settlement-manager] settlement_disputes update failed:', disputeErr.code, disputeErr.message);
    }
    // Previously `status_from: 'disputed'` unconditionally, even when the
    // settlement had not been in that state.
    const historyRecorded = await recordHistory(settlementId, settlement.status ?? null, newStatus, notes ?? `Dispute resolved: ${resolution}`);
    return json({
      settlement: updated,
      disputes_closed: resolvedDisputes?.length ?? 0,
      dispute_update_failed: !!disputeErr,
      history_recorded: historyRecorded
    });
  }
  // ─── get_balance_summary ──────────────────────────────────────────
  if (action === 'get_balance_summary') {
    const { groupId, tripId } = body;
    if (!groupId || !tripId) return err('MISSING_PARAMS', 'groupId and tripId required');
    const membership = await requireGroupMember(groupId);
    if (membership instanceof Response) return membership;
    // Fetch expenses
    const { data: expenses, error: expErr } = await supabase.from('expenses').select('id, paid_by, amount, currency').eq('trip_id', tripId).eq('group_id', groupId).is('deleted_at', null);
    if (expErr) return err('DB_ERROR', expErr.message, 500);
    const expenseIds = (expenses ?? []).map((e)=>e.id);
    let splits = [];
    if (expenseIds.length > 0) {
      // DEFECT 2026-09-19 — this read's error was discarded. With splits empty,
      // every payer appeared fully in credit for everything they had paid and
      // NOBODY appeared to owe anything: a broken query rendered as a balance
      // summary that was wrong in both directions at once.
      const { data: splitData, error: splitErr } = await supabase.from('expense_splits').select('expense_id, user_id, amount').in('expense_id', expenseIds);
      if (splitErr) {
        console.error('[settlement-manager] balance splits read failed:', splitErr.code, splitErr.message);
        return err('DB_ERROR', 'Failed to load expense splits; balances were not calculated', 500);
      }
      splits = splitData ?? [];
    }
    // Build net balances
    const balances = new Map();
    const paid = new Map();
    const owes = new Map();
    for (const expense of expenses ?? []){
      if (!expense.paid_by) continue;
      balances.set(expense.paid_by, (balances.get(expense.paid_by) ?? 0) + Number(expense.amount));
      paid.set(expense.paid_by, (paid.get(expense.paid_by) ?? 0) + Number(expense.amount));
    }
    for (const split of splits){
      if (!split.user_id) continue;
      balances.set(split.user_id, (balances.get(split.user_id) ?? 0) - Number(split.amount));
      owes.set(split.user_id, (owes.get(split.user_id) ?? 0) + Number(split.amount));
    }
    // Fetch display names from group_members
    const userIds = Array.from(balances.keys());
    const memberMap = new Map();
    let namesResolved = true;
    if (userIds.length > 0) {
      const { data: members, error: membersErr } = await supabase.from('group_members').select('user_id, display_name, email').eq('group_id', groupId).in('user_id', userIds);
      if (membersErr) {
        // Not fatal to the money, but the caller should know the names shown
        // are raw ids rather than assume those people have no display name.
        console.error('[settlement-manager] member names read failed:', membersErr.code, membersErr.message);
        namesResolved = false;
      }
      for (const m of members ?? []){
        memberMap.set(m.user_id, m.display_name || m.email || m.user_id);
      }
    }
    const balanceList = Array.from(balances.entries()).map(([userId, net])=>({
        userId,
        displayName: memberMap.get(userId) ?? userId,
        net: fmt(net),
        owed: fmt(paid.get(userId) ?? 0),
        owes: fmt(owes.get(userId) ?? 0)
      }));
    const currencies = Array.from(new Set((expenses ?? []).map((e)=>e.currency).filter(Boolean)));
    return json({
      balances: balanceList,
      currencies,
      mixed_currencies: currencies.length > 1,
      display_names_resolved: namesResolved
    });
  }
  // ─── get_settlement_history ────────────────────────────────────────
  if (action === 'get_settlement_history') {
    const { settlementId } = body;
    if (!settlementId) return err('MISSING_PARAMS', 'settlementId required');
    const access = await requireSettlementAccess(settlementId);
    if (access instanceof Response) return access;
    const { data: history, error: hErr } = await supabase.from('settlement_history').select('*').eq('settlement_id', settlementId).order('created_at', {
      ascending: true
    });
    if (hErr) return err('DB_ERROR', hErr.message, 500);
    return json({
      history: history ?? []
    });
  }
  return err('UNKNOWN_ACTION', `Unknown action: ${action}`);
});

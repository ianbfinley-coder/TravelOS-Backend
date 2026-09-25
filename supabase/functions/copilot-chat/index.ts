import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

// TWO FATAL DEFECTS, 2026-09-19. This function answered 404 to everyone.
//
// 1. THE OWNERSHIP QUERY NAMED COLUMNS THAT DO NOT EXIST.
//
//      .from('trips')
//      .select('id, user_id, destination, start_date, end_date, travelers_count, notes')
//
//    `trips` has no `travelers_count` and no `notes`. PostgREST rejects the
//    WHOLE query with 42703 when a selected column is missing, so `trip` came
//    back null and `tripError` was set on every single request. The next line
//    is `if (tripError || !trip) return 404 'Trip not found'` — so copilot-chat
//    has returned "Trip not found" for every trip, for every user, since those
//    two column names were written. Not a permissions bug; the query never ran.
//    This is the same shape as the `get-trip-readiness` defect of 2026-09-18
//    (`itinerary_data` / `budget_status`), and the reason it survives is always
//    the same: a missing column and an empty result are indistinguishable once
//    the error is discarded or folded into a not-found branch.
//
//    Fixed: select only columns `trips` actually has, and separate the two
//    cases — a query FAILURE is now a 500 that says so, while not-found and
//    not-yours both stay 404 so a caller cannot probe which trip ids exist.
//
// 2. THE TRIP CONTEXT FETCH WAS AUTHENTICATED WITH THE SERVICE-ROLE KEY.
//
//      fetch(contextUrl, { headers: { Authorization: `Bearer ${serviceRoleKey}` } })
//
//    `get-copilot-context` authenticates with `supabase.auth.getUser(jwt)`,
//    which resolves a bearer to a row in auth.users. The service-role key has
//    no `sub` and resolves to nobody, so this returned 401 every time. The
//    `if (contextRes.ok)` guard then left `context` null, and
//    `formatContextForPrompt(null)` returns the string "Trip context
//    unavailable." — which went into the system prompt. Even once defect 1 is
//    fixed, the copilot would have been answering questions about a trip it
//    could not see, and the `catch` that was supposed to fall back to the trip
//    row could not fire, because a 401 is a successful fetch.
//
//    Fixed: forward the CALLER's Authorization header, which is the only
//    credential that endpoint accepts and belongs to a user already proven to
//    own this trip. A non-2xx is logged with its status and body, and the trip
//    row is used as a minimal fallback context so the model at least knows the
//    destination and dates rather than being told nothing is available.
//
// NOT changed, and worth checking separately: every OpenRouter call in this
// file requests model `google/gemini-3.5-flash`. If that id is not valid on
// the account, each call returns non-2xx and the function answers 502 — which
// would have been indistinguishable from the 404 above until now.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// RATE LIMITING 2026-09-20 — this function had no limit of any kind, and it is
// the most expensive endpoint in the project to call. One request makes up to
// THREE OpenRouter completions: the intent classifier, the answer itself, and
// the follow-up suggestions call, all on google/gemini-3.5-flash. The anon key
// that reaches it is embedded in a published browser client, so a signed-in
// caller could sit in a loop and spend the account's OpenRouter credit, and
// nothing here would have slowed them down or left a trace saying so.
//
// 20 requests per 5-minute window, per authenticated user. This is a chat
// feature a human drives one message at a time, so 4 requests a minute
// sustained is already faster than anyone converses: the ceiling is invisible
// to a real user while capping one account at 60 model calls per 5 minutes.
// The window is deliberately wider than a minute — a burst of quick follow-up
// questions is ordinary conversation and should not be punished, but it should
// not be sustainable indefinitely either.
//
// Counting happens inside `public.rate_limit_hit`, which inserts and
// increments in a single statement, so two concurrent requests cannot both
// read the same count and both be let through.
//
// Deliberate choice, copied from platform-trips: the limiter FAILS OPEN when
// the RPC itself errors, but logs at error level with an unmissable prefix.
// Failing closed would turn a limiter outage into a total copilot outage.
// Failing open *silently* is the defect this is written to avoid, so the log
// line is the point rather than a courtesy.
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_SECONDS = 300;
// Must be one of global | strict | user_quota — see rate_limit_buckets_bucket_type_check.
const RATE_LIMIT_BUCKET_TYPE = 'user_quota';

// IP RATE LIMITING 2026-09-20 (Q2.15) — every limit above only starts
// counting once a JWT has been verified as belonging to a real user. A flood
// of requests carrying a syntactically-valid-looking but bogus bearer token
// — or the anon/publishable key itself, which IS a valid JWT — never fails
// to parse, so each one still pays for a full `supabase.auth.getUser(jwt)`
// round trip before the per-user bucket check above can even run. Worse, a
// caller who mints many different garbage subjects gets a fresh per-user
// bucket for each one, so the per-user limit counts nothing against that
// shape of flood.
//
// This gate runs BEFORE any bearer token is looked at, keyed on the caller's
// IP alone, so it caps the cost of running auth verification itself rather
// than the cost of being authenticated. 100 requests per 5-minute window,
// per IP — deliberately generous: many real users can share one IP (NAT, a
// corporate network, mobile carrier CGNAT), so this is not tuned as the
// primary defense against one abusive user — the per-user bucket above
// already is that, once a real identity is established. It exists so one
// source cannot force unlimited auth verifications or mint unlimited
// per-user buckets cheaply.
const IP_RATE_LIMIT_MAX = 100;
const IP_RATE_LIMIT_WINDOW_SECONDS = 300;
// Must be one of global | strict | user_quota — see rate_limit_buckets_bucket_type_check.
const IP_RATE_LIMIT_BUCKET_TYPE = 'strict';

// Supabase Edge Functions sit behind a gateway that sets x-forwarded-for,
// which may be a comma-separated chain (client, then any intermediate
// proxies) — the first entry is the client's own address. Falls back to a
// constant so a missing header can never throw.
function getClientIp(req: Request): string {
  const forwardedFor = req.headers.get('x-forwarded-for');
  if (!forwardedFor) return 'unknown';
  const first = forwardedFor.split(',')[0]?.trim();
  return first || 'unknown';
}

// ── Types ────────────────────────────────────────────────────────────────
interface AlertContext {
  alert_id: string;
  alert_type?: string;
  priority?: 'INFO' | 'LOW' | 'HIGH' | 'CRITICAL';
  urgency?: string;
  confidence?: string;
  title?: string;
  summary?: string;
  explanation?: string;
  affected_entities?: Array<{ type: string; description: string }>;
  recommended_next_step_type?: string;
  monitoring_event_id?: string | null;
  primary_impact_id?: string | null;
  impact?: Record<string, unknown> | null;
  trip_id?: string;
  itinerary_version_id?: string | null;
  alert_title?: string;
  alert_summary?: string;
  alert_priority?: string;
  alert_urgency?: string;
  alert_confidence?: string;
  affected_reservations?: any[];
  affected_itinerary_items?: any[];
  protected_items?: any[];
  constraints?: any[];
}

interface ProposalSummary {
  id: string;
  goal: string;
  what_will_change: string;
  what_will_stay: string;
  why_recommended: string;
  trade_offs: any[];
  expected_result: string;
  confidence: string;
  affected_items: any[];
  status: string;
}

// ── Safe failure logger — never throws ───────────────────────────────────
async function logRecovery(
  supabaseUrl: string,
  serviceRoleKey: string,
  params: {
    user_id?: string;
    trip_id?: string;
    operation: string;
    related_object_type?: string;
    related_object_id?: string;
    failure_type: string;
    failure_message?: string;
    failure_detail?: Record<string, unknown>;
  }
): Promise<string | null> {
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/pipeline-recovery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${serviceRoleKey}` },
      body: JSON.stringify({ action: 'log_failure', ...params }),
    });
    if (res.ok) {
      const data = await res.json();
      return data.recovery_log_id ?? null;
    }
    console.error(`[copilot-chat] pipeline-recovery ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return null;
  } catch (e) {
    console.error('[copilot-chat] pipeline-recovery unreachable:', e instanceof Error ? e.message : String(e));
    return null;
  }
}

// ── Proposal intent detection ──────────────────────────────────────────
const PROPOSAL_PHRASES = [
  'fix this', 'what are my options', 'how can i fix', 'make this work',
  'protect my', 'change my plan', 'what should i do', 'help me fix',
  'rebook', 'reschedule', 'adjust my itinerary', 'what can i do',
  'how do i fix', 'what do i do', 'give me options', 'show me options',
  'suggest a fix', 'suggest changes', 'what changes', 'help me with this',
  'what would you recommend', 'recommend a fix', 'fix my trip',
];

const APPROVAL_PHRASES = [
  'apply this plan', 'yes make this change', 'do it', 'apply it',
  'yes do it', 'confirm', 'go ahead', 'execute', 'apply the plan',
  'make the change', 'yes please', "let's do it", 'lets do it',
  'sounds good', 'looks good', 'approved', 'yes apply', 'apply changes',
  'make it happen', 'proceed', 'yes confirm',
];

function isProposalRequest(message: string): boolean {
  const lower = message.toLowerCase();
  return PROPOSAL_PHRASES.some(p => lower.includes(p));
}

function isApprovalMessage(message: string): boolean {
  const lower = message.toLowerCase().trim();
  return APPROVAL_PHRASES.some(p => lower.includes(p));
}

// ── Alert context helpers ────────────────────────────────────────────
function buildAlertSystemPromptSection(
  alertCtx: AlertContext,
  impact: Record<string, unknown> | null,
  alertStale: boolean
): string {
  const title = alertCtx.alert_title ?? alertCtx.title ?? 'Unknown Alert';
  const summary = alertCtx.alert_summary ?? alertCtx.summary ?? '';
  const priority = alertCtx.alert_priority ?? alertCtx.priority ?? 'UNKNOWN';
  const urgency = alertCtx.alert_urgency ?? alertCtx.urgency ?? 'UNKNOWN';
  const confidence = alertCtx.alert_confidence ?? alertCtx.confidence ?? 'UNKNOWN';
  const alertType = alertCtx.alert_type ?? 'TRAVEL_ALERT';
  const affectedEntities = alertCtx.affected_entities ?? [];

  const lines: string[] = [];
  lines.push('=== ALERT CONTEXT ===');
  lines.push('The traveler opened this conversation from a Travel Alert. Do NOT ask them to repeat this information.');
  lines.push('');
  lines.push(`ALERT: ${title}`);
  lines.push(`TYPE: ${alertType}`);
  lines.push(`PRIORITY: ${priority}`);
  lines.push(`URGENCY: ${urgency}`);
  lines.push(`CONFIDENCE: ${confidence}`);
  lines.push('');
  lines.push('WHAT CHANGED (CONFIRMED FACT):');
  lines.push(summary);

  if (alertCtx.explanation) {
    lines.push('');
    lines.push('ADDITIONAL CONTEXT:');
    lines.push(alertCtx.explanation);
  }

  if (affectedEntities.length > 0) {
    lines.push('');
    lines.push('WHAT MAY BE AFFECTED:');
    for (const entity of affectedEntities) {
      lines.push(`- ${entity.type}: ${entity.description}`);
    }
  }

  if (alertCtx.affected_reservations && alertCtx.affected_reservations.length > 0) {
    lines.push('');
    lines.push('AFFECTED RESERVATIONS:');
    for (const r of alertCtx.affected_reservations) {
      lines.push(`- ${r.type ?? 'reservation'}: ${r.title ?? r.name ?? r.id}${r.confirmation_number ? ' (Conf: ' + r.confirmation_number + ')' : ''}`);
    }
  }

  if (alertCtx.protected_items && alertCtx.protected_items.length > 0) {
    lines.push('');
    lines.push('PROTECTED ITEMS (must not be changed):');
    for (const p of alertCtx.protected_items) {
      lines.push(`- ${typeof p === 'string' ? p : JSON.stringify(p)}`);
    }
  }

  if (impact) {
    lines.push('');
    lines.push('TRIP IMPACT ANALYSIS:');
    lines.push(`- Impact Level: ${impact.impact_level ?? 'UNKNOWN'}`);
    lines.push(`- Impact Type: ${impact.impact_type ?? 'UNKNOWN'}`);
    lines.push(`- Explanation: ${impact.explanation ?? 'N/A'}`);
    const evidence = impact.evidence as unknown[] | null;
    if (evidence && evidence.length > 0) {
      lines.push(`- Evidence: ${evidence.map((e: unknown) => (typeof e === 'string' ? e : JSON.stringify(e))).join(', ')}`);
    }
    lines.push(`- Confidence: ${impact.confidence ?? 'UNKNOWN'}`);
  }

  if (alertStale) {
    lines.push('');
    lines.push('⚠️ NOTE: This alert may no longer be current. Acknowledge this uncertainty.');
  }

  lines.push('');
  lines.push('INSTRUCTIONS FOR THIS CONVERSATION:');
  lines.push('1. Begin by acknowledging the alert and explaining WHAT CHANGED, WHY IT MATTERS, and WHAT CAN WE DO?');
  lines.push('2. Clearly distinguish CONFIRMED FACTS from POTENTIAL IMPACTS from UNKNOWN/VERIFY items.');
  lines.push('3. If confidence is LOW or UNKNOWN, explicitly communicate uncertainty.');
  lines.push('4. Respect all confirmed reservations, must-do activities, and traveler constraints.');
  lines.push('5. You may explain, analyze, and discuss options. Do NOT automatically change the itinerary.');
  lines.push('6. If the traveler asks for a solution, generate a structured proposal. Do NOT execute it.');
  lines.push('=== END ALERT CONTEXT ===');

  return lines.join('\n');
}

function buildAlertOpeningInstruction(alertCtx: AlertContext): string {
  const confidence = alertCtx.alert_confidence ?? alertCtx.confidence ?? 'UNKNOWN';
  return `
This is the FIRST message in the conversation. The traveler opened the Copilot from a Travel Alert.
Generate a structured opening message in this EXACT format:

WHAT CHANGED
[Confirmed fact from the alert summary — be specific, do not hedge confirmed facts]

WHY IT MATTERS
[Explain the impact on THIS traveler's specific trip — reference their actual reservations, itinerary days, and plans]

WHAT CAN WE DO?
[Brief overview of 2-3 options without committing to any — keep it concise and actionable]

IMPORTANT: If confidence is "${confidence}" and it is LOW or UNKNOWN, use hedging language throughout ("may", "could", "we're not certain yet"). Do NOT invent facts not in the context.
`;
}

function buildAlertSuggestions(alertCtx: AlertContext): string[] {
  const suggestions = [
    'What does this mean for my trip?',
    'What are my options?',
    'Which reservations are affected?',
    'How urgent is this?',
  ];
  const entities = alertCtx.affected_entities ?? [];
  if (entities.length > 0) {
    suggestions.push(`Help me protect my ${entities[0].type.toLowerCase()}`);
  } else {
    suggestions.push('Help me protect my plans');
  }
  return suggestions;
}

// ── Trip context formatter ───────────────────────────────────────────
function formatContextForPrompt(context: any): string {
  if (!context || context.error) return 'Trip context unavailable.';
  const lines: string[] = [];

  const trip = context.trip;
  if (trip) {
    lines.push('=== TRIP OVERVIEW ===');
    lines.push(`Destination: ${trip.destination || 'Unknown'}`);
    lines.push(`Dates: ${trip.start_date || 'TBD'} to ${trip.end_date || 'TBD'}`);
    if (trip.travelers_count != null) lines.push(`Travelers: ${trip.travelers_count}`);
    if (trip.notes) lines.push(`Notes: ${trip.notes}`);
  }

  const itinerary = context.itinerary;
  if (itinerary) {
    lines.push('');
    lines.push('=== ITINERARY ===');
    if (itinerary.name) lines.push(`Plan: ${itinerary.name}`);
    const days = context.days || [];
    if (days.length > 0) {
      lines.push(`Duration: ${days.length} day(s)`);
      days.slice(0, 10).forEach((day: any) => {
        lines.push(`Day ${day.day_number} (${day.date || 'TBD'}): ${day.title || ''}`);
        const items = day.items || [];
        items.slice(0, 5).forEach((item: any) => {
          lines.push(`  - [${item.category || 'activity'}] ${item.title}${item.start_time ? ' at ' + item.start_time : ''}${item.location ? ' @ ' + item.location : ''}${item.cost ? ' ($' + item.cost + ')' : ''}`);
        });
      });
    }
  }

  const reservations = context.reservations || [];
  if (reservations.length > 0) {
    lines.push('');
    lines.push('=== RESERVATIONS ===');
    reservations.slice(0, 10).forEach((r: any) => {
      lines.push(`- ${r.type || 'reservation'}: ${r.title || r.name}${r.confirmation_number ? ' (Conf: ' + r.confirmation_number + ')' : ''}${r.date ? ' on ' + r.date : ''}${r.status ? ' [' + r.status + ']' : ''}`);
    });
  }

  const health = context.health;
  if (health) {
    lines.push('');
    lines.push('=== TRIP HEALTH ===');
    lines.push(`Score: ${health.score ?? 'N/A'}/100 — Status: ${health.status || 'unknown'}`);
  }

  const budget = context.budget;
  if (budget) {
    lines.push('');
    lines.push('=== BUDGET ===');
    lines.push(`Total: $${budget.total_budget ?? 'N/A'} | Spent: $${budget.total_spent ?? 0} | Remaining: $${budget.remaining ?? 'N/A'}`);
  }

  if (context.partial) {
    lines.push('');
    lines.push('NOTE: Only the basic trip record could be loaded. The itinerary, health, friction and budget detail are NOT available for this conversation — say so if the traveler asks about them, and do not estimate.');
  }

  return lines.join('\n');
}

// ── Helpers ───────────────────────────────────────────────────────────
const CANCEL_PHRASES = [
  'cancel', 'never mind', 'nevermind', 'forget it', 'keep it as is',
  'keep it as-is', 'leave it', "don't change", 'no change', 'ignore that',
  'disregard', 'scratch that',
];

function isCancellation(message: string): boolean {
  const lower = message.toLowerCase().trim();
  return CANCEL_PHRASES.some(phrase => lower.includes(phrase));
}

function extractProposalIdFromHistory(conversationHistory: any[]): string | null {
  for (let i = conversationHistory.length - 1; i >= 0; i--) {
    const msg = conversationHistory[i];
    if (msg?.role === 'assistant' && msg?.proposal_id) return msg.proposal_id;
    if (msg?.role === 'assistant' && typeof msg?.content === 'string') {
      const match = msg.content.match(/"proposal_id"\s*:\s*"([a-f0-9-]{36})"/);
      if (match) return match[1];
    }
  }
  return null;
}

// FIX 2026-09-21: this selected a nonexistent `source` column and filtered
// on `status = 'ACTIVE'`. itinerary_versions.status is a free-text field
// whose real values are lowercase ('ready', 'ready_with_notes',
// 'needs_review', ...) — there is no 'ACTIVE' status. The actual "is this
// the current version" flag is the boolean `is_active` column, which is
// exactly what change-plan's own stale-version check already uses. With the
// old column/filter this call always returned zero rows (or errored on the
// missing column), so every staleness check and baseVersionId resolution
// that depended on it silently saw "no active version" — always false, never
// actually stale, and every proposal's base version resolved to null.
async function getActiveItineraryVersion(supabase: any, tripId: string): Promise<any | null> {
  const { data, error } = await supabase
    .from('itinerary_versions')
    .select('id, version_number, status, is_active')
    .eq('trip_id', tripId)
    .eq('is_active', true)
    .maybeSingle();
  if (error) console.error('[copilot-chat] itinerary_versions read failed:', error.message);
  return data ?? null;
}

// ── Proposal generation ───────────────────────────────────────────────
async function generateProposal(
  supabase: any,
  openrouterKey: string,
  userId: string,
  tripId: string,
  message: string,
  alertCtx: AlertContext,
  alertImpact: Record<string, unknown> | null,
  contextFormatted: string,
  itineraryVersionId: string | null
): Promise<{ proposal: ProposalSummary | null; aiMessage: string; proposalId: string | null }> {
  const title = alertCtx.alert_title ?? alertCtx.title ?? 'Travel Alert';
  const summary = alertCtx.alert_summary ?? alertCtx.summary ?? '';
  const priority = alertCtx.alert_priority ?? alertCtx.priority ?? 'UNKNOWN';
  const affectedReservations = alertCtx.affected_reservations ?? [];
  const protectedItems = alertCtx.protected_items ?? alertCtx.constraints ?? [];

  const proposalSystemPrompt = `You are TravelOS, an expert AI travel planner generating a structured change proposal.

ALERT CONTEXT:
- Alert: ${title}
- Priority: ${priority}
- Summary: ${summary}
- Impact: ${alertImpact ? JSON.stringify(alertImpact) : 'N/A'}
- Affected Reservations: ${JSON.stringify(affectedReservations)}
- Protected Items (MUST NOT CHANGE): ${JSON.stringify(protectedItems)}

TRIP CONTEXT:
${contextFormatted}

Traveler's request: "${message}"

Generate a structured proposal. Respond ONLY with valid JSON (no markdown, no code fences):
{
  "goal": "one sentence describing the overall goal",
  "proposed_changes": [
    {
      "type": "MOVE|REMOVE|ADD|REPLACE|REBOOK|RESCHEDULE|ADJUST_TIME",
      "id": "item id if known or null",
      "name": "item name",
      "change_description": "plain language description of this specific change"
    }
  ],
  "protected_items": ["list of items that will NOT be changed"],
  "trade_offs": [
    { "pro": "benefit", "con": "downside or risk" }
  ],
  "expected_result": "plain language description of the outcome",
  "confidence": "HIGH|MEDIUM|LOW",
  "what_will_change": "2-3 sentence human-readable summary of what changes",
  "what_will_stay": "1-2 sentence summary of what stays the same / is protected",
  "why_recommended": "1-2 sentence rationale for this approach",
  "affected_items": [
    { "type": "reservation|itinerary_item|activity", "id": "id or null", "name": "name", "change_description": "what happens to this item" }
  ],
  "ai_message": "The full conversational message to show the traveler, structured as:\n\nWHAT WILL CHANGE\n[summary]\n\nWHAT WILL STAY THE SAME\n[summary]\n\nWHY THIS FIX IS RECOMMENDED\n[rationale]\n\nTRADE-OFFS\n[pros and cons]\n\nEXPECTED RESULT\n[outcome]"
}`;

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${openrouterKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://travelos.app',
      'X-Title': 'TravelOS Copilot',
    },
    body: JSON.stringify({
      model: 'google/gemini-3.5-flash',
      // FIX 2026-09-22: same defect class as the action-planning call below —
      // no response_format and a max_tokens ceiling (1500) too low for this
      // schema's biggest field (ai_message, a full structured multi-section
      // write-up) plus everything else. A truncated/malformed reply threw in
      // JSON.parse and the raw model text was handed back as `aiMessage`,
      // which is what the traveler sees.
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: proposalSystemPrompt }],
      max_tokens: 3000,
      temperature: 0.3,
    }),
  });

  if (!res.ok) {
    console.error('[copilot-chat] proposal generation failed:', res.status, (await res.text()).slice(0, 300));
    return { proposal: null, aiMessage: "I couldn't generate a proposal right now. Please try again.", proposalId: null };
  }

  const data = await res.json();
  const rawContent = data.choices?.[0]?.message?.content ?? '{}';

  let parsed: any = {};
  try {
    const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
    parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
  } catch (e) {
    // FIX 2026-09-22: was `aiMessage: rawContent` — surfaced the raw,
    // possibly truncated JSON text to the traveler. Never do that.
    console.error('[copilot-chat] failed to parse proposal JSON:', e instanceof Error ? e.message : String(e), '| raw (first 500 chars):', rawContent.slice(0, 500));
    return { proposal: null, aiMessage: "I wasn't able to put together a clean proposal for that just now — please try again.", proposalId: null };
  }

  const activeVersion = await getActiveItineraryVersion(supabase, tripId);
  const baseVersionId = itineraryVersionId ?? activeVersion?.id ?? null;

  let proposalId: string | null = null;
  // FIX 2026-09-22: this insert named five columns that do not exist on
  // copilot_proposals — goal, protected_items, trade_offs, expected_result,
  // impact_id (singular; the real column is impact_ids, an array). Every
  // single insert here failed with a schema-cache error (logged, never
  // surfaced), so `proposalId` was ALWAYS null and no alert-driven proposal
  // has ever actually been persisted. That in turn means the later
  // "approve this change" step had no row to look up and execute against.
  // Real columns: interpreted_goal, preserved_constraints, expected_effects
  // (jsonb — trade_offs has no column at all, so it isn't persisted here),
  // impact_ids (array).
  const { data: saved, error: saveErr } = await supabase
    .from('copilot_proposals')
    .insert({
      user_id: userId,
      trip_id: tripId,
      alert_id: alertCtx.alert_id ?? null,
      monitoring_event_id: alertCtx.monitoring_event_id ?? null,
      impact_ids: alertCtx.primary_impact_id ? [alertCtx.primary_impact_id] : [],
      itinerary_version_id: baseVersionId,
      base_itinerary_version_id: baseVersionId,
      user_request: message,
      interpreted_goal: parsed.goal ?? message,
      proposed_changes: parsed.proposed_changes ?? [],
      preserved_constraints: parsed.protected_items ?? protectedItems,
      expected_effects: { summary: parsed.expected_result ?? '', trade_offs: parsed.trade_offs ?? [] },
      confidence: parsed.confidence ?? 'MEDIUM',
      what_will_change: parsed.what_will_change ?? '',
      what_will_stay: parsed.what_will_stay ?? '',
      why_recommended: parsed.why_recommended ?? '',
      affected_items: parsed.affected_items ?? [],
      // FIX 2026-09-22: 'PENDING' is not a value copilot_proposals.status
      // allows (see the CHECK constraint note in executeProposal below) —
      // this insert has always been rejected outright. 'READY_FOR_REVIEW' is
      // both a real allowed value and matches the state this proposal is
      // actually in right after being generated.
      status: 'READY_FOR_REVIEW',
      stale_checked_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (!saveErr && saved) {
    proposalId = saved.id;
  } else {
    console.error('[copilot-chat] failed to save proposal:', saveErr?.message);
  }

  const proposalSummary: ProposalSummary = {
    id: proposalId ?? '',
    goal: parsed.goal ?? '',
    what_will_change: parsed.what_will_change ?? '',
    what_will_stay: parsed.what_will_stay ?? '',
    why_recommended: parsed.why_recommended ?? '',
    trade_offs: parsed.trade_offs ?? [],
    expected_result: parsed.expected_result ?? '',
    confidence: parsed.confidence ?? 'MEDIUM',
    affected_items: parsed.affected_items ?? [],
    status: 'PENDING',
  };

  return {
    proposal: proposalSummary,
    // FIX 2026-09-22: was `parsed.ai_message ?? rawContent` — the same
    // raw-JSON-leak defect as the parse-failure branches above. If the model
    // omits ai_message (valid JSON, missing field, e.g. from a schema slip),
    // this used to hand back the whole raw JSON blob as the chat message.
    aiMessage: parsed.ai_message ?? "Here's the proposal I put together — see the details below.",
    proposalId,
  };
}

// ── Proposal approval / execution ───────────────────────────────────────
async function executeProposal(
  supabase: any,
  supabaseUrl: string,
  serviceRoleKey: string,
  proposalId: string,
  userId: string,
  tripId: string
): Promise<{
  executed: boolean;
  stale?: boolean;
  failed?: boolean;
  new_version_id?: string;
  message: string;
}> {
  const { data: proposal, error: fetchErr } = await supabase
    .from('copilot_proposals')
    .select('*')
    .eq('id', proposalId)
    .eq('user_id', userId)
    .maybeSingle();

  if (fetchErr) console.error('[copilot-chat] copilot_proposals read failed:', fetchErr.message);
  if (fetchErr || !proposal) {
    return { executed: false, failed: true, message: 'Proposal not found.' };
  }

  // FIX 2026-09-22: was `proposal.status !== 'PENDING'` — 'PENDING' is not
  // one of the values copilot_proposals.status actually allows (confirmed
  // against its CHECK constraint: DRAFT, READY_FOR_REVIEW, APPROVED,
  // EXECUTING, EXECUTED, FAILED, CANCELLED, STALE, COMPLETE). Every insert
  // that tried to write 'PENDING' was rejected by Postgres outright (caught
  // live: "violates check constraint copilot_proposals_status_check"), so
  // proposalId was always null and this function could never find a
  // proposal to execute in the first place.
  if (proposal.status !== 'READY_FOR_REVIEW') {
    const statusMsg: Record<string, string> = {
      DRAFT: 'This proposal still needs clarification before it can be applied.',
      STALE: 'This proposal is stale — the itinerary has changed. Please request a new proposal.',
      APPROVED: 'This proposal has already been approved.',
      EXECUTING: 'This proposal is already being executed.',
      EXECUTED: 'This proposal has already been applied.',
      COMPLETE: 'This proposal has already been applied.',
      FAILED: 'This proposal previously failed. Please request a new proposal.',
      CANCELLED: 'This proposal was cancelled. Please request a new proposal.',
    };
    return {
      executed: false,
      failed: true,
      message: statusMsg[proposal.status] ?? `Proposal is in ${proposal.status} state and cannot be executed.`,
    };
  }

  const activeVersion = await getActiveItineraryVersion(supabase, tripId);
  const currentActiveVersionId = activeVersion?.id ?? null;
  const baseVersionId = proposal.base_itinerary_version_id ?? proposal.itinerary_version_id ?? null;

  if (baseVersionId && currentActiveVersionId && currentActiveVersionId !== baseVersionId) {
    await supabase
      .from('copilot_proposals')
      .update({ status: 'STALE', updated_at: new Date().toISOString() })
      .eq('id', proposalId);

    return {
      executed: false,
      stale: true,
      message: 'The itinerary has changed since this proposal was created. Let me refresh the context.',
    };
  }

  // FIX 2026-09-22: proposal.protected_items / proposal.goal read columns
  // that don't exist on copilot_proposals (see the insert-side fix above) —
  // real columns are preserved_constraints / interpreted_goal.
  const protectedItems = proposal.preserved_constraints ?? [];
  if (Array.isArray(protectedItems) && protectedItems.length > 0) {
    const reservationIds = protectedItems
      .filter((p: any) => typeof p === 'object' && p.type === 'reservation' && p.id)
      .map((p: any) => p.id);

    if (reservationIds.length > 0) {
      const { data: existingReservations, error: resErr } = await supabase
        .from('reservations')
        .select('id, reservation_status')
        .in('id', reservationIds);

      if (resErr) {
        console.error('[copilot-chat] protected reservation check failed:', resErr.message);
        return {
          executed: false,
          failed: true,
          message: 'Your protected reservations could not be verified, so nothing was changed.',
        };
      }

      const existingIds = new Set((existingReservations ?? []).map((r: any) => r.id));
      const missing = reservationIds.filter((id: string) => !existingIds.has(id));
      if (missing.length > 0) {
        return {
          executed: false,
          failed: true,
          message: `Some protected reservations no longer exist (${missing.length} missing). Please request a new proposal.`,
        };
      }
    }
  }

  await supabase
    .from('copilot_proposals')
    .update({ status: 'EXECUTING', updated_at: new Date().toISOString() })
    .eq('id', proposalId);

  const changeRequest = `${proposal.interpreted_goal} ${JSON.stringify(proposal.proposed_changes)}`;
  let changePlanResult: any = null;
  let changePlanError: string | null = null;
  let changePlanStatus: number | null = null;

  try {
    const changePlanRes = await fetch(`${supabaseUrl}/functions/v1/change-plan`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
      // FIX 2026-09-21: change-plan requires `user_request` (not
      // `change_request`) and — as of the itinerary_items MVP rewrite — no
      // longer accepts or needs `itinerary_id` at all; `trip_id` alone
      // identifies the target. The old body sent `change_request` and omitted
      // `itinerary_id` (back when it was still required), which meant this
      // call got a guaranteed 400 from change-plan on every single approval —
      // "yes, do it" in the chat has never actually applied a change.
      body: JSON.stringify({
        trip_id: tripId,
        user_id: userId,
        user_request: changeRequest,
        itinerary_version_id: baseVersionId,
        constraints: proposal.preserved_constraints ?? [],
        alert_id: proposal.alert_id ?? null,
        proposal_id: proposalId,
      }),
    });

    changePlanStatus = changePlanRes.status;

    if (changePlanRes.ok) {
      changePlanResult = await changePlanRes.json();
    } else {
      const errText = await changePlanRes.text();
      changePlanError = errText;
      console.error('[copilot-chat] change-plan error:', changePlanStatus, errText.slice(0, 300));
    }
  } catch (e: any) {
    changePlanError = e?.message ?? 'Unknown error';
    console.error('[copilot-chat] change-plan exception:', e);
  }

  if (changePlanStatus === 409) {
    await supabase
      .from('copilot_proposals')
      .update({ status: 'STALE', updated_at: new Date().toISOString() })
      .eq('id', proposalId);

    return {
      executed: false,
      stale: true,
      message: 'The itinerary has changed since this proposal was created. Let me refresh the context.',
    };
  }

  if (changePlanError || !changePlanResult || changePlanResult.error) {
    const reason = changePlanError ?? changePlanResult?.error ?? 'Unknown failure';

    await supabase
      .from('copilot_proposals')
      .update({
        status: 'FAILED',
        failure_reason: reason,
        updated_at: new Date().toISOString(),
      })
      .eq('id', proposalId);

    await logRecovery(supabaseUrl, serviceRoleKey, {
      user_id: userId,
      trip_id: tripId,
      operation: 'ITINERARY_CHANGE',
      related_object_type: 'copilot_proposal',
      related_object_id: proposalId,
      failure_type: 'PROCESSING_FAILED',
      failure_message: 'The change could not be applied',
      failure_detail: { error: reason, proposal_id: proposalId },
    });

    return {
      executed: false,
      failed: true,
      message: 'The change could not be applied. Your original itinerary is unchanged.',
    };
  }

  const newVersionId = changePlanResult.itinerary_version_id ?? changePlanResult.new_version_id ?? null;

  await supabase
    .from('copilot_proposals')
    .update({
      status: 'COMPLETE',
      result_itinerary_version_id: newVersionId,
      executed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', proposalId);

  if (newVersionId) {
    await supabase
      .from('itinerary_versions')
      .update({ proposal_id: proposalId })
      .eq('id', newVersionId);
  }

  if (proposal.alert_id) {
    await supabase
      .from('travel_alerts')
      .update({ copilot_proposal_id: proposalId })
      .eq('id', proposal.alert_id);
  }

  return {
    executed: true,
    new_version_id: newVersionId,
    message: `Your itinerary has been updated successfully. ${changePlanResult.message ?? ''}`.trim(),
  };
}

// ── Rate limit ────────────────────────────────────────────────────────
// Records one request against the caller's bucket and reports whether it is
// within the limit. See the RATE LIMITING note at the top for the numbers and
// for why this fails open rather than closed.
//
// `retryAfter` is whatever the function reports as remaining in the window it
// actually used, never a constant: a hardcoded value drifts out of step with
// the window the moment either is changed, and then tells the caller to come
// back at a time that is simply wrong.
async function checkRateLimit(
  supabase: ReturnType<typeof createClient>,
  bucketKey: string,
): Promise<{ allowed: boolean; retryAfter: number }> {
  const { data, error } = await supabase.rpc('rate_limit_hit', {
    p_bucket_key: bucketKey,
    p_bucket_type: RATE_LIMIT_BUCKET_TYPE,
    p_limit: RATE_LIMIT_MAX,
    p_window_seconds: RATE_LIMIT_WINDOW_SECONDS,
  });

  if (error) {
    console.error('[copilot-chat] RATE LIMIT NOT ENFORCED — rate_limit_hit failed:', error.message);
    return { allowed: true, retryAfter: 0 };
  }

  const row = (Array.isArray(data) ? data[0] : data) as
    { is_allowed?: boolean; hits?: number; retry_after_seconds?: number } | null | undefined;

  if (!row || typeof row.is_allowed !== 'boolean') {
    console.error('[copilot-chat] RATE LIMIT NOT ENFORCED — rate_limit_hit returned no usable row');
    return { allowed: true, retryAfter: 0 };
  }

  if (!row.is_allowed) {
    console.warn(`[copilot-chat] rate limited ${bucketKey} at ${row.hits} hits (limit ${RATE_LIMIT_MAX})`);
  }

  return {
    allowed: row.is_allowed,
    retryAfter: typeof row.retry_after_seconds === 'number'
      ? row.retry_after_seconds
      : RATE_LIMIT_WINDOW_SECONDS,
  };
}

// ── IP rate limit (Q2.15) ────────────────────────────────────────────
// Same shape and same fail-open-loudly behavior as checkRateLimit above, but
// against the IP bucket and with a log prefix that distinguishes it from a
// per-user block in the logs.
async function checkIpRateLimit(
  supabase: ReturnType<typeof createClient>,
  bucketKey: string,
): Promise<{ allowed: boolean; retryAfter: number }> {
  const { data, error } = await supabase.rpc('rate_limit_hit', {
    p_bucket_key: bucketKey,
    p_bucket_type: IP_RATE_LIMIT_BUCKET_TYPE,
    p_limit: IP_RATE_LIMIT_MAX,
    p_window_seconds: IP_RATE_LIMIT_WINDOW_SECONDS,
  });

  if (error) {
    console.error('[copilot-chat] RATE LIMIT NOT ENFORCED (ip) — rate_limit_hit failed:', error.message);
    return { allowed: true, retryAfter: 0 };
  }

  const row = (Array.isArray(data) ? data[0] : data) as
    { is_allowed?: boolean; hits?: number; retry_after_seconds?: number } | null | undefined;

  if (!row || typeof row.is_allowed !== 'boolean') {
    console.error('[copilot-chat] RATE LIMIT NOT ENFORCED (ip) — rate_limit_hit returned no usable row');
    return { allowed: true, retryAfter: 0 };
  }

  if (!row.is_allowed) {
    console.warn(`[copilot-chat] IP rate limited ${bucketKey} at ${row.hits} hits (limit ${IP_RATE_LIMIT_MAX})`);
  }

  return {
    allowed: row.is_allowed,
    retryAfter: typeof row.retry_after_seconds === 'number'
      ? row.retry_after_seconds
      : IP_RATE_LIMIT_WINDOW_SECONDS,
  };
}

// ── Main handler ──────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const openrouterKey = Deno.env.get('OPENROUTER_API_KEY')!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // IP RATE LIMIT GATE (Q2.15) — runs before any bearer token is even
    // looked at, let alone verified. See the IP RATE LIMITING note above.
    const clientIp = getClientIp(req);
    const ipRate = await checkIpRateLimit(supabase, `copilot-chat:ip:${clientIp}`);
    if (!ipRate.allowed) {
      return new Response(JSON.stringify({ error: 'Too many requests' }), {
        status: 429,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
          'Retry-After': String(Math.max(1, ipRate.retryAfter)),
        },
      });
    }

    // Auth
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const jwt = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(jwt);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Gated here, before the body is even read: everything past this point
    // costs either a database round trip or an OpenRouter call.
    //
    // The bucket is keyed on `user.id` — the subject of the JWT that was just
    // verified — and never on anything from the request body. A body-supplied
    // identity would let a caller mint a fresh bucket per request and walk
    // straight past the limit. The `copilot-chat:` prefix keeps this namespace
    // clear of every other function's buckets in the shared table.
    const { allowed, retryAfter } = await checkRateLimit(supabase, `copilot-chat:user:${user.id}`);
    if (!allowed) {
      return new Response(JSON.stringify({ error: 'Too many requests' }), {
        status: 429,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
          'Retry-After': String(Math.max(1, retryAfter)),
        },
      });
    }

    let body: Record<string, unknown>;
    try { body = await req.json(); } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const {
      trip_id,
      itinerary_id,
      message,
      conversation_history = [],
      active_proposal_id,
      alert_context,
    }: {
      trip_id: string;
      itinerary_id?: string;
      message: string;
      conversation_history?: any[];
      active_proposal_id?: string;
      alert_context?: AlertContext;
    } = body as any;

    if (!trip_id || !message) {
      return new Response(JSON.stringify({ error: 'trip_id and message are required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Verify trip ownership.
    // Only columns `trips` actually has. The old list included
    // `travelers_count` and `notes`, which do not exist — PostgREST rejected
    // the whole query with 42703 and every caller got "Trip not found".
    const { data: trip, error: tripError } = await supabase
      .from('trips')
      .select('id, user_id, name, title, destination, start_date, end_date, primary_tz, status')
      .eq('id', trip_id)
      .maybeSingle();

    // A failed query and an absent trip are different problems and must not
    // share a response. The first is ours; the second is the caller's.
    if (tripError) {
      console.error('[copilot-chat] trips read failed:', tripError.message);
      return new Response(JSON.stringify({ error: 'Trip lookup failed' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Not-found and not-yours share a 404 so a caller cannot probe trip ids.
    if (!trip || trip.user_id !== user.id) {
      return new Response(JSON.stringify({ error: 'Trip not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── Alert context enrichment ─────────────────────────────────────────
    let enrichedAlertCtx: AlertContext | null = null;
    let alertImpact: Record<string, unknown> | null = null;
    let alertStale = false;

    if (alert_context?.alert_id) {
      const { data: alertRow, error: alertErr } = await supabase
        .from('travel_alerts')
        .select('*')
        .eq('id', alert_context.alert_id)
        .eq('trip_id', trip_id)
        .maybeSingle();

      if (alertErr) console.error('[copilot-chat] travel_alerts read failed:', alertErr.message);
      if (!alertRow || alertRow.status !== 'ACTIVE') {
        alertStale = true;
      }

      const primaryImpactId = alert_context.primary_impact_id ?? alertRow?.primary_impact_id ?? null;
      if (primaryImpactId) {
        const { data: impactRow, error: impactErr } = await supabase
          .from('trip_impacts')
          .select('*')
          .eq('id', primaryImpactId)
          .maybeSingle();
        if (impactErr) console.error('[copilot-chat] trip_impacts read failed:', impactErr.message);
        if (impactRow) alertImpact = impactRow as Record<string, unknown>;
      }

      enrichedAlertCtx = {
        ...alert_context,
        impact: alertImpact,
        alert_title: alert_context.alert_title ?? alertRow?.title,
        alert_summary: alert_context.alert_summary ?? alertRow?.summary,
        alert_priority: alert_context.alert_priority ?? alertRow?.priority,
        alert_urgency: alert_context.alert_urgency ?? alertRow?.urgency,
        alert_confidence: alert_context.alert_confidence ?? alertRow?.confidence,
        affected_entities: alert_context.affected_entities ?? alertRow?.affected_entities,
        monitoring_event_id: alert_context.monitoring_event_id ?? alertRow?.monitoring_event_id,
        primary_impact_id: alert_context.primary_impact_id ?? alertRow?.primary_impact_id,
      };
    }

    // Fast path: cancellation
    if (isCancellation(message)) {
      return new Response(
        JSON.stringify({
          message: "No problem, your itinerary hasn't been changed.",
          mode: 'cancelled',
          proposal: null,
          suggestions: [],
          context_used: { itinerary_available: false, health_available: false, friction_available: false, issues_available: false },
          trip_id,
          itinerary_id: itinerary_id ?? null,
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── Fetch trip context ──────────────────────────────────────────────
    // The caller's own header, not the service-role key: get-copilot-context
    // authenticates with auth.getUser(), which the service-role key fails.
    // The caller has already been proven to own this trip.
    let context: any = null;
    let contextUsed = {
      itinerary_available: false,
      health_available: false,
      friction_available: false,
      issues_available: false,
    };

    const contextUrl = `${supabaseUrl}/functions/v1/get-copilot-context?trip_id=${encodeURIComponent(trip_id)}${itinerary_id ? `&itinerary_id=${encodeURIComponent(itinerary_id)}` : ''}`;

    try {
      const contextRes = await fetch(contextUrl, { headers: { Authorization: authHeader } });
      if (contextRes.ok) {
        context = await contextRes.json();
        contextUsed = {
          itinerary_available: !!(context.itinerary || context.days?.length > 0),
          health_available: !!context.health,
          friction_available: !!(context.friction?.days?.length > 0),
          issues_available: !!(context.issues?.length > 0),
        };
      } else {
        console.error(`[copilot-chat] get-copilot-context ${contextRes.status}: ${(await contextRes.text()).slice(0, 300)}`);
        context = { trip, partial: true };
      }
    } catch (e) {
      console.error('[copilot-chat] get-copilot-context unreachable:', e instanceof Error ? e.message : String(e));
      context = { trip, partial: true };
    }

    const today = new Date().toISOString().split('T')[0];
    const destination = trip.destination || context?.trip?.destination || 'your destination';
    const contextFormatted = formatContextForPrompt(context);
    const isFirstMessage = conversation_history.length === 0;

    // ── APPROVAL PATH ──────────────────────────────────────────────────
    const resolvedProposalId = active_proposal_id ?? extractProposalIdFromHistory(conversation_history);

    if (isApprovalMessage(message) && resolvedProposalId) {
      const result = await executeProposal(
        supabase,
        supabaseUrl,
        serviceRoleKey,
        resolvedProposalId,
        user.id,
        trip_id
      );

      return new Response(
        JSON.stringify({
          message: result.message,
          mode: result.stale ? 'stale' : result.executed ? 'executed' : 'failed',
          executed: result.executed,
          stale: result.stale ?? false,
          failed: result.failed ?? false,
          new_version_id: result.new_version_id ?? null,
          proposal: null,
          suggestions: enrichedAlertCtx ? buildAlertSuggestions(enrichedAlertCtx) : [],
          context_used: contextUsed,
          trip_id,
          itinerary_id: itinerary_id ?? null,
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── PROPOSAL GENERATION PATH ─────────────────────────────────────────
    if (enrichedAlertCtx && isProposalRequest(message)) {
      const { proposal, aiMessage, proposalId } = await generateProposal(
        supabase,
        openrouterKey,
        user.id,
        trip_id,
        message,
        enrichedAlertCtx,
        alertImpact,
        contextFormatted,
        itinerary_id ?? alert_context?.itinerary_version_id ?? null
      );

      return new Response(
        JSON.stringify({
          message: aiMessage,
          mode: 'proposal',
          proposal: proposal ? { ...proposal, id: proposalId ?? proposal.id } : null,
          executed: false,
          stale: false,
          failed: false,
          suggestions: [
            'Apply this plan',
            'Show me other options',
            'What are the trade-offs?',
            'What stays the same?',
          ],
          context_used: contextUsed,
          trip_id,
          itinerary_id: itinerary_id ?? null,
          alert_stale: alertStale,
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── ACTION PLANNING PATH (non-alert) ────────────────────────────────────
    const classifyRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openrouterKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://travelos.app',
        'X-Title': 'TravelOS Copilot',
      },
      body: JSON.stringify({
        model: 'google/gemini-3.5-flash',
        messages: [
          {
            role: 'user',
            content: `Classify this message as "information", "action", "approval", or "cancel":\n- "information": asking about the trip, requesting analysis\n- "action": requesting a change, modification, addition, removal\n- "approval": explicitly approving/confirming a previously proposed change\n- "cancel": cancelling/rejecting a proposal\n\nExamples:\n"What's on day 2?" -> information\n"Move my dinner to 7pm" -> action\n"Reschedule the museum visit to 2pm" -> action\n"Yes, do it" -> approval\n"Never mind" -> cancel\n\nMessage: "${message.replace(/"/g, '\\"')}"\n\nReply with ONLY one word: information, action, approval, or cancel.`,
          },
        ],
        // FIX 2026-09-22: caught live returning an empty content string at
        // max_tokens: 5 and again at 10 — this model appears to spend part
        // of the budget on hidden reasoning/formatting before the visible
        // word, so a tiny ceiling starves the actual answer. 30 gives it
        // room; the keyword-heuristic fallback right below still covers a
        // genuinely empty or unparseable reply either way.
        max_tokens: 30,
        temperature: 0,
      }),
    });

    // FIX 2026-09-22: caught live — a real "move X to Y" request fell all
    // the way through to the default 'information' mode (which tells the
    // model "do NOT modify the itinerary"), producing a flat refusal even
    // though the item existed and a proposal should have been generated.
    // No error was logged for that request, meaning the classifier call
    // succeeded but returned text that didn't cleanly start with
    // action/approval/cancel — and this silently fell back to
    // 'information', a hard decline, with nothing recorded to diagnose it.
    // Two changes: (1) log the raw classifier text whenever it doesn't match
    // one of the three non-default keywords, so a repeat is diagnosable, and
    // (2) never let classifier flakiness default to a decline — fall back to
    // a keyword heuristic that treats an unclassified message as 'action'
    // when it contains an obvious change verb, since silently refusing a
    // real request is worse than occasionally over-triggering the proposal
    // path (which itself explains its findings before touching anything).
    const ACTION_VERB_PATTERN = /\b(move|change|reschedule|shift|adjust|modify|update|add|remove|delete|cancel|swap|replace|switch|push|delay|bump|book|rebook)\b/i;
    let messageMode: 'information' | 'action' | 'approval' | 'cancel' = 'information';
    if (classifyRes.ok) {
      const classifyData = await classifyRes.json();
      const classifyText = (classifyData.choices?.[0]?.message?.content ?? '').toLowerCase().trim();
      if (classifyText.startsWith('action')) messageMode = 'action';
      else if (classifyText.startsWith('approval')) messageMode = 'approval';
      else if (classifyText.startsWith('cancel')) messageMode = 'cancel';
      else if (classifyText.startsWith('information')) messageMode = 'information';
      else {
        console.error('[copilot-chat] classifier returned unrecognized text, falling back to keyword heuristic:', JSON.stringify(classifyText).slice(0, 200));
        messageMode = isCancellation(message) ? 'cancel' : isApprovalMessage(message) ? 'approval' : ACTION_VERB_PATTERN.test(message) ? 'action' : 'information';
      }
    } else {
      console.error('[copilot-chat] classifier failed, falling back to keyword heuristic:', classifyRes.status, (await classifyRes.text()).slice(0, 200));
      messageMode = isCancellation(message) ? 'cancel' : isApprovalMessage(message) ? 'approval' : ACTION_VERB_PATTERN.test(message) ? 'action' : 'information';
    }

    if (enrichedAlertCtx && isFirstMessage) messageMode = 'information';

    // ── CANCEL ─────────────────────────────────────────────────────────
    if (messageMode === 'cancel') {
      return new Response(
        JSON.stringify({
          message: "No problem, your itinerary hasn't been changed.",
          mode: 'cancelled',
          proposal: null,
          suggestions: [],
          context_used: contextUsed,
          trip_id,
          itinerary_id: itinerary_id ?? null,
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── ACTION PLANNING (non-alert) ────────────────────────────────────────
    if (messageMode === 'action') {
      const alertPreamble = enrichedAlertCtx
        ? `${buildAlertSystemPromptSection(enrichedAlertCtx, alertImpact, alertStale)}\n\n`
        : '';

      const actionSystemPrompt = `${alertPreamble}You are TravelOS, an expert AI travel planner. The traveler wants to make a change to their trip.

Your job is to:
1. Understand their intent
2. Identify what would need to change
3. Generate a structured proposal (DO NOT apply any changes)
4. Protect confirmed reservations and must-do activities
5. Explain tradeoffs clearly

CRITICAL RULES:
- Do NOT modify the itinerary
- Do NOT book anything
- Do NOT cancel anything
- If a confirmed reservation conflicts, explain it and work around it
- If the request is ambiguous, ask ONE clarifying question
- If multiple solutions exist, offer up to 3 options
- Never invent prices, times, distances, or availability

TRIP CONTEXT:
${contextFormatted}

Today's date: ${today}

Respond in this exact JSON format (no markdown, no code fences, raw JSON only):
{
  "response_message": "conversational response to the user",
  "proposal_status": "READY_FOR_REVIEW" | "REQUIRES_CLARIFICATION" | "NOT_FEASIBLE",
  "interpreted_goal": "one sentence describing what the user wants",
  "clarification_question": "string or null",
  "affected_days": [1, 3],
  "proposed_changes": [],
  "preserved_constraints": [],
  "expected_effects": { "friction_change": "UNKNOWN", "pace_change": "UNKNOWN", "walking_change": "UNKNOWN", "budget_change": "UNKNOWN", "summary": "" },
  "warnings": [],
  "options": [],
  "confidence": "HIGH" | "MEDIUM" | "LOW",
  "before_snapshot": { "day_number": null, "activity_count": null, "friction_score": null, "friction_status": null, "pace": null },
  "suggestions": []
}`;

      const actionRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${openrouterKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://travelos.app',
          'X-Title': 'TravelOS Copilot',
        },
        body: JSON.stringify({
          model: 'google/gemini-3.5-flash',
          messages: [
            { role: 'system', content: actionSystemPrompt },
            ...conversation_history.slice(-10),
            { role: 'user', content: message },
          ],
          // FIX 2026-09-22: was max_tokens: 1200 with no response_format.
          // Once get-copilot-context started returning real itinerary data
          // (see that function's 2026-09-22 rewrite), this prompt's context
          // block got long enough that the model's structured reply — which
          // has ~13 fields including a free-text response_message — routinely
          // ran past 1200 tokens and got cut off mid-JSON. JSON.parse then
          // threw, and the catch fallback below used to hand the raw,
          // truncated JSON text straight to the traveler as if it were the
          // chat reply. response_format forces the API to return valid JSON
          // outright (matching change-plan's own OpenRouter calls); the
          // higher ceiling gives the full structured object room to finish.
          response_format: { type: 'json_object' },
          max_tokens: 3000,
          temperature: 0.3,
        }),
      });

      if (!actionRes.ok) {
        console.error('[copilot-chat] OpenRouter action error:', actionRes.status, (await actionRes.text()).slice(0, 300));
        return new Response(
          JSON.stringify({ error: "I'm having trouble connecting right now. Please try again." }),
          { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const actionData = await actionRes.json();
      const rawContent = actionData.choices?.[0]?.message?.content ?? '{}';

      let proposal: any = {};
      try {
        const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
        proposal = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
      } catch (parseErr) {
        // FIX 2026-09-22: this used to set `response_message: rawContent` —
        // handing the traveler the literal (often truncated, half-written)
        // JSON the model produced, which is what showed up verbatim in the
        // chat log. A parse failure here means the model's own reply is
        // broken; never forward broken model output as if it were a chat
        // message. Log it for debugging and tell the traveler plainly that
        // this attempt didn't work, instead.
        console.error(
          '[copilot-chat] action-planning JSON parse failed:', parseErr instanceof Error ? parseErr.message : String(parseErr),
          '| raw (first 500 chars):', rawContent.slice(0, 500)
        );
        proposal = {
          response_message: "I wasn't able to put together a clean proposal for that just now — could you try rephrasing the request, or asking again?",
          proposal_status: 'NOT_FEASIBLE',
          interpreted_goal: message,
          clarification_question: null,
          affected_days: [],
          proposed_changes: [],
          preserved_constraints: [],
          expected_effects: { friction_change: 'UNKNOWN', pace_change: 'UNKNOWN', walking_change: 'UNKNOWN', budget_change: 'UNKNOWN', summary: '' },
          warnings: [],
          options: [],
          confidence: 'LOW',
          before_snapshot: null,
          suggestions: [],
        };
      }

      const proposalStatus = proposal.proposal_status ?? 'NOT_FEASIBLE';
      let proposalId: string | null = null;

      if (proposalStatus === 'READY_FOR_REVIEW' || proposalStatus === 'REQUIRES_CLARIFICATION') {
        const activeVersion = await getActiveItineraryVersion(supabase, trip_id);
        const baseVersionId = itinerary_id ?? activeVersion?.id ?? null;

        // FIX 2026-09-22: this is the exact failure caught live in the edge
        // logs — "Could not find the 'expected_result' column of
        // 'copilot_proposals' in the schema cache". goal, protected_items,
        // trade_offs and expected_result are not real columns (confirmed
        // against information_schema.columns); every insert here has always
        // failed, so proposalId was always null and no plain-chat proposal
        // has ever been persisted for later approval. Real columns:
        // interpreted_goal, preserved_constraints, expected_effects (jsonb —
        // trade_offs has no column and isn't persisted), plus affected_days /
        // warnings / options, which were being silently dropped too.
        const { data: savedProposal, error: saveError } = await supabase
          .from('copilot_proposals')
          .insert({
            user_id: user.id,
            trip_id,
            itinerary_version_id: baseVersionId,
            base_itinerary_version_id: baseVersionId,
            user_request: message,
            interpreted_goal: proposal.interpreted_goal ?? message,
            affected_days: proposal.affected_days ?? [],
            proposed_changes: proposal.proposed_changes ?? [],
            preserved_constraints: proposal.preserved_constraints ?? [],
            expected_effects: proposal.expected_effects ?? {},
            warnings: proposal.warnings ?? [],
            options: proposal.options ?? [],
            confidence: proposal.confidence ?? 'MEDIUM',
            what_will_change: proposal.expected_effects?.summary ?? '',
            what_will_stay: (proposal.preserved_constraints ?? []).join(', '),
            why_recommended: '',
            affected_items: [],
            // FIX 2026-09-22: 'PENDING' is not a value copilot_proposals.status
            // allows — caught live in the edge logs ("violates check
            // constraint copilot_proposals_status_check"). This insert has
            // been failing on every single call, so proposalId was always
            // null and there was never anything for "yes, do it" to execute.
            // 'READY_FOR_REVIEW' is a real allowed value and matches this
            // proposalStatus case exactly (this insert only runs for
            // READY_FOR_REVIEW or REQUIRES_CLARIFICATION); DRAFT is the
            // closest real status for the clarification case, since the
            // proposal isn't actually ready to execute yet.
            status: proposalStatus === 'READY_FOR_REVIEW' ? 'READY_FOR_REVIEW' : 'DRAFT',
            alert_id: enrichedAlertCtx?.alert_id ?? null,
            stale_checked_at: new Date().toISOString(),
          })
          .select('id')
          .single();

        if (!saveError && savedProposal) proposalId = savedProposal.id;
        else console.error('[copilot-chat] failed to save action proposal:', saveError?.message);
      }

      return new Response(
        JSON.stringify({
          message: proposal.response_message ?? "I've analyzed your request.",
          mode: 'action_planning',
          proposal: {
            proposal_id: proposalId,
            status: proposalStatus,
            interpreted_goal: proposal.interpreted_goal ?? '',
            clarification_question: proposal.clarification_question ?? null,
            affected_days: proposal.affected_days ?? [],
            proposed_changes: proposal.proposed_changes ?? [],
            preserved_constraints: proposal.preserved_constraints ?? [],
            expected_effects: proposal.expected_effects ?? {},
            warnings: proposal.warnings ?? [],
            options: proposal.options ?? [],
            confidence: proposal.confidence ?? 'MEDIUM',
            before_snapshot: proposal.before_snapshot ?? null,
          },
          suggestions: proposal.suggestions ?? (enrichedAlertCtx ? buildAlertSuggestions(enrichedAlertCtx) : []),
          context_used: contextUsed,
          trip_id,
          itinerary_id: itinerary_id ?? null,
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── INFORMATION (default) ──────────────────────────────────────────────
    const alertSystemSection = enrichedAlertCtx
      ? buildAlertSystemPromptSection(enrichedAlertCtx, alertImpact, alertStale)
      : null;

    let systemPrompt: string;
    if (enrichedAlertCtx && alertSystemSection) {
      const openingInstruction = isFirstMessage ? buildAlertOpeningInstruction(enrichedAlertCtx) : '';
      systemPrompt = `${alertSystemSection}\n\n${openingInstruction}You are TravelOS, an expert AI travel assistant helping a traveler with a Travel Alert affecting their trip.

RULES:
- Answer ONLY using the trip information provided
- Clearly distinguish CONFIRMED FACTS from POTENTIAL IMPACTS from UNKNOWN/VERIFY items
- Do NOT modify the itinerary, book anything, or cancel anything
- Be concise, practical, and conversational

TRIP CONTEXT:
${contextFormatted}

Today's date: ${today}`;
    } else {
      systemPrompt = `You are TravelOS, an expert AI travel assistant helping a traveler with their specific trip.

RULES:
- Answer ONLY using the trip information provided below
- Do NOT invent prices, travel times, distances, availability, or any facts not in the context
- Do NOT modify the itinerary, book anything, cancel anything, or perform any actions
- Be concise, practical, and conversational
- When information is unavailable, say so clearly rather than guessing

TRIP CONTEXT:
${contextFormatted}

Today's date: ${today}`;
    }

    const aiRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openrouterKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://travelos.app',
        'X-Title': 'TravelOS Copilot',
      },
      body: JSON.stringify({
        model: 'google/gemini-3.5-flash',
        messages: [
          { role: 'system', content: systemPrompt },
          ...conversation_history.slice(-10),
          { role: 'user', content: message },
        ],
        max_tokens: 800,
        temperature: 0.3,
      }),
    });

    if (!aiRes.ok) {
      console.error('[copilot-chat] OpenRouter error:', aiRes.status, (await aiRes.text()).slice(0, 300));
      return new Response(
        JSON.stringify({ error: "I'm having trouble connecting right now. Please try again." }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const aiData = await aiRes.json();
    const aiMessage = aiData.choices?.[0]?.message?.content ?? "I'm having trouble connecting right now. Please try again.";

    let suggestions: string[] = enrichedAlertCtx ? buildAlertSuggestions(enrichedAlertCtx) : [];
    if (!enrichedAlertCtx) {
      try {
        const suggestRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${openrouterKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://travelos.app',
            'X-Title': 'TravelOS Copilot',
          },
          body: JSON.stringify({
            model: 'google/gemini-3.5-flash',
            messages: [{
              role: 'user',
              content: `Based on this conversation about a trip to ${destination}, suggest 2-3 short follow-up questions the traveler might want to ask next. Return as a JSON array of strings only, no explanation. Keep each under 8 words.`,
            }],
            max_tokens: 150,
            temperature: 0.5,
          }),
        });
        if (suggestRes.ok) {
          const suggestData = await suggestRes.json();
          const raw = suggestData.choices?.[0]?.message?.content ?? '[]';
          const match = raw.match(/\[.*\]/s);
          if (match) suggestions = JSON.parse(match[0]);
        } else {
          console.error('[copilot-chat] suggestions call failed:', suggestRes.status);
        }
      } catch (e) {
        console.error('[copilot-chat] suggestions call threw:', e instanceof Error ? e.message : String(e));
      }
    }

    return new Response(
      JSON.stringify({
        message: aiMessage,
        mode: 'information',
        proposal: null,
        suggestions,
        context_used: contextUsed,
        trip_id,
        itinerary_id: itinerary_id ?? null,
        alert_stale: enrichedAlertCtx ? alertStale : undefined,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('[copilot-chat] unhandled error:', err);
    return new Response(
      JSON.stringify({ error: "I'm having trouble connecting right now. Please try again." }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

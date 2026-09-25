// 2026-09-25 — getProfileVector with overrides but no learned profile (wave 6b).
// A traveller who had set explicit overrides (PATCH /profile/overrides) but
// had no learned context yet got NO_PROFILE, i.e. the preferences they had
// typed in themselves were ignored by every consumer. Now: with no scored
// context but at least one override, the vector is built on the neutral base
// (0 — the same default a missing feature already had) with the overrides
// applied, and the response says `basis: 'overrides_only'` so a caller can tell
// it apart from a learned vector. No overrides and no context is still
// NO_PROFILE. supabase-js import switched from jsr: to esm.sh (standing rule).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { timingSafeEqual, corsHeaders } from "./_shared/auth.ts";
// ---------------------------------------------------------------------------
// Constants & Taxonomy
// ---------------------------------------------------------------------------
const TAXONOMY_FEATURES = [
  'food.local_traditional',
  'food.fine_dining',
  'food.street_food',
  'food.cafes',
  'food.vegetarian_friendly',
  'culture.art_museums',
  'culture.history',
  'culture.architecture',
  'culture.performing_arts',
  'culture.religious_sites',
  'outdoors.hiking',
  'outdoors.beach',
  'outdoors.parks_gardens',
  'outdoors.viewpoints',
  'outdoors.water_sports',
  'nightlife.bars',
  'nightlife.clubs',
  'nightlife.live_music',
  'shopping.markets',
  'shopping.boutiques',
  'shopping.malls',
  'wellness.spa',
  'wellness.fitness',
  'family.kid_friendly',
  'style.price_level',
  'style.crowd_tolerance',
  'style.pace',
  'style.walking',
  'style.early_bird',
  'style.novelty',
  'style.local_vs_iconic',
  'style.planning',
  'style.ambience_small'
];
const TAXONOMY_SET = new Set(TAXONOMY_FEATURES);
const K = 5;
const HALF_LIFE_MONTHS = 18;
const VALID_CONTEXTS = [
  'all',
  'solo',
  'couple',
  'friends',
  'family',
  'business'
];
const VALID_KINDS = [
  'onboarding_answer',
  'rated',
  'kept',
  'removed',
  'rec_accepted',
  'rec_dismissed',
  'thumbs',
  'spent',
  'search',
  'past_trip_rating'
];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// ---------------------------------------------------------------------------
// Supabase client (service role)
// ---------------------------------------------------------------------------
function getServiceClient() {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  return createClient(url, key, {
    auth: {
      persistSession: false
    }
  });
}
// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------
async function getUserId(req) {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const client = createClient(url, anonKey, {
    auth: {
      persistSession: false
    },
    global: {
      headers: {
        Authorization: `Bearer ${token}`
      }
    }
  });
  const { data: { user }, error } = await client.auth.getUser();
  if (error || !user) return null;
  return user.id;
}
// NOTE 2026-09-20 (identity axis — settled for two of these three tables).
// This supersedes a 2026-09-19 note here that described all three user_id
// columns as TEXT and the whole axis as unsettled. That is no longer true of
// two of them. It is corrected rather than left standing because a note that
// is confidently wrong costs a later pass more than no note at all.
//
// Checked against the live schema on 2026-09-20 via pg_constraint and
// pg_class, not inferred:
//
//   traveler_profiles.user_id  uuid, FK -> auth.users(id) ON DELETE CASCADE
//   profile_signals.user_id    uuid, FK -> auth.users(id) ON DELETE CASCADE
//
// Both have RLS enabled with per-user policies. For these two the old note's
// fear — this function and the rest of the platform keeping two disjoint sets
// of rows for one person, one keyed by auth.uid() and one by a "usr_<hex>"
// platform id — can no longer happen quietly: a "usr_" id is not a uuid, so
// it is rejected as a 22P02 at the database instead of being stored. The raw
// auth.uid() this function has always written is the only thing that fits.
// That is also why the service route below validates its body userId against
// UUID_RE before it reaches a query: to turn that 22P02 into an honest 422.
//
// STILL OPEN — onboarding_completions.user_id is TEXT, with no FK and no uuid
// constraint. Nothing above settles it, and the old note's concern survives
// there intact. Do not read the two lines above as covering all three.
//
// All three tables were still empty when this was checked, so there remains
// no evidence in the data either way for the one that is open.
// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json'
    }
  });
}
function err(code, message, status, details) {
  return json({
    error: {
      code,
      message,
      ...details ? {
        details
      } : {}
    }
  }, status);
}
// DEFECT 2026-09-19 (unguarded body parse) — several routes called
// `await req.json()` bare. A malformed or empty body throws inside the
// handler, which Deno.serve turns into an opaque 500 with no explanation for
// the caller and a stack trace in the logs. Every body is now parsed through
// this guard, which answers 400 with the reason.
async function readJson(req) {
  try {
    const parsed = await req.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch  {
    return null;
  }
}
// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------
function newId() {
  return crypto.randomUUID();
}
// ---------------------------------------------------------------------------
// Signal strength defaults
// ---------------------------------------------------------------------------
// DEFECT 2026-09-19 (fabricated data) — this used to read:
//     case 'rated': { const rating = (params.rating as number) ?? 3;
//                     return (rating - 3) * 0.8; }
//     case 'thumbs': return (params.thumbs as boolean) ? 0.7 : -0.7;
//     case 'past_trip_rating': { const rating = (params.rating as number) ?? 3; ... }
// A 'rated' or 'past_trip_rating' signal sent without a rating was recorded
// as a rating of exactly 3, i.e. perfectly neutral, and a 'thumbs' signal
// sent without the `thumbs` field was recorded as a thumbs DOWN of strength
// -0.7 — an opinion the traveller never expressed, written into the table the
// whole preference model is built from and decayed over 18 months. A missing
// required field is now null and the route rejects the signal with 422
// instead of inventing one.
function defaultStrength(kind, params) {
  switch(kind){
    case 'onboarding_answer':
      return 1.5; // sign comes from feature value
    case 'rated':
      {
        const rating = params.rating;
        if (typeof rating !== 'number' || !Number.isFinite(rating)) return null;
        return (rating - 3) * 0.8;
      }
    case 'kept':
      return 0.4;
    case 'removed':
      return -0.3;
    case 'rec_accepted':
      return 0.6;
    case 'rec_dismissed':
      return -0.5;
    case 'thumbs':
      {
        if (typeof params.thumbs !== 'boolean') return null;
        return params.thumbs ? 0.7 : -0.7;
      }
    case 'spent':
      return 0.2;
    case 'search':
      return 0.2;
    case 'past_trip_rating':
      {
        const rating = params.rating;
        if (typeof rating !== 'number' || !Number.isFinite(rating)) return null;
        return (rating - 3) * 0.3;
      }
    default:
      return null;
  }
}
function requiredFieldFor(kind) {
  if (kind === 'rated' || kind === 'past_trip_rating') return 'rating (a finite number)';
  if (kind === 'thumbs') return 'thumbs (a boolean)';
  return null;
}
// ---------------------------------------------------------------------------
// Decay function
// ---------------------------------------------------------------------------
function decay(occurredAt) {
  const ageMs = Date.now() - new Date(occurredAt).getTime();
  const ageMonths = ageMs / (1000 * 60 * 60 * 24 * 30);
  return Math.pow(0.5, ageMonths / HALF_LIFE_MONTHS);
}
// DEFECT 2026-09-19 (dead filter / wrong result) — computeContextProfile used
// to take a `context` argument and skip every signal whose context did not
// equal it exactly. Its callers had already selected the rows they wanted:
//     const ctxSignals = rows.filter(s => s.context === ctx || s.context === 'all');
//     ... computeContextProfile(ctxSignals, ctx, priors)
// so the `|| s.context === 'all'` half of that filter was silently thrown
// away again inside, and the generic signals the per-context profile was
// meant to be built on top of never contributed anything. The same applied to
//     const allSignals = rows;  // every signal, all contexts
//     contexts['all'] = computeContextProfile(allSignals, 'all', priors);
// where the inner filter reduced "every signal" to "only signals literally
// tagged 'all'": a traveller whose signals were all captured during couple
// trips got a completely empty 'all' profile, and since every context with
// fewer than 10 signals falls back to 'all', an empty profile everywhere.
// The function now scores exactly the rows it is handed and the callers do
// the selecting, once.
function computeContextProfile(signals, priors = {}) {
  const evidence = {};
  const counts = {};
  for (const sig of signals){
    if (sig.excluded) continue;
    const d = decay(sig.occurred_at);
    for (const [fk, val] of Object.entries(sig.features ?? {})){
      if (!TAXONOMY_SET.has(fk)) continue;
      if (typeof val !== 'number' || !Number.isFinite(val)) continue;
      evidence[fk] = (evidence[fk] ?? 0) + sig.strength * val * d;
      counts[fk] = (counts[fk] ?? 0) + 1;
    }
  }
  const result = {};
  for (const fk of TAXONOMY_FEATURES){
    const n = counts[fk] ?? 0;
    const ev = evidence[fk] ?? 0;
    const prior = priors[fk] ?? 0;
    const rawScore = (prior * K + ev) / (K + n) * 2;
    const weight = Math.tanh(rawScore);
    const confidence = n / (n + K);
    result[fk] = {
      weight,
      confidence
    };
  }
  return result;
}
// DEFECT 2026-09-19 (unhandled throw) — recomputeProfile used to `throw` on a
// read or upsert failure. Its callers had already inserted the caller's
// signal and then awaited this with no try/catch, so a failed recompute threw
// out of the handler: the caller got an opaque 500 and had no way to know
// their signal HAD in fact been stored. It now reports the failure and the
// routes answer 200 with `profileRecomputed: false` so the client does not
// retry a write that already succeeded.
async function recomputeProfile(db, userId) {
  console.log(`[traveler-profile] recomputing profile for ${userId}`);
  // Fetch all non-excluded signals
  const { data: signals, error } = await db.from('profile_signals').select('*').eq('user_id', userId).eq('excluded', false);
  if (error) {
    console.error('[traveler-profile] signal read failed during recompute', error);
    return {
      ok: false,
      reason: error.message
    };
  }
  const rows = signals ?? [];
  // Extract onboarding slider priors for style.* features
  const priors = {};
  for (const sig of rows){
    if (sig.kind === 'onboarding_answer') {
      for (const [fk, val] of Object.entries(sig.features ?? {})){
        if (fk.startsWith('style.') && typeof val === 'number' && Number.isFinite(val)) {
          priors[fk] = val;
        }
      }
    }
  }
  const contexts = {};
  // The 'all' profile is built from every signal, whatever context it was
  // captured in.
  contexts['all'] = computeContextProfile(rows, priors);
  // Compute per-context profiles with blending
  for (const ctx of VALID_CONTEXTS){
    if (ctx === 'all') continue;
    const ctxSignals = rows.filter((s)=>s.context === ctx || s.context === 'all');
    const ctxCount = rows.filter((s)=>s.context === ctx).length;
    if (ctxCount >= 10) {
      // Blend 60% context + 40% all
      const ctxProfile = computeContextProfile(ctxSignals, priors);
      const allProfile = contexts['all'];
      const blended = {};
      for (const fk of TAXONOMY_FEATURES){
        const cw = ctxProfile[fk]?.weight ?? 0;
        const aw = allProfile[fk]?.weight ?? 0;
        const cc = ctxProfile[fk]?.confidence ?? 0;
        const ac = allProfile[fk]?.confidence ?? 0;
        blended[fk] = {
          weight: 0.6 * cw + 0.4 * aw,
          confidence: 0.6 * cc + 0.4 * ac
        };
      }
      contexts[ctx] = blended;
    } else {
      // Not enough context-specific evidence — fall back to the general profile.
      contexts[ctx] = contexts['all'];
    }
  }
  const { error: upsertErr } = await db.from('traveler_profiles').upsert({
    user_id: userId,
    contexts,
    updated_at: new Date().toISOString()
  }, {
    onConflict: 'user_id'
  });
  if (upsertErr) {
    console.error('[traveler-profile] profile upsert failed during recompute', upsertErr);
    return {
      ok: false,
      reason: upsertErr.message
    };
  }
  return {
    ok: true
  };
}
// ---------------------------------------------------------------------------
// Persona generation
// ---------------------------------------------------------------------------
const TRAIT_TEMPLATES = {
  'food.local_traditional': {
    positive: 'You prefer local, traditional food over tourist restaurants.',
    negative: 'You tend to gravitate toward familiar, international cuisine.'
  },
  'food.fine_dining': {
    positive: 'You enjoy fine dining experiences.',
    negative: 'You prefer casual, relaxed dining over formal restaurants.'
  },
  'food.street_food': {
    positive: 'You love exploring street food scenes.',
    negative: 'You prefer sit-down restaurants over street food.'
  },
  'food.cafes': {
    positive: 'You enjoy spending time in local cafes.',
    negative: 'You rarely seek out cafes when traveling.'
  },
  'food.vegetarian_friendly': {
    positive: 'You look for vegetarian-friendly dining options.',
    negative: 'Vegetarian options are not a priority for you.'
  },
  'culture.art_museums': {
    positive: 'You enjoy art museums and galleries.',
    negative: 'Art museums are not typically on your itinerary.'
  },
  'culture.history': {
    positive: 'You love diving into the history of places you visit.',
    negative: 'Historical sites are not a major draw for you.'
  },
  'culture.architecture': {
    positive: 'You appreciate remarkable architecture.',
    negative: 'Architecture is not a focus when you travel.'
  },
  'culture.performing_arts': {
    positive: 'You enjoy live performances and theater when traveling.',
    negative: 'Performing arts are not usually part of your trips.'
  },
  'culture.religious_sites': {
    positive: 'You appreciate visiting religious and spiritual sites.',
    negative: 'Religious sites are not typically on your list.'
  },
  'outdoors.hiking': {
    positive: 'You love hiking and outdoor adventures.',
    negative: 'You prefer urban experiences over hiking.'
  },
  'outdoors.beach': {
    positive: 'You love spending time at the beach.',
    negative: 'Beach destinations are not your preference.'
  },
  'outdoors.parks_gardens': {
    positive: 'You enjoy parks and gardens as part of your travels.',
    negative: 'Parks and gardens are not a priority for you.'
  },
  'outdoors.viewpoints': {
    positive: 'You seek out scenic viewpoints and panoramas.',
    negative: 'Viewpoints are not a major draw for you.'
  },
  'outdoors.water_sports': {
    positive: 'You enjoy water sports and aquatic activities.',
    negative: 'Water sports are not your thing.'
  },
  'nightlife.bars': {
    positive: 'You enjoy the bar scene when traveling.',
    negative: 'Bars are not typically part of your travel plans.'
  },
  'nightlife.clubs': {
    positive: 'You enjoy nightclubs and dancing when traveling.',
    negative: 'Nightclubs are not your scene.'
  },
  'nightlife.live_music': {
    positive: 'You love catching live music when you travel.',
    negative: 'Live music venues are not a priority for you.'
  },
  'shopping.markets': {
    positive: 'You love browsing local markets.',
    negative: 'Markets are not a major part of your travel experience.'
  },
  'shopping.boutiques': {
    positive: 'You enjoy discovering local boutiques and independent shops.',
    negative: 'Boutique shopping is not a priority for you.'
  },
  'shopping.malls': {
    positive: 'You enjoy shopping malls when traveling.',
    negative: 'You prefer to avoid malls when traveling.'
  },
  'wellness.spa': {
    positive: 'You enjoy spa and wellness experiences on your trips.',
    negative: 'Spa treatments are not typically part of your travel.'
  },
  'wellness.fitness': {
    positive: 'Staying active and fit is important to you while traveling.',
    negative: 'Fitness routines are not a priority when you travel.'
  },
  'family.kid_friendly': {
    positive: 'You prioritize kid-friendly activities and venues.',
    negative: 'Kid-friendly considerations are not a factor for you.'
  },
  'style.price_level': {
    positive: 'You tend to spend more on quality experiences.',
    negative: "You're good at finding value and keeping costs down."
  },
  'style.crowd_tolerance': {
    positive: 'You are comfortable in busy, crowded places.',
    negative: 'You prefer quieter, less crowded places.'
  },
  'style.pace': {
    positive: 'You like to pack in as many activities as possible.',
    negative: 'You prefer a relaxed pace with plenty of downtime.'
  },
  'style.walking': {
    positive: 'You enjoy exploring on foot and walking long distances.',
    negative: 'You prefer to minimize walking and use transport.'
  },
  'style.early_bird': {
    positive: "You're an early riser — you make the most of mornings.",
    negative: "You're a night owl — you prefer late starts and late nights."
  },
  'style.novelty': {
    positive: 'You love trying new and unusual experiences.',
    negative: 'You prefer familiar, tried-and-tested experiences.'
  },
  'style.local_vs_iconic': {
    positive: 'You seek out local spots over famous tourist attractions.',
    negative: 'You enjoy visiting iconic landmarks and famous sights.'
  },
  'style.planning': {
    positive: 'You like to plan your trips in detail in advance.',
    negative: 'You prefer spontaneous travel with minimal planning.'
  },
  'style.ambience_small': {
    positive: 'You prefer intimate, small-scale venues and experiences.',
    negative: 'You enjoy large-scale events and grand venues.'
  }
};
function strengthLabel(absWeight) {
  if (absWeight > 0.75) return 'strong';
  if (absWeight > 0.55) return 'clear';
  return 'leaning';
}
function generatePersona(contextProfile, signals, overrides) {
  const traits = [];
  // Count trips
  const tripIds = new Set(signals.filter((s)=>s.trip_id).map((s)=>s.trip_id));
  const tripCount = tripIds.size;
  const totalSignals = signals.length;
  for (const fk of TAXONOMY_FEATURES){
    const stat = contextProfile[fk];
    if (!stat) continue;
    // Apply override if present
    const effectiveWeight = overrides[fk] !== undefined ? overrides[fk] : stat.weight;
    const absWeight = Math.abs(effectiveWeight);
    if (absWeight < 0.35 || stat.confidence < 0.5) continue;
    const direction = effectiveWeight >= 0 ? 'positive' : 'negative';
    const template = TRAIT_TEMPLATES[fk];
    if (!template) continue;
    const label = direction === 'positive' ? template.positive : template.negative;
    if (!label) continue;
    traits.push({
      featureKey: fk,
      direction,
      strength: strengthLabel(absWeight),
      label,
      weight: effectiveWeight,
      confidence: stat.confidence
    });
  }
  // Sort by |weight| desc, cap at 8
  traits.sort((a, b)=>Math.abs(b.weight) - Math.abs(a.weight));
  const top = traits.slice(0, 8);
  // Attach evidence string
  return top.map((t)=>({
      ...t,
      evidence: `Based on ${totalSignals} signal${totalSignals !== 1 ? 's' : ''} across ${tripCount} trip${tripCount !== 1 ? 's' : ''}.`
    }));
}
// ---------------------------------------------------------------------------
// Recently changing detection
// ---------------------------------------------------------------------------
// DEFECT 2026-09-19 (fabricated data) — this compared the current profile to
// one built from signals older than 90 days. For anyone whose account is less
// than 90 days old there ARE no older signals, so olderProfile was the pure
// prior (weight 0 for every non-style feature) and almost every feature the
// traveller had ever touched differed from it by more than 0.2. A brand new
// user was told their taste in half a dozen categories was "recently
// changing", which is a claim about a history that does not exist. There is
// now a minimum of older evidence before any such claim is made, and the
// caller is told when the comparison could not be drawn.
const RECENT_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const MIN_OLDER_SIGNALS_FOR_TREND = 5;
function detectRecentlyChanging(signals, priors) {
  const now = Date.now();
  const recentSignals = signals.filter((s)=>now - new Date(s.occurred_at).getTime() <= RECENT_WINDOW_MS);
  const olderSignals = signals.filter((s)=>now - new Date(s.occurred_at).getTime() > RECENT_WINDOW_MS);
  if (olderSignals.length < MIN_OLDER_SIGNALS_FOR_TREND) {
    return {
      features: [],
      comparable: false
    };
  }
  const currentProfile = computeContextProfile(signals, priors);
  const olderProfile = computeContextProfile(olderSignals, priors);
  const changing = [];
  for (const fk of TAXONOMY_FEATURES){
    const currentWeight = currentProfile[fk]?.weight ?? 0;
    const olderWeight = olderProfile[fk]?.weight ?? 0;
    if (Math.abs(currentWeight - olderWeight) > 0.2 && recentSignals.some((s)=>fk in (s.features ?? {}))) {
      changing.push(fk);
    }
  }
  return {
    features: changing,
    comparable: true
  };
}
// ---------------------------------------------------------------------------
// Context differences
// ---------------------------------------------------------------------------
function detectContextDifferences(contexts) {
  const diffs = {};
  const allProfile = contexts['all'] ?? {};
  for (const ctx of [
    'family',
    'business'
  ]){
    const ctxProfile = contexts[ctx] ?? {};
    const diffFeatures = [];
    for (const fk of TAXONOMY_FEATURES){
      const allW = allProfile[fk]?.weight ?? 0;
      const ctxW = ctxProfile[fk]?.weight ?? 0;
      if (Math.abs(ctxW - allW) > 0.3) {
        diffFeatures.push(fk);
      }
    }
    if (diffFeatures.length > 0) diffs[ctx] = diffFeatures;
  }
  return diffs;
}
// ---------------------------------------------------------------------------
// getProfileVector — exported for server-to-server use
// ---------------------------------------------------------------------------
// DEFECT 2026-09-19 (fabricated data) — this was the worst thing in the file:
//     const { data, error } = await db.from('traveler_profiles')
//       .select('contexts, overrides').eq('user_id', userId).single();
//     if (error || !data) {
//       // Return neutral vector
//       const neutral: Record<string, number> = {};
//       for (const fk of TAXONOMY_FEATURES) neutral[fk] = 0;
//       return neutral;
//     }
// `.single()` errors with PGRST116 whenever the user has no profile row yet,
// so the ordinary case of "we have not learned anything about this traveller"
// went down the same branch as a transport failure or a schema error — and
// both were answered with a complete, well-formed preference vector reading
// exactly 0.0 on all 33 features. A caller cannot tell that from a genuinely
// measured, perfectly balanced traveller: every consumer of
// /internal/profile-vector has been ranking recommendations against invented
// indifference and had no way to know. The absence is now reported as an
// absence, with the reason, and callers must handle `vector: null`.
export async function getProfileVector(userId, context) {
  const db = getServiceClient();
  const { data, error } = await db.from('traveler_profiles').select('contexts, overrides').eq('user_id', userId).maybeSingle();
  if (error) {
    console.error('[traveler-profile] profile vector read failed', error);
    return {
      unavailable: 'READ_FAILED',
      reason: error.message
    };
  }
  if (!data) {
    return {
      unavailable: 'NO_PROFILE',
      reason: 'Nothing has been learned about this traveller yet, so there is no preference vector.'
    };
  }
  const contexts = data.contexts ?? {};
  const overrides = data.overrides ?? {};
  const ctxProfile = contexts[context] ?? contexts['all'];
  // 2026-09-25: overrides the traveller set explicitly count even before
  // anything has been learned — applied on the neutral (0) base.
  const hasOverrides = TAXONOMY_FEATURES.some((fk)=>typeof overrides[fk] === 'number');
  if (!ctxProfile && !hasOverrides) {
    return {
      unavailable: 'NO_PROFILE',
      reason: 'The stored profile carries no scored contexts yet.'
    };
  }
  const vector = {};
  for (const fk of TAXONOMY_FEATURES){
    const base = ctxProfile?.[fk]?.weight ?? 0;
    vector[fk] = overrides[fk] !== undefined ? overrides[fk] : base;
  }
  return {
    vector,
    basis: ctxProfile ? 'learned' : 'overrides_only'
  };
}
// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders
    });
  }
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/traveler-profile/, '');
  const method = req.method;
  console.log(`[traveler-profile] ${method} ${path}`);
  // ---------------------------------------------------------------------------
  // Auth (skip for internal routes that use service key directly)
  // ---------------------------------------------------------------------------
  let userId = null;
  // Internal server-to-server route — verify via service role header
  //
  // SECURITY 2026-09-17 — this compared the caller-supplied header to the
  // service role key with `!==`, a non-constant-time string compare. For a
  // secret comparison that is a timing side channel: an attacker who can
  // measure response latency can recover the key one byte at a time. Fixed
  // to use the shared timingSafeEqual (length-independent, constant-time).
  if (path === '/internal/profile-vector' && method === 'POST') {
    const serviceKey = req.headers.get('x-service-key') ?? '';
    const expected = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    if (!serviceKey || !timingSafeEqual(serviceKey, expected)) {
      return err('UNAUTHORIZED', 'Invalid service key', 401);
    }
    const body = await readJson(req);
    if (!body) return err('VALIDATION_ERROR', 'Request body must be a JSON object', 400);
    const uid = body.userId;
    const context = body.context;
    if (!uid || !context) return err('VALIDATION_ERROR', 'userId and context required', 422);
    if (!VALID_CONTEXTS.includes(context)) {
      return err('VALIDATION_ERROR', `context must be one of ${VALID_CONTEXTS.join(', ')}`, 422);
    }
    const result = await getProfileVector(uid, context);
    if ('unavailable' in result) {
      // 200 with vector: null — the caller asked a well-formed question and the
      // honest answer is "no vector", which is not the same as a zero vector.
      return json({
        userId: uid,
        context,
        vector: null,
        available: false,
        unavailableReason: result.unavailable,
        detail: result.reason
      });
    }
    return json({
      userId: uid,
      context,
      vector: result.vector,
      available: true,
      basis: result.basis
    });
  }
  // Internal server-to-server route — record a signal on behalf of a named user.
  //
  // WHY THIS EXISTS 2026-09-20 — happiness-prediction POSTs its rating signals
  // with an x-service-key header and a body userId. They went to /signals,
  // which is below the JWT gate: the gate resolves the writer from the token,
  // and a service-role bearer has no `sub`, so getUserId() returns null and the
  // call 401s before the body is ever looked at. Worse, that fetch sent no
  // Authorization header at all, so the functions gateway rejected it ahead of
  // this function entirely — a service-key header alone is invisible to the
  // gateway, which only ever looks for a JWT. Every rating signal that function
  // believed it was recording has been dropped since the call was written.
  // Both halves had to change together: the caller now sends the service-role
  // key as Bearer so the gateway lets it through, and this route gives it a
  // landing place above the gate that can accept a named subject.
  //
  // SECURITY 2026-09-20 — this route takes its user id from the request body,
  // which every other route here refuses to do. That is safe only because of
  // where it sits: above the JWT gate and behind the same constant-time
  // service-key check as /internal/profile-vector, so nothing a browser can
  // send arrives on this path. The body's userId is a worker naming its
  // subject, not a caller naming themselves. If this block is ever moved below
  // the gate, or the key check weakened, it becomes an account-takeover
  // primitive — a caller could write taste signals onto any profile.
  if (path === '/internal/signal' && method === 'POST') {
    const serviceKey = req.headers.get('x-service-key') ?? '';
    const expected = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    if (!serviceKey || !timingSafeEqual(serviceKey, expected)) {
      console.error('[traveler-profile] /internal/signal refused: bad service key');
      return err('UNAUTHORIZED', 'Invalid service key', 401);
    }
    const body = await readJson(req);
    if (!body) return err('VALIDATION_ERROR', 'Request body must be a JSON object', 400);
    const uid = body.userId;
    // profile_signals.user_id is uuid with an FK to auth.users; anything else
    // surfaces as a raw 22P02/23503 at the caller rather than a clear refusal.
    if (!uid || !UUID_RE.test(uid)) {
      return err('VALIDATION_ERROR', 'userId must be an auth user uuid', 422);
    }
    return await handlePostSignal(getServiceClient(), uid, body);
  }
  // All other routes require JWT
  userId = await getUserId(req);
  if (!userId) return err('UNAUTHORIZED', 'Valid JWT required', 401);
  const db = getServiceClient();
  // ---------------------------------------------------------------------------
  // GET /profile?userId=
  // ---------------------------------------------------------------------------
  if ((path === '/profile' || path === '') && method === 'GET') {
    const targetUserId = url.searchParams.get('userId') ?? userId;
    // Only allow fetching own profile (or service-level override not needed here)
    if (targetUserId !== userId) return err('FORBIDDEN', 'Cannot access another user\'s profile', 403);
    return await handleGetProfile(db, targetUserId);
  }
  // ---------------------------------------------------------------------------
  // GET /profile/me
  // ---------------------------------------------------------------------------
  if (path === '/profile/me' && method === 'GET') {
    return await handleGetProfile(db, userId);
  }
  // ---------------------------------------------------------------------------
  // GET /profile/export
  // ---------------------------------------------------------------------------
  if (path === '/profile/export' && method === 'GET') {
    const [profileRes, signalsRes] = await Promise.all([
      db.from('traveler_profiles').select('*').eq('user_id', userId).maybeSingle(),
      db.from('profile_signals').select('*').eq('user_id', userId).order('occurred_at', {
        ascending: false
      })
    ]);
    // DEFECT 2026-09-19 (failure looks like absence) — this route used
    //     db.from('traveler_profiles')...single()
    // and then returned
    //     { profile: profileRes.data ?? null, signals: signalsRes.data ?? [] }
    // with both errors discarded. This is the "download everything you hold
    // about me" route: a failed read handed the user a complete-looking export
    // stating that TravelOS holds no profile and no signals for them, which is
    // a false answer to a data-subject request, not merely a UI glitch. Both
    // reads must now succeed or the export is refused.
    if (profileRes.error) {
      return err('DB_ERROR', `Could not read your profile: ${profileRes.error.message}`, 500);
    }
    if (signalsRes.error) {
      return err('DB_ERROR', `Could not read your signals: ${signalsRes.error.message}`, 500);
    }
    return json({
      profile: profileRes.data ?? null,
      signals: signalsRes.data ?? [],
      complete: true
    });
  }
  // ---------------------------------------------------------------------------
  // POST /onboarding
  // ---------------------------------------------------------------------------
  if (path === '/onboarding' && method === 'POST') {
    const raw = await readJson(req);
    if (!raw) return err('VALIDATION_ERROR', 'Request body must be a JSON object', 400);
    const body = raw;
    const now = new Date().toISOString();
    const signalsToInsert = [];
    // Interest signals → features map
    const interestFeatures = {};
    for (const interest of body.interests ?? []){
      if (TAXONOMY_SET.has(interest)) {
        interestFeatures[interest] = 1;
      }
    }
    if (Object.keys(interestFeatures).length > 0) {
      signalsToInsert.push({
        id: newId(),
        user_id: userId,
        trip_id: null,
        context: 'all',
        kind: 'onboarding_answer',
        entity_ref: null,
        features: interestFeatures,
        strength: 1.5,
        occurred_at: now,
        excluded: false
      });
    }
    // Slider signals
    const sliderFeatures = {};
    for (const [key, val] of Object.entries(body.sliders ?? {})){
      if (TAXONOMY_SET.has(key)) {
        if (typeof val !== 'number' || !Number.isFinite(val)) {
          return err('VALIDATION_ERROR', `Slider '${key}' must be a finite number`, 422);
        }
        // Normalize slider value to [-1, 1] if needed
        const normalized = Math.max(-1, Math.min(1, val));
        sliderFeatures[key] = normalized;
      }
    }
    // Early bird
    if (body.earlyBird !== undefined) {
      if (typeof body.earlyBird !== 'boolean') {
        return err('VALIDATION_ERROR', 'earlyBird must be a boolean', 422);
      }
      sliderFeatures['style.early_bird'] = body.earlyBird ? 1 : -1;
    }
    if (Object.keys(sliderFeatures).length > 0) {
      signalsToInsert.push({
        id: newId(),
        user_id: userId,
        trip_id: null,
        context: 'all',
        kind: 'onboarding_answer',
        entity_ref: null,
        features: sliderFeatures,
        strength: 1.5,
        occurred_at: now,
        excluded: false
      });
    }
    // Past trip ratings
    //
    // DEFECT 2026-09-19 (dead data, misleading comment) — the original read:
    //     // Generic positive signal for all features at low weight
    //     signalsToInsert.push({ ... features: {}, strength, ... });
    // The comment claims the rating is spread across all features; the code
    // writes an EMPTY features map. computeContextProfile iterates
    // Object.entries(features), so a row with no features contributes exactly
    // nothing to any weight or any confidence count, forever. Every past-trip
    // rating a user gave during onboarding has been stored and has never
    // influenced a single recommendation. The rows are still written — they
    // are a truthful record of what the user said, and a future version can
    // use them (e.g. by attributing them to the features of the items on that
    // trip) — but the comment no longer claims an effect that does not exist,
    // and the response now says plainly that they do not yet weigh on the
    // profile so nobody reads the number as an input it is not.
    //
    // The ids are also validated: profile_signals.trip_id is a uuid with a
    // foreign key to trips, so a non-uuid tripId used to make the whole batch
    // insert fail with 22P02 and take the interests and sliders down with it.
    let pastTripRatingsStored = 0;
    for (const ptr of body.pastTripRatings ?? []){
      if (!ptr || typeof ptr.tripId !== 'string' || !UUID_RE.test(ptr.tripId)) {
        return err('VALIDATION_ERROR', `pastTripRatings[].tripId must be a trip uuid`, 422);
      }
      if (typeof ptr.rating !== 'number' || !Number.isFinite(ptr.rating)) {
        return err('VALIDATION_ERROR', 'pastTripRatings[].rating must be a finite number', 422);
      }
      const strength = (ptr.rating - 3) * 0.3;
      signalsToInsert.push({
        id: newId(),
        user_id: userId,
        trip_id: ptr.tripId,
        context: 'all',
        kind: 'past_trip_rating',
        entity_ref: {
          tripId: ptr.tripId,
          rating: ptr.rating
        },
        features: {},
        strength,
        occurred_at: now,
        excluded: false
      });
      pastTripRatingsStored++;
    }
    if (signalsToInsert.length > 0) {
      const { error: insErr } = await db.from('profile_signals').insert(signalsToInsert);
      if (insErr) {
        console.error('[traveler-profile] signal insert error', insErr);
        return err('DB_ERROR', insErr.message, 500);
      }
    }
    // Mark onboarding complete
    const { error: ocErr } = await db.from('onboarding_completions').upsert({
      user_id: userId,
      completed_at: now,
      skipped: false
    }, {
      onConflict: 'user_id'
    });
    if (ocErr) {
      // DEFECT 2026-09-19 (discarded error) — this was logged and ignored, so
      // a user could complete onboarding, be told it succeeded, and be walked
      // through the whole thing again on their next visit with no explanation.
      console.error('[traveler-profile] onboarding completion error', ocErr);
      return err('DB_ERROR', `Your answers were saved but onboarding could not be marked complete: ${ocErr.message}`, 500, {
        signalsCreated: signalsToInsert.length
      });
    }
    // Recompute profile
    const recomputed = await recomputeProfile(db, userId);
    return json({
      success: true,
      signalsCreated: signalsToInsert.length,
      pastTripRatingsStored,
      pastTripRatingsWeighed: 0,
      pastTripRatingsNote: pastTripRatingsStored > 0 ? 'Past trip ratings are recorded but do not yet contribute to the preference profile.' : undefined,
      profileRecomputed: recomputed.ok,
      ...recomputed.ok ? {} : {
        profileRecomputeError: recomputed.reason
      }
    });
  }
  // ---------------------------------------------------------------------------
  // POST /signals
  // ---------------------------------------------------------------------------
  if (path === '/signals' && method === 'POST') {
    const raw = await readJson(req);
    if (!raw) return err('VALIDATION_ERROR', 'Request body must be a JSON object', 400);
    // SECURITY 2026-09-20 — the signal is attributed to the verified JWT's
    // user, and a `userId` in the body is ignored rather than honoured. This
    // is the route a browser reaches, so the id deciding whose row gets
    // written must not come from the same request that is asking for the
    // write. A worker that legitimately names another user uses
    // POST /internal/signal, which sits above the JWT gate behind the
    // service-key check. Keep that split: it is the only thing stopping a
    // logged-in caller from writing signals onto someone else's profile.
    return await handlePostSignal(db, userId, raw);
  }
  // ---------------------------------------------------------------------------
  // PATCH /profile/overrides
  // ---------------------------------------------------------------------------
  if (path === '/profile/overrides' && method === 'PATCH') {
    const raw = await readJson(req);
    if (!raw) return err('VALIDATION_ERROR', 'Request body must be a JSON object', 400);
    const body = raw;
    if (!body.featureKey || !TAXONOMY_SET.has(body.featureKey)) {
      return err('VALIDATION_ERROR', 'Invalid featureKey', 422);
    }
    if (body.value !== null && body.value !== undefined && (typeof body.value !== 'number' || !Number.isFinite(body.value))) {
      return err('VALIDATION_ERROR', 'value must be a finite number or null', 422);
    }
    // Get current overrides.
    //
    // DEFECT 2026-09-19 (silent data loss) — this was a read-modify-write on
    // the whole overrides object using `.single()` with the error discarded:
    //     const { data: existing } = await db...select('overrides').single();
    //     const overrides = (existing?.overrides ?? {}) as ...;
    // If that read failed, `overrides` became {} and the upsert below wrote {}
    // back — silently deleting every manual correction the traveller had ever
    // made to their profile, while answering 200 with `overrides: {}` as if
    // that had always been the state. The read failure is now fatal to the
    // write.
    const { data: existing, error: readErr } = await db.from('traveler_profiles').select('overrides').eq('user_id', userId).maybeSingle();
    if (readErr) {
      return err('DB_ERROR', `Could not read your existing overrides, so nothing was changed: ${readErr.message}`, 500);
    }
    const overrides = existing?.overrides ?? {};
    if (body.value === null || body.value === undefined) {
      delete overrides[body.featureKey];
    } else {
      overrides[body.featureKey] = body.value;
    }
    const { error: updErr } = await db.from('traveler_profiles').upsert({
      user_id: userId,
      overrides,
      updated_at: new Date().toISOString()
    }, {
      onConflict: 'user_id'
    });
    if (updErr) return err('DB_ERROR', updErr.message, 500);
    return json({
      success: true,
      overrides
    });
  }
  // ---------------------------------------------------------------------------
  // POST /profile/pause
  // ---------------------------------------------------------------------------
  if (path === '/profile/pause' && method === 'POST') {
    const { error: updErr } = await db.from('traveler_profiles').upsert({
      user_id: userId,
      learning_paused: true,
      updated_at: new Date().toISOString()
    }, {
      onConflict: 'user_id'
    });
    if (updErr) return err('DB_ERROR', updErr.message, 500);
    return json({
      success: true,
      learning_paused: true
    });
  }
  // ---------------------------------------------------------------------------
  // POST /profile/resume
  // ---------------------------------------------------------------------------
  if (path === '/profile/resume' && method === 'POST') {
    const { error: updErr } = await db.from('traveler_profiles').upsert({
      user_id: userId,
      learning_paused: false,
      updated_at: new Date().toISOString()
    }, {
      onConflict: 'user_id'
    });
    if (updErr) return err('DB_ERROR', updErr.message, 500);
    return json({
      success: true,
      learning_paused: false
    });
  }
  // ---------------------------------------------------------------------------
  // POST /profile/exclude-trip
  // ---------------------------------------------------------------------------
  if (path === '/profile/exclude-trip' && method === 'POST') {
    const raw = await readJson(req);
    if (!raw) return err('VALIDATION_ERROR', 'Request body must be a JSON object', 400);
    const tripId = raw.tripId;
    if (!tripId) return err('VALIDATION_ERROR', 'tripId required', 422);
    if (!UUID_RE.test(tripId)) return err('VALIDATION_ERROR', 'tripId must be a trip uuid', 422);
    // DEFECT 2026-09-19 (silent data loss) — same read-modify-write hazard as
    // /profile/overrides above: `.single()` with the error discarded meant a
    // failed read produced `excluded = [tripId]` and the upsert then dropped
    // every previously excluded trip, quietly folding trips the traveller had
    // asked to be ignored back into their profile.
    const { data: existing, error: readErr } = await db.from('traveler_profiles').select('excluded_trip_ids').eq('user_id', userId).maybeSingle();
    if (readErr) {
      return err('DB_ERROR', `Could not read your existing exclusions, so nothing was changed: ${readErr.message}`, 500);
    }
    const excluded = [
      ...new Set([
        ...existing?.excluded_trip_ids ?? [],
        tripId
      ])
    ];
    // Mark signals as excluded.
    //
    // DEFECT 2026-09-19 (discarded error) — this was logged and ignored, so
    // the trip could be listed as excluded while all of its signals kept
    // feeding the profile: the traveller was told the trip had been excluded
    // and it had not been.
    const { error: sigErr } = await db.from('profile_signals').update({
      excluded: true
    }).eq('user_id', userId).eq('trip_id', tripId);
    if (sigErr) {
      console.error('[traveler-profile] exclude signals error', sigErr);
      return err('DB_ERROR', `The trip's signals could not be excluded, so nothing was changed: ${sigErr.message}`, 500);
    }
    const { error: updErr } = await db.from('traveler_profiles').upsert({
      user_id: userId,
      excluded_trip_ids: excluded,
      updated_at: new Date().toISOString()
    }, {
      onConflict: 'user_id'
    });
    if (updErr) return err('DB_ERROR', updErr.message, 500);
    const recomputed = await recomputeProfile(db, userId);
    return json({
      success: true,
      excluded_trip_ids: excluded,
      profileRecomputed: recomputed.ok,
      ...recomputed.ok ? {} : {
        profileRecomputeError: recomputed.reason
      }
    });
  }
  // ---------------------------------------------------------------------------
  // DELETE /profile/signals
  // ---------------------------------------------------------------------------
  if (path === '/profile/signals' && method === 'DELETE') {
    const tripId = url.searchParams.get('tripId');
    const featureKey = url.searchParams.get('featureKey');
    if (!tripId && !featureKey) {
      return err('VALIDATION_ERROR', 'tripId or featureKey query param required', 422);
    }
    if (tripId && !UUID_RE.test(tripId)) {
      return err('VALIDATION_ERROR', 'tripId must be a trip uuid', 422);
    }
    if (featureKey && !TAXONOMY_SET.has(featureKey)) {
      return err('VALIDATION_ERROR', 'featureKey is not in the allowed taxonomy', 422);
    }
    // DEFECT 2026-09-19 (over-deletion + discarded error) — the original was:
    //     let query = db.from('profile_signals').delete().eq('user_id', userId);
    //     if (tripId) query = query.eq('trip_id', tripId);
    //     if (featureKey && !tripId) { ...filter in app, delete those ids... }
    //     else { await query; }
    // When BOTH tripId and featureKey were supplied the featureKey was
    // dropped on the floor and the else branch deleted EVERY signal from that
    // trip — a request to forget one preference erased the whole trip's
    // history. Neither delete captured its error, so the route answered
    // `{ success: true }` whether or not anything had been deleted. Both
    // filters are now honoured together and the caller is told how many rows
    // actually went.
    let idsToDelete;
    if (featureKey) {
      // features is jsonb; the key test has to happen here rather than in the
      // filter, so select the candidates first.
      let sel = db.from('profile_signals').select('id, features').eq('user_id', userId);
      if (tripId) sel = sel.eq('trip_id', tripId);
      const { data: sigs, error: selErr } = await sel;
      if (selErr) return err('DB_ERROR', selErr.message, 500);
      idsToDelete = (sigs ?? []).filter((s)=>featureKey in (s.features ?? {})).map((s)=>s.id);
    } else {
      const { data: sigs, error: selErr } = await db.from('profile_signals').select('id').eq('user_id', userId).eq('trip_id', tripId);
      if (selErr) return err('DB_ERROR', selErr.message, 500);
      idsToDelete = (sigs ?? []).map((s)=>s.id);
    }
    let deletedCount = 0;
    if (idsToDelete.length > 0) {
      const { data: deleted, error: delErr } = await db.from('profile_signals').delete().eq('user_id', userId).in('id', idsToDelete).select('id');
      if (delErr) return err('DB_ERROR', delErr.message, 500);
      deletedCount = deleted?.length ?? 0;
    }
    const recomputed = await recomputeProfile(db, userId);
    return json({
      success: true,
      deletedCount,
      profileRecomputed: recomputed.ok,
      ...recomputed.ok ? {} : {
        profileRecomputeError: recomputed.reason
      }
    });
  }
  // ---------------------------------------------------------------------------
  // POST /profile/group-use
  // ---------------------------------------------------------------------------
  if (path === '/profile/group-use' && method === 'POST') {
    const raw = await readJson(req);
    if (!raw) return err('VALIDATION_ERROR', 'Request body must be a JSON object', 400);
    if (typeof raw.enabled !== 'boolean') {
      return err('VALIDATION_ERROR', 'enabled must be a boolean', 422);
    }
    const enabled = raw.enabled;
    const { error: updErr } = await db.from('traveler_profiles').upsert({
      user_id: userId,
      group_use_enabled: enabled,
      updated_at: new Date().toISOString()
    }, {
      onConflict: 'user_id'
    });
    if (updErr) return err('DB_ERROR', updErr.message, 500);
    return json({
      success: true,
      group_use_enabled: enabled
    });
  }
  return err('NOT_FOUND', 'Route not found', 404);
});
// ---------------------------------------------------------------------------
// handleGetProfile — shared by GET /profile and GET /profile/me
// ---------------------------------------------------------------------------
async function handleGetProfile(db, userId) {
  const [profileRes, signalsRes, onboardingRes] = await Promise.all([
    db.from('traveler_profiles').select('*').eq('user_id', userId).maybeSingle(),
    db.from('profile_signals').select('*').eq('user_id', userId).eq('excluded', false).order('occurred_at', {
      ascending: false
    }),
    db.from('onboarding_completions').select('*').eq('user_id', userId).maybeSingle()
  ]);
  // DEFECT 2026-09-19 (failure looks like absence) — all three reads used
  // `.single()` and all three errors were discarded. `.single()` raises
  // PGRST116 on zero rows, which is the ordinary state for a new user, so the
  // code could not have distinguished them anyway; a failed profile read fell
  // through to the `if (!profile)` branch below and the traveller was shown
  // "we have not learned anything about you yet" with an empty persona and
  // onboardingComplete: false — after they had completed onboarding and given
  // dozens of signals. Worse, being shown onboardingComplete: false is an
  // invitation to redo onboarding and write a second set of priors.
  if (profileRes.error) {
    return err('DB_ERROR', `Could not read your profile: ${profileRes.error.message}`, 500);
  }
  if (signalsRes.error) {
    return err('DB_ERROR', `Could not read your signals: ${signalsRes.error.message}`, 500);
  }
  if (onboardingRes.error) {
    return err('DB_ERROR', `Could not read your onboarding state: ${onboardingRes.error.message}`, 500);
  }
  const profile = profileRes.data;
  const signals = signalsRes.data ?? [];
  const onboarding = onboardingRes.data;
  // DEFECT 2026-09-19 (inconsistent result) — the no-profile branch reported
  // `onboardingComplete: !!onboarding` while the branch below reported
  // `!!onboarding && !onboarding.skipped`. A user who SKIPPED onboarding and
  // therefore has no profile yet was told onboarding was complete, and so was
  // never offered it again. The two branches now agree.
  const onboardingComplete = !!onboarding && !onboarding.skipped;
  if (!profile) {
    // Nothing has been learned about this traveller yet. This is an absence,
    // not a neutral profile: `profile` is null rather than a zeroed vector.
    return json({
      profile: null,
      persona: [],
      onboardingComplete,
      recentlyChanging: [],
      recentlyChangingComparable: false,
      contextDifferences: {}
    });
  }
  const contexts = profile.contexts ?? {};
  const overrides = profile.overrides ?? {};
  const allProfile = contexts['all'] ?? {};
  // Extract priors for recently changing
  const priors = {};
  for (const sig of signals){
    if (sig.kind === 'onboarding_answer') {
      for (const [fk, val] of Object.entries(sig.features ?? {})){
        if (fk.startsWith('style.') && typeof val === 'number' && Number.isFinite(val)) {
          priors[fk] = val;
        }
      }
    }
  }
  const persona = generatePersona(allProfile, signals, overrides);
  const changing = detectRecentlyChanging(signals, priors);
  const contextDifferences = detectContextDifferences(contexts);
  return json({
    profile: {
      userId: profile.user_id,
      version: profile.version,
      contexts,
      overrides,
      learningPaused: profile.learning_paused,
      excludedTripIds: profile.excluded_trip_ids,
      groupUseEnabled: profile.group_use_enabled,
      updatedAt: profile.updated_at
    },
    persona,
    onboardingComplete,
    recentlyChanging: changing.features,
    // false means "there is not enough history to say", NOT "nothing is
    // changing" — see detectRecentlyChanging().
    recentlyChangingComparable: changing.comparable,
    contextDifferences
  });
}
// ---------------------------------------------------------------------------
// handlePostSignal — shared by POST /signals (JWT, id from the token) and
// POST /internal/signal (service key, id from the body). The caller has
// already decided whose signal this is and is trusted to have done so; this
// function deliberately never reaches into the request for an identity, so
// there is exactly one place per route where that decision is visible.
// ---------------------------------------------------------------------------
async function handlePostSignal(db, userId, raw) {
  const body = raw;
  // Validate kind
  if (!VALID_KINDS.includes(body.kind)) {
    return err('VALIDATION_ERROR', `Invalid kind: ${body.kind}`, 422);
  }
  // Validate features — only taxonomy keys allowed (except onboarding_answer)
  if (body.kind !== 'onboarding_answer') {
    for (const fk of Object.keys(body.features ?? {})){
      if (!TAXONOMY_SET.has(fk)) {
        return err('PROHIBITED_INFERENCE', `Feature key '${fk}' is not in the allowed taxonomy`, 422);
      }
    }
  }
  // profile_signals.trip_id is a uuid with a foreign key to trips; a bad
  // value is a 22P02 or 23503 raised as a raw DB error to the caller.
  if (body.tripId !== undefined && body.tripId !== null && !UUID_RE.test(String(body.tripId))) {
    return err('VALIDATION_ERROR', 'tripId must be a trip uuid', 422);
  }
  // Handle rec_dismissed with reason too_pricey
  let features = body.features ?? {};
  if (body.kind === 'rec_dismissed' && body.reason === 'too_pricey') {
    features = {
      'style.price_level': -1
    };
  }
  const context = body.context && VALID_CONTEXTS.includes(body.context) ? body.context : 'all';
  let strength;
  if (body.strength !== undefined) {
    if (typeof body.strength !== 'number' || !Number.isFinite(body.strength)) {
      return err('VALIDATION_ERROR', 'strength must be a finite number', 422);
    }
    strength = body.strength;
  } else {
    const derived = defaultStrength(body.kind, {
      rating: body.rating,
      thumbs: body.thumbs
    });
    if (derived === null) {
      // See defaultStrength(): rather than recording a neutral rating or a
      // thumbs-down the traveller never gave, refuse the signal.
      return err('VALIDATION_ERROR', `A '${body.kind}' signal requires ${requiredFieldFor(body.kind) ?? 'a strength'}, or an explicit strength`, 422);
    }
    strength = derived;
  }
  const entityRef = body.entityRef ?? (body.entityType && body.entityId ? {
    type: body.entityType,
    id: body.entityId
  } : null);
  const signal = {
    id: newId(),
    user_id: userId,
    trip_id: body.tripId ?? null,
    context,
    kind: body.kind,
    entity_ref: entityRef,
    features,
    strength,
    occurred_at: new Date().toISOString(),
    excluded: false
  };
  const { error: insErr } = await db.from('profile_signals').insert(signal);
  if (insErr) {
    console.error('[traveler-profile] signal insert error', insErr);
    return err('DB_ERROR', insErr.message, 500);
  }
  // Check if learning is paused.
  //
  // DEFECT 2026-09-19 (failure looks like absence) — this was
  //     const { data: profileData } = await db...select('learning_paused')
  //       .eq('user_id', userId).single();
  //     if (!profileData?.learning_paused) await recomputeProfile(db, userId);
  // with the error discarded. `.single()` errors with PGRST116 for a user
  // who has no profile row yet, and any read failure also left profileData
  // null — so a user who had explicitly PAUSED learning had their profile
  // recomputed anyway whenever that read failed. A pause that is silently
  // ignored is worse than no pause. The read now distinguishes the three
  // cases and, if it cannot establish the pause state, does NOT recompute.
  const { data: profileData, error: pauseErr } = await db.from('traveler_profiles').select('learning_paused').eq('user_id', userId).maybeSingle();
  if (pauseErr) {
    console.error('[traveler-profile] learning_paused read failed', pauseErr);
    return json({
      success: true,
      signalId: signal.id,
      profileRecomputed: false,
      profileRecomputeError: `Could not confirm whether learning is paused, so the profile was left untouched: ${pauseErr.message}`
    });
  }
  if (profileData?.learning_paused) {
    return json({
      success: true,
      signalId: signal.id,
      profileRecomputed: false,
      learningPaused: true
    });
  }
  const recomputed = await recomputeProfile(db, userId);
  return json({
    success: true,
    signalId: signal.id,
    profileRecomputed: recomputed.ok,
    ...recomputed.ok ? {} : {
      profileRecomputeError: recomputed.reason
    }
  });
} // TODO: wire to pg_cron or Supabase scheduled function for nightly full recompute of all profiles

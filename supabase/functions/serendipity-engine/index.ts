import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { corsHeaders } from './_shared/auth.ts';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');
const log = (...args)=>console.log('[serendipity-engine]', ...args);
function serviceClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
}
function nanoid(len = 21) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  for (const b of bytes)id += chars[b % chars.length];
  return id;
}
async function simpleHash(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map((b)=>b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}
async function getUserId(req) {
  const auth = req.headers.get('Authorization');
  if (!auth) return null;
  const token = auth.replace('Bearer ', '');
  const client = createClient(SUPABASE_URL, ANON_KEY);
  const { data: { user }, error } = await client.auth.getUser(token);
  if (error || !user) return null;
  return user.id;
}
// DEFECT 2026-09-19 (unguarded body parse) — the three POST/PUT routes called
// `await req.json()` bare, so an empty or malformed body threw and was caught
// by the blanket handler at the bottom, which answered a generic
// INTERNAL_ERROR 500 that told the caller nothing.
async function readJson(req) {
  try {
    const parsed = await req.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch  {
    return null;
  }
}
// ─── CATEGORY FEATURES MAP ───────────────────────────────────────────
//
// DEFECT 2026-09-19 (keys that never match) — this map used to be written in
// invented short words:
//     gallery: ['art', 'culture', 'indoor'],
//     market:  ['food', 'local', 'outdoor'],
//     ... etc
// but the profile vector these are looked up in is keyed by the
// traveler-profile taxonomy — 'culture.art_museums', 'food.street_food',
// 'outdoors.viewpoints' and so on. Not one of the words above is a key in
// that vector, so `profile[f]` was ALWAYS undefined, the dot product was
// always exactly 0, and computeRelevance() always returned exactly 0.5 for
// any traveller who had a profile. The very next line is
//     if (relevance < 0.6) continue;
// so every candidate was discarded and a traveller with a profile received
// zero suggestions — always, silently, with a 200 and an empty list. Only a
// traveller the system knew NOTHING about got any suggestions at all, via the
// `Object.keys(profile).length === 0` early return of 0.65. The map now uses
// real taxonomy keys.
const CATEGORY_FEATURES = {
  gallery: [
    'culture.art_museums',
    'culture.architecture'
  ],
  market: [
    'shopping.markets',
    'food.street_food',
    'food.local_traditional'
  ],
  viewpoint: [
    'outdoors.viewpoints'
  ],
  bar: [
    'nightlife.bars'
  ],
  art: [
    'culture.art_museums',
    'shopping.boutiques'
  ],
  museum: [
    'culture.art_museums',
    'culture.history'
  ],
  restaurant: [
    'food.local_traditional',
    'food.fine_dining'
  ],
  park: [
    'outdoors.parks_gardens'
  ],
  music: [
    'nightlife.live_music'
  ],
  club: [
    'nightlife.clubs'
  ],
  nightlife: [
    'nightlife.bars',
    'nightlife.clubs',
    'nightlife.live_music'
  ],
  cafe: [
    'food.cafes'
  ],
  shop: [
    'shopping.boutiques',
    'shopping.markets'
  ],
  tour: [
    'culture.history',
    'culture.architecture'
  ],
  sport: [
    'wellness.fitness',
    'outdoors.hiking'
  ],
  spa: [
    'wellness.spa'
  ]
};
const PRICE_LABELS = [
  'Free',
  '€',
  '€€',
  '€€€'
];
// ─── CANDIDATE SOURCE ──────────────────────────────────────────────
//
// DEFECT 2026-09-19 (fabricated data — the whole feature) — every suggestion
// this engine has ever made was invented. The file carried a MOCK_CANDIDATES
// array of five venues that do not exist:
//
//   { source:'places', externalId:'gem_001', name:'Tiny Gallery Upstairs',
//     category:'gallery', lat:0, lng:0, rating:4.7, reviewCount:45,
//     durationMinutes:60, priceLevel:1, openUntil:'20:00',
//     description:'A small gallery hosting an evening talk tonight',
//     timeliness:1.0 },
//   { ... 'Weekly Organic Market', rating 4.6, 120 reviews, 'open Saturdays only' },
//   { ... 'Golden Hour Viewpoint', rating 4.8, 280 reviews, 'Best sunset view in the neighborhood' },
//   { ... 'Neighborhood Fado Bar', rating 4.5, 67 reviews, 'Authentic fado, no tourists' },
//   { ... 'Azulejo Workshop', rating 4.6, 33 reviews, 'Make your own tile, small group sessions' },
//
// and then placed them on the map with:
//
//   const candidates = MOCK_CANDIDATES.map(c => ({ ...c,
//     lat: resolvedAnchor.lat + (c.lat === 0 ? (Math.random() - 0.5) * 0.01 : c.lat),
//     lng: resolvedAnchor.lng + (c.lng === 0 ? (Math.random() - 0.5) * 0.01 : c.lng) }));
//
// — a random point within about half a kilometre of the anchor, redrawn on
// every request. The traveller was shown a named venue, a star rating, a
// review count, a closing time, a price and a walking distance, all of it
// fiction, and a personalised "Why this?" paragraph explaining why it suited
// them. Someone acting on one of these walks to an empty street corner.
// The rows were also written to serendipity_suggestions, so the fiction was
// persisted and fed back into the dismissal and appetite logic.
//
// There is no place/event data source wired into this project, so there is
// nothing truthful to put in their place. The mocks are removed and the route
// now reports plainly that it cannot make suggestions. Everything downstream
// — feasibility, scoring, explanation, dedup — is kept and is correct as
// written, so connecting a real source is a change to this one function.
async function fetchCandidates(_anchor, _reachMinutes) {
  return {
    unavailable: 'NO_PLACE_SOURCE',
    reason: 'No place or event data source is connected, so there are no real venues to suggest. ' + 'This is not "nothing nearby" — nothing was searched.'
  };
}
function degDistance(lat1, lng1, lat2, lng2) {
  return Math.sqrt(Math.pow(lat2 - lat1, 2) + Math.pow(lng2 - lng1, 2));
}
// The figure is a straight-line estimate at 5 km/h, not a routed walking
// time; the label says so rather than implying a real route was computed.
function distanceLabel(degs) {
  const km = degs * 111;
  const walkMin = Math.round(km / 5 * 60);
  return `~${walkMin} min walk (straight line)`;
}
// DEFECT 2026-09-19 (fabricated data) — this used to be:
//     if (!resp.ok) return {};
//     return data.vector ?? {};
//     ... catch { return {}; }
// An empty object is then read by computeRelevance/computeUnexpectedness as
// "this traveller has no preferences", for which they return the invented
// constants 0.65 and 0.7 — so a traveller whose profile simply failed to load
// was scored as though the system had measured a mildly positive fit. It now
// distinguishes a profile that could not be fetched from one that does not
// exist, and the scorers refuse to score without one.
// (traveler-profile's /internal/profile-vector now answers 200 with
// `vector: null, available: false` when it has nothing, rather than a vector
// of 33 zeros; both shapes are handled here.)
async function fetchProfileVector(userId) {
  try {
    const resp = await fetch(`${SUPABASE_URL}/functions/v1/traveler-profile/internal/profile-vector`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-service-key': SUPABASE_SERVICE_ROLE_KEY
      },
      body: JSON.stringify({
        userId,
        context: 'all'
      })
    });
    if (!resp.ok) {
      const text = await resp.text().catch(()=>'<unreadable>');
      console.error(`[serendipity-engine] profile-vector returned ${resp.status}: ${text.slice(0, 300)}`);
      return {
        unavailable: 'PROFILE_FETCH_FAILED',
        reason: `profile service returned ${resp.status}`
      };
    }
    const data = await resp.json();
    if (data?.available === false || !data?.vector || typeof data.vector !== 'object') {
      return {
        unavailable: 'NO_PROFILE',
        reason: String(data?.detail ?? 'no preference vector has been learned for this traveller')
      };
    }
    return {
      vector: data.vector
    };
  } catch (e) {
    console.error('[serendipity-engine] profile-vector call threw:', e);
    return {
      unavailable: 'PROFILE_FETCH_FAILED',
      reason: String(e)
    };
  }
}
// DEFECT 2026-09-19 (fabricated data) — both scorers used to invent a score
// when they had nothing to score with:
//     if (features.length === 0 || Object.keys(profile).length === 0) return 0.65;
//     if (Object.keys(profile).length === 0) return 0.7;
// 0.65 sits comfortably above the 0.6 relevance gate, so an unknown traveller
// and an uncategorised venue both scored as a good match, and the number was
// then shown to the user inside `scores` as a measured relevance. They now
// return null and the caller must decide what to do without a score.
function computeRelevance(category, profile) {
  const features = CATEGORY_FEATURES[category] ?? [];
  if (features.length === 0) return null;
  let dot = 0;
  for (const f of features)dot += profile[f] ?? 0;
  const normalized = (dot / features.length + 1) / 2;
  return Math.max(0, Math.min(1, normalized));
}
function computeUnexpectedness(category, profile) {
  const features = CATEGORY_FEATURES[category] ?? [];
  if (features.length === 0) return null;
  const top3 = Object.entries(profile).sort((a, b)=>b[1] - a[1]).slice(0, 3).map(([k])=>k);
  const inTop3 = features.some((f)=>top3.includes(f));
  return inTop3 ? 0.5 : 1.0;
}
// DEFECT 2026-09-19 (fabricated claim) — the explanation used to include:
//     `You have never visited a ${category} on a trip — a perfect chance ...`
// Nothing in this function ever looked at what the traveller has visited;
// that branch fired whenever the category simply was not in their top three
// features, which is not the same claim at all and is often false. It also
// said `You love ${matchedFeature} spots` on the strength of the feature
// merely being PRESENT as a key — a feature the traveller scores at -0.9,
// i.e. actively dislikes, produced "You love it". The wording now follows the
// sign and size of the weight that is actually there, and makes no claim
// about visit history.
function generateExplanation(category, profile) {
  const features = CATEGORY_FEATURES[category] ?? [];
  const weighted = features.map((f)=>({
      f,
      w: profile[f]
    })).filter((x)=>typeof x.w === 'number');
  const strongest = weighted.slice().sort((a, b)=>Math.abs(b.w) - Math.abs(a.w))[0];
  const top3 = Object.entries(profile).sort((a, b)=>b[1] - a[1]).slice(0, 3).map(([k])=>k);
  const isOutsideUsual = features.length > 0 && !features.some((f)=>top3.includes(f));
  if (strongest && strongest.w >= 0.35) {
    return isOutsideUsual ? `Why this? It leans on your taste for ${strongest.f}, but it is outside the handful of things you pick most often.` : `Why this? It matches your taste for ${strongest.f}.`;
  }
  if (strongest && strongest.w <= -0.35) {
    return `Why this? A ${category} is not usually your thing — this one is offered as a deliberate change of pace.`;
  }
  if (isOutsideUsual) {
    return `Why this? A ${category} sits outside the categories you pick most often.`;
  }
  return `Why this? It is close to where you already are and fits the time you have free.`;
}
// Returns the hour of day at the trip's own timezone, or null when the trip
// does not record one.
//
// DEFECT 2026-09-19 (wrong basis) — quiet hours and the late-night nightlife
// filter were both computed from `now.getUTCHours()`. A traveller in Tokyo
// (UTC+9) had "quiet hours" applied between 07:00 and 17:00 their time and
// was free to be pushed a proactive suggestion at 04:00; a traveller in Los
// Angeles had it the other way round. Quiet hours now use the trip's
// primary_tz, and when the trip has none, a PROACTIVE suggestion is withheld
// rather than pushed at a guessed hour.
function localHour(tz) {
  if (!tz) return null;
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      hour12: false
    });
    const h = parseInt(fmt.format(new Date()), 10);
    return Number.isFinite(h) ? h : null;
  } catch  {
    return null;
  }
}
// ─── ROUTE: GET /free-windows ────────────────────────────────────────
async function handleFreeWindows(req, userId) {
  const url = new URL(req.url);
  const tripId = url.searchParams.get('tripId');
  const dateParam = url.searchParams.get('date');
  if (!tripId) return jsonError('MISSING_PARAM', 'tripId is required', 400);
  const date = dateParam ?? new Date().toISOString().slice(0, 10);
  const db = serviceClient();
  const { data: trip, error: tripErr } = await db.from('trips').select('id, primary_tz').eq('id', tripId).maybeSingle();
  if (tripErr) return jsonError('DB_ERROR', tripErr.message, 500);
  if (!trip) return jsonError('NOT_FOUND', 'Trip not found', 404);
  const tz = trip.primary_tz ?? null;
  // DEFECT 2026-09-19 (failure looks like absence + wrong column) — the read
  // was wrapped in try/catch with `if (!error && data) items = data;` and a
  // log line claiming "itinerary_items table not found", so a genuine query
  // failure left items empty and fell into the mock branch below. It also
  // filtered the day with
  //     .gte('start_time', `${date}T00:00:00`).lte('start_time', `${date}T23:59:59`)
  // comparing a timestamptz against a bare local-looking string, which
  // Postgres reads as UTC — so for any trip not on UTC the window was shifted
  // by the offset and items at the edges of the day were picked up on the
  // wrong date. itinerary_items carries an explicit `date` column; use it.
  const { data: rawItems, error: itemsErr } = await db.from('itinerary_items').select('start_time, end_time, lat, lng, title').eq('trip_id', tripId).eq('date', date).order('start_time', {
    ascending: true
  });
  if (itemsErr) return jsonError('DB_ERROR', itemsErr.message, 500);
  // Gap detection needs both ends of an item; items without them cannot take
  // part rather than being given invented times.
  const items = (rawItems ?? []).filter((i)=>!!i.start_time && !!i.end_time);
  const skippedForMissingTimes = (rawItems ?? []).length - items.length;
  // DEFECT 2026-09-19 (fabricated data) — when the day had no items this used
  // to answer with a window it made up:
  //     windows.push({ ..., start: `${date}T17:00:00`, end: `${date}T22:00:00`,
  //       tz: 'UTC', anchor: { lat: 38.7169, lng: -9.1399, label: 'Trip destination' },
  //       reachMinutes: 20, reason: 'evening', durationMinutes: 300 });
  // 38.7169/-9.1399 is central Lisbon. Every trip in the system, wherever it
  // was, was told it had a free evening anchored in Lisbon and labelled that
  // point "Trip destination". An empty day is now an empty day.
  if (items.length === 0) {
    return json({
      windows: [],
      tz,
      reason: (rawItems ?? []).length === 0 ? 'Nothing is scheduled on this day, so no free windows were derived from it.' : 'The items scheduled on this day have no start or end time, so no gaps could be measured.',
      skippedForMissingTimes
    });
  }
  const windows = [];
  // Detect gaps >= 90 minutes
  for(let i = 0; i < items.length - 1; i++){
    const endA = new Date(items[i].end_time).getTime();
    const startB = new Date(items[i + 1].start_time).getTime();
    if (!Number.isFinite(endA) || !Number.isFinite(startB)) continue;
    const gapMin = (startB - endA) / 60000;
    if (gapMin >= 90) {
      // The anchor is where the traveller actually is. An item with no
      // coordinates yields a window with no anchor, NOT a Lisbon default.
      const hasCoords = typeof items[i].lat === 'number' && typeof items[i].lng === 'number';
      windows.push({
        id: nanoid(),
        memberIds: [
          userId
        ],
        start: items[i].end_time,
        end: items[i + 1].start_time,
        tz,
        anchor: hasCoords ? {
          lat: items[i].lat,
          lng: items[i].lng,
          label: items[i].title ?? 'Previous stop'
        } : null,
        reachMinutes: Math.min(20, gapMin * 0.25),
        reason: 'gap',
        durationMinutes: gapMin
      });
    }
  }
  // Evening window: after the last item until 22:00 on the same date.
  const lastItem = items[items.length - 1];
  const lastEnd = new Date(lastItem.end_time);
  const eveningEnd = new Date(`${date}T22:00:00`);
  const eveningMin = (eveningEnd.getTime() - lastEnd.getTime()) / 60000;
  if (Number.isFinite(eveningMin) && eveningMin >= 90) {
    const hasCoords = typeof lastItem.lat === 'number' && typeof lastItem.lng === 'number';
    windows.push({
      id: nanoid(),
      memberIds: [
        userId
      ],
      start: lastItem.end_time,
      end: `${date}T22:00:00`,
      tz,
      anchor: hasCoords ? {
        lat: lastItem.lat,
        lng: lastItem.lng,
        label: lastItem.title ?? 'Last stop'
      } : null,
      reachMinutes: Math.min(20, eveningMin * 0.25),
      reason: 'evening',
      durationMinutes: eveningMin
    });
  }
  log(`free-windows: found ${windows.length} windows for trip ${tripId} on ${date}`);
  return json({
    windows,
    tz,
    skippedForMissingTimes
  });
}
// ─── ROUTE: POST /suggest ─────────────────────────────────────────────
async function handleSuggest(req, userId) {
  const body = await readJson(req);
  if (!body) return jsonError('INVALID_BODY', 'Request body must be a JSON object', 400);
  const tripId = body.tripId;
  const windowStart = body.windowStart;
  const anchor = body.anchor;
  const audience = body.audience ?? 'me';
  if (!tripId) return jsonError('MISSING_PARAM', 'tripId is required', 400);
  const db = serviceClient();
  const isProactive = !!windowStart;
  const now = new Date();
  const { data: trip, error: tripErr } = await db.from('trips').select('id, primary_tz').eq('id', tripId).maybeSingle();
  if (tripErr) return jsonError('DB_ERROR', tripErr.message, 500);
  if (!trip) return jsonError('NOT_FOUND', 'Trip not found', 404);
  const hour = localHour(trip.primary_tz ?? null);
  // Fetch preferences.
  //
  // DEFECT 2026-09-19 (discarded error) — `const { data: prefRow }` dropped
  // the error and fell back to `{ enabled: true, appetite: 1.0 }`, so a failed
  // read enabled serendipity for someone who may have switched it off.
  const { data: prefRow, error: prefErr } = await db.from('serendipity_preferences').select('*').eq('user_id', userId).maybeSingle();
  if (prefErr) return jsonError('DB_ERROR', prefErr.message, 500);
  // DEFECT 2026-09-19 (setting ignored) — `enabled` was read into `prefs` and
  // then never consulted anywhere in the function. Turning serendipity off in
  // preferences did nothing at all: proactive suggestions kept coming.
  const enabled = prefRow?.enabled ?? true;
  if (!enabled) {
    return json({
      suggestions: [],
      available: false,
      unavailableReason: 'DISABLED',
      detail: 'Serendipity suggestions are switched off in your preferences.'
    });
  }
  const appetite = typeof prefRow?.appetite === 'number' ? prefRow.appetite : 1.0;
  // Proactive caps
  if (isProactive) {
    if (hour === null) {
      return jsonError('NO_TRIP_TIMEZONE', 'This trip records no timezone, so quiet hours cannot be checked and no suggestion will be pushed.', 409);
    }
    // Quiet hours 22:00-08:00, in the trip's own timezone.
    if (hour >= 22 || hour < 8) {
      return jsonError('QUIET_HOURS', 'Serendipity suggestions are paused during quiet hours', 429);
    }
    // At most 1 suggestion per user per day
    const todayStart = new Date(now);
    todayStart.setUTCHours(0, 0, 0, 0);
    const { data: todaySuggestions, error: todayErr } = await db.from('serendipity_suggestions').select('id').eq('user_id', userId).gte('shown_at', todayStart.toISOString()).limit(1);
    // DEFECT 2026-09-19 (discarded error) — all three cap checks below threw
    // their error away, so any read failure read as "no cap reached" and the
    // caps — one push per day, quiet hours, suppression after dismissals —
    // all failed OPEN. A cap that fails open is not a cap. They now fail
    // closed: if we cannot tell whether we may push, we do not push.
    if (todayErr) {
      return jsonError('CAP_CHECK_FAILED', `Could not check the daily cap: ${todayErr.message}`, 503);
    }
    if (todaySuggestions && todaySuggestions.length > 0) {
      return jsonError('DAILY_CAP', 'Daily suggestion cap reached', 429);
    }
    // Not if 2 consecutive dismissals in last 48 hours
    const fortyEightHoursAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    const { data: recentDismissals, error: dismissErr } = await db.from('serendipity_suggestions').select('id').eq('user_id', userId).eq('action', 'dismissed').gte('acted_at', fortyEightHoursAgo.toISOString()).order('acted_at', {
      ascending: false
    }).limit(2);
    if (dismissErr) {
      return jsonError('CAP_CHECK_FAILED', `Could not check recent dismissals: ${dismissErr.message}`, 503);
    }
    if (recentDismissals && recentDismissals.length >= 2) {
      return jsonError('SUPPRESSED', 'Suggestions suppressed after consecutive dismissals', 429);
    }
  }
  // Resolve anchor.
  //
  // DEFECT 2026-09-19 (fabricated data) — this was
  //     const resolvedAnchor = anchor ?? { lat: 38.7169, lng: -9.1399 };
  // central Lisbon, used as the origin for every distance and every candidate
  // position whenever the caller did not supply one. Without an anchor there
  // is no "near here" to search, so the request is refused instead.
  if (!anchor || typeof anchor.lat !== 'number' || typeof anchor.lng !== 'number') {
    return jsonError('MISSING_ANCHOR', 'anchor {lat,lng} is required — without a location there is nothing to be near.', 400);
  }
  const resolvedAnchor = anchor;
  // Resolve window duration
  let windowDurationMinutes = 180; // default 3 hours
  let reachMinutes = 20;
  if (windowStart) {
    const windowEnd = body.windowEnd;
    if (windowEnd) {
      windowDurationMinutes = (new Date(windowEnd).getTime() - new Date(windowStart).getTime()) / 60000;
      if (!Number.isFinite(windowDurationMinutes) || windowDurationMinutes <= 0) {
        return jsonError('INVALID_PARAM', 'windowEnd must be a valid time after windowStart', 400);
      }
    }
    reachMinutes = Math.min(20, windowDurationMinutes * 0.25);
  }
  // Fetch profile vector
  const profileResult = await fetchProfileVector(userId);
  if ('unavailable' in profileResult) {
    // Scoring is entirely a function of the profile. Without one there is no
    // honest relevance number, and the previous code's answer — score
    // everything 0.65 and suggest it — presented a guess as a measurement.
    return json({
      suggestions: [],
      available: false,
      unavailableReason: profileResult.unavailable,
      detail: profileResult.reason
    }, 503);
  }
  const profile = profileResult.vector;
  log(`profile vector keys: ${Object.keys(profile).length}`);
  // Fetch the candidate venues.
  const candidateResult = await fetchCandidates(resolvedAnchor, reachMinutes);
  if ('unavailable' in candidateResult) {
    return json({
      suggestions: [],
      available: false,
      unavailableReason: candidateResult.unavailable,
      detail: candidateResult.reason
    }, 503);
  }
  const candidates = candidateResult.candidates;
  // Fetch dismissed candidates (14-day window)
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
  const { data: dismissedRows, error: dismissedErr } = await db.from('serendipity_dismissed').select('candidate_key').eq('user_id', userId).gte('dismissed_at', fourteenDaysAgo.toISOString());
  // DEFECT 2026-09-19 (discarded error) — a failed read produced an empty
  // dismissal set, so the traveller was re-shown the very things they had
  // just dismissed.
  if (dismissedErr) return jsonError('DB_ERROR', dismissedErr.message, 500);
  const dismissedKeys = new Set((dismissedRows ?? []).map((r)=>r.candidate_key));
  // Score and filter
  const scored = [];
  for (const c of candidates){
    // Feasibility
    const dist = degDistance(resolvedAnchor.lat, resolvedAnchor.lng, c.lat, c.lng);
    const maxReachDeg = reachMinutes * 0.08 / 20; // rough: 20min walk = 0.08 deg
    if (dist > maxReachDeg) continue;
    if (c.durationMinutes > windowDurationMinutes - reachMinutes * 2) continue;
    if (c.priceLevel > 3) continue;
    // Late-night nightlife filter for solo
    if (audience === 'me' && hour !== null && hour >= 22 && [
      'bar',
      'club',
      'nightlife'
    ].includes(c.category)) continue;
    // Dismissed check
    const candidateKey = await simpleHash(c.externalId);
    if (dismissedKeys.has(candidateKey)) continue;
    const relevance = computeRelevance(c.category, profile);
    const unexpectedness = computeUnexpectedness(c.category, profile);
    const timeliness = c.timeliness;
    // An uncategorised venue cannot be scored; it is dropped rather than
    // handed the old invented 0.65.
    if (relevance === null || unexpectedness === null) continue;
    // DEFECT 2026-09-19 (fabricated score) — `const novelty = 1.0;` was a
    // constant with a 0.2 weight in the blend below, reported to the caller
    // inside `scores` as though it had been measured. Nothing in this
    // function has ever computed novelty. It is reported as null and the
    // remaining weights are renormalised so the serendipity score is a blend
    // of the three terms that do exist (0.45/0.2/0.15, summing to 0.8).
    const serendipity = appetite * ((0.45 * relevance + 0.2 * unexpectedness + 0.15 * timeliness) / 0.8);
    const scores = {
      relevance,
      novelty: null,
      unexpectedness,
      timeliness,
      serendipity
    };
    // Filter thresholds
    if (relevance < 0.6) continue;
    if (isProactive && serendipity < 0.62) continue;
    scored.push({
      candidate: c,
      scores,
      candidateKey
    });
  }
  // Sort by serendipity desc, take top 3
  scored.sort((a, b)=>b.scores.serendipity - a.scores.serendipity);
  const top3 = scored.slice(0, 3);
  // Build suggestion objects and insert
  const suggestions = [];
  const windowStartVal = windowStart ?? now.toISOString();
  const windowEndVal = body.windowEnd ?? new Date(now.getTime() + windowDurationMinutes * 60000).toISOString();
  for (const { candidate: c, scores } of top3){
    const id = nanoid();
    const explanation = generateExplanation(c.category, profile);
    const dist = degDistance(resolvedAnchor.lat, resolvedAnchor.lng, c.lat, c.lng);
    // DEFECT 2026-09-19 (failure looks like success) — the insert below
    // discarded its error and the suggestion was returned to the client
    // regardless. The client then had an id that does not exist in
    // serendipity_suggestions, so POST /feedback on it answered 404 'Suggestion
    // not found' and the dismissal, the appetite adjustment and the dedup key
    // were all lost. A suggestion that cannot be recorded is not offered.
    const { error: insErr } = await db.from('serendipity_suggestions').insert({
      id,
      user_id: userId,
      trip_id: tripId,
      window_start: windowStartVal,
      window_end: windowEndVal,
      candidate_ref: {
        source: c.source,
        externalId: c.externalId,
        name: c.name,
        lat: c.lat,
        lng: c.lng,
        category: c.category
      },
      scores,
      explanation,
      shown_at: now.toISOString()
    });
    if (insErr) {
      console.error('[serendipity-engine] suggestion insert failed:', insErr.message);
      continue;
    }
    suggestions.push({
      id,
      name: c.name,
      category: c.category,
      description: c.description,
      explanation,
      distance: distanceLabel(dist),
      openUntil: c.openUntil,
      priceLabel: PRICE_LABELS[c.priceLevel] ?? 'Free',
      scores,
      source: c.source,
      timeliness: c.timeliness,
      ...audience === 'group' ? {
        groupNote: 'Something the group might enjoy',
        askGroupPollEnabled: true
      } : {}
    });
  }
  log(`suggest: returning ${suggestions.length} suggestions for user ${userId}`);
  return json({
    suggestions,
    available: true,
    considered: scored.length
  });
}
// ─── ROUTE: POST /feedback ────────────────────────────────────────────
const VALID_ACTIONS = [
  'added',
  'dismissed',
  'ignored',
  'asked_group'
];
async function handleFeedback(req, userId) {
  const body = await readJson(req);
  if (!body) return jsonError('INVALID_BODY', 'Request body must be a JSON object', 400);
  const suggestionId = body.suggestionId;
  const action = body.action;
  const reason = body.reason;
  if (!suggestionId || !action) return jsonError('MISSING_PARAM', 'suggestionId and action are required', 400);
  // DEFECT 2026-09-19 (unvalidated value + discarded error) — `action` went
  // straight into the UPDATE. serendipity_suggestions.action has a CHECK
  // constraint (added|dismissed|ignored|asked_group), so any other value was
  // rejected with 23514 — and the update's error was discarded, so the route
  // still answered { ok: true } having recorded nothing.
  if (!VALID_ACTIONS.includes(action)) {
    return jsonError('INVALID_PARAM', `action must be one of ${VALID_ACTIONS.join(', ')}`, 400);
  }
  const db = serviceClient();
  const now = new Date();
  // Fetch suggestion
  const { data: suggestion, error: fetchErr } = await db.from('serendipity_suggestions').select('*').eq('id', suggestionId).eq('user_id', userId).maybeSingle();
  // DEFECT 2026-09-19 (failure looks like absence) — this was
  //     if (fetchErr || !suggestion) return jsonError('NOT_FOUND', ..., 404);
  // folding a broken read into "that suggestion does not exist".
  if (fetchErr) return jsonError('DB_ERROR', fetchErr.message, 500);
  if (!suggestion) return jsonError('NOT_FOUND', 'Suggestion not found', 404);
  // Update action
  const { data: updated, error: updateErr } = await db.from('serendipity_suggestions').update({
    action,
    dismiss_reason: reason ?? null,
    acted_at: now.toISOString()
  }).eq('id', suggestionId).eq('user_id', userId).select('id');
  if (updateErr) return jsonError('DB_ERROR', updateErr.message, 500);
  if (!updated || updated.length === 0) {
    return jsonError('NOT_RECORDED', 'The feedback did not update any row', 500);
  }
  let suppressedFor;
  const warnings = [];
  if (action === 'dismissed') {
    // Insert into dismissed dedup.
    //
    // candidate_ref is NOT NULL but its shape is not enforced; guard the read
    // rather than throwing into the blanket 500 handler.
    const externalId = suggestion.candidate_ref?.externalId;
    if (typeof externalId === 'string' && externalId.length > 0) {
      const candidateKey = await simpleHash(externalId);
      // PK is (user_id, candidate_key) — name it so the upsert is a refresh of
      // dismissed_at rather than a 23505.
      const { error: dismissErr } = await db.from('serendipity_dismissed').upsert({
        user_id: userId,
        candidate_key: candidateKey,
        dismissed_at: now.toISOString()
      }, {
        onConflict: 'user_id,candidate_key'
      });
      // DEFECT 2026-09-19 (discarded error) — dropped, so a failed write meant
      // the traveller would be shown the same dismissed venue again while
      // being told the dismissal had registered.
      if (dismissErr) {
        console.error('[serendipity-engine] dismissal dedup write failed:', dismissErr.message);
        warnings.push('This suggestion may be shown again: the dismissal could not be remembered.');
      }
    } else {
      warnings.push('This suggestion may be shown again: it carries no external id to remember it by.');
    }
    // Adjust appetite
    let appetiteAdjust = 0;
    if (reason === 'Not my thing') appetiteAdjust = -0.1;
    if (reason === 'More like this') appetiteAdjust = 0.1;
    if (appetiteAdjust !== 0) {
      const { data: prefRow, error: prefErr } = await db.from('serendipity_preferences').select('appetite').eq('user_id', userId).maybeSingle();
      // DEFECT 2026-09-19 (silent data loss) — a failed read fell back to
      // `?? 1.0` and then WROTE that back, resetting an appetite the traveller
      // had tuned down to 0.5 (or up to 1.5) to the default.
      if (prefErr) {
        console.error('[serendipity-engine] appetite read failed:', prefErr.message);
        warnings.push('Your suggestion appetite was left unchanged: it could not be read.');
      } else {
        const currentAppetite = typeof prefRow?.appetite === 'number' ? prefRow.appetite : 1.0;
        const newAppetite = Math.max(0.5, Math.min(1.5, currentAppetite + appetiteAdjust));
        const { error: apErr } = await db.from('serendipity_preferences').upsert({
          user_id: userId,
          appetite: newAppetite,
          updated_at: now.toISOString()
        }, {
          onConflict: 'user_id'
        });
        if (apErr) {
          console.error('[serendipity-engine] appetite write failed:', apErr.message);
          warnings.push('Your suggestion appetite could not be updated.');
        }
      }
    }
    // Check consecutive dismissals in last 48 hours
    const fortyEightHoursAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    const { data: recentDismissals, error: recentErr } = await db.from('serendipity_suggestions').select('id').eq('user_id', userId).eq('action', 'dismissed').gte('acted_at', fortyEightHoursAgo.toISOString()).limit(2);
    if (recentErr) {
      console.error('[serendipity-engine] recent dismissal read failed:', recentErr.message);
    } else if (recentDismissals && recentDismissals.length >= 2) {
      suppressedFor = 48;
    }
  }
  log(`feedback: suggestion ${suggestionId} action=${action} user=${userId}`);
  return json({
    ok: true,
    ...suppressedFor !== undefined ? {
      suppressedFor
    } : {},
    ...warnings.length ? {
      warnings
    } : {}
  });
}
// ─── ROUTE: PUT /preferences ─────────────────────────────────────────
async function handlePutPreferences(req, userId) {
  const body = await readJson(req);
  if (!body) return jsonError('INVALID_BODY', 'Request body must be a JSON object', 400);
  const enabled = body.enabled;
  const appetite = body.appetite;
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    return jsonError('INVALID_PARAM', 'enabled must be a boolean', 400);
  }
  if (appetite !== undefined) {
    if (typeof appetite !== 'number' || !Number.isFinite(appetite)) {
      return jsonError('INVALID_PARAM', 'appetite must be a number', 400);
    }
    if (appetite < 0.5 || appetite > 1.5) {
      return jsonError('INVALID_PARAM', 'appetite must be between 0.5 and 1.5', 400);
    }
  }
  const db = serviceClient();
  const now = new Date();
  // DEFECT 2026-09-19 (silent data loss) — the read below discarded its error
  // and the merge fell back to `?? true` / `?? 1.0`, so a failed read turned a
  // request that changed only `appetite` into a write that ALSO switched
  // serendipity back on for someone who had switched it off, and vice versa.
  const { data: existing, error: readErr } = await db.from('serendipity_preferences').select('*').eq('user_id', userId).maybeSingle();
  if (readErr) {
    return jsonError('DB_ERROR', `Could not read your current preferences, so nothing was changed: ${readErr.message}`, 500);
  }
  const merged = {
    user_id: userId,
    enabled: enabled ?? existing?.enabled ?? true,
    appetite: appetite ?? existing?.appetite ?? 1.0,
    updated_at: now.toISOString()
  };
  // DEFECT 2026-09-19 (failure looks like success) — the upsert's error was
  // discarded and the route echoed `merged` back, so the UI showed the new
  // setting as saved when it had not been written at all.
  const { error: upsertErr } = await db.from('serendipity_preferences').upsert(merged, {
    onConflict: 'user_id'
  });
  if (upsertErr) return jsonError('DB_ERROR', upsertErr.message, 500);
  log(`preferences updated for user ${userId}: enabled=${merged.enabled} appetite=${merged.appetite}`);
  return json({
    enabled: merged.enabled,
    appetite: merged.appetite
  });
}
// ─── ROUTE: GET /preferences ─────────────────────────────────────────
async function handleGetPreferences(_req, userId) {
  const db = serviceClient();
  const { data, error } = await db.from('serendipity_preferences').select('*').eq('user_id', userId).maybeSingle();
  // DEFECT 2026-09-19 (failure looks like absence) — the error was discarded
  // and the defaults returned, so a settings screen could show "enabled, 1.0"
  // to someone who had turned it off, and writing that screen back would then
  // really turn it on.
  if (error) return jsonError('DB_ERROR', error.message, 500);
  return json({
    enabled: data?.enabled ?? true,
    appetite: data?.appetite ?? 1.0,
    // true when these are the defaults because nothing has been saved yet,
    // rather than values the traveller chose.
    isDefault: !data
  });
}
// ─── HELPERS ──────────────────────────────────────────────────────
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json'
    }
  });
}
function jsonError(code, message, status) {
  return json({
    error: {
      code,
      message
    }
  }, status);
}
// ─── MAIN HANDLER ─────────────────────────────────────────────────
Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders
    });
  }
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/serendipity-engine/, '').replace(/^\/?/, '/');
  const method = req.method;
  log(`${method} ${path}`);
  // Auth
  const userId = await getUserId(req);
  if (!userId) return jsonError('UNAUTHORIZED', 'Valid JWT required', 401);
  try {
    if (method === 'GET' && path === '/free-windows') return await handleFreeWindows(req, userId);
    if (method === 'POST' && path === '/suggest') return await handleSuggest(req, userId);
    if (method === 'POST' && path === '/feedback') return await handleFeedback(req, userId);
    if (method === 'PUT' && path === '/preferences') return await handlePutPreferences(req, userId);
    if (method === 'GET' && path === '/preferences') return await handleGetPreferences(req, userId);
    return jsonError('NOT_FOUND', 'Route not found', 404);
  } catch (err) {
    // Log the actual error — previously only the opaque message reached the
    // caller and nothing identifiable reached the logs.
    console.error('[serendipity-engine] Unhandled error:', err);
    return jsonError('INTERNAL_ERROR', 'An unexpected error occurred', 500);
  }
});

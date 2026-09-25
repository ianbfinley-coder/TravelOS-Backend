// 2026-09-25 — alignment correctness + recompute reliability (wave 6b).
// 1. computeAlignment grouped answers by DIMENSION and classified the whole
//    pool with the FIRST question's kind: wake_time pooled wake-up and bedtime
//    answers into one time spread (08:00 vs 23:00 = "divergent" for a group
//    that agrees on both); pace mixed a single-choice, a range and a scale
//    under whichever came first; splitting pooled two different questions'
//    options. Each QUESTION is now classified on its own answers with its own
//    kind; a dimension's state is the worst of its questions' states, its
//    distribution is its first choice question's (so suggestion text such as
//    "Most common preference" refers to one question), and the per-question
//    breakdown is in dimensions[dim].questions.
// 2. Range questions: answers are [min,max] ("0–n km"), so every answer
//    contains 0 and the old "intervals intersect" test called every group
//    aligned. Alignment is now the overlap of the intervals divided by their
//    union (>= 0.5 aligned, >= 0.25 mixed, else divergent); a bare number n is
//    read as [scale.min, n].
// 3. Recompute: handlePutResponses fired computeAlignment un-awaited, so the
//    runtime could stop it as soon as the response was sent, and a 2-minute
//    "computed recently" skip dropped every answer saved in that window from
//    the report until some later save. It now runs under
//    EdgeRuntime.waitUntil and the skip is gone (every save recomputes).
// 4. Dietary vs dining check required food.dietary answers with visibility
//    'shared', but that question is sensitive and always stored 'private', so
//    it never fired. It now counts non-empty dietary answers of ANY visibility
//    and reports only that someone in the group has a dietary need — never
//    who, how many, or what.
// supabase-js import switched from jsr: to esm.sh (standing rule).
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');
// SECURITY 2026-09-17 — two defects here, one of them the exact class of bug
// this audit went looking for.
//
// 1. Hardcoded encryption key fallback.
//    `const MASTER_KEY_HEX = Deno.env.get('AGREEMENT_MASTER_KEY') || 'b'.repeat(64);`
//    This function encrypts the SENSITIVE agreement answers — dietary needs,
//    accessibility needs, room-sharing comfort — with AES-GCM keys derived
//    from this master key. If the env var was ever unset (a bad deploy, a
//    missed secret in a new environment), every trip's answers would
//    silently encrypt under the same publicly-known 32-byte key baked into
//    the source. That is not encryption, it is base64 with extra steps. The
//    fix removes the fallback entirely: with no master key configured, the
//    function fails loudly instead of encrypting sensitive data under a key
//    anyone reading this file already has.
//
// 2. Fail-open membership checks.
//    `checkMembership` and `checkOrganizerRole` both did: look up a
//    trip_members row for (tripId, userId); if none is found, count ALL
//    trip_members rows for that tripId; if that count is zero, ALLOW the
//    caller (as a plain member, or — in checkOrganizerRole — as an
//    organizer). The comment called this "fallback: trip_members not wired
//    yet". trip_members is currently empty for every trip in this project
//    (confirmed against the live table), which means that fallback is not a
//    rare edge case — it is the path every single request has been taking.
//    Any authenticated user calling this function with any real trip id
//    could open a trip's questionnaire, submit responses framed as an
//    arbitrary member, read a trip's alignment report, or apply a
//    suggestion as if they were the organizer, for a trip they have no
//    relationship to at all. This is exactly the "a lookup whose empty
//    result lets execution continue" shape flagged for this audit.
//    Fixed: an unmatched trip_members lookup no longer defaults to "allow".
//    It falls back to checking `trips.user_id` (the uuid owner column every
//    other TravelOS trip-scoped function already uses) — so the trip's
//    actual owner keeps working exactly as before, and everyone else is
//    denied. When trip_members is eventually populated for real multi-member
//    trips, invited members will be recognized through the primary lookup
//    as designed; until then, only the owner passes.
//
// USER-AXIS FIX 2026-09-18 — the trip_members lookups above were comparing
// the wrong id space. `trip_members.user_id` is TEXT and holds a PLATFORM id
// (`usr_<hex>`), while `user.id` from the JWT is an auth uuid, so
// checkMembership / checkOrganizerRole / getMemberId never matched a row.
// The first two were masked by the isTripOwner fallback (trips.user_id IS a
// uuid — that comparison is correct and is unchanged), so the trip owner
// still got in while every invited member was silently denied. getMemberId
// had no fallback at all and returned the raw auth uuid as the member id,
// which then landed in agreement_responses.member_id /
// agreement_completions.member_id AND fed deriveKey(tripId, memberId) — so
// responses were encrypted under a key derived from the wrong id space.
// Fixed: resolvePlatformUserId() maps the auth uuid to the platform id via
// public.auth_identities (provider_subject -> user_id) and all three helpers
// query trip_members with the resolved platform id. isTripOwner still
// receives the AUTH uuid. Note: the bridge lookup matches on
// provider_subject ALONE — `provider` varies by sign-in method and filtering
// on it would silently deny everyone. Verified safe to change the member id
// and therefore the key derivation: agreement_responses,
// agreement_completions and alignment_reports were all empty at deploy time,
// so nothing was orphaned.
const MASTER_KEY_HEX = Deno.env.get('AGREEMENT_MASTER_KEY');
if (!MASTER_KEY_HEX) {
  throw new Error('AGREEMENT_MASTER_KEY is not configured. Refusing to start rather than encrypt agreement responses under a hardcoded key.');
}
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'authorization,x-client-info,apikey,content-type'
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
function err(code, message, status) {
  return json({
    error: {
      code,
      message
    }
  }, status);
}
// ─── Crypto helpers ────────────────────────────────────────────────
function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for(let i = 0; i < hex.length; i += 2){
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}
async function deriveKey(tripId, memberId) {
  const masterBytes = hexToBytes(MASTER_KEY_HEX);
  const baseKey = await crypto.subtle.importKey('raw', masterBytes, 'HKDF', false, [
    'deriveKey'
  ]);
  const info = new TextEncoder().encode(`agreement:${tripId}:${memberId}`);
  const salt = new TextEncoder().encode('travelos-agreement-v1');
  return crypto.subtle.deriveKey({
    name: 'HKDF',
    hash: 'SHA-256',
    salt,
    info
  }, baseKey, {
    name: 'AES-GCM',
    length: 256
  }, false, [
    'encrypt',
    'decrypt'
  ]);
}
async function encryptValue(key, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({
    name: 'AES-GCM',
    iv
  }, key, plaintext);
  const packed = new Uint8Array(12 + ciphertext.byteLength);
  packed.set(iv, 0);
  packed.set(new Uint8Array(ciphertext), 12);
  return btoa(String.fromCharCode(...packed));
}
async function decryptValue(key, enc) {
  const packed = Uint8Array.from(atob(enc), (c)=>c.charCodeAt(0));
  const iv = packed.slice(0, 12);
  const ciphertext = packed.slice(12);
  const plaintext = await crypto.subtle.decrypt({
    name: 'AES-GCM',
    iv
  }, key, ciphertext);
  return JSON.parse(new TextDecoder().decode(plaintext));
}
// ─── Question bank ────────────────────────────────────────────────────────
const QUESTION_BANK = [
  {
    id: 'pace.wake_time',
    section: 'pace',
    prompt: 'What time do you usually wake up on vacation?',
    kind: 'time',
    defaultVisibility: 'aggregate',
    sensitive: false,
    dimension: 'wake_time',
    optional: false
  },
  {
    id: 'pace.bedtime',
    section: 'pace',
    prompt: 'What time do you usually go to bed?',
    kind: 'time',
    defaultVisibility: 'aggregate',
    sensitive: false,
    dimension: 'wake_time',
    optional: false
  },
  {
    id: 'pace.activities_per_day',
    section: 'pace',
    prompt: 'How many planned activities do you prefer per day?',
    kind: 'single',
    options: [
      {
        value: '1-2',
        label: '1–2 (relaxed)'
      },
      {
        value: '3-4',
        label: '3–4 (balanced)'
      },
      {
        value: '5+',
        label: '5+ (packed)'
      }
    ],
    defaultVisibility: 'aggregate',
    sensitive: false,
    dimension: 'pace',
    optional: false
  },
  {
    id: 'pace.walking_km',
    section: 'pace',
    prompt: 'How many km are you comfortable walking per day?',
    kind: 'range',
    scale: {
      min: 0,
      max: 30,
      minLabel: '0 km',
      maxLabel: '30+ km'
    },
    defaultVisibility: 'aggregate',
    sensitive: false,
    dimension: 'pace',
    optional: false
  },
  {
    id: 'pace.downtime',
    section: 'pace',
    prompt: 'How much do you need downtime (rest/quiet time) each day?',
    kind: 'scale',
    scale: {
      min: 1,
      max: 5,
      minLabel: 'Not at all',
      maxLabel: 'Essential'
    },
    defaultVisibility: 'aggregate',
    sensitive: false,
    dimension: 'pace',
    optional: false
  },
  {
    id: 'must_dos.must_dos',
    section: 'must_dos',
    prompt: 'List up to 3 things you absolutely must do on this trip.',
    kind: 'list',
    defaultVisibility: 'shared',
    sensitive: false,
    dimension: 'must_dos',
    optional: true
  },
  {
    id: 'must_dos.rather_skip',
    section: 'must_dos',
    prompt: 'List up to 3 things you would rather skip.',
    kind: 'list',
    defaultVisibility: 'aggregate',
    sensitive: false,
    dimension: 'must_dos',
    optional: true
  },
  {
    id: 'must_dos.interests',
    section: 'must_dos',
    prompt: 'What are your main interests for this trip?',
    kind: 'multi',
    options: [
      {
        value: 'history',
        label: 'History & Culture'
      },
      {
        value: 'food',
        label: 'Food & Dining'
      },
      {
        value: 'nature',
        label: 'Nature & Outdoors'
      },
      {
        value: 'nightlife',
        label: 'Nightlife'
      },
      {
        value: 'shopping',
        label: 'Shopping'
      },
      {
        value: 'art',
        label: 'Art & Museums'
      },
      {
        value: 'adventure',
        label: 'Adventure Sports'
      },
      {
        value: 'relaxation',
        label: 'Relaxation'
      },
      {
        value: 'local',
        label: 'Local Life'
      }
    ],
    defaultVisibility: 'aggregate',
    sensitive: false,
    dimension: 'interests',
    optional: true
  },
  {
    id: 'together.togetherness',
    section: 'together',
    prompt: 'How much time do you want to spend together as a group?',
    kind: 'scale',
    scale: {
      min: 1,
      max: 5,
      minLabel: 'Everything together',
      maxLabel: 'Meet for dinner only'
    },
    defaultVisibility: 'aggregate',
    sensitive: false,
    dimension: 'together',
    optional: false
  },
  {
    id: 'together.skip_ok',
    section: 'together',
    prompt: 'Is it fine for anyone to skip an activity without explaining why?',
    kind: 'single',
    options: [
      {
        value: 'yes',
        label: 'Yes, totally fine'
      },
      {
        value: 'prefer_notice',
        label: 'Fine, but a heads-up is nice'
      },
      {
        value: 'no',
        label: 'We should all do things together'
      }
    ],
    defaultVisibility: 'aggregate',
    sensitive: false,
    dimension: 'together',
    optional: false
  },
  {
    id: 'rooms.room_sharing',
    section: 'rooms',
    prompt: 'What is your room-sharing comfort level?',
    kind: 'single',
    options: [
      {
        value: 'own_room',
        label: 'I need my own room'
      },
      {
        value: 'partner',
        label: 'Happy to share with my partner'
      },
      {
        value: 'anyone',
        label: 'Happy to share with anyone'
      }
    ],
    defaultVisibility: 'private',
    sensitive: false,
    dimension: 'rooms',
    optional: false
  },
  {
    id: 'rooms.light_sleeper',
    section: 'rooms',
    prompt: 'Are you a light sleeper?',
    kind: 'single',
    options: [
      {
        value: 'yes',
        label: 'Yes'
      },
      {
        value: 'no',
        label: 'No'
      },
      {
        value: 'sometimes',
        label: 'Sometimes'
      }
    ],
    defaultVisibility: 'private',
    sensitive: false,
    dimension: 'rooms',
    optional: true
  },
  {
    id: 'money.shared_meals',
    section: 'money',
    prompt: 'For shared meals, how should we split the bill?',
    kind: 'single',
    options: [
      {
        value: 'even',
        label: 'Split evenly'
      },
      {
        value: 'ordered',
        label: 'Pay for what you order'
      },
      {
        value: 'flexible',
        label: 'Flexible — decide each time'
      }
    ],
    defaultVisibility: 'aggregate',
    sensitive: false,
    dimension: 'splitting',
    optional: false
  },
  {
    id: 'money.drinks',
    section: 'money',
    prompt: 'How should drinks be handled?',
    kind: 'single',
    options: [
      {
        value: 'included',
        label: 'Include in the shared split'
      },
      {
        value: 'separate',
        label: 'Everyone pays for their own'
      },
      {
        value: 'flexible',
        label: 'Decide each time'
      }
    ],
    defaultVisibility: 'aggregate',
    sensitive: false,
    dimension: 'splitting',
    optional: false
  },
  {
    id: 'money.deposit',
    section: 'money',
    prompt: 'Are you comfortable paying a deposit upfront for the group?',
    kind: 'single',
    options: [
      {
        value: 'yes',
        label: 'Yes'
      },
      {
        value: 'small_only',
        label: 'Yes, for small amounts'
      },
      {
        value: 'no',
        label: 'No'
      }
    ],
    defaultVisibility: 'private',
    sensitive: false,
    dimension: 'money_comfort',
    optional: true
  },
  {
    id: 'decisions.decision_style',
    section: 'decisions',
    prompt: 'How should group decisions be made?',
    kind: 'single',
    options: [
      {
        value: 'organizer_small',
        label: 'Organizer decides small things; vote on big ones'
      },
      {
        value: 'vote_all',
        label: 'Vote on everything'
      },
      {
        value: 'organizer_all',
        label: 'Organizer decides; others can raise concerns'
      }
    ],
    defaultVisibility: 'aggregate',
    sensitive: false,
    dimension: 'decision_style',
    optional: false
  },
  {
    id: 'dropout.dropout_rule',
    section: 'dropout',
    prompt: 'If someone drops out after booking, who covers non-refundable costs?',
    kind: 'single',
    options: [
      {
        value: 'person',
        label: 'The person dropping out'
      },
      {
        value: 'shared',
        label: 'Shared by everyone'
      },
      {
        value: 'case_by_case',
        label: 'Decide case by case'
      }
    ],
    defaultVisibility: 'aggregate',
    sensitive: false,
    dimension: 'dropout',
    optional: false
  },
  {
    id: 'food.dietary',
    section: 'food',
    prompt: 'Do you have any dietary needs or allergies we should plan around?',
    kind: 'text',
    defaultVisibility: 'private',
    sensitive: true,
    dimension: 'dietary',
    optional: true
  },
  {
    id: 'food.adventurousness',
    section: 'food',
    prompt: 'How adventurous are you with food?',
    kind: 'scale',
    scale: {
      min: 1,
      max: 5,
      minLabel: 'Stick to familiar',
      maxLabel: 'Try anything'
    },
    defaultVisibility: 'aggregate',
    sensitive: false,
    dimension: 'food',
    optional: false
  },
  {
    id: 'comms.social_media',
    section: 'comms',
    prompt: 'Is it OK to post group photos of you on social media?',
    kind: 'single',
    options: [
      {
        value: 'yes',
        label: 'Yes, go ahead'
      },
      {
        value: 'ask_first',
        label: 'Please ask me first'
      },
      {
        value: 'no',
        label: 'Please do not post photos of me'
      }
    ],
    defaultVisibility: 'shared',
    sensitive: false,
    dimension: 'photo_consent',
    optional: false
  },
  {
    id: 'comms.chat_intensity',
    section: 'comms',
    prompt: 'What group chat style works for you?',
    kind: 'single',
    options: [
      {
        value: 'important',
        label: 'Important updates only'
      },
      {
        value: 'normal',
        label: 'Normal conversation'
      },
      {
        value: 'chatty',
        label: 'Chatty — I love the banter'
      }
    ],
    defaultVisibility: 'aggregate',
    sensitive: false,
    dimension: 'comms',
    optional: false
  },
  {
    id: 'access.accessibility',
    section: 'access',
    prompt: 'Do you have any mobility or accessibility needs we should plan around?',
    kind: 'text',
    defaultVisibility: 'private',
    sensitive: true,
    dimension: 'accessibility',
    optional: true
  }
];
const QUESTION_MAP = new Map(QUESTION_BANK.map((q)=>[
    q.id,
    q
  ]));
// ─── Suggestion library ─────────────────────────────────────────────────────
// FABRICATION FIX 2026-09-19 — three suggestion builders below turned an
// EMPTY distribution into a statement of group consensus. `?? 'even'`,
// `?? 'case_by_case'` and the decision_style ternary (whose `!== 'vote_all'`
// arm swallows `undefined`) all rendered a confident "Most common
// preference: X" when nothing had been recorded for that dimension —
// attributing an opinion to the group that nobody expressed. An empty
// distribution means no usable answers were decrypted for that dimension,
// not that the group agreed on the default. `topPreference` returns null in
// that case and each builder now says so instead of inventing a preference.
function topPreference(dist) {
  const entries = Object.entries(dist).filter(([, n])=>typeof n === 'number' && n > 0);
  if (entries.length === 0) return null;
  entries.sort((a, b)=>b[1] - a[1]);
  return entries[0][0];
}
const SUGGESTIONS = {
  wake_time: (state)=>state === 'divergent' ? [
      {
        id: 'sug_wake_split',
        text: 'Plan split mornings: early risers get a sunrise option; meet at 11:00 for the first shared activity.',
        appliesTo: 'plan',
        action: {
          kind: 'set_first_shared_time',
          payload: {
            time: '11:00'
          }
        }
      }
    ] : [],
  pace: (state)=>state === 'divergent' ? [
      {
        id: 'sug_pace_anchor',
        text: 'Mark 1–2 anchor activities per day as "together"; everything else optional.',
        appliesTo: 'plan',
        action: {
          kind: 'enable_optional_attendance',
          payload: {}
        }
      }
    ] : [],
  together: (state)=>state !== 'aligned' ? [
      {
        id: 'sug_together_dinner',
        text: 'Schedule shared dinners and free afternoons to balance group time and personal space.',
        appliesTo: 'plan',
        action: {
          kind: 'add_dinner_placeholders',
          payload: {}
        }
      }
    ] : [],
  splitting: (state, dist)=>{
    if (state === 'aligned') return [];
    const top = topPreference(dist);
    return [
      {
        id: 'sug_split_rule',
        text: top === null ? 'Split shared dishes evenly; drinks and individual orders separately. (No split preferences have been recorded for this group yet, so this is a starting suggestion rather than the group preference.)' : `Split shared dishes evenly; drinks and individual orders separately. (Most common preference so far: ${top})`,
        appliesTo: 'money',
        action: {
          kind: 'set_default_split',
          payload: {
            rule: 'dishes_even_drinks_separate',
            basedOnPreference: top
          }
        }
      }
    ];
  },
  dropout: (state, dist)=>{
    if (state === 'aligned') return [];
    const top = topPreference(dist);
    return [
      {
        id: 'sug_dropout_clause',
        text: top === null ? 'Agree on a drop-out rule now. No drop-out preferences have been recorded for this group yet, so there is no stated preference to build on.' : `Agree on a drop-out rule now. Most common preference so far: "${top}".`,
        appliesTo: '5E2',
        action: {
          kind: 'prefill_dropout_clause',
          payload: {
            rule: top
          }
        }
      }
    ];
  },
  decision_style: (_state, dist)=>{
    const top = topPreference(dist);
    let text;
    if (top === null) {
      text = 'Configure group decisions: no decision-style preferences have been recorded for this group yet, so pick a default together rather than assuming one.';
    } else if (top === 'vote_all') {
      text = 'Configure group decisions: vote on everything.';
    } else if (top === 'organizer_all') {
      text = 'Configure group decisions: organizer decides, others can raise concerns.';
    } else {
      text = 'Configure group decisions: organizer decides small items, vote on big ones.';
    }
    return [
      {
        id: 'sug_decision_config',
        text,
        appliesTo: '5E3',
        action: {
          kind: 'configure_voting_defaults',
          payload: {
            style: top
          }
        }
      }
    ];
  },
  rooms: (state)=>state !== 'aligned' ? [
      {
        id: 'sug_rooms_options',
        text: 'Consider booking a mix of room types to accommodate different preferences.',
        appliesTo: 'rooms',
        action: {
          kind: 'note_room_preferences',
          payload: {}
        }
      }
    ] : []
};
// ─── Alignment engine ───────────────────────────────────────────────────────
function parseTimeMinutes(t) {
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return parseInt(m[1]) * 60 + parseInt(m[2]);
}
function stdDev(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b)=>a + b, 0) / values.length;
  const variance = values.reduce((s, v)=>s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}
function classifyState(dimension, kind, values, rangeFloor = 0) {
  const distribution = {};
  if (kind === 'time') {
    const minutes = values.map((v)=>parseTimeMinutes(String(v))).filter((v)=>v !== null);
    if (minutes.length < 2) return {
      state: 'aligned',
      distribution
    };
    const spread = Math.max(...minutes) - Math.min(...minutes);
    // Handle wrap-around (e.g. 23:00 vs 01:00)
    const altSpread = 24 * 60 - spread;
    const effectiveSpread = Math.min(spread, altSpread);
    const state = effectiveSpread < 90 ? 'aligned' : effectiveSpread <= 180 ? 'mixed' : 'divergent';
    return {
      state,
      distribution
    };
  }
  if (kind === 'scale') {
    const nums = values.map(Number).filter((v)=>!isNaN(v));
    if (nums.length < 2) return {
      state: 'aligned',
      distribution
    };
    const sd = stdDev(nums);
    const state = sd < 0.8 ? 'aligned' : sd <= 1.4 ? 'mixed' : 'divergent';
    return {
      state,
      distribution
    };
  }
  if (kind === 'range') {
    // 2026-09-25: answers are [min, max] intervals (or {min,max}); a bare
    // number n means "up to n" = [rangeFloor, n]. Alignment = overlap / union.
    const ranges = [];
    for (const v of values){
      let lo, hi;
      if (Array.isArray(v) && v.length >= 2) {
        lo = Number(v[0]);
        hi = Number(v[1]);
      } else if (v && typeof v === 'object' && 'min' in v) {
        lo = Number(v.min);
        hi = Number(v.max);
      } else {
        lo = rangeFloor;
        hi = Number(v);
      }
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;
      ranges.push(lo <= hi ? [
        lo,
        hi
      ] : [
        hi,
        lo
      ]);
    }
    if (ranges.length < 2) return {
      state: 'aligned',
      distribution
    };
    const overlap = Math.min(...ranges.map((r)=>r[1])) - Math.max(...ranges.map((r)=>r[0]));
    const union = Math.max(...ranges.map((r)=>r[1])) - Math.min(...ranges.map((r)=>r[0]));
    if (union === 0) return {
      state: 'aligned',
      distribution
    }; // everyone gave the same point
    if (overlap < 0) return {
      state: 'divergent',
      distribution
    };
    const ratio = overlap / union;
    const state = ratio >= 0.5 ? 'aligned' : ratio >= 0.25 ? 'mixed' : 'divergent';
    return {
      state,
      distribution
    };
  }
  if (kind === 'single' || kind === 'multi') {
    const flat = [];
    for (const v of values){
      if (Array.isArray(v)) flat.push(...v.map(String));
      else flat.push(String(v));
    }
    for (const v of flat)distribution[v] = (distribution[v] ?? 0) + 1;
    const total = flat.length;
    if (total === 0) return {
      state: 'aligned',
      distribution
    };
    const topShare = Math.max(...Object.values(distribution)) / total;
    const state = topShare >= 0.75 ? 'aligned' : topShare >= 0.5 ? 'mixed' : 'divergent';
    return {
      state,
      distribution
    };
  }
  // list / text — no numeric alignment
  return {
    state: 'aligned',
    distribution
  };
}
async function computeAlignment(tripId) {
  const svc = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  // 2026-09-25: the 2-minute "computed recently" skip is removed — it dropped
  // every answer saved inside the window from the report. Every save recomputes.
  // Fetch all responses
  const { data: rows, error } = await svc.from('agreement_responses').select('member_id, question_id, value_enc, visibility').eq('trip_id', tripId);
  if (error) {
    console.log('[agreement-engine] computeAlignment fetch error', error);
    return;
  }
  if (!rows || rows.length === 0) {
    console.log('[agreement-engine] computeAlignment: no responses yet for', tripId);
    return;
  }
  // Decrypt all responses
  const decrypted = [];
  const memberIds = [
    ...new Set(rows.map((r)=>r.member_id))
  ];
  for (const row of rows){
    try {
      const key = await deriveKey(tripId, row.member_id);
      const value = await decryptValue(key, row.value_enc);
      decrypted.push({
        memberId: row.member_id,
        questionId: row.question_id,
        value,
        visibility: row.visibility
      });
    } catch (e) {
      console.log('[agreement-engine] decrypt error for', row.question_id, e);
    }
  }
  // 2026-09-25: group by QUESTION (each has its own kind), then roll up to
  // the dimension. See header item 1.
  const visOrder = [
    'shared',
    'aggregate',
    'private'
  ];
  const byQuestion = new Map();
  for (const d of decrypted){
    const q = QUESTION_MAP.get(d.questionId);
    if (!q) continue;
    let entry = byQuestion.get(q.id);
    if (!entry) {
      entry = {
        q,
        visibility: d.visibility,
        values: []
      };
      byQuestion.set(q.id, entry);
    }
    entry.values.push(d.value);
    // Use least-private visibility across responses to this question
    if (visOrder.indexOf(d.visibility) < visOrder.indexOf(entry.visibility)) entry.visibility = d.visibility;
  }
  const respondentCount = memberIds.length;
  const dimensionResults = {};
  const allSuggestions = [];
  const stateRank = {
    aligned: 0,
    mixed: 1,
    divergent: 2
  };
  const byDimension = new Map();
  // QUESTION_BANK order, so "first question of a dimension" is stable.
  for (const q of QUESTION_BANK){
    const entry = byQuestion.get(q.id);
    if (!entry) continue;
    if (!byDimension.has(q.dimension)) byDimension.set(q.dimension, []);
    byDimension.get(q.dimension).push(entry);
  }
  for (const [dim, entries] of byDimension){
    let dimState = 'aligned';
    let dimDistribution = null;
    let dimShowDistribution = false;
    const questions = {};
    for (const { q, visibility, values } of entries){
      const { state, distribution } = classifyState(dim, q.kind, values, q.scale?.min ?? 0);
      const show = respondentCount >= 3 && (visibility === 'aggregate' || visibility === 'shared');
      const hasDist = Object.keys(distribution).length > 0;
      questions[q.id] = {
        kind: q.kind,
        state,
        ...show && hasDist ? {
          distribution
        } : {}
      };
      if (stateRank[state] > stateRank[dimState]) dimState = state;
      if (dimDistribution === null && (q.kind === 'single' || q.kind === 'multi')) {
        dimDistribution = distribution;
        dimShowDistribution = show;
      }
    }
    const distribution = dimDistribution ?? {};
    const sugFn = SUGGESTIONS[dim];
    const suggestions = sugFn ? sugFn(dimState, distribution) : [];
    allSuggestions.push(...suggestions);
    dimensionResults[dim] = {
      state: dimState,
      ...dimShowDistribution ? {
        distribution
      } : {},
      suggestions,
      questions
    };
  }
  // Collect must-dos (shared visibility only)
  const mustDos = [];
  for (const d of decrypted){
    if (d.questionId === 'must_dos.must_dos' && d.visibility === 'shared') {
      const items = Array.isArray(d.value) ? d.value : [
        d.value
      ];
      mustDos.push(...items.map(String));
    }
  }
  // Collect rather-skips for conflict check
  const ratherSkips = [];
  for (const d of decrypted){
    if (d.questionId === 'must_dos.rather_skip') {
      const items = Array.isArray(d.value) ? d.value : [
        d.value
      ];
      ratherSkips.push(...items.map(String));
    }
  }
  // Conflict checks
  const conflicts = [];
  // Must-do vs rather-skip word overlap
  for (const mustDo of mustDos){
    const words = mustDo.toLowerCase().split(/\s+/).filter((w)=>w.length > 3);
    for (const skip of ratherSkips){
      const skipLower = skip.toLowerCase();
      if (words.some((w)=>skipLower.includes(w))) {
        conflicts.push({
          kind: 'must_do_skip_conflict',
          severity: 'warning',
          message: `A group must-do may conflict with someone's rather-skip list. Consider discussing "${mustDo}" before finalising the itinerary.`
        });
        break;
      }
    }
  }
  // Photo consent
  const photoConsentValues = decrypted.filter((d)=>d.questionId === 'comms.social_media').map((d)=>d.value);
  if (photoConsentValues.includes('no')) {
    conflicts.push({
      kind: 'photo_consent',
      severity: 'info',
      message: 'At least one group member prefers not to have photos posted on social media. Please check before posting.'
    });
  }
  // Dietary + dining reservations.
  // 2026-09-25: food.dietary is sensitive and always stored 'private', so the
  // old `visibility === 'shared'` filter meant this never ran. Any non-empty
  // answer counts; the conflict says only that SOMEONE has a need — never who,
  // how many, or what (see header item 4).
  const NO_DIET = new Set([
    '',
    'no',
    'none',
    'n/a',
    'na',
    'nope',
    'nothing',
    'no restrictions',
    'none.',
    'no.'
  ]);
  const someoneHasDietaryNeed = decrypted.some((d)=>{
    if (d.questionId !== 'food.dietary') return false;
    const v = Array.isArray(d.value) ? d.value.join(' ') : d.value == null ? '' : String(d.value);
    return !NO_DIET.has(v.trim().toLowerCase());
  });
  if (someoneHasDietaryNeed) {
    // SCHEMA FIX 2026-09-19 — this filtered `.eq('type', 'dining')`. There is
    // no `type` column on `reservations` (it is `reservation_type`) and there
    // is no `dining` value (the check constraint allows upper-case values, of
    // which the dining one is `RESTAURANT`). Postgres rejected the whole
    // query with 42703 every time, the error was only logged, and `reservations`
    // came back undefined — so this conflict has NEVER been raised, on any
    // trip, since the check was written. A group that shared dietary needs was
    // never once told to check the restaurant bookings.
    const { data: reservations, error: reservationsErr } = await svc.from('reservations').select('id').eq('trip_id', tripId).eq('reservation_type', 'RESTAURANT').limit(1);
    if (reservationsErr) {
      // Do not silently drop the check: say that it could not run.
      console.error('[agreement-engine] dining reservations lookup failed:', reservationsErr.message);
      conflicts.push({
        kind: 'dietary_dining_check_failed',
        severity: 'warning',
        message: 'Someone in the group has a dietary need, but the dining-reservation lookup failed, so this check did not run. Review dining reservations manually.'
      });
    } else if (reservations && reservations.length > 0) {
      conflicts.push({
        kind: 'dietary_dining',
        severity: 'info',
        message: 'Someone in the group has a dietary need. Check that your restaurant bookings can accommodate dietary requirements.'
      });
    }
  }
  const report = {
    tripId,
    dimensions: dimensionResults,
    mustDos,
    conflicts,
    suggestions: allSuggestions,
    respondentCount,
    computedAt: new Date().toISOString()
  };
  // ERROR FIX 2026-09-19 — this upsert discarded its error. When it failed,
  // computeAlignment still logged "done" and handleGetReport went on serving
  // the previous report as if it were current (or 404ing on a trip that had
  // in fact been analysed). Capture it and throw, so the fire-and-forget
  // caller's .catch logs a real failure instead of a success line.
  const { error: upsertErr } = await svc.from('alignment_reports').upsert({
    trip_id: tripId,
    report,
    respondent_count: respondentCount,
    computed_at: new Date().toISOString()
  }, {
    onConflict: 'trip_id'
  });
  if (upsertErr) {
    console.error('[agreement-engine] alignment_reports upsert failed for', tripId, '-', upsertErr.message, '- report NOT persisted; getReport will keep serving the previous report or 404');
    throw new Error(`alignment_reports upsert failed for ${tripId}: ${upsertErr.message}`);
  }
  console.log('[agreement-engine] computeAlignment done for', tripId, 'respondents:', respondentCount);
}
// ─── Auth helpers ────────────────────────────────────────────────────────
// AUTH FIX 2026-09-18 — this function was rejecting every VALID user JWT with
// 401 "Missing or invalid JWT", denying all legitimate signed-in callers on
// all eight routes while still looking correctly secured to an anonymous
// probe (which gets 401 either way). Found only by calling it with a real
// session.
//
// Cause: the global header key below was lowercase `authorization`. supabase-js
// v2 seeds its auth sub-client with `Authorization: Bearer <anon key>`, and
// plain JS object keys are case-sensitive — so a lowercase key does NOT
// overwrite that entry. Both survived, fetch folded them into a single
// `authorization: Bearer <anon>, Bearer <jwt>`, GoTrue could not parse it, and
// getUser() returned null. (The same casing mismatch also defeats auth-js's
// case-sensitive `'Authorization' in headers` check.) The capital `A` is
// load-bearing — do not "tidy" it to lowercase.
//
// Passing the token explicitly to getUser(token) as well, so this does not
// depend on header-merge behaviour of whatever @2 resolves to at build time.
async function getUser(req) {
  const authHeader = req.headers.get('authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const client = createClient(SUPABASE_URL, ANON_KEY, {
    global: {
      headers: {
        Authorization: `Bearer ${token}`
      }
    }
  });
  const { data: { user }, error } = await client.auth.getUser(token);
  if (error || !user) {
    if (error) console.error('[agreement-engine] getUser failed:', error.message);
    return null;
  }
  return user;
}
/**
 * Map an auth uuid (user.id from the JWT) to the TravelOS platform user id
 * (`usr_<hex>`) that `trip_members.user_id` actually stores.
 *
 * USER-AXIS FIX 2026-09-18 — see the header note. Match on `provider_subject`
 * ALONE: the `provider` column varies by sign-in method, and filtering on it
 * would silently deny everyone. Returns null when no bridge row exists; the
 * callers then fall through to the uuid-based `isTripOwner` check rather than
 * querying trip_members with an id that cannot match.
 */ async function resolvePlatformUserId(svc, authUserId) {
  const { data, error } = await svc.from('auth_identities').select('user_id').eq('provider_subject', authUserId).maybeSingle();
  if (error) {
    console.error('[agreement-engine] resolvePlatformUserId lookup failed:', error.message);
    return null;
  }
  return data?.user_id ?? null;
}
async function getMemberId(svc, tripId, authUserId) {
  const platformUserId = await resolvePlatformUserId(svc, authUserId);
  if (!platformUserId) {
    console.warn('[agreement-engine] getMemberId: no platform id for auth uuid', authUserId);
    return authUserId;
  }
  const { data, error } = await svc.from('trip_members').select('id').eq('trip_id', tripId).eq('user_id', platformUserId).is('removed_at', null).maybeSingle();
  if (error) console.error('[agreement-engine] getMemberId lookup failed:', error.message);
  return data?.id ?? platformUserId ?? authUserId;
}
/**
 * True if `userId` owns `tripId` in the trips table (uuid owner column).
 * SECURITY: this gates checkMembership/checkOrganizerRole's fallback path.
 * A query error must not be mistaken for "not found and therefore allow" —
 * `data` is falsy either way, so `!!data` already denies on error. The
 * error is now captured and logged for visibility, not swallowed.
 *
 * NOTE: this one takes the AUTH UUID, not the platform id — `trips.user_id`
 * is a uuid column. Do not route the resolved platform id here.
 */ async function isTripOwner(svc, tripId, userId) {
  const { data, error } = await svc.from('trips').select('id').eq('id', tripId).eq('user_id', userId).maybeSingle();
  if (error) console.error('[agreement-engine] isTripOwner lookup failed (denying):', error.message);
  return !!data;
}
async function checkMembership(svc, tripId, authUserId) {
  const platformUserId = await resolvePlatformUserId(svc, authUserId);
  if (!platformUserId) {
    console.warn('[agreement-engine] checkMembership: no platform id for auth uuid', authUserId, '— falling back to trip owner check');
    return await isTripOwner(svc, tripId, authUserId);
  }
  const { data, error } = await svc.from('trip_members').select('id').eq('trip_id', tripId).eq('user_id', platformUserId).is('removed_at', null).maybeSingle();
  if (error) console.error('[agreement-engine] checkMembership lookup failed:', error.message);
  if (!data) {
    // trip_members is not populated for every trip yet. Rather than treat an
    // empty roster as "open to anyone", fall back to the trip's actual
    // owner — see the SECURITY note above. isTripOwner takes the AUTH uuid.
    return await isTripOwner(svc, tripId, authUserId);
  }
  return true;
}
async function checkOrganizerRole(svc, tripId, authUserId) {
  const platformUserId = await resolvePlatformUserId(svc, authUserId);
  if (!platformUserId) {
    console.warn('[agreement-engine] checkOrganizerRole: no platform id for auth uuid', authUserId, '— falling back to trip owner check');
    return await isTripOwner(svc, tripId, authUserId);
  }
  const { data, error } = await svc.from('trip_members').select('role').eq('trip_id', tripId).eq('user_id', platformUserId).is('removed_at', null).maybeSingle();
  if (error) console.error('[agreement-engine] checkOrganizerRole lookup failed:', error.message);
  if (!data) {
    // Same fallback as checkMembership: the trip owner is always an
    // organizer; nobody else is, regardless of whether trip_members has any
    // rows for this trip. isTripOwner takes the AUTH uuid.
    return await isTripOwner(svc, tripId, authUserId);
  }
  return data.role === 'owner' || data.role === 'organizer';
}
async function getMemberDisplayNames(svc, tripId) {
  const { data, error } = await svc.from('trip_members').select('id, user_id, display_name').eq('trip_id', tripId).is('removed_at', null);
  if (error) console.error('[agreement-engine] getMemberDisplayNames lookup failed:', error.message);
  const map = new Map();
  for (const m of data ?? []){
    map.set(m.id, m.display_name ?? m.user_id);
    map.set(m.user_id, m.display_name ?? m.user_id);
  }
  return map;
}
// ─── Visibility ordering ─────────────────────────────────────────────────────
const VIS_ORDER = {
  shared: 0,
  aggregate: 1,
  private: 2
};
function resolveVisibility(requested, defaultVis, sensitive) {
  if (sensitive) return 'private';
  if (!requested) return defaultVis;
  // Can only make more private, not less
  return VIS_ORDER[requested] >= VIS_ORDER[defaultVis] ? requested : defaultVis;
}
// ─── Route handlers ────────────────────────────────────────────────────────
async function handlePutQuestionnaire(req) {
  const user = await getUser(req);
  if (!user) return err('UNAUTHORIZED', 'Missing or invalid JWT', 401);
  const body = await req.json();
  const { tripId, questionIds, customQuestions, deadline, status } = body;
  if (!tripId) return err('BAD_REQUEST', 'tripId required', 400);
  const svc = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const isOrg = await checkOrganizerRole(svc, tripId, user.id);
  if (!isOrg) return err('FORBIDDEN', 'Only organizers can configure the questionnaire', 403);
  const now = new Date().toISOString();
  const upsertData = {
    trip_id: tripId,
    updated_at: now
  };
  if (questionIds !== undefined) upsertData.question_ids = questionIds;
  if (customQuestions !== undefined) upsertData.custom_questions = customQuestions;
  if (deadline !== undefined) upsertData.deadline = deadline;
  if (status !== undefined) upsertData.status = status;
  const { data, error } = await svc.from('agreement_questionnaires').upsert(upsertData, {
    onConflict: 'trip_id'
  }).select().single();
  if (error) {
    console.log('[agreement-engine] upsert questionnaire error', error);
    return err('DB_ERROR', error.message, 500);
  }
  return json(data);
}
async function handleOpenQuestionnaire(req) {
  const user = await getUser(req);
  if (!user) return err('UNAUTHORIZED', 'Missing or invalid JWT', 401);
  const body = await req.json();
  const { tripId } = body;
  if (!tripId) return err('BAD_REQUEST', 'tripId required', 400);
  const svc = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const isOrg = await checkOrganizerRole(svc, tripId, user.id);
  if (!isOrg) return err('FORBIDDEN', 'Only organizers can open the questionnaire', 403);
  const { error } = await svc.from('agreement_questionnaires').upsert({
    trip_id: tripId,
    status: 'open',
    updated_at: new Date().toISOString()
  }, {
    onConflict: 'trip_id'
  });
  if (error) {
    console.log('[agreement-engine] open questionnaire error', error);
    return err('DB_ERROR', error.message, 500);
  }
  const { count: memberCount, error: memberCountErr } = await svc.from('trip_members').select('id', {
    count: 'exact',
    head: true
  }).eq('trip_id', tripId).is('removed_at', null);
  // FABRICATION FIX 2026-09-19 — `memberCount ?? 0` reported "0 members" to
  // the organiser when the count query FAILED, which is indistinguishable
  // from a genuinely empty roster. The questionnaire really was opened, so
  // this still succeeds, but an unavailable count is now reported as
  // unavailable (null) rather than as zero.
  if (memberCountErr) {
    console.error('[agreement-engine] member count lookup failed:', memberCountErr.message);
    return json({
      success: true,
      memberCount: null,
      memberCountAvailable: false,
      memberCountError: memberCountErr.message
    });
  }
  return json({
    success: true,
    memberCount: memberCount ?? 0,
    memberCountAvailable: true
  });
}
async function handleGetQuestions(req) {
  const user = await getUser(req);
  if (!user) return err('UNAUTHORIZED', 'Missing or invalid JWT', 401);
  const url = new URL(req.url);
  const tripId = url.searchParams.get('tripId');
  if (!tripId) return err('BAD_REQUEST', 'tripId required', 400);
  const svc = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const isMember = await checkMembership(svc, tripId, user.id);
  if (!isMember) return err('NOT_FOUND', 'Trip not found or not a member', 404);
  const memberId = await getMemberId(svc, tripId, user.id);
  // Load questionnaire config
  const { data: qConfig, error: qConfigErr } = await svc.from('agreement_questionnaires').select('*').eq('trip_id', tripId).maybeSingle();
  if (qConfigErr) console.error('[agreement-engine] questionnaire config lookup failed:', qConfigErr.message);
  const questionIds = qConfig?.question_ids ?? QUESTION_BANK.map((q)=>q.id);
  const customQuestions = qConfig?.custom_questions ?? [];
  const questions = questionIds.map((id)=>QUESTION_MAP.get(id)).filter((q)=>q !== undefined);
  // Fetch member's own existing answers
  const { data: existingRows, error: existingRowsErr } = await svc.from('agreement_responses').select('question_id, value_enc, visibility, updated_at').eq('trip_id', tripId).eq('member_id', memberId);
  if (existingRowsErr) console.error('[agreement-engine] existing answers lookup failed:', existingRowsErr.message);
  const existingAnswers = {};
  for (const row of existingRows ?? []){
    try {
      const key = await deriveKey(tripId, memberId);
      const value = await decryptValue(key, row.value_enc);
      existingAnswers[row.question_id] = {
        value,
        visibility: row.visibility,
        updatedAt: row.updated_at
      };
    } catch (e) {
      console.log('[agreement-engine] decrypt existing answer error', row.question_id, e);
    }
  }
  return json({
    questions,
    customQuestions,
    questionnaire: qConfig ?? null,
    existingAnswers
  });
}
async function handlePutResponses(req) {
  const user = await getUser(req);
  if (!user) return err('UNAUTHORIZED', 'Missing or invalid JWT', 401);
  const body = await req.json();
  const { tripId, answers } = body;
  if (!tripId || !Array.isArray(answers)) return err('BAD_REQUEST', 'tripId and answers[] required', 400);
  const svc = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const isMember = await checkMembership(svc, tripId, user.id);
  if (!isMember) return err('NOT_FOUND', 'Trip not found or not a member', 404);
  const memberId = await getMemberId(svc, tripId, user.id);
  const now = new Date().toISOString();
  const upsertRows = [];
  for (const answer of answers){
    const { questionId, value, visibility: requestedVis } = answer;
    const q = QUESTION_MAP.get(questionId);
    if (!q) continue;
    const finalVisibility = resolveVisibility(requestedVis, q.defaultVisibility, q.sensitive);
    const key = await deriveKey(tripId, memberId);
    const value_enc = await encryptValue(key, value);
    upsertRows.push({
      trip_id: tripId,
      member_id: memberId,
      question_id: questionId,
      value_enc,
      visibility: finalVisibility,
      updated_at: now
    });
  }
  if (upsertRows.length > 0) {
    const { error } = await svc.from('agreement_responses').upsert(upsertRows, {
      onConflict: 'trip_id,member_id,question_id'
    });
    if (error) {
      console.log('[agreement-engine] upsert responses error', error);
      return err('DB_ERROR', error.message, 500);
    }
  }
  // Upsert completion record
  const { error: compErr } = await svc.from('agreement_completions').upsert({
    trip_id: tripId,
    member_id: memberId,
    completed_at: now,
    question_count: upsertRows.length
  }, {
    onConflict: 'trip_id,member_id'
  });
  if (compErr) {
    console.log('[agreement-engine] upsert completion error', compErr);
  }
  // Trigger alignment computation. 2026-09-25: kept alive past the response
  // with EdgeRuntime.waitUntil (a bare un-awaited promise can be cut off).
  const recompute = computeAlignment(tripId).catch((e)=>console.log('[agreement-engine] computeAlignment error', e));
  try {
    // deno-lint-ignore no-explicit-any
    globalThis.EdgeRuntime?.waitUntil?.(recompute);
  } catch (e) {
    console.log('[agreement-engine] EdgeRuntime.waitUntil unavailable', e);
  }
  return json({
    success: true,
    completedAt: now
  });
}
async function handleGetMyResponses(req) {
  const user = await getUser(req);
  if (!user) return err('UNAUTHORIZED', 'Missing or invalid JWT', 401);
  const url = new URL(req.url);
  const tripId = url.searchParams.get('tripId');
  if (!tripId) return err('BAD_REQUEST', 'tripId required', 400);
  const svc = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const isMember = await checkMembership(svc, tripId, user.id);
  if (!isMember) return err('NOT_FOUND', 'Trip not found or not a member', 404);
  const memberId = await getMemberId(svc, tripId, user.id);
  const { data: rows, error } = await svc.from('agreement_responses').select('question_id, value_enc, visibility, updated_at').eq('trip_id', tripId).eq('member_id', memberId);
  if (error) return err('DB_ERROR', error.message, 500);
  const answers = [];
  for (const row of rows ?? []){
    try {
      const key = await deriveKey(tripId, memberId);
      const value = await decryptValue(key, row.value_enc);
      answers.push({
        questionId: row.question_id,
        value,
        visibility: row.visibility,
        updatedAt: row.updated_at
      });
    } catch (e) {
      console.log('[agreement-engine] decrypt my response error', row.question_id, e);
    }
  }
  return json({
    answers
  });
}
async function handleGetProgress(req) {
  const user = await getUser(req);
  if (!user) return err('UNAUTHORIZED', 'Missing or invalid JWT', 401);
  const url = new URL(req.url);
  const tripId = url.searchParams.get('tripId');
  if (!tripId) return err('BAD_REQUEST', 'tripId required', 400);
  const svc = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const isMember = await checkMembership(svc, tripId, user.id);
  if (!isMember) return err('NOT_FOUND', 'Trip not found or not a member', 404);
  const [{ data: completions, error: completionsErr }, { data: members, error: membersErr }] = await Promise.all([
    svc.from('agreement_completions').select('member_id, completed_at, question_count').eq('trip_id', tripId),
    svc.from('trip_members').select('id, user_id, display_name').eq('trip_id', tripId).is('removed_at', null)
  ]);
  // FABRICATION FIX 2026-09-19 — both errors were only logged. A failed
  // members read left `members` undefined, `memberList` empty, and execution
  // fell into the "return completions without member names" branch below,
  // which produces `pending: []`. The organiser was therefore told that
  // NOBODY was outstanding — a trip looked ready to proceed when in fact the
  // roster could not be read and nobody knew who had answered. A failed read
  // is now a 500 that says which read failed; it is never reported as an
  // empty pending list.
  if (completionsErr) {
    console.error('[agreement-engine] progress completions lookup failed:', completionsErr.message);
    return err('DB_ERROR', `Questionnaire completions lookup failed: ${completionsErr.message}`, 500);
  }
  if (membersErr) {
    console.error('[agreement-engine] progress members lookup failed:', membersErr.message);
    return err('DB_ERROR', `Trip member lookup failed, so questionnaire progress cannot be reported: ${membersErr.message}`, 500);
  }
  const completionMap = new Map((completions ?? []).map((c)=>[
      c.member_id,
      c
    ]));
  const memberList = members ?? [];
  const completed = [];
  const pending = [];
  if (memberList.length > 0) {
    for (const m of memberList){
      const comp = completionMap.get(m.id) ?? completionMap.get(m.user_id);
      const displayName = m.display_name ?? m.user_id;
      if (comp) {
        completed.push({
          memberId: m.id,
          displayName,
          completedAt: comp.completed_at,
          questionCount: comp.question_count
        });
      } else {
        pending.push({
          memberId: m.id,
          displayName
        });
      }
    }
  } else {
    // The members read SUCCEEDED and returned no rows (a genuinely empty
    // roster) — a failed read is now a 500 above and never reaches here.
    // `pending` is legitimately empty in this case; `rosterKnown: false`
    // below still tells the caller that these entries carry no member names.
    for (const [memberId, comp] of completionMap){
      completed.push({
        memberId,
        displayName: memberId,
        completedAt: comp.completed_at,
        questionCount: comp.question_count
      });
    }
  }
  return json({
    completed,
    pending,
    totalMembers: memberList.length || completionMap.size,
    completedCount: completed.length,
    // False when the trip roster came back empty, so `pending` is empty for
    // want of a roster rather than because everyone has answered.
    rosterKnown: memberList.length > 0
  });
}
async function handleGetReport(req) {
  const user = await getUser(req);
  if (!user) return err('UNAUTHORIZED', 'Missing or invalid JWT', 401);
  const url = new URL(req.url);
  const tripId = url.searchParams.get('tripId');
  if (!tripId) return err('BAD_REQUEST', 'tripId required', 400);
  const svc = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const isMember = await checkMembership(svc, tripId, user.id);
  if (!isMember) return err('NOT_FOUND', 'Trip not found or not a member', 404);
  const { data: reportRow, error } = await svc.from('alignment_reports').select('*').eq('trip_id', tripId).maybeSingle();
  if (error) return err('DB_ERROR', error.message, 500);
  if (!reportRow) return err('NOT_FOUND', 'No report available yet', 404);
  const report = reportRow.report;
  const respondentCount = reportRow.respondent_count;
  // Apply visibility filtering on dimensions
  const rawDimensions = report.dimensions ?? {};
  const filteredDimensions = {};
  for (const [dim, dimData] of Object.entries(rawDimensions)){
    // Find the visibility for this dimension from question bank
    const dimQuestions = QUESTION_BANK.filter((q)=>q.dimension === dim);
    const visibilities = dimQuestions.map((q)=>q.defaultVisibility);
    const isPrivate = visibilities.every((v)=>v === 'private');
    if (isPrivate) continue; // Never include private dimensions in report
    const hasAggregate = visibilities.some((v)=>v === 'aggregate' || v === 'shared');
    if (hasAggregate && respondentCount < 3) {
      // Show state only, no distribution
      filteredDimensions[dim] = {
        state: dimData.state,
        suggestions: dimData.suggestions
      };
    } else {
      filteredDimensions[dim] = dimData;
    }
  }
  return json({
    ...report,
    dimensions: filteredDimensions,
    respondentCount,
    computedAt: reportRow.computed_at
  });
}
async function handleApplySuggestion(req) {
  const user = await getUser(req);
  if (!user) return err('UNAUTHORIZED', 'Missing or invalid JWT', 401);
  const body = await req.json();
  const { tripId, suggestionId, actionPayload } = body;
  if (!tripId || !suggestionId) return err('BAD_REQUEST', 'tripId and suggestionId required', 400);
  const svc = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const isOrg = await checkOrganizerRole(svc, tripId, user.id);
  if (!isOrg) return err('FORBIDDEN', 'Only organizers can apply suggestions', 403);
  // Look up suggestion in latest report
  const { data: reportRow, error: reportRowErr } = await svc.from('alignment_reports').select('report').eq('trip_id', tripId).maybeSingle();
  if (reportRowErr) console.error('[agreement-engine] apply-suggestion report lookup failed:', reportRowErr.message);
  if (!reportRow) return err('NOT_FOUND', 'No report found for this trip', 404);
  const report = reportRow.report;
  const suggestion = (report.suggestions ?? []).find((s)=>s.id === suggestionId);
  if (!suggestion) return err('NOT_FOUND', `Suggestion ${suggestionId} not found in report`, 404);
  const appliedAt = new Date().toISOString();
  console.log('[agreement-engine] apply suggestion', suggestionId, 'for trip', tripId, 'action:', suggestion.action.kind, 'payload:', actionPayload ?? suggestion.action.payload);
  return json({
    success: true,
    appliedAt,
    suggestion
  });
}
// ─── Router ────────────────────────────────────────────────────────────────
Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: CORS
    });
  }
  const url = new URL(req.url);
  // Strip leading /agreement-engine prefix
  const path = url.pathname.replace(/^\/agreement-engine/, '') || '/';
  console.log('[agreement-engine]', req.method, path);
  try {
    if (req.method === 'PUT' && path === '/questionnaire') return await handlePutQuestionnaire(req);
    if (req.method === 'POST' && path === '/questionnaire/open') return await handleOpenQuestionnaire(req);
    if (req.method === 'GET' && path === '/questions') return await handleGetQuestions(req);
    if (req.method === 'PUT' && path === '/responses') return await handlePutResponses(req);
    if (req.method === 'GET' && path === '/responses/me') return await handleGetMyResponses(req);
    if (req.method === 'GET' && path === '/progress') return await handleGetProgress(req);
    if (req.method === 'GET' && path === '/report') return await handleGetReport(req);
    if (req.method === 'POST' && path === '/suggestions/apply') return await handleApplySuggestion(req);
    return err('NOT_FOUND', 'Route not found', 404);
  } catch (e) {
    console.log('[agreement-engine] unhandled error', e);
    return err('INTERNAL_ERROR', 'Internal server error', 500);
  }
});

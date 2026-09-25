import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { requireUser, requireTripOwner, serviceClient, corsHeaders } from './_shared/auth.ts';
// COLUMN NAMES 2026-09-19 — `itinerary_items` DOES exist. The comments below
// claiming otherwise (queue item Q2.9) were wrong, and because everyone
// believed them, the real defect went unexamined for as long as the table was
// presumed missing: this function named columns on it that do not exist.
//
//   itinerary_items.starts_at  → does not exist. The column is `start_time`
//                                (timestamptz). `get_trip_context` ordered by
//                                it, and PostgREST rejects the WHOLE query when
//                                an ordered column is missing (42703), so the
//                                read returned `{data: null, error: 42703}`.
//                                The error was logged, but the result was
//                                `planItems: items ?? []` — so the model was
//                                handed an EMPTY PLAN for every trip, on every
//                                turn, and `planItemsAvailable` was the only
//                                hint that anything was wrong.
//   itinerary_items.ends_at    → does not exist. The column is `end_time`
//                                (timestamptz). Written by the `move` op in
//                                POST /drafts/:id/apply.
//   itinerary_items.id         → exists, and is `uuid DEFAULT
//                                gen_random_uuid()`. The `add` op supplied
//                                `id: nanoid()`, a 32-character hex string with
//                                no dashes, which Postgres rejects as invalid
//                                uuid input syntax (22P02). Every `add` failed.
//                                The id is now left to the database. (nanoid()
//                                is still correct for copilot_threads /
//                                copilot_messages / copilot_drafts, whose ids
//                                are `text`.)
//
// The `add` and `update` ops also spread the model's `item` object straight
// into the write. Any key the model invented — and the tool schema advertises
// camelCase `startsAt`/`endsAt`, which are not columns at all — made PostgREST
// reject the entire row. The ops are now mapped onto the real column list and
// unknown keys are reported back in `failures` rather than silently poisoning
// the write.
//
// `traveler_profiles` had the same class of defect one level down:
// `get_traveler_summary` read `profile.pace`, `.early_bird`,
// `.walking_comfort`, `.interests` and `.dietary_needs` off a `select('*')`
// row. None of those are columns — the table stores `contexts` and `overrides`
// as jsonb. No 42703 (the select was `*`), just five `undefined`s, so a fully
// filled-in profile was reported to the model as a traveller with no stated
// preferences at all. The values are now read out of the jsonb, with
// `overrides` taking precedence over `contexts`, and a field that is genuinely
// absent is reported absent rather than defaulted.
//
// Finally, `preview_plan` returned `healthDelta: conflicts.length === 0 ? 5 :
// -3` and a friction delta of -1 per timed op. Those numbers were not computed
// from anything; they were constants dressed as analysis, and the model
// presented them to the traveller as the effect of a plan change. They are
// removed — the route now returns only the overlap detection it actually
// performs. This is the same rule as the FABRICATION note below.
//
// Every `{ data }` destructure in this file that discarded an `error` now
// captures it, and no failed query is reported as a 404 or as a success.
//
// FABRICATION 2026-09-19 — every external tool this copilot had was wired to
// invent its answer, and the wiring guaranteed the invented branch was the one
// that ran.
//
// search_places, get_place_details and get_weather each called
// `provider-adapters` with `Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}`.
// provider-adapters authenticates with `supabase.auth.getUser(token)`, which
// resolves a bearer to a row in auth.users; the service-role key has no `sub`
// and resolves to nobody, so every one of those calls returned 401. The code
// was `if (resp.ok) { ...return real data... }` followed by a mock block, so a
// non-2xx did not even need to throw to reach the mock — it fell straight
// through. The `catch { /* fall through to mock */ }` was decoration.
//
// What the traveler got instead:
//   • search_places   — three invented venues with invented ratings, price
//                        levels and open/closed state, at coordinates nudged a
//                        few hundred metres off the search point.
//   • get_place_details — an invented address, phone number, website and a
//                        full week of invented opening hours.
//   • get_weather     — an invented forecast carrying
//                        `provenance: { attribution: 'Weather data by
//                        Open-Meteo.com' }`. Fabricated weather, attributed to
//                        a real provider by name.
//   • get_trip_context — a catch block returning a trip to Lisbon with a hotel
//                        and two travellers named Alice and Bob.
//   • get_traveler_summary — invented interests and a hardcoded budget band of
//                        EUR 6000–8500 with `overlap: 'yes'`, returned as the
//                        traveller's own figures whenever no profile row
//                        existed.
//
// The sharpest part is that the grounding mechanism validated the
// fabrications. SYSTEM_PROMPT rule 7 says every suggested place must carry a
// placeId from search_places or get_place_details, and preview_plan refuses
// ungrounded ids — but both mock branches called `groundedPlaceIds.add()` on
// the ids they had just made up. The safety check passed because the invented
// data had been registered as trustworthy by the same code that invented it.
//
// Fix: forward the CALLER's Authorization header. The caller is a verified
// user who has already passed requireTripOwner, which is exactly the identity
// provider-adapters expects. Every tool now returns a structured
// `{ available: false, reason }` when the provider cannot answer, nothing is
// added to groundedPlaceIds unless a provider returned it, and no tool invents
// a value under any circumstance. The model is told plainly that the tool is
// unavailable and instructed (rule 11) to say so rather than fill the gap.
//
// Also fixed: POST /trips/draft inserted `id` (a 32-char hex string into a
// uuid column), `created_by`, `traveler_count` and `style` — none of which
// exist on `trips`, which also requires a NOT NULL `user_id` that was never
// supplied. The insert failed every time, the error was swallowed by
// `catch { /* table may not exist, use mock */ }`, and the route returned a
// tripId for a trip that had never been created. It now writes the columns the
// table actually has and returns an error if the write fails.
//
// SECURITY 2026-09-17 — This function verified the caller's JWT but never
// checked that the caller owned the `tripId` it was handed in the request
// body. POST /messages created (or reused) a copilot thread for any tripId
// the caller supplied, then ran an agentic loop where the model could call
// the get_trip_context tool, which read the `trips` row and every row in
// `reservations` for that trip_id with a service-role client and no owner
// filter at all. Any signed-in user could pass a stranger's trip id and get
// that trip's destination, dates, and full reservation list — including
// confirmation numbers — back in the tool result and the assistant's reply.
// The same gap applied to POST /drafts/:id/apply. The gate now:
// requireTripOwner(supabase, tripId, userId) is called immediately after
// tripId is read from the body in POST /messages, and again on draft.trip_id
// before a draft is applied. A trip that isn't the caller's returns 404.
const SYSTEM_PROMPT = `You are the TravelOS AI Trip Copilot. You help travelers plan and improve their trips.

RULES:
1. You plan trips using ONLY information from tool results. Never invent places, prices, hours, or events.
2. Confirmed reservations are FIXED. Never move or remove them.
3. Prefer fewer, better items. Leave free time consistent with the traveler's pace.
4. Say when information is missing or uncertain.
5. For health, legal, visa, or safety questions: summarize briefly and point to official sources. Do not give medical or legal advice.
6. Keep explanations short: one sentence per item on why it fits.
7. Every place you suggest must have a placeId from search_places or get_place_details in this conversation.
8. Respect the traveler's dietary and accessibility needs as hard constraints.
9. When proposing a plan, always call preview_plan first and address any critical conflicts.
10. Respond in the same language the user writes in.
11. A tool result of the form {"available": false, "reason": "..."} means that information could not be retrieved. Tell the traveler plainly which information is unavailable and continue without it. NEVER substitute your own estimate for a failed tool call, and never name a specific venue, address, opening time, price or forecast that did not come from a successful tool result.

PRIVACY: You have access to first names, interests, and released group aggregates only. Never reference private budget values, other members' profiles, or precise locations.`;
const TOOLS = [
  {
    name: 'get_trip_context',
    description: 'Get trip details: destination, dates, lodging, confirmed reservations, current plan items, travelers',
    input_schema: {
      type: 'object',
      properties: {
        dateFrom: {
          type: 'string',
          description: 'ISO date, optional filter'
        },
        dateTo: {
          type: 'string',
          description: 'ISO date, optional filter'
        }
      }
    }
  },
  {
    name: 'get_traveler_summary',
    description: 'Get traveler preferences: interests, pace, walking comfort, dietary needs, budget band',
    input_schema: {
      type: 'object',
      properties: {
        audience: {
          type: 'string',
          enum: [
            'me',
            'group'
          ]
        }
      },
      required: [
        'audience'
      ]
    }
  },
  {
    name: 'search_places',
    description: 'Search for places near a location',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string'
        },
        near: {
          type: 'object',
          properties: {
            lat: {
              type: 'number'
            },
            lng: {
              type: 'number'
            }
          }
        },
        category: {
          type: 'string'
        },
        openAt: {
          type: 'string',
          description: 'ISO datetime'
        },
        radiusM: {
          type: 'number'
        },
        limit: {
          type: 'number'
        }
      },
      required: [
        'query',
        'near'
      ]
    }
  },
  {
    name: 'get_place_details',
    description: 'Get detailed info about a place including opening hours',
    input_schema: {
      type: 'object',
      properties: {
        placeId: {
          type: 'string'
        }
      },
      required: [
        'placeId'
      ]
    }
  },
  {
    name: 'get_weather',
    description: 'Get weather forecast for a date and location',
    input_schema: {
      type: 'object',
      properties: {
        date: {
          type: 'string'
        },
        lat: {
          type: 'number'
        },
        lng: {
          type: 'number'
        }
      },
      required: [
        'date',
        'lat',
        'lng'
      ]
    }
  },
  {
    name: 'estimate_travel',
    description: 'Estimate travel time between two points. This is a straight-line distance estimate, not a routed journey.',
    input_schema: {
      type: 'object',
      properties: {
        from: {
          type: 'object',
          properties: {
            lat: {
              type: 'number'
            },
            lng: {
              type: 'number'
            }
          }
        },
        to: {
          type: 'object',
          properties: {
            lat: {
              type: 'number'
            },
            lng: {
              type: 'number'
            }
          }
        },
        mode: {
          type: 'string',
          enum: [
            'walk',
            'transit',
            'drive'
          ]
        }
      },
      required: [
        'from',
        'to',
        'mode'
      ]
    }
  },
  {
    name: 'get_past_trips',
    description: "Get summaries of the user's past trips for personalization",
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Optional search query'
        },
        limit: {
          type: 'number'
        }
      }
    }
  },
  {
    name: 'preview_plan',
    description: 'Preview a set of plan operations to check for conflicts before proposing',
    input_schema: {
      type: 'object',
      properties: {
        ops: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              op: {
                type: 'string',
                enum: [
                  'add',
                  'move',
                  'remove',
                  'update'
                ]
              },
              itemId: {
                type: 'string'
              },
              item: {
                type: 'object'
              },
              startsAt: {
                type: 'string'
              },
              endsAt: {
                type: 'string'
              },
              tz: {
                type: 'string'
              }
            },
            required: [
              'op'
            ]
          }
        }
      },
      required: [
        'ops'
      ]
    }
  },
  {
    name: 'draft_poll',
    description: 'Create a draft poll for group decision on place options',
    input_schema: {
      type: 'object',
      properties: {
        question: {
          type: 'string'
        },
        optionPlaceIds: {
          type: 'array',
          items: {
            type: 'string'
          }
        }
      },
      required: [
        'question',
        'optionPlaceIds'
      ]
    }
  }
];
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function nanoid() {
  return crypto.randomUUID().replace(/-/g, '');
}
/**
 * The columns a draft operation may write on `itinerary_items`. `id` is
 * excluded on purpose: it is uuid DEFAULT gen_random_uuid() and the database
 * generates it. `trip_id` is excluded because it comes from the draft, never
 * from the model. `created_at` / `updated_at` are the database's.
 */ const ITINERARY_ITEM_COLUMNS = new Set([
  'title',
  'type',
  'category',
  'status',
  'date',
  'start_time',
  'end_time',
  'timezone',
  'duration_min',
  'location',
  'notes',
  'country_code',
  'transport_mode',
  'party_size',
  'place_id',
  'lat',
  'lng',
  'windows',
  'fixed',
  'fixed_start',
  'outdoor',
  'must_do',
  'starred',
  'suggested',
  'droppable',
  'critical',
  'hold_minutes',
  'energy_cost',
  'member_ids',
  'cancellation'
]);
/**
 * camelCase names the model is shown (tool schema) or is likely to emit,
 * mapped onto the real columns.
 */ const ITINERARY_ITEM_ALIASES = {
  startsAt: 'start_time',
  endsAt: 'end_time',
  startTime: 'start_time',
  endTime: 'end_time',
  tz: 'timezone',
  durationMin: 'duration_min',
  countryCode: 'country_code',
  transportMode: 'transport_mode',
  partySize: 'party_size',
  placeId: 'place_id',
  fixedStart: 'fixed_start',
  mustDo: 'must_do',
  holdMinutes: 'hold_minutes',
  energyCost: 'energy_cost',
  memberIds: 'member_ids'
};
/**
 * Maps a model-authored draft item onto columns that exist on
 * `itinerary_items`. A single unknown key used to make PostgREST reject the
 * whole write, so unknown keys are dropped and named back to the caller
 * instead of silently poisoning the row.
 */ function mapItemToColumns(item) {
  const columns = {};
  const unknown = [];
  for (const [key, value] of Object.entries(item)){
    const column = ITINERARY_ITEM_COLUMNS.has(key) ? key : ITINERARY_ITEM_ALIASES[key] ?? null;
    if (column) {
      columns[column] = value;
    } else if (key !== 'id' && key !== 'trip_id') {
      unknown.push(key);
    }
  }
  return {
    columns,
    unknown
  };
}
/** Uniform "this could not be answered" shape. Rule 11 tells the model what it means. */ function unavailable(reason) {
  return {
    available: false,
    reason
  };
}
/**
 * Calls a provider-adapters route with the CALLER's credential.
 *
 * Never falls back to invented data. A failure returns `null` and the caller
 * turns that into an `unavailable(...)` tool result the model is required to
 * surface rather than paper over.
 */ async function callProvider(route, body, authHeader) {
  const base = Deno.env.get('SUPABASE_URL') ?? '';
  try {
    const resp = await fetch(`${base}/functions/v1/provider-adapters${route}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader
      },
      body: JSON.stringify(body)
    });
    if (!resp.ok) {
      const detail = (await resp.text()).slice(0, 200);
      console.error(`[ai-copilot-v2] provider-adapters${route} -> ${resp.status}: ${detail}`);
      return {
        ok: false,
        reason: `provider returned ${resp.status}`
      };
    }
    const data = await resp.json();
    // provider-adapters answers { data, status, provenance } and uses
    // status:'unavailable' rather than an HTTP error when a provider is not
    // configured. That is a failure here too, not an empty success.
    if (data && typeof data === 'object' && 'status' in data) {
      const envelope = data;
      if (envelope.status !== 'ok' || envelope.data == null) {
        return {
          ok: false,
          reason: envelope.safeFailureMessage ?? `provider reported ${envelope.status ?? 'no data'}`
        };
      }
      return {
        ok: true,
        data: envelope.data
      };
    }
    return {
      ok: true,
      data
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[ai-copilot-v2] provider-adapters${route} unreachable: ${message}`);
    return {
      ok: false,
      reason: 'provider unreachable'
    };
  }
}
async function executeTool(name, input, tripId, userId, supabase, groundedPlaceIds, authHeader) {
  console.log(`[ai-copilot-v2] executing tool: ${name}`, JSON.stringify(input));
  switch(name){
    case 'get_trip_context':
      {
        const { data: trip, error: tripErr } = await supabase.from('trips').select('*').eq('id', tripId).maybeSingle();
        if (tripErr) {
          console.error('[ai-copilot-v2] trips read failed:', tripErr.message);
          return unavailable('the trip record could not be read');
        }
        if (!trip) return unavailable('no trip found for this conversation');
        const { data: reservations, error: resErr } = await supabase.from('reservations').select('*').eq('trip_id', tripId);
        if (resErr) console.error('[ai-copilot-v2] reservations read failed:', resErr.message);
        const { data: members, error: memErr } = await supabase.from('trip_members').select('user_id, role').eq('trip_id', tripId);
        if (memErr) console.error('[ai-copilot-v2] trip_members read failed:', memErr.message);
        // COLUMN FIX 2026-09-19: ordered by `starts_at`, which is not a column
        // on itinerary_items — 42703 rejected the whole query, so this always
        // returned null and the model was told the trip had no plan items. The
        // column is `start_time`. (The old comment here claimed the table did
        // not exist; it does.)
        const { data: items, error: itemsErr } = await supabase.from('itinerary_items').select('*').eq('trip_id', tripId).order('start_time', {
          ascending: true
        });
        if (itemsErr) console.error('[ai-copilot-v2] itinerary_items read failed:', itemsErr.message);
        return {
          destination: trip.destination ?? null,
          dates: trip.start_date && trip.end_date ? `${trip.start_date} to ${trip.end_date}` : null,
          lodging: [],
          reservations: reservations ?? [],
          reservationsAvailable: !resErr,
          planItems: items ?? [],
          planItemsAvailable: !itemsErr,
          travelers: members?.map((m)=>m.user_id) ?? [],
          travelersAvailable: !memErr,
          tz: trip.primary_tz ?? null
        };
      }
    case 'get_traveler_summary':
      {
        const { data: profile, error } = await supabase.from('traveler_profiles').select('*').eq('user_id', userId).maybeSingle();
        if (error) {
          console.error('[ai-copilot-v2] traveler_profiles read failed:', error.message);
          return unavailable('traveler preferences could not be read');
        }
        if (!profile) {
          return unavailable('this traveler has not filled in a preferences profile yet');
        }
        // COLUMN FIX 2026-09-19: this read profile.pace, .early_bird,
        // .walking_comfort, .interests and .dietary_needs. `traveler_profiles`
        // has none of those columns — it holds `contexts` and `overrides`, both
        // jsonb, plus version / learning_paused / excluded_trip_ids /
        // group_use_enabled. Because the select was `*` there was no 42703 to
        // notice: the five reads simply yielded `undefined`, and every traveller
        // was described to the model as having stated no preferences at all.
        // An explicit `overrides` entry wins over the learned `contexts` value,
        // matching how traveler-profile writes them.
        const contexts = profile.contexts ?? {};
        const overrides = profile.overrides ?? {};
        const pref = (key)=>overrides[key] !== undefined ? overrides[key] : contexts[key];
        // Only what the row actually holds. The old code returned a hardcoded
        // EUR 6000-8500 band with overlap:'yes' as if it were the traveler's
        // own figures; budget bands come from budget-preferences /band, which
        // enforces a privacy threshold, and must never be synthesised here.
        // A field absent from both jsonb objects is reported null — never
        // defaulted to a plausible-looking value.
        const interests = pref('interests');
        return {
          pace: pref('pace') ?? null,
          earlyBird: pref('early_bird') ?? null,
          walkingComfort: pref('walking_comfort') ?? null,
          interests: Array.isArray(interests) ? interests : null,
          dietary: pref('dietary_needs') ?? null,
          budgetBand: null,
          budgetBandNote: 'Budget bands are not available to the copilot.',
          note: 'Any field returned as null was not recorded on this profile. Do not assume a value for it.'
        };
      }
    case 'search_places':
      {
        const { query, near, category, limit = 5 } = input;
        const res = await callProvider('/places/nearby', {
          query,
          near,
          category,
          limit
        }, authHeader);
        if (!res.ok) return unavailable(`place search is unavailable (${res.reason})`);
        const payload = res.data;
        const places = Array.isArray(payload) ? payload : payload.places ?? [];
        // Only ids a provider actually returned are ever marked grounded.
        places.forEach((p)=>{
          const id = p.placeId;
          if (id) groundedPlaceIds.add(id);
        });
        return places;
      }
    case 'get_place_details':
      {
        const { placeId } = input;
        const res = await callProvider('/places/details', {
          placeId
        }, authHeader);
        if (!res.ok) return unavailable(`details for this place are unavailable (${res.reason})`);
        groundedPlaceIds.add(placeId);
        return res.data;
      }
    case 'get_weather':
      {
        const { date, lat, lng } = input;
        const res = await callProvider('/weather', {
          date,
          lat,
          lng
        }, authHeader);
        if (!res.ok) return unavailable(`the forecast for ${date} is unavailable (${res.reason})`);
        return res.data;
      }
    case 'estimate_travel':
      {
        const { from, to, mode } = input;
        // Straight-line arithmetic, labelled as such. Not a routed journey and
        // not presented as one.
        const km = haversineKm(from.lat, from.lng, to.lat, to.lng);
        const speedKph = mode === 'walk' ? 5 : mode === 'transit' ? 20 : 40;
        const minutes = Math.round(km / speedKph * 60);
        return {
          minutes,
          km: Math.round(km * 10) / 10,
          estimated: true,
          method: 'straight-line distance at an assumed average speed; not a routed journey'
        };
      }
    case 'get_past_trips':
      {
        const { limit = 5 } = input;
        const { data, error } = await supabase.from('copilot_trip_summaries').select('*').eq('user_id', userId).order('generated_at', {
          ascending: false
        }).limit(limit);
        if (error) {
          console.error('[ai-copilot-v2] copilot_trip_summaries read failed:', error.message);
          return unavailable('past trip summaries could not be read');
        }
        return data ?? [];
      }
    case 'preview_plan':
      {
        const { ops } = input;
        const conflicts = [];
        const timedOps = ops.filter((op)=>op.startsAt && op.endsAt);
        for(let i = 0; i < timedOps.length; i++){
          for(let j = i + 1; j < timedOps.length; j++){
            const a = timedOps[i], b = timedOps[j];
            const aStart = new Date(a.startsAt).getTime();
            const aEnd = new Date(a.endsAt).getTime();
            const bStart = new Date(b.startsAt).getTime();
            const bEnd = new Date(b.endsAt).getTime();
            if (aStart < bEnd && bStart < aEnd) {
              conflicts.push(`Time overlap between ops ${i} and ${j}`);
            }
          }
        }
        // FABRICATION FIX 2026-09-19: this also returned
        // `healthDelta: conflicts.length === 0 ? 5 : -3` and a frictionDeltaByDay
        // of -1 per timed op. Neither number was derived from anything — they
        // were constants shaped like analysis, and the model relayed them to the
        // traveller as the measured effect of a plan change. Removed. This route
        // now reports only what it genuinely computes: overlaps between the
        // proposed operations. Real health and friction scoring lives in
        // analyze-trip-health and analyze-daily-friction, which run against a
        // saved itinerary, not a draft.
        return {
          conflicts,
          checked: timedOps.length,
          note: 'Overlap check between the proposed operations only. This does not score the trip’s health or friction, and it does not check the proposals against items already on the plan.'
        };
      }
    case 'draft_poll':
      {
        const { question, optionPlaceIds } = input;
        const ungrounded = optionPlaceIds.filter((id)=>!groundedPlaceIds.has(id));
        if (ungrounded.length > 0) {
          return unavailable(`these place ids did not come from a tool result: ${ungrounded.join(', ')}`);
        }
        // No invented display names — the client resolves ids to names.
        return {
          pollId: `draft_poll_${nanoid().slice(0, 8)}`,
          question,
          options: optionPlaceIds.map((id)=>({
              placeId: id
            }))
        };
      }
    default:
      return {
        error: `Unknown tool: ${name}`
      };
  }
}
async function runCopilotStream(tripId, userId, threadId, userMessage, history, supabase, controller, authHeader) {
  const encoder = new TextEncoder();
  const emit = (obj)=>{
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
  };
  const groundedPlaceIds = new Set();
  const conversationHistory = [
    ...history,
    {
      role: 'user',
      content: userMessage
    }
  ];
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
  if (!apiKey) {
    emit({
      type: 'error',
      code: 'COPILOT_UNAVAILABLE',
      message: 'Copilot API key not configured.'
    });
    emit({
      type: 'done'
    });
    return {
      assistantText: '',
      draftId: null
    };
  }
  let fullAssistantText = '';
  let draftId = null;
  let toolCallCount = 0;
  const MAX_TOOL_CALLS = 12;
  while(true){
    const controller2 = new AbortController();
    const timeout = setTimeout(()=>controller2.abort(), 60000);
    let anthropicResp;
    try {
      anthropicResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: Deno.env.get('COPILOT_MODEL') ?? 'claude-3-5-haiku-20241022',
          max_tokens: 4096,
          system: SYSTEM_PROMPT,
          tools: TOOLS,
          messages: conversationHistory,
          stream: true
        }),
        signal: controller2.signal
      });
    } catch (err) {
      clearTimeout(timeout);
      const msg = err instanceof Error && err.name === 'AbortError' ? 'Request timed out. Try a narrower request.' : 'Copilot is unavailable right now.';
      emit({
        type: 'error',
        code: 'COPILOT_UNAVAILABLE',
        message: msg
      });
      emit({
        type: 'done'
      });
      return {
        assistantText: fullAssistantText,
        draftId
      };
    }
    clearTimeout(timeout);
    if (!anthropicResp.ok) {
      const errText = await anthropicResp.text();
      console.error(`[ai-copilot-v2] Anthropic error ${anthropicResp.status}: ${errText}`);
      emit({
        type: 'error',
        code: 'COPILOT_UNAVAILABLE',
        message: 'Copilot is unavailable right now.'
      });
      emit({
        type: 'done'
      });
      return {
        assistantText: fullAssistantText,
        draftId
      };
    }
    const reader = anthropicResp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let currentTextBlock = '';
    const toolUseBlocks = [];
    let currentToolBlock = null;
    let stopReason = '';
    while(true){
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, {
        stream: true
      });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines){
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        let evt;
        try {
          evt = JSON.parse(data);
        } catch  {
          continue;
        }
        const evtType = evt.type;
        if (evtType === 'content_block_start') {
          const block = evt.content_block;
          if (block?.type === 'tool_use') {
            currentToolBlock = {
              id: block.id,
              name: block.name,
              inputJson: ''
            };
            emit({
              type: 'tool_status',
              name: block.name,
              status: 'running'
            });
          }
        } else if (evtType === 'content_block_delta') {
          const delta = evt.delta;
          if (delta?.type === 'text_delta') {
            const text = delta.text;
            currentTextBlock += text;
            fullAssistantText += text;
            emit({
              type: 'text',
              delta: text
            });
          } else if (delta?.type === 'input_json_delta' && currentToolBlock) {
            currentToolBlock.inputJson += delta.partial_json;
          }
        } else if (evtType === 'content_block_stop') {
          if (currentToolBlock) {
            toolUseBlocks.push(currentToolBlock);
            currentToolBlock = null;
          }
        } else if (evtType === 'message_delta') {
          const delta = evt.delta;
          stopReason = delta?.stop_reason ?? '';
        }
      }
    }
    const assistantContent = [];
    if (currentTextBlock) {
      assistantContent.push({
        type: 'text',
        text: currentTextBlock
      });
    }
    for (const tb of toolUseBlocks){
      let parsedInput = {};
      try {
        parsedInput = JSON.parse(tb.inputJson || '{}');
      } catch  {
        parsedInput = {};
      }
      assistantContent.push({
        type: 'tool_use',
        id: tb.id,
        name: tb.name,
        input: parsedInput
      });
    }
    conversationHistory.push({
      role: 'assistant',
      content: assistantContent
    });
    if (toolUseBlocks.length === 0 || stopReason === 'end_turn' || toolCallCount >= MAX_TOOL_CALLS) {
      break;
    }
    const toolResults = [];
    for (const tb of toolUseBlocks){
      if (toolCallCount >= MAX_TOOL_CALLS) break;
      toolCallCount++;
      let parsedInput = {};
      try {
        parsedInput = JSON.parse(tb.inputJson || '{}');
      } catch  {
        parsedInput = {};
      }
      if (tb.name === 'preview_plan') {
        const ops = parsedInput.ops ?? [];
        const invalidIds = [];
        for (const op of ops){
          const item = op.item;
          const placeId = item?.placeId;
          if (placeId && !groundedPlaceIds.has(placeId)) {
            invalidIds.push(placeId);
          }
        }
        if (invalidIds.length > 0) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tb.id,
            content: `Error: Place IDs not grounded: ${invalidIds.join(', ')}. Please call search_places or get_place_details first to obtain valid place IDs.`
          });
          emit({
            type: 'tool_status',
            name: tb.name,
            status: 'done'
          });
          continue;
        }
      }
      const result = await executeTool(tb.name, parsedInput, tripId, userId, supabase, groundedPlaceIds, authHeader);
      const failed = !!(result && typeof result === 'object' && result.available === false);
      emit({
        type: 'tool_status',
        name: tb.name,
        status: failed ? 'unavailable' : 'done',
        result: failed ? result.reason : typeof result === 'object' ? 'ok' : String(result)
      });
      toolResults.push({
        type: 'tool_result',
        tool_use_id: tb.id,
        content: JSON.stringify(result)
      });
    }
    conversationHistory.push({
      role: 'user',
      content: toolResults
    });
  }
  const opsMatch = fullAssistantText.match(/```json\s*([\s\S]*?)```/);
  if (opsMatch) {
    try {
      const parsed = JSON.parse(opsMatch[1]);
      if (parsed.ops && Array.isArray(parsed.ops)) {
        const unmet = [];
        const validOps = parsed.ops.filter((op)=>{
          const item = op.item;
          const placeId = item?.placeId;
          if (placeId && !groundedPlaceIds.has(placeId)) {
            unmet.push(`Place ${placeId} not grounded`);
            return false;
          }
          return true;
        });
        const draft = {
          id: nanoid(),
          threadId,
          tripId,
          userId,
          ops: validOps,
          preview: parsed.preview ?? {},
          summary: parsed.summary ?? 'Proposed plan changes',
          unmet,
          sources: parsed.sources ?? [],
          status: 'pending'
        };
        const { error: draftErr } = await supabase.from('copilot_drafts').insert({
          id: draft.id,
          thread_id: draft.threadId,
          trip_id: draft.tripId,
          user_id: draft.userId,
          ops: draft.ops,
          preview: draft.preview,
          summary: draft.summary,
          unmet: draft.unmet,
          sources: draft.sources,
          status: draft.status
        });
        if (draftErr) {
          console.error('[ai-copilot-v2] copilot_drafts insert failed:', draftErr.message);
        } else {
          draftId = draft.id;
          emit({
            type: 'draft',
            draft
          });
        }
      }
    } catch  {}
  }
  emit({
    type: 'done'
  });
  return {
    assistantText: fullAssistantText,
    draftId
  };
}
Deno.serve(async (req)=>{
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/ai-copilot-v2/, '');
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: corsHeaders
    });
  }
  // Auth — verified JWT only, never a body-supplied id.
  const caller = await requireUser(req);
  if (caller instanceof Response) return caller;
  const userId = caller.userId;
  // The caller's own credential, forwarded to provider-adapters. It is the
  // only credential those endpoints accept, and the caller has already been
  // proven to own the trip.
  const authHeader = req.headers.get('Authorization') ?? '';
  const supabase = serviceClient();
  console.log(`[ai-copilot-v2] ${req.method} ${path} user=${userId}`);
  // ── POST /messages ──────────────────────────────────────────────
  if (req.method === 'POST' && path === '/messages') {
    let body;
    try {
      body = await req.json();
    } catch  {
      return new Response(JSON.stringify({
        error: {
          code: 'BAD_REQUEST',
          message: 'Invalid JSON'
        }
      }), {
        status: 400,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    const { tripId, threadId: existingThreadId, message } = body;
    if (!tripId || !message) {
      return new Response(JSON.stringify({
        error: {
          code: 'BAD_REQUEST',
          message: 'tripId and message are required'
        }
      }), {
        status: 400,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    const tripOwnerCheck = await requireTripOwner(supabase, tripId, userId);
    if (tripOwnerCheck instanceof Response) return tripOwnerCheck;
    const today = new Date().toISOString().split('T')[0];
    const { data: settings, error: settingsErr } = await supabase.from('copilot_settings').select('*').eq('user_id', userId).maybeSingle();
    // A failed read used to look identical to "this user has no settings row",
    // which silently disabled the daily message limit.
    if (settingsErr) {
      console.error('[ai-copilot-v2] copilot_settings read failed:', settingsErr.message);
      return new Response(JSON.stringify({
        error: {
          code: 'DB_ERROR',
          message: 'Could not read your copilot settings.'
        }
      }), {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
    if (settings && settings.daily_count_date === today && settings.daily_message_count >= 30) {
      return new Response(JSON.stringify({
        error: {
          code: 'DAILY_LIMIT',
          message: 'Daily message limit reached (30). Upgrade for more.'
        }
      }), {
        status: 429,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    let threadId = existingThreadId;
    if (!threadId) {
      threadId = nanoid();
      const { error: threadErr } = await supabase.from('copilot_threads').insert({
        id: threadId,
        trip_id: tripId,
        user_id: userId,
        title: message.slice(0, 80),
        last_message_at: new Date().toISOString()
      });
      if (threadErr) {
        console.error('[ai-copilot-v2] copilot_threads insert failed:', threadErr.message);
        return new Response(JSON.stringify({
          error: {
            code: 'DB_ERROR',
            message: 'Could not start a conversation.'
          }
        }), {
          status: 500,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
    } else {
      const { data: thread, error: threadReadErr } = await supabase.from('copilot_threads').select('id, user_id').eq('id', threadId).maybeSingle();
      // A failed read is a 500, not "not found".
      if (threadReadErr) {
        console.error('[ai-copilot-v2] copilot_threads read failed:', threadReadErr.message);
        return new Response(JSON.stringify({
          error: {
            code: 'DB_ERROR',
            message: 'The conversation could not be read.'
          }
        }), {
          status: 500,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }
      if (!thread || thread.user_id !== userId) {
        return new Response(JSON.stringify({
          error: {
            code: 'NOT_FOUND',
            message: 'Thread not found'
          }
        }), {
          status: 404,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
    }
    const { data: recentMessages, error: recentErr } = await supabase.from('copilot_messages').select('role, content').eq('thread_id', threadId).order('created_at', {
      ascending: false
    }).limit(20);
    // Losing the history silently would make the copilot forget the
    // conversation mid-thread with no sign that anything went wrong.
    if (recentErr) {
      console.error('[ai-copilot-v2] copilot_messages read failed:', recentErr.message);
      return new Response(JSON.stringify({
        error: {
          code: 'DB_ERROR',
          message: 'The conversation history could not be read.'
        }
      }), {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
    const history = (recentMessages ?? []).reverse().map((m)=>({
        role: m.role === 'tool' ? 'user' : m.role,
        content: m.content
      }));
    const userMsgId = nanoid();
    const { error: userMsgErr } = await supabase.from('copilot_messages').insert({
      id: userMsgId,
      thread_id: threadId,
      role: 'user',
      content: message
    });
    if (userMsgErr) console.error('[ai-copilot-v2] user message insert failed:', userMsgErr.message);
    let assistantText = '';
    let draftId = null;
    const stream = new ReadableStream({
      async start (streamController) {
        const encoder = new TextEncoder();
        streamController.enqueue(encoder.encode(`data: ${JSON.stringify({
          type: 'thread_id',
          threadId
        })}\n\n`));
        const result = await runCopilotStream(tripId, userId, threadId, message, history, supabase, streamController, authHeader);
        assistantText = result.assistantText;
        draftId = result.draftId;
        const asstMsgId = nanoid();
        const { error: asstMsgErr } = await supabase.from('copilot_messages').insert({
          id: asstMsgId,
          thread_id: threadId,
          role: 'assistant',
          content: assistantText || '(no response)',
          draft_id: draftId
        });
        if (asstMsgErr) console.error('[ai-copilot-v2] assistant message insert failed:', asstMsgErr.message);
        const { error: touchErr } = await supabase.from('copilot_threads').update({
          last_message_at: new Date().toISOString()
        }).eq('id', threadId);
        if (touchErr) console.error('[ai-copilot-v2] thread last_message_at update failed:', touchErr.message);
        const newCount = settings ? settings.daily_count_date === today ? settings.daily_message_count + 1 : 1 : 1;
        const { error: counterErr } = await supabase.from('copilot_settings').upsert({
          user_id: userId,
          daily_message_count: newCount,
          daily_count_date: today,
          updated_at: new Date().toISOString()
        }, {
          onConflict: 'user_id'
        });
        // A failed counter write means the daily limit stops counting, so it
        // must not be invisible.
        if (counterErr) console.error('[ai-copilot-v2] daily counter upsert failed:', counterErr.message);
        streamController.close();
      }
    });
    return new Response(stream, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      }
    });
  }
  // ── GET /threads ─────────────────────────────────────────────────
  if (req.method === 'GET' && path === '/threads') {
    const tripId = url.searchParams.get('tripId');
    if (!tripId) {
      return new Response(JSON.stringify({
        error: {
          code: 'BAD_REQUEST',
          message: 'tripId is required'
        }
      }), {
        status: 400,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    const { data, error } = await supabase.from('copilot_threads').select('*').eq('trip_id', tripId).eq('user_id', userId).is('deleted_at', null).order('last_message_at', {
      ascending: false
    });
    if (error) {
      console.error('[ai-copilot-v2] get threads error:', error);
      return new Response(JSON.stringify({
        error: {
          code: 'DB_ERROR',
          message: 'Could not list conversations.'
        }
      }), {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    return new Response(JSON.stringify({
      threads: data
    }), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
  // ── DELETE /threads/:id ───────────────────────────────────────────
  const deleteThreadMatch = path.match(/^\/threads\/([^/]+)$/);
  if (req.method === 'DELETE' && deleteThreadMatch) {
    const threadId = deleteThreadMatch[1];
    const { data: thread, error: threadLookupErr } = await supabase.from('copilot_threads').select('id, user_id').eq('id', threadId).maybeSingle();
    // A failed read is a 500, not "not found".
    if (threadLookupErr) {
      console.error('[ai-copilot-v2] copilot_threads lookup failed:', threadLookupErr.message);
      return new Response(JSON.stringify({
        error: {
          code: 'DB_ERROR',
          message: 'The conversation could not be read.'
        }
      }), {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
    if (!thread || thread.user_id !== userId) {
      return new Response(JSON.stringify({
        error: {
          code: 'NOT_FOUND',
          message: 'Thread not found'
        }
      }), {
        status: 404,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // The delete used to report success whether or not the row was touched.
    const { error: softDeleteErr } = await supabase.from('copilot_threads').update({
      deleted_at: new Date().toISOString()
    }).eq('id', threadId);
    if (softDeleteErr) {
      console.error('[ai-copilot-v2] thread soft-delete failed:', softDeleteErr.message);
      return new Response(JSON.stringify({
        error: {
          code: 'DB_ERROR',
          message: 'The conversation could not be deleted.'
        }
      }), {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
    return new Response(JSON.stringify({
      deleted: true
    }), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
  // ── POST /drafts/:id/apply ───────────────────────────────────────
  const applyDraftMatch = path.match(/^\/drafts\/([^/]+)\/apply$/);
  if (req.method === 'POST' && applyDraftMatch) {
    const draftId = applyDraftMatch[1];
    let body;
    try {
      body = await req.json();
    } catch  {
      body = {};
    }
    const { includedOpIndexes } = body;
    const { data: draft, error: draftReadErr } = await supabase.from('copilot_drafts').select('*').eq('id', draftId).maybeSingle();
    // A failed read is a 500 that says so; only an absent row is a 404.
    if (draftReadErr) {
      console.error('[ai-copilot-v2] copilot_drafts read failed:', draftReadErr.message);
      return new Response(JSON.stringify({
        error: {
          code: 'DB_ERROR',
          message: 'The draft could not be read.'
        }
      }), {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
    if (!draft || draft.user_id !== userId) {
      return new Response(JSON.stringify({
        error: {
          code: 'NOT_FOUND',
          message: 'Draft not found'
        }
      }), {
        status: 404,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    const draftTripOwnerCheck = await requireTripOwner(supabase, draft.trip_id, userId);
    if (draftTripOwnerCheck instanceof Response) return draftTripOwnerCheck;
    const ops = draft.ops ?? [];
    const selectedOps = includedOpIndexes ? ops.filter((_, i)=>includedOpIndexes.includes(i)) : ops;
    let appliedCount = 0;
    const failures = [];
    for (const op of selectedOps){
      let opError = null;
      if (op.op === 'add' && op.item) {
        // COLUMN FIX 2026-09-19: this was
        // `insert({ id: nanoid(), trip_id, ...item, created_at })`.
        // Two defects. `id` is uuid DEFAULT gen_random_uuid(); nanoid()
        // produces a 32-char hex string with no dashes, which Postgres rejects
        // with 22P02 (invalid input syntax for type uuid) — so every `add`
        // failed. And `...item` spread whatever the model wrote, including the
        // camelCase `startsAt`/`endsAt` this function's own tool schema
        // advertises, which are not columns; a single unknown key makes
        // PostgREST reject the entire row. The id is left to the database and
        // the item is mapped onto real columns below.
        const mapped = mapItemToColumns(op.item);
        if (mapped.unknown.length > 0) {
          failures.push(`add: ignored fields with no column on itinerary_items: ${mapped.unknown.join(', ')}`);
        }
        const { error } = await supabase.from('itinerary_items').insert({
          ...mapped.columns,
          trip_id: draft.trip_id
        });
        opError = error;
      } else if (op.op === 'update' && op.itemId) {
        const mapped = mapItemToColumns(op.item ?? {});
        if (mapped.unknown.length > 0) {
          failures.push(`update: ignored fields with no column on itinerary_items: ${mapped.unknown.join(', ')}`);
        }
        if (Object.keys(mapped.columns).length === 0) {
          failures.push('update: no writable fields in this operation');
          continue;
        }
        const { error } = await supabase.from('itinerary_items').update(mapped.columns).eq('id', op.itemId).eq('trip_id', draft.trip_id);
        opError = error;
      } else if (op.op === 'remove' && op.itemId) {
        const { error } = await supabase.from('itinerary_items').delete().eq('id', op.itemId).eq('trip_id', draft.trip_id);
        opError = error;
      } else if (op.op === 'move' && op.itemId) {
        // COLUMN FIX 2026-09-19: wrote `starts_at` / `ends_at`, neither of
        // which exists on itinerary_items. The columns are `start_time` and
        // `end_time` (both timestamptz), so every `move` failed with 42703.
        const update = {};
        if (op.startsAt) update.start_time = op.startsAt;
        if (op.endsAt) update.end_time = op.endsAt;
        if (op.tz) update.timezone = op.tz;
        if (Object.keys(update).length === 0) {
          failures.push('move: neither startsAt nor endsAt was supplied');
          continue;
        }
        const { error } = await supabase.from('itinerary_items').update(update).eq('id', op.itemId).eq('trip_id', draft.trip_id);
        opError = error;
      } else {
        continue;
      }
      if (opError) {
        console.error('[ai-copilot-v2] apply op failed:', opError.message);
        failures.push(`${op.op}: ${opError.message}`);
      } else {
        appliedCount++;
      }
    }
    // The old code counted every op as applied and swallowed the error, so a
    // draft that wrote nothing still reported success.
    if (appliedCount === 0 && failures.length > 0) {
      return new Response(JSON.stringify({
        error: {
          code: 'APPLY_FAILED',
          message: 'No operations could be applied.',
          failures
        }
      }), {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
    const { error: draftStatusErr } = await supabase.from('copilot_drafts').update({
      status: failures.length > 0 ? 'partially_applied' : 'applied'
    }).eq('id', draftId);
    if (draftStatusErr) console.error('[ai-copilot-v2] draft status update failed:', draftStatusErr.message);
    return new Response(JSON.stringify({
      applied: true,
      appliedCount,
      failures
    }), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
  // ── POST /trips/draft ───────────────────────────────────────────
  // Wrote `id` (a 32-char hex string into a uuid column), `created_by`,
  // `traveler_count` and `style` — none of which exist on `trips` — and never
  // set the NOT NULL `user_id`. Every insert failed, the error was swallowed,
  // and the route returned a tripId for a trip that did not exist.
  if (req.method === 'POST' && path === '/trips/draft') {
    let body;
    try {
      body = await req.json();
    } catch  {
      return new Response(JSON.stringify({
        error: {
          code: 'BAD_REQUEST',
          message: 'Invalid JSON'
        }
      }), {
        status: 400,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    const { destination, startDate, endDate, name, timezone } = body;
    if (!destination) {
      return new Response(JSON.stringify({
        error: {
          code: 'BAD_REQUEST',
          message: 'destination is required'
        }
      }), {
        status: 400,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    const { data: trip, error: tripError } = await supabase.from('trips').insert({
      user_id: userId,
      name: name ?? `Trip to ${destination}`,
      destination,
      start_date: startDate ?? null,
      end_date: endDate ?? null,
      primary_tz: timezone ?? 'UTC',
      status: 'planning'
    }).select().single();
    if (tripError || !trip) {
      console.error('[ai-copilot-v2] trips insert failed:', tripError?.message);
      return new Response(JSON.stringify({
        error: {
          code: 'DB_ERROR',
          message: 'The trip could not be created.'
        }
      }), {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
    return new Response(JSON.stringify({
      tripId: trip.id,
      trip,
      draft: {
        id: nanoid(),
        tripId: trip.id,
        ops: [],
        preview: {
          destination,
          startDate: trip.start_date,
          endDate: trip.end_date
        },
        summary: `Draft trip to ${destination}`,
        unmet: [],
        sources: [],
        status: 'pending'
      }
    }), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
  // ── GET /memory ───────────────────────────────────────────────
  if (req.method === 'GET' && path === '/memory') {
    const [summariesRes, settingsRes] = await Promise.all([
      supabase.from('copilot_trip_summaries').select('*').eq('user_id', userId).order('generated_at', {
        ascending: false
      }),
      supabase.from('copilot_settings').select('use_memory').eq('user_id', userId).maybeSingle()
    ]);
    // Both errors used to be discarded, so a broken read looked exactly like
    // "you have no saved trip memory".
    if (summariesRes.error) {
      console.error('[ai-copilot-v2] copilot_trip_summaries read failed:', summariesRes.error.message);
      return new Response(JSON.stringify({
        error: {
          code: 'DB_ERROR',
          message: 'Your saved trip memory could not be read.'
        }
      }), {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
    if (settingsRes.error) {
      console.error('[ai-copilot-v2] copilot_settings read failed:', settingsRes.error.message);
      return new Response(JSON.stringify({
        error: {
          code: 'DB_ERROR',
          message: 'Your copilot settings could not be read.'
        }
      }), {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
    return new Response(JSON.stringify({
      summaries: summariesRes.data ?? [],
      useMemory: settingsRes.data?.use_memory ?? true
    }), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
  // ── PUT /memory/settings ────────────────────────────────────────
  if (req.method === 'PUT' && path === '/memory/settings') {
    let body;
    try {
      body = await req.json();
    } catch  {
      return new Response(JSON.stringify({
        error: {
          code: 'BAD_REQUEST',
          message: 'Invalid JSON'
        }
      }), {
        status: 400,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    const { useMemory } = body;
    const { error: memSettingsErr } = await supabase.from('copilot_settings').upsert({
      user_id: userId,
      use_memory: useMemory,
      updated_at: new Date().toISOString()
    }, {
      onConflict: 'user_id'
    });
    // This returned {updated: true} whether or not the write landed.
    if (memSettingsErr) {
      console.error('[ai-copilot-v2] memory settings upsert failed:', memSettingsErr.message);
      return new Response(JSON.stringify({
        error: {
          code: 'DB_ERROR',
          message: 'Your memory setting could not be saved.'
        }
      }), {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
    return new Response(JSON.stringify({
      updated: true
    }), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
  // ── DELETE /memory/:tripId ───────────────────────────────────────
  const deleteMemoryMatch = path.match(/^\/memory\/([^/]+)$/);
  if (req.method === 'DELETE' && deleteMemoryMatch) {
    const memTripId = deleteMemoryMatch[1];
    // copilot_trip_summaries.trip_id is uuid: a non-uuid path segment fails
    // with 22P02. The error was discarded and the route answered
    // {deleted: true} for a delete that never happened.
    const { error: memDeleteErr } = await supabase.from('copilot_trip_summaries').delete().eq('trip_id', memTripId).eq('user_id', userId);
    if (memDeleteErr) {
      console.error('[ai-copilot-v2] memory delete failed:', memDeleteErr.message);
      return new Response(JSON.stringify({
        error: {
          code: 'DB_ERROR',
          message: 'That trip memory could not be deleted.'
        }
      }), {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
    return new Response(JSON.stringify({
      deleted: true
    }), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
  return new Response(JSON.stringify({
    error: {
      code: 'NOT_FOUND',
      message: 'Route not found'
    }
  }), {
    status: 404,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json'
    }
  });
});

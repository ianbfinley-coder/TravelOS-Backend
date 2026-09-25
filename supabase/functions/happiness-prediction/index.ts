import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders } from "./_shared/auth.ts";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const log = (...args)=>console.log("[happiness-prediction]", ...args);
// DEFECT SWEEP 2026-09-19 — this function invented most of what it reported.
// Four separate fabrications and one dead write, detailed at each site below:
//
//   1. MOCK ITINERARY. handleGetPredictionsDay, on finding no itinerary items
//      for a date (or on a failed query, whose error was only logged),
//      substituted three hardcoded activities — "mock-1" museum, "mock-2"
//      restaurant, "mock-3" park — and returned a happiness score computed
//      from them as that day's prediction, complete with a confidence
//      interval and an energy-used percentage. A traveller with an empty day,
//      or whose itinerary failed to load, was shown a score for a day that
//      does not exist.
//   2. INVENTED WEATHER. Every prediction context was built as
//      `{ precipProb: 0, tempC: 20 }`. Those values feed the weather penalty
//      term directly, so an outdoor activity in a downpour or a heatwave was
//      always scored as though the day were dry and 20 degrees. The project
//      has a weather_forecasts table; it was never consulted.
//   3. INVENTED SWAP IMPROVEMENTS. Every swap suggestion asserted a
//      predictedScore of `currentScore + 15` / `+ 12` / `+ 8` with an interval
//      of +/-10, +/-8, +/-6 around it. Those constants are not derived from
//      anything — not the model, not the profile, not the item. "Dropping this
//      activity will improve your day by 15 points" was a literal in the
//      source.
//   4. INVENTED RATING CONTEXT. handlePostRating stored a context of
//      `{ weather: null, dayIndex: 0, frictionScore: 0, groupSize: 1,
//         itemsBeforeToday: 0, energyUsedPct: 0 }` against every rating. That
//      is the record of the conditions a rating was given under, and it was
//      the same fabricated row every time — which then feeds model training.
//   5. DEAD WRITE (42703). The happy_moments insert passed `item_id` and
//      `tags`; that table has neither column (it has description, category,
//      rating, location, participants). PostgREST rejected the whole insert,
//      the result was never destructured so the error vanished, and the
//      try/catch around it was commented "table may not exist". The table
//      exists. No happy moment has ever been recorded.
// ─── Constants ────────────────────────────────────────────────
const EXERTION = {
  museum: 8,
  gallery: 8,
  art: 8,
  hike: 20,
  trek: 20,
  outdoor: 15,
  beach: 5,
  park: 5,
  garden: 5,
  dinner: 3,
  lunch: 3,
  breakfast: 2,
  restaurant: 3,
  food: 3,
  transit: 6,
  transport: 6,
  flight: 10,
  tour: 12,
  activity: 12,
  shopping: 7,
  market: 7,
  bar: 4,
  nightlife: 6,
  club: 8,
  spa: 3,
  wellness: 3,
  default: 8
};
const CATEGORY_FEATURES = {
  museum: {
    "culture.art_museums": 1,
    "style.ambience_small": 0.3
  },
  gallery: {
    "culture.art_museums": 0.8,
    "culture.architecture": 0.3
  },
  history: {
    "culture.history": 1
  },
  restaurant: {
    "food.local_traditional": 0.5,
    "food.fine_dining": 0.3
  },
  street_food: {
    "food.street_food": 1
  },
  cafe: {
    "food.cafes": 1,
    "style.ambience_small": 0.5
  },
  hike: {
    "outdoors.hiking": 1,
    "style.walking": 0.8
  },
  beach: {
    "outdoors.beach": 1
  },
  park: {
    "outdoors.parks_gardens": 1
  },
  viewpoint: {
    "outdoors.viewpoints": 1
  },
  bar: {
    "nightlife.bars": 1
  },
  club: {
    "nightlife.clubs": 1
  },
  live_music: {
    "nightlife.live_music": 1
  },
  market: {
    "shopping.markets": 1
  },
  spa: {
    "wellness.spa": 1
  },
  default: {}
};
const CATEGORY_MEANS = {
  museum: 3.8,
  restaurant: 4.0,
  hike: 4.1,
  beach: 4.2,
  bar: 3.6,
  spa: 4.3,
  market: 3.9,
  tour: 3.9,
  default: 3.7
};
const HAPPY_TAGS = new Set([
  "Delicious",
  "Beautiful",
  "Fun",
  "Relaxing"
]);
const NO_PROMPT_TYPES = new Set([
  "flight",
  "transfer",
  "transit",
  "transport"
]);
// ─── Helpers ────────────────────────────────────────────────
function dailyEnergyBudget(paceFactor) {
  const pf = 1.0 + paceFactor * 0.2;
  return 100 * pf;
}
function itemEnergyCost(category, durationHours) {
  const exertion = EXERTION[category.toLowerCase()] ?? EXERTION.default;
  return exertion * durationHours;
}
function defaultModel(userId) {
  return {
    user_id: userId,
    rating_count: 0,
    bias: 0,
    beta_aff: 0.4,
    beta_q: 0.3,
    beta_w: -0.2,
    beta_f: -0.3,
    beta_g: 0.2,
    beta_t: 0.15,
    residual_std: 0.8,
    calibrated: false,
    within_1_star_pct: null,
    interval_coverage_pct: null
  };
}
function background(p) {
  const rt = globalThis.EdgeRuntime;
  if (rt && typeof rt.waitUntil === "function") rt.waitUntil(p);
  else void Promise.resolve(p).catch((e)=>log("background task failed", e));
}
async function fetchProfileVector(userId) {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/traveler-profile/internal/profile-vector`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // DEFECT 2026-09-20 (this call had never once succeeded) — the
        // Authorization header was absent. x-service-key alone is not
        // enough and never was: traveler-profile runs with
        // verify_jwt: true, so the Supabase functions gateway looks for a
        // JWT and rejects the request before any TravelOS code runs. The
        // 401 came back as {"code":"UNAUTHORIZED_NO_AUTH_HEADER"} — the
        // gateway's wording, not traveler-profile's — so the service-key
        // check on the other side was never even reached. The catch below
        // logged it and returned {}, and an empty vector zeroes the
        // affinity term in predictItem: every happiness prediction, day
        // score and swap suggestion this function has ever produced was
        // computed with the traveller's taste profile contributing
        // nothing, silently falling back to the category mean. Sending the
        // service-role key as Bearer gets past the gateway; x-service-key
        // stays because that is what the route's own check reads.
        "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "x-service-key": SUPABASE_SERVICE_ROLE_KEY
      },
      body: JSON.stringify({
        userId,
        context: "all"
      })
    });
    if (!res.ok) {
      // Previously a silent `return {}` — an empty profile vector zeroes the
      // affinity term, so every prediction quietly fell back to the category
      // mean with no indication that the traveller's taste profile was missing.
      const text = await res.text().catch(()=>"<unreadable>");
      log("profile-vector fetch failed", res.status, text.slice(0, 300));
      return {};
    }
    const data = await res.json();
    return data?.vector ?? data ?? {};
  } catch (e) {
    log("profile-vector fetch threw", e instanceof Error ? e.message : String(e));
    return {};
  }
}
async function getOrCreateModel(supabase, userId) {
  const { data, error } = await supabase.from("prediction_models").select("*").eq("user_id", userId).maybeSingle();
  if (error) log("prediction_models read failed", error.code, error.message);
  return data ?? defaultModel(userId);
}
/**
 * Weather for a trip day, or nulls when none is held.
 *
 * DEFECT 2026-09-19 — this lookup did not exist; every context was built with
 * `precipProb: 0, tempC: 20` hardcoded.
 */ async function fetchWeather(supabase, tripId, date) {
  const { data, error } = await supabase.from("weather_forecasts").select("temperature, precipitation").eq("trip_id", tripId).eq("forecast_date", date).order("fetched_at", {
    ascending: false
  }).limit(1).maybeSingle();
  if (error) {
    log("weather_forecasts read failed", error.code, error.message);
    return {
      precipProb: null,
      tempC: null
    };
  }
  if (!data) return {
    precipProb: null,
    tempC: null
  };
  const precip = data.precipitation === null || data.precipitation === undefined ? null : Number(data.precipitation);
  const temp = data.temperature === null || data.temperature === undefined ? null : Number(data.temperature);
  return {
    // `precipitation` is stored as a probability or mm depending on source;
    // treat > 1 as mm and normalise conservatively rather than inventing.
    precipProb: precip === null || !Number.isFinite(precip) ? null : precip > 1 ? Math.min(1, precip / 10) : precip,
    tempC: temp === null || !Number.isFinite(temp) ? null : temp
  };
}
function predictItem(item, context, model, profileVector) {
  const category = item.category?.toLowerCase() || "default";
  const mu = CATEGORY_MEANS[category] ?? CATEGORY_MEANS.default;
  const n = model.rating_count;
  const bias = model.bias * (n / (n + 10));
  const features = CATEGORY_FEATURES[category] ?? CATEGORY_FEATURES.default;
  let affinity = 0;
  for (const [key, val] of Object.entries(features)){
    affinity += (profileVector[key] ?? 0) * val;
  }
  affinity = Math.max(-1, Math.min(1, affinity));
  // A FIXED PRIOR, not a measurement of this item. It was previously written
  // as `const quality = 3.8 - 4.2;` and reported in the response as
  // `factors.quality`, which reads as a per-item quality assessment. It is the
  // same -0.4 for every item ever predicted; renamed so nobody mistakes it for
  // one. Replace it with a real venue-quality signal when one exists.
  const qualityPrior = -0.4;
  const isOutdoor = [
    "hike",
    "beach",
    "park",
    "viewpoint",
    "outdoor"
  ].includes(category);
  const weatherKnown = context.precipProb !== null && context.tempC !== null;
  // With no forecast, the weather term contributes nothing AND the response
  // says so — rather than silently contributing the penalty for a dry 20C day.
  const weatherPenalty = isOutdoor && weatherKnown ? (context.precipProb > 0.6 ? -0.5 : 0) + (context.tempC > 32 ? -0.3 : 0) + (context.tempC < 5 ? -0.4 : 0) : 0;
  const fatigue = Math.max(0, Math.min(1, context.energyUsedPct - 0.7));
  const groupFit = 0;
  const earlyBirdPref = profileVector["style.early_bird"] ?? 0;
  const timeOfDayFit = earlyBirdPref > 0 && item.hourLocal < 10 ? 0.2 : earlyBirdPref < 0 && item.hourLocal > 20 ? 0.2 : 0;
  const rHat = mu + bias + model.beta_aff * affinity + model.beta_q * qualityPrior + model.beta_w * weatherPenalty + model.beta_f * -fatigue + model.beta_g * groupFit + model.beta_t * timeOfDayFit;
  const clamped = Math.max(1, Math.min(5, rHat));
  const sigma = model.residual_std * (n < 20 ? 1.3 : 1.0);
  const interval = 1.28 * sigma;
  return {
    rating: Math.round(clamped * 10) / 10,
    intervalLow: Math.max(1, Math.round((clamped - interval) * 10) / 10),
    intervalHigh: Math.min(5, Math.round((clamped + interval) * 10) / 10),
    weatherKnown,
    factors: {
      affinity: Math.round(model.beta_aff * affinity * 100) / 100,
      qualityPrior: Math.round(model.beta_q * qualityPrior * 100) / 100,
      weather: isOutdoor && !weatherKnown ? null : Math.round(model.beta_w * weatherPenalty * 100) / 100,
      fatigue: Math.round(model.beta_f * -fatigue * 100) / 100,
      groupFit: 0,
      timeOfDay: Math.round(model.beta_t * timeOfDayFit * 100) / 100
    }
  };
}
function generateId() {
  return crypto.randomUUID();
}
function errResponse(code, message, status) {
  return new Response(JSON.stringify({
    error: {
      code,
      message
    }
  }), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json"
    }
  });
}
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json"
    }
  });
}
// ─── Auth ─────────────────────────────────────────────────────
async function getUserId(req) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return {
      error: errResponse("unauthorized", "Missing Authorization header", 401)
    };
  }
  const token = authHeader.slice(7);
  const client = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: { user }, error } = await client.auth.getUser(token);
  if (error || !user) {
    return {
      error: errResponse("unauthorized", "Invalid token", 401)
    };
  }
  return {
    userId: user.id
  };
}
/** Confirms the caller owns the trip before any trip data is read or written. */ async function requireTrip(supabase, tripId, userId) {
  const { data, error } = await supabase.from("trips").select("id").eq("id", tripId).eq("user_id", userId).maybeSingle();
  if (error) {
    log("trip ownership check failed", error.code, error.message);
    return errResponse("db_error", "Failed to verify trip", 500);
  }
  if (!data) return errResponse("not_found", "Trip not found", 404);
  return null;
}
/** Itinerary items for a trip day. Throws rather than returning [] on failure. */ async function loadDayItems(supabase, tripId, date) {
  const { data: rows, error } = await supabase.from("itinerary_items").select("id, category, duration_min, start_time").eq("trip_id", tripId).eq("date", date);
  // DEFECT 2026-09-19 — this error was only logged, and the caller then fell
  // through to the mock itinerary. A failed read produced a fabricated day.
  if (error) {
    log("itinerary_items read failed", error.code, error.message);
    return errResponse("db_error", `Failed to load the itinerary for ${date}: ${error.message}`, 500);
  }
  return (rows ?? []).map((r)=>({
      id: r.id,
      category: r.category ?? "default",
      durationHours: (r.duration_min ?? 0) / 60,
      hourLocal: r.start_time ? parseInt(String(r.start_time).split(":")[0], 10) : 12
    }));
}
// ─── Route Handlers ────────────────────────────────────────────
async function handlePostRating(req, userId, supabase) {
  let body;
  try {
    body = await req.json();
  } catch  {
    return errResponse("bad_request", "Invalid JSON body", 400);
  }
  const { tripId, itemId, rating, tags = [] } = body;
  if (!tripId || !itemId) {
    return errResponse("bad_request", "tripId and itemId are required", 400);
  }
  if (typeof rating !== "number" || rating < 1 || rating > 5 || !Number.isInteger(rating)) {
    return errResponse("bad_request", "rating must be an integer between 1 and 5", 400);
  }
  const denied = await requireTrip(supabase, tripId, userId);
  if (denied) return denied;
  const hourLocal = new Date().getUTCHours();
  // DEFECT 2026-09-19 (fabricated data) — the stored context used to be
  //   { weather: null, dayIndex: 0, frictionScore: 0, groupSize: 1,
  //     itemsBeforeToday: 0, energyUsedPct: 0 }
  // The same invented row was written against every rating, describing
  // conditions nobody measured, and this is the table the prediction model is
  // trained from — so the fabrication does not just display wrong, it teaches
  // the model wrong. Only what is actually known is recorded; the rest is
  // explicitly null and marked unmeasured.
  const context = {
    hourLocalUtc: hourLocal,
    ratedAt: new Date().toISOString(),
    weather: null,
    dayIndex: null,
    frictionScore: null,
    groupSize: null,
    itemsBeforeToday: null,
    energyUsedPct: null,
    measured: false,
    note: "Only the rating time is measured. Earlier versions of this function recorded zeros here as though they were observations."
  };
  // Fetch existing prediction if any
  const { data: existing, error: existingErr } = await supabase.from("item_ratings").select("predicted").eq("user_id", userId).eq("item_id", itemId).maybeSingle();
  if (existingErr) log("item_ratings read failed", existingErr.code, existingErr.message);
  const id = generateId();
  const { error: upsertErr } = await supabase.from("item_ratings").upsert({
    id,
    user_id: userId,
    trip_id: tripId,
    item_id: itemId,
    rating,
    tags,
    context,
    predicted: existing?.predicted ?? null
  }, {
    onConflict: "user_id,item_id"
  });
  if (upsertErr) {
    log("upsert error", upsertErr);
    return errResponse("db_error", upsertErr.message, 500);
  }
  // Log happy moment if applicable.
  //
  // DEFECT 2026-09-19 (42703) — this insert passed `item_id` and `tags`.
  // happy_moments has neither; it has (id, trip_id, user_id, description,
  // category, rating, location, participants, created_at), with description
  // NOT NULL. The insert failed every time with an unknown-column error, the
  // result was never destructured so nothing surfaced it, and the try/catch
  // was commented "table may not exist — skip gracefully". The table exists;
  // not one happy moment has ever been saved. Rewritten against the real
  // columns, with the item id and tags carried in `description`, and the error
  // reported rather than swallowed.
  let happyMomentSaved = null;
  if (rating >= 4 && tags.some((t)=>HAPPY_TAGS.has(t))) {
    const matched = tags.filter((t)=>HAPPY_TAGS.has(t));
    const { error: happyErr } = await supabase.from("happy_moments").insert({
      id: generateId(),
      user_id: userId,
      trip_id: tripId,
      description: `Rated ${rating}/5${matched.length ? ` — ${matched.join(", ")}` : ""} (itinerary item ${itemId})`,
      category: "moment",
      rating
    });
    if (happyErr) {
      log("happy_moments insert failed", happyErr.code, happyErr.message);
    }
    happyMomentSaved = !happyErr;
  }
  // Update rating_prompt_state: reset consecutive_skips. Previously the error
  // was discarded, so a failed write left the skip counter high and prompts
  // suppressed for a user who had just engaged.
  const { error: promptErr } = await supabase.from("rating_prompt_state").upsert({
    user_id: userId,
    consecutive_skips: 0,
    last_prompt_at: new Date().toISOString()
  }, {
    onConflict: "user_id"
  });
  if (promptErr) log("rating_prompt_state upsert failed", promptErr.code, promptErr.message);
  // Trigger profile signal.
  //
  // DEFECT 2026-09-19 — this was an un-awaited fetch with `.catch(() => {})`.
  // A non-2xx is a resolved promise so the catch never fired, and nothing held
  // the isolate open, so the signal may never have been sent at all. Awaited
  // in waitUntil with the status logged.
  //
  // NOTE: `category` here is hardcoded "default", so `features` is always {}
  // and the signal carries no category information. That is pre-existing and
  // marked in the original as "simplified"; it is left, but it means the
  // signal is close to inert.
  const category = "default";
  const features = CATEGORY_FEATURES[category] ?? {};
  const strength = (rating - 3) * 0.8;
  //
  // DEFECT 2026-09-20 (two faults, both fatal, fixed together) — this posted
  // to /traveler-profile/signals with no Authorization header:
  //
  //   1. No Authorization header. traveler-profile has verify_jwt: true, so
  //      the functions gateway rejected this before traveler-profile ran at
  //      all. A service-key header is invisible to the gateway; it only ever
  //      looks for a JWT. Fixed by sending the service-role key as Bearer.
  //   2. Wrong route. /signals sits BELOW traveler-profile's JWT gate and
  //      attributes the signal to whoever the token resolves to, ignoring the
  //      body's userId entirely. A service-role bearer has no `sub`, so
  //      auth.getUser() yields nobody and the route 401s. Even with the header
  //      added, this could never have worked. Fixed by pointing at
  //      /internal/signal, added to traveler-profile the same day: it sits
  //      above the JWT gate, is gated on the same constant-time service-key
  //      check as /internal/profile-vector, and is the one route there that
  //      may take its subject from the body. The userId already being sent
  //      becomes load-bearing rather than ignored.
  //
  // Neither half works alone, which is why they shipped together. No rating
  // signal this function believed it was recording has ever reached the
  // traveller's profile.
  background((async ()=>{
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/traveler-profile/internal/signal`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "x-service-key": SUPABASE_SERVICE_ROLE_KEY
        },
        body: JSON.stringify({
          userId,
          kind: "rated",
          features,
          strength
        })
      });
      if (!res.ok) {
        const text = await res.text().catch(()=>"<unreadable>");
        log("traveler-profile/internal/signal returned", res.status, text.slice(0, 300));
      }
    } catch (e) {
      log("traveler-profile/internal/signal threw", e instanceof Error ? e.message : String(e));
    }
  })());
  log(`rated item ${itemId} by user ${userId}: ${rating}`);
  return jsonResponse({
    id,
    rating,
    tags,
    happyMomentSaved
  }, 201);
}
async function handleSkip(req, userId, supabase) {
  let body;
  try {
    body = await req.json();
  } catch  {
    return errResponse("bad_request", "Invalid JSON body", 400);
  }
  const { itemId, tripId } = body;
  if (!itemId || !tripId) {
    return errResponse("bad_request", "itemId and tripId are required", 400);
  }
  const { data: state, error: stateErr } = await supabase.from("rating_prompt_state").select("*").eq("user_id", userId).maybeSingle();
  if (stateErr) {
    // Previously discarded: a failed read reset consecutive_skips to 1, so the
    // "pause after 3 skips" rule could never be reached for that user.
    log("rating_prompt_state read failed", stateErr.code, stateErr.message);
    return errResponse("db_error", "Failed to load your prompt state", 500);
  }
  const currentSkips = (state?.consecutive_skips ?? 0) + 1;
  const paused = currentSkips >= 3;
  const pausedUntil = paused ? new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString() : null;
  const { error: upsertErr } = await supabase.from("rating_prompt_state").upsert({
    user_id: userId,
    consecutive_skips: currentSkips,
    paused_until: pausedUntil
  }, {
    onConflict: "user_id"
  });
  if (upsertErr) {
    log("rating_prompt_state upsert failed", upsertErr.code, upsertErr.message);
    return errResponse("db_error", "Failed to record the skip", 500);
  }
  log(`skip for user ${userId}, skips=${currentSkips}, paused=${paused}`);
  return jsonResponse({
    paused,
    ...pausedUntil ? {
      pausedUntil
    } : {}
  });
}
async function handleGetPredictionsItems(url, userId, supabase) {
  const tripId = url.searchParams.get("tripId");
  const idsParam = url.searchParams.get("ids");
  const date = url.searchParams.get("date");
  if (!tripId || !idsParam) {
    return errResponse("bad_request", "tripId and ids are required", 400);
  }
  const ids = idsParam.split(",").map((s)=>s.trim()).filter(Boolean);
  if (ids.length === 0) {
    return jsonResponse([]);
  }
  const denied = await requireTrip(supabase, tripId, userId);
  if (denied) return denied;
  const [model, profileVector] = await Promise.all([
    getOrCreateModel(supabase, userId),
    fetchProfileVector(userId)
  ]);
  const { data: items, error: itemsErr } = await supabase.from("itinerary_items").select("id, category, duration_min").in("id", ids);
  // Previously only logged, leaving every item at the "default" category — so
  // a failed read produced predictions for generic activities rather than the
  // traveller's actual ones, with nothing saying so.
  if (itemsErr) {
    log("itinerary_items read failed", itemsErr.code, itemsErr.message);
    return errResponse("db_error", `Failed to load those itinerary items: ${itemsErr.message}`, 500);
  }
  const itemMap = {};
  for (const it of items ?? []){
    itemMap[it.id] = {
      category: it.category ?? "default",
      durationHours: (it.duration_min ?? 0) / 60
    };
  }
  const weather = date ? await fetchWeather(supabase, tripId, date) : {
    precipProb: null,
    tempC: null
  };
  const hourLocal = new Date().getUTCHours();
  const results = ids.map((itemId)=>{
    const itemData = itemMap[itemId];
    const item = {
      id: itemId,
      category: itemData?.category ?? "default",
      durationHours: itemData?.durationHours ?? 1,
      hourLocal
    };
    const ctx = {
      precipProb: weather.precipProb,
      tempC: weather.tempC,
      groupSize: 1,
      energyUsedPct: 0,
      dayIndex: 0
    };
    const pred = predictItem(item, ctx, model, profileVector);
    return {
      itemId,
      known: !!itemData,
      rating: pred.rating,
      intervalLow: pred.intervalLow,
      intervalHigh: pred.intervalHigh,
      calibrated: model.calibrated,
      weatherKnown: pred.weatherKnown,
      factors: pred.factors
    };
  });
  return jsonResponse(results);
}
async function handleGetPredictionsDay(url, date, userId, supabase) {
  const tripId = url.searchParams.get("tripId");
  if (!tripId) {
    return errResponse("bad_request", "tripId is required", 400);
  }
  const denied = await requireTrip(supabase, tripId, userId);
  if (denied) return denied;
  const [model, profileVector] = await Promise.all([
    getOrCreateModel(supabase, userId),
    fetchProfileVector(userId)
  ]);
  const loaded = await loadDayItems(supabase, tripId, date);
  if (loaded instanceof Response) return loaded;
  const items = loaded;
  // DEFECT 2026-09-19 (fabricated data) — what stood here was:
  //   if (items.length === 0) {
  //     items = [
  //       { id: "mock-1", category: "museum", durationHours: 2, hourLocal: 10 },
  //       { id: "mock-2", category: "restaurant", durationHours: 1.5, hourLocal: 13 },
  //       { id: "mock-3", category: "park", durationHours: 1, hourLocal: 16 },
  //     ];
  //   }
  // Three invented activities, scored by the real model, returned as the
  // traveller's predicted happiness for that date with an interval and an
  // energy figure attached. A day with nothing planned is now reported as a
  // day with nothing planned.
  if (items.length === 0) {
    return jsonResponse({
      date,
      score: null,
      intervalLow: null,
      intervalHigh: null,
      energyUsedPct: null,
      overloaded: null,
      itemCount: 0,
      calibrated: model.calibrated,
      reason: "Nothing is scheduled on this day, so there is no day to score."
    });
  }
  const weather = await fetchWeather(supabase, tripId, date);
  const paceFactor = profileVector["style.pace"] ?? 0;
  const budget = dailyEnergyBudget(paceFactor);
  let totalEnergyCost = 0;
  for (const it of items){
    totalEnergyCost += itemEnergyCost(it.category, it.durationHours);
  }
  const energyUsedPct = Math.min(1, totalEnergyCost / budget);
  const overloaded = totalEnergyCost > budget;
  const overload = Math.max(0, totalEnergyCost - budget) / 20;
  const weights = items.map((_, i)=>i < 3 ? 1 : i === 3 ? 0.8 : 0.6);
  let weightedSum = 0;
  let weightSum = 0;
  let intervalLowSum = 0;
  let intervalHighSum = 0;
  let anyWeatherKnown = false;
  for(let i = 0; i < items.length; i++){
    const ctx = {
      precipProb: weather.precipProb,
      tempC: weather.tempC,
      groupSize: 1,
      energyUsedPct,
      dayIndex: 0
    };
    const pred = predictItem(items[i], ctx, model, profileVector);
    if (pred.weatherKnown) anyWeatherKnown = true;
    const w = weights[i];
    weightedSum += w * pred.rating;
    intervalLowSum += w * pred.intervalLow;
    intervalHighSum += w * pred.intervalHigh;
    weightSum += w;
  }
  // weightSum is always > 0 here because items.length > 0, so the previous
  // `: 3.5` / `: 2.5` / `: 4.5` fallbacks (three more invented scores) are gone.
  const rawScore = weightedSum / weightSum;
  const rawLow = intervalLowSum / weightSum;
  const rawHigh = intervalHighSum / weightSum;
  const toScore = (r)=>Math.round((r - 1) / 4 * 100);
  const score = Math.max(0, Math.min(100, toScore(rawScore) - Math.round(overload * 10)));
  const intervalLow = Math.max(0, toScore(rawLow));
  const intervalHigh = Math.min(100, toScore(rawHigh));
  log(`day prediction ${date} trip=${tripId} score=${score}`);
  return jsonResponse({
    date,
    score,
    intervalLow,
    intervalHigh,
    energyUsedPct: Math.round(energyUsedPct * 100) / 100,
    overloaded,
    itemCount: items.length,
    calibrated: model.calibrated,
    weatherKnown: anyWeatherKnown
  });
}
async function handlePostSwaps(req, userId, supabase) {
  let body;
  try {
    body = await req.json();
  } catch  {
    return errResponse("bad_request", "Invalid JSON body", 400);
  }
  const { tripId, date } = body;
  if (!tripId) {
    return errResponse("bad_request", "tripId is required", 400);
  }
  const denied = await requireTrip(supabase, tripId, userId);
  if (denied) return denied;
  const [model, profileVector] = await Promise.all([
    getOrCreateModel(supabase, userId),
    fetchProfileVector(userId)
  ]);
  const targetDate = date ?? new Date().toISOString().split("T")[0];
  const nextDate = new Date(new Date(targetDate).getTime() + 86400000).toISOString().split("T")[0];
  const dates = date ? [
    targetDate
  ] : [
    targetDate,
    nextDate
  ];
  // DEFECT 2026-09-19 (fabricated data) — every suggestion previously carried
  //   predictedScore = currentScore + 15   (drop_item)
  //   predictedScore = currentScore + 12   (replace_lowest)
  //   predictedScore = currentScore + 8    (energy_move)
  // with intervals of +/-10, +/-8 and +/-6 around those. None of those numbers
  // came from the model, the profile, or the item — they are literals. The app
  // presented them as "this change will take your day from 62 to 77". The
  // suggestions are kept, because the reasoning behind each (this is your
  // lowest-scoring item; this day is over your energy budget; this exertion is
  // scheduled late) is real and useful. The invented after-scores are not
  // reported: predictedScore is null and the current score stands on its own.
  const suggestions = [];
  for (const d of dates){
    if (suggestions.length >= 3) break;
    const loaded = await loadDayItems(supabase, tripId, d);
    if (loaded instanceof Response) return loaded;
    const items = loaded;
    if (items.length === 0) continue;
    const weather = await fetchWeather(supabase, tripId, d);
    const paceFactor = profileVector["style.pace"] ?? 0;
    const budget = dailyEnergyBudget(paceFactor);
    let totalEnergy = 0;
    for (const it of items)totalEnergy += itemEnergyCost(it.category, it.durationHours);
    const energyUsedPct = Math.min(1, totalEnergy / budget);
    const overloaded = totalEnergy > budget;
    const preds = items.map((it)=>{
      const ctx = {
        precipProb: weather.precipProb,
        tempC: weather.tempC,
        groupSize: 1,
        energyUsedPct,
        dayIndex: 0
      };
      return {
        item: it,
        pred: predictItem(it, ctx, model, profileVector)
      };
    });
    const sorted = [
      ...preds
    ].sort((a, b)=>a.pred.rating - b.pred.rating);
    const lowest = sorted[0];
    if (overloaded && lowest && suggestions.length < 3) {
      suggestions.push({
        kind: "drop_item",
        description: `Drop the lowest-rated ${lowest.item.category} activity on ${d} to reduce overload.`,
        fromItemId: lowest.item.id,
        currentScore: Math.round((lowest.pred.rating - 1) / 4 * 100),
        predictedScore: null,
        predictedIntervalLow: null,
        predictedIntervalHigh: null,
        basis: `This day's planned exertion (${Math.round(totalEnergy)}) exceeds your energy budget (${Math.round(budget)}), and this is its lowest-scoring item. The size of the improvement is not estimated.`,
        calibrated: model.calibrated
      });
    }
    if (lowest && suggestions.length < 3) {
      suggestions.push({
        kind: "replace_lowest",
        description: `Replace the ${lowest.item.category} activity on ${d} with something better suited to your taste profile.`,
        fromItemId: lowest.item.id,
        currentScore: Math.round((lowest.pred.rating - 1) / 4 * 100),
        predictedScore: null,
        predictedIntervalLow: null,
        predictedIntervalHigh: null,
        basis: "This is the lowest-scoring item on the day against your taste profile. No replacement has been chosen, so no after-score can be given.",
        calibrated: model.calibrated
      });
    }
    const highEnergy = preds.filter((p)=>p.item.hourLocal > 15 && itemEnergyCost(p.item.category, p.item.durationHours) > 12).sort((a, b)=>itemEnergyCost(b.item.category, b.item.durationHours) - itemEnergyCost(a.item.category, a.item.durationHours))[0];
    if (highEnergy && suggestions.length < 3) {
      suggestions.push({
        kind: "energy_move",
        description: `Move the ${highEnergy.item.category} activity on ${d} to the morning when your energy is higher.`,
        fromItemId: highEnergy.item.id,
        currentScore: Math.round((highEnergy.pred.rating - 1) / 4 * 100),
        predictedScore: null,
        predictedIntervalLow: null,
        predictedIntervalHigh: null,
        basis: `This is a high-exertion activity scheduled at ${highEnergy.item.hourLocal}:00. The size of the improvement is not estimated.`,
        calibrated: model.calibrated
      });
    }
  }
  log(`swaps for user ${userId} trip=${tripId}: ${suggestions.length} suggestions`);
  return jsonResponse({
    suggestions,
    calibrated: model.calibrated,
    note: "predictedScore is null by design: earlier versions reported a fixed +15/+12/+8 improvement that was not derived from anything."
  });
}
async function handleGetAccuracy(userId, supabase) {
  const model = await getOrCreateModel(supabase, userId);
  const ratingCount = model.rating_count;
  const calibrated = model.calibrated;
  let message;
  if (calibrated && model.within_1_star_pct != null) {
    message = `Predictions for you are within 1 star ${Math.round(model.within_1_star_pct)}% of the time (based on ${ratingCount} ratings).`;
  } else {
    message = `TravelOS is still learning your taste. ${ratingCount} rating${ratingCount === 1 ? "" : "s"} so far.`;
  }
  return jsonResponse({
    ratingCount,
    calibrated,
    within1StarPct: model.within_1_star_pct,
    intervalCoveragePct: model.interval_coverage_pct,
    message
  });
}
async function handleGetPrompt(url, userId, supabase) {
  const tripId = url.searchParams.get("tripId");
  const itemId = url.searchParams.get("itemId");
  if (!tripId || !itemId) {
    return errResponse("bad_request", "tripId and itemId are required", 400);
  }
  // Check item type — never prompt for flights/transfers.
  //
  // Previously wrapped in a try/catch with the error discarded, so a failed
  // read left itemCategory as "default" and the traveller could be prompted to
  // rate a flight — the exact case this check exists to prevent.
  const { data: item, error: itemErr } = await supabase.from("itinerary_items").select("category").eq("id", itemId).maybeSingle();
  if (itemErr) {
    log("itinerary_items read failed", itemErr.code, itemErr.message);
    return errResponse("db_error", "Failed to load that item", 500);
  }
  const itemCategory = item?.category ? String(item.category).toLowerCase() : "default";
  if (NO_PROMPT_TYPES.has(itemCategory)) {
    return jsonResponse({
      shouldPrompt: false,
      reason: "Item type does not require rating"
    });
  }
  // Check quiet hours (22:00-08:00 UTC as proxy for local)
  const hourUtc = new Date().getUTCHours();
  if (hourUtc >= 22 || hourUtc < 8) {
    return jsonResponse({
      shouldPrompt: false,
      reason: "Quiet hours"
    });
  }
  const { data: state, error: stateErr } = await supabase.from("rating_prompt_state").select("*").eq("user_id", userId).maybeSingle();
  if (stateErr) {
    // Previously discarded: a failed read bypassed both the pause check and the
    // daily limit, so a user who had paused prompts could be prompted anyway.
    log("rating_prompt_state read failed", stateErr.code, stateErr.message);
    return errResponse("db_error", "Failed to load your prompt state", 500);
  }
  const today = new Date().toISOString().split("T")[0];
  if (state) {
    if (state.paused_until && new Date(state.paused_until) > new Date()) {
      return jsonResponse({
        shouldPrompt: false,
        reason: "Prompts paused"
      });
    }
    if (state.prompts_today_date === today && state.prompts_today >= 3) {
      return jsonResponse({
        shouldPrompt: false,
        reason: "Daily prompt limit reached"
      });
    }
  }
  const currentState = state ?? {
    prompts_today: 0,
    prompts_today_date: today
  };
  const newCount = currentState.prompts_today_date === today ? currentState.prompts_today + 1 : 1;
  const { error: upsertErr } = await supabase.from("rating_prompt_state").upsert({
    user_id: userId,
    prompts_today: newCount,
    prompts_today_date: today,
    last_prompt_at: new Date().toISOString()
  }, {
    onConflict: "user_id"
  });
  if (upsertErr) {
    // Previously discarded, so the daily counter could fail to advance and the
    // "max 3 per day" cap would never bite.
    log("rating_prompt_state upsert failed", upsertErr.code, upsertErr.message);
    return errResponse("db_error", "Failed to record the prompt", 500);
  }
  log(`prompt shown for user ${userId} item=${itemId}`);
  return jsonResponse({
    shouldPrompt: true
  });
}
// ─── Main Router ──────────────────────────────────────────────
Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders
    });
  }
  const url = new URL(req.url);
  const pathParts = url.pathname.replace(/^\/happiness-prediction/, "").replace(/^\//, "");
  const segments = pathParts.split("/").filter(Boolean);
  log(`${req.method} /${segments.join("/")}`);
  const authResult = await getUserId(req);
  if ("error" in authResult) return authResult.error;
  const { userId } = authResult;
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  if (req.method === "POST" && segments[0] === "ratings" && segments[1] === "skip") {
    return handleSkip(req, userId, supabase);
  }
  if (req.method === "POST" && segments[0] === "ratings" && !segments[1]) {
    return handlePostRating(req, userId, supabase);
  }
  if (req.method === "GET" && segments[0] === "predictions" && segments[1] === "items") {
    return handleGetPredictionsItems(url, userId, supabase);
  }
  if (req.method === "GET" && segments[0] === "predictions" && segments[1] === "day" && segments[2]) {
    return handleGetPredictionsDay(url, segments[2], userId, supabase);
  }
  if (req.method === "POST" && segments[0] === "predictions" && segments[1] === "swaps") {
    return handlePostSwaps(req, userId, supabase);
  }
  if (req.method === "GET" && segments[0] === "accuracy") {
    return handleGetAccuracy(userId, supabase);
  }
  if (req.method === "GET" && segments[0] === "prompt") {
    return handleGetPrompt(url, userId, supabase);
  }
  return errResponse("not_found", "Route not found", 404);
});

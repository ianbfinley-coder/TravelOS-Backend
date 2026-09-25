// FABRICATION REMOVED 2026-09-18
//
// This function used to invent weather, flight status and traffic whenever a
// provider key was missing — `mockWeather()`, `mockFlightStatus()` and
// `mockTraffic()` produced deterministic, entirely plausible numbers from a
// hash of the input string, returned them with HTTP 200 and **no flag of any
// kind**, and wrote them to `weather_forecasts`, `flight_disruptions` and
// `traffic_updates`. `unified-alerts` and `alert-aggregator` then re-served
// those rows to the user as real alerts. A traveller could have been told
// their flight was cancelled on the strength of `flightNumber.length % 4`.
//
// `weather_forecasts.data_source` makes the point by itself: it is NOT NULL
// and defaults to the literal `'openweathermap'`, and the old code never set
// it. Every fabricated row would have been stamped as having come from
// OpenWeatherMap.
//
// Three separate paths produced fake data, not one:
//   1. No key            -> fell through to the mock function.
//   2. Upstream threw     -> `catch { weatherData = mockWeather(location) }`.
//   3. Upstream 4xx/5xx   -> NOT caught at all. `res.ok` was never checked, so
//      an OpenWeatherMap error body parsed cleanly and every `??` default
//      fired: 'Clear', 20 degrees, 60% humidity. That is the same defect found
//      in `recommendations` on 2026-09-17 — an upstream that fails with a
//      parseable body defeats status-code-free checks. It mattered doubly here
//      because an OpenWeatherMap key takes up to two hours to activate, so the
//      window right after adding a key is exactly when it would have lied.
// And `get_trip_intelligence` called all three mock functions UNCONDITIONALLY,
// so it fabricated even when the keys were present.
//
// The replacement never invents anything. Every reading comes from
// `provider-adapters`, which already implements these providers with caching,
// circuit breaking and explicit provenance. When a provider has no key or
// fails, this function returns `available: false` with a reason and
// **writes nothing** — an empty panel, not an invented one.
//
// Why provider-adapters rather than new keys:
//   * Weather is Open-Meteo, which needs NO API KEY. Verified live against
//     Paris on 2026-09-18: real hourly and daily forecast, HTTP 200.
//     `OPENWEATHERMAP_API_KEY` is therefore not needed at all.
//   * Flight status is FlightAware, which already has an adapter that returns
//     a clean `status: 'unavailable'` when `FLIGHTAWARE_API_KEY` is absent —
//     confirmed live, that is its current state. `AVIATION_API_KEY`
//     (aviationstack) would be a second, worse implementation of the same
//     capability: 100 requests/month, non-commercial, and its free tier does
//     not permit HTTPS. Not wired up. One flight provider, not two.
//   * Traffic has no usable provider — see handleTraffic.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const PROVIDERS = `${SUPABASE_URL}/functions/v1/provider-adapters`;
async function callProvider(path, authHeader) {
  try {
    const res = await fetch(`${PROVIDERS}${path}`, {
      headers: {
        Authorization: authHeader
      }
    });
    if (!res.ok) {
      console.error(`[travel-intelligence] provider-adapters ${path} HTTP ${res.status}`);
      return {
        data: null,
        status: 'unavailable',
        safeFailureMessage: `provider request failed (${res.status})`
      };
    }
    const json = await res.json();
    // A provider result must announce itself as ok AND carry data. Anything
    // else is treated as unavailable rather than coerced into defaults.
    if (json?.status !== 'ok' || json?.data == null) {
      return {
        data: null,
        status: 'unavailable',
        provenance: json?.provenance,
        safeFailureMessage: json?.safeFailureMessage ?? 'provider returned no data'
      };
    }
    return json;
  } catch (e) {
    console.error(`[travel-intelligence] provider-adapters ${path} threw:`, e instanceof Error ? e.message : String(e));
    return {
      data: null,
      status: 'unavailable',
      safeFailureMessage: 'provider unreachable'
    };
  }
}
// GEOCODE HONESTY 2026-09-18 — Mapbox always answers with its best guess and
// never refuses, so a location string the user mistyped still resolves to real
// coordinates somewhere. Probing `"Zzqxwvunk Nowhereville 99999"` returned a
// genuine Open-Meteo forecast for a point in Asia/Kolkata, presented under the
// requested name. The weather was real; the label was not. Callers therefore
// always get `resolvedLocation` back — the place Mapbox actually matched — so
// a wrong match is visible rather than silent. Gating on a relevance score
// would be better still, but the geocode adapter does not surface one; adding
// that belongs in provider-adapters.
async function geocode(place, authHeader) {
  const r = await callProvider(`/geocode?q=${encodeURIComponent(place)}`, authHeader);
  if (r.status !== 'ok' || typeof r.data?.lat !== 'number' || typeof r.data?.lon !== 'number') return null;
  return r.data;
}
// ── WMO weather codes (Open-Meteo) ──────────────────────────────────────────
// Open-Meteo reports a numeric WMO code, not a text label. This is the
// published mapping, not a guess.
function wmoCondition(code) {
  if (code == null) return 'Unknown';
  if (code === 0) return 'Clear';
  if (code <= 3) return 'Clouds';
  if (code === 45 || code === 48) return 'Fog';
  if (code >= 51 && code <= 57) return 'Drizzle';
  if (code >= 61 && code <= 67) return 'Rain';
  if (code >= 71 && code <= 77) return 'Snow';
  if (code >= 80 && code <= 82) return 'Rain';
  if (code === 85 || code === 86) return 'Snow';
  if (code >= 95) return 'Thunderstorm';
  return 'Unknown';
}
// Risks are derived ONLY from fields Open-Meteo actually returns through this
// adapter. The old analyzer also scored humidity and UV index, neither of
// which is in the payload — with the mocks gone those would always have been
// undefined, so scoring them would have produced silent false negatives.
function analyzeRisks(input) {
  const risks = [];
  if (input.windKph != null && input.windKph > 40) {
    risks.push({
      type: 'wind',
      severity: 3,
      description: `High winds expected (${Math.round(input.windKph)} km/h)`
    });
  }
  // precipProb is a PROBABILITY in percent, not millimetres. The old code
  // compared a millimetre value against 25; reusing that threshold here would
  // have flagged a 26% chance of drizzle as heavy rain.
  if (input.precipProb != null && input.precipProb > 70) {
    risks.push({
      type: 'rain',
      severity: 3,
      description: `High chance of precipitation (${Math.round(input.precipProb)}%)`
    });
  }
  if (input.code != null && input.code >= 95) {
    risks.push({
      type: 'severe_weather',
      severity: 4,
      description: 'Thunderstorm conditions forecast'
    });
  }
  return risks;
}
// Peak wind over the hours belonging to one local calendar day.
function peakWindKph(payload, date) {
  const hours = (payload.hourly ?? []).filter((h)=>typeof h.at === 'string' && h.at.slice(0, 10) === date);
  if (!hours.length) return null;
  return Math.max(...hours.map((h)=>h.windKph ?? 0));
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json'
    }
  });
}
// A single shape for "we could not find out." The client can render an empty
// state from this; it must never be mistaken for a reading.
function unavailable(what, reason, provider) {
  return {
    available: false,
    [what]: null,
    reason,
    provider: provider ?? null
  };
}
Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') return new Response('ok', {
    headers: corsHeaders
  });
  const supabase = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));
  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  let userId = null;
  if (token) {
    const { data: { user } } = await supabase.auth.getUser(token);
    userId = user?.id ?? null;
  }
  if (!userId) return json({
    error: 'Unauthorized'
  }, 401);
  let body = {};
  try {
    body = await req.json();
  } catch  {}
  const action = body.action;
  try {
    if (action === 'get_weather') return await handleWeather(supabase, userId, authHeader, body);
    if (action === 'get_flight_status') return await handleFlight(supabase, userId, authHeader, body);
    if (action === 'get_traffic') return handleTraffic();
    if (action === 'get_trip_intelligence') return await handleTripIntelligence(supabase, userId, authHeader, body);
    if (action === 'get_disruptions') return await handleDisruptions(supabase, userId, body);
    return json({
      error: 'Unknown action'
    }, 400);
  } catch (err) {
    console.error('[travel-intelligence] unhandled:', err instanceof Error ? err.message : String(err));
    return json({
      error: 'Internal server error'
    }, 500);
  }
});
// ── get_weather ─────────────────────────────────────────────────────────────
// DATE HANDLING 2026-09-18 — `forecast_date` is optional, and when it is
// omitted the answer wanted is "the soonest day there is a forecast for at the
// DESTINATION." Defaulting to `new Date()` in UTC gets that wrong by a day
// wherever local time has already rolled over: asked for Paris at 22:40 UTC
// this function looked for 2026-09-18 while Open-Meteo (which returns
// destination-local dates, `timezone=auto`) started at 2026-09-19, and
// correctly reported having no forecast for a date that had already ended
// there. So an explicit date is honoured exactly — absent means unavailable,
// never the nearest day — while an omitted date resolves to the first day the
// provider actually returned.
async function handleWeather(supabase, userId, authHeader, body) {
  const trip_id = body.trip_id;
  const location = body.location;
  if (!location) return json({
    error: 'location is required'
  }, 400);
  const requestedDate = body.forecast_date;
  // The stored-row cache is only consulted for an explicit date; with no date
  // the target day is not known until the provider answers. provider-adapters
  // caches the upstream call for an hour, so this is cheap either way.
  if (requestedDate) {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    let q = supabase.from('weather_forecasts').select('*').eq('user_id', userId).eq('location', location).eq('forecast_date', requestedDate).gte('fetched_at', twoHoursAgo);
    q = trip_id ? q.eq('trip_id', trip_id) : q.is('trip_id', null);
    const { data: cached } = await q.maybeSingle();
    if (cached) return json({
      available: true,
      forecast: cached,
      cached: true
    });
  }
  const point = await geocode(location, authHeader);
  if (!point) {
    return json(unavailable('forecast', `could not resolve location "${location}"`, 'mapbox'));
  }
  const wx = await callProvider(`/weather?lat=${point.lat}&lon=${point.lon}`, authHeader);
  if (wx.status !== 'ok' || !wx.data) {
    return json(unavailable('forecast', wx.safeFailureMessage ?? 'weather provider unavailable', wx.provenance?.provider ?? 'open-meteo'));
  }
  const daily = wx.data.daily ?? [];
  const day = requestedDate ? daily.find((d)=>d.date === requestedDate) ?? null : daily[0] ?? null;
  if (!day) {
    const span = daily.length ? ` (forecast covers ${daily[0].date} to ${daily[daily.length - 1].date})` : '';
    return json(unavailable('forecast', `no forecast available for ${requestedDate ?? 'this location'}${span}`, 'open-meteo'));
  }
  const windKph = peakWindKph(wx.data, day.date);
  const condition = wmoCondition(day.code);
  const risks = analyzeRisks({
    windKph,
    precipProb: day.precipProb ?? null,
    code: day.code ?? null
  });
  // Columns with no Open-Meteo equivalent through this adapter are left NULL.
  // `feels_like`, `humidity` and `uv_index` are not in the payload; the old
  // code filled them from the mock. NULL is the honest value.
  const row = {
    user_id: userId,
    trip_id: trip_id ?? null,
    location,
    forecast_date: day.date,
    condition,
    temperature: day.maxC ?? null,
    feels_like: null,
    humidity: null,
    wind_speed: windKph,
    precipitation: null,
    uv_index: null,
    risks,
    data_source: 'open-meteo',
    fetched_at: new Date().toISOString()
  };
  const { error: upsertErr } = await supabase.from('weather_forecasts').upsert(row, {
    onConflict: 'user_id,trip_id,location,forecast_date'
  });
  if (upsertErr) {
    // The old code discarded this error entirely.
    console.error('[travel-intelligence] weather_forecasts upsert failed:', upsertErr.message);
  }
  return json({
    available: true,
    // `location` is what was asked for; `resolvedLocation` is what was actually
    // measured. When they differ, the caller is looking at somewhere else's
    // weather and needs to be able to see that.
    resolvedLocation: point.placeName ?? null,
    forecast: {
      ...row,
      minC: day.minC ?? null,
      precipitationProbability: day.precipProb ?? null,
      sunrise: day.sunrise ?? null,
      sunset: day.sunset ?? null,
      timezone: wx.data.timezone ?? null
    },
    forecastRange: daily.length ? {
      from: daily[0].date,
      to: daily[daily.length - 1].date
    } : null,
    provenance: wx.provenance ?? {
      provider: 'open-meteo'
    },
    attribution: wx.provenance?.attribution ?? 'Weather data by Open-Meteo.com'
  });
}
async function handleFlight(supabase, userId, authHeader, body) {
  const trip_id = body.trip_id;
  const flight_number = body.flight_number;
  if (!flight_number) return json({
    error: 'flight_number is required'
  }, 400);
  const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const { data: recent } = await supabase.from('flight_disruptions').select('*').eq('user_id', userId).eq('flight_number', flight_number).eq('resolved', false).gte('detected_at', thirtyMinAgo).maybeSingle();
  if (recent) return json({
    available: true,
    disruption: recent,
    cached: true
  });
  const fl = await callProvider(`/flight?ident=${encodeURIComponent(flight_number)}${body.scheduled_out ? `&scheduledOut=${encodeURIComponent(String(body.scheduled_out))}` : ''}`, authHeader);
  if (fl.status !== 'ok' || !fl.data) {
    // Today this is the normal path: FLIGHTAWARE_API_KEY is not configured, so
    // the adapter returns `unavailable`. Nothing is written and nothing is
    // claimed. Previously this branch invented a delay or a cancellation.
    return json(unavailable('disruption', fl.safeFailureMessage ?? 'no flight data provider configured', fl.provenance?.provider ?? 'flightaware'));
  }
  const f = fl.data;
  const delayMinutes = computeDelayMinutes(f);
  const cancelled = f.status === 'cancelled';
  const disruptionType = cancelled ? 'cancellation' : delayMinutes && delayMinutes > 0 ? 'delay' : 'on_time';
  const severity = cancelled ? 'critical' : (delayMinutes ?? 0) > 60 ? 'high' : (delayMinutes ?? 0) > 0 ? 'medium' : 'low';
  const insert = {
    user_id: userId,
    trip_id: trip_id ?? null,
    flight_number,
    disruption_type: disruptionType,
    estimated_delay_minutes: delayMinutes,
    new_departure_time: f.estimatedOut ?? null,
    new_arrival_time: f.estimatedIn ?? null,
    severity,
    detected_at: new Date().toISOString()
  };
  const { data: inserted, error: insertErr } = await supabase.from('flight_disruptions').insert(insert).select().single();
  if (insertErr) console.error('[travel-intelligence] flight_disruptions insert failed:', insertErr.message);
  return json({
    available: true,
    disruption: inserted ?? insert,
    raw: f,
    provenance: fl.provenance ?? {
      provider: 'flightaware'
    }
  });
}
function computeDelayMinutes(f) {
  if (!f.scheduledOut) return null;
  const actual = f.actualOut ?? f.estimatedOut;
  if (!actual) return null;
  const diff = (new Date(actual).getTime() - new Date(f.scheduledOut).getTime()) / 60000;
  if (!isFinite(diff)) return null;
  return Math.round(diff);
}
// ── get_traffic ─────────────────────────────────────────────────────────────
function handleTraffic() {
  // There is no usable traffic provider in this project, so this route reports
  // that instead of inventing congestion. It used to return a full congestion
  // model — distance, normal vs estimated duration, a severity and a
  // "leave 25 minutes early" recommendation — computed entirely from
  // `hash(from + to)`, and persist it to `traffic_updates`.
  //
  // Mapbox IS configured and its `driving-traffic` profile would give a real
  // answer, but provider-adapters caches every directions response for 7 days
  // (604800s TTL, shared across profiles). Week-old traffic is not traffic.
  // Wiring this up means giving that adapter a profile-aware TTL first —
  // roughly 120s for `driving-traffic` — which is a change to
  // provider-adapters, not to this function. Until then: unavailable.
  return json(unavailable('traffic', 'no live traffic provider configured', 'mapbox'));
}
// ── get_trip_intelligence ───────────────────────────────────────────────────
async function handleTripIntelligence(supabase, userId, authHeader, body) {
  const trip_id = body.trip_id;
  if (!trip_id) return json({
    error: 'trip_id is required'
  }, 400);
  const { data: reservations } = await supabase.from('booking_reservations').select('*').eq('trip_id', trip_id).eq('user_id', userId);
  const weather_alerts = [];
  const flight_alerts = [];
  const traffic_alerts = [];
  // Every capability that could not be consulted is named, so the caller can
  // tell "nothing is wrong" apart from "nothing could be checked." Conflating
  // those two is what the mocks did.
  const unavailableProviders = [];
  const seenLocations = new Set();
  for (const r of reservations ?? []){
    const loc = r.location;
    if (loc && !seenLocations.has(loc)) {
      seenLocations.add(loc);
      const point = await geocode(loc, authHeader);
      if (!point) {
        unavailableProviders.push({
          capability: `weather:${loc}`,
          reason: 'location could not be geocoded'
        });
      } else {
        const wx = await callProvider(`/weather?lat=${point.lat}&lon=${point.lon}`, authHeader);
        if (wx.status !== 'ok' || !wx.data) {
          unavailableProviders.push({
            capability: `weather:${loc}`,
            reason: wx.safeFailureMessage ?? 'weather provider unavailable'
          });
        } else {
          const day = (wx.data.daily ?? [])[0] ?? null;
          if (day) {
            const windKph = peakWindKph(wx.data, day.date);
            const risks = analyzeRisks({
              windKph,
              precipProb: day.precipProb ?? null,
              code: day.code ?? null
            });
            if (risks.length > 0) {
              weather_alerts.push({
                location: loc,
                resolvedLocation: point.placeName ?? null,
                forecast_date: day.date,
                condition: wmoCondition(day.code),
                temperature: day.maxC ?? null,
                wind_speed: windKph,
                precipitationProbability: day.precipProb ?? null,
                risks,
                severity: risks.some((x)=>x.severity >= 4) ? 'critical' : 'high',
                data_source: 'open-meteo'
              });
            }
          }
        }
      }
    }
    if (r.type === 'flight' && r.name) {
      const ident = String(r.name).match(/[A-Z]{2}\d+/)?.[0];
      if (ident) {
        const fl = await callProvider(`/flight?ident=${encodeURIComponent(ident)}`, authHeader);
        if (fl.status !== 'ok' || !fl.data) {
          unavailableProviders.push({
            capability: `flight:${ident}`,
            reason: fl.safeFailureMessage ?? 'no flight data provider configured'
          });
        } else {
          const delay = computeDelayMinutes(fl.data);
          const cancelled = fl.data.status === 'cancelled';
          if (cancelled || (delay ?? 0) > 0) {
            flight_alerts.push({
              flight_number: ident,
              disruption_type: cancelled ? 'cancellation' : 'delay',
              estimated_delay_minutes: delay,
              severity: cancelled ? 'critical' : (delay ?? 0) > 60 ? 'high' : 'medium',
              data_source: 'flightaware'
            });
          }
        }
      }
    }
  }
  unavailableProviders.push({
    capability: 'traffic',
    reason: 'no live traffic provider configured'
  });
  const all = [
    ...weather_alerts,
    ...flight_alerts,
    ...traffic_alerts
  ];
  return json({
    weather_alerts,
    traffic_alerts,
    flight_alerts,
    unavailable: unavailableProviders,
    summary: {
      total_alerts: all.length,
      critical_count: all.filter((a)=>a.severity === 'critical').length,
      high_count: all.filter((a)=>a.severity === 'high').length,
      capabilities_unavailable: unavailableProviders.length
    }
  });
}
// ── get_disruptions ─────────────────────────────────────────────────────────
async function handleDisruptions(supabase, userId, body) {
  const trip_id = body.trip_id;
  if (!trip_id) return json({
    error: 'trip_id is required'
  }, 400);
  const [weatherRes, flightsRes, trafficRes] = await Promise.all([
    supabase.from('weather_forecasts').select('*').eq('user_id', userId).eq('trip_id', trip_id),
    supabase.from('flight_disruptions').select('*').eq('user_id', userId).eq('trip_id', trip_id).eq('resolved', false),
    supabase.from('traffic_updates').select('*').eq('user_id', userId).eq('trip_id', trip_id).neq('severity', 'low')
  ]);
  if (weatherRes.error) console.error('[travel-intelligence] weather_forecasts read failed:', weatherRes.error.message);
  if (flightsRes.error) console.error('[travel-intelligence] flight_disruptions read failed:', flightsRes.error.message);
  if (trafficRes.error) console.error('[travel-intelligence] traffic_updates read failed:', trafficRes.error.message);
  return json({
    weather: weatherRes.data ?? [],
    flights: flightsRes.data ?? [],
    traffic: trafficRes.data ?? []
  });
}

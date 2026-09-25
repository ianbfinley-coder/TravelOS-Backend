import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
// ---------------------------------------------------------------------------
// Env / config
// ---------------------------------------------------------------------------
/** Env reads are trimmed: a stray space or newline from a copy-paste otherwise
 *  reaches an HTTP header or query string and fails in ways that look like a
 *  bad key. Found live on FLIGHTAWARE_API_KEY, 2026-09-17. */ function env(name) {
  const v = Deno.env.get(name)?.trim();
  return v ? v : undefined;
}
const SUPABASE_URL = env('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = env('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const PROVIDERS_MODE = env('PROVIDERS_MODE') ?? 'live';
// FIX 2026-09-19 (1) — the old gate was
//   if (PROVIDERS_MODE === 'mock' && NODE_ENV === 'production') throw ...
// with NODE_ENV defaulting to 'development'. Supabase Edge does not populate
// NODE_ENV, so the gate never fired on this hosted project and a single secret
// (PROVIDERS_MODE=mock) would have made every adapter in the fleet serve
// fixtures stamped status 'ok'.
//
// Mocks are now gated on something that cannot be flipped by a secret: whether
// this is a hosted Supabase deployment. A hosted project's SUPABASE_URL is
// https://<ref>.supabase.co; the local CLI stack serves http://localhost:54321,
// http://127.0.0.1:54321 or http://kong:8000. SUPABASE_URL is injected by the
// platform, and a value that did not point at this project would break the
// database client on the line below long before it could enable a fixture.
const IS_HOSTED_DEPLOYMENT = /^https:\/\/[a-z0-9-]+\.supabase\.(co|in)(\/|$)/i.test(SUPABASE_URL);
// Fixtures are reachable ONLY when PROVIDERS_MODE=mock AND this is not a hosted
// deployment. There is deliberately no per-provider override any more: the old
// isMock('OPEN_METEO_MODE') form was a second, quieter door into the same
// behaviour.
const MOCKS_ENABLED = PROVIDERS_MODE === 'mock' && !IS_HOSTED_DEPLOYMENT;
if (PROVIDERS_MODE === 'mock' && IS_HOSTED_DEPLOYMENT) {
  // Loud, but not fatal. Throwing here would take down the fleet's only
  // provider gateway; ignoring the flag and calling the real providers is the
  // correct behaviour, so that is what happens.
  console.error('[provider-adapters] PROVIDERS_MODE=mock IGNORED: this is a hosted deployment. ' + 'Fixtures are disabled and every adapter will call its real provider.');
}
const isMock = ()=>MOCKS_ENABLED;
/** The ONLY way a fixture may leave this function. Never status 'ok'. */ function mockResult(provider, data, attribution) {
  return {
    data,
    status: 'mock',
    provenance: {
      provider,
      fetchedAt: new Date().toISOString(),
      cacheHit: false,
      attribution,
      stale: false,
      mock: true
    },
    safeFailureMessage: 'FIXTURE — this is not real provider data. PROVIDERS_MODE=mock is set on a ' + 'non-hosted deployment. Do not display or act on this value.'
  };
}
// ---------------------------------------------------------------------------
// Supabase client (service role)
// ---------------------------------------------------------------------------
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};
function corsResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json'
    }
  });
}
// CONFIG 2026-09-17 — Mapbox credentials were being read from two different
// env var names in this file: MAPBOX_ACCESS_TOKEN (geocode, reverse-geocode,
// directions, matrix adapters) and MAPBOX_API_KEY (the legacy /geocode
// adapter). That collision would require the owner to set the same secret
// twice under two names, and any drift between them would silently break
// one code path. MAPBOX_TOKEN below resolves either name, preferring the
// canonical MAPBOX_ACCESS_TOKEN, so a single secret configures every Mapbox
// adapter. Nothing else about auth, response shape, or providers changes.
//
// Also: several adapters (OpenAQ air-quality, the legacy TripAdvisor places
// search, Google Places nearby-v1, FlightAware flight-status, and the legacy
// Ticketmaster /events route) parsed the upstream response body without
// checking res.ok first. An upstream auth rejection — a JSON error body with
// no results/data/places/flights/events array — was indistinguishable from a
// genuine empty result, so it was reported back as status 'ok'. Each of
// those adapters now checks res.ok before parsing and, on a non-OK response,
// fails through the same path used elsewhere for an upstream rejection
// (logged via console.error and reported as status 'unavailable'), instead
// of being reported as success. Separately, the dedicated /mapbox/* routes
// and /ticketmaster/events did not set safeFailureMessage on their
// not-configured (missing credential) path, so a missing key and a rejected
// key produced byte-identical responses. Those routes now set
// safeFailureMessage naming the missing env var when the credential is
// absent, and leave it unset when the credential is present but the call
// fails, so safeFailureMessage now reliably distinguishes "not configured"
// from "configured but failing".
//
// Also: a live probe on FLIGHTAWARE_API_KEY found it configured with trailing
// whitespace (33 chars instead of 32), which reaches the x-apikey header as-is
// and fails upstream in a way that looks identical to a bad key. Every env
// read in this file — every provider credential and the non-secret config
// values above — now goes through env(), which trims the value and reports a
// whitespace-only secret as not configured (undefined) rather than present.
const MAPBOX_TOKEN = env('MAPBOX_ACCESS_TOKEN') ?? env('MAPBOX_API_KEY');
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function roundTo2(n) {
  return Math.round(n * 100) / 100;
}
function roundTo4(n) {
  return Math.round(n * 10000) / 10000;
}
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function sevenDaysAgo() {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d.toISOString().split('T')[0];
}
// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------
async function cacheGet(key) {
  const { data, error } = await supabase.from('provider_cache').select('payload, expires_at, fetched_at').eq('key', key).maybeSingle();
  if (error || !data) return null;
  return {
    payload: data.payload,
    expiresAt: new Date(data.expires_at),
    fetchedAt: new Date(data.fetched_at)
  };
}
async function cacheSet(key, provider, payload, ttlSeconds) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
  await supabase.from('provider_cache').upsert({
    key,
    provider,
    payload,
    fetched_at: now.toISOString(),
    expires_at: expiresAt.toISOString()
  });
}
// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------
const FAILURE_THRESHOLD = 5;
const HALF_OPEN_AFTER_MS = 60_000;
const CLOSE_AFTER_SUCCESSES = 2;
async function circuitGet(provider) {
  const { data } = await supabase.from('provider_circuit').select('*').eq('provider', provider).maybeSingle();
  if (!data) {
    return {
      state: 'closed',
      consecutive_failures: 0,
      opened_at: null,
      last_success_at: null,
      last_error: null,
      updated_at: new Date().toISOString()
    };
  }
  if (data.state === 'open' && data.opened_at) {
    const openedMs = new Date(data.opened_at).getTime();
    if (Date.now() - openedMs > HALF_OPEN_AFTER_MS) {
      await supabase.from('provider_circuit').upsert({
        provider,
        state: 'half-open',
        updated_at: new Date().toISOString()
      });
      return {
        ...data,
        state: 'half-open'
      };
    }
  }
  return data;
}
async function circuitRecordSuccess(provider) {
  const row = await circuitGet(provider);
  const newFailures = 0;
  let newState = 'closed';
  if (row.state === 'half-open') {
    newState = 'closed';
  }
  await supabase.from('provider_circuit').upsert({
    provider,
    state: newState,
    consecutive_failures: newFailures,
    last_success_at: new Date().toISOString(),
    last_error: null,
    updated_at: new Date().toISOString()
  });
  console.log('[provider-adapters] circuit closed for', provider);
}
async function circuitRecordFailure(provider, error) {
  const row = await circuitGet(provider);
  const newFailures = row.consecutive_failures + 1;
  const shouldOpen = newFailures >= FAILURE_THRESHOLD;
  const newState = shouldOpen ? 'open' : row.state === 'half-open' ? 'open' : 'closed';
  await supabase.from('provider_circuit').upsert({
    provider,
    state: newState,
    consecutive_failures: newFailures,
    opened_at: shouldOpen ? new Date().toISOString() : row.opened_at,
    last_error: error,
    updated_at: new Date().toISOString()
  });
  if (shouldOpen) console.log('[provider-adapters] circuit OPENED for', provider, 'after', newFailures, 'failures');
}
// ---------------------------------------------------------------------------
// Quota
// ---------------------------------------------------------------------------
const DAILY_QUOTAS = {
  'google-places': 1000,
  'tripadvisor': 500,
  'flightaware': 500,
  'ticketmaster': 5000,
  'openaq': 2000,
  'mapbox': 100000
};
async function quotaCheck(provider) {
  const limit = DAILY_QUOTAS[provider] ?? Infinity;
  if (!isFinite(limit)) return {
    allowed: true,
    used: 0,
    limit: Infinity
  };
  const today = new Date().toISOString().split('T')[0];
  const { data } = await supabase.from('provider_quota').select('request_count').eq('provider', provider).eq('date', today).maybeSingle();
  const used = data?.request_count ?? 0;
  if (used >= limit) return {
    allowed: false,
    used,
    limit
  };
  if (used >= limit * 0.8) console.log('[provider-adapters] quota WARNING', provider, `${used}/${limit}`);
  return {
    allowed: true,
    used,
    limit
  };
}
// SECURITY/AVAILABILITY 2026-09-17 — total provider outage fixed here.
//
// This function previously read:
//
//   await supabase.rpc('increment_provider_quota', {...}).catch(() => {...});
//
// Three defects, compounding:
//
//  1) `supabase.rpc(...)` returns a PostgrestFilterBuilder. It is *thenable*
//     (it has .then, so `await` works) but it is NOT a Promise and has no
//     .catch method. Calling `.catch(...)` on it threw
//     `TypeError: supabase.rpc(...).catch is not a function` — synchronously,
//     on every single invocation. quotaIncrement() is the FIRST statement in
//     the try block of the fetch path, so `fetcher()` was never reached.
//     Every provider — including the keyless ones (open-meteo, ECB, USGS,
//     weather.gov, GDACS) — returned status:'unavailable' with HTTP 200.
//     No adapter in this function had ever performed a live upstream call.
//     The 'unavailable' result masked it as a provider/key problem.
//
//  2) The RPC `increment_provider_quota` does not exist in this database, so
//     even a correctly-awaited call would have returned an error object.
//
//  3) The fallback upsert wrote columns `requests_used` and `last_request_at`.
//     public.provider_quota has exactly (provider, date, request_count).
//     quotaCheck() read `requests_used` too, so the quota read silently
//     errored and `used` was always 0 — quota enforcement was dead as well.
//
// Rewritten to await the read/write properly against the real columns, and to
// swallow its own failures. Quota accounting is bookkeeping; it must never be
// able to take down the provider call it is counting. That containment is the
// reason this bug was a total outage rather than a missing metric.
async function quotaIncrement(provider) {
  try {
    const today = new Date().toISOString().split('T')[0];
    const { data } = await supabase.from('provider_quota').select('request_count').eq('provider', provider).eq('date', today).maybeSingle();
    const next = (data?.request_count ?? 0) + 1;
    const { error } = await supabase.from('provider_quota').upsert({
      provider,
      date: today,
      request_count: next
    }, {
      onConflict: 'provider,date'
    });
    if (error) console.log('[provider-adapters] quota write failed', provider, error.message);
  } catch (e) {
    console.log('[provider-adapters] quota increment threw (ignored)', provider, e instanceof Error ? e.message : String(e));
  }
}
// ---------------------------------------------------------------------------
// Fetch with retry
// ---------------------------------------------------------------------------
async function fetchWithRetry(url, init = {}, maxRetries = 2) {
  const delays = [
    500,
    1500
  ];
  let lastError = new Error('unknown');
  for(let attempt = 0; attempt <= maxRetries; attempt++){
    const controller = new AbortController();
    const timer = setTimeout(()=>controller.abort(), 8000);
    try {
      const res = await fetch(url, {
        ...init,
        signal: controller.signal
      });
      clearTimeout(timer);
      if (res.status >= 500) {
        lastError = new Error(`HTTP ${res.status}`);
        if (attempt < maxRetries) {
          const jitter = Math.random() * 500;
          await sleep(delays[attempt] + jitter);
          continue;
        }
        throw lastError;
      }
      return res;
    } catch (e) {
      clearTimeout(timer);
      lastError = e instanceof Error ? e : new Error(String(e));
      if (attempt < maxRetries) {
        const jitter = Math.random() * 500;
        await sleep(delays[attempt] + jitter);
      }
    }
  }
  throw lastError;
}
function sleep(ms) {
  return new Promise((r)=>setTimeout(r, ms));
}
// ---------------------------------------------------------------------------
// Core provider runner
// ---------------------------------------------------------------------------
async function runProvider(provider, cacheKey, ttlSeconds, maxStaleSeconds, fetcher, attribution, safeFailureMessage, officialUrl) {
  const now = new Date();
  const cached = await cacheGet(cacheKey);
  if (cached) {
    const fresh = cached.expiresAt > now;
    const staleWindow = new Date(cached.expiresAt.getTime() + maxStaleSeconds * 1000);
    const withinStale = staleWindow > now;
    if (fresh) {
      console.log('[provider-adapters] cache HIT', cacheKey);
      return {
        data: cached.payload,
        status: 'ok',
        provenance: {
          provider,
          fetchedAt: cached.fetchedAt.toISOString(),
          cacheHit: true,
          attribution,
          stale: false
        }
      };
    }
    const circuit = await circuitGet(provider);
    const quota = await quotaCheck(provider);
    if (circuit.state === 'open' || !quota.allowed) {
      if (withinStale) {
        console.log('[provider-adapters] serving STALE', cacheKey, 'circuit:', circuit.state);
        return {
          data: cached.payload,
          status: 'stale',
          provenance: {
            provider,
            fetchedAt: cached.fetchedAt.toISOString(),
            cacheHit: true,
            attribution,
            stale: true
          }
        };
      }
      return unavailableResult(provider, attribution, safeFailureMessage, officialUrl);
    }
  }
  const circuit = await circuitGet(provider);
  if (circuit.state === 'open') {
    console.log('[provider-adapters] circuit OPEN, no cache for', provider);
    return unavailableResult(provider, attribution, safeFailureMessage, officialUrl);
  }
  const quota = await quotaCheck(provider);
  if (!quota.allowed) {
    console.log('[provider-adapters] quota EXHAUSTED for', provider);
    return unavailableResult(provider, attribution, safeFailureMessage, officialUrl);
  }
  try {
    await quotaIncrement(provider);
    const data = await fetcher();
    if (data === null || data === undefined) throw new Error('empty response');
    await cacheSet(cacheKey, provider, data, ttlSeconds);
    await circuitRecordSuccess(provider);
    console.log('[provider-adapters] cache MISS fetched', cacheKey);
    return {
      data,
      status: 'ok',
      provenance: {
        provider,
        fetchedAt: now.toISOString(),
        cacheHit: false,
        attribution,
        stale: false
      }
    };
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    await circuitRecordFailure(provider, errMsg);
    console.log('[provider-adapters] fetch FAILED', provider, errMsg);
    if (cached) {
      const staleWindow = new Date(cached.expiresAt.getTime() + maxStaleSeconds * 1000);
      if (staleWindow > now) {
        return {
          data: cached.payload,
          status: 'stale',
          provenance: {
            provider,
            fetchedAt: cached.fetchedAt.toISOString(),
            cacheHit: true,
            attribution,
            stale: true
          }
        };
      }
    }
    return unavailableResult(provider, attribution, safeFailureMessage, officialUrl);
  }
}
function unavailableResult(provider, attribution, safeFailureMessage, officialUrl) {
  return {
    data: null,
    status: 'unavailable',
    provenance: {
      provider,
      fetchedAt: new Date().toISOString(),
      cacheHit: false,
      attribution,
      stale: false
    },
    ...safeFailureMessage ? {
      safeFailureMessage
    } : {},
    ...officialUrl ? {
      officialUrl
    } : {}
  };
}
// ---------------------------------------------------------------------------
// Mock fixtures
// ---------------------------------------------------------------------------
function mockWeather(_lat, _lon) {
  return {
    timezone: 'Europe/Paris',
    hourly: Array.from({
      length: 24
    }, (_, i)=>({
        at: new Date(Date.now() + i * 3600_000).toISOString(),
        tempC: 22 + Math.sin(i / 4) * 3,
        precipProb: 10,
        code: 1,
        windKph: 15
      })),
    daily: Array.from({
      length: 7
    }, (_, i)=>{
      const d = new Date();
      d.setDate(d.getDate() + i);
      return {
        date: d.toISOString().split('T')[0],
        maxC: 24,
        minC: 16,
        precipProb: 10,
        sunrise: '06:30',
        sunset: '20:45',
        code: 1
      };
    })
  };
}
function mockWeatherAlerts() {
  return {
    alerts: []
  };
}
function mockEarthquakes() {
  return {
    earthquakes: []
  };
}
function mockDisasters() {
  return {
    disasters: []
  };
}
function mockAdvisoryUS(iso2) {
  return {
    country: iso2 === 'FR' ? 'France' : iso2,
    iso2,
    source: 'US',
    level: 1,
    summary: 'Exercise normal precautions.',
    url: 'https://travel.state.gov',
    updatedAt: new Date().toISOString()
  };
}
function mockAdvisoryUK(countrySlug) {
  return {
    country: countrySlug,
    iso2: 'XX',
    source: 'UK',
    level: 1,
    summary: 'See our travel advice before travelling.',
    url: `https://www.gov.uk/foreign-travel-advice/${countrySlug}`,
    updatedAt: new Date().toISOString()
  };
}
function mockDiseaseOutbreaks() {
  return {
    outbreaks: []
  };
}
function mockAirQuality() {
  return {
    aqi: 42,
    category: 'good',
    pm25: 8,
    pm10: 15,
    station: 'Mock Station',
    measuredAt: new Date().toISOString()
  };
}
function mockPlaces() {
  return {
    places: [
      {
        id: 'mock-1',
        source: 'google',
        name: 'Eiffel Tower',
        lat: 48.8584,
        lng: 2.2945,
        rating: 4.7,
        reviewCount: 120000,
        types: [
          'tourist_attraction'
        ],
        websiteUrl: 'https://www.toureiffel.paris'
      },
      {
        id: 'mock-2',
        source: 'google',
        name: 'Louvre Museum',
        lat: 48.8606,
        lng: 2.3376,
        rating: 4.7,
        reviewCount: 200000,
        types: [
          'museum'
        ],
        websiteUrl: 'https://www.louvre.fr'
      }
    ]
  };
}
function mockFlight(ident) {
  return {
    ident: ident || 'AA100',
    scheduledOut: new Date(Date.now() + 3600_000).toISOString(),
    scheduledIn: new Date(Date.now() + 10 * 3600_000).toISOString(),
    status: 'scheduled',
    gateOrigin: 'B22',
    gateDestination: 'C14'
  };
}
function mockGeocode(q) {
  return {
    lat: 48.8566,
    lon: 2.3522,
    placeName: q || 'Paris, France',
    iso2: 'FR'
  };
}
function mockFxRates() {
  return {
    base: 'EUR',
    date: new Date().toISOString().split('T')[0],
    rates: {
      USD: 1.08,
      GBP: 0.86,
      JPY: 162.5,
      CAD: 1.47,
      AUD: 1.65,
      CHF: 0.97,
      CNY: 7.82
    }
  };
}
function mockEvents() {
  return {
    events: [
      {
        id: 'mock-evt-1',
        name: 'Jazz Festival',
        date: new Date(Date.now() + 86400_000).toISOString(),
        venue: 'City Park',
        category: 'Music',
        url: 'https://ticketmaster.com',
        priceMin: 25,
        priceMax: 80,
        currency: 'USD'
      }
    ]
  };
}
function mockLodging() {
  return {
    properties: [
      {
        id: 'mock-lodge-1',
        name: 'Grand Hotel Paris',
        lat: 48.8566,
        lng: 2.3522,
        pricePerNight: 189,
        currency: 'EUR',
        rating: 4.5,
        reviewCount: 3200,
        type: 'hotel'
      },
      {
        id: 'mock-lodge-2',
        name: 'Boutique Marais',
        lat: 48.8603,
        lng: 2.3601,
        pricePerNight: 145,
        currency: 'EUR',
        rating: 4.3,
        reviewCount: 890,
        type: 'boutique'
      },
      {
        id: 'mock-lodge-3',
        name: 'Budget Inn Montmartre',
        lat: 48.8867,
        lng: 2.3431,
        pricePerNight: 79,
        currency: 'EUR',
        rating: 3.9,
        reviewCount: 450,
        type: 'budget'
      }
    ],
    note: 'Real rates require a partner API agreement. Airbnb rates are not available.'
  };
}
function mockTripAdvisorLocations() {
  return {
    data: [
      {
        location_id: 'mock-ta-1',
        name: 'Eiffel Tower',
        address_obj: {
          city: 'Paris',
          country: 'France'
        },
        rating: 4.7,
        num_reviews: 85000,
        category: {
          name: 'Attraction'
        },
        web_url: 'https://www.tripadvisor.com/Attraction_Review-g187147-d188151'
      },
      {
        location_id: 'mock-ta-2',
        name: 'Louvre Museum',
        address_obj: {
          city: 'Paris',
          country: 'France'
        },
        rating: 4.6,
        num_reviews: 120000,
        category: {
          name: 'Museum'
        },
        web_url: 'https://www.tripadvisor.com/Attraction_Review-g187147-d188150'
      }
    ]
  };
}
function mockTripAdvisorDetails(locationId) {
  return {
    location_id: locationId,
    name: 'Mock Location',
    address_obj: {
      street1: '1 Example St',
      city: 'Paris',
      country: 'France'
    },
    rating: 4.5,
    num_reviews: 1000,
    category: {
      name: 'Attraction'
    },
    web_url: `https://www.tripadvisor.com/Attraction_Review-${locationId}`
  };
}
function mockTripAdvisorReviews(locationId) {
  return {
    data: [
      {
        id: `${locationId}-rev-1`,
        lang: 'en',
        rating: 5,
        title: 'Amazing experience',
        text: 'Absolutely loved it!',
        published_date: new Date().toISOString(),
        user: {
          username: 'traveler123'
        }
      },
      {
        id: `${locationId}-rev-2`,
        lang: 'en',
        rating: 4,
        title: 'Great visit',
        text: 'Well worth the trip.',
        published_date: new Date().toISOString(),
        user: {
          username: 'explorer456'
        }
      }
    ]
  };
}
function mockTicketmasterEvents() {
  return {
    _embedded: {
      events: [
        {
          id: 'mock-tm-evt-1',
          name: 'Mock Concert',
          dates: {
            start: {
              dateTime: new Date(Date.now() + 86400_000).toISOString()
            }
          },
          _embedded: {
            venues: [
              {
                name: 'Mock Arena'
              }
            ]
          },
          classifications: [
            {
              segment: {
                name: 'Music'
              }
            }
          ],
          url: 'https://www.ticketmaster.com',
          priceRanges: [
            {
              min: 30,
              max: 120,
              currency: 'USD'
            }
          ]
        }
      ]
    }
  };
}
function mockTicketmasterEvent(eventId) {
  return {
    id: eventId,
    name: 'Mock Event',
    dates: {
      start: {
        dateTime: new Date(Date.now() + 86400_000).toISOString()
      }
    },
    _embedded: {
      venues: [
        {
          name: 'Mock Venue'
        }
      ]
    },
    url: 'https://www.ticketmaster.com'
  };
}
function mockTicketmasterVenue(venueId) {
  return {
    id: venueId,
    name: 'Mock Venue',
    city: {
      name: 'New York'
    },
    country: {
      name: 'United States',
      countryCode: 'US'
    },
    address: {
      line1: '123 Main St'
    },
    location: {
      latitude: '40.7128',
      longitude: '-74.0060'
    }
  };
}
function mockTicketmasterAttraction(attractionId) {
  return {
    id: attractionId,
    name: 'Mock Artist',
    classifications: [
      {
        segment: {
          name: 'Music'
        },
        genre: {
          name: 'Rock'
        }
      }
    ],
    url: 'https://www.ticketmaster.com'
  };
}
function mockMapboxGeocode(query) {
  return {
    type: 'FeatureCollection',
    features: [
      {
        id: 'place.mock',
        type: 'Feature',
        place_type: [
          'place'
        ],
        relevance: 1,
        properties: {},
        text: query,
        place_name: `${query}, France`,
        center: [
          2.3522,
          48.8566
        ],
        geometry: {
          type: 'Point',
          coordinates: [
            2.3522,
            48.8566
          ]
        },
        context: [
          {
            id: 'country.FR',
            short_code: 'fr',
            text: 'France'
          }
        ]
      }
    ]
  };
}
function mockMapboxReverseGeocode(lat, lng) {
  return {
    type: 'FeatureCollection',
    features: [
      {
        id: 'address.mock',
        type: 'Feature',
        place_type: [
          'address'
        ],
        relevance: 1,
        properties: {},
        text: 'Mock Street',
        place_name: `Mock Address, ${lat.toFixed(4)}, ${lng.toFixed(4)}`,
        center: [
          lng,
          lat
        ],
        geometry: {
          type: 'Point',
          coordinates: [
            lng,
            lat
          ]
        },
        context: []
      }
    ]
  };
}
function mockMapboxDirections(profile) {
  return {
    routes: [
      {
        distance: 5200,
        duration: 720,
        geometry: {
          type: 'LineString',
          coordinates: [
            [
              2.3522,
              48.8566
            ],
            [
              2.2945,
              48.8584
            ]
          ]
        },
        legs: [
          {
            distance: 5200,
            duration: 720,
            steps: [],
            summary: `Mock ${profile} route`
          }
        ],
        weight_name: 'routability',
        weight: 720
      }
    ],
    waypoints: [
      {
        name: 'Origin',
        location: [
          2.3522,
          48.8566
        ]
      },
      {
        name: 'Destination',
        location: [
          2.2945,
          48.8584
        ]
      }
    ],
    code: 'Ok',
    uuid: 'mock-uuid'
  };
}
function mockMapboxMatrix(_profile) {
  return {
    code: 'Ok',
    durations: [
      [
        0,
        720
      ],
      [
        680,
        0
      ]
    ],
    distances: [
      [
        0,
        5200
      ],
      [
        5100,
        0
      ]
    ],
    destinations: [
      {
        name: 'Origin',
        location: [
          2.3522,
          48.8566
        ]
      },
      {
        name: 'Destination',
        location: [
          2.2945,
          48.8584
        ]
      }
    ],
    sources: [
      {
        name: 'Origin',
        location: [
          2.3522,
          48.8566
        ]
      },
      {
        name: 'Destination',
        location: [
          2.2945,
          48.8584
        ]
      }
    ]
  };
}
// ---------------------------------------------------------------------------
// Mock fixtures — Google Places (new)
// ---------------------------------------------------------------------------
function mockGooglePlacesSearch() {
  return {
    results: [
      {
        place_id: 'mock_place_1',
        name: 'Mock Café',
        formatted_address: '1 Main St',
        geometry: {
          location: {
            lat: 40.7128,
            lng: -74.006
          }
        },
        rating: 4.5,
        user_ratings_total: 120,
        types: [
          'cafe',
          'food'
        ]
      }
    ],
    status: 'OK'
  };
}
function mockGooglePlacesDetails() {
  return {
    result: {
      place_id: 'mock_place_1',
      name: 'Mock Café',
      formatted_address: '1 Main St',
      geometry: {
        location: {
          lat: 40.7128,
          lng: -74.006
        }
      },
      rating: 4.5,
      opening_hours: {
        open_now: true,
        weekday_text: []
      },
      formatted_phone_number: '+1 555-0100',
      website: 'https://example.com',
      types: [
        'cafe'
      ]
    },
    status: 'OK'
  };
}
function mockGooglePlacesAutocomplete() {
  return {
    predictions: [
      {
        place_id: 'mock_place_1',
        description: 'Mock Café, New York, NY, USA',
        structured_formatting: {
          main_text: 'Mock Café',
          secondary_text: 'New York, NY, USA'
        }
      }
    ],
    status: 'OK'
  };
}
// ---------------------------------------------------------------------------
// Monitoring: fire-and-forget log-call
// ---------------------------------------------------------------------------
// FIX 2026-09-19 (2) — monitoring-api resolves the key it expects as
//   const SERVICE_KEY = Deno.env.get('SERVICE_KEY') ?? SUPABASE_SERVICE_ROLE_KEY;
// and compares `req.headers.get('x-service-key') === SERVICE_KEY` with a strict
// equality. It does NOT trim. This file's env() helper does trim, so resolving
// the key through env() here could produce a value that differs by a byte from
// the one monitoring-api computed from the same secret and fail the comparison.
// This read is therefore deliberately raw, mirroring monitoring-api exactly.
const MONITORING_SERVICE_KEY = Deno.env.get('SERVICE_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const MONITORING_LOG_CALL_URL = 'https://cyrgzvnjvevwbjqxgfxd.supabase.co/functions/v1/monitoring-api/api-opt/log-call';
/** monitoring-api's handleLogCall requires a NUMERIC responseStatus and 400s
 *  with MISSING_PARAM without one; it treats 2xx as a success (resetting
 *  api_service_health.consecutive_failures) and >=500 or errorKind 'timeout' as
 *  a failure. The old body sent this function's string status, which would have
 *  been rejected even if the auth had been right. */ function monitoringResponseStatus(status) {
  if (status === 'ok') return 200;
  // Served from cache because the provider could not be reached: answered, but
  // not authoritative. 2xx so it is not counted as an upstream failure.
  if (status === 'stale') return 203;
  return 503;
}
async function postMonitoringCall(opts) {
  if (!MONITORING_SERVICE_KEY) {
    console.error('[provider-adapters] monitoring log-call skipped: no SERVICE_KEY / SUPABASE_SERVICE_ROLE_KEY');
    return;
  }
  // A cache hit and a failed call are not billable, so do not report a cost for
  // them — otherwise the cost ledger inflates with calls that never happened.
  const billable = opts.status === 'ok' && !opts.cacheHit;
  const body = {
    service: opts.service,
    endpoint: opts.endpoint,
    responseStatus: monitoringResponseStatus(opts.status),
    cacheHit: opts.cacheHit,
    durationMs: Math.max(0, Math.round(opts.durationMs)),
    costUsd: billable ? opts.costUsd : 0,
    ...opts.status === 'ok' ? {} : {
      errorKind: opts.status
    }
  };
  try {
    const res = await fetch(MONITORING_LOG_CALL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // checkApiOptAuth accepts x-service-key OR an Authorization bearer that
        // resolves to a user. A service-role JWT is not a user, which is why the
        // old Authorization-only call got a 401 on every single request.
        'x-service-key': MONITORING_SERVICE_KEY
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      // A non-2xx is a FULFILLED fetch, so the old .catch() could never see it.
      // This is the line that would have surfaced the 401 four months ago.
      const text = await res.text().catch(()=>'<unreadable body>');
      console.error('[provider-adapters] monitoring log-call failed:', res.status, opts.service + '/' + opts.endpoint, text.slice(0, 500));
    }
  } catch (e) {
    console.error('[provider-adapters] monitoring log-call threw:', opts.service + '/' + opts.endpoint, e instanceof Error ? e.message : String(e));
  }
}
function logMonitoringCall(opts) {
  // A fixture is not a provider call and must not enter the cost ledger.
  if (opts.status === 'mock') return;
  const pending = postMonitoringCall(opts);
  const rt = globalThis.EdgeRuntime;
  if (rt && typeof rt.waitUntil === 'function') {
    // Keeps the POST off the response path while guaranteeing the isolate stays
    // alive until it completes — previously the isolate could be torn down
    // mid-flight and the log silently lost even once auth was fixed.
    rt.waitUntil(pending);
  } else {
    pending.catch(()=>{});
  }
}
// ---------------------------------------------------------------------------
// Adapter: WeatherForecast
// ---------------------------------------------------------------------------
async function adapterWeather(lat, lon) {
  if (isMock()) return mockResult('open-meteo', mockWeather(lat, lon), 'Weather data by Open-Meteo.com');
  const cacheKey = `weather:${roundTo2(lat)}:${roundTo2(lon)}`;
  return runProvider('open-meteo', cacheKey, 3600, 7200, async ()=>{
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,precipitation_probability,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset&timezone=auto`;
    const res = await fetchWithRetry(url);
    const json = await res.json();
    if (!json.hourly || !json.daily) throw new Error('malformed weather response');
    const hourly = json.hourly.time.map((t, i)=>({
        at: t,
        tempC: json.hourly.temperature_2m[i],
        precipProb: json.hourly.precipitation_probability[i],
        code: json.hourly.weather_code[i],
        windKph: json.hourly.wind_speed_10m[i]
      }));
    const daily = json.daily.time.map((t, i)=>({
        date: t,
        maxC: json.daily.temperature_2m_max[i],
        minC: json.daily.temperature_2m_min[i],
        precipProb: json.daily.precipitation_probability_max[i],
        sunrise: json.daily.sunrise[i],
        sunset: json.daily.sunset[i],
        code: json.daily.weather_code[i]
      }));
    return {
      hourly,
      daily,
      timezone: json.timezone
    };
  }, 'Weather data by Open-Meteo.com');
}
// ---------------------------------------------------------------------------
// Adapter: WeatherAlertsUS
// ---------------------------------------------------------------------------
async function adapterWeatherAlerts(lat, lon) {
  if (isMock()) return mockResult('weather.gov', mockWeatherAlerts());
  const cacheKey = `weather-alerts:${roundTo2(lat)}:${roundTo2(lon)}`;
  return runProvider('weather.gov', cacheKey, 600, 1800, async ()=>{
    const url = `https://api.weather.gov/alerts/active?point=${lat},${lon}`;
    const res = await fetchWithRetry(url, {
      headers: {
        'User-Agent': 'TravelOS/1.0 (contact@travelos.app)'
      }
    });
    const json = await res.json();
    const alerts = (json.features ?? []).map((f)=>{
      const p = f.properties;
      return {
        id: f.id,
        event: p.event,
        severity: p.severity,
        headline: p.headline,
        description: p.description,
        onset: p.onset,
        expires: p.expires,
        areaDesc: p.areaDesc
      };
    });
    return {
      alerts
    };
  }, undefined, 'Data unavailable — check official sources', 'https://www.weather.gov/alerts');
}
// ---------------------------------------------------------------------------
// Adapter: Earthquakes
// ---------------------------------------------------------------------------
async function adapterEarthquakes(lat, lon) {
  if (isMock()) return mockResult('usgs', mockEarthquakes());
  const cacheKey = `earthquakes:${roundTo2(lat)}:${roundTo2(lon)}`;
  return runProvider('usgs', cacheKey, 900, 3600, async ()=>{
    const url = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&latitude=${lat}&longitude=${lon}&maxradiuskm=300&minmagnitude=4.5&starttime=${sevenDaysAgo()}`;
    const res = await fetchWithRetry(url);
    const json = await res.json();
    const earthquakes = (json.features ?? []).map((f)=>{
      const p = f.properties;
      const geo = f.geometry;
      return {
        id: f.id,
        magnitude: p.mag,
        place: p.place,
        time: new Date(p.time).toISOString(),
        lat: geo.coordinates[1],
        lon: geo.coordinates[0],
        depth: geo.coordinates[2],
        url: p.url
      };
    });
    return {
      earthquakes
    };
  }, undefined, 'Data unavailable — check official sources', 'https://earthquake.usgs.gov');
}
// ---------------------------------------------------------------------------
// Adapter: GlobalDisasters (GDACS RSS)
// ---------------------------------------------------------------------------
async function adapterDisasters(lat, lon) {
  if (isMock()) return mockResult('gdacs', mockDisasters());
  const cacheKey = `disasters:global`;
  return runProvider('gdacs', cacheKey, 1800, 7200, async ()=>{
    const res = await fetchWithRetry('https://www.gdacs.org/xml/rss.xml');
    const text = await res.text();
    const items = text.match(/<item[^>]*>([\s\S]*?)<\/item>/g) ?? [];
    const disasters = [];
    for (const item of items){
      const title = (item.match(/<title><!\[CDATA\[([^\]]+)\]\]><\/title>/) ?? item.match(/<title>([^<]+)<\/title>/))?.[1] ?? '';
      const link = item.match(/<link>([^<]+)<\/link>/)?.[1] ?? '';
      const pubDate = item.match(/<pubDate>([^<]+)<\/pubDate>/)?.[1] ?? '';
      const gdacsSeverity = item.match(/<gdacs:severity[^>]*>([^<]+)<\/gdacs:severity>/)?.[1] ?? 'unknown';
      const gdacsCountry = item.match(/<gdacs:country[^>]*>([^<]+)<\/gdacs:country>/)?.[1] ?? '';
      const gdacsType = item.match(/<gdacs:eventtype[^>]*>([^<]+)<\/gdacs:eventtype>/)?.[1] ?? '';
      const gdacsLat = parseFloat(item.match(/<geo:lat>([^<]+)<\/geo:lat>/)?.[1] ?? '0');
      const gdacsLon = parseFloat(item.match(/<geo:long>([^<]+)<\/geo:long>/)?.[1] ?? '0');
      const guid = item.match(/<guid[^>]*>([^<]+)<\/guid>/)?.[1] ?? link;
      if (!isNaN(gdacsLat) && !isNaN(gdacsLon)) {
        const dist = haversineKm(lat, lon, gdacsLat, gdacsLon);
        if (dist < 500) disasters.push({
          id: guid,
          title,
          type: gdacsType,
          severity: gdacsSeverity,
          country: gdacsCountry,
          lat: gdacsLat,
          lon: gdacsLon,
          url: link,
          pubDate
        });
      }
    }
    return {
      disasters
    };
  }, undefined, 'Data unavailable — check official sources', 'https://www.gdacs.org');
}
// ---------------------------------------------------------------------------
// Adapter: TravelAdvisoryUS
// ---------------------------------------------------------------------------
// REWRITTEN 2026-09-17. The previous implementation fetched
//   https://travel.state.gov/content/dam/travelsite/json/en_US/travelwarning.json
// which no longer serves JSON — it returns an HTML page, so `res.json()` threw
// `Unexpected token '<'` and the route was permanently 'unavailable'.
//
// Current source: https://cadataapi.state.gov/api/TravelAdvisories — the Bureau
// of Consular Affairs data API. 229 records, all countries, JSON.
//
// THREE THINGS ABOUT THIS SOURCE THAT WILL BITE IF FORGOTTEN
//
// 1) `Category` is NOT ISO 3166-1 alpha-2. It is the State Department's own
//    FIPS 10-4 / GEC coding: Germany is "GM", Japan "JA", Suriname "NS",
//    the UK "UK". Matching an ISO2 against it is not merely lossy, it is
//    DANGEROUS — the code spaces collide on different countries. FIPS "AU" is
//    AUSTRIA while ISO "AU" is AUSTRALIA; FIPS "BG" is BANGLADESH while ISO
//    "BG" is BULGARIA. A naive match hands the caller another country's
//    safety advisory while looking perfectly healthy. `Category` is therefore
//    ignored entirely. Countries are resolved from the country NAME in
//    `Title`, via Intl.DisplayNames (which Deno supports with full ICU) plus a
//    small alias table for State Department naming quirks.
//
//    Raw two-letter codes are canonicalized through Intl.getCanonicalLocales
//    before their display name is taken, because deprecated aliases otherwise
//    poison the index: "DD" (East Germany) resolves to the display name
//    "Germany", and "UK" to "United Kingdom", so an alphabetical build would
//    key Germany under DD and the UK under UK instead of DE and GB.
//
// 2) The feed contains DUPLICATE and NON-COUNTRY records — two entries each for
//    Bosnia, Paraguay, the Bahamas, Malta and others, plus "West Bank" and
//    "Gaza" (both ISO PS), and rows like "French West Indies" and "Mainland
//    China, Hong Kong & Macau - See Summaries" that are not countries at all.
//    Where several records map to one ISO code, the HIGHEST severity wins,
//    tie-broken by most recently updated. For safety data, over-warning is the
//    correct failure direction. Non-country rows resolve to null and are
//    skipped rather than guessed at.
//
// 3) The API RATE LIMITS, and answers HTTP 429 with an HTML error page rather
//    than JSON. Status and content-type are both checked before parsing, so a
//    429 surfaces as a 429 instead of a JSON syntax error. The whole feed is
//    cached under ONE key and sliced per country: the old code keyed the cache
//    per ISO2, so every new country re-fetched all 728KB and walked straight
//    into the rate limiter.
const US_ADVISORY_URL = 'https://cadataapi.state.gov/api/TravelAdvisories';
// State Department country names that Intl.DisplayNames does not recognize.
// Keys are the normalized name with spaces removed.
const US_ADVISORY_NAME_ALIASES = {
  burma: 'MM',
  caboverde: 'CV',
  cotedivoire: 'CI',
  kingdomdenmark: 'DK',
  turkey: 'TR',
  kyrgyz: 'KG',
  macau: 'MO',
  gaza: 'PS',
  westbank: 'PS',
  bonaire: 'BQ',
  sabasinteustatius: 'BQ',
  democraticcongo: 'CD',
  congo: 'CG',
  federatedstatesmicronesia: 'FM',
  // The feed carries no standalone "China" row. Mainland China's advisory lives
  // in this combined row; Hong Kong and Macau additionally have their own rows
  // (resolved to HK and MO above). Without this alias, asking for CN — a top
  // destination — returns "No advisory found" while an advisory plainly exists.
  // This row's Title has no "Level N", so the level comes from the summary
  // fallback in loadUsAdvisoryIndex, which takes the FIRST level mentioned:
  // mainland China's, which is the correct one for CN.
  mainlandchinahongkongmacauseesummaries: 'CN'
};
const US_ADVISORY_LEVEL_TEXT = {
  1: 'Exercise Normal Precautions',
  2: 'Exercise Increased Caution',
  3: 'Reconsider Travel',
  4: 'Do Not Travel'
};
function advisoryNormalizeName(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\bst\b/g, 'saint').replace(/\b(the|and|of|republic)\b/g, '').replace(/\s+/g, ' ').trim();
}
let _isoNameIndex = null;
function advisoryIsoNameIndex() {
  if (_isoNameIndex) return _isoNameIndex;
  const dn = new Intl.DisplayNames([
    'en'
  ], {
    type: 'region'
  });
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const idx = {};
  for (const a of letters){
    for (const b of letters){
      const raw = a + b;
      let cc = raw;
      try {
        const loc = Intl.getCanonicalLocales('und-' + raw)[0];
        const m = loc && loc.match(/-([A-Z]{2})$/);
        if (m) cc = m[1];
      } catch  {
        continue;
      }
      let name;
      try {
        name = dn.of(cc);
      } catch  {
        continue;
      }
      if (!name || name === cc) continue;
      idx[advisoryNormalizeName(name)] = cc;
    }
  }
  _isoNameIndex = idx;
  return idx;
}
function advisoryResolveIso(countryName) {
  const key = advisoryNormalizeName(countryName);
  return advisoryIsoNameIndex()[key] ?? US_ADVISORY_NAME_ALIASES[key.replace(/ /g, '')] ?? null;
}
function advisoryCleanTitle(title) {
  return (title || '').replace(/\s*[-–]\s*Level\s*[1-4].*$/i, '').replace(/\s*Travel Advisory\s*$/i, '').trim();
}
function advisoryStripHtml(html) {
  return (html || '').replace(/<br\s*\/?>/gi, ' ').replace(/<\/(p|li|h[1-6]|ul|ol|div)>/gi, ' ').replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#8217;/g, '’').replace(/&#8216;/g, '‘').replace(/&quot;/gi, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
}
/** Fetches and indexes the ENTIRE advisory feed. Cached under one key. */ async function loadUsAdvisoryIndex() {
  return runProvider('state-dept', 'advisory-us:index', 43200, 172800, async ()=>{
    const res = await fetchWithRetry(US_ADVISORY_URL, {
      headers: {
        'Accept': 'application/json'
      }
    });
    if (!res.ok) throw new Error(`State Dept advisories HTTP ${res.status}`);
    const body = await res.text();
    // The API answers 429 (and some errors) with an HTML page. Parsing that
    // blind is what produced the original "Unexpected token '<'" failure.
    if (body.trim().startsWith('<')) {
      throw new Error(`State Dept advisories returned HTML, not JSON (HTTP ${res.status}) — likely rate limited`);
    }
    const arr = JSON.parse(body);
    if (!Array.isArray(arr)) throw new Error('State Dept advisories: unexpected payload shape');
    const byIso = {};
    const unresolved = [];
    for (const row of arr){
      const title = String(row.Title ?? '');
      const name = advisoryCleanTitle(title);
      const iso2 = advisoryResolveIso(name);
      if (!iso2) {
        if (name) unresolved.push(name);
        continue;
      }
      // CHINA IS A SPECIAL CASE, and the obvious handling of it is wrong.
      //
      // The feed carries THREE rows titled "Mainland China, Hong Kong & Macau -
      // See Summaries", and all three DO carry a "Level N" in the title. But
      // those title levels describe the most severe territory in the combined
      // advisory, not mainland China: one row is titled "Level 3: Reconsider
      // Travel" while its own body reads "Level 2: Exercise Increased Caution in
      // mainland China" — the 3 is Macau's. Trusting the title and then applying
      // highest-severity-wins published Level 3 for CN when mainland China is
      // Level 2. Wrong data, and wrong in the direction that makes a country
      // look more dangerous than the State Department says it is.
      //
      // So for CN the level comes ONLY from the clause naming mainland China,
      // matched against the HTML-STRIPPED summary — the raw text wraps the level
      // in markup ("<b>Level 2:</b> ... </b>in mainland China") and uses curly
      // quotes, both of which defeat a regex written against the visible
      // wording. The three rows phrase it "in mainland China", "in mainland
      // China" and "for Mainland China", so the preposition is not fixed. A
      // CN-aliased row with no such clause is skipped rather than allowed to
      // overwrite China's real level.
      let level = null;
      if (iso2 === 'CN') {
        const plainSummary = advisoryStripHtml(String(row.Summary ?? ''));
        const mainland = plainSummary.match(/Level\s*([1-4])[^.]{0,80}?\b(?:in|for|to)\s+mainland\s+china/i);
        if (!mainland) continue;
        level = parseInt(mainland[1], 10);
      } else {
        const tl = title.match(/Level\s*([1-4])/i) ?? advisoryStripHtml(String(row.Summary ?? '')).match(/Level\s*([1-4])/i);
        level = tl ? parseInt(tl[1], 10) : null;
      }
      // Derived from the level, not scraped. These four are the State
      // Department's fixed labels, and reading them out of the title meant
      // re-deriving from prose that varies in punctuation and casing.
      const levelText = level ? US_ADVISORY_LEVEL_TEXT[level] : '';
      const updatedAt = String(row.Updated ?? row.Published ?? '');
      const prev = byIso[iso2];
      // Highest severity wins; tie-break on most recent. Over-warn, never under-warn.
      const better = !prev || (level ?? 0) > (prev.level ?? 0) || (level ?? 0) === (prev.level ?? 0) && updatedAt > prev.updatedAt;
      if (!better) continue;
      byIso[iso2] = {
        // The combined row's title is not a usable country label for CN.
        country: iso2 === 'CN' ? 'China (mainland)' : name,
        iso2,
        source: 'US',
        level,
        levelText,
        summary: advisoryStripHtml(String(row.Summary ?? '')).slice(0, 1500),
        url: String(row.Link ?? 'https://travel.state.gov'),
        updatedAt
      };
    }
    if (unresolved.length) {
      console.log('[provider-adapters] state-dept unresolved country names:', unresolved.join('; '));
    }
    console.log('[provider-adapters] state-dept indexed', Object.keys(byIso).length, 'countries from', arr.length, 'records');
    return byIso;
  }, 'U.S. Department of State', 'Data unavailable — check official sources', 'https://travel.state.gov');
}
async function adapterAdvisoryUS(iso2) {
  if (isMock()) return mockResult('state-dept', mockAdvisoryUS(iso2), 'U.S. Department of State');
  const code = iso2.trim().toUpperCase();
  const index = await loadUsAdvisoryIndex();
  if (index.status === 'unavailable' || !index.data) {
    return unavailableResult('state-dept', 'U.S. Department of State', 'Data unavailable — check official sources', 'https://travel.state.gov');
  }
  const hit = index.data[code];
  // Preserve the index's provenance so cacheHit / stale stay truthful.
  return {
    data: hit ?? {
      country: code,
      iso2: code,
      source: 'US',
      level: null,
      levelText: '',
      summary: 'No advisory found.',
      url: 'https://travel.state.gov',
      updatedAt: null
    },
    status: index.status,
    provenance: index.provenance
  };
}
// ---------------------------------------------------------------------------
// Adapter: TravelAdvisoryUK
// ---------------------------------------------------------------------------
async function adapterAdvisoryUK(countrySlug) {
  if (isMock()) return mockResult('fcdo', mockAdvisoryUK(countrySlug), 'UK Foreign, Commonwealth & Development Office');
  const cacheKey = `advisory-uk:${countrySlug}`;
  return runProvider('fcdo', cacheKey, 43200, 86400, async ()=>{
    const res = await fetchWithRetry(`https://www.gov.uk/api/content/foreign-travel-advice/${encodeURIComponent(countrySlug)}`);
    const json = await res.json();
    const details = json.details ?? {};
    const alertStatus = details.alert_status ?? [];
    const levelMap = {
      'Advise against all travel': 4,
      'Advise against all but essential travel': 3,
      'Some parts of the country': 2
    };
    let level = 1;
    for (const status of alertStatus){
      for (const [key, val] of Object.entries(levelMap)){
        if (String(status).includes(key)) {
          level = val;
          break;
        }
      }
    }
    return {
      country: json.title ?? countrySlug,
      iso2: 'XX',
      source: 'UK',
      level,
      summary: details.summary ?? '',
      url: `https://www.gov.uk/foreign-travel-advice/${countrySlug}`,
      updatedAt: json.updated_at ?? new Date().toISOString()
    };
  }, 'UK Foreign, Commonwealth & Development Office', 'Data unavailable — check official sources', 'https://www.gov.uk/foreign-travel-advice');
}
// ---------------------------------------------------------------------------
// Adapter: DiseaseOutbreaks (WHO)
// ---------------------------------------------------------------------------
async function adapterDiseaseOutbreaks() {
  if (isMock()) return mockResult('who-cdc', mockDiseaseOutbreaks(), 'WHO Disease Outbreak News');
  const cacheKey = `disease-outbreaks:who`;
  return runProvider('who-cdc', cacheKey, 43200, 86400, async ()=>{
    const res = await fetchWithRetry('https://www.who.int/api/news/diseaseoutbreaknews?sf_culture=en&$top=20');
    const json = await res.json();
    const items = json.value ?? json.items ?? [];
    const outbreaks = items.map((item, idx)=>({
        id: String(item.Id ?? item.id ?? idx),
        title: String(item.Title ?? item.title ?? ''),
        country: String(item.CountryName ?? item.country ?? ''),
        iso2: String(item.CountryCode ?? item.iso2 ?? 'XX'),
        date: String(item.PublicationDate ?? item.date ?? new Date().toISOString()),
        summary: String(item.Summary ?? item.summary ?? ''),
        url: String(item.Url ?? item.url ?? 'https://www.who.int/emergencies/disease-outbreak-news'),
        source: 'WHO'
      }));
    return {
      outbreaks
    };
  }, 'WHO Disease Outbreak News', 'Data unavailable — check official sources', 'https://www.who.int/emergencies/disease-outbreak-news');
}
// ---------------------------------------------------------------------------
// Adapter: AirQuality (OpenAQ)
// ---------------------------------------------------------------------------
async function adapterAirQuality(lat, lon) {
  if (isMock()) return mockResult('openaq', mockAirQuality());
  const apiKey = env('OPENAQ_API_KEY');
  if (!apiKey) return unavailableResult('openaq', undefined, 'OPENAQ_API_KEY not configured');
  const cacheKey = `air-quality:${roundTo2(lat)}:${roundTo2(lon)}`;
  return runProvider('openaq', cacheKey, 3600, 7200, async ()=>{
    const url = `https://api.openaq.org/v3/locations?coordinates=${lat},${lon}&radius=10000&limit=5`;
    const res = await fetchWithRetry(url, {
      headers: {
        'X-API-Key': apiKey
      }
    });
    if (!res.ok) {
      console.error('[provider-adapters] OpenAQ air-quality HTTP', res.status);
      throw new Error(`OpenAQ air-quality HTTP ${res.status}`);
    }
    const json = await res.json();
    const results = json.results ?? [];
    if (!results.length) return {
      aqi: null,
      category: 'unknown',
      station: 'No station nearby',
      measuredAt: new Date().toISOString()
    };
    // OpenAQ v3 /locations returns sensor DEFINITIONS only — each sensor has
    // {id, name, parameter:{name, units}} and NO current reading. The original
    // code read `s.lastValue`, which does not exist on that payload, so pm25 was
    // always undefined, aqi always null and category always 'unknown'. The route
    // answered 200 with a real station name attached to no data, which read as
    // working. Current values require a second call to /latest.
    //
    // Two further hazards, both found by probing real cities:
    //
    //  * STALE STATIONS. Taking results[0] blindly returned a Los Angeles
    //    reading timestamped 2017-06-07 — nine years old — presented as current
    //    air quality. OpenAQ keeps decommissioned stations in /locations. Any
    //    reading older than MAX_AGE_MS is rejected outright; stale air-quality
    //    data is worse than none, because a traveler acts on it.
    //  * EMPTY STATIONS. Delhi's nearest station resolved by name but carried no
    //    pm25/pm10 in /latest, and the single-station lookup gave up there. The
    //    candidates are now walked in order until one yields a fresh reading.
    const MAX_AGE_MS = 48 * 3600 * 1000;
    const nowMs = Date.now();
    let pm25;
    let pm10;
    let measuredAt;
    let stationName;
    let tried = 0;
    let rejectedStale = 0;
    for (const station of results.slice(0, 5)){
      tried++;
      const sensorParam = new Map();
      for (const s of station.sensors ?? []){
        if (s.id != null && s.parameter?.name) sensorParam.set(s.id, s.parameter.name);
      }
      if (!sensorParam.size) continue;
      let p25, p10, ts;
      try {
        const latestRes = await fetchWithRetry(`https://api.openaq.org/v3/locations/${station.id}/latest`, {
          headers: {
            'X-API-Key': apiKey
          }
        });
        if (!latestRes.ok) {
          console.error('[provider-adapters] OpenAQ latest HTTP', latestRes.status, 'station', station.id);
          continue;
        }
        const latestJson = await latestRes.json();
        for (const m of latestJson.results ?? []){
          const pname = sensorParam.get(m.sensorsId);
          if (pname !== 'pm25' && pname !== 'pm10') continue;
          if (typeof m.value !== 'number') continue;
          const when = m.datetime?.utc;
          if (!when) continue;
          const age = nowMs - new Date(when).getTime();
          if (!(age >= 0) || age > MAX_AGE_MS) {
            rejectedStale++;
            continue;
          }
          if (pname === 'pm25') p25 = m.value;
          else p10 = m.value;
          if (!ts || when > ts) ts = when;
        }
      } catch (e) {
        // A station that errors must not fail the whole call — try the next.
        console.error('[provider-adapters] OpenAQ latest failed for station', station.id, e instanceof Error ? e.message : String(e));
        continue;
      }
      if (p25 != null || p10 != null) {
        pm25 = p25;
        pm10 = p10;
        measuredAt = ts;
        stationName = station.name ?? 'Unknown';
        break;
      }
    }
    const aqi = epaAqi(pm25, pm10);
    if (aqi === null) {
      console.log('[provider-adapters] OpenAQ no fresh reading —', tried, 'stations tried,', rejectedStale, 'readings rejected as stale');
    }
    return {
      aqi,
      category: aqiCategory(aqi),
      pm25,
      pm10,
      // Never claim a station when no usable reading came from it.
      station: aqi === null ? null : stationName ?? 'Unknown',
      measuredAt: measuredAt ?? null,
      stationsTried: tried
    };
  });
}
// EPA AQI from concentrations, replacing the previous `Math.round(pm25 * 4.5)`
// approximation. That linear guess diverges badly from the real piecewise scale:
// at 35 µg/m³ PM2.5 it returned 158 ("unhealthy") where the EPA value is 99
// ("moderate"), and at 150 µg/m³ it returned 675, off the top of a 0–500 scale.
// Breakpoints are the EPA 24-hour tables (PM2.5 revised 2024). The overall AQI
// is the maximum across pollutants, which is how the EPA defines it.
function aqiFromBreakpoints(c, bp) {
  for (const [cLo, cHi, iLo, iHi] of bp){
    if (c >= cLo && c <= cHi) return Math.round((iHi - iLo) / (cHi - cLo) * (c - cLo) + iLo);
  }
  return c > bp[bp.length - 1][1] ? 500 : null;
}
function epaAqi(pm25, pm10) {
  const PM25 = [
    [
      0,
      9.0,
      0,
      50
    ],
    [
      9.1,
      35.4,
      51,
      100
    ],
    [
      35.5,
      55.4,
      101,
      150
    ],
    [
      55.5,
      125.4,
      151,
      200
    ],
    [
      125.5,
      225.4,
      201,
      300
    ],
    [
      225.5,
      325.4,
      301,
      500
    ]
  ];
  const PM10 = [
    [
      0,
      54,
      0,
      50
    ],
    [
      55,
      154,
      51,
      100
    ],
    [
      155,
      254,
      101,
      150
    ],
    [
      255,
      354,
      151,
      200
    ],
    [
      355,
      424,
      201,
      300
    ],
    [
      425,
      604,
      301,
      500
    ]
  ];
  const vals = [
    typeof pm25 === 'number' ? aqiFromBreakpoints(pm25, PM25) : null,
    typeof pm10 === 'number' ? aqiFromBreakpoints(pm10, PM10) : null
  ].filter((v)=>v !== null);
  return vals.length ? Math.max(...vals) : null;
}
function aqiCategory(aqi) {
  if (aqi === null) return 'unknown';
  if (aqi <= 50) return 'good';
  if (aqi <= 100) return 'moderate';
  if (aqi <= 150) return 'unhealthy';
  if (aqi <= 200) return 'very-unhealthy';
  return 'hazardous';
}
// ---------------------------------------------------------------------------
// Adapter: Places (Google Places API v1 — nearby)
// ---------------------------------------------------------------------------
async function adapterPlacesNearby(lat, lon, radius = 1000, types = []) {
  if (isMock()) return mockResult('google-places', mockPlaces());
  const apiKey = env('GOOGLE_PLACES_API_KEY');
  if (!apiKey) return unavailableResult('google-places', undefined, 'GOOGLE_PLACES_API_KEY not configured');
  const cacheKey = `places-nearby:${roundTo2(lat)}:${roundTo2(lon)}:${radius}:${types.sort().join(',')}`;
  return runProvider('google-places', cacheKey, 86400, 172800, async ()=>{
    const body = {
      locationRestriction: {
        circle: {
          center: {
            latitude: lat,
            longitude: lon
          },
          radius
        }
      }
    };
    if (types.length) body.includedTypes = types;
    const res = await fetchWithRetry('https://places.googleapis.com/v1/places:searchNearby', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.location,places.rating,places.userRatingCount,places.priceLevel,places.regularOpeningHours,places.types,places.websiteUri,places.nationalPhoneNumber'
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      console.error('[provider-adapters] Google Places nearby HTTP', res.status);
      throw new Error(`Google Places nearby HTTP ${res.status}`);
    }
    const json = await res.json();
    const places = (json.places ?? []).map((p)=>({
        id: p.id,
        source: 'google',
        name: p.displayName?.text ?? '',
        lat: p.location?.latitude ?? 0,
        lng: p.location?.longitude ?? 0,
        rating: p.rating,
        reviewCount: p.userRatingCount,
        priceLevel: parsePriceLevel(p.priceLevel),
        types: p.types ?? [],
        websiteUrl: p.websiteUri,
        phone: p.nationalPhoneNumber
      }));
    return {
      places
    };
  });
}
function parsePriceLevel(raw) {
  if (!raw) return undefined;
  const map = {
    PRICE_LEVEL_INEXPENSIVE: 1,
    PRICE_LEVEL_MODERATE: 2,
    PRICE_LEVEL_EXPENSIVE: 3,
    PRICE_LEVEL_VERY_EXPENSIVE: 4
  };
  return map[raw];
}
// ---------------------------------------------------------------------------
// Places API (New) -> legacy response shape
// See the MIGRATION 2026-09-17 block at the top of this file.
// ---------------------------------------------------------------------------
/** Best-effort extraction of the { error: { message } } body the New API
 *  returns on a non-2xx, for the log line only. Never throws. */ async function googleErrorDetail(res) {
  try {
    const text = await res.text();
    try {
      const parsed = JSON.parse(text);
      return String(parsed?.error?.message ?? text).slice(0, 300);
    } catch  {
      return text.slice(0, 300);
    }
  } catch  {
    return '<unreadable body>';
  }
}
/** Legacy callers pass location as the "lat,lng" string the legacy query
 *  parameter used. Returns null when it is not a usable pair, in which case
 *  the caller omits locationBias entirely (still a valid text search). */ function parseLatLngPair(raw) {
  const parts = String(raw ?? '').split(',');
  if (parts.length !== 2) return null;
  const lat = parseFloat(parts[0].trim());
  const lng = parseFloat(parts[1].trim());
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return {
    lat,
    lng
  };
}
/** locationBias/locationRestriction circles are capped at 50000 m. */ function clampRadius(radius, fallback) {
  if (!Number.isFinite(radius) || radius <= 0) return fallback;
  return Math.min(radius, 50000);
}
/** One New API place -> one legacy result/candidate object. Only the paths
 *  named in the field masks below are read here. */ function toLegacyPlace(p) {
  const out = {
    place_id: p?.id,
    name: p?.displayName?.text ?? '',
    geometry: {
      location: {
        lat: p?.location?.latitude,
        lng: p?.location?.longitude
      }
    },
    types: p?.types ?? []
  };
  if (p?.formattedAddress !== undefined) out.formatted_address = p.formattedAddress;
  if (p?.rating !== undefined) out.rating = p.rating;
  if (p?.userRatingCount !== undefined) out.user_ratings_total = p.userRatingCount;
  const priceLevel = parsePriceLevel(p?.priceLevel);
  if (priceLevel !== undefined) out.price_level = priceLevel;
  if (p?.currentOpeningHours?.openNow !== undefined) out.opening_hours = {
    open_now: p.currentOpeningHours.openNow
  };
  return out;
}
/** { places: [...] } -> { results: [...], status }. An empty search omits the
 *  places key entirely, which is ZERO_RESULTS, not a failure. */ function toLegacyTextSearchResponse(json) {
  const places = Array.isArray(json?.places) ? json.places : [];
  return {
    results: places.map(toLegacyPlace),
    status: places.length ? 'OK' : 'ZERO_RESULTS'
  };
}
/** A place details GET returns the Place resource at the top level. */ function toLegacyDetailsResponse(p) {
  if (!p || typeof p !== 'object') throw new Error('Google Places details: unexpected response shape');
  const result = {
    place_id: p.id,
    name: p.displayName?.text ?? '',
    geometry: {
      location: {
        lat: p.location?.latitude,
        lng: p.location?.longitude
      }
    },
    types: p.types ?? []
  };
  if (p.formattedAddress !== undefined) result.formatted_address = p.formattedAddress;
  if (p.rating !== undefined) result.rating = p.rating;
  const priceLevel = parsePriceLevel(p.priceLevel);
  if (priceLevel !== undefined) result.price_level = priceLevel;
  const openNow = p.currentOpeningHours?.openNow;
  const weekdayText = p.regularOpeningHours?.weekdayDescriptions;
  if (openNow !== undefined || weekdayText !== undefined) {
    result.opening_hours = {
      ...openNow !== undefined ? {
        open_now: openNow
      } : {},
      weekday_text: weekdayText ?? []
    };
  }
  if (p.nationalPhoneNumber !== undefined) result.formatted_phone_number = p.nationalPhoneNumber;
  if (p.websiteUri !== undefined) result.website = p.websiteUri;
  return {
    result,
    status: 'OK'
  };
}
/** { suggestions: [...] } -> { predictions: [...], status }. queryPrediction
 *  entries have no place_id and had no legacy equivalent, so they are dropped.
 *  An empty autocomplete omits the suggestions key, which is ZERO_RESULTS. */ function toLegacyAutocompleteResponse(json) {
  const suggestions = Array.isArray(json?.suggestions) ? json.suggestions : [];
  const predictions = suggestions.filter((s)=>s?.placePrediction).map((s)=>{
    const pp = s.placePrediction;
    return {
      place_id: pp.placeId ?? String(pp.place ?? '').replace(/^places\//, ''),
      description: pp.text?.text ?? '',
      structured_formatting: {
        main_text: pp.structuredFormat?.mainText?.text ?? '',
        secondary_text: pp.structuredFormat?.secondaryText?.text ?? ''
      }
    };
  });
  return {
    predictions,
    status: predictions.length ? 'OK' : 'ZERO_RESULTS'
  };
}
/** Legacy components="country:fr|country:de" -> includedRegionCodes ["fr","de"]. */ function toRegionCodes(components) {
  return String(components ?? '').split('|').map((part)=>part.trim()).filter(Boolean).map((part)=>part.startsWith('country:') ? part.slice('country:'.length) : part).map((part)=>part.trim().toLowerCase()).filter(Boolean).slice(0, 15);
}
// Field masks. Each path here is read by a toLegacy* mapper above; nothing
// unread is requested. Field masks are mandatory and billed by tier.
const GP_SEARCH_FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.rating',
  'places.userRatingCount',
  'places.priceLevel',
  'places.currentOpeningHours.openNow',
  'places.types'
].join(',');
const GP_DETAILS_FIELD_MASK = [
  'id',
  'displayName',
  'formattedAddress',
  'location',
  'rating',
  'priceLevel',
  'currentOpeningHours.openNow',
  'regularOpeningHours.weekdayDescriptions',
  'nationalPhoneNumber',
  'websiteUri',
  'types'
].join(',');
// ---------------------------------------------------------------------------
// Adapter: TripAdvisor (legacy places search)
// ---------------------------------------------------------------------------
async function adapterPlacesSearch(query) {
  if (isMock()) return mockResult('tripadvisor', mockPlaces(), 'Powered by Tripadvisor');
  const apiKey = env('TRIPADVISOR_API_KEY');
  if (!apiKey) return unavailableResult('tripadvisor', 'Powered by Tripadvisor', 'TRIPADVISOR_API_KEY not configured');
  const cacheKey = `places-search:${encodeURIComponent(query)}`;
  return runProvider('tripadvisor', cacheKey, 86400, 172800, async ()=>{
    const url = `https://api.content.tripadvisor.com/api/v1/location/search?searchQuery=${encodeURIComponent(query)}&key=${apiKey}`;
    const res = await fetchWithRetry(url);
    if (!res.ok) {
      console.error('[provider-adapters] TripAdvisor places-search HTTP', res.status);
      throw new Error(`TripAdvisor places-search HTTP ${res.status}`);
    }
    const json = await res.json();
    const places = (json.data ?? []).map((p)=>({
        id: String(p.location_id ?? p.id ?? ''),
        source: 'tripadvisor',
        name: String(p.name ?? ''),
        lat: parseFloat(String(p.latitude ?? '0')),
        lng: parseFloat(String(p.longitude ?? '0')),
        types: [
          String(p.category?.name ?? 'attraction')
        ],
        websiteUrl: p.web_url
      }));
    return {
      places
    };
  }, 'Powered by Tripadvisor');
}
// ---------------------------------------------------------------------------
// Adapter: TripAdvisor Search
// ---------------------------------------------------------------------------
async function adapterTripAdvisorSearch(query, language) {
  if (isMock()) return mockResult('tripadvisor', mockTripAdvisorLocations(), 'Powered by Tripadvisor');
  const apiKey = env('TRIPADVISOR_API_KEY');
  if (!apiKey) return unavailableResult('tripadvisor', 'Powered by Tripadvisor', 'TRIPADVISOR_API_KEY not configured');
  const cacheKey = `tripadvisor:search:${encodeURIComponent(query)}:${language}`;
  const t0 = Date.now();
  const result = await runProvider('tripadvisor', cacheKey, 86400, 172800, async ()=>{
    const controller = new AbortController();
    const timer = setTimeout(()=>controller.abort(), 5000);
    try {
      const url = `https://api.tripadvisor.com/api/travel/v1/location/search?query=${encodeURIComponent(query)}&language=${encodeURIComponent(language)}&key=${apiKey}`;
      const res = await fetch(url, {
        signal: controller.signal
      });
      clearTimeout(timer);
      if (res.status >= 400 && res.status < 500) throw Object.assign(new Error(`TripAdvisor 4xx: ${res.status}`), {
        is4xx: true
      });
      if (res.status >= 500) {
        await sleep(2000);
        const res2 = await fetch(url);
        if (!res2.ok) throw new Error(`TripAdvisor 5xx: ${res2.status}`);
        return await res2.json();
      }
      return await res.json();
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  }, 'Powered by Tripadvisor');
  logMonitoringCall({
    service: 'tripadvisor',
    endpoint: 'search',
    status: result.status,
    cacheHit: result.provenance.cacheHit,
    durationMs: Date.now() - t0,
    costUsd: 0.005
  });
  return result;
}
// ---------------------------------------------------------------------------
// Adapter: TripAdvisor Details
// ---------------------------------------------------------------------------
async function adapterTripAdvisorDetails(locationId, language) {
  if (isMock()) return mockResult('tripadvisor', mockTripAdvisorDetails(locationId), 'Powered by Tripadvisor');
  const apiKey = env('TRIPADVISOR_API_KEY');
  if (!apiKey) return unavailableResult('tripadvisor', 'Powered by Tripadvisor', 'TRIPADVISOR_API_KEY not configured');
  const cacheKey = `tripadvisor:details:${locationId}:${language}`;
  const t0 = Date.now();
  const result = await runProvider('tripadvisor', cacheKey, 86400, 172800, async ()=>{
    const controller = new AbortController();
    const timer = setTimeout(()=>controller.abort(), 5000);
    try {
      const url = `https://api.tripadvisor.com/api/travel/v1/location/${encodeURIComponent(locationId)}/details?language=${encodeURIComponent(language)}&key=${apiKey}`;
      const res = await fetch(url, {
        signal: controller.signal
      });
      clearTimeout(timer);
      if (res.status >= 400 && res.status < 500) throw Object.assign(new Error(`TripAdvisor 4xx: ${res.status}`), {
        is4xx: true
      });
      if (res.status >= 500) {
        await sleep(2000);
        const res2 = await fetch(url);
        if (!res2.ok) throw new Error(`TripAdvisor 5xx: ${res2.status}`);
        return await res2.json();
      }
      return await res.json();
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  }, 'Powered by Tripadvisor');
  logMonitoringCall({
    service: 'tripadvisor',
    endpoint: 'details',
    status: result.status,
    cacheHit: result.provenance.cacheHit,
    durationMs: Date.now() - t0,
    costUsd: 0.005
  });
  return result;
}
// ---------------------------------------------------------------------------
// Adapter: TripAdvisor Nearby
// ---------------------------------------------------------------------------
async function adapterTripAdvisorNearby(lat, lng, language) {
  if (isMock()) return mockResult('tripadvisor', mockTripAdvisorLocations(), 'Powered by Tripadvisor');
  const apiKey = env('TRIPADVISOR_API_KEY');
  if (!apiKey) return unavailableResult('tripadvisor', 'Powered by Tripadvisor', 'TRIPADVISOR_API_KEY not configured');
  const cacheKey = `tripadvisor:nearby:${roundTo2(lat)}:${roundTo2(lng)}:${language}`;
  const t0 = Date.now();
  const result = await runProvider('tripadvisor', cacheKey, 86400, 172800, async ()=>{
    const controller = new AbortController();
    const timer = setTimeout(()=>controller.abort(), 5000);
    try {
      const url = `https://api.tripadvisor.com/api/travel/v1/location/nearby?latLong=${lat},${lng}&language=${encodeURIComponent(language)}&key=${apiKey}`;
      const res = await fetch(url, {
        signal: controller.signal
      });
      clearTimeout(timer);
      if (res.status >= 400 && res.status < 500) throw Object.assign(new Error(`TripAdvisor 4xx: ${res.status}`), {
        is4xx: true
      });
      if (res.status >= 500) {
        await sleep(2000);
        const res2 = await fetch(url);
        if (!res2.ok) throw new Error(`TripAdvisor 5xx: ${res2.status}`);
        return await res2.json();
      }
      return await res.json();
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  }, 'Powered by Tripadvisor');
  logMonitoringCall({
    service: 'tripadvisor',
    endpoint: 'nearby',
    status: result.status,
    cacheHit: result.provenance.cacheHit,
    durationMs: Date.now() - t0,
    costUsd: 0.005
  });
  return result;
}
// ---------------------------------------------------------------------------
// Adapter: TripAdvisor Reviews
// ---------------------------------------------------------------------------
async function adapterTripAdvisorReviews(locationId, language) {
  if (isMock()) return mockResult('tripadvisor', mockTripAdvisorReviews(locationId), 'Powered by Tripadvisor');
  const apiKey = env('TRIPADVISOR_API_KEY');
  if (!apiKey) return unavailableResult('tripadvisor', 'Powered by Tripadvisor', 'TRIPADVISOR_API_KEY not configured');
  const cacheKey = `tripadvisor:reviews:${locationId}:${language}`;
  const t0 = Date.now();
  const result = await runProvider('tripadvisor', cacheKey, 86400, 172800, async ()=>{
    const controller = new AbortController();
    const timer = setTimeout(()=>controller.abort(), 5000);
    try {
      const url = `https://api.tripadvisor.com/api/travel/v1/location/${encodeURIComponent(locationId)}/reviews?language=${encodeURIComponent(language)}&key=${apiKey}`;
      const res = await fetch(url, {
        signal: controller.signal
      });
      clearTimeout(timer);
      if (res.status >= 400 && res.status < 500) throw Object.assign(new Error(`TripAdvisor 4xx: ${res.status}`), {
        is4xx: true
      });
      if (res.status >= 500) {
        await sleep(2000);
        const res2 = await fetch(url);
        if (!res2.ok) throw new Error(`TripAdvisor 5xx: ${res2.status}`);
        return await res2.json();
      }
      return await res.json();
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  }, 'Powered by Tripadvisor');
  logMonitoringCall({
    service: 'tripadvisor',
    endpoint: 'reviews',
    status: result.status,
    cacheHit: result.provenance.cacheHit,
    durationMs: Date.now() - t0,
    costUsd: 0.005
  });
  return result;
}
// ---------------------------------------------------------------------------
// Adapter: Ticketmaster Events
// ---------------------------------------------------------------------------
async function adapterTicketmasterEvents(city, countryCode, startDateTime, endDateTime, keyword, size) {
  if (isMock()) return mockResult('ticketmaster', mockTicketmasterEvents());
  const apiKey = env('TICKETMASTER_API_KEY');
  if (!apiKey) return {
    data: null,
    status: 'unavailable',
    provenance: {
      provider: 'ticketmaster',
      fetchedAt: new Date().toISOString(),
      cacheHit: false,
      stale: false
    },
    safeFailureMessage: 'TICKETMASTER_API_KEY not configured'
  };
  const cacheKey = `ticketmaster:events:${city}:${startDateTime}:${keyword}`;
  const t0 = Date.now();
  const result = await runProvider('ticketmaster', cacheKey, 21600, 43200, async ()=>{
    const params = new URLSearchParams({
      apikey: apiKey,
      countryCode,
      size: String(size)
    });
    if (city) params.set('city', city);
    // Ticketmaster rejects millisecond precision with HTTP 400 — see tmDateTime.
    if (startDateTime) params.set('startDateTime', tmDateTime(startDateTime));
    if (endDateTime) params.set('endDateTime', tmDateTime(endDateTime));
    if (keyword) params.set('keyword', keyword);
    const controller = new AbortController();
    const timer = setTimeout(()=>controller.abort(), 5000);
    try {
      const url = `https://app.ticketmaster.com/discovery/v2/events.json?${params.toString()}`;
      const res = await fetch(url, {
        signal: controller.signal
      });
      clearTimeout(timer);
      if (res.status >= 400 && res.status < 500) throw Object.assign(new Error(`Ticketmaster 4xx: ${res.status}`), {
        is4xx: true
      });
      if (res.status >= 500) {
        await sleep(2000);
        const res2 = await fetch(url);
        if (!res2.ok) throw new Error(`Ticketmaster 5xx: ${res2.status}`);
        return await res2.json();
      }
      return await res.json();
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  });
  logMonitoringCall({
    service: 'ticketmaster',
    endpoint: 'events',
    status: result.status,
    cacheHit: result.provenance.cacheHit,
    durationMs: Date.now() - t0,
    costUsd: 0.002
  });
  return result;
}
// ---------------------------------------------------------------------------
// Adapter: Ticketmaster Event Detail
// ---------------------------------------------------------------------------
async function adapterTicketmasterEventDetail(eventId) {
  if (isMock()) return mockResult('ticketmaster', mockTicketmasterEvent(eventId));
  const apiKey = env('TICKETMASTER_API_KEY');
  if (!apiKey) return {
    data: null,
    status: 'unavailable',
    provenance: {
      provider: 'ticketmaster',
      fetchedAt: new Date().toISOString(),
      cacheHit: false,
      stale: false
    }
  };
  const cacheKey = `ticketmaster:event:${eventId}`;
  const t0 = Date.now();
  const result = await runProvider('ticketmaster', cacheKey, 21600, 43200, async ()=>{
    const controller = new AbortController();
    const timer = setTimeout(()=>controller.abort(), 5000);
    try {
      const url = `https://app.ticketmaster.com/discovery/v2/events/${encodeURIComponent(eventId)}.json?apikey=${apiKey}`;
      const res = await fetch(url, {
        signal: controller.signal
      });
      clearTimeout(timer);
      if (res.status >= 400 && res.status < 500) throw Object.assign(new Error(`Ticketmaster 4xx: ${res.status}`), {
        is4xx: true
      });
      if (res.status >= 500) {
        await sleep(2000);
        const res2 = await fetch(url);
        if (!res2.ok) throw new Error(`Ticketmaster 5xx: ${res2.status}`);
        return await res2.json();
      }
      return await res.json();
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  });
  logMonitoringCall({
    service: 'ticketmaster',
    endpoint: 'event-detail',
    status: result.status,
    cacheHit: result.provenance.cacheHit,
    durationMs: Date.now() - t0,
    costUsd: 0.002
  });
  return result;
}
// ---------------------------------------------------------------------------
// Adapter: Ticketmaster Venue Detail
// ---------------------------------------------------------------------------
async function adapterTicketmasterVenueDetail(venueId) {
  if (isMock()) return mockResult('ticketmaster', mockTicketmasterVenue(venueId));
  const apiKey = env('TICKETMASTER_API_KEY');
  if (!apiKey) return {
    data: null,
    status: 'unavailable',
    provenance: {
      provider: 'ticketmaster',
      fetchedAt: new Date().toISOString(),
      cacheHit: false,
      stale: false
    }
  };
  const cacheKey = `ticketmaster:venue:${venueId}`;
  const t0 = Date.now();
  const result = await runProvider('ticketmaster', cacheKey, 21600, 43200, async ()=>{
    const controller = new AbortController();
    const timer = setTimeout(()=>controller.abort(), 5000);
    try {
      const url = `https://app.ticketmaster.com/discovery/v2/venues/${encodeURIComponent(venueId)}.json?apikey=${apiKey}`;
      const res = await fetch(url, {
        signal: controller.signal
      });
      clearTimeout(timer);
      if (res.status >= 400 && res.status < 500) throw Object.assign(new Error(`Ticketmaster 4xx: ${res.status}`), {
        is4xx: true
      });
      if (res.status >= 500) {
        await sleep(2000);
        const res2 = await fetch(url);
        if (!res2.ok) throw new Error(`Ticketmaster 5xx: ${res2.status}`);
        return await res2.json();
      }
      return await res.json();
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  });
  logMonitoringCall({
    service: 'ticketmaster',
    endpoint: 'venue-detail',
    status: result.status,
    cacheHit: result.provenance.cacheHit,
    durationMs: Date.now() - t0,
    costUsd: 0.002
  });
  return result;
}
// ---------------------------------------------------------------------------
// Adapter: Ticketmaster Attraction Detail
// ---------------------------------------------------------------------------
async function adapterTicketmasterAttractionDetail(attractionId) {
  if (isMock()) return mockResult('ticketmaster', mockTicketmasterAttraction(attractionId));
  const apiKey = env('TICKETMASTER_API_KEY');
  if (!apiKey) return {
    data: null,
    status: 'unavailable',
    provenance: {
      provider: 'ticketmaster',
      fetchedAt: new Date().toISOString(),
      cacheHit: false,
      stale: false
    }
  };
  const cacheKey = `ticketmaster:attraction:${attractionId}`;
  const t0 = Date.now();
  const result = await runProvider('ticketmaster', cacheKey, 21600, 43200, async ()=>{
    const controller = new AbortController();
    const timer = setTimeout(()=>controller.abort(), 5000);
    try {
      const url = `https://app.ticketmaster.com/discovery/v2/attractions/${encodeURIComponent(attractionId)}.json?apikey=${apiKey}`;
      const res = await fetch(url, {
        signal: controller.signal
      });
      clearTimeout(timer);
      if (res.status >= 400 && res.status < 500) throw Object.assign(new Error(`Ticketmaster 4xx: ${res.status}`), {
        is4xx: true
      });
      if (res.status >= 500) {
        await sleep(2000);
        const res2 = await fetch(url);
        if (!res2.ok) throw new Error(`Ticketmaster 5xx: ${res2.status}`);
        return await res2.json();
      }
      return await res.json();
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  });
  logMonitoringCall({
    service: 'ticketmaster',
    endpoint: 'attraction-detail',
    status: result.status,
    cacheHit: result.provenance.cacheHit,
    durationMs: Date.now() - t0,
    costUsd: 0.002
  });
  return result;
}
// ---------------------------------------------------------------------------
// Adapter: FlightStatus
// ---------------------------------------------------------------------------
async function adapterFlightStatus(ident, scheduledOut) {
  if (isMock()) return mockResult('flightaware', mockFlight(ident));
  const apiKey = env('FLIGHTAWARE_API_KEY');
  if (!apiKey) return unavailableResult('flightaware', undefined, 'FLIGHTAWARE_API_KEY not configured');
  let ttl = 1800;
  if (scheduledOut) {
    const depMs = new Date(scheduledOut).getTime();
    const diffH = (depMs - Date.now()) / 3_600_000;
    if (Math.abs(diffH) < 6) ttl = 120;
  }
  const cacheKey = `flight:${ident.toUpperCase()}`;
  return runProvider('flightaware', cacheKey, ttl, ttl * 2, async ()=>{
    const url = `https://aeroapi.flightaware.com/aeroapi/flights/${encodeURIComponent(ident)}`;
    const res = await fetchWithRetry(url, {
      headers: {
        'x-apikey': apiKey
      }
    });
    if (!res.ok) {
      console.error('[provider-adapters] FlightAware flight-status HTTP', res.status);
      throw new Error(`FlightAware flight-status HTTP ${res.status}`);
    }
    const json = await res.json();
    const f = (json.flights ?? [
      json
    ])[0];
    if (!f) throw new Error('no flight data');
    const statusMap = {
      Scheduled: 'scheduled',
      Delayed: 'delayed',
      Departed: 'departed',
      Arrived: 'arrived',
      Cancelled: 'cancelled',
      Diverted: 'diverted'
    };
    return {
      ident: f.ident ?? ident,
      scheduledOut: f.scheduled_out ?? f.scheduled_off ?? '',
      estimatedOut: f.estimated_out ?? f.estimated_off,
      actualOut: f.actual_out ?? f.actual_off,
      scheduledIn: f.scheduled_in ?? f.scheduled_on ?? '',
      estimatedIn: f.estimated_in ?? f.estimated_on,
      gateOrigin: f.gate_origin,
      gateDestination: f.gate_destination,
      status: statusMap[f.status] ?? 'unknown',
      inboundIdent: f.inbound_fa_flight_id
    };
  });
}
// ---------------------------------------------------------------------------
// Adapter: Geocode (Mapbox)
// ---------------------------------------------------------------------------
async function adapterGeocode(q) {
  if (isMock()) return mockResult('mapbox', mockGeocode(q));
  const mapboxKey = MAPBOX_TOKEN;
  if (!mapboxKey) return unavailableResult('mapbox', undefined, 'MAPBOX_ACCESS_TOKEN or MAPBOX_API_KEY not configured');
  // FIX 2026-09-19 (3b) — versioned to v2 so the 30-day entries written before
  // `relevance` existed are not served without it.
  const cacheKey = `geocode:v2:${encodeURIComponent(q.toLowerCase())}`;
  return runProvider('mapbox', cacheKey, 2592000, 5184000, async ()=>{
    // MIGRATION 2026-09-17 — the Google Geocoding fallback that used to live
    // here called maps.googleapis.com/maps/api/geocode/json, which is a legacy
    // API and is not enabled on this Google project (verified live: HTTP 200,
    // REQUEST_DENIED, "This API is not activated on your API project"). It
    // could therefore never return a result. Mapbox is the primary geocoder
    // and its token works, so this adapter is Mapbox-only now. The returned
    // object { lat, lon, placeName, iso2 } is unchanged.
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json?access_token=${mapboxKey}`;
    const res = await fetchWithRetry(url);
    if (!res.ok) {
      console.error('[provider-adapters] Mapbox geocode non-OK:', res.status);
      throw new Error(`Mapbox geocode ${res.status}`);
    }
    const json = await res.json();
    const feat = json.features?.[0];
    if (!feat) throw new Error('no geocode result');
    const iso2 = feat.context?.find((c)=>c.id?.startsWith('country'))?.short_code?.toUpperCase();
    // Q2.17 / FIX 2026-09-19 (3b) — this adapter returned only lat/lon/placeName/
    // iso2, so a nonsense query resolved to a real place with nothing to flag it.
    // The cache still holds the proof: geocode:zzqxwvunk%20nowhereville%2099999
    // -> "999992, Munsiari, Uttarakhand, India". Mapbox scores each feature with
    // relevance (0..1); it is surfaced here together with the text Mapbox
    // actually matched, the feature's place_type and how many candidates came
    // back, so a caller can judge the match instead of trusting it. Behaviour is
    // otherwise unchanged: a weak match is still returned, it is merely labelled.
    // These are additive fields; lat/lon/placeName/iso2 are untouched.
    const relevance = typeof feat.relevance === 'number' ? feat.relevance : null;
    return {
      lat: feat.center[1],
      lon: feat.center[0],
      placeName: feat.place_name,
      iso2,
      relevance,
      matchedText: typeof feat.text === 'string' ? feat.text : null,
      placeType: Array.isArray(feat.place_type) ? feat.place_type : null,
      candidateCount: Array.isArray(json.features) ? json.features.length : 0
    };
  });
}
// ---------------------------------------------------------------------------
// Adapter: FxRates (ECB)
// ---------------------------------------------------------------------------
async function adapterFxRates() {
  if (isMock()) return mockResult('ecb', mockFxRates(), 'Exchange rates by European Central Bank');
  const cacheKey = `fx-rates:eur`;
  return runProvider('ecb', cacheKey, 21600, 86400, async ()=>{
    const res = await fetchWithRetry('https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml');
    const text = await res.text();
    const dateMatch = text.match(/time='([^']+)'/);
    const date = dateMatch?.[1] ?? new Date().toISOString().split('T')[0];
    const rates = {};
    const rateMatches = text.matchAll(/currency='([A-Z]+)'\s+rate='([\d.]+)'/g);
    for (const m of rateMatches){
      rates[m[1]] = parseFloat(m[2]);
    }
    if (!Object.keys(rates).length) throw new Error('empty ECB rates');
    return {
      base: 'EUR',
      date,
      rates
    };
  }, 'Exchange rates by European Central Bank');
}
// ---------------------------------------------------------------------------
// Adapter: Events (Ticketmaster — legacy lat/lon route)
// ---------------------------------------------------------------------------
// Ticketmaster's Discovery API accepts ONLY `YYYY-MM-DDTHH:mm:ssZ` for
// startDateTime/endDateTime. JavaScript's Date.prototype.toISOString() emits
// milliseconds (`2026-09-17T19:51:45.162Z`), which Ticketmaster rejects with a
// flat HTTP 400. The /events route defaults both bounds to toISOString(), so
// EVERY call to this legacy lat/lon route 400'd — and because the handler below
// swallowed the status and returned null, runProvider reported it as the
// uninformative 'empty response'. Normalizing here also protects against a
// caller passing a millisecond timestamp of their own.
function tmDateTime(iso) {
  if (!iso) return iso;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
async function adapterEvents(lat, lon, start, end) {
  if (isMock()) return mockResult('ticketmaster', mockEvents());
  const apiKey = env('TICKETMASTER_API_KEY');
  if (!apiKey) return unavailableResult('ticketmaster', undefined, 'TICKETMASTER_API_KEY not configured');
  const startTm = tmDateTime(start);
  const endTm = tmDateTime(end);
  const cacheKey = `events:${roundTo2(lat)}:${roundTo2(lon)}:${startTm}:${endTm}`;
  return runProvider('ticketmaster', cacheKey, 21600, 43200, async ()=>{
    const url = `https://app.ticketmaster.com/discovery/v2/events.json?latlong=${lat},${lon}&radius=25&unit=km&startDateTime=${encodeURIComponent(startTm)}&endDateTime=${encodeURIComponent(endTm)}&apikey=${apiKey}`;
    const res = await fetchWithRetry(url);
    // Surface the real upstream status. Returning null here made every failure
    // mode — bad dates, revoked key, rate limit — look identical downstream.
    if (!res.ok) {
      console.error('[provider-adapters] Ticketmaster events (legacy) HTTP', res.status);
      throw new Error(`Ticketmaster events (legacy) HTTP ${res.status}`);
    }
    const json = await res.json();
    const rawEvents = json._embedded?.events ?? [];
    const events = rawEvents.map((e)=>{
      const dates = e.dates;
      const venue = e._embedded?.venues?.[0];
      const priceRanges = e.priceRanges;
      const classification = e.classifications?.[0];
      return {
        id: e.id,
        name: e.name,
        date: dates?.start?.dateTime ?? '',
        venue: venue?.name ?? '',
        category: classification?.segment?.name ?? 'Entertainment',
        url: e.url,
        priceMin: priceRanges?.[0]?.min,
        priceMax: priceRanges?.[0]?.max,
        currency: priceRanges?.[0]?.currency
      };
    });
    return {
      events
    };
  });
}
// ---------------------------------------------------------------------------
// Adapter: LodgingRates (mock only)
// ---------------------------------------------------------------------------
async function adapterLodging(_lat, _lon, _checkIn, _checkOut) {
  // FIX 2026-09-19 (1) — this used to return mockLodging(): three invented
  // properties with invented nightly rates ("Grand Hotel Paris", EUR 189) in
  // `data`, while reporting status 'unavailable'. A caller that read .data
  // without checking .status rendered fabricated prices. There is no lodging
  // provider wired up, so the honest answer is the unavailable envelope with
  // data: null. The fixture is still reachable under PROVIDERS_MODE=mock on a
  // non-hosted deployment, clearly labelled.
  if (isMock()) return mockResult('lodging', mockLodging());
  return {
    data: null,
    status: 'unavailable',
    provenance: {
      provider: 'lodging',
      fetchedAt: new Date().toISOString(),
      cacheHit: false,
      stale: false
    },
    safeFailureMessage: 'Real rates require a partner API agreement. Airbnb rates are not available.'
  };
}
// ---------------------------------------------------------------------------
// Q2.17 / FIX 2026-09-19 (3a) — profile-aware route cache policy
// ---------------------------------------------------------------------------
// Every Mapbox route and matrix response was cached for 7 days regardless of
// profile. 'driving-traffic' is the one profile whose durations encode live
// traffic, so a week-old entry made "live traffic" meaningless. The static
// profiles genuinely do not change on that timescale and keep the long TTL.
const ROUTE_CACHE_POLICY = {
  'driving-traffic': {
    ttl: 120,
    maxStale: 120
  }
};
const ROUTE_CACHE_DEFAULT = {
  ttl: 604800,
  maxStale: 1209600
};
function routeCachePolicy(profile) {
  return ROUTE_CACHE_POLICY[profile] ?? ROUTE_CACHE_DEFAULT;
}
// ---------------------------------------------------------------------------
// Adapter: Mapbox Geocode
// ---------------------------------------------------------------------------
async function adapterMapboxGeocode(query, limit) {
  if (isMock()) return mockResult('mapbox', mockMapboxGeocode(query));
  const apiKey = MAPBOX_TOKEN;
  if (!apiKey) return {
    data: null,
    status: 'unavailable',
    provenance: {
      provider: 'mapbox',
      fetchedAt: new Date().toISOString(),
      cacheHit: false,
      stale: false
    },
    safeFailureMessage: 'MAPBOX_ACCESS_TOKEN or MAPBOX_API_KEY not configured'
  };
  // FIX 2026-09-19 (3b) — `limit` was not in the key, so a limit=1 request and
  // a limit=10 request shared one cache entry and one of them got the wrong
  // number of candidates. Versioned to v2 to retire those mixed entries.
  const cacheKey = `mapbox:geocode:v2:${limit}:${query}`;
  const t0 = Date.now();
  const result = await runProvider('mapbox', cacheKey, 604800, 1209600, async ()=>{
    const controller = new AbortController();
    const timer = setTimeout(()=>controller.abort(), 5000);
    try {
      const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?access_token=${apiKey}&limit=${limit}`;
      const res = await fetch(url, {
        signal: controller.signal
      });
      clearTimeout(timer);
      if (res.status >= 400 && res.status < 500) {
        console.error('[provider-adapters] Mapbox geocode HTTP', res.status);
        throw new Error(`Mapbox geocode HTTP ${res.status}`);
      }
      if (res.status >= 500) {
        await sleep(2000);
        const res2 = await fetch(url);
        if (!res2.ok) throw new Error(`Mapbox geocode 5xx: ${res2.status}`);
        return await res2.json();
      }
      return await res.json();
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  });
  logMonitoringCall({
    service: 'mapbox',
    endpoint: 'geocode',
    status: result.status,
    cacheHit: result.provenance.cacheHit,
    durationMs: Date.now() - t0,
    costUsd: 0.0005
  });
  return result;
}
// ---------------------------------------------------------------------------
// Adapter: Mapbox Reverse Geocode
// ---------------------------------------------------------------------------
async function adapterMapboxReverseGeocode(lat, lng) {
  if (isMock()) return mockResult('mapbox', mockMapboxReverseGeocode(lat, lng));
  const apiKey = MAPBOX_TOKEN;
  if (!apiKey) return {
    data: null,
    status: 'unavailable',
    provenance: {
      provider: 'mapbox',
      fetchedAt: new Date().toISOString(),
      cacheHit: false,
      stale: false
    },
    safeFailureMessage: 'MAPBOX_ACCESS_TOKEN or MAPBOX_API_KEY not configured'
  };
  const lat4 = roundTo4(lat);
  const lng4 = roundTo4(lng);
  const cacheKey = `mapbox:reverse:${lat4}:${lng4}`;
  const t0 = Date.now();
  const result = await runProvider('mapbox', cacheKey, 604800, 1209600, async ()=>{
    const controller = new AbortController();
    const timer = setTimeout(()=>controller.abort(), 5000);
    try {
      const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json?access_token=${apiKey}`;
      const res = await fetch(url, {
        signal: controller.signal
      });
      clearTimeout(timer);
      if (res.status >= 400 && res.status < 500) {
        console.error('[provider-adapters] Mapbox reverse-geocode HTTP', res.status);
        throw new Error(`Mapbox reverse-geocode HTTP ${res.status}`);
      }
      if (res.status >= 500) {
        await sleep(2000);
        const res2 = await fetch(url);
        if (!res2.ok) throw new Error(`Mapbox reverse-geocode 5xx: ${res2.status}`);
        return await res2.json();
      }
      return await res.json();
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  });
  logMonitoringCall({
    service: 'mapbox',
    endpoint: 'reverse-geocode',
    status: result.status,
    cacheHit: result.provenance.cacheHit,
    durationMs: Date.now() - t0,
    costUsd: 0.0005
  });
  return result;
}
// ---------------------------------------------------------------------------
// Adapter: Mapbox Directions
// ---------------------------------------------------------------------------
async function adapterMapboxDirections(coordinates, profile) {
  if (isMock()) return mockResult('mapbox', mockMapboxDirections(profile));
  const apiKey = MAPBOX_TOKEN;
  if (!apiKey) return {
    data: null,
    status: 'unavailable',
    provenance: {
      provider: 'mapbox',
      fetchedAt: new Date().toISOString(),
      cacheHit: false,
      stale: false
    },
    safeFailureMessage: 'MAPBOX_ACCESS_TOKEN or MAPBOX_API_KEY not configured'
  };
  const coordString = coordinates.map(([lng, lat])=>`${lng},${lat}`).join(';');
  // FIX 2026-09-19 (3a) — profile leads the key and the coordinates use the same
  // canonical string the request URL uses, so two profiles cannot collide and
  // the key does not depend on JSON.stringify formatting.
  const cacheKey = `mapbox:directions:v2:${profile}:${coordString}`;
  const { ttl, maxStale } = routeCachePolicy(profile);
  const t0 = Date.now();
  const result = await runProvider('mapbox', cacheKey, ttl, maxStale, async ()=>{
    const controller = new AbortController();
    const timer = setTimeout(()=>controller.abort(), 5000);
    try {
      const url = `https://api.mapbox.com/directions/v5/mapbox/${profile}/${coordString}?access_token=${apiKey}&alternatives=true&steps=true`;
      const res = await fetch(url, {
        signal: controller.signal
      });
      clearTimeout(timer);
      if (res.status >= 400 && res.status < 500) {
        console.error('[provider-adapters] Mapbox directions HTTP', res.status);
        throw new Error(`Mapbox directions HTTP ${res.status}`);
      }
      if (res.status >= 500) {
        await sleep(2000);
        const res2 = await fetch(url);
        if (!res2.ok) throw new Error(`Mapbox directions 5xx: ${res2.status}`);
        return await res2.json();
      }
      return await res.json();
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  });
  logMonitoringCall({
    service: 'mapbox',
    endpoint: 'directions',
    status: result.status,
    cacheHit: result.provenance.cacheHit,
    durationMs: Date.now() - t0,
    costUsd: 0.001
  });
  return result;
}
// ---------------------------------------------------------------------------
// Adapter: Mapbox Matrix
// ---------------------------------------------------------------------------
async function adapterMapboxMatrix(coordinates, profile) {
  if (isMock()) return mockResult('mapbox', mockMapboxMatrix(profile));
  const apiKey = MAPBOX_TOKEN;
  if (!apiKey) return {
    data: null,
    status: 'unavailable',
    provenance: {
      provider: 'mapbox',
      fetchedAt: new Date().toISOString(),
      cacheHit: false,
      stale: false
    },
    safeFailureMessage: 'MAPBOX_ACCESS_TOKEN or MAPBOX_API_KEY not configured'
  };
  const coordString = coordinates.map(([lng, lat])=>`${lng},${lat}`).join(';');
  // FIX 2026-09-19 (3a) — same defect as /mapbox/directions: a 'driving-traffic'
  // matrix was cached for 7 days. Same profile-aware policy and same key shape.
  const cacheKey = `mapbox:matrix:v2:${profile}:${coordString}`;
  const { ttl, maxStale } = routeCachePolicy(profile);
  const t0 = Date.now();
  const result = await runProvider('mapbox', cacheKey, ttl, maxStale, async ()=>{
    const controller = new AbortController();
    const timer = setTimeout(()=>controller.abort(), 5000);
    try {
      const url = `https://api.mapbox.com/matrix/v1/mapbox/${profile}/${coordString}?access_token=${apiKey}`;
      const res = await fetch(url, {
        signal: controller.signal
      });
      clearTimeout(timer);
      if (res.status >= 400 && res.status < 500) {
        console.error('[provider-adapters] Mapbox matrix HTTP', res.status);
        throw new Error(`Mapbox matrix HTTP ${res.status}`);
      }
      if (res.status >= 500) {
        await sleep(2000);
        const res2 = await fetch(url);
        if (!res2.ok) throw new Error(`Mapbox matrix 5xx: ${res2.status}`);
        return await res2.json();
      }
      return await res.json();
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  });
  logMonitoringCall({
    service: 'mapbox',
    endpoint: 'matrix',
    status: result.status,
    cacheHit: result.provenance.cacheHit,
    durationMs: Date.now() - t0,
    costUsd: 0.002
  });
  return result;
}
// ---------------------------------------------------------------------------
// Adapter: Google Places — Text Search (Places API (New) places:searchText)
// ---------------------------------------------------------------------------
async function adapterGooglePlacesSearch(query, location, radius) {
  const apiKey = env('GOOGLE_PLACES_API_KEY');
  if (!apiKey) return {
    status: 'unavailable',
    data: null,
    provenance: {
      provider: 'google_places',
      fetchedAt: new Date().toISOString(),
      cacheHit: false,
      stale: false
    }
  };
  if (isMock()) return mockResult('google_places', mockGooglePlacesSearch());
  const cacheKey = `google_places:search:${query}:${location}:${radius}`;
  const t0 = Date.now();
  const result = await runProvider('google-places', cacheKey, 86400, 172800, async ()=>{
    const controller = new AbortController();
    const timer = setTimeout(()=>controller.abort(), 5000);
    try {
      const url = 'https://places.googleapis.com/v1/places:searchText';
      const payload = {
        textQuery: query,
        maxResultCount: 20
      };
      const center = parseLatLngPair(location);
      if (center) {
        payload.locationBias = {
          circle: {
            center: {
              latitude: center.lat,
              longitude: center.lng
            },
            radius: clampRadius(radius, 50000)
          }
        };
      }
      const init = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': GP_SEARCH_FIELD_MASK
        },
        body: JSON.stringify(payload)
      };
      const res = await fetch(url, {
        ...init,
        signal: controller.signal
      });
      clearTimeout(timer);
      if (res.status >= 400 && res.status < 500) {
        console.error('[provider-adapters] Google Places searchText 4xx:', res.status, await googleErrorDetail(res));
        throw Object.assign(new Error(`Google Places 4xx: ${res.status}`), {
          is4xx: true
        });
      }
      if (res.status >= 500) {
        await sleep(2000);
        const res2 = await fetch(url, init);
        if (!res2.ok) throw new Error(`Google Places 5xx: ${res2.status}`);
        return toLegacyTextSearchResponse(await res2.json());
      }
      if (!res.ok) throw new Error(`Google Places searchText ${res.status}`);
      return toLegacyTextSearchResponse(await res.json());
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  });
  logMonitoringCall({
    service: 'google_places',
    endpoint: 'search',
    status: result.status,
    cacheHit: result.provenance.cacheHit,
    durationMs: Date.now() - t0,
    costUsd: 0.017
  });
  return result;
}
// ---------------------------------------------------------------------------
// Adapter: Google Places — Place Details (Places API (New) GET /v1/places/{id})
// ---------------------------------------------------------------------------
async function adapterGooglePlacesDetails(placeId) {
  const apiKey = env('GOOGLE_PLACES_API_KEY');
  if (!apiKey) return {
    status: 'unavailable',
    data: null,
    provenance: {
      provider: 'google_places',
      fetchedAt: new Date().toISOString(),
      cacheHit: false,
      stale: false
    }
  };
  if (isMock()) return mockResult('google_places', mockGooglePlacesDetails());
  const cacheKey = `google_places:details:${placeId}`;
  const t0 = Date.now();
  const result = await runProvider('google-places', cacheKey, 86400, 172800, async ()=>{
    const controller = new AbortController();
    const timer = setTimeout(()=>controller.abort(), 5000);
    try {
      const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`;
      const init = {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': GP_DETAILS_FIELD_MASK
        }
      };
      const res = await fetch(url, {
        ...init,
        signal: controller.signal
      });
      clearTimeout(timer);
      if (res.status >= 400 && res.status < 500) {
        console.error('[provider-adapters] Google Places details 4xx:', res.status, await googleErrorDetail(res));
        throw Object.assign(new Error(`Google Places 4xx: ${res.status}`), {
          is4xx: true
        });
      }
      if (res.status >= 500) {
        await sleep(2000);
        const res2 = await fetch(url, init);
        if (!res2.ok) throw new Error(`Google Places 5xx: ${res2.status}`);
        return toLegacyDetailsResponse(await res2.json());
      }
      if (!res.ok) throw new Error(`Google Places details ${res.status}`);
      return toLegacyDetailsResponse(await res.json());
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  });
  logMonitoringCall({
    service: 'google_places',
    endpoint: 'details',
    status: result.status,
    cacheHit: result.provenance.cacheHit,
    durationMs: Date.now() - t0,
    costUsd: 0.017
  });
  return result;
}
// ---------------------------------------------------------------------------
// Adapter: Google Places — Autocomplete (Places API (New) places:autocomplete)
// ---------------------------------------------------------------------------
// Autocomplete (New) is the one method in this family that does not take an
// X-Goog-FieldMask: it returns a fixed response shape and is billed per
// request, so no mask header is sent here.
async function adapterGooglePlacesAutocomplete(input, components) {
  const apiKey = env('GOOGLE_PLACES_API_KEY');
  if (!apiKey) return {
    status: 'unavailable',
    data: null,
    provenance: {
      provider: 'google_places',
      fetchedAt: new Date().toISOString(),
      cacheHit: false,
      stale: false
    }
  };
  if (isMock()) return mockResult('google_places', mockGooglePlacesAutocomplete());
  const cacheKey = `google_places:autocomplete:${input}:${components}`;
  const t0 = Date.now();
  const result = await runProvider('google-places', cacheKey, 86400, 172800, async ()=>{
    const controller = new AbortController();
    const timer = setTimeout(()=>controller.abort(), 5000);
    try {
      const url = 'https://places.googleapis.com/v1/places:autocomplete';
      const payload = {
        input
      };
      const regionCodes = toRegionCodes(components);
      if (regionCodes.length) payload.includedRegionCodes = regionCodes;
      const init = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey
        },
        body: JSON.stringify(payload)
      };
      const res = await fetch(url, {
        ...init,
        signal: controller.signal
      });
      clearTimeout(timer);
      if (res.status >= 400 && res.status < 500) {
        console.error('[provider-adapters] Google Places autocomplete 4xx:', res.status, await googleErrorDetail(res));
        throw Object.assign(new Error(`Google Places 4xx: ${res.status}`), {
          is4xx: true
        });
      }
      if (res.status >= 500) {
        await sleep(2000);
        const res2 = await fetch(url, init);
        if (!res2.ok) throw new Error(`Google Places 5xx: ${res2.status}`);
        return toLegacyAutocompleteResponse(await res2.json());
      }
      if (!res.ok) throw new Error(`Google Places autocomplete ${res.status}`);
      return toLegacyAutocompleteResponse(await res.json());
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  });
  logMonitoringCall({
    service: 'google_places',
    endpoint: 'autocomplete',
    status: result.status,
    cacheHit: result.provenance.cacheHit,
    durationMs: Date.now() - t0,
    costUsd: 0.00283
  });
  return result;
}
// ---------------------------------------------------------------------------
// Health endpoint
// ---------------------------------------------------------------------------
async function adapterHealth() {
  const [circuits, quotas, cacheStats] = await Promise.all([
    supabase.from('provider_circuit').select('*'),
    supabase.from('provider_quota').select('*').eq('date', new Date().toISOString().split('T')[0]),
    supabase.from('provider_cache').select('provider, expires_at').limit(1000)
  ]);
  const now = new Date();
  const cacheRows = cacheStats.data ?? [];
  const hitsByProvider = {};
  for (const row of cacheRows){
    if (!hitsByProvider[row.provider]) hitsByProvider[row.provider] = {
      total: 0,
      fresh: 0
    };
    hitsByProvider[row.provider].total++;
    if (new Date(row.expires_at) > now) hitsByProvider[row.provider].fresh++;
  }
  return {
    circuits: circuits.data ?? [],
    quotas: quotas.data ?? [],
    cacheHitRates: Object.fromEntries(Object.entries(hitsByProvider).map(([p, v])=>[
        p,
        {
          total: v.total,
          freshPct: v.total ? Math.round(v.fresh / v.total * 100) : 0
        }
      ])),
    timestamp: now.toISOString()
  };
}
// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
async function authenticate(req) {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return null;
  return {
    userId: data.user.id,
    email: data.user.email ?? '',
    metadata: data.user.user_metadata ?? {}
  };
}
function isStaff(user) {
  if (user.metadata?.is_staff === true) return true;
  if (user.email.endsWith('@travelos.app')) return true;
  return false;
}
// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') return new Response(null, {
    status: 204,
    headers: CORS_HEADERS
  });
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/provider-adapters/, '').replace(/^\/?/, '/');
  const user = await authenticate(req);
  if (!user) return corsResponse({
    error: 'Unauthorized'
  }, 401);
  try {
    // GET /health
    if (req.method === 'GET' && path === '/health') {
      if (!isStaff(user)) return corsResponse({
        error: 'Forbidden'
      }, 403);
      return corsResponse(await adapterHealth());
    }
    // GET /weather
    if (req.method === 'GET' && path === '/weather') {
      const lat = parseFloat(url.searchParams.get('lat') ?? '');
      const lon = parseFloat(url.searchParams.get('lon') ?? '');
      if (isNaN(lat) || isNaN(lon)) return corsResponse({
        error: 'lat and lon required'
      }, 400);
      return corsResponse(await adapterWeather(lat, lon));
    }
    // GET /weather-alerts
    if (req.method === 'GET' && path === '/weather-alerts') {
      const lat = parseFloat(url.searchParams.get('lat') ?? '');
      const lon = parseFloat(url.searchParams.get('lon') ?? '');
      if (isNaN(lat) || isNaN(lon)) return corsResponse({
        error: 'lat and lon required'
      }, 400);
      return corsResponse(await adapterWeatherAlerts(lat, lon));
    }
    // GET /earthquakes
    if (req.method === 'GET' && path === '/earthquakes') {
      const lat = parseFloat(url.searchParams.get('lat') ?? '');
      const lon = parseFloat(url.searchParams.get('lon') ?? '');
      if (isNaN(lat) || isNaN(lon)) return corsResponse({
        error: 'lat and lon required'
      }, 400);
      return corsResponse(await adapterEarthquakes(lat, lon));
    }
    // GET /disasters
    if (req.method === 'GET' && path === '/disasters') {
      const lat = parseFloat(url.searchParams.get('lat') ?? '');
      const lon = parseFloat(url.searchParams.get('lon') ?? '');
      if (isNaN(lat) || isNaN(lon)) return corsResponse({
        error: 'lat and lon required'
      }, 400);
      return corsResponse(await adapterDisasters(lat, lon));
    }
    // GET /advisory/us
    if (req.method === 'GET' && path === '/advisory/us') {
      const iso2 = url.searchParams.get('iso2');
      if (!iso2) return corsResponse({
        error: 'iso2 required'
      }, 400);
      return corsResponse(await adapterAdvisoryUS(iso2));
    }
    // GET /advisory/uk
    if (req.method === 'GET' && path === '/advisory/uk') {
      const countrySlug = url.searchParams.get('countrySlug');
      if (!countrySlug) return corsResponse({
        error: 'countrySlug required'
      }, 400);
      return corsResponse(await adapterAdvisoryUK(countrySlug));
    }
    // GET /disease-outbreaks
    if (req.method === 'GET' && path === '/disease-outbreaks') {
      return corsResponse(await adapterDiseaseOutbreaks());
    }
    // GET /air-quality
    if (req.method === 'GET' && path === '/air-quality') {
      const lat = parseFloat(url.searchParams.get('lat') ?? '');
      const lon = parseFloat(url.searchParams.get('lon') ?? '');
      if (isNaN(lat) || isNaN(lon)) return corsResponse({
        error: 'lat and lon required'
      }, 400);
      return corsResponse(await adapterAirQuality(lat, lon));
    }
    // POST /places/nearby
    if (req.method === 'POST' && path === '/places/nearby') {
      const body = await req.json().catch(()=>({}));
      const { lat, lon, radius, types } = body;
      if (typeof lat !== 'number' || typeof lon !== 'number') return corsResponse({
        error: 'lat and lon required'
      }, 400);
      return corsResponse(await adapterPlacesNearby(lat, lon, radius, types));
    }
    // GET /places/search
    if (req.method === 'GET' && path === '/places/search') {
      const query = url.searchParams.get('query');
      if (!query) return corsResponse({
        error: 'query required'
      }, 400);
      return corsResponse(await adapterPlacesSearch(query));
    }
    // GET /flight
    if (req.method === 'GET' && path === '/flight') {
      const ident = url.searchParams.get('ident');
      if (!ident) return corsResponse({
        error: 'ident required'
      }, 400);
      const scheduledOut = url.searchParams.get('scheduledOut') ?? undefined;
      return corsResponse(await adapterFlightStatus(ident, scheduledOut));
    }
    // GET /geocode
    if (req.method === 'GET' && path === '/geocode') {
      const q = url.searchParams.get('q');
      if (!q) return corsResponse({
        error: 'q required'
      }, 400);
      return corsResponse(await adapterGeocode(q));
    }
    // GET /fx-rates
    if (req.method === 'GET' && path === '/fx-rates') {
      return corsResponse(await adapterFxRates());
    }
    // GET /events
    if (req.method === 'GET' && path === '/events') {
      const lat = parseFloat(url.searchParams.get('lat') ?? '');
      const lon = parseFloat(url.searchParams.get('lon') ?? '');
      const start = url.searchParams.get('start') ?? new Date().toISOString();
      const end = url.searchParams.get('end') ?? new Date(Date.now() + 7 * 86400_000).toISOString();
      if (isNaN(lat) || isNaN(lon)) return corsResponse({
        error: 'lat and lon required'
      }, 400);
      return corsResponse(await adapterEvents(lat, lon, start, end));
    }
    // GET /lodging
    if (req.method === 'GET' && path === '/lodging') {
      const lat = parseFloat(url.searchParams.get('lat') ?? '');
      const lon = parseFloat(url.searchParams.get('lon') ?? '');
      const checkIn = url.searchParams.get('checkIn') ?? '';
      const checkOut = url.searchParams.get('checkOut') ?? '';
      if (isNaN(lat) || isNaN(lon)) return corsResponse({
        error: 'lat and lon required'
      }, 400);
      return corsResponse(await adapterLodging(lat, lon, checkIn, checkOut));
    }
    // -------------------------------------------------------------------------
    // TripAdvisor routes
    // -------------------------------------------------------------------------
    // GET /tripadvisor/search
    if (req.method === 'GET' && path === '/tripadvisor/search') {
      const query = url.searchParams.get('query');
      if (!query) return corsResponse({
        error: 'query required'
      }, 400);
      const language = url.searchParams.get('language') ?? 'en';
      return corsResponse(await adapterTripAdvisorSearch(query, language));
    }
    // GET /tripadvisor/details/:locationId
    if (req.method === 'GET' && path.startsWith('/tripadvisor/details/')) {
      const locationId = path.replace('/tripadvisor/details/', '');
      if (!locationId) return corsResponse({
        error: 'locationId required'
      }, 400);
      const language = url.searchParams.get('language') ?? 'en';
      return corsResponse(await adapterTripAdvisorDetails(locationId, language));
    }
    // GET /tripadvisor/nearby
    if (req.method === 'GET' && path === '/tripadvisor/nearby') {
      const lat = parseFloat(url.searchParams.get('lat') ?? '');
      const lng = parseFloat(url.searchParams.get('lng') ?? '');
      if (isNaN(lat) || isNaN(lng)) return corsResponse({
        error: 'lat and lng required'
      }, 400);
      const language = url.searchParams.get('language') ?? 'en';
      return corsResponse(await adapterTripAdvisorNearby(lat, lng, language));
    }
    // GET /tripadvisor/reviews/:locationId
    if (req.method === 'GET' && path.startsWith('/tripadvisor/reviews/')) {
      const locationId = path.replace('/tripadvisor/reviews/', '');
      if (!locationId) return corsResponse({
        error: 'locationId required'
      }, 400);
      const language = url.searchParams.get('language') ?? 'en';
      return corsResponse(await adapterTripAdvisorReviews(locationId, language));
    }
    // -------------------------------------------------------------------------
    // Ticketmaster routes
    // -------------------------------------------------------------------------
    // GET /ticketmaster/events
    if (req.method === 'GET' && path === '/ticketmaster/events') {
      const city = url.searchParams.get('city') ?? '';
      const countryCode = url.searchParams.get('countryCode') ?? 'US';
      const startDateTime = url.searchParams.get('startDateTime') ?? '';
      const endDateTime = url.searchParams.get('endDateTime') ?? '';
      const keyword = url.searchParams.get('keyword') ?? '';
      const size = parseInt(url.searchParams.get('size') ?? '20', 10);
      return corsResponse(await adapterTicketmasterEvents(city, countryCode, startDateTime, endDateTime, keyword, isNaN(size) ? 20 : size));
    }
    // GET /ticketmaster/events/:eventId
    if (req.method === 'GET' && path.startsWith('/ticketmaster/events/')) {
      const eventId = path.replace('/ticketmaster/events/', '');
      if (!eventId) return corsResponse({
        error: 'eventId required'
      }, 400);
      return corsResponse(await adapterTicketmasterEventDetail(eventId));
    }
    // GET /ticketmaster/venues/:venueId
    if (req.method === 'GET' && path.startsWith('/ticketmaster/venues/')) {
      const venueId = path.replace('/ticketmaster/venues/', '');
      if (!venueId) return corsResponse({
        error: 'venueId required'
      }, 400);
      return corsResponse(await adapterTicketmasterVenueDetail(venueId));
    }
    // GET /ticketmaster/attractions/:attractionId
    if (req.method === 'GET' && path.startsWith('/ticketmaster/attractions/')) {
      const attractionId = path.replace('/ticketmaster/attractions/', '');
      if (!attractionId) return corsResponse({
        error: 'attractionId required'
      }, 400);
      return corsResponse(await adapterTicketmasterAttractionDetail(attractionId));
    }
    // -------------------------------------------------------------------------
    // Mapbox routes
    // -------------------------------------------------------------------------
    // GET /mapbox/geocode
    if (req.method === 'GET' && path === '/mapbox/geocode') {
      const query = url.searchParams.get('query');
      if (!query) return corsResponse({
        error: 'query required'
      }, 400);
      const limit = parseInt(url.searchParams.get('limit') ?? '10', 10);
      return corsResponse(await adapterMapboxGeocode(query, isNaN(limit) ? 10 : limit));
    }
    // GET /mapbox/reverse-geocode
    if (req.method === 'GET' && path === '/mapbox/reverse-geocode') {
      const lat = parseFloat(url.searchParams.get('lat') ?? '');
      const lng = parseFloat(url.searchParams.get('lng') ?? '');
      if (isNaN(lat) || isNaN(lng)) return corsResponse({
        error: 'lat and lng required'
      }, 400);
      return corsResponse(await adapterMapboxReverseGeocode(lat, lng));
    }
    // GET /mapbox/directions
    if (req.method === 'GET' && path === '/mapbox/directions') {
      const coordinatesParam = url.searchParams.get('coordinates');
      if (!coordinatesParam) return corsResponse({
        error: 'coordinates required'
      }, 400);
      let coordinates;
      try {
        coordinates = JSON.parse(coordinatesParam);
        if (!Array.isArray(coordinates) || coordinates.length < 2) throw new Error('invalid');
      } catch  {
        return corsResponse({
          error: 'coordinates must be a JSON array of [lng, lat] pairs with at least 2 points'
        }, 400);
      }
      const profile = url.searchParams.get('profile') ?? 'driving';
      return corsResponse(await adapterMapboxDirections(coordinates, profile));
    }
    // GET /mapbox/matrix
    if (req.method === 'GET' && path === '/mapbox/matrix') {
      const coordinatesParam = url.searchParams.get('coordinates');
      if (!coordinatesParam) return corsResponse({
        error: 'coordinates required'
      }, 400);
      let coordinates;
      try {
        coordinates = JSON.parse(coordinatesParam);
        if (!Array.isArray(coordinates) || coordinates.length < 2) throw new Error('invalid');
      } catch  {
        return corsResponse({
          error: 'coordinates must be a JSON array of [lng, lat] pairs with at least 2 points'
        }, 400);
      }
      const profile = url.searchParams.get('profile') ?? 'driving';
      return corsResponse(await adapterMapboxMatrix(coordinates, profile));
    }
    // -------------------------------------------------------------------------
    // Google Places routes (v6)
    // -------------------------------------------------------------------------
    // GET /google-places/search
    if (req.method === 'GET' && path === '/google-places/search') {
      const query = url.searchParams.get('query');
      const location = url.searchParams.get('location');
      if (!query) return corsResponse({
        error: 'query required'
      }, 400);
      if (!location) return corsResponse({
        error: 'location required'
      }, 400);
      const radius = parseInt(url.searchParams.get('radius') ?? '50000', 10);
      return corsResponse(await adapterGooglePlacesSearch(query, location, isNaN(radius) ? 50000 : radius));
    }
    // GET /google-places/details/:placeId
    if (req.method === 'GET' && path.startsWith('/google-places/details/')) {
      const placeId = path.replace('/google-places/details/', '');
      if (!placeId) return corsResponse({
        error: 'placeId required'
      }, 400);
      return corsResponse(await adapterGooglePlacesDetails(placeId));
    }
    // GET /google-places/autocomplete
    if (req.method === 'GET' && path === '/google-places/autocomplete') {
      const input = url.searchParams.get('input');
      if (!input) return corsResponse({
        error: 'input required'
      }, 400);
      const components = url.searchParams.get('components') ?? '';
      return corsResponse(await adapterGooglePlacesAutocomplete(input, components));
    }
    return corsResponse({
      error: 'Not found'
    }, 404);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[provider-adapters] unhandled error:', msg);
    return corsResponse({
      error: 'Internal server error',
      detail: msg
    }, 500);
  }
});

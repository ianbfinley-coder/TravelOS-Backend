// PLACES PHOTO KEY REMOVED FROM URLS 2026-09-25
// ---------------------------------------------------------------------------
// googlePlacesSearch() used to build
//   https://places.googleapis.com/v1/<photoName>/media?maxWidthPx=400&key=<GOOGLE_PLACES_API_KEY>
// and return it as imageUrl, which also went into recommendations.image_url.
// That handed the server-side Google key to every client and persisted it in
// the cache table. Now:
//   * items carry photo_ref (the Places photo resource name,
//     "places/<placeId>/photos/<ref>") and imageUrl is a key-free relative
//     proxy path: /functions/v1/recommendations?action=photo&ref=<photo_ref>&maxwidth=400
//     (null-ish/undefined when there is no photo). Clients must fetch it with
//     the same Authorization + apikey headers as any other call here.
//   * GET ?action=photo&ref=...&maxwidth=... is authenticated exactly like the
//     other actions (gateway verify_jwt + supabase.auth.getUser), validates ref
//     against the Places photo-name charset, calls only places.googleapis.com
//     with the key in the X-Goog-Api-Key header, and streams the bytes back
//     with the upstream Content-Type and Cache-Control: private, max-age=86400.
//   * public.recommendations and public.saved_recommendations were checked on
//     2026-09-25: 0 rows had 'key=' in image_url (both tables empty), so no
//     data scrub was needed.
// ---------------------------------------------------------------------------
// FABRICATION REMOVED 2026-09-19 — invented places, invented distances,
// invented price bands and invented editorial taglines, all cached as real.
// ---------------------------------------------------------------------------
// If you are reading this with no other context: when no provider returned
// results, this function used to answer with a hard-coded list of places that
// do not exist — 'La Maison Bistro', 'Sunset Boat Tour', 'Boutique Heritage
// Hotel' — each with a specific rating, a specific review count, a price band
// and a description, none of which describe anything real:
//
//   const MOCK_DATA: Record<string, any[]> = {
//     dining: [
//       { name: 'La Maison Bistro', rating: 4.6, reviewCount: 890, price: '$$',
//         description: 'Cozy French bistro with seasonal menu and excellent wine list', ... },
//       ...
//   function generateMockRecommendations(category, location, limit) {
//     return items.slice(0, limit).map((item, i) => ({
//       id: `mock_${category}_${i}_${location...}`,
//       ...item,
//       location,                                   // <- labelled with the REAL city
//       latitude: 48.8566 + (Math.random() - 0.5) * 0.1,   // <- Paris, always
//       longitude: 2.3522 + (Math.random() - 0.5) * 0.1,
//       source: 'mock',
//     }));
//   }
//   if (rawItems.length === 0) {
//     rawItems = generateMockRecommendations(category, location, limit * 2);
//   }
//
// Note the coordinates: every invented place was dropped at a random point
// within ~5km of the centre of Paris and then labelled with whatever city the
// traveller actually searched. A traveller in Tokyo was handed a French bistro
// with a 4.6 rating, 890 reviews and a map pin in the 1st arrondissement.
//
// The response did carry `source: 'mock'`, which is more honesty than most of
// this codebase managed. But the rows were then written to the
// public.recommendations cache by cacheRecommendations(), where they sit
// beside real Google Places and TripAdvisor rows. `get_cached` and
// `getCachedRecommendations` select * and never filter on source, so on the
// next request the invented bistro came back through the CACHE path and was
// served as `source: 'cache'` — the 'mock' label did not travel with it, and a
// traveller could save it, and it would be counted in trending.
//
// Three smaller inventions in the same file, all removed:
//
//   1. estimateDistance() returned a "distance" in kilometres computed from the
//      character codes of two strings:
//        const h1 = loc1.split('').reduce((a, b) => a + b.charCodeAt(0), 0);
//        const h2 = loc2.split('').reduce((a, b) => a + b.charCodeAt(0), 0);
//        return Math.abs(h1 - h2) / 200;
//      That number drove scoreProximity() and was persisted to
//      recommendations.score_proximity. It is now a real haversine distance
//      between the geocoded search centre and the provider's own coordinates,
//      and where either is missing the proximity factor is null (unknown)
//      rather than a number.
//   2. A missing price level became '$$' — a price band asserted about a real
//      business the provider declined to rate. Now null. (Google's
//      PRICE_LEVEL_FREE was also being mapped to '$$'; free is now 'free'.)
//   3. generateTagline() picked an editorial claim about a real business —
//      'Hidden gem', 'Highly rated', 'Local favorite' — by hashing its name:
//        const idx = seed.split('').reduce((a, b) => a + b.charCodeAt(0), 0) % options.length;
//      A hash cannot know a restaurant is a local favourite. Taglines are now
//      null unless the provider supplied one.
//
// Unknown factor scores are now null rather than a stand-in number, and the
// weighted score renormalizes over the factors that are actually known, so an
// unknown does not silently score as average. `timing` was a literal 85 for
// every item — nothing computes it — so it is null until something does.
//
// WHAT IT DOES NOW
// When no provider returns anything, `get_recommendations` returns zero
// results with a reason (the project's ProviderResult envelope, see
// PROMPT_5A2) and CACHES NOTHING. Only rows that came from a provider are
// ever written to public.recommendations.
//
// Rows already in the database: public.recommendations was checked on
// 2026-09-19 and held 0 rows, so no fabricated recommendation is cached. Any
// row whose id begins 'mock_' or whose source is 'mock' is fabricated.
//
// Residual, NOT fixed here and needing a DDL change rather than a code change:
// public.saved_recommendations defaults rating to 0 and price to '$$' at the
// column level, so a row inserted without them still gets a made-up price
// band. This function now passes explicit nulls, which override those
// defaults, but the defaults themselves should be dropped.
// ---------------------------------------------------------------------------
// MIGRATION 2026-09-17 — Google Places: legacy API -> Places API (New)
// ---------------------------------------------------------------------------
// Both Google calls in this file were dead. Probed live on 2026-09-17 with
// this project's real GOOGLE_PLACES_API_KEY:
//
//   GET maps.googleapis.com/maps/api/place/findplacefromtext/json
//       -> HTTP 200, status REQUEST_DENIED, "You're calling a legacy API,
//          which is not enabled for your project. To get newer features and
//          more functionality, switch to the Places API (New) or Routes API."
//   GET maps.googleapis.com/maps/api/geocode/json
//       -> HTTP 200, status REQUEST_DENIED, "This API is not activated on
//          your API project."
//   POST places.googleapis.com/v1/places:searchText
//       (X-Goog-Api-Key + X-Goog-FieldMask) -> HTTP 200, OK.
//
// The key, its restrictions and billing are all fine. Google does not enable
// the legacy Maps/Places APIs on Cloud projects created after March 2025 and
// never will for this project, so there is no console switch that fixes this.
//
// Note the failure mode: the legacy endpoints answer HTTP 200 and carry the
// rejection inside the body, so the existing res.ok checks could not see it.
// geocodeLocation found no data.results and returned null, which meant the
// whole Google enrichment path silently no-opped on every request and every
// result served from this function was in fact mock data — while the response
// still reported source: 'live' whenever an API key happened to be set.
//
// What changed:
//   * googlePlacesSearch  legacy /place/nearbysearch/json
//                         -> POST places.googleapis.com/v1/places:searchNearby
//                         with the mandatory X-Goog-FieldMask. Places API (New)
//                         returns a real non-2xx plus { error: { code, status,
//                         message } } on rejection, so the res.ok check now
//                         actually catches an upstream rejection instead of
//                         letting it through as an empty success.
//   * geocodeLocation     legacy /maps/api/geocode/json -> Mapbox forward
//                         geocoding. Mapbox is the primary geocoder in
//                         TravelOS and its token works; Google Geocoding is a
//                         separate legacy API that is equally not enabled here,
//                         so rather than adopt another New API surface just to
//                         turn a place name into coordinates, this now uses the
//                         Mapbox token (MAPBOX_ACCESS_TOKEN, falling back to
//                         MAPBOX_API_KEY, matching provider-adapters).
//   * source: 'live' is now reported only when at least one item actually came
//     back from a provider, not merely because a key was configured.
//   * env() helper: every env read is trimmed, and a whitespace-only secret is
//     treated as absent. A live probe on this project found a credential stored
//     with trailing whitespace, which reaches an HTTP header as-is and fails in
//     a way that looks identical to a bad key.
//
// The items this function produces keep exactly the internal shape they had
// (id, placeId, name, location, latitude, longitude, rating, reviewCount,
// price, description, imageUrl, bookingUrl, openNow, tags, source) and the
// outward response shape of every action is unchanged. The New API field names
// (id, displayName.text, formattedAddress, location.latitude/longitude,
// userRatingCount, currentOpeningHours.openNow, priceLevel as an enum string)
// are mapped back to that internal shape here and are not propagated outward.
// The New API omits the places key entirely when there are no matches, which
// is treated as zero results rather than as an error.
// ---------------------------------------------------------------------------
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
/** Env reads are trimmed: a stray space or newline from a copy-paste otherwise
 *  reaches an HTTP header or query string and fails in ways that look like a
 *  bad key. Every env read in this file goes through this helper. */ function env(name) {
  const v = Deno.env.get(name)?.trim();
  return v ? v : undefined;
}
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
const json = (data)=>new Response(JSON.stringify(data), {
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json'
    }
  });
// ─── Scoring Engine ──────────────────────────────────────────────
const WEIGHTS = {
  preferences: 0.25,
  proximity: 0.15,
  timing: 0.15,
  quality: 0.20,
  budget: 0.15,
  context: 0.10
};
/** null when the traveller has recorded no interests: there is nothing to
 *  match against, which is not the same as a middling match. */ function scorePreferences(item, _category, profile) {
  const interests = profile.interests || [];
  if (interests.length === 0) return null;
  const tags = item.tags || [];
  const matches = interests.filter((interest)=>tags.some((tag)=>tag.toLowerCase().includes(interest.toLowerCase()))).length;
  return Math.min(100, 50 + matches * 15);
}
/** Real great-circle distance in km. Replaces estimateDistance(), which
 *  returned Math.abs(hash(a) - hash(b)) / 200 and called it kilometres. */ function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d)=>d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
function distanceFromCentre(item, centre) {
  if (!centre) return null;
  const lat = Number(item.latitude);
  const lng = Number(item.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat === 0 && lng === 0) return null; // provider placeholder, not the Gulf of Guinea
  return haversineKm(centre.lat, centre.lng, lat, lng);
}
function scoreProximity(distanceKm) {
  if (distanceKm === null) return null;
  if (distanceKm < 1) return 100;
  if (distanceKm < 5) return 90;
  if (distanceKm < 10) return 75;
  if (distanceKm < 25) return 50;
  return 25;
}
/** null when the provider reports no rating at all — unrated is not average. */ function scoreQuality(rating, reviewCount) {
  if (rating == null || !Number.isFinite(rating) || rating <= 0) return null;
  const ratingScore = rating / 5 * 100;
  const reviewBonus = Math.min(20, (reviewCount ?? 0) / 50);
  return Math.min(100, ratingScore + reviewBonus);
}
/** null when the provider gave no price level. Previously an unpriced place
 *  was scored as if it were '$$'. */ function scoreBudget(itemPrice, budgetLevel) {
  if (itemPrice == null) return null;
  const priceMap = {
    'free': 0,
    '$': 1,
    '$$': 2,
    '$$$': 3,
    '$$$$': 4
  };
  const budgetMap = {
    budget: 1,
    moderate: 2,
    luxury: 4
  };
  const pv = priceMap[itemPrice];
  if (pv === undefined) return null;
  const bv = budgetMap[budgetLevel] ?? 2;
  const diff = Math.abs(pv - bv);
  if (diff === 0) return 100;
  if (diff === 1) return 80;
  if (diff === 2) return 55;
  return 30;
}
function scoreContext(item, category) {
  let score = 75;
  if (category === 'dining' && item.cuisine) score += 5;
  if (category === 'accommodation' && item.amenities) score += 5;
  if (item.openNow === true) score += 10;
  return Math.min(100, score);
}
/** Renormalizes over the factors that are actually known, so an unknown factor
 *  neither helps nor hurts. With every factor known this is identical to the
 *  previous fixed-weight sum (the weights total 1.0). */ function calculateWeightedScore(factors) {
  let weighted = 0;
  let weightUsed = 0;
  for (const key of Object.keys(WEIGHTS)){
    const value = factors[key];
    if (value == null) continue;
    weighted += value * WEIGHTS[key];
    weightUsed += WEIGHTS[key];
  }
  if (weightUsed === 0) return null;
  return weighted / weightUsed;
}
function scoreItem(item, category, location, profile, centre) {
  const distanceKm = distanceFromCentre(item, centre);
  const factors = {
    preferences: scorePreferences(item, category, profile),
    proximity: scoreProximity(distanceKm),
    // Nothing in this function computes a timing score. It used to be the
    // literal 85 for every item, which looked like a measurement.
    timing: null,
    quality: scoreQuality(item.rating ?? null, item.reviewCount ?? null),
    budget: scoreBudget(item.price ?? null, profile.budgetLevel || 'moderate'),
    context: scoreContext(item, category)
  };
  const overallScore = calculateWeightedScore(factors);
  return {
    ...item,
    category,
    factors,
    overallScore: overallScore === null ? null : Math.round(overallScore * 10) / 10,
    distanceKm: distanceKm === null ? null : Math.round(distanceKm * 100) / 100,
    // Only a provider-supplied tagline. The old hash-picked editorial claim
    // ('Hidden gem', 'Local favorite') is gone.
    tagline: item.tagline ?? null,
    // recommendations.source is NOT NULL; every item here came from a provider
    // that set it, and 'unknown' is the honest fallback rather than 'mock'.
    source: item.source ?? 'unknown'
  };
}
// ─── Google Places Adapter (Places API (New)) ───────────────────────────
const CATEGORY_TYPE_MAP = {
  activity: 'tourist_attraction',
  dining: 'restaurant',
  accommodation: 'lodging',
  experience: 'museum',
  shopping: 'shopping_mall',
  nightlife: 'bar',
  transportation: 'transit_station'
};
// X-Goog-FieldMask is mandatory on Places API (New) and is billed by tier, so
// this lists only the paths the mapper below actually reads. Requesting '*'
// would bill at the highest tier.
//   places.id                          -> id, placeId
//   places.displayName                 -> name           (.text)
//   places.formattedAddress            -> location, description
//   places.location                    -> latitude, longitude (.latitude/.longitude)
//   places.rating                      -> rating
//   places.userRatingCount             -> reviewCount
//   places.priceLevel                  -> price          (enum string -> free/$ ... $$$$, or null)
//   places.currentOpeningHours.openNow -> openNow
//   places.types                       -> tags
//   places.websiteUri                  -> bookingUrl
//   places.photos                      -> imageUrl       ([0].name)
const GOOGLE_PLACES_FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.rating',
  'places.userRatingCount',
  'places.priceLevel',
  'places.currentOpeningHours.openNow',
  'places.types',
  'places.websiteUri',
  'places.photos'
].join(',');
/** null when the provider gave no price level. Previously defaulted to '$$',
 *  asserting a price band about a business Google declined to rate. */ function priceFromLevel(level) {
  if (level == null) return null;
  const map = {
    0: 'free',
    1: '$',
    2: '$$',
    3: '$$$',
    4: '$$$$'
  };
  return map[level] ?? null;
}
/** Places API (New) returns priceLevel as an enum string rather than the
 *  integer the legacy API used. PRICE_LEVEL_FREE used to fall through to '$$';
 *  it is now 'free'. An absent or unrecognised level is null, not a guess. */ function priceFromNewLevel(raw) {
  if (!raw) return null;
  const map = {
    PRICE_LEVEL_FREE: 0,
    PRICE_LEVEL_INEXPENSIVE: 1,
    PRICE_LEVEL_MODERATE: 2,
    PRICE_LEVEL_EXPENSIVE: 3,
    PRICE_LEVEL_VERY_EXPENSIVE: 4
  };
  const level = map[raw];
  return level === undefined ? null : priceFromLevel(level);
}
function tagsFromTypes(types) {
  return types.map((t)=>t.replace(/_/g, ' ')).slice(0, 5);
}
async function googlePlacesSearch(lat, lng, category, radius, apiKey) {
  const type = CATEGORY_TYPE_MAP[category] || 'tourist_attraction';
  // locationRestriction circles are capped at 50000 m by the New API.
  const safeRadius = Number.isFinite(radius) && radius > 0 ? Math.min(radius, 50000) : 5000;
  const res = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': GOOGLE_PLACES_FIELD_MASK
    },
    body: JSON.stringify({
      includedTypes: [
        type
      ],
      maxResultCount: 20,
      locationRestriction: {
        circle: {
          center: {
            latitude: lat,
            longitude: lng
          },
          radius: safeRadius
        }
      }
    })
  });
  if (!res.ok) {
    // Places API (New) reports a rejection as a non-2xx with a body of
    // { error: { code, status, message } }. Log it and return nothing rather
    // than letting it read as an empty success.
    const detail = await res.text().catch(()=>'');
    console.error('Google Places searchNearby rejected:', res.status, detail.slice(0, 300));
    throw new Error(`google_places_rejected_${res.status}`);
  }
  const data = await res.json();
  // An empty search omits the places key entirely; that is zero results.
  return (data.places || []).map((p)=>{
    const address = p.formattedAddress || '';
    const photoName = p.photos?.[0]?.name;
    return {
      id: p.id,
      placeId: p.id,
      name: p.displayName?.text || '',
      location: address,
      latitude: p.location?.latitude,
      longitude: p.location?.longitude,
      // null, not 0: 0 reads as a rating of zero stars.
      rating: typeof p.rating === 'number' ? p.rating : null,
      reviewCount: typeof p.userRatingCount === 'number' ? p.userRatingCount : null,
      price: priceFromNewLevel(p.priceLevel),
      description: address,
      // Never put the API key in a URL that leaves this function (2026-09-25).
      photo_ref: photoName && isValidPhotoRef(photoName) ? photoName : null,
      imageUrl: photoName && isValidPhotoRef(photoName) ? photoProxyPath(photoName, 400) : undefined,
      bookingUrl: p.websiteUri,
      openNow: p.currentOpeningHours?.openNow,
      tags: tagsFromTypes(p.types || []),
      source: 'google_places'
    };
  });
}
// ─── Places photo proxy (2026-09-25) ─────────────────────────────────
/** Places API (New) photo resource name: places/<placeId>/photos/<photoRef>.
 *  Strict charset so nothing but a Places photo path can reach the fetch. */ const PHOTO_REF_RE = /^places\/[A-Za-z0-9_-]{1,256}\/photos\/[A-Za-z0-9_-]{1,2048}$/;
function isValidPhotoRef(ref) {
  return PHOTO_REF_RE.test(ref);
}
function photoProxyPath(ref, maxWidth) {
  return `/functions/v1/recommendations?action=photo&ref=${encodeURIComponent(ref)}&maxwidth=${maxWidth}`;
}
async function proxyPlacesPhoto(url) {
  const ref = url.searchParams.get('ref') || '';
  if (!isValidPhotoRef(ref)) {
    return new Response(JSON.stringify({
      error: 'invalid_photo_ref'
    }), {
      status: 400,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
  const mwRaw = Number(url.searchParams.get('maxwidth') ?? '400');
  const maxWidth = Number.isFinite(mwRaw) ? Math.min(1600, Math.max(16, Math.round(mwRaw))) : 400;
  const apiKey = env('GOOGLE_PLACES_API_KEY');
  if (!apiKey) {
    return new Response(JSON.stringify({
      error: 'photo_provider_not_configured'
    }), {
      status: 503,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
  // Fixed host; ref is validated above, so the path cannot escape /v1/places/.
  const upstream = await fetch(`https://places.googleapis.com/v1/${ref}/media?maxWidthPx=${maxWidth}`, {
    headers: {
      'X-Goog-Api-Key': apiKey
    }
  });
  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(()=>'');
    console.error('Places photo rejected:', upstream.status, detail.slice(0, 300));
    return new Response(JSON.stringify({
      error: 'photo_unavailable'
    }), {
      status: 502,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
  return new Response(upstream.body, {
    status: 200,
    headers: {
      ...corsHeaders,
      'Content-Type': upstream.headers.get('Content-Type') || 'application/octet-stream',
      'Cache-Control': 'private, max-age=86400'
    }
  });
}
/** Mapbox forward geocoding. Replaces the Google Geocoding call, which was a
 *  legacy API not enabled on this Google project. Returns the same
 *  { lat, lng } shape the caller already expected. */ async function geocodeLocation(location, mapboxToken) {
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(location)}.json?access_token=${mapboxToken}&limit=1`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error('Mapbox geocode rejected:', res.status);
    return null;
  }
  const data = await res.json();
  const center = data.features?.[0]?.center;
  if (!Array.isArray(center) || center.length < 2) return null;
  return {
    lat: center[1],
    lng: center[0]
  };
}
// ─── TripAdvisor Adapter ────────────────────────────────────────────
function numberOrNull(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
async function tripAdvisorSearch(query, category, apiKey) {
  const url = `https://api.content.tripadvisor.com/api/v1/location/search?searchQuery=${encodeURIComponent(query)}&category=${category === 'dining' ? 'restaurants' : 'attractions'}&key=${apiKey}`;
  const res = await fetch(url, {
    headers: {
      accept: 'application/json'
    }
  });
  if (!res.ok) {
    const detail = await res.text().catch(()=>'');
    console.error('TripAdvisor rejected:', res.status, detail.slice(0, 300));
    throw new Error(`tripadvisor_rejected_${res.status}`);
  }
  const data = await res.json();
  return (data.data || []).slice(0, 10).map((r)=>({
      id: r.location_id,
      placeId: r.location_id,
      name: r.name,
      location: r.address_obj?.address_string || query,
      // null rather than 0 — absent coordinates are absent, not (0, 0).
      latitude: numberOrNull(r.latitude),
      longitude: numberOrNull(r.longitude),
      rating: numberOrNull(r.rating),
      reviewCount: numberOrNull(r.num_reviews),
      price: r.price_level ?? null,
      description: r.description || r.ranking_data?.ranking_string || r.address_obj?.address_string || '',
      imageUrl: undefined,
      bookingUrl: r.web_url,
      tags: [
        r.ranking_data?.ranking_string?.toLowerCase() || category
      ].filter(Boolean).slice(0, 5),
      source: 'tripadvisor'
    }));
}
// ─── Cache helpers ─────────────────────────────────────────────────
async function getCachedRecommendations(supabase, userId, location, category) {
  const { data, error } = await supabase.from('recommendations').select('*').eq('user_id', userId).eq('location', location).eq('category', category).gt('expires_at', new Date().toISOString()).order('overall_score', {
    ascending: false
  }).limit(20);
  if (error) {
    console.error('recommendations cache read failed:', error.message);
    return null;
  }
  return data?.length ? data : null;
}
async function cacheRecommendations(supabase, userId, tripId, location, category, items) {
  // Only provider-sourced items ever reach this function now. Nothing
  // generated locally is written to the recommendations table.
  if (items.length === 0) return;
  const rows = items.map((item)=>({
      id: item.id,
      trip_id: tripId,
      user_id: userId,
      category,
      location,
      name: item.name,
      description: item.description,
      rating: item.rating,
      review_count: item.reviewCount,
      price: item.price,
      image_url: item.imageUrl,
      booking_url: item.bookingUrl,
      latitude: item.latitude,
      longitude: item.longitude,
      tags: item.tags,
      tagline: item.tagline,
      source: item.source,
      score_preferences: item.factors.preferences,
      score_proximity: item.factors.proximity,
      score_timing: item.factors.timing,
      score_quality: item.factors.quality,
      score_budget: item.factors.budget,
      score_context: item.factors.context,
      overall_score: item.overallScore,
      place_id: item.placeId,
      open_now: item.openNow,
      phone: item.phone,
      expires_at: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString()
    }));
  const { error } = await supabase.from('recommendations').upsert(rows, {
    onConflict: 'id'
  });
  if (error) console.error('recommendations cache write failed:', error.message);
}
// ─── Main handler ───────────────────────────────────────────────
serve(async (req)=>{
  if (req.method === 'OPTIONS') return new Response('ok', {
    headers: corsHeaders
  });
  try {
    const supabase = createClient(env('SUPABASE_URL') ?? '', env('SUPABASE_ANON_KEY') ?? '', {
      global: {
        headers: {
          Authorization: req.headers.get('Authorization') || ''
        }
      }
    });
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return new Response(JSON.stringify({
        error: 'Unauthorized'
      }), {
        status: 401,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // ── photo (GET, 2026-09-25) ─────────────────────────────────────
    if (req.method === 'GET') {
      const url = new URL(req.url);
      if (url.searchParams.get('action') === 'photo') return await proxyPlacesPhoto(url);
      return new Response(JSON.stringify({
        error: 'Unknown action'
      }), {
        status: 400,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    let body;
    try {
      body = await req.json();
    } catch  {
      return new Response(JSON.stringify({
        error: 'invalid_json'
      }), {
        status: 400,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    const { action } = body;
    // ── get_recommendations ───────────────────────────────────────────
    if (action === 'get_recommendations') {
      const { category = 'activity', location, tripId = null, radius = 5000, limit = 6, forceRefresh = false } = body;
      if (!location) {
        return new Response(JSON.stringify({
          error: 'location required'
        }), {
          status: 400,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      if (!forceRefresh) {
        const cached = await getCachedRecommendations(supabase, user.id, location, category);
        if (cached) return json({
          recommendations: cached,
          data: {
            recommendations: cached
          },
          status: 'ok',
          source: 'cache'
        });
      }
      const { data: profileData, error: profileErr } = await supabase.from('user_recommendation_profiles').select('*').eq('user_id', user.id).maybeSingle();
      if (profileErr) console.error('recommendation profile read failed:', profileErr.message);
      const profile = {
        interests: profileData?.interests || [],
        budgetLevel: profileData?.budget_level || 'moderate',
        preferredCategories: profileData?.preferred_categories || [],
        homeLocation: profileData?.home_location
      };
      const googleApiKey = env('GOOGLE_PLACES_API_KEY') || '';
      const taApiKey = env('TRIPADVISOR_API_KEY') || '';
      // Same resolution order as provider-adapters: one Mapbox secret, either name.
      const mapboxToken = env('MAPBOX_ACCESS_TOKEN') || env('MAPBOX_API_KEY') || '';
      const providersConfigured = [];
      const providersReturned = [];
      const providerErrors = [];
      let centre = null;
      let rawItems = [];
      if (googleApiKey && mapboxToken) {
        providersConfigured.push('google_places');
        try {
          centre = await geocodeLocation(location, mapboxToken);
          if (!centre) {
            providerErrors.push('geocode_failed: the search location could not be resolved to coordinates');
          } else {
            const googleItems = await googlePlacesSearch(centre.lat, centre.lng, category, radius, googleApiKey);
            if (googleItems.length > 0) providersReturned.push('google_places');
            rawItems.push(...googleItems);
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error('Google Places error:', msg);
          providerErrors.push(`google_places: ${msg}`);
        }
      } else if (googleApiKey) {
        console.error('recommendations: GOOGLE_PLACES_API_KEY is set but no Mapbox token (MAPBOX_ACCESS_TOKEN / MAPBOX_API_KEY) is configured; Places nearby search needs coordinates, so it is being skipped.');
        providerErrors.push('google_places: no Mapbox token configured, so no coordinates could be resolved');
      }
      if (taApiKey) {
        providersConfigured.push('tripadvisor');
        try {
          const taItems = await tripAdvisorSearch(location, category, taApiKey);
          if (taItems.length > 0) providersReturned.push('tripadvisor');
          rawItems.push(...taItems);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error('TripAdvisor error:', msg);
          providerErrors.push(`tripadvisor: ${msg}`);
        }
      }
      // FABRICATION REMOVED 2026-09-19 — this is where
      //   rawItems = generateMockRecommendations(category, location, limit * 2);
      // used to fill the result with invented places that were then cached.
      // No results is now reported as no results, with the reason, and nothing
      // is written to the recommendations table.
      if (rawItems.length === 0) {
        const reason = providersConfigured.length === 0 ? 'no_recommendation_provider_configured' : providerErrors.length > 0 ? 'provider_request_failed' : 'no_results_from_providers';
        const safeFailureMessage = providersConfigured.length === 0 ? 'TravelOS has no recommendation provider connected, so it cannot suggest anything here. ' + 'This is a missing integration, not an empty destination.' : providerErrors.length > 0 ? 'The recommendation providers could not be reached, so nothing can be suggested right now. ' + 'This does not mean there is nothing to do here.' : 'No provider returned any ' + String(category) + ' near ' + String(location) + '. ' + 'Try a wider radius or a different category.';
        return json({
          recommendations: [],
          data: null,
          status: 'unavailable',
          source: null,
          reason,
          safeFailureMessage,
          providers_configured: providersConfigured,
          provider_errors: providerErrors,
          persisted: false
        });
      }
      const seen = new Set();
      const deduped = rawItems.filter((item)=>{
        const key = String(item.name || '').toLowerCase();
        if (!key) return false;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const scored = deduped.map((item)=>scoreItem(item, category, location, profile, centre)).sort((a, b)=>(b.overallScore ?? -1) - (a.overallScore ?? -1)).slice(0, limit);
      await cacheRecommendations(supabase, user.id, tripId, location, category, scored);
      return json({
        recommendations: scored,
        data: {
          recommendations: scored
        },
        status: 'ok',
        source: 'live',
        providers_returned: providersReturned,
        provider_errors: providerErrors
      });
    }
    // ── get_profile ─────────────────────────────────────────────────
    if (action === 'get_profile') {
      const { data, error } = await supabase.from('user_recommendation_profiles').select('*').eq('user_id', user.id).maybeSingle();
      if (error) {
        console.error('get_profile failed:', error.message);
        return new Response(JSON.stringify({
          error: 'profile_lookup_failed',
          details: error.message
        }), {
          status: 500,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      return json({
        profile: data ?? null
      });
    }
    // ── update_profile ──────────────────────────────────────────────
    if (action === 'update_profile') {
      const { interests, budgetLevel, preferredCategories, homeLocation } = body;
      const { data, error } = await supabase.from('user_recommendation_profiles').upsert({
        user_id: user.id,
        interests: interests || [],
        budget_level: budgetLevel || 'moderate',
        preferred_categories: preferredCategories || [],
        home_location: homeLocation,
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'user_id'
      }).select().single();
      if (error) throw error;
      return json({
        profile: data
      });
    }
    // ── get_cached ─────────────────────────────────────────────────
    if (action === 'get_cached') {
      const { tripId, category } = body;
      let query = supabase.from('recommendations').select('*').eq('user_id', user.id);
      if (tripId) query = query.eq('trip_id', tripId);
      if (category) query = query.eq('category', category);
      const { data, error } = await query.order('overall_score', {
        ascending: false
      }).limit(50);
      if (error) {
        console.error('get_cached failed:', error.message);
        return new Response(JSON.stringify({
          error: 'cache_lookup_failed',
          details: error.message
        }), {
          status: 500,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      return json({
        recommendations: data || []
      });
    }
    // ── save_recommendation ──────────────────────────────────────────
    if (action === 'save_recommendation') {
      const { recommendation } = body;
      if (!recommendation?.id || !recommendation?.name) {
        return new Response(JSON.stringify({
          error: 'recommendation with id and name required'
        }), {
          status: 400,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      const { data, error } = await supabase.from('saved_recommendations').upsert({
        user_id: user.id,
        recommendation_id: recommendation.id,
        trip_id: recommendation.tripId || null,
        name: recommendation.name,
        category: recommendation.category,
        location: recommendation.location,
        // Explicit nulls: `|| 0` and `|| '$$'` used to turn an unrated or
        // unpriced place into a place rated 0 and priced '$$'. (The column
        // defaults still do this for inserts that omit the field — those
        // defaults should be dropped.)
        rating: recommendation.rating ?? null,
        price: recommendation.price ?? null,
        image_url: recommendation.imageUrl,
        booking_url: recommendation.bookingUrl,
        overall_score: recommendation.overallScore ?? null,
        tagline: recommendation.tagline ?? null,
        tags: recommendation.tags || []
      }, {
        onConflict: 'user_id,recommendation_id'
      }).select().single();
      if (error) throw error;
      const { error: engagementErr } = await supabase.from('recommendation_engagement').upsert({
        user_id: user.id,
        recommendation_id: recommendation.id,
        engagement_type: 'save',
        location: recommendation.location,
        category: recommendation.category
      }, {
        onConflict: 'user_id,recommendation_id,engagement_type'
      });
      if (engagementErr) console.error('save engagement write failed:', engagementErr.message);
      return json({
        saved: data
      });
    }
    // ── unsave_recommendation ───────────────────────────────────────
    if (action === 'unsave_recommendation') {
      const { recommendationId } = body;
      const { error } = await supabase.from('saved_recommendations').delete().eq('user_id', user.id).eq('recommendation_id', recommendationId);
      if (error) {
        console.error('unsave failed:', error.message);
        return new Response(JSON.stringify({
          error: 'unsave_failed',
          details: error.message
        }), {
          status: 500,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      return json({
        unsaved: true
      });
    }
    // ── get_saved ──────────────────────────────────────────────────
    if (action === 'get_saved') {
      const { tripId, category } = body;
      let query = supabase.from('saved_recommendations').select('*').eq('user_id', user.id);
      if (tripId) query = query.eq('trip_id', tripId);
      if (category && category !== 'all') query = query.eq('category', category);
      const { data, error } = await query.order('saved_at', {
        ascending: false
      });
      if (error) {
        console.error('get_saved failed:', error.message);
        return new Response(JSON.stringify({
          error: 'saved_lookup_failed',
          details: error.message
        }), {
          status: 500,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      return json({
        saved: data || []
      });
    }
    // ── track_engagement ────────────────────────────────────────────
    if (action === 'track_engagement') {
      const { recommendationId, engagementType, location, category } = body;
      const { error } = await supabase.from('recommendation_engagement').upsert({
        user_id: user.id,
        recommendation_id: recommendationId,
        engagement_type: engagementType,
        location,
        category
      }, {
        onConflict: 'user_id,recommendation_id,engagement_type'
      });
      if (error) {
        console.error('track_engagement failed:', error.message);
        return new Response(JSON.stringify({
          error: 'engagement_write_failed',
          details: error.message
        }), {
          status: 500,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      return json({
        tracked: true
      });
    }
    // ── get_social_signals ─────────────────────────────────────────
    if (action === 'get_social_signals') {
      const { recommendationId } = body;
      const { count: totalSaves, error: savesErr } = await supabase.from('recommendation_engagement').select('*', {
        count: 'exact',
        head: true
      }).eq('recommendation_id', recommendationId).eq('engagement_type', 'save');
      const { count: totalViews, error: viewsErr } = await supabase.from('recommendation_engagement').select('*', {
        count: 'exact',
        head: true
      }).eq('recommendation_id', recommendationId).eq('engagement_type', 'view');
      // A failed count is not a count of zero. Reporting 0 saves because the
      // query broke would be the same class of defect this file just removed.
      if (savesErr || viewsErr) {
        const detail = savesErr?.message ?? viewsErr?.message ?? 'unknown';
        console.error('get_social_signals count failed:', detail);
        return new Response(JSON.stringify({
          error: 'social_signals_lookup_failed',
          details: detail,
          data: null,
          status: 'unavailable'
        }), {
          status: 500,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      const saves = totalSaves || 0;
      const views = totalViews || 0;
      const trendingScore = Math.min(100, Math.round(saves * 5 + views * 0.5));
      let trendingCategory = 'new';
      if (trendingScore > 80) trendingCategory = 'viral';
      else if (trendingScore > 60) trendingCategory = 'popular';
      else if (trendingScore > 30) trendingCategory = 'rising';
      const { error: trendingErr } = await supabase.from('recommendation_trending').upsert({
        recommendation_id: recommendationId,
        total_saves: saves,
        total_views: views,
        trending_score: trendingScore,
        trending_category: trendingCategory,
        last_calculated: new Date().toISOString()
      }, {
        onConflict: 'recommendation_id'
      });
      if (trendingErr) console.error('trending upsert failed:', trendingErr.message);
      return json({
        socialSignals: {
          recommendationId,
          totalSaves: saves,
          totalViews: views,
          trendingScore,
          trendingCategory
        }
      });
    }
    // ── get_trending ───────────────────────────────────────────────
    if (action === 'get_trending') {
      const { location, category, limit = 10 } = body;
      let query = supabase.from('recommendation_trending').select('*');
      if (location) query = query.eq('location', location);
      if (category && category !== 'all') query = query.eq('category', category);
      const { data, error } = await query.order('trending_score', {
        ascending: false
      }).limit(limit);
      if (error) {
        console.error('get_trending failed:', error.message);
        return new Response(JSON.stringify({
          error: 'trending_lookup_failed',
          details: error.message
        }), {
          status: 500,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      return json({
        trending: data || []
      });
    }
    return new Response(JSON.stringify({
      error: 'Unknown action'
    }), {
      status: 400,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  } catch (err) {
    console.error('recommendations error:', err);
    return new Response(JSON.stringify({
      error: 'Internal server error'
    }), {
      status: 500,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
});

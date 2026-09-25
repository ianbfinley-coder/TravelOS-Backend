// geocode-itinerary - created 2026-09-25 (Wave 5, map pins).
//
// Fills itinerary_items.lat / lng / place_id from itinerary_items.location so
// the trip map can pin items the user typed by name. Coordinates are metadata:
// NO itinerary version is created, trips.version is not touched, and
// itinerary_items.updated_at is left alone (so AI-analysis caches keyed on the
// last item edit are not invalidated by a geocode).
//
// v3 2026-09-25 - landmarks did not resolve. Live test: "Hoover Dam" on the
// Las Vegas trip pinned nothing. v2 sent "Hoover Dam, Las Vegas, Nevada, USA"
// to Geocoding v6 (which has no POIs) and then to v5 with the same text; the
// appended city is wrong for a landmark outside it, which drags v5 relevance
// under the 0.8 cut. v3:
//   * names (anything not starting with a house number) go to the Mapbox
//     Search Box API /forward first - it returns POIs - with the location
//     text alone and proximity to the destination centre;
//   * then v5 mapbox.places (location alone, then with the destination
//     appended), then v6 (addresses);
//   * address-like text goes to v6 first;
//   * up to 5 candidates per endpoint are judged, not just the top one;
//   * an endpoint that rejects the token (401/403) is skipped for the rest of
//     the call instead of aborting; 503 only when every endpoint rejects it;
//   * one structured console.log line per item (no token, no URL): endpoint
//     tried, HTTP status, feature count, top candidate type/name/relevance,
//     and the verdict or rejection reason. Skipped entries carry `detail`.
//
// CONTRACT
//   POST /functions/v1/geocode-itinerary   (verify_jwt: true; user JWT required)
//   body { trip_id: uuid, item_ids?: uuid[] (max 50) }
//     * without item_ids: items of the trip with lat OR lng null and a
//       non-empty location, in date/start order, at most 50 per call;
//       `remaining` says how many more are still waiting (call again).
//     * with item_ids: exactly those items of the trip (re-geocoded even if they
//       already have coordinates, e.g. after a location edit).
//   200 { updated, skipped: [{ id, title, reason, detail? }], items: [{ id, lat,
//         lng, place_id, matched, source }], considered, remaining }
//       skip reasons: no_location | not_found | no_match | weak_match |
//         too_far_from_destination | rate_limited | geocoder_error |
//         location_changed | write_failed
//       not_found = the id is not an itinerary_items row of this trip.
//   400 { error }                        bad body
//   401 { error }                        missing/invalid JWT
//   403 { error: 'FORBIDDEN', message }  viewer (read-only member)
//   403 { error: 'MFA_REQUIRED', message } MFA enrolled but session is aal1
//   404 { error: 'Trip not found' }      not a member / no such trip
//   503 { error: 'GEOCODER_UNAVAILABLE', message }
//
// AUTH: caller must hold an editing role (owner / organizer / member) on an
// active account membership (trip_members kind 'account', removed_at IS NULL,
// resolved through auth_identities.provider_subject = auth uid), or be the
// trips.user_id owner. The same MFA rule as the itinerary_items RLS policy
// (private.mfa_satisfied) is applied before any write: aal2, or no verified
// factor. Writes then go through the service client, guarded on trip_id and
// on the location string that was geocoded (a concurrent location edit wins).
//
// MATCH GATES (Mapbox always returns a best guess, so every candidate is judged):
//   poi                 -> shares a significant word with the location's first segment
//   address / street    -> v6 match_code confidence exact/high/medium (street: exact/high);
//                          Search Box / v5 addresses need a shared word
//   city-level          -> only when the location itself names that place
//   v5                  -> relevance >= 0.7 as well
//   any                 -> within 500 km of the trip destination centre when known
// Token env: MAPBOX_ACCESS_TOKEN, else MAPBOX_API_KEY (same as provider-adapters).
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { json, fail, corsHeaders, serviceClient, requireUser } from './_shared/auth.ts';
const MAX_ITEMS = 50;
const DELAY_MS = 120;
const MAX_DISTANCE_KM = 500;
const CANDIDATES = 5;
const V5_MIN_RELEVANCE = 0.7;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EDIT_ROLES = new Set([
  'owner',
  'organizer',
  'member'
]);
const ROLE_RANK = {
  owner: 4,
  organizer: 3,
  member: 2,
  viewer: 1
};
const CITY_LEVEL = new Set([
  'country',
  'region',
  'postcode',
  'district',
  'place',
  'city',
  'locality',
  'neighborhood'
]);
const STOP = new Set([
  'the',
  'and',
  'of',
  'at',
  'in',
  'de',
  'la',
  'le',
  'du',
  'des',
  'el',
  'los',
  'las',
  'san',
  'st',
  'saint',
  'visit',
  'tour'
]);
function mapboxToken() {
  const a = Deno.env.get('MAPBOX_ACCESS_TOKEN')?.trim();
  if (a) return a;
  const b = Deno.env.get('MAPBOX_API_KEY')?.trim();
  return b || null;
}
const sleep = (ms)=>new Promise((r)=>setTimeout(r, ms));
function norm(s) {
  return String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function words(s) {
  return norm(s).split(' ').filter((w)=>w.length >= 3 && !STOP.has(w));
}
/** True when the location's first segment names this place (city-level results only). */ function locationNamesPlace(location, placeName) {
  const head = norm(location.split(',')[0]);
  const name = norm(placeName);
  if (!head || !name) return false;
  return head === name || name.length >= 4 && (head.startsWith(name) || name.startsWith(head));
}
function sharesWord(location, featureText) {
  const f = new Set(words(featureText));
  return words(location.split(',')[0]).some((w)=>f.has(w));
}
function looksLikeAddress(location) {
  return /^\s*\d+[a-z]?\s+\S/i.test(location);
}
function haversineKm(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad, dLng = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
class GeocoderRateLimit extends Error {
}
/** Fetches one Mapbox URL. Returns status + parsed body; 429 throws. Never logs the URL (it carries the token). */ async function mapboxGet(url) {
  const res = await fetch(url);
  if (res.status === 429) throw new GeocoderRateLimit('mapbox 429');
  if (!res.ok) {
    try {
      await res.body?.cancel();
    } catch  {}
    return {
      status: res.status,
      body: null
    };
  }
  return {
    status: res.status,
    body: await res.json()
  };
}
function num(v) {
  return typeof v === 'number' ? v : Number(v);
}
/** Search Box /forward and Geocoding v6 share the GeoJSON + properties.coordinates shape. */ function candsFromV6Like(body) {
  const feats = body?.features ?? [];
  const out = [];
  for (const f of feats){
    const p = f.properties ?? {};
    const c = p.coordinates ?? {};
    const g = f.geometry?.coordinates;
    const lng = num(c.longitude ?? g?.[0]), lat = num(c.latitude ?? g?.[1]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    const name = String(p.name ?? p.name_preferred ?? '');
    out.push({
      lng,
      lat,
      place_id: p.mapbox_id ? String(p.mapbox_id) : null,
      name,
      matched: String(p.full_address ?? (p.place_formatted ? `${name}, ${p.place_formatted}` : name)),
      type: String(p.feature_type ?? ''),
      confidence: String((p.match_code ?? {}).confidence ?? ''),
      relevance: null
    });
  }
  return out;
}
function candsFromV5(body) {
  const feats = body?.features ?? [];
  const out = [];
  for (const f of feats){
    const center = f.center;
    const lng = num(center?.[0]), lat = num(center?.[1]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    const types = f.place_type ?? [];
    out.push({
      lng,
      lat,
      place_id: f.id ? String(f.id) : null,
      name: String(f.text ?? ''),
      matched: String(f.place_name ?? f.text ?? ''),
      type: types.includes('poi') ? 'poi' : types.includes('address') ? 'address' : types[0] ?? '',
      confidence: '',
      relevance: Number.isFinite(num(f.relevance)) ? num(f.relevance) : null
    });
  }
  return out;
}
/** null when acceptable, else the rejection reason. */ function judge(c, endpoint, location, destCenter) {
  if ((endpoint === 'v5' || endpoint === 'v5_biased') && (c.relevance ?? 0) < V5_MIN_RELEVANCE) {
    return `relevance ${c.relevance ?? 'n/a'} < ${V5_MIN_RELEVANCE}`;
  }
  let ok = false;
  if (c.type === 'poi') {
    ok = sharesWord(location, c.name);
    if (!ok) return `poi "${c.name}" shares no word with location`;
  } else if (c.type === 'address' || c.type === 'secondary_address' || c.type === 'street') {
    if (endpoint === 'v6') {
      const allowed = c.type === 'street' ? [
        'exact',
        'high'
      ] : [
        'exact',
        'high',
        'medium'
      ];
      ok = allowed.includes(c.confidence);
      if (!ok) return `${c.type} confidence "${c.confidence || 'none'}"`;
    } else {
      ok = sharesWord(location, c.name) || sharesWord(location, c.matched);
      if (!ok) return `${c.type} "${c.name}" shares no word with location`;
    }
  } else if (CITY_LEVEL.has(c.type)) {
    ok = locationNamesPlace(location, c.name);
    if (!ok) return `${c.type} "${c.name}" is not what the location names`;
  } else {
    return `unhandled type "${c.type}"`;
  }
  if (destCenter && haversineKm(destCenter, [
    c.lng,
    c.lat
  ]) > MAX_DISTANCE_KM) {
    return `"${c.name}" is ${Math.round(haversineKm(destCenter, [
      c.lng,
      c.lat
    ]))} km from the destination`;
  }
  return null;
}
function bearerAal(req) {
  try {
    const token = (req.headers.get('Authorization') ?? '').slice(7).trim();
    const payload = token.split('.')[1] ?? '';
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '=');
    return String(JSON.parse(atob(b64)).aal ?? 'aal1');
  } catch  {
    return 'aal1';
  }
}
function logLine(o) {
  console.log(JSON.stringify({
    fn: 'geocode-itinerary',
    ...o
  }));
}
Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') return new Response(null, {
    status: 204,
    headers: corsHeaders
  });
  if (req.method !== 'POST') return fail('Method not allowed', 405);
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;
  const authUid = auth.userId;
  let body;
  try {
    body = await req.json();
  } catch  {
    return fail('Invalid JSON body', 400);
  }
  const tripId = String(body.trip_id ?? '');
  if (!UUID_RE.test(tripId)) return fail('trip_id (uuid) is required', 400);
  let itemIds = null;
  if (body.item_ids !== undefined && body.item_ids !== null) {
    if (!Array.isArray(body.item_ids) || body.item_ids.some((x)=>typeof x !== 'string' || !UUID_RE.test(x))) {
      return fail('item_ids must be an array of uuids', 400);
    }
    itemIds = [
      ...new Set(body.item_ids.map((x)=>x.toLowerCase()))
    ];
    if (itemIds.length === 0) return fail('item_ids is empty', 400);
    if (itemIds.length > MAX_ITEMS) return fail(`At most ${MAX_ITEMS} item_ids per call`, 400);
  }
  const db = serviceClient();
  try {
    // -- trip + role
    const { data: trip, error: tripErr } = await db.from('trips').select('id, user_id, destination').eq('id', tripId).maybeSingle();
    if (tripErr) return fail(`Trip lookup failed: ${tripErr.message}`, 500);
    if (!trip) return fail('Trip not found', 404);
    let role = trip.user_id === authUid ? 'owner' : null;
    if (!role) {
      const { data: idents, error: identErr } = await db.from('auth_identities').select('user_id').eq('provider_subject', authUid);
      if (identErr) return fail(`Identity lookup failed: ${identErr.message}`, 500);
      const platformIds = [
        ...new Set((idents ?? []).map((r)=>r.user_id).filter(Boolean))
      ];
      if (platformIds.length > 0) {
        const { data: members, error: memErr } = await db.from('trip_members').select('role').eq('trip_id', tripId).eq('kind', 'account').in('user_id', platformIds).is('removed_at', null);
        if (memErr) return fail(`Membership lookup failed: ${memErr.message}`, 500);
        for (const m of members ?? []){
          const r = String(m.role ?? '');
          if ((ROLE_RANK[r] ?? 0) > (role ? ROLE_RANK[role] : 0)) role = r;
        }
      }
    }
    if (!role) return fail('Trip not found', 404);
    if (!EDIT_ROLES.has(role)) {
      return json({
        error: 'FORBIDDEN',
        message: "Viewers can see this trip's map but can't place pins."
      }, 403);
    }
    // -- MFA, mirroring private.mfa_satisfied()
    if (bearerAal(req) !== 'aal2') {
      const { data: factors, error: mfaErr } = await db.auth.admin.mfa.listFactors({
        userId: authUid
      });
      if (mfaErr) return fail(`MFA check failed: ${mfaErr.message}`, 500);
      const verified = (factors?.factors ?? []).some((f)=>f.status === 'verified');
      if (verified) {
        return json({
          error: 'MFA_REQUIRED',
          message: 'Verify with your authenticator app to edit this trip.'
        }, 403);
      }
    }
    const token = mapboxToken();
    if (!token) {
      logLine({
        event: 'no_token'
      });
      return json({
        error: 'GEOCODER_UNAVAILABLE',
        message: 'Map search is not configured.'
      }, 503);
    }
    const skipped = [];
    let batch = [];
    let remaining = 0;
    if (itemIds) {
      const { data, error } = await db.from('itinerary_items').select('id, title, location').eq('trip_id', tripId).in('id', itemIds);
      if (error) return fail(`Item lookup failed: ${error.message}`, 500);
      const found = new Map((data ?? []).map((r)=>[
          String(r.id).toLowerCase(),
          r
        ]));
      const missing = [];
      for (const id of itemIds){
        const it = found.get(id);
        if (!it) {
          missing.push(id);
          skipped.push({
            id,
            title: null,
            reason: 'not_found',
            detail: 'not an itinerary item of this trip'
          });
          continue;
        }
        if (!String(it.location ?? '').trim()) {
          skipped.push({
            id,
            title: it.title,
            reason: 'no_location'
          });
          continue;
        }
        batch.push(it);
      }
      logLine({
        event: 'load',
        mode: 'item_ids',
        trip_id: tripId,
        requested: itemIds.length,
        found: found.size,
        missing
      });
    } else {
      const { data, error } = await db.from('itinerary_items').select('id, title, location').eq('trip_id', tripId).or('lat.is.null,lng.is.null').not('location', 'is', null).order('date', {
        ascending: true,
        nullsFirst: false
      }).order('start_time', {
        ascending: true,
        nullsFirst: false
      }).limit(1000);
      if (error) return fail(`Item lookup failed: ${error.message}`, 500);
      const pending = (data ?? []).filter((r)=>String(r.location ?? '').trim());
      batch = pending.slice(0, MAX_ITEMS);
      remaining = pending.length - batch.length;
      logLine({
        event: 'load',
        mode: 'missing_coords',
        trip_id: tripId,
        pending: pending.length,
        batch: batch.length
      });
    }
    // -- endpoints; one that rejects the token is dropped for this call
    const disabled = new Set();
    const destination = String(trip.destination ?? '').trim();
    const destHead = norm(destination.split(',')[0]);
    let destCenter = null;
    let rateLimited = false;
    function urlFor(ep, q) {
      const prox = destCenter ? `${destCenter[0]},${destCenter[1]}` : null;
      if (ep === 'searchbox') {
        const p = new URLSearchParams({
          q,
          limit: String(CANDIDATES),
          access_token: token
        });
        if (prox) p.set('proximity', prox);
        return `https://api.mapbox.com/search/searchbox/v1/forward?${p}`;
      }
      if (ep === 'v6') {
        const p = new URLSearchParams({
          q,
          limit: String(CANDIDATES),
          autocomplete: 'false',
          access_token: token
        });
        if (prox) p.set('proximity', prox);
        return `https://api.mapbox.com/search/geocode/v6/forward?${p}`;
      }
      const p = new URLSearchParams({
        limit: String(CANDIDATES),
        autocomplete: 'false',
        access_token: token
      });
      if (prox) p.set('proximity', prox);
      return `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json?${p}`;
    }
    if (destination && batch.length > 0) {
      try {
        const p = new URLSearchParams({
          q: destination,
          limit: '1',
          types: 'place,locality,region,country',
          access_token: token
        });
        const r = await mapboxGet(`https://api.mapbox.com/search/geocode/v6/forward?${p}`);
        const c = candsFromV6Like(r.body)[0];
        if (c) destCenter = [
          c.lng,
          c.lat
        ];
        logLine({
          event: 'destination',
          destination,
          status: r.status,
          center: destCenter
        });
        if (r.status === 401 || r.status === 403) disabled.add('v6');
      } catch (e) {
        logLine({
          event: 'destination',
          destination,
          error: e instanceof Error ? e.message : String(e)
        });
      }
      await sleep(DELAY_MS);
    }
    // -- geocode sequentially
    const out = [];
    for(let i = 0; i < batch.length; i++){
      const it = batch[i];
      if (rateLimited) {
        skipped.push({
          id: it.id,
          title: it.title,
          reason: 'rate_limited'
        });
        continue;
      }
      const location = String(it.location).trim();
      const biased = destination && destHead && !norm(location).includes(destHead) ? `${location}, ${destination}` : null;
      const plan = looksLikeAddress(location) ? [
        {
          ep: 'v6',
          q: biased ?? location
        },
        {
          ep: 'searchbox',
          q: location
        },
        {
          ep: 'v5',
          q: biased ?? location
        }
      ] : [
        {
          ep: 'searchbox',
          q: location
        },
        {
          ep: 'v5',
          q: location
        },
        ...biased ? [
          {
            ep: 'v5_biased',
            q: biased
          }
        ] : [],
        {
          ep: 'v6',
          q: biased ?? location
        }
      ];
      const attempts = [];
      let hit = null;
      let sawCandidate = false;
      let lastReject = '';
      let hadError = false;
      for (const step of plan){
        const base = step.ep === 'v5_biased' ? 'v5' : step.ep;
        if (disabled.has(base)) continue;
        let r;
        try {
          r = await mapboxGet(urlFor(step.ep, step.q));
        } catch (e) {
          if (e instanceof GeocoderRateLimit) {
            rateLimited = true;
            attempts.push({
              endpoint: step.ep,
              status: 429,
              features: 0,
              top: null,
              verdict: 'rate_limited'
            });
            break;
          }
          hadError = true;
          attempts.push({
            endpoint: step.ep,
            status: 0,
            features: 0,
            top: null,
            verdict: `fetch error: ${e instanceof Error ? e.message : String(e)}`
          });
          await sleep(DELAY_MS);
          continue;
        }
        if (r.status === 401 || r.status === 403) {
          disabled.add(base);
          attempts.push({
            endpoint: step.ep,
            status: r.status,
            features: 0,
            top: null,
            verdict: 'token rejected; endpoint disabled for this call'
          });
          continue;
        }
        if (r.status !== 200) {
          hadError = true;
          attempts.push({
            endpoint: step.ep,
            status: r.status,
            features: 0,
            top: null,
            verdict: 'http error'
          });
          await sleep(DELAY_MS);
          continue;
        }
        const cands = base === 'v5' ? candsFromV5(r.body) : candsFromV6Like(r.body);
        const top = cands[0] ? `${cands[0].type}:"${cands[0].name}"${cands[0].relevance !== null ? ` rel=${cands[0].relevance}` : ''}${cands[0].confidence ? ` conf=${cands[0].confidence}` : ''}` : null;
        let verdict = cands.length ? '' : 'no features';
        for (const c of cands){
          sawCandidate = true;
          const why = judge(c, base, location, destCenter);
          if (!why) {
            hit = {
              lng: c.lng,
              lat: c.lat,
              place_id: c.place_id,
              matched: c.matched,
              source: `mapbox.${step.ep}`
            };
            verdict = `accepted ${c.type}:"${c.name}"`;
            break;
          }
          if (!verdict) verdict = `rejected: ${why}`;
          lastReject = why;
        }
        attempts.push({
          endpoint: step.ep,
          status: r.status,
          features: cands.length,
          top,
          verdict
        });
        if (hit) break;
        await sleep(DELAY_MS);
      }
      let reason = null;
      let detail;
      if (!hit) {
        if (rateLimited) reason = 'rate_limited';
        else if (sawCandidate) {
          reason = lastReject.includes('km from the destination') ? 'too_far_from_destination' : 'weak_match';
          detail = lastReject;
        } else if (hadError) reason = 'geocoder_error';
        else reason = 'no_match';
      }
      logLine({
        event: 'item',
        item_id: it.id,
        location,
        attempts,
        result: hit ? 'hit' : reason,
        detail: detail ?? null
      });
      if (!hit) {
        skipped.push({
          id: it.id,
          title: it.title,
          reason: reason,
          ...detail ? {
            detail
          } : {}
        });
        if (disabled.size >= 3 && out.length === 0) {
          logLine({
            event: 'all_endpoints_rejected_token'
          });
          return json({
            error: 'GEOCODER_UNAVAILABLE',
            message: 'Map search is not available right now.'
          }, 503);
        }
        continue;
      }
      // Guarded on the location that was geocoded: if someone edited it
      // meanwhile, their edit wins and this pin is dropped.
      const { data: upd, error: updErr } = await db.from('itinerary_items').update({
        lat: hit.lat,
        lng: hit.lng,
        place_id: hit.place_id
      }).eq('id', it.id).eq('trip_id', tripId).eq('location', it.location).select('id');
      if (updErr) {
        console.error('[geocode-itinerary] update failed:', updErr.message);
        skipped.push({
          id: it.id,
          title: it.title,
          reason: 'write_failed'
        });
      } else if (!upd || upd.length === 0) {
        skipped.push({
          id: it.id,
          title: it.title,
          reason: 'location_changed'
        });
      } else {
        out.push({
          id: it.id,
          lat: hit.lat,
          lng: hit.lng,
          place_id: hit.place_id,
          matched: hit.matched,
          source: hit.source
        });
      }
      if (i < batch.length - 1) await sleep(DELAY_MS);
    }
    logLine({
      event: 'done',
      trip_id: tripId,
      updated: out.length,
      skipped: skipped.length,
      disabled: [
        ...disabled
      ]
    });
    return json({
      updated: out.length,
      skipped,
      items: out,
      considered: batch.length,
      remaining
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[geocode-itinerary] unhandled:', message);
    return fail('Internal server error', 500);
  }
});

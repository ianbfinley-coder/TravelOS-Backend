// FABRICATION REMOVED 2026-09-19
//
// Every safety and health figure this function returned was invented, and the
// inventions were the kind a traveller acts on. There was no provider call on
// these paths at all — the numbers came from the length and character codes of
// the destination string:
//
//   function getSafetyRiskLevel(destination: string): RiskLevel {
//     return RISK_LEVELS[destination.length % 4];          // "low".."extreme"
//   }
//   function getHealthRiskLevel(destination: string): RiskLevel {
//     return RISK_LEVELS[(destination.charCodeAt(0) + destination.length) % 4];
//   }
//   function getMedicalFacilityQuality(destination: string): string {
//     return ["excellent","good","adequate","poor"][destination.length % 4];
//   }
//
// From those three hashes the old code derived, with HTTP 200 and no flag of
// any kind: an advisory_level of "Do not travel"; threat lists naming "Active
// conflict zone" and "Terrorism risk"; a cholera OUTBREAK with a required
// cholera vaccination; malaria endemicity with antimalarials "advised"; and a
// medical-facility rating. A destination of the right length was declared a
// war zone. "Bogota" (6) and "Zurich" (6) scored identically, because only the
// length was ever read. All of it was written to `safety_assessments` and
// `health_assessments`, where `get_all_intelligence`, the trip dashboard and
// the alert pipeline re-served it as an assessment of a real place.
//
// Disaster alerts had the fabrication tell this codebase keeps producing — a
// mock stamped with a real agency's name, or falling back to a mock when the
// agency could not be reached:
//
//   } catch (_e) {
//     // USGS fetch failed — fall through to mock
//   }
//   // If no real data, generate 0-1 mock alerts based on destination hash
//   if (alerts.length === 0 && destination) {
//     const hash = destination.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
//     if (hash % 5 === 0) { alerts.push({ disaster_type: "flood", ...
//
// and the second copy of the same block, in get_trip_safety_health, was worse:
// `catch (_e) { // ignore }` left `disaster_alerts: []` and
// `summary.disaster_count: 0`, which reads as "no disasters near your trip"
// when what actually happened is that nobody asked. Two further inventions
// rode along with the genuine USGS rows: `evacuation_order: severity ===
// "extreme"` manufactured an official evacuation order that no agency had
// issued, and `recommendation: "Follow local evacuation orders immediately"`
// attached invented instructions to a USGS-attributed alert.
//
// Even the USGS success path was wrong about relevance. It read
// `summary/significant_month.geojson`, the GLOBAL feed, and stored every
// M4.5+ event on Earth as an alert for this trip. Real data, filed under the
// wrong trip.
//
// And with no reservations on a trip, get_trip_safety_health did:
//   if (locations.length === 0) locations.push("Unknown destination");
// then ran the hashes over that literal — a full safety and health assessment
// of a place that does not exist.
//
// WHAT IT DOES NOW
//
// Nothing is derived from the destination string. Every value comes from
// `provider-adapters`, which already implements these sources with caching,
// circuit breaking and explicit provenance, and which returns a clean
// `status: 'unavailable'` rather than a default when a source is down:
//
//   * Safety   — /advisory/us?iso2=XX, the U.S. Department of State Bureau of
//                Consular Affairs data API. Its published four-point scale maps
//                one-to-one onto this schema's risk_level CHECK values, so
//                risk_level is a translation of a real published level, not a
//                score this function made up.
//   * Health   — /disease-outbreaks, WHO Disease Outbreak News.
//   * Disaster — /earthquakes?lat&lon, USGS, already scoped to 300km of the
//                destination and the last 7 days, which is the relevance the
//                global feed never had.
//
// When a source cannot answer, the reply is `{ available: false, reason }`
// and NOTHING is written. An empty panel, not an invented one. Absent data is
// never reported as "low" — `summary.highest_safety_risk` is now null when
// nothing could be assessed, where it previously defaulted to "low".
//
// health_assessments IS NO LONGER WRITTEN AT ALL, and get_health_assessment
// returns `assessment: null` beside the real WHO outbreak list. The reason is
// in the schema: `health_assessments.overall_risk_level` and
// `medical_facility_quality` are both NOT NULL with CHECK constraints that
// admit only ('low','moderate','high','extreme') and
// ('excellent','good','adequate','poor'). No provider here rates either one,
// and there is no 'unknown' member to fall back on, so every row written to
// that table would have had to contain a made-up rating — which is exactly
// what the hash functions were for. Callers get the outbreaks, which are real,
// and an explicit reason for the null. Adding 'unknown' to both CHECKs is a
// migration, not an edge function change.
//
// GDACS (/disasters?lat&lon) is deliberately NOT wired in, for the same
// reason: `disaster_alerts.severity` is CHECKed against the same four values
// and GDACS publishes its severity as free text ("Magnitude 5.9M, Depth:10km"),
// which cannot be mapped onto that scale without inventing a level. Earthquake
// severity here is derived from the real magnitude by a documented threshold,
// which is a derivation from a measurement, not a guess.
//
// CROSS-FUNCTION AUTH — provider-adapters authenticates with
// `supabase.auth.getUser(token)`, so it resolves a bearer token to a row in
// auth.users. The service-role key has no `sub` and gets 401 there. The
// CALLER'S Authorization header is therefore forwarded, never the service key.
// A service-role caller of THIS function (requireUserOrService still accepts
// one) has no user token to forward, so the provider paths report themselves
// unavailable with that reason rather than silently returning nothing.
//
// Column names verified against information_schema.columns and pg_constraint
// on 2026-09-19; the previously discarded `error` on every read and write is
// now captured, logged, and distinguished from an absent row.
//
// ── SECURITY 2026-09-16 (retained) ──────────────────────────────────────────
// The get_trip_safety_health action used to read booking_reservations by
// trip_id alone, through a service-role client that bypasses RLS, so any
// authenticated caller could pass another user's trip_id and receive that
// trip's booking locations. Fixed then by an explicit trip-ownership check
// (requireTripOwner against `trips`, uuid-to-uuid, 404 rather than 403 so trip
// ids cannot be enumerated) before any trip_id-keyed read or write, plus a
// defence-in-depth `.eq("user_id", userId)` on the reservations read itself.
// Both are still here, unchanged.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { requireUserOrService, serviceClient, requireTripOwner } from "./_shared/auth.ts";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const PROVIDERS = `${SUPABASE_URL}/functions/v1/provider-adapters`;
const RISK_LEVELS = [
  "low",
  "moderate",
  "high",
  "extreme"
];
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json"
    }
  });
}
/** One shape for "we could not find out". It must never be mistaken for a reading. */ function unavailable(what, reason, provider) {
  return {
    available: false,
    [what]: null,
    reason,
    provider: provider ?? null
  };
}
function providerUnavailable(reason, provider) {
  return {
    data: null,
    status: "unavailable",
    provenance: {
      provider
    },
    safeFailureMessage: reason
  };
}
/**
 * Calls provider-adapters with the END USER'S bearer token.
 *
 * Not the service-role key: provider-adapters resolves the bearer through
 * `supabase.auth.getUser(token)`, which the service-role key fails (no `sub`),
 * so sending it would produce a blanket 401 that this function would then have
 * to interpret — and the old shape of that interpretation was a mock.
 */ async function callProvider(path, authHeader) {
  if (!authHeader) {
    return providerUnavailable("no user token to forward to provider-adapters", "provider-adapters");
  }
  if (authHeader.replace(/^Bearer\s+/i, "").trim() === SERVICE_ROLE_KEY) {
    // A service-role caller of this function has no user JWT. Say so rather
    // than sending a token provider-adapters is guaranteed to reject.
    return providerUnavailable("provider-adapters requires a user JWT; this request was authenticated with the service-role key", "provider-adapters");
  }
  try {
    const res = await fetch(`${PROVIDERS}${path}`, {
      headers: {
        Authorization: authHeader
      }
    });
    if (!res.ok) {
      console.error(`[safety-health-intelligence] provider-adapters ${path} HTTP ${res.status}`);
      return providerUnavailable(`provider request failed (${res.status})`, "provider-adapters");
    }
    const body = await res.json();
    // A result must announce itself as ok AND carry data. Anything else is
    // treated as unavailable rather than coerced into defaults.
    if (body?.status !== "ok" || body?.data == null) {
      return {
        data: null,
        status: "unavailable",
        provenance: body?.provenance,
        safeFailureMessage: body?.safeFailureMessage ?? "provider returned no data",
        officialUrl: body?.officialUrl
      };
    }
    return body;
  } catch (e) {
    console.error(`[safety-health-intelligence] provider-adapters ${path} threw:`, e instanceof Error ? e.message : String(e));
    return providerUnavailable("provider unreachable", "provider-adapters");
  }
}
/**
 * Resolves a place name to coordinates and a country.
 *
 * The country code is what the State Department advisory lookup keys on, and
 * Mapbox does not always return one. When it does not, this reports a failure
 * — guessing the country from the string would reintroduce the class of bug
 * provider-adapters' own comment warns about (a code-space collision hands the
 * caller a different country's safety advisory while looking perfectly fine).
 */ async function geocode(place, authHeader) {
  const r = await callProvider(`/geocode?q=${encodeURIComponent(place)}`, authHeader);
  if (r.status !== "ok" || typeof r.data?.lat !== "number" || typeof r.data?.lon !== "number") {
    return {
      error: r.safeFailureMessage ?? `could not resolve location "${place}"`,
      provider: r.provenance?.provider ?? "mapbox"
    };
  }
  return r.data;
}
function countryName(iso2) {
  if (!iso2 || iso2.length !== 2) return null;
  try {
    return new Intl.DisplayNames([
      "en"
    ], {
      type: "region"
    }).of(iso2.toUpperCase()) ?? null;
  } catch  {
    return null;
  }
}
/**
 * The State Department's four advisory levels, verbatim. This is a published
 * scale, not a scoring model — level 4 IS "Do Not Travel". The old code
 * produced these same strings from `destination.length % 4`.
 */ const US_ADVISORY_TEXT = {
  1: "Level 1: Exercise Normal Precautions",
  2: "Level 2: Exercise Increased Caution",
  3: "Level 3: Reconsider Travel",
  4: "Level 4: Do Not Travel"
};
function advisoryLevelToRisk(level) {
  switch(level){
    case 1:
      return "low";
    case 2:
      return "moderate";
    case 3:
      return "high";
    case 4:
      return "extreme";
    default:
      return null;
  }
}
async function fetchSafety(destination, point, userId, tripId, authHeader) {
  if (!point.iso2) {
    return {
      ok: false,
      reason: `could not determine the country for "${destination}"`,
      provider: "mapbox"
    };
  }
  const adv = await callProvider(`/advisory/us?iso2=${encodeURIComponent(point.iso2)}`, authHeader);
  if (adv.status !== "ok" || !adv.data) {
    return {
      ok: false,
      reason: adv.safeFailureMessage ?? "travel advisory provider unavailable",
      provider: adv.provenance?.provider ?? "state-dept"
    };
  }
  const risk = advisoryLevelToRisk(adv.data.level);
  if (!risk) {
    // The adapter answers with level: null for a country it has no record of.
    // "No advisory published" is not "low risk", so nothing is written.
    return {
      ok: false,
      reason: `no current U.S. State Department advisory for ${countryName(point.iso2) ?? point.iso2}`,
      provider: adv.provenance?.provider ?? "state-dept"
    };
  }
  return {
    ok: true,
    advisory: adv.data,
    provenance: adv.provenance,
    row: {
      user_id: userId,
      trip_id: tripId,
      destination,
      risk_level: risk,
      // No provider here publishes an itemised threat list or per-traveller
      // advice, so these stay empty rather than carrying the invented bullets
      // ("Pickpocketing reported", "Avoid traveling at night") the old code
      // generated. The advisory's own text and official URL travel in the
      // response body, attributed, instead of being paraphrased into a list.
      threats: [],
      recommendations: [],
      advisory_level: adv.data.levelText || US_ADVISORY_TEXT[adv.data.level],
      assessed_at: new Date().toISOString()
    }
  };
}
async function fetchOutbreaks(point, authHeader) {
  const res = await callProvider("/disease-outbreaks", authHeader);
  if (res.status !== "ok" || !res.data) {
    return {
      ok: false,
      reason: res.safeFailureMessage ?? "disease outbreak provider unavailable",
      provider: res.provenance?.provider ?? "who"
    };
  }
  const all = res.data.outbreaks ?? [];
  const iso2 = point.iso2?.toUpperCase() ?? null;
  const name = countryName(iso2);
  // WHO's feed does not reliably carry a country code — the adapter falls back
  // to 'XX'. Filtering an unfilterable feed down to zero and presenting that as
  // "no outbreaks at your destination" would be the same lie in a new place, so
  // when the feed cannot be scoped the whole list is returned, flagged.
  const filterable = all.some((o)=>o.iso2 && o.iso2.toUpperCase() !== "XX");
  if (!iso2 || !filterable && !name) {
    return {
      ok: true,
      outbreaks: all,
      scoped: false,
      scopeNote: "WHO Disease Outbreak News could not be filtered to this destination; the full current list is returned",
      provenance: res.provenance
    };
  }
  const needle = name?.toLowerCase() ?? "";
  const matched = all.filter((o)=>{
    if (iso2 && o.iso2 && o.iso2.toUpperCase() === iso2) return true;
    if (!needle) return false;
    return (o.country ?? "").toLowerCase().includes(needle) || (o.title ?? "").toLowerCase().includes(needle);
  });
  return {
    ok: true,
    outbreaks: matched,
    scoped: true,
    provenance: res.provenance
  };
}
/**
 * Severity from the measured magnitude. A threshold applied to a real
 * measurement, unlike the old `destination.length % 4`.
 */ function magnitudeToSeverity(mag) {
  if (mag > 7) return "extreme";
  if (mag > 6) return "high";
  if (mag > 5) return "moderate";
  return "low";
}
function earthquakeRow(q, userId, tripId) {
  return {
    user_id: userId,
    trip_id: tripId,
    disaster_type: "earthquake",
    location: q.place ?? "Unknown location",
    severity: magnitudeToSeverity(q.magnitude),
    description: `Magnitude ${q.magnitude.toFixed(1)} earthquake — ${q.place ?? "location not given"} (USGS)`,
    affected_area: q.place ?? null,
    // USGS reports seismology. It does not issue evacuation orders, and this
    // function has no source that does. The old code set this true whenever it
    // had scored the event "extreme", manufacturing an official order.
    evacuation_order: false,
    // Likewise: no agency here supplies instructions to the traveller. The old
    // string ("Follow local evacuation orders immediately") was written by this
    // file and served under a USGS attribution.
    recommendation: null,
    source: "USGS",
    event_time: q.time ?? null,
    detected_at: new Date().toISOString()
  };
}
async function fetchEarthquakes(point, userId, tripId, authHeader) {
  const res = await callProvider(`/earthquakes?lat=${point.lat}&lon=${point.lon}`, authHeader);
  if (res.status !== "ok" || !res.data) {
    return {
      ok: false,
      reason: res.safeFailureMessage ?? "earthquake provider unavailable",
      provider: res.provenance?.provider ?? "usgs"
    };
  }
  const rows = (res.data.earthquakes ?? []).filter((q)=>typeof q.magnitude === "number").map((q)=>earthquakeRow(q, userId, tripId));
  return {
    ok: true,
    rows,
    provenance: res.provenance
  };
}
// ── destination resolution ──────────────────────────────────────────────────
/** Falls back to the trip's own destination. Never to a placeholder string. */ async function resolveDestination(db, destination, tripId, userId) {
  if (typeof destination === "string" && destination.trim()) return destination.trim();
  if (!tripId) return null;
  const { data, error } = await db.from("trips").select("destination").eq("id", tripId).eq("user_id", userId).maybeSingle();
  if (error) {
    console.error("[safety-health-intelligence] trips read failed:", error.message);
    return null;
  }
  const d = data?.destination ?? null;
  return d && d.trim() ? d.trim() : null;
}
Deno.serve(async (req)=>{
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: corsHeaders
    });
  }
  // Auth — accepts either a user JWT or the service-role key. Unchanged.
  const caller = await requireUserOrService(req);
  if (caller instanceof Response) return caller;
  const body = await req.json().catch(()=>({}));
  const { action, trip_id, destination } = body;
  const userId = caller.kind === "user" ? caller.userId : body.user_id;
  if (!userId) {
    return json({
      error: "Unauthorized"
    }, 401);
  }
  // Forwarded to provider-adapters as-is. See callProvider.
  const authHeader = req.headers.get("Authorization") ?? "";
  const tripId = trip_id ?? null;
  const db = serviceClient();
  // Confirm the caller owns this trip before any trip_id-keyed read or
  // write. 404 (not 403) so trip ids cannot be enumerated.
  if (tripId) {
    const owned = await requireTripOwner(db, tripId, userId);
    if (owned instanceof Response) return owned;
  }
  try {
    // ── get_safety_assessment ───────────────────────────────────────────────
    if (action === "get_safety_assessment") {
      const dest = await resolveDestination(db, destination, tripId, userId);
      if (!dest) return json({
        error: "destination is required"
      }, 400);
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      let q = db.from("safety_assessments").select("*").eq("user_id", userId).eq("destination", dest).gte("assessed_at", cutoff);
      q = tripId ? q.eq("trip_id", tripId) : q.is("trip_id", null);
      // A failed query and an absent row are different answers. The old code
      // discarded `error` entirely and read both as "no cache".
      const { data: cached, error: cacheErr } = await q.maybeSingle();
      if (cacheErr) {
        console.error("[safety-health-intelligence] safety_assessments read failed:", cacheErr.message);
        return json({
          error: "safety_assessments read failed"
        }, 500);
      }
      if (cached) return json({
        available: true,
        assessment: cached,
        cached: true
      });
      const point = await geocode(dest, authHeader);
      if ("error" in point) return json(unavailable("assessment", point.error, point.provider));
      const safety = await fetchSafety(dest, point, userId, tripId, authHeader);
      if (!safety.ok) return json(unavailable("assessment", safety.reason, safety.provider));
      const { data: upserted, error } = await db.from("safety_assessments").upsert(safety.row, {
        onConflict: "user_id,trip_id,destination"
      }).select().single();
      if (error) {
        console.error("[safety-health-intelligence] safety_assessments upsert failed:", error.message);
        return json({
          error: error.message
        }, 500);
      }
      return json({
        available: true,
        assessment: upserted,
        // `destination` is what was asked for; `resolvedLocation` is the place
        // the advisory actually describes. When they differ the caller is
        // reading about somewhere else and needs to be able to see that.
        resolvedLocation: point.placeName ?? null,
        advisory: {
          source: "U.S. Department of State",
          country: safety.advisory.country,
          iso2: safety.advisory.iso2,
          level: safety.advisory.level,
          levelText: safety.row.advisory_level,
          summary: safety.advisory.summary,
          url: safety.advisory.url,
          updatedAt: safety.advisory.updatedAt ?? null
        },
        provenance: safety.provenance ?? {
          provider: "state-dept"
        },
        attribution: safety.provenance?.attribution ?? "U.S. Department of State"
      });
    }
    // ── get_health_assessment ───────────────────────────────────────────────
    // Returns the real WHO outbreak list and an explicit null assessment. See
    // the header: health_assessments cannot be written without inventing an
    // overall_risk_level and a medical_facility_quality, because both columns
    // are NOT NULL with CHECK constraints that have no 'unknown' member.
    if (action === "get_health_assessment") {
      const dest = await resolveDestination(db, destination, tripId, userId);
      if (!dest) return json({
        error: "destination is required"
      }, 400);
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      let q = db.from("health_assessments").select("*").eq("user_id", userId).eq("destination", dest).gte("assessed_at", cutoff);
      q = tripId ? q.eq("trip_id", tripId) : q.is("trip_id", null);
      const { data: cached, error: cacheErr } = await q.maybeSingle();
      if (cacheErr) {
        console.error("[safety-health-intelligence] health_assessments read failed:", cacheErr.message);
        return json({
          error: "health_assessments read failed"
        }, 500);
      }
      if (cached) return json({
        available: true,
        assessment: cached,
        cached: true
      });
      const point = await geocode(dest, authHeader);
      if ("error" in point) return json(unavailable("assessment", point.error, point.provider));
      const outbreaks = await fetchOutbreaks(point, authHeader);
      if (!outbreaks.ok) return json(unavailable("assessment", outbreaks.reason, outbreaks.provider));
      return json({
        available: true,
        assessment: null,
        assessmentUnavailableReason: "no provider rates overall health risk or medical facility quality for a destination; " + "health_assessments is not written rather than filled with a placeholder",
        destination: dest,
        resolvedLocation: point.placeName ?? null,
        country: countryName(point.iso2) ?? point.iso2 ?? null,
        outbreaks: outbreaks.outbreaks,
        outbreaksScopedToDestination: outbreaks.scoped,
        ...outbreaks.scopeNote ? {
          scopeNote: outbreaks.scopeNote
        } : {},
        provenance: outbreaks.provenance ?? {
          provider: "who-cdc"
        },
        attribution: outbreaks.provenance?.attribution ?? "WHO Disease Outbreak News"
      });
    }
    // ── get_disaster_alerts ─────────────────────────────────────────────────
    if (action === "get_disaster_alerts") {
      const cutoff7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      let existingQ = db.from("disaster_alerts").select("*").eq("user_id", userId).gte("detected_at", cutoff7d);
      existingQ = tripId ? existingQ.eq("trip_id", tripId) : existingQ.is("trip_id", null);
      const { data: existing, error: existingErr } = await existingQ;
      if (existingErr) {
        console.error("[safety-health-intelligence] disaster_alerts read failed:", existingErr.message);
        return json({
          error: "disaster_alerts read failed"
        }, 500);
      }
      if (existing && existing.length > 0) {
        return json({
          available: true,
          alerts: existing,
          cached: true
        });
      }
      const dest = await resolveDestination(db, destination, tripId, userId);
      if (!dest) return json(unavailable("alerts", "no destination to check for disasters", null));
      const point = await geocode(dest, authHeader);
      if ("error" in point) return json(unavailable("alerts", point.error, point.provider));
      const quakes = await fetchEarthquakes(point, userId, tripId, authHeader);
      if (!quakes.ok) return json(unavailable("alerts", quakes.reason, quakes.provider));
      if (quakes.rows.length === 0) {
        // A real, checked "nothing found" — distinct from the unavailable
        // shape above, and distinct from the old silent empty array.
        return json({
          available: true,
          alerts: [],
          checked: {
            provider: "usgs",
            scope: "M4.5+ within 300km of the destination in the last 7 days"
          },
          resolvedLocation: point.placeName ?? null,
          provenance: quakes.provenance ?? {
            provider: "usgs"
          }
        });
      }
      const { data: saved, error: insertErr } = await db.from("disaster_alerts").insert(quakes.rows).select();
      if (insertErr) {
        console.error("[safety-health-intelligence] disaster_alerts insert failed:", insertErr.message);
        return json({
          error: insertErr.message
        }, 500);
      }
      return json({
        available: true,
        alerts: saved ?? [],
        resolvedLocation: point.placeName ?? null,
        provenance: quakes.provenance ?? {
          provider: "usgs"
        },
        attribution: quakes.provenance?.attribution ?? "U.S. Geological Survey"
      });
    }
    // ── get_trip_safety_health ──────────────────────────────────────────────
    if (action === "get_trip_safety_health") {
      if (!tripId) return json({
        error: "trip_id is required"
      }, 400);
      // Service-role client, so the user_id filter is the clamp, not RLS.
      const { data: reservations, error: resErr } = await db.from("booking_reservations").select("location").eq("trip_id", tripId).eq("user_id", userId);
      if (resErr) {
        console.error("[safety-health-intelligence] booking_reservations read failed:", resErr.message);
        return json({
          error: "booking_reservations read failed"
        }, 500);
      }
      const locations = [
        ...new Set((reservations ?? []).map((r)=>r.location).filter((l)=>!!l && !!l.trim()))
      ];
      if (locations.length === 0) {
        // Was: locations.push("Unknown destination"), then a full hashed
        // assessment of that literal.
        const fallback = await resolveDestination(db, undefined, tripId, userId);
        if (fallback) locations.push(fallback);
      }
      const safetyAssessments = [];
      const disasterAlerts = [];
      const healthOutbreaks = [];
      // Every capability that could not be consulted is named, so the caller
      // can tell "nothing is wrong" apart from "nothing could be checked".
      // Conflating those two is what the hashes and the mocks did.
      const unavailableCapabilities = [];
      if (locations.length === 0) {
        unavailableCapabilities.push({
          capability: "destination",
          reason: "this trip has no reservation locations and no destination set, so there is nothing to assess"
        });
      }
      const cutoff7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const { data: existingAlerts, error: alertsErr } = await db.from("disaster_alerts").select("*").eq("user_id", userId).eq("trip_id", tripId).gte("detected_at", cutoff7d);
      if (alertsErr) {
        console.error("[safety-health-intelligence] disaster_alerts read failed:", alertsErr.message);
        unavailableCapabilities.push({
          capability: "disasters",
          reason: "stored disaster alerts could not be read"
        });
      }
      let haveAlerts = !!existingAlerts && existingAlerts.length > 0;
      if (haveAlerts) disasterAlerts.push(...existingAlerts ?? []);
      for (const loc of locations){
        const point = await geocode(loc, authHeader);
        if ("error" in point) {
          unavailableCapabilities.push({
            capability: `safety:${loc}`,
            reason: point.error,
            provider: point.provider
          });
          unavailableCapabilities.push({
            capability: `health:${loc}`,
            reason: point.error,
            provider: point.provider
          });
          unavailableCapabilities.push({
            capability: `disasters:${loc}`,
            reason: point.error,
            provider: point.provider
          });
          continue;
        }
        // Safety — U.S. State Department advisory.
        const safety = await fetchSafety(loc, point, userId, tripId, authHeader);
        if (!safety.ok) {
          unavailableCapabilities.push({
            capability: `safety:${loc}`,
            reason: safety.reason,
            provider: safety.provider
          });
        } else {
          const { data: s, error: sErr } = await db.from("safety_assessments").upsert(safety.row, {
            onConflict: "user_id,trip_id,destination"
          }).select().single();
          if (sErr) {
            console.error("[safety-health-intelligence] safety_assessments upsert failed:", sErr.message);
            unavailableCapabilities.push({
              capability: `safety:${loc}`,
              reason: "assessment could not be stored"
            });
          } else if (s) {
            safetyAssessments.push(s);
          }
        }
        // Health — WHO Disease Outbreak News. Nothing is persisted; see header.
        const outbreaks = await fetchOutbreaks(point, authHeader);
        if (!outbreaks.ok) {
          unavailableCapabilities.push({
            capability: `health:${loc}`,
            reason: outbreaks.reason,
            provider: outbreaks.provider
          });
        } else {
          healthOutbreaks.push({
            location: loc,
            resolvedLocation: point.placeName ?? null,
            country: countryName(point.iso2) ?? point.iso2 ?? null,
            outbreaks: outbreaks.outbreaks,
            scopedToDestination: outbreaks.scoped,
            ...outbreaks.scopeNote ? {
              scopeNote: outbreaks.scopeNote
            } : {},
            source: "WHO Disease Outbreak News"
          });
        }
        // Disasters — USGS, already scoped to 300km of this point.
        if (!haveAlerts) {
          const quakes = await fetchEarthquakes(point, userId, tripId, authHeader);
          if (!quakes.ok) {
            unavailableCapabilities.push({
              capability: `disasters:${loc}`,
              reason: quakes.reason,
              provider: quakes.provider
            });
          } else if (quakes.rows.length > 0) {
            const { data: saved, error: insErr } = await db.from("disaster_alerts").insert(quakes.rows).select();
            if (insErr) {
              console.error("[safety-health-intelligence] disaster_alerts insert failed:", insErr.message);
              unavailableCapabilities.push({
                capability: `disasters:${loc}`,
                reason: "alerts could not be stored"
              });
            } else {
              disasterAlerts.push(...saved ?? []);
              haveAlerts = true;
            }
          }
        }
      }
      unavailableCapabilities.push({
        capability: "health_assessment",
        reason: "no provider rates overall health risk or medical facility quality; " + "WHO outbreak data is returned under health_outbreaks instead"
      });
      const riskOrder = RISK_LEVELS;
      // null, not "low". An unassessed trip is not a safe trip.
      const highestSafety = safetyAssessments.length ? safetyAssessments.reduce((max, a)=>riskOrder.indexOf(a.risk_level) > riskOrder.indexOf(max) ? a.risk_level : max, "low") : null;
      return json({
        safety_assessments: safetyAssessments,
        // Always empty now — nothing can be written to health_assessments
        // honestly. The real health data is in health_outbreaks.
        health_assessments: [],
        health_outbreaks: healthOutbreaks,
        disaster_alerts: disasterAlerts,
        unavailable: unavailableCapabilities,
        summary: {
          highest_safety_risk: highestSafety,
          highest_health_risk: null,
          disaster_count: disasterAlerts.length,
          total_alerts: safetyAssessments.length + disasterAlerts.length,
          capabilities_unavailable: unavailableCapabilities.length
        }
      });
    }
    // ── get_all_intelligence ────────────────────────────────────────────────
    if (action === "get_all_intelligence") {
      const [safetyRes, healthRes, disasterRes] = await Promise.all([
        db.from("safety_assessments").select("*").eq("user_id", userId).eq("trip_id", tripId),
        db.from("health_assessments").select("*").eq("user_id", userId).eq("trip_id", tripId),
        db.from("disaster_alerts").select("*").eq("user_id", userId).eq("trip_id", tripId)
      ]);
      // The old code destructured `data` only, so a failed query was
      // indistinguishable from an empty table.
      if (safetyRes.error) console.error("[safety-health-intelligence] safety_assessments read failed:", safetyRes.error.message);
      if (healthRes.error) console.error("[safety-health-intelligence] health_assessments read failed:", healthRes.error.message);
      if (disasterRes.error) console.error("[safety-health-intelligence] disaster_alerts read failed:", disasterRes.error.message);
      if (safetyRes.error || healthRes.error || disasterRes.error) {
        return json({
          error: "intelligence read failed"
        }, 500);
      }
      return json({
        safety: safetyRes.data ?? [],
        health: healthRes.data ?? [],
        disasters: disasterRes.data ?? []
      });
    }
    return json({
      error: "Unknown action"
    }, 400);
  } catch (err) {
    console.error("[safety-health-intelligence] unhandled:", err instanceof Error ? err.message : String(err));
    return json({
      error: "Internal server error"
    }, 500);
  }
});

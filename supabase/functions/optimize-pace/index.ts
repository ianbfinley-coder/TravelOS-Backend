// ITINERARY RECONCILIATION 2026-09-24 — optimize-pace is retired.
//
// It rewrote a legacy generated_itineraries row toward a pace goal, inserted a
// new GI row, and triggered validate-itinerary and create-itinerary-version
// (both retired). No current trip has a GI row; the live itinerary is
// itinerary_items, which change-plan edits. The mobile pace action was already
// removed.
//
// Every request now answers 410 GONE with a pointer to the replacement. The
// CORS preflight still answers so browsers see the 410 rather than a CORS
// failure. Nothing is read or written; no authentication is needed to be told
// an endpoint is gone. Previous source: orig/optimize-pace/ in the
// reconciliation bundle.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS'
};
const GONE_BODY = JSON.stringify({
  error: 'GONE',
  message: 'Retired 2026-09-24. Pace optimization rewrote the legacy AI plan, which no longer exists for current trips. Ask the Assistant to make a day more relaxed or add free time.'
});
Deno.serve((req)=>{
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS
    });
  }
  return new Response(GONE_BODY, {
    status: 410,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json'
    }
  });
});

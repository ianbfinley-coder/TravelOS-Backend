// ITINERARY RECONCILIATION 2026-09-24 — validate-itinerary is retired.
//
// It ran an AI validate-and-repair pass over a legacy generated_itineraries
// row and wrote the repaired plan back to that row. No current trip has a GI
// row (the live itinerary is itinerary_items), so it could only 404 or rewrite
// a dead record. Its only callers were generate-itinerary and restore-version,
// which no longer call it.
//
// Every request now answers 410 GONE with a pointer to the replacement. The
// CORS preflight still answers so browsers see the 410 rather than a CORS
// failure. Nothing is read or written; no authentication is needed to be told
// an endpoint is gone. Previous source: orig/validate-itinerary/ in the
// reconciliation bundle.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS'
};
const GONE_BODY = JSON.stringify({
  error: 'GONE',
  message: 'Retired 2026-09-24. It validated the legacy AI plan, which no longer exists for current trips. Trip health checks the live itinerary; ask the Assistant to fix problems.'
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

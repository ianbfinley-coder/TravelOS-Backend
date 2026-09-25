// ITINERARY RECONCILIATION 2026-09-24 — optimize-budget is retired.
//
// It applied budget_analyses savings opportunities by rewriting a legacy
// generated_itineraries row into a new GI row, then triggered validate-
// itinerary and create-itinerary-version (both retired). No current trip has a
// GI row; the live itinerary is itinerary_items. Savings from analyze-budget
// are shown read-only; the Assistant (change-plan) applies edits.
//
// Every request now answers 410 GONE with a pointer to the replacement. The
// CORS preflight still answers so browsers see the 410 rather than a CORS
// failure. Nothing is read or written; no authentication is needed to be told
// an endpoint is gone. Previous source: orig/optimize-budget/ in the
// reconciliation bundle.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS'
};
const GONE_BODY = JSON.stringify({
  error: 'GONE',
  message: 'Retired 2026-09-24. Ask the Assistant to apply savings.'
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

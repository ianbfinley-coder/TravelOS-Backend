// ITINERARY RECONCILIATION 2026-09-24 — change-plan-confirm is retired.
//
// It applied a single-item change by rewriting an itinerary_versions SNAPSHOT
// (or the legacy generated_itineraries row). That never changed the live
// itinerary (itinerary_items), so a confirmed change did not reach anything
// the traveler sees. change-plan with confirmed + proposed_changes applies
// edits to itinerary_items and records a version.
//
// Every request now answers 410 GONE with a pointer to the replacement. The
// CORS preflight still answers so browsers see the 410 rather than a CORS
// failure. Nothing is read or written; no authentication is needed to be told
// an endpoint is gone. Previous source: orig/change-plan-confirm/ in the
// reconciliation bundle.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS'
};
const GONE_BODY = JSON.stringify({
  error: 'GONE',
  message: 'Retired 2026-09-24. Use change-plan (preview via its response; confirm with confirmed + proposed_changes).'
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

// ITINERARY RECONCILIATION 2026-09-24 — create-itinerary-version is retired.
//
// It snapshotted a legacy generated_itineraries row into itinerary_versions
// (itinerary_id was required). No current trip has a GI row, so every call
// already 404'd. Versions of the live itinerary (itinerary_items) are now
// written by change-plan and by the itinerary_* RPCs, each of which records a
// flat snapshot and bumps trips.version.
//
// Every request now answers 410 GONE with a pointer to the replacement. The
// CORS preflight still answers so browsers see the 410 rather than a CORS
// failure. Nothing is read or written; no authentication is needed to be told
// an endpoint is gone. Previous source: orig/create-itinerary-version/ in the
// reconciliation bundle.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS'
};
const GONE_BODY = JSON.stringify({
  error: 'GONE',
  message: 'Retired 2026-09-24. Itinerary versions are now recorded automatically by change-plan and by the itinerary_add_items / itinerary_restore_version / itinerary_undo_change database functions.'
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

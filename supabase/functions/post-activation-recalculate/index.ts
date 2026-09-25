// ITINERARY RECONCILIATION 2026-09-24 — no more NO_SOURCE_ITINERARY.
// ---------------------------------------------------------------------------
// The health step below required itinerary_versions.source_itinerary_id (a
// generated_itineraries id) because analyze-trip-health did. Current trips'
// versions have no GI behind them, so every activation logged
// NO_SOURCE_ITINERARY, skipped health, and ended PARTIAL.
//
// The trip-health analyzers are now keyed by trip and read itinerary_items, so
// this function calls all three with { trip_id, version_id, user_id,
// force_refresh: true } on the service-role key it already holds:
//   * analyze-trip-health and analyze-daily-friction run in parallel;
//   * detect-trip-issues runs after both, because it reads the latest health
//     and friction rows as context;
//   * analyze-readiness is unchanged.
// The health version guard and the stamp-by-id write are unchanged (the new
// analyze-trip-health writes version_id, so the stamp now finds its row).
// issues_created / issues_resolved now come from detect-trip-issues'
// total_count / resolved_count when that call succeeds. A friction or issues
// failure is logged to pipeline-recovery (operation HEALTH_RECALCULATION, the
// analyzer named in failure_detail) and makes the run PARTIAL; it never makes
// the run FAILED, which still requires both health and readiness to fail. The
// response adds friction_error and issues_error.
// The "1." note under CROSS-FUNCTION CALLS 2026-09-19 below describes the
// previous GI-based body and the NO_SOURCE_ITINERARY path; both are superseded.
// ---------------------------------------------------------------------------
// SECURITY 2026-09-17 — this function had no authentication at all. Both
// GET (returns health/readiness detail: score, issues, money-relevant
// itinerary state) and POST (recalculates and WRITES trip_health_analyses
// and pre_trip_readiness for any trip_id/itinerary_version_id pair, with no
// ownership check) were reachable by anyone, unauthenticated, against a
// service_role client that does the reads and writes.
//
// Concrete attack: `curl -X POST .../post-activation-recalculate -d
// '{"trip_id":"<any-uuid>","itinerary_version_id":"<any-uuid>"}'` — no
// Authorization header needed at all — would recalculate and overwrite
// another user's trip_health_analyses / pre_trip_readiness rows. The GET
// form (`?trip_id=...&itinerary_version_id=...`) would read them, including
// the money-relevant issue detail embedded in trip_health_analyses.issues.
//
// This function is only ever invoked server-to-server: change-plan calls it
// with `Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>`, fire-and-forget,
// right after activating a new itinerary version (see change-plan's
// post-activation fetch to this function's URL). No client path was found
// calling it, on GET or POST. Gate: requireService — the service-role key
// is now required on both methods.
//
// ═══════════════════════════════════════════════════════════════════════
// CROSS-FUNCTION CALLS 2026-09-19 — both of this function's outbound calls
// pointed at slugs that are not deployed in this project. Neither had ever
// succeeded; the function's entire reason to exist was dead.
//
// 1. POST /trip-health — NO SUCH FUNCTION. `list_edge_functions` has no
//    `trip-health` slug. Every call returned the platform's 404, so
//    `healthResp.ok` was false, `healthError` was set to
//    "trip-health returned 404: ...", a PIPELINE_RECOVERY failure was logged,
//    and post_activation_status went to PARTIAL — on every single activation,
//    forever. Repointed to `analyze-trip-health`, which is the real trip
//    health engine and IS deployed.
//    Its gate is `requireUserOrService`, so the service-role key this function
//    already holds is accepted. Its required body is `itinerary_id` AND
//    `trip_id` AND `user_id` — all three, or it returns
//    400 "itinerary_id, trip_id, and user_id are required". The old body sent
//    only trip_id + itinerary_version_id + force_recalculate, so even against
//    the right slug it would have been a 400. The itinerary id is resolved
//    from `itinerary_versions.source_itinerary_id` (uuid, verified against
//    information_schema) on the version row already fetched below; the user id
//    comes from `itinerary_versions.user_id` or the request body. When
//    source_itinerary_id is null there is nothing to analyse and the run is
//    reported as unavailable rather than guessed at.
//    Its cache-bypass flag is `force_refresh`, not `force_recalculate` — the
//    old name was silently ignored, so a 30-minute-old analysis would have
//    been returned as if freshly computed.
//    Its response shape is `{ analysis: <row>, cached: bool }`, NOT a bare
//    `{ health_score, issues }`. The old code read `healthResult.health_score`
//    and `healthResult.issues` off the top level, both of which would have
//    been undefined even on success — so `healthScore` was always null, the
//    version guard and the follow-up write were skipped, and issues_created /
//    issues_resolved were always 0. Now read from `.analysis`.
//
// 2. POST /pre-trip-readiness — NO SUCH FUNCTION either. The real readiness
//    engine is `analyze-readiness`, and the slug is repointed to it.
//
//    RESOLVED 2026-09-19 (later the same day). This note used to say that
//    analyze-readiness was USER-JWT-ONLY — that it did
//    `supabase.auth.getUser(jwt)`, that a service-role key has no `sub` and
//    so resolved to nobody, and that "until that lands, post-activation
//    readiness recalculation cannot run at all". THAT IS NO LONGER TRUE, and
//    the note is corrected here rather than left to mislead the next reader.
//
//    The fix this note asked for has landed. analyze-readiness v17 gates with
//    `requireUserOrService` from `_shared/auth.ts`: a bearer matching
//    SUPABASE_SERVICE_ROLE_KEY is accepted as `{ kind: 'service' }`, the
//    `trip.user_id !== user.id` 403 is skipped for a service caller, and the
//    owning user is read out of `trips.user_id` for the supplied trip_id
//    (never from the request body). Verified against the deployed source on
//    2026-09-19.
//
//    So the call below now proceeds normally on the service credential this
//    function already holds, and a successful run writes readiness for real.
//    The 401/403 branch that named READINESS_TARGET_REJECTS_SERVICE_CREDENTIAL
//    is no longer the expected outcome; it is kept only as a genuine error
//    path (a rotated or mismatched service key, or a future regression in
//    analyze-readiness's gate) and is reported as the unexpected failure it
//    would now be. Nothing is defaulted or invented on that path either.
//
// 3. Both calls were already awaited with their status and body read, so the
//    "nobody reads the answer" half of the defect class was not present here;
//    only the credential/target half was. The one un-awaited call in this file
//    (the CANCELLED_STALE transition to pipeline-recovery) is now awaited and
//    logged too.
//
// COLUMN AUDIT 2026-09-19 — every column named in this file was checked
// against information_schema.columns. itinerary_versions has id, trip_id,
// user_id, source_itinerary_id, is_active, status, post_activation_status,
// version_number, health_recalculated_at, readiness_recalculated_at;
// trip_health_analyses has health_score, previous_health_score,
// health_score_change, health_status, issues, analyzed_at, source, alert_id,
// version_id; pre_trip_readiness has overall_status, open_item_count,
// critical_item_count, calculated_at, source, previous_readiness_score,
// itinerary_version_id. All present; no change needed.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireService } from "./_shared/auth.ts";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};
const JSON_HEADERS = {
  ...CORS_HEADERS,
  "Content-Type": "application/json"
};
async function logRecovery(params) {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/pipeline-recovery`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
      },
      body: JSON.stringify({
        action: 'log_failure',
        ...params
      })
    });
    if (res.ok) {
      const data = await res.json();
      return data.recovery_log_id ?? null;
    }
    const detail = await res.text().catch(()=>'<unreadable body>');
    console.error('[post-activation-recalculate] pipeline-recovery log_failure failed:', res.status, detail.slice(0, 300));
    return null;
  } catch (e) {
    console.error('[post-activation-recalculate] pipeline-recovery log_failure threw:', e instanceof Error ? e.message : String(e));
    return null;
  }
}
// ITINERARY RECONCILIATION 2026-09-24: one awaited, status-checked call to a
// trip-health analyzer on the service-role key. Never throws; a network error
// comes back as { ok: false, status: 0 }.
async function callAnalyzer(slug, payload) {
  try {
    const resp = await fetch(`${SUPABASE_URL}/functions/v1/${slug}`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    const text = await resp.text().catch(()=>'<unreadable body>');
    let json = null;
    try {
      json = JSON.parse(text);
    } catch  {
      json = null;
    }
    return {
      ok: resp.ok,
      status: resp.status,
      json,
      text
    };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      json: null,
      text: e instanceof Error ? e.message : String(e)
    };
  }
}
// ─────────────────────────────────────────────────────────────────────
// TASK 7: Version guard helper
// Checks if the given version_id is still the active version for the trip.
// Returns true if active, false if superseded.
// ─────────────────────────────────────────────────────────────────────
async function checkVersionStillActive(supabase, trip_id, version_id) {
  const { data } = await supabase.from('itinerary_versions').select('id, is_active').eq('id', version_id).eq('trip_id', trip_id).eq('is_active', true).maybeSingle();
  return !!data;
}
serve(async (req)=>{
  if (req.method === "OPTIONS") return new Response(null, {
    headers: CORS_HEADERS
  });
  // SECURITY 2026-09-17 — pipeline-only. See comment at top of file.
  const gate = requireService(req);
  if (gate instanceof Response) return gate;
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  try {
    if (req.method === "GET") {
      const url = new URL(req.url);
      const trip_id = url.searchParams.get("trip_id");
      const itinerary_version_id = url.searchParams.get("itinerary_version_id");
      if (!trip_id || !itinerary_version_id) {
        return new Response(JSON.stringify({
          error: "trip_id and itinerary_version_id are required"
        }), {
          status: 400,
          headers: JSON_HEADERS
        });
      }
      const { data: version, error: versionLookupError } = await supabase.from("itinerary_versions").select("id, post_activation_status, health_recalculated_at, readiness_recalculated_at, is_active, status").eq("id", itinerary_version_id).eq("trip_id", trip_id).maybeSingle();
      // A failed query is a 500 that says so; only a genuinely absent row is a
      // 404. Collapsing the two would report a broken query as "not found".
      if (versionLookupError) {
        console.error("[post-activation-recalculate] itinerary_versions lookup failed:", versionLookupError.message);
        return new Response(JSON.stringify({
          error: "Could not read itinerary version"
        }), {
          status: 500,
          headers: JSON_HEADERS
        });
      }
      if (!version) {
        return new Response(JSON.stringify({
          error: "Version not found"
        }), {
          status: 404,
          headers: JSON_HEADERS
        });
      }
      const { data: healthRecord } = await supabase.from("trip_health_analyses").select("health_score, previous_health_score, health_score_change, health_status, issues, analyzed_at, source").eq("version_id", itinerary_version_id).eq("trip_id", trip_id).order("analyzed_at", {
        ascending: false
      }).limit(1).maybeSingle();
      const { data: readinessRecord } = await supabase.from("pre_trip_readiness").select("overall_status, open_item_count, critical_item_count, calculated_at, source, previous_readiness_score").eq("itinerary_version_id", itinerary_version_id).eq("trip_id", trip_id).order("calculated_at", {
        ascending: false
      }).limit(1).maybeSingle();
      return new Response(JSON.stringify({
        itinerary_version_id,
        post_activation_status: version.post_activation_status,
        health_recalculated_at: version.health_recalculated_at,
        readiness_recalculated_at: version.readiness_recalculated_at,
        is_active: version.is_active,
        health: healthRecord || null,
        readiness: readinessRecord || null
      }), {
        headers: JSON_HEADERS
      });
    }
    if (req.method === "POST") {
      const body = await req.json();
      const { trip_id, itinerary_version_id, user_id, alert_id, proposal_id, source = "ACTIVATION", // TASK 7: recovery_operation_id for marking CANCELLED_STALE on version guard failure
      recovery_operation_id } = body;
      if (!trip_id || !itinerary_version_id) {
        return new Response(JSON.stringify({
          error: "trip_id and itinerary_version_id are required"
        }), {
          status: 400,
          headers: JSON_HEADERS
        });
      }
      // ITINERARY RECONCILIATION 2026-09-24: source_itinerary_id is no longer
      // needed — the analyzers take trip_id + version_id.
      const { data: version, error: versionError } = await supabase.from("itinerary_versions").select("id, trip_id, user_id, is_active, status, post_activation_status, version_number").eq("id", itinerary_version_id).eq("trip_id", trip_id).maybeSingle();
      // A query error and an absent row are different outcomes and get
      // different status codes.
      if (versionError) {
        console.error("[post-activation-recalculate] itinerary_versions lookup failed:", versionError.message);
        return new Response(JSON.stringify({
          error: "Could not read itinerary version",
          skipped: false
        }), {
          status: 500,
          headers: JSON_HEADERS
        });
      }
      if (!version) {
        return new Response(JSON.stringify({
          error: "Version not found",
          skipped: false
        }), {
          status: 404,
          headers: JSON_HEADERS
        });
      }
      if (!version.is_active) {
        return new Response(JSON.stringify({
          skipped: true,
          reason: "VERSION_NOT_ACTIVE"
        }), {
          headers: JSON_HEADERS
        });
      }
      if (version.post_activation_status === "COMPLETE" || version.post_activation_status === "RUNNING") {
        return new Response(JSON.stringify({
          skipped: true,
          reason: "ALREADY_PROCESSED",
          post_activation_status: version.post_activation_status
        }), {
          headers: JSON_HEADERS
        });
      }
      await supabase.from("itinerary_versions").update({
        post_activation_status: "RUNNING"
      }).eq("id", itinerary_version_id);
      const effectiveUserId = user_id || version.user_id;
      // ITINERARY RECONCILIATION 2026-09-24: the body all three trip-health
      // analyzers accept. force_refresh bypasses their 30-minute caches.
      const analyzerBody = {
        trip_id,
        version_id: itinerary_version_id,
        user_id: effectiveUserId,
        force_refresh: true
      };
      // Friction does not depend on health, so it starts now and is awaited
      // after the health step.
      const frictionPromise = callAnalyzer("analyze-daily-friction", analyzerBody);
      let previousHealthScore = null;
      try {
        const { data: prevHealth } = await supabase.from("trip_health_analyses").select("health_score, analyzed_at").eq("trip_id", trip_id).neq("version_id", itinerary_version_id).order("analyzed_at", {
          ascending: false
        }).limit(1).maybeSingle();
        if (prevHealth) previousHealthScore = prevHealth.health_score;
      } catch (e) {
        console.error("[post-activation-recalculate] Failed to fetch previous health score (non-fatal):", e);
      }
      let previousReadinessScore = null;
      try {
        const { data: prevReadiness } = await supabase.from("pre_trip_readiness").select("open_item_count, calculated_at").eq("trip_id", trip_id).neq("itinerary_version_id", itinerary_version_id).order("calculated_at", {
          ascending: false
        }).limit(1).maybeSingle();
        if (prevReadiness) previousReadinessScore = prevReadiness.open_item_count;
      } catch (e) {
        console.error("[post-activation-recalculate] Failed to fetch previous readiness score (non-fatal):", e);
      }
      let healthError = null;
      let healthScore = null;
      let issuesResolved = 0;
      let issuesCreated = 0;
      // ─── HEALTH RECALCULATION ── analyze-trip-health ───────────────────────
      // See CROSS-FUNCTION CALLS 2026-09-19 (1) at the top of this file: the
      // slug, the body and the response parsing were all wrong.
      // ITINERARY RECONCILIATION 2026-09-24: the NO_SOURCE_ITINERARY branch
      // that stood here is gone — analyze-trip-health is keyed by trip +
      // version and reads itinerary_items, so there is always something to
      // send it.
      if (!effectiveUserId) {
        healthError = 'NO_USER_ID: neither the request body nor itinerary_versions.user_id supplied a user id.';
        console.error("[post-activation-recalculate]", healthError);
        await supabase.from("itinerary_versions").update({
          post_activation_status: "PARTIAL"
        }).eq("id", itinerary_version_id);
      } else {
        try {
          const healthResp = await fetch(`${SUPABASE_URL}/functions/v1/analyze-trip-health`, {
            method: "POST",
            headers: {
              // analyze-trip-health gates with requireUserOrService, so the
              // service-role key is accepted here.
              "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
              "Content-Type": "application/json"
            },
            // { trip_id, version_id, user_id, force_refresh: true }. The flag is
            // `force_refresh`; `force_recalculate` was ignored.
            body: JSON.stringify(analyzerBody)
          });
          if (healthResp.ok) {
            // Response shape is { analysis: <trip_health_analyses row>, cached }.
            const healthPayload = await healthResp.json();
            const analysis = healthPayload?.analysis ?? null;
            healthScore = analysis && typeof analysis.health_score === "number" ? analysis.health_score : null;
            if (healthScore === null && healthPayload?.status === "no_itinerary") {
              healthError = 'NO_ITINERARY_ITEMS: analyze-trip-health found no itinerary_items for this trip, so nothing was scored.';
              console.error("[post-activation-recalculate]", healthError);
            } else if (healthScore === null) {
              healthError = 'NO_HEALTH_SCORE: analyze-trip-health returned 200 but its analysis carried no numeric health_score.';
              console.error("[post-activation-recalculate]", healthError);
            } else {
              // ─────────────────────────────────────────────────────────────
              // TASK 7: Version guard before writing health results
              // Only write if the version we calculated for is still active.
              // ─────────────────────────────────────────────────────────────
              const versionStillActive = await checkVersionStillActive(supabase, trip_id, itinerary_version_id);
              if (!versionStillActive) {
                // A newer version became active while we were calculating.
                // Do NOT overwrite health data. Mark this calc as stale.
                console.warn(`[post-activation-recalculate] Version ${itinerary_version_id} is no longer active. Health results discarded.`);
                healthError = 'VERSION_SUPERSEDED';
                // Mark recovery log as CANCELLED_STALE if we have a recovery_operation_id.
                // CROSS-FUNCTION CALLS 2026-09-19: this was an un-awaited
                // fetch with `.catch(() => {})`, so a 401/404/500 from
                // pipeline-recovery vanished. Awaited and logged now.
                if (recovery_operation_id) {
                  try {
                    const transitionResp = await fetch(`${SUPABASE_URL}/functions/v1/pipeline-recovery`, {
                      method: 'POST',
                      headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
                      },
                      body: JSON.stringify({
                        action: 'transition_state',
                        operation_id: recovery_operation_id,
                        from_state: 'ATTEMPTING',
                        to_state: 'CANCELLED_STALE',
                        reason: 'Health recalculation completed but version is no longer active — results discarded'
                      })
                    });
                    if (!transitionResp.ok) {
                      const detail = await transitionResp.text().catch(()=>'<unreadable body>');
                      console.error('[post-activation-recalculate] pipeline-recovery transition_state failed:', transitionResp.status, detail.slice(0, 300));
                    }
                  } catch (e) {
                    console.error('[post-activation-recalculate] pipeline-recovery transition_state threw:', e instanceof Error ? e.message : String(e));
                  }
                }
                await supabase.from("itinerary_versions").update({
                  post_activation_status: "PARTIAL"
                }).eq("id", itinerary_version_id);
              } else {
                // Version is still active — safe to write health results.
                //
                // ORDER/LIMIT ON UPDATE 2026-09-20 — PostgREST honours
                // `.order()` and `.limit()` only on a SELECT; chained onto an
                // `.update()` they are silently ignored and the write lands on
                // every row the `.eq()` filters match. So this did not stamp
                // the newest analysis for the version, it stamped every
                // analysis ever recorded for it, back-dating older rows'
                // source, previous_health_score, health_score_change and
                // alert_id with this run's values and destroying the history
                // the analyzed_at ordering exists to preserve. The target
                // row's id is selected first — where ORDER/LIMIT do apply —
                // and the update is keyed on that id alone.
                const { data: latestHealthRow, error: latestHealthLookupError } = await supabase.from("trip_health_analyses").select("id").eq("trip_id", trip_id).eq("version_id", itinerary_version_id).order("analyzed_at", {
                  ascending: false
                }).limit(1).maybeSingle();
                // A failed lookup and an absent row are different outcomes and
                // are logged as such; neither is grounds for falling back to
                // the unfiltered update this replaced.
                if (latestHealthLookupError) {
                  console.error("[post-activation-recalculate] trip_health_analyses latest-row lookup failed:", latestHealthLookupError.message);
                } else if (!latestHealthRow) {
                  console.error("[post-activation-recalculate] No trip_health_analyses row to stamp for trip", trip_id, "version", itinerary_version_id);
                } else {
                  const { error: healthStampError } = await supabase.from("trip_health_analyses").update({
                    source: source,
                    previous_health_score: previousHealthScore,
                    health_score_change: previousHealthScore !== null ? healthScore - previousHealthScore : null,
                    alert_id: alert_id || null
                  }).eq("id", latestHealthRow.id);
                  if (healthStampError) {
                    console.error("[post-activation-recalculate] trip_health_analyses update failed:", healthStampError.message);
                  }
                }
              }
            }
            const issues = analysis?.issues || [];
            issuesCreated = issues.filter((i)=>i.status === "OPEN" || !i.status).length;
            issuesResolved = issues.filter((i)=>i.status === "RESOLVED").length;
          } else {
            const errText = await healthResp.text().catch(()=>'<unreadable body>');
            healthError = `analyze-trip-health returned ${healthResp.status}: ${errText.slice(0, 300)}`;
            console.error("[post-activation-recalculate] analyze-trip-health failed (continuing):", healthError);
            await logRecovery({
              user_id: effectiveUserId,
              trip_id,
              operation: 'HEALTH_RECALCULATION',
              related_object_type: 'itinerary_version',
              related_object_id: itinerary_version_id,
              failure_type: 'PROCESSING_FAILED',
              failure_message: 'Trip health recalculation could not be completed',
              failure_detail: {
                error: healthError,
                source
              }
            });
            await supabase.from("itinerary_versions").update({
              post_activation_status: "PARTIAL"
            }).eq("id", itinerary_version_id);
          }
        } catch (e) {
          healthError = e instanceof Error ? e.message : String(e);
          console.error("[post-activation-recalculate] analyze-trip-health threw (continuing):", healthError);
          await logRecovery({
            user_id: effectiveUserId,
            trip_id,
            operation: 'HEALTH_RECALCULATION',
            related_object_type: 'itinerary_version',
            related_object_id: itinerary_version_id,
            failure_type: 'PROCESSING_FAILED',
            failure_message: 'Trip health recalculation could not be completed',
            failure_detail: {
              error: healthError,
              source
            }
          });
          await supabase.from("itinerary_versions").update({
            post_activation_status: "PARTIAL"
          }).eq("id", itinerary_version_id);
        }
      }
      // ─── FRICTION + ISSUES ── analyze-daily-friction, detect-trip-issues ───
      // ITINERARY RECONCILIATION 2026-09-24. Friction was started above in
      // parallel with health; issues run now because detect-trip-issues reads
      // the latest health and friction rows as context. Neither step writes
      // anything here — each analyzer persists its own rows keyed by
      // trip_id + version_id. A failure is recorded and reported, never
      // smoothed over.
      let frictionError = null;
      let issuesError = null;
      const frictionResult = await frictionPromise;
      if (!frictionResult.ok) {
        frictionError = `analyze-daily-friction returned ${frictionResult.status}: ${frictionResult.text.slice(0, 300)}`;
        console.error("[post-activation-recalculate] analyze-daily-friction failed (continuing):", frictionError);
        await logRecovery({
          user_id: effectiveUserId,
          trip_id,
          operation: 'HEALTH_RECALCULATION',
          related_object_type: 'itinerary_version',
          related_object_id: itinerary_version_id,
          failure_type: 'PROCESSING_FAILED',
          failure_message: 'Daily friction recalculation could not be completed',
          failure_detail: {
            analyzer: 'analyze-daily-friction',
            error: frictionError,
            source
          }
        });
      }
      const issuesResult = await callAnalyzer("detect-trip-issues", analyzerBody);
      if (issuesResult.ok) {
        const totalCount = issuesResult.json?.total_count;
        const resolvedCount = issuesResult.json?.resolved_count;
        if (typeof totalCount === "number") issuesCreated = totalCount;
        if (typeof resolvedCount === "number") issuesResolved = resolvedCount;
      } else {
        issuesError = `detect-trip-issues returned ${issuesResult.status}: ${issuesResult.text.slice(0, 300)}`;
        console.error("[post-activation-recalculate] detect-trip-issues failed (continuing):", issuesError);
        await logRecovery({
          user_id: effectiveUserId,
          trip_id,
          operation: 'HEALTH_RECALCULATION',
          related_object_type: 'itinerary_version',
          related_object_id: itinerary_version_id,
          failure_type: 'PROCESSING_FAILED',
          failure_message: 'Trip issue detection could not be completed',
          failure_detail: {
            analyzer: 'detect-trip-issues',
            error: issuesError,
            source
          }
        });
      }
      let readinessError = null;
      let readinessScore = null;
      // ─── READINESS RECALCULATION ── analyze-readiness ─────────────────────
      // See CROSS-FUNCTION CALLS 2026-09-19 (2). The slug `pre-trip-readiness`
      // is not deployed; `analyze-readiness` is the real engine and is what we
      // now call. As of analyze-readiness v17 it gates with
      // `requireUserOrService`, so the service-role key below is ACCEPTED and
      // this call is expected to succeed. A failure here is a real failure and
      // is reported as one, never smoothed over.
      try {
        const readinessResp = await fetch(`${SUPABASE_URL}/functions/v1/analyze-readiness`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json"
          },
          // analyze-readiness POST takes { trip_id } and derives everything
          // else from the verified user. It has no itinerary_version_id input.
          body: JSON.stringify({
            trip_id
          })
        });
        if (readinessResp.ok) {
          // Response shape is { readiness, items, tasks }. There is no
          // `readiness_score`; the comparable scalar this function tracks is
          // pre_trip_readiness.open_item_count, which is what
          // previousReadinessScore is read from above.
          const readinessPayload = await readinessResp.json();
          const readinessRow = readinessPayload?.readiness ?? null;
          readinessScore = readinessRow && typeof readinessRow.open_item_count === "number" ? readinessRow.open_item_count : null;
          const versionStillActiveForReadiness = await checkVersionStillActive(supabase, trip_id, itinerary_version_id);
          if (!versionStillActiveForReadiness) {
            console.warn(`[post-activation-recalculate] Version ${itinerary_version_id} is no longer active. Readiness results discarded.`);
            readinessError = 'VERSION_SUPERSEDED';
          // Do not write readiness data — version is stale
          } else {
            // Version still active — safe to write readiness results.
            //
            // ORDER/LIMIT ON UPDATE 2026-09-20 — same PostgREST behaviour as
            // the health write above: `.order()` and `.limit()` mean nothing
            // on an `.update()`, and here the only surviving filter was
            // `.eq("trip_id", ...)`. Every readiness row the trip has ever
            // had was rewritten, each one stamped with this run's
            // itinerary_version_id — so every historical row came to claim it
            // belonged to the newest version, which is corruption rather than
            // a mis-targeted write. The newest row for the trip is identified
            // by id first, and only that row is updated.
            const { data: latestReadinessRow, error: latestReadinessLookupError } = await supabase.from("pre_trip_readiness").select("id").eq("trip_id", trip_id).order("calculated_at", {
              ascending: false
            }).limit(1).maybeSingle();
            // A failed lookup and an absent row are different outcomes and are
            // logged as such; neither is grounds for falling back to the
            // unfiltered update this replaced.
            if (latestReadinessLookupError) {
              console.error("[post-activation-recalculate] pre_trip_readiness latest-row lookup failed:", latestReadinessLookupError.message);
            } else if (!latestReadinessRow) {
              console.error("[post-activation-recalculate] No pre_trip_readiness row to stamp for trip", trip_id);
            } else {
              const { error: readinessStampError } = await supabase.from("pre_trip_readiness").update({
                source: source,
                previous_readiness_score: previousReadinessScore,
                itinerary_version_id: itinerary_version_id
              }).eq("id", latestReadinessRow.id);
              if (readinessStampError) {
                console.error("[post-activation-recalculate] pre_trip_readiness update failed:", readinessStampError.message);
              }
            }
          }
        } else {
          const errText = await readinessResp.text().catch(()=>'<unreadable body>');
          if (readinessResp.status === 401 || readinessResp.status === 403) {
            // This used to be the EXPECTED outcome, described here as a known
            // structural limitation of analyze-readiness. It is not any more:
            // analyze-readiness v17 accepts the service-role key via
            // requireUserOrService. A 401/403 here now means the credential
            // itself is wrong (rotated or mismatched SUPABASE_SERVICE_ROLE_KEY
            // between the two functions) or analyze-readiness's gate has
            // regressed — both real, actionable faults rather than a standing
            // condition to be tolerated.
            readinessError = `READINESS_CREDENTIAL_REJECTED: analyze-readiness returned ${readinessResp.status} to this function's ` + `service-role key. analyze-readiness v17 gates with requireUserOrService and is expected to accept it, ` + `so this is an unexpected failure: check that SUPABASE_SERVICE_ROLE_KEY matches between the two ` + `functions and that analyze-readiness still uses requireUserOrService. Body: ${errText.slice(0, 200)}`;
          } else {
            readinessError = `analyze-readiness returned ${readinessResp.status}: ${errText.slice(0, 300)}`;
          }
          console.error("[post-activation-recalculate] analyze-readiness failed (continuing):", readinessError);
          await logRecovery({
            user_id: effectiveUserId,
            trip_id,
            operation: 'READINESS_RECALCULATION',
            related_object_type: 'itinerary_version',
            related_object_id: itinerary_version_id,
            failure_type: 'PROCESSING_FAILED',
            failure_message: 'Trip readiness recalculation could not be completed',
            failure_detail: {
              error: readinessError,
              source
            }
          });
        }
      } catch (e) {
        readinessError = e instanceof Error ? e.message : String(e);
        console.error("[post-activation-recalculate] analyze-readiness threw (continuing):", readinessError);
        await logRecovery({
          user_id: effectiveUserId,
          trip_id,
          operation: 'READINESS_RECALCULATION',
          related_object_type: 'itinerary_version',
          related_object_id: itinerary_version_id,
          failure_type: 'PROCESSING_FAILED',
          failure_message: 'Trip readiness recalculation could not be completed',
          failure_detail: {
            error: readinessError,
            source
          }
        });
      }
      // Determine final status
      // VERSION_SUPERSEDED is treated as a stale cancellation, not a hard failure
      const healthFailed = healthError !== null && healthError !== 'VERSION_SUPERSEDED';
      const readinessFailed = readinessError !== null && readinessError !== 'VERSION_SUPERSEDED';
      const healthSuperseded = healthError === 'VERSION_SUPERSEDED';
      const readinessSuperseded = readinessError === 'VERSION_SUPERSEDED';
      const bothFailed = healthFailed && readinessFailed;
      // Friction / issues failures make the run PARTIAL, never FAILED.
      const eitherFailed = healthFailed || readinessFailed || frictionError !== null || issuesError !== null;
      const eitherSuperseded = healthSuperseded || readinessSuperseded;
      const finalStatus = bothFailed ? "FAILED" : eitherFailed ? "PARTIAL" : eitherSuperseded ? "PARTIAL" : "COMPLETE";
      await supabase.from("itinerary_versions").update({
        post_activation_status: finalStatus,
        health_recalculated_at: healthFailed || healthSuperseded ? null : new Date().toISOString(),
        readiness_recalculated_at: readinessFailed || readinessSuperseded ? null : new Date().toISOString()
      }).eq("id", itinerary_version_id);
      if (bothFailed) {
        return new Response(JSON.stringify({
          success: false,
          post_activation_status: "FAILED",
          health_error: healthError,
          readiness_error: readinessError,
          friction_error: frictionError,
          issues_error: issuesError,
          itinerary_version_id
        }), {
          status: 500,
          headers: JSON_HEADERS
        });
      }
      const healthDelta = healthScore !== null && previousHealthScore !== null ? healthScore - previousHealthScore : null;
      const readinessDelta = readinessScore !== null && previousReadinessScore !== null ? readinessScore - previousReadinessScore : null;
      return new Response(JSON.stringify({
        success: true,
        post_activation_status: finalStatus,
        itinerary_version_id,
        health_score: healthScore,
        previous_health_score: previousHealthScore,
        health_delta: healthDelta,
        readiness_score: readinessScore,
        previous_readiness_score: previousReadinessScore,
        readiness_delta: readinessDelta,
        issues_resolved: issuesResolved,
        issues_created: issuesCreated,
        health_error: healthError,
        readiness_error: readinessError,
        friction_error: frictionError,
        issues_error: issuesError,
        version_superseded: eitherSuperseded
      }), {
        headers: JSON_HEADERS
      });
    }
    return new Response(JSON.stringify({
      error: "Method not allowed"
    }), {
      status: 405,
      headers: JSON_HEADERS
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[post-activation-recalculate] Unhandled error:", message);
    try {
      const body = await req.clone().json().catch(()=>({}));
      if (body.itinerary_version_id) {
        await supabase.from("itinerary_versions").update({
          post_activation_status: "FAILED"
        }).eq("id", body.itinerary_version_id);
      }
    } catch (_) {}
    return new Response(JSON.stringify({
      error: "Internal server error"
    }), {
      status: 500,
      headers: JSON_HEADERS
    });
  }
});

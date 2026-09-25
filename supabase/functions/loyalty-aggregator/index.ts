// TravelOS — loyalty-aggregator edge function
//
// Implements the 5A4 LoyaltyAggregator contract against the AwardWallet
// Account Access API (https://awardwallet.com/api/account, verified 2026-09-16).
//
// Design constraints, all from 5A4:
//   - No field anywhere accepts a loyalty-program password (5A4 AC #2).
//     The user authorises on AwardWallet's own site; we only ever hold an
//     AwardWallet API key and a connectedUser id.
//   - Missing configuration degrades to {status:"unavailable"} rather than
//     throwing, matching the provider-adapters convention already in TravelOS.
//   - Withheld expiry must never be conflated with "no expiry". AwardWallet
//     returns null expirationDate both when a program has no expiry and when
//     the subscription or access level hides it. We report expiryWithheld so
//     5A4's expiry job falls back to its own catalog computation.
//
// Secrets:
//   AWARDWALLET_API_KEY            required — business.awardwallet.com/profile/api
//   AWARDWALLET_CONNECT_URL        required — Business-account connection URL
//   AWARDWALLET_PAID_SUBSCRIPTION  optional — "true" when the Business plan is paid
//   AWARDWALLET_BASE_URL           optional — override for testing
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { requireUser } from "./_shared/auth.ts";
const DEFAULT_BASE_URL = "https://business.awardwallet.com/api/export/v1";
const PER_ID_LIMIT = 20;
const PER_ID_WINDOW_MS = 10 * 60 * 1000;
const PROVIDER_CODE_MAP = {
  MarriottRewards: "marriott_bonvoy",
  MarriottBonvoy: "marriott_bonvoy",
  HiltonHonors: "hilton_honors",
  HHonors: "hilton_honors",
  IHGRewardsClub: "ihg_one_rewards",
  IHGOneRewards: "ihg_one_rewards",
  ChoicePrivileges: "choice_privileges",
  WyndhamRewards: "wyndham_rewards",
  UnitedMileagePlus: "united_mileageplus",
  MileagePlus: "united_mileageplus",
  DeltaSkyMiles: "delta_skymiles",
  SkyMiles: "delta_skymiles",
  AmericanAAdvantage: "american_aadvantage",
  AAdvantage: "american_aadvantage",
  SouthwestRapidRewards: "southwest_rapid_rewards",
  RapidRewards: "southwest_rapid_rewards",
  Aeroplan: "aeroplan",
  AirCanadaAeroplan: "aeroplan"
};
const ELITE_HINTS = [
  "elite status",
  "elite level",
  "status",
  "membership level",
  "tier",
  "level"
];
// In-memory, per-isolate. A best-effort guard, not a distributed limiter —
// AwardWallet's own 429 is still handled below.
const rateWindows = new Map();
function rateLimitWaitMs(id) {
  const now = Date.now();
  const cutoff = now - PER_ID_WINDOW_MS;
  const hits = (rateWindows.get(id) ?? []).filter((t)=>t > cutoff);
  rateWindows.set(id, hits);
  if (hits.length < PER_ID_LIMIT) return 0;
  return Math.max(0, hits[0] + PER_ID_WINDOW_MS - now);
}
function recordRateHit(id) {
  const hits = rateWindows.get(id) ?? [];
  hits.push(Date.now());
  rateWindows.set(id, hits);
}
function slugify(code) {
  return code.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^a-zA-Z0-9]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "").toLowerCase();
}
function toProgramCode(awCode) {
  if (!awCode) return null;
  return PROVIDER_CODE_MAP[awCode] ?? slugify(awCode);
}
// DEFECT 2026-09-19 (accounts silently vanish) — the regex is anchored with
// `^`, so any display balance that does not START with a digit or minus sign
// — "$1,234", "£500", "~12,000" — parsed as null. normalizeAccount() then
// returned null for that account and normalizeAccounts() simply left it out,
// so the programme disappeared from the traveller's balance list with no
// trace: not shown, not counted, not reported as unreadable. The parser now
// finds the first number anywhere in the string, and anything still
// unreadable is reported to the caller rather than dropped in silence.
function parseDisplayBalance(balance) {
  if (!balance) return null;
  const match = /-?\d+(\.\d+)?/.exec(balance.replace(/[,\s]/g, ""));
  if (!match) return null;
  const n = Number(match[0]);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}
function extractEliteTier(properties) {
  if (!properties?.length) return undefined;
  for (const hint of ELITE_HINTS){
    const hit = properties.find((p)=>p.name?.trim().toLowerCase() === hint && p.value?.trim());
    if (hit?.value) return hit.value.trim();
  }
  for (const hint of ELITE_HINTS){
    const hit = properties.find((p)=>p.name?.toLowerCase().includes(hint) && p.value?.trim());
    if (hit?.value) return hit.value.trim();
  }
  return undefined;
}
function toIso(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
// deno-lint-ignore no-explicit-any
function normalizeAccount(account, expiryUnavailable, skipped) {
  const programCode = toProgramCode(account?.code);
  if (!programCode) {
    skipped.push({
      programCode: null,
      awCode: account?.code ?? null,
      reason: "AwardWallet returned no programme code for this account"
    });
    return null;
  }
  const raw = typeof account.balanceRaw === "number" && Number.isFinite(account.balanceRaw) ? Math.trunc(account.balanceRaw) : parseDisplayBalance(account.balance);
  if (raw === null) {
    skipped.push({
      programCode,
      awCode: account?.code ?? null,
      reason: account?.errorCode ? `AwardWallet could not read this account (error ${account.errorCode})` : "no readable balance was returned for this account"
    });
    return null;
  }
  const expiresOn = toIso(account.expirationDate);
  const login = account.login ?? undefined;
  // DEFECT 2026-09-19 (placeholder timestamp presented as a measurement) —
  // this line read:
  //     asOf: toIso(account.lastRetrieveDate) ?? toIso(account.lastChangeDate)
  //           ?? new Date().toISOString(),
  // When AwardWallet reported neither a last-retrieve nor a last-change date,
  // the balance was stamped with the current instant. The traveller was shown
  // a points balance "as of just now" for a figure that may have been
  // scraped weeks earlier, or never successfully scraped at all — and the
  // downstream 5A4 expiry job uses asOf to decide whether a balance is fresh
  // enough to reason about. An unknown timestamp is now null, and asOfKnown
  // says so explicitly.
  const asOf = toIso(account.lastRetrieveDate) ?? toIso(account.lastChangeDate);
  return {
    programCode,
    balance: raw,
    eliteTier: extractEliteTier(account.properties),
    asOf,
    asOfKnown: asOf !== null,
    expiresOn: expiresOn ?? undefined,
    expiryWithheld: expiresOn === null && expiryUnavailable,
    memberLast4: login && login.trim().length >= 4 ? login.trim().slice(-4) : undefined,
    externalAccountId: account.accountId,
    providerErrorCode: account.errorCode ?? null
  };
}
// deno-lint-ignore no-explicit-any
function normalizeAccounts(accounts, expiryUnavailable) {
  const out = [];
  const skipped = [];
  for (const account of accounts ?? []){
    const parent = normalizeAccount(account, expiryUnavailable, skipped);
    if (parent) out.push(parent);
    for (const sub of account?.subAccounts ?? []){
      const child = normalizeAccount(sub, expiryUnavailable, skipped);
      if (child) out.push(child);
    }
  }
  return {
    balances: out,
    skipped
  };
}
function readConfig() {
  const apiKey = Deno.env.get("AWARDWALLET_API_KEY");
  const connectUrl = Deno.env.get("AWARDWALLET_CONNECT_URL");
  const missing = [];
  if (!apiKey) missing.push("AWARDWALLET_API_KEY");
  if (!connectUrl) missing.push("AWARDWALLET_CONNECT_URL");
  if (missing.length) return {
    config: null,
    missing
  };
  return {
    config: {
      apiKey: apiKey,
      connectUrl: connectUrl,
      baseUrl: Deno.env.get("AWARDWALLET_BASE_URL") ?? DEFAULT_BASE_URL,
      paidSubscription: Deno.env.get("AWARDWALLET_PAID_SUBSCRIPTION") === "true"
    },
    missing: []
  };
}
async function awRequest(config, path, rateLimitId) {
  if (rateLimitId) {
    const wait = rateLimitWaitMs(rateLimitId);
    if (wait > 0) {
      throw Object.assign(new Error(`Rate limited locally for ${rateLimitId}; retry in ${Math.ceil(wait / 1000)}s`), {
        status: 429,
        retryable: true
      });
    }
    recordRateHit(rateLimitId);
  }
  const res = await fetch(`${config.baseUrl.replace(/\/+$/, "")}${path}`, {
    method: "GET",
    headers: {
      "X-Authentication": config.apiKey,
      Accept: "application/json"
    }
  });
  if (!res.ok) {
    const body = await res.text().catch(()=>"");
    throw Object.assign(new Error(`AwardWallet ${res.status} on ${path}`), {
      status: res.status,
      retryable: res.status === 429 || res.status >= 500,
      body: body.slice(0, 500)
    });
  }
  return await res.json();
}
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
    }
  });
}
// loyalty_aggregator_connections.access_level is a smallint with
// CHECK (access_level >= 0 AND access_level <= 3). AwardWallet's value went
// into the UPDATE unvalidated, so anything outside that range raised 23514 —
// and the UPDATE's error was discarded, so last_synced_at and status were
// never written while the response still reported a successful sync.
function validAccessLevel(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const n = Math.trunc(v);
  return n >= 0 && n <= 3 ? n : null;
}
Deno.serve(async (req)=>{
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
        "Access-Control-Allow-Methods": "POST, OPTIONS"
      }
    });
  }
  // Every action here is user-facing and acts on one user's loyalty-account
  // connection, including `status` (configuration-only, but still gated to
  // authenticated callers — see the doc comment on requireUser). Auth runs
  // before any database work and before any outbound AwardWallet call.
  //
  // NOTE: `supabase` is the caller-scoped anon client, which is correct here:
  // loyalty_aggregator_connections has own-row RLS policies for SELECT,
  // INSERT, UPDATE and DELETE keyed on auth.uid() = user_id, so the user's
  // own token is exactly the right authority for every statement below.
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;
  const { userId, client: supabase } = auth;
  const { config, missing } = readConfig();
  let action = "status";
  let payload = {};
  try {
    if (req.method === "POST") {
      const parsed = await req.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return json({
          error: "request body must be a JSON object"
        }, 400);
      }
      payload = parsed;
      action = payload.action ?? "status";
    }
  } catch  {
    return json({
      error: "invalid JSON body"
    }, 400);
  }
  // Unconfigured is a normal state, not an error — matches provider-adapters.
  if (!config) {
    return json({
      status: "unavailable",
      aggregator: "awardwallet",
      reason: `Not configured. Missing: ${missing.join(", ")}`,
      runbook: "AWARDWALLET_SETUP_RUNBOOK.md"
    });
  }
  if (action === "status") {
    // Configuration only — never the API key or the connect URL value itself.
    return json({
      status: "configured",
      aggregator: "awardwallet",
      baseUrl: config.baseUrl,
      paidSubscription: config.paidSubscription,
      expiryDataExpected: config.paidSubscription,
      note: config.paidSubscription ? "Expiry may still be withheld per-user at access levels 0-1, or without user AwardWallet Plus." : "Expiry will be withheld for all users until the Business plan is paid. 5A4 computes expiry from its own catalog instead."
    });
  }
  try {
    if (action === "link") {
      const url = new URL(config.connectUrl);
      // NOTE 2026-09-19 — `state` carries the caller's auth uuid to
      // AwardWallet and back. Nothing in this function ever reads it back:
      // `reconcile` matches on email instead. It is therefore not a trust
      // boundary today, which is just as well since it is unsigned. If a
      // callback is ever added that trusts `state`, it must be signed first.
      url.searchParams.set("state", userId);
      // DEFECT 2026-09-19 (a re-link downgrades a working connection) — this
      // upserted `status: 'pending'` unconditionally, so a user who opened
      // the link screen again while already connected had their row moved
      // back to 'pending' (external_user_id was left intact by the upsert, so
      // balances kept working while every status display said otherwise).
      // Only a row that is not already connected is moved to pending.
      const { data: existing, error: readErr } = await supabase.from("loyalty_aggregator_connections").select("status").eq("user_id", userId).eq("aggregator", "awardwallet").maybeSingle();
      if (readErr) {
        return json({
          error: `Could not read your connection state: ${readErr.message}`
        }, 500);
      }
      if (existing?.status !== "connected") {
        // DEFECT 2026-09-19 (discarded error) — the upsert's result was
        // dropped and the redirect URL returned regardless, so a user could
        // be sent to AwardWallet with no pending row recorded on this side.
        const { error: upsertErr } = await supabase.from("loyalty_aggregator_connections").upsert({
          user_id: userId,
          aggregator: "awardwallet",
          status: "pending"
        }, {
          onConflict: "user_id,aggregator"
        });
        if (upsertErr) {
          return json({
            error: `Could not record the pending link: ${upsertErr.message}`
          }, 500);
        }
      }
      return json({
        redirectUrl: url.toString(),
        alreadyConnected: existing?.status === "connected"
      });
    }
    if (action === "reconcile") {
      let email = String(payload.email ?? "").trim().toLowerCase();
      if (!email) {
        // Fall back to the authenticated caller's own email — never a body
        // field used as identity. `supabase` here is the requireUser-scoped
        // client, so this call re-validates the same session, it does not
        // widen the identity accepted.
        const { data: selfUser } = await supabase.auth.getUser();
        email = String(selfUser?.user?.email ?? "").trim().toLowerCase();
      }
      if (!email) return json({
        error: "email required to reconcile"
      }, 400);
      const users = await awRequest(config, "/connectedUser", // Was unlimited: the local guard was applied to the per-user call but
      // not to this one, so a client could poll /connectedUser without bound.
      `reconcile:${userId}`);
      if (!Array.isArray(users)) {
        // Previously `users.find` threw on a non-array body and surfaced as a
        // generic 500 with a TypeError message.
        throw Object.assign(new Error("AwardWallet /connectedUser did not return a list"), {
          status: 502,
          retryable: true
        });
      }
      const hit = users.find((u)=>u.email?.trim().toLowerCase() === email);
      if (!hit) {
        return json({
          connected: false,
          reason: "no matching connected user yet"
        });
      }
      // DEFECT 2026-09-19 (failure looks like success) — this upsert's error
      // was discarded and { connected: true } returned anyway. The mapping is
      // the entire point of reconcile: without it the very next `balances`
      // call reads no external_user_id and answers `connected: false`, so the
      // user was told they were connected and then told they were not.
      const { data: saved, error: upsertErr } = await supabase.from("loyalty_aggregator_connections").upsert({
        user_id: userId,
        aggregator: "awardwallet",
        external_user_id: hit.userId,
        external_email: email,
        status: "connected",
        last_error: null
      }, {
        onConflict: "user_id,aggregator"
      }).select("user_id");
      if (upsertErr) {
        return json({
          error: `Could not save the connection: ${upsertErr.message}`
        }, 500);
      }
      if (!saved || saved.length === 0) {
        return json({
          error: "The connection was not saved"
        }, 500);
      }
      return json({
        connected: true,
        externalUserId: hit.userId
      });
    }
    if (action === "balances") {
      const { data: conn, error: connErr } = await supabase.from("loyalty_aggregator_connections").select("external_user_id, access_level, status").eq("user_id", userId).eq("aggregator", "awardwallet").maybeSingle();
      // DEFECT 2026-09-19 (failure looks like absence) — this was
      //     const { data: conn } = await supabase...
      //     if (!conn?.external_user_id) return json({ connected: false, balances: [] });
      // so a failed read told a connected user that they had no loyalty
      // accounts linked and showed them an empty balance list — which invites
      // them to link again and, before this deploy, would have overwritten
      // their working connection with a pending one.
      if (connErr) {
        return json({
          error: `Could not read your connection: ${connErr.message}`
        }, 500);
      }
      if (!conn?.external_user_id) {
        return json({
          connected: false,
          balances: [],
          reason: conn ? `Your AwardWallet connection is "${conn.status}" and carries no AwardWallet user id yet.` : "No AwardWallet connection has been set up for this account."
        });
      }
      // deno-lint-ignore no-explicit-any
      const user = await awRequest(config, `/connectedUser/${encodeURIComponent(String(conn.external_user_id))}`, `user:${conn.external_user_id}`);
      // DEFECT 2026-09-19 (an invented access level) — this was
      //     const level = user?.accountsAccessLevel ?? user?.accessLevel ?? 1;
      // so when AwardWallet reported no access level at all, 1 was invented,
      // written to the database as the user's measured access_level, and
      // returned to the caller as `accessLevel: 1`. Unknown is now null. The
      // conservative consequence is unchanged — an unknown level still means
      // expiry is treated as withheld — but nothing claims to know a level it
      // was never told.
      const level = validAccessLevel(user?.accountsAccessLevel ?? user?.accessLevel);
      const expiryUnavailable = level === null || level <= 1 || !config.paidSubscription;
      const { balances, skipped } = normalizeAccounts(user?.accounts, expiryUnavailable);
      // DEFECT 2026-09-19 (discarded error) — the sync bookkeeping update
      // dropped its result, so last_synced_at could silently stop advancing
      // (for instance on the access_level CHECK violation described above)
      // while every response reported a clean sync.
      const updatePayload = {
        last_synced_at: new Date().toISOString(),
        last_error: null,
        status: "connected"
      };
      if (level !== null) updatePayload.access_level = level;
      const { error: updateErr } = await supabase.from("loyalty_aggregator_connections").update(updatePayload).eq("user_id", userId).eq("aggregator", "awardwallet");
      if (updateErr) {
        console.error("[loyalty-aggregator] sync bookkeeping update failed:", updateErr.message);
      }
      return json({
        connected: true,
        accessLevel: level,
        accessLevelKnown: level !== null,
        expiryAvailable: !expiryUnavailable,
        balances,
        // Accounts AwardWallet returned that could not be read. Previously
        // these were dropped without a word, so a missing programme looked
        // like a programme the traveller does not have.
        unreadableAccounts: skipped,
        syncRecorded: !updateErr
      });
    }
    if (action === "unlink") {
      // Clears only the TravelOS-side mapping. Revoking the AwardWallet
      // connection itself is the user's action on AwardWallet.
      //
      // DEFECT 2026-09-19 (failure looks like success) — this returned
      // { unlinked: true } unconditionally, with the update's error discarded
      // and no check that any row was touched. A user who asked to disconnect
      // their loyalty accounts was told it had been done while the mapping,
      // and TravelOS's ability to pull their balances, remained in place.
      const { data: revoked, error: unlinkErr } = await supabase.from("loyalty_aggregator_connections").update({
        status: "revoked",
        external_user_id: null
      }).eq("user_id", userId).eq("aggregator", "awardwallet").select("user_id");
      if (unlinkErr) {
        return json({
          unlinked: false,
          error: `Could not unlink: ${unlinkErr.message}`
        }, 500);
      }
      if (!revoked || revoked.length === 0) {
        return json({
          unlinked: false,
          reason: "There was no AwardWallet connection to unlink."
        });
      }
      return json({
        unlinked: true
      });
    }
    return json({
      error: `unknown action: ${action}`
    }, 400);
  } catch (err) {
    // deno-lint-ignore no-explicit-any
    const e = err;
    const status = typeof e?.status === "number" ? e.status : 500;
    const { error: errorWriteErr } = await supabase.from("loyalty_aggregator_connections").update({
      last_error: String(e?.message ?? err).slice(0, 500)
    }).eq("user_id", userId).eq("aggregator", "awardwallet");
    if (errorWriteErr) {
      console.error("[loyalty-aggregator] last_error write failed:", errorWriteErr.message);
    }
    return json({
      error: String(e?.message ?? err),
      retryable: Boolean(e?.retryable)
    }, status === 429 ? 429 : status >= 500 ? 502 : status);
  }
});

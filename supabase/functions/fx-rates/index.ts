// fx-rates — currency converter backend. Written 2026-09-22, deployed 2026-09-23.
//
// Routes (all under /functions/v1/fx-rates):
//   POST /refresh                          cron key or service key only
//   GET  /latest?base=EUR                  full table for offline caching
//   GET  /convert?from=USD&to=EUR&amount_minor=12345
//   GET  /history?from=USD&to=EUR&days=30  (max 90)
//   GET  /currencies
//
// Rules this follows (build queue): no fabricated values — a missing rate is a
// 404 with a plain message, never a guess; stale rates are served but flagged;
// every refresh records its outcome in api_service_health and raises an
// api_alerts row on failure so the alert-notifier emails it.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const PRIMARY = 'frankfurter';
const FALLBACK = 'exchangerate-api';
const STALE_DAYS = 3;
const FETCH_TIMEOUT_MS = 12000;
// ISO 4217 minor units that differ from the default of 2.
const MINOR_UNITS = {
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  UYI: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
  CLF: 4,
  UYW: 4
};
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-key',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};
function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS,
      'Content-Type': 'application/json',
      ...extra
    }
  });
}
const ok = (data, cache = 'public, max-age=900')=>json({
    success: true,
    data
  }, 200, {
    'Cache-Control': cache
  });
const fail = (code, message, status)=>json({
    success: false,
    error: {
      code,
      message
    }
  }, status);
const isCode = (s)=>!!s && /^[A-Za-z]{3}$/.test(s);
const daysOld = (asOf)=>Math.floor((Date.now() - new Date(`${asOf}T00:00:00Z`).getTime()) / 86_400_000);
function timingSafeEqual(a, b) {
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for(let i = 0; i < Math.max(ea.length, eb.length); i++)diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}
async function authorizeCron(req, admin) {
  const bearer = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '').trim();
  if (bearer && timingSafeEqual(bearer, SERVICE_ROLE_KEY)) return true;
  const key = req.headers.get('x-cron-key');
  if (!key) return false;
  const { data, error } = await admin.rpc('verify_cron_key', {
    p_key: key
  });
  if (error) {
    console.error('[fx-rates] verify_cron_key failed:', error.message);
    return false;
  }
  return data === true;
}
// Per-IP flood backstop, same RPC and fail-open-loudly behavior as the other cost centres.
async function ipAllowed(req, admin) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  const { data, error } = await admin.rpc('rate_limit_hit', {
    p_bucket_key: `fx-rates:ip:${ip}`,
    p_bucket_type: 'strict',
    p_limit: 300,
    p_window_seconds: 300
  });
  if (error) {
    console.error('[fx-rates] RATE LIMIT NOT ENFORCED:', error.message);
    return null;
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (row && row.is_allowed === false) {
    return json({
      success: false,
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many requests. Try again shortly.'
      }
    }, 429, {
      'Retry-After': String(row.retry_after_seconds ?? 60)
    });
  }
  return null;
}
async function fetchJson(url) {
  const ctl = new AbortController();
  const t = setTimeout(()=>ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: {
        Accept: 'application/json'
      }
    });
    if (!res.ok) throw new Error(`${url} returned ${res.status}`);
    return await res.json();
  } finally{
    clearTimeout(t);
  }
}
async function fromFrankfurter() {
  const [rates, currencies] = await Promise.all([
    fetchJson('https://api.frankfurter.dev/v2/rates?base=USD'),
    fetchJson('https://api.frankfurter.dev/v2/currencies')
  ]);
  if (!Array.isArray(rates) || rates.length === 0) throw new Error('frankfurter returned no rates');
  const out = {
    USD: 1
  };
  let asOf = rates[0].date;
  for (const r of rates){
    if (isCode(r.quote) && typeof r.rate === 'number' && r.rate > 0) out[r.quote.toUpperCase()] = r.rate;
    if (r.date > asOf) asOf = r.date;
  }
  const names = {};
  for (const c of Array.isArray(currencies) ? currencies : []){
    if (isCode(c.iso_code)) names[c.iso_code.toUpperCase()] = {
      name: c.name,
      symbol: c.symbol ?? null
    };
  }
  return {
    source: PRIMARY,
    asOf,
    rates: out,
    names
  };
}
async function fromExchangeRateApi() {
  const body = await fetchJson('https://open.er-api.com/v6/latest/USD');
  if (body.result !== 'success' || !body.rates || !body.time_last_update_unix) {
    throw new Error('exchangerate-api returned an unusable body');
  }
  const asOf = new Date(body.time_last_update_unix * 1000).toISOString().slice(0, 10);
  const out = {};
  for (const [k, v] of Object.entries(body.rates))if (isCode(k) && v > 0) out[k.toUpperCase()] = v;
  out.USD = 1;
  return {
    source: FALLBACK,
    asOf,
    rates: out,
    names: {}
  };
}
async function recordHealth(admin, status, note) {
  const now = new Date().toISOString();
  const { error } = await admin.from('api_service_health').upsert({
    service: 'fx-rates',
    status,
    consecutive_failures: status === 'healthy' ? 0 : 1,
    last_success_at: status === 'down' ? null : now,
    last_failure_at: status === 'healthy' ? null : now,
    updated_at: now
  }, {
    onConflict: 'service'
  });
  if (error) console.error('[fx-rates] could not record health:', error.message);
  console.log(`[fx-rates] ${status}: ${note}`);
}
async function raiseAlert(admin, message, details) {
  const { error } = await admin.from('api_alerts').insert({
    id: `alt_fx_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`,
    severity: 'warning',
    kind: 'fx_refresh_failed',
    service: 'fx-rates',
    message,
    details
  });
  if (error) console.error('[fx-rates] could not raise alert:', error.message);
}
async function refresh(admin) {
  const errors = [];
  let set = null;
  for (const load of [
    fromFrankfurter,
    fromExchangeRateApi
  ]){
    try {
      set = await load();
      break;
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  if (!set) {
    await recordHealth(admin, 'down', errors.join(' | '));
    await raiseAlert(admin, 'Both exchange-rate sources failed; converter is serving older rates.', {
      errors
    });
    return fail('SOURCES_UNAVAILABLE', 'No exchange-rate source is reachable.', 502);
  }
  // Currencies first (FK). Keep existing names; only fill what we learned.
  const { data: known, error: kErr } = await admin.from('currencies').select('iso_code');
  if (kErr) return fail('DB_ERROR', 'Could not read currencies.', 500);
  const knownSet = new Set((known ?? []).map((r)=>r.iso_code));
  const curRows = Object.keys(set.rates).filter((c)=>set.names[c] || !knownSet.has(c)).map((c)=>({
      iso_code: c,
      name: set.names[c]?.name ?? c,
      symbol: set.names[c]?.symbol ?? null,
      minor_units: MINOR_UNITS[c] ?? 2,
      updated_at: new Date().toISOString()
    }));
  if (curRows.length) {
    const { error } = await admin.from('currencies').upsert(curRows, {
      onConflict: 'iso_code'
    });
    if (error) {
      await recordHealth(admin, 'down', `currencies upsert: ${error.message}`);
      return fail('DB_ERROR', 'Could not save currencies.', 500);
    }
  }
  const rateRows = Object.entries(set.rates).map(([quote, usd_rate])=>({
      as_of: set.asOf,
      quote,
      usd_rate,
      source: set.source,
      fetched_at: new Date().toISOString()
    }));
  const { error: rErr, count } = await admin.from('fx_rates').upsert(rateRows, {
    onConflict: 'as_of,quote,source',
    count: 'exact'
  });
  if (rErr) {
    await recordHealth(admin, 'down', `fx_rates upsert: ${rErr.message}`);
    return fail('DB_ERROR', 'Could not save rates.', 500);
  }
  const status = set.source === PRIMARY ? 'healthy' : 'degraded';
  await recordHealth(admin, status, `${count ?? rateRows.length} rates from ${set.source} as of ${set.asOf}`);
  if (status === 'degraded') {
    await raiseAlert(admin, 'Primary exchange-rate source failed; using fallback.', {
      errors,
      fallback: set.source
    });
  }
  return ok({
    source: set.source,
    as_of: set.asOf,
    saved: count ?? rateRows.length,
    errors
  }, 'no-store');
}
async function latestTable(admin) {
  const { data, error } = await admin.from('fx_latest').select('quote, usd_rate, as_of, source, minor_units');
  if (error) throw new Error(error.message);
  return data ?? [];
}
Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') return new Response(null, {
    headers: CORS
  });
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const url = new URL(req.url);
  const route = url.pathname.replace(/^.*\/fx-rates/, '') || '/';
  try {
    if (route === '/refresh') {
      if (req.method !== 'POST') return fail('METHOD', 'Use POST.', 405);
      if (!await authorizeCron(req, admin)) return fail('UNAUTHORIZED', 'Cron key or service key required.', 401);
      return await refresh(admin);
    }
    if (req.method !== 'GET') return fail('METHOD', 'Use GET.', 405);
    const limited = await ipAllowed(req, admin);
    if (limited) return limited;
    if (route === '/currencies') {
      const { data, error } = await admin.from('currencies').select('iso_code, name, symbol, minor_units').eq('active', true).order('iso_code');
      if (error) {
        console.error('[fx-rates] currencies:', error.message);
        return fail('DB_ERROR', 'Could not load currencies.', 500);
      }
      return ok({
        currencies: data ?? []
      }, 'public, max-age=86400');
    }
    if (route === '/latest') {
      const base = (url.searchParams.get('base') ?? 'USD').toUpperCase();
      if (!isCode(base)) return fail('BAD_REQUEST', 'base must be a 3-letter currency code.', 400);
      const rows = await latestTable(admin);
      const b = rows.find((r)=>r.quote === base);
      if (!b) return fail('NO_RATE', `No rate is available for ${base}.`, 404);
      const baseUsd = Number(b.usd_rate);
      const rates = {};
      let asOf = b.as_of;
      const sources = new Set();
      for (const r of rows){
        rates[r.quote] = Number((Number(r.usd_rate) / baseUsd).toPrecision(12));
        if (r.as_of < asOf) asOf = r.as_of;
        sources.add(r.source);
      }
      return ok({
        base,
        as_of: asOf,
        stale: daysOld(asOf) > STALE_DAYS,
        rate_type: 'mid-market',
        sources: [
          ...sources
        ],
        minor_units: Object.fromEntries(rows.map((r)=>[
            r.quote,
            r.minor_units
          ])),
        rates
      });
    }
    if (route === '/convert') {
      const from = url.searchParams.get('from'), to = url.searchParams.get('to');
      const amt = url.searchParams.get('amount_minor');
      if (!isCode(from) || !isCode(to)) return fail('BAD_REQUEST', 'from and to must be 3-letter currency codes.', 400);
      if (!amt || !/^-?\d{1,15}$/.test(amt)) return fail('BAD_REQUEST', 'amount_minor must be a whole number of minor units.', 400);
      const { data, error } = await admin.rpc('fx_convert', {
        p_from: from.toUpperCase(),
        p_to: to.toUpperCase(),
        p_amount_minor: Number(amt)
      });
      if (error) {
        console.error('[fx-rates] fx_convert:', error.message);
        return fail('DB_ERROR', 'Could not convert right now.', 500);
      }
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) return fail('NO_RATE', `No rate is available for ${from.toUpperCase()} to ${to.toUpperCase()}.`, 404);
      return ok({
        from: from.toUpperCase(),
        to: to.toUpperCase(),
        amount_minor: Number(amt),
        converted_minor: Number(row.converted_minor),
        rate: Number(row.rate),
        as_of: row.as_of,
        source: row.source,
        stale: row.stale,
        rate_type: 'mid-market'
      });
    }
    if (route === '/history') {
      const from = url.searchParams.get('from'), to = url.searchParams.get('to');
      const days = Math.min(90, Math.max(1, Number(url.searchParams.get('days') ?? 30) || 30));
      if (!isCode(from) || !isCode(to)) return fail('BAD_REQUEST', 'from and to must be 3-letter currency codes.', 400);
      const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
      const { data, error } = await admin.from('fx_rates').select('as_of, quote, usd_rate, source').in('quote', [
        from.toUpperCase(),
        to.toUpperCase()
      ]).eq('source', PRIMARY).gte('as_of', since).order('as_of');
      if (error) {
        console.error('[fx-rates] history:', error.message);
        return fail('DB_ERROR', 'Could not load history.', 500);
      }
      const byDate = new Map();
      for (const r of data ?? []){
        const m = byDate.get(r.as_of) ?? {};
        m[r.quote] = Number(r.usd_rate);
        byDate.set(r.as_of, m);
      }
      const F = from.toUpperCase(), T = to.toUpperCase();
      const series = [
        ...byDate.entries()
      ].filter(([, m])=>m[F] && m[T]).map(([date, m])=>({
          date,
          rate: Number((m[T] / m[F]).toPrecision(10))
        }));
      return ok({
        from: F,
        to: T,
        days,
        source: PRIMARY,
        series
      });
    }
    return fail('NOT_FOUND', 'Unknown route.', 404);
  } catch (e) {
    console.error('[fx-rates] unhandled:', e instanceof Error ? e.stack : String(e));
    return fail('INTERNAL', 'Something went wrong. Try again.', 500);
  }
});

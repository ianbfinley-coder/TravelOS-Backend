// SECURITY 2026-09-17 — Authentication itself was real here (verifyJwt
// decoded and verified the caller's JWT via auth.getUser(), not a presence
// check), but nothing checked that the authenticated caller actually owned
// the trip being queried. /forecast, /burn, and /coach all took a tripId
// query param, then loaded from the `trips` table and its children
// (reservations, itinerary_items, personal_calibration-scoped costs) through
// a service_role client that bypasses RLS, with no `.eq('user_id', ...)`
// filter anywhere in the chain. Any authenticated user could read any other
// user's trip forecast, burn-rate/spending status, and personalized
// savings-coach tips by passing an arbitrary tripId — trips.id is an
// enumerable uuid. Fixed by requiring the verified caller to own the trip
// (requireTripOwner — trips.id/user_id are both uuid, a direct comparison)
// immediately after validating tripId, before any data is loaded, in all
// three handlers. Returns 404, not 403, so trip ids cannot be enumerated.
// /calibrate takes no tripId and only ever reads/writes the caller's own
// expenses and personal_calibration rows, so it needed no ownership check.
// /cost-index and /phrases return public reference data and are left open.
//
// DEFECT 2026-09-19 — EVERY FORECAST THIS FUNCTION HAS EVER RETURNED WAS
// ZERO, DENOMINATED IN US DOLLARS, AND PRESENTED AS A REAL FORECAST.
//
// The whole computation was addressed to columns that do not exist. Because
// both loaders used `select('*')`, PostgREST raised no error — the fields
// simply came back `undefined`, every comparison was false, and every lookup
// fell through to a `?? 0`:
//
//   trips        has NO city_code, destination_city_code, country_code,
//                destination_country_code, budget_tier or prefers_taxi.
//                It has: destination, start_date, end_date, base_currency,
//                primary_tz, title, name, status, version.
//                -> cityCode was always '', so the cost_index was never
//                   queried at all, `idx` was always empty, and every
//                   `getIndex(...)?.p50_minor ?? 0` returned 0.
//                -> `currency = costRows[0]?.currency ?? 'USD'` therefore
//                   ALWAYS resolved to USD, whatever the trip.
//
//   reservations has NO type, check_in, check_out or cost.
//                It has: reservation_type, start_date, end_date,
//                current_price_amount, current_price_currency,
//                original_price_amount.
//                -> every `reservations.filter(r => r.type === 'hotel')` and
//                   similar matched NOTHING, so "booked" was 0 in every
//                   category, and bookedNights was 0 so the trip looked
//                   entirely unbooked.
//
//   expenses     has NO user_id. It has paid_by.
//                -> loadExpenses' `.eq('user_id', ...)` is a real 42703 that
//                   PostgREST rejects outright; the error was discarded and
//                   `?? []` returned, so /burn reported spentToDate: 0 for
//                   every traveller on every trip, mid-trip, and computed a
//                   "safe to spend today" figure from it. handleCalibrate had
//                   the same query and so never produced a calibration.
//
// The result was a fully-formed TripForecast object — categories, p50/p80
// bands, per-day figures, a confidence rating — in which every number was
// zero and the currency was invented, cached into trip_forecasts, and shown
// to the traveller as their budget forecast.
//
// Fixed by reading the real columns, and — where the underlying data genuinely
// is not available (there is no city code anywhere in this schema, so the
// cost_index cannot be keyed) — by returning an explicit null with a reason
// instead of a zero. A forecast that cannot be made is now reported as one
// that cannot be made.
import { requireUser, requireTripOwner, serviceClient } from './_shared/auth.ts';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS,
      'Content-Type': 'application/json'
    }
  });
}
function err(code, message, status) {
  return json({
    error: {
      code,
      message
    }
  }, status);
}
// ─── Helpers ─────────────────────────────────────────────────────
function daysBetween(a, b) {
  return Math.max(0, Math.round((b.getTime() - a.getTime()) / 86400000));
}
function isStale(observedOn) {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 18);
  return new Date(observedOn) < cutoff;
}
function indexMap(rows) {
  const m = new Map();
  for (const r of rows)m.set(`${r.item}:${r.tier}`, r);
  return m;
}
function money(amountMinor, currency) {
  return {
    amountMinor: Math.round(amountMinor),
    currency
  };
}
/** Reservation price in minor units, from the columns that actually exist. */ function reservationPriceMinor(r) {
  const raw = r?.current_price_amount ?? r?.original_price_amount;
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}
function reservationType(r) {
  return String(r?.reservation_type ?? '').toUpperCase();
}
// ─── Load helpers ──────────────────────────────────────────────────
async function loadTrip(svc, tripId) {
  const { data, error } = await svc.from('trips').select('*').eq('id', tripId).maybeSingle();
  if (error) {
    console.error('[budget-forecast] trip read failed:', error.code, error.message);
    return null;
  }
  return data;
}
async function loadReservations(svc, tripId) {
  const { data, error } = await svc.from('reservations').select('*').eq('trip_id', tripId);
  if (error) {
    console.error('[budget-forecast] reservations read failed:', error.code, error.message);
    throw new Error(`Failed to load reservations: ${error.message}`);
  }
  return data ?? [];
}
async function loadItineraryItems(svc, tripId) {
  const { data, error } = await svc.from('itinerary_items').select('*').eq('trip_id', tripId);
  if (error) {
    console.error('[budget-forecast] itinerary_items read failed:', error.code, error.message);
    throw new Error(`Failed to load itinerary items: ${error.message}`);
  }
  return data ?? [];
}
async function loadCostIndex(svc, cityCode) {
  const { data, error } = await svc.from('cost_index').select('*').eq('city_code', cityCode);
  if (error) {
    console.error('[budget-forecast] cost_index read failed:', error.code, error.message);
    return [];
  }
  return data ?? [];
}
/**
 * The caller's own expenses on a trip.
 *
 * DEFECT 2026-09-19 — this filtered `.eq('user_id', userId)`. `expenses` has
 * no user_id column; the payer is `paid_by`. That is a 42703 which PostgREST
 * rejects outright, and the error was discarded, so this returned [] for
 * everyone, always — which /burn then reported as "you have spent nothing".
 */ async function loadExpenses(svc, tripId, userId) {
  const { data, error } = await svc.from('expenses').select('*').eq('trip_id', tripId).eq('paid_by', userId).is('deleted_at', null);
  if (error) {
    console.error('[budget-forecast] expenses read failed:', error.code, error.message);
    throw new Error(`Failed to load expenses: ${error.message}`);
  }
  return data ?? [];
}
async function loadTripMembers(svc, tripId) {
  const { data, error } = await svc.from('trip_members').select('*').eq('trip_id', tripId).is('removed_at', null);
  if (error) {
    console.error('[budget-forecast] trip_members read failed:', error.code, error.message);
    return [];
  }
  return data ?? [];
}
async function loadCachedForecast(svc, tripId, scope, memberId) {
  const memberVal = memberId ?? '';
  const { data, error } = await svc.from('trip_forecasts').select('*').eq('trip_id', tripId).eq('scope', scope).eq('member_id', memberVal).gte('generated_at', new Date(Date.now() - 30 * 60 * 1000).toISOString()).maybeSingle();
  if (error) {
    console.error('[budget-forecast] cached forecast read failed:', error.code, error.message);
    return null;
  }
  if (!data) return null;
  return data.forecast;
}
async function saveForecast(svc, tripId, scope, memberId, forecast) {
  const memberVal = memberId ?? '';
  const { error } = await svc.from('trip_forecasts').upsert({
    trip_id: tripId,
    scope,
    member_id: memberVal,
    forecast,
    generated_at: new Date().toISOString()
  }, {
    onConflict: 'trip_id,scope,member_id'
  });
  if (error) {
    console.error('[budget-forecast] forecast save failed:', error.code, error.message);
  }
}
// ─── Forecast computation ─────────────────────────────────────────────
/**
 * `cost_index` is keyed by city_code. Nothing in `trips` carries a city code —
 * the only location field is the free-text `destination` — so unless a caller
 * supplies one there is no way to look up typical prices for this trip. The
 * old code papered over that with `cityCode = trip?.city_code ?? ''` and then
 * `?? 0` on every index lookup, producing a forecast of zero.
 */ function resolveCityCode(trip, override) {
  const candidate = override ?? trip?.city_code ?? trip?.destination_city_code ?? null;
  const trimmed = typeof candidate === 'string' ? candidate.trim() : '';
  return trimmed.length > 0 ? trimmed : null;
}
async function computeForecast(svc, tripId, scope, userId, cityCodeOverride) {
  console.log('[budget-forecast] computeForecast', {
    tripId,
    scope,
    userId
  });
  const trip = await loadTrip(svc, tripId);
  const reservations = await loadReservations(svc, tripId);
  const itineraryItems = await loadItineraryItems(svc, tripId);
  const cityCode = resolveCityCode(trip, cityCodeOverride);
  const preferredTier = 'mid';
  let costRows = [];
  let limitedData = false;
  if (cityCode) {
    costRows = await loadCostIndex(svc, cityCode);
    if (costRows.length === 0) {
      limitedData = true;
      const countryPrefix = cityCode.split('-')[0];
      const { data, error } = await svc.from('cost_index').select('*').like('city_code', `${countryPrefix}-%`);
      if (error) {
        console.error('[budget-forecast] country cost_index read failed:', error.code, error.message);
      }
      costRows = data ?? [];
    }
  }
  const idx = indexMap(costRows);
  const indexAvailable = costRows.length > 0;
  // DEFECT 2026-09-19 (fabricated data) — `costRows[0]?.currency ?? 'USD'`.
  // With costRows always empty (see header) this made every forecast dollars.
  // The trip's own base_currency, and the currency the reservations are
  // actually priced in, are the real evidence.
  const reservationCurrencies = Array.from(new Set(reservations.map((r)=>r.current_price_currency).filter(Boolean)));
  const currency = (indexAvailable ? costRows[0]?.currency : null) ?? (reservationCurrencies.length === 1 ? reservationCurrencies[0] : null) ?? (trip?.base_currency ? String(trip.base_currency).trim() : null) ?? null;
  const predictionUnavailableReason = !indexAvailable ? cityCode ? `No price data is held for ${cityCode}, so nothing beyond what you have already booked can be estimated.` : 'This trip has no city code recorded, so typical local prices cannot be looked up and nothing beyond what you have already booked can be estimated.' : null;
  // Trip dates. Previously these silently fell back to "today" and "today + 7
  // days", which produced a seven-day trip out of nothing.
  const startDate = trip?.start_date ? new Date(trip.start_date) : null;
  const endDate = trip?.end_date ? new Date(trip.end_date) : null;
  const totalDays = startDate && endDate ? Math.max(1, daysBetween(startDate, endDate)) : null;
  const categories = [];
  function bookedFor(pred) {
    let minor = 0, count = 0, priced = 0;
    for (const r of reservations){
      if (!pred(r)) continue;
      count++;
      const p = reservationPriceMinor(r);
      if (p !== null) {
        minor += p;
        priced++;
      }
    }
    return {
      minor,
      count,
      priced
    };
  }
  function pushCategory(category, booked, drivers) {
    const bookedMoney = money(booked.minor, currency);
    const extraDrivers = [
      ...drivers
    ];
    if (booked.count > booked.priced) {
      extraDrivers.push(`${booked.count - booked.priced} booked item(s) have no recorded price and are not included`);
    }
    categories.push({
      category,
      booked: bookedMoney,
      // With no cost index there is no basis for a prediction. Reporting zero
      // here is what produced the all-zero forecasts.
      predicted: null,
      total: null,
      drivers: extraDrivers,
      confidence: 'unavailable',
      predictionUnavailableReason: predictionUnavailableReason ?? undefined
    });
  }
  // Reservation types come from `reservation_type`, matching the values
  // parse-reservation writes (FLIGHT, HOTEL, RENTAL_CAR, TRAIN, BUS,
  // RESTAURANT, TOUR, ACTIVITY, EVENT, CRUISE, TRANSFER, OTHER).
  const lodging = bookedFor((r)=>[
      'HOTEL',
      'LODGING'
    ].includes(reservationType(r)));
  const lodgingDrivers = [];
  let bookedNights = 0;
  for (const r of reservations){
    if (![
      'HOTEL',
      'LODGING'
    ].includes(reservationType(r))) continue;
    if (r.start_date && r.end_date) bookedNights += daysBetween(new Date(r.start_date), new Date(r.end_date));
  }
  if (bookedNights > 0) lodgingDrivers.push(`${bookedNights} night${bookedNights > 1 ? 's' : ''} booked`);
  if (totalDays !== null && totalDays > bookedNights) {
    lodgingDrivers.push(`${totalDays - bookedNights} night${totalDays - bookedNights > 1 ? 's' : ''} not booked`);
  }
  pushCategory('lodging', lodging, lodgingDrivers);
  const food = bookedFor((r)=>reservationType(r) === 'RESTAURANT');
  pushCategory('food', food, food.count > 0 ? [
    `${food.count} restaurant booking(s)`
  ] : [
    'No restaurant bookings'
  ]);
  pushCategory('transport_local', {
    minor: 0,
    count: 0,
    priced: 0
  }, [
    'Local transport is not booked through TravelOS'
  ]);
  const activities = bookedFor((r)=>[
      'ACTIVITY',
      'TOUR',
      'EVENT'
    ].includes(reservationType(r)));
  const plannedActivities = itineraryItems.filter((i)=>[
      'activity',
      'museum',
      'tour'
    ].includes(String(i.type ?? '').toLowerCase()));
  const activityDrivers = [];
  if (activities.count > 0) activityDrivers.push(`${activities.count} booked activity/tour`);
  if (plannedActivities.length > 0) activityDrivers.push(`${plannedActivities.length} planned activities with no booking`);
  pushCategory('activities', activities, activityDrivers);
  const intercity = bookedFor((r)=>[
      'FLIGHT',
      'TRAIN',
      'BUS',
      'CRUISE',
      'TRANSFER',
      'RENTAL_CAR'
    ].includes(reservationType(r)));
  pushCategory('transport_intercity', intercity, intercity.count > 0 ? [
    `${intercity.count} booked intercity segment(s)`
  ] : [
    'No intercity transport booked'
  ]);
  // The 5% fees buffer was computed from category totals that were all zero,
  // so it was itself always zero. With no prediction basis there is nothing to
  // take a percentage of; the category is reported with its booked value only.
  pushCategory('fees_misc', {
    minor: 0,
    count: 0,
    priced: 0
  }, [
    'Fees, tips and miscellaneous are not estimated without local price data'
  ]);
  const bookedTotal = categories.reduce((s, c)=>s + c.booked.amountMinor, 0);
  // vs band. The old code read `bandData?.band?.minMinor` / `maxMinor`; the
  // /band endpoint returns the band object at the top level and expresses it
  // as comfortPerDay {low, high}, so bandMax was always 0 and vsBand was
  // permanently 'unknown'. It stays 'unknown' here too — but now because
  // there is genuinely no projected total to compare, not because of a
  // mis-read field.
  const vsBand = 'unknown';
  const forecast = {
    scope: {
      memberId: scope === 'me' ? userId : undefined,
      perPerson: scope === 'me'
    },
    currency,
    categories,
    booked: money(bookedTotal, currency),
    total: null,
    perDay: null,
    vsBand,
    predictionAvailable: false,
    predictionUnavailableReason,
    generatedAt: new Date().toISOString(),
    ...limitedData ? {
      note: 'Limited price data for this city — country-level rows were used'
    } : {}
  };
  return forecast;
}
// ─── Route handlers ───────────────────────────────────────────────────
async function handleForecast(req, url) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;
  const tripId = url.searchParams.get('tripId');
  const scope = url.searchParams.get('scope') ?? 'me';
  const cityCode = url.searchParams.get('cityCode');
  if (!tripId) return err('BAD_REQUEST', 'tripId is required', 400);
  const svc = serviceClient();
  const owns = await requireTripOwner(svc, tripId, auth.userId);
  if (owns instanceof Response) return owns;
  console.log('[budget-forecast] GET /forecast', {
    tripId,
    scope,
    userId: auth.userId
  });
  const cached = await loadCachedForecast(svc, tripId, scope, scope === 'me' ? auth.userId : undefined);
  if (cached) {
    console.log('[budget-forecast] returning cached forecast');
    return json(cached);
  }
  const forecast = await computeForecast(svc, tripId, scope, auth.userId, cityCode);
  await saveForecast(svc, tripId, scope, scope === 'me' ? auth.userId : undefined, forecast);
  return json(forecast);
}
async function handleBurn(req, url) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;
  const tripId = url.searchParams.get('tripId');
  if (!tripId) return err('BAD_REQUEST', 'tripId is required', 400);
  const svc = serviceClient();
  const owns = await requireTripOwner(svc, tripId, auth.userId);
  if (owns instanceof Response) return owns;
  console.log('[budget-forecast] GET /burn', {
    tripId,
    userId: auth.userId
  });
  const trip = await loadTrip(svc, tripId);
  const expenses = await loadExpenses(svc, tripId, auth.userId);
  const startDate = trip?.start_date ? new Date(trip.start_date) : null;
  const endDate = trip?.end_date ? new Date(trip.end_date) : null;
  const today = new Date();
  const expenseCurrencies = Array.from(new Set(expenses.map((e)=>e.currency).filter(Boolean)));
  const currency = expenseCurrencies.length === 1 ? expenseCurrencies[0] : trip?.base_currency ? String(trip.base_currency).trim() : null;
  // Spent to date — now over the caller's real expense rows (see loadExpenses).
  const spentToDate = expenses.filter((e)=>e.paid_at && new Date(e.paid_at) <= today).reduce((s, e)=>s + Math.round(Number(e.amount) * 100), 0);
  // DEFECT 2026-09-19 — everything below used to be derived from
  // forecast.total.p50, which was always zero (see header). plannedToDate,
  // variancePct, projectedTotal and safeToSpendToday were therefore all zero
  // or NaN-adjacent, and `status` came out 'on_track' for every trip in every
  // state — including a traveller who had blown their budget. Without a
  // projected total there is no plan to compare against, so those figures are
  // reported as unavailable rather than as zeroes.
  const forecast = await loadCachedForecast(svc, tripId, 'me', auth.userId);
  const projectedTotalMinor = forecast?.predictionAvailable ? forecast.total?.p50.amountMinor ?? null : null;
  if (!startDate || !endDate) {
    return json({
      spentToDate: money(spentToDate, currency),
      expenseCount: expenses.length,
      mixedCurrencies: expenseCurrencies.length > 1,
      plannedToDate: null,
      variancePct: null,
      projectedTotal: null,
      safeToSpendToday: null,
      status: 'unknown',
      reason: 'This trip has no start and end date recorded, so spending cannot be paced against it.'
    });
  }
  const totalDays = Math.max(1, daysBetween(startDate, endDate));
  const daysElapsed = Math.max(1, Math.min(totalDays, daysBetween(startDate, today)));
  const daysRemaining = Math.max(0, totalDays - daysElapsed);
  if (projectedTotalMinor === null) {
    return json({
      spentToDate: money(spentToDate, currency),
      expenseCount: expenses.length,
      mixedCurrencies: expenseCurrencies.length > 1,
      daysElapsed,
      daysRemaining,
      plannedToDate: null,
      variancePct: null,
      projectedTotal: null,
      safeToSpendToday: null,
      status: 'unknown',
      reason: forecast?.predictionUnavailableReason ?? 'No budget forecast is available for this trip, so there is nothing to pace spending against.'
    });
  }
  const plannedToDate = Math.round(projectedTotalMinor * (daysElapsed / totalDays));
  const variancePct = plannedToDate > 0 ? (spentToDate - plannedToDate) / plannedToDate : 0;
  const observedRatio = plannedToDate > 0 ? Math.min(1.5, Math.max(0.7, spentToDate / plannedToDate)) : 1.0;
  const remainingForecast = projectedTotalMinor - plannedToDate;
  const projectedP50 = Math.round(spentToDate + remainingForecast * observedRatio);
  const projectedP80 = Math.round(projectedP50 * 1.2);
  const mandatoryRemaining = Math.round(projectedTotalMinor * (daysRemaining / totalDays) * 0.4);
  const safeToSpendToday = Math.max(0, Math.round((projectedTotalMinor - spentToDate - mandatoryRemaining) / Math.max(1, daysRemaining)));
  let status = 'on_track';
  if (variancePct > 0.25 || projectedP50 > projectedTotalMinor * 1.25) status = 'over';
  else if (variancePct > 0.10) status = 'watch';
  return json({
    spentToDate: money(spentToDate, currency),
    expenseCount: expenses.length,
    mixedCurrencies: expenseCurrencies.length > 1,
    daysElapsed,
    daysRemaining,
    plannedToDate: money(plannedToDate, currency),
    variancePct: Math.round(variancePct * 1000) / 1000,
    projectedTotal: {
      p50: money(projectedP50, currency),
      p80: money(projectedP80, currency)
    },
    safeToSpendToday: money(safeToSpendToday, currency),
    status
  });
}
async function handleCoach(req, url) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;
  const tripId = url.searchParams.get('tripId');
  if (!tripId) return err('BAD_REQUEST', 'tripId is required', 400);
  const svc = serviceClient();
  const owns = await requireTripOwner(svc, tripId, auth.userId);
  if (owns instanceof Response) return owns;
  console.log('[budget-forecast] GET /coach', {
    tripId,
    userId: auth.userId
  });
  const trip = await loadTrip(svc, tripId);
  // NOTE 2026-09-19: `trips` has no country_code or city_code column either,
  // so these were always '' and the bargain_norms / phrase_cards / cost_index
  // lookups below matched nothing. They can be supplied as query params until
  // the trip schema carries them; without one, the country-specific tips are
  // simply absent rather than replaced with generic invented figures.
  const countryCode = (url.searchParams.get('country') ?? trip?.country_code ?? '').trim();
  const cityCode = resolveCityCode(trip, url.searchParams.get('cityCode'));
  const preferredTier = 'mid';
  const bargainRows = countryCode ? await svc.from('bargain_norms').select('*').eq('country_code', countryCode).then((r)=>{
    if (r.error) console.error('[budget-forecast] bargain_norms read failed:', r.error.code, r.error.message);
    return r.data ?? [];
  }) : [];
  const phraseRows = countryCode ? await svc.from('phrase_cards').select('*').eq('country_code', countryCode).then((r)=>{
    if (r.error) console.error('[budget-forecast] phrase_cards read failed:', r.error.code, r.error.message);
    return r.data ?? [];
  }) : [];
  const costRows = cityCode ? await loadCostIndex(svc, cityCode) : [];
  const members = await loadTripMembers(svc, tripId);
  const idx = indexMap(costRows);
  const currency = costRows[0]?.currency ?? null;
  const tips = [];
  const getIdx = (item)=>idx.get(`${item}:${preferredTier}`) ?? idx.get(`${item}:mid`);
  // DEFECT 2026-09-19 (fabricated data) — every savings figure in this handler
  // was of the form
  //   (getIndex(idx, 'guided_tour_half_day', tier)?.p50_minor ?? 5000) * n * 0.15
  // With the cost index never loaded (see header), the `??` fallback ALWAYS
  // fired, so "you could save 45.00" was 5000 minor units invented in this
  // file, multiplied out, and shown to the traveller as an estimate derived
  // from local prices. A saving we cannot compute is now simply omitted, and
  // the tip still carries its advice.
  if (members.length >= 6) {
    const groupPhrase = phraseRows.find((p)=>p.context === 'tour_operator');
    const restaurantPhrase = phraseRows.find((p)=>p.context === 'restaurant');
    const tourIdx = getIdx('guided_tour_half_day');
    tips.push({
      id: 'group-rate-tours',
      type: 'group_rate',
      title: 'Ask for group rates on tours',
      description: `With ${members.length} people, you qualify for group discounts at most tour operators and many restaurants. Always ask before booking.`,
      ...tourIdx ? {
        estimatedSavingsMinor: Math.round(tourIdx.p50_minor * members.length * 0.15),
        currency
      } : {},
      basis: tourIdx ? 'Group discounts of 10-20% are standard for 6+ people; figure from the local cost index' : 'Group discounts of 10-20% are standard for 6+ people. No local price data is held for this trip, so no figure is given.',
      ...groupPhrase ? {
        messageTemplate: `EN: "${groupPhrase.phrase_en.replace('[N]', String(members.length))}" | Local: "${groupPhrase.phrase_local.replace('[N]', String(members.length))}"`
      } : {}
    });
    if (restaurantPhrase) {
      const dinnerIdx = getIdx('dinner');
      tips.push({
        id: 'group-rate-restaurants',
        type: 'group_rate',
        title: 'Request group menu at restaurants',
        description: 'Large groups often get a set menu or prix-fixe option that saves 15-25% vs ordering a la carte.',
        ...dinnerIdx ? {
          estimatedSavingsMinor: Math.round(dinnerIdx.p50_minor * members.length * 0.20),
          currency
        } : {},
        basis: dinnerIdx ? 'Set menus for groups are common; figure from the local cost index' : 'Set menus for groups are common. No local price data is held for this trip, so no figure is given.',
        messageTemplate: `EN: "${restaurantPhrase.phrase_en}" | Local: "${restaurantPhrase.phrase_local}"`
      });
    }
  }
  for (const norm of bargainRows){
    const isNotDone = norm.norm === 'not_done';
    tips.push({
      id: `bargain-${norm.id}`,
      type: 'bargain_norm',
      title: isNotDone ? `Avoid bargaining at ${String(norm.context).replace(/_/g, ' ')}` : `Bargaining at ${String(norm.context).replace(/_/g, ' ')}: ${norm.norm}`,
      description: norm.tip,
      basis: norm.source,
      norm: norm.norm,
      officialSource: norm.source
    });
  }
  const lunchIdx = getIdx('lunch');
  const dinnerIdx = getIdx('dinner');
  if (lunchIdx && dinnerIdx && dinnerIdx.p50_minor > lunchIdx.p50_minor) {
    tips.push({
      id: 'timing-lunch-vs-dinner',
      type: 'timing',
      title: 'Eat your main meal at lunch',
      description: `Lunch averages ${(lunchIdx.p50_minor / 100).toFixed(2)} ${currency} vs ${(dinnerIdx.p50_minor / 100).toFixed(2)} ${currency} for dinner — same food, lower price.`,
      estimatedSavingsMinor: dinnerIdx.p50_minor - lunchIdx.p50_minor,
      currency,
      basis: 'Cost index p50 comparison: lunch vs dinner'
    });
  }
  const museumIdx = getIdx('museum_entry');
  if (museumIdx && museumIdx.p25_minor === 0) {
    tips.push({
      id: 'timing-free-museum',
      type: 'timing',
      title: 'Free museum entry available',
      description: 'Some museums in this city offer free entry on certain days or times. Check official museum websites before booking.',
      estimatedSavingsMinor: museumIdx.p50_minor,
      currency,
      basis: 'Cost index shows p25 = 0 (free entry exists)'
    });
  }
  const expensiveItems = [];
  for (const [key, row] of idx.entries()){
    if (key.endsWith(`:${preferredTier}`)) {
      expensiveItems.push({
        item: row.item,
        p50: row.p50_minor,
        p25: row.p25_minor,
        p75: row.p75_minor
      });
    }
  }
  expensiveItems.sort((a, b)=>b.p50 - a.p50);
  for (const item of expensiveItems.slice(0, 3)){
    tips.push({
      id: `benchmark-${item.item}`,
      type: 'benchmark',
      title: `${item.item.replace(/_/g, ' ')} price range`,
      description: `Typical range: ${(item.p25 / 100).toFixed(2)}–${(item.p75 / 100).toFixed(2)} ${currency}. Median: ${(item.p50 / 100).toFixed(2)} ${currency}.`,
      estimatedSavingsMinor: item.p75 - item.p25,
      currency,
      basis: 'Cost index p25–p75 range'
    });
  }
  // This one is advice, not an estimate derived from this trip. It previously
  // attached a savings figure built from `?? 10000` — ten thousand minor units
  // invented here. The advice stands on its own without a number.
  tips.push({
    id: 'fee-saving-dcc',
    type: 'fee_saving',
    title: 'Always pay in local currency',
    description: 'When paying by card abroad, always choose to pay in the local currency. Dynamic Currency Conversion (DCC) adds 3-7% markup. Your home bank rate is almost always better.',
    basis: 'DCC markup is typically 3-7% above interbank rate'
  });
  tips.sort((a, b)=>(b.estimatedSavingsMinor ?? 0) - (a.estimatedSavingsMinor ?? 0));
  return json({
    tips,
    phrases: phraseRows,
    countryCode: countryCode || null,
    cityCode,
    localPriceDataAvailable: costRows.length > 0
  });
}
async function handleCostIndex(_req, cityCode) {
  console.log('[budget-forecast] GET /cost-index', {
    cityCode
  });
  const svc = serviceClient();
  const rows = await loadCostIndex(svc, cityCode);
  const annotated = rows.map((r)=>({
      ...r,
      stale: isStale(r.observed_on)
    }));
  return json({
    cityCode,
    rows: annotated
  });
}
async function handlePhrases(_req, url) {
  const country = url.searchParams.get('country');
  const context = url.searchParams.get('context');
  if (!country) return err('BAD_REQUEST', 'country is required', 400);
  console.log('[budget-forecast] GET /phrases', {
    country,
    context
  });
  const svc = serviceClient();
  let query = svc.from('phrase_cards').select('*').eq('country_code', country);
  if (context) query = query.eq('context', context);
  const { data, error } = await query;
  if (error) {
    console.error('[budget-forecast] phrase_cards read failed:', error.code, error.message);
    return err('INTERNAL_ERROR', 'Failed to load phrases', 500);
  }
  return json({
    phrases: data ?? [],
    country,
    context
  });
}
async function handleCalibrate(req) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;
  console.log('[budget-forecast] POST /calibrate', {
    userId: auth.userId
  });
  const svc = serviceClient();
  // DEFECT 2026-09-19 — this was `.eq('user_id', auth.userId)` on `expenses`,
  // a column that does not exist (the payer column is `paid_by`). PostgREST
  // rejected the request with 42703, the error was discarded, and `?? []`
  // meant this endpoint has always returned `{ calibration: [] }` — so
  // personal_calibration has never held a single row, and computeForecast's
  // `calibration.get(cat) ?? 1.0` was always 1.0.
  const { data: allExpenses, error: expensesErr } = await svc.from('expenses').select('*').eq('paid_by', auth.userId).is('deleted_at', null);
  if (expensesErr) {
    console.error('[budget-forecast] calibrate expenses read failed:', expensesErr.code, expensesErr.message);
    return err('INTERNAL_ERROR', 'Failed to load your expenses', 500);
  }
  const expenses = allExpenses ?? [];
  // Group by trip and category
  const tripCategories = new Map();
  for (const e of expenses){
    if (!e.trip_id) continue;
    if (!tripCategories.has(e.trip_id)) tripCategories.set(e.trip_id, new Map());
    const catMap = tripCategories.get(e.trip_id);
    catMap.set(e.category, (catMap.get(e.category) ?? 0) + Math.round(Number(e.amount) * 100));
  }
  const categoryRatios = new Map();
  let tripsSkippedNoCityCode = 0;
  for (const [tripId, catMap] of tripCategories.entries()){
    const trip = await loadTrip(svc, tripId);
    if (!trip) continue;
    const cityCode = resolveCityCode(trip, null);
    if (!cityCode) {
      // Without a city code there is no index to calibrate against. Previously
      // this produced indexP50 = 0 for every category, which the `> 0` guard
      // below then skipped — silently, so the endpoint looked like it had run.
      tripsSkippedNoCityCode++;
      continue;
    }
    const costRows = await loadCostIndex(svc, cityCode);
    const idx = indexMap(costRows);
    const tier = 'mid';
    const getIdx = (item)=>idx.get(`${item}:${tier}`) ?? idx.get(`${item}:mid`);
    const startDate = trip.start_date ? new Date(trip.start_date) : null;
    const endDate = trip.end_date ? new Date(trip.end_date) : null;
    if (!startDate || !endDate) continue;
    const days = Math.max(1, daysBetween(startDate, endDate));
    for (const [cat, spent] of catMap.entries()){
      let indexP50 = 0;
      if (cat === 'food') {
        indexP50 = ((getIdx('breakfast')?.p50_minor ?? 0) + (getIdx('lunch')?.p50_minor ?? 0) + (getIdx('dinner')?.p50_minor ?? 0)) * days;
      } else if (cat === 'accommodation' || cat === 'lodging') {
        indexP50 = (getIdx('lodging_night')?.p50_minor ?? 0) * days;
      } else if (cat === 'transport') {
        indexP50 = (getIdx('local_transit_ride')?.p50_minor ?? 0) * 3 * days;
      } else if (cat === 'activity' || cat === 'activities') {
        indexP50 = (getIdx('museum_entry')?.p50_minor ?? 0) * days;
      }
      if (indexP50 > 0) {
        if (!categoryRatios.has(cat)) categoryRatios.set(cat, []);
        categoryRatios.get(cat).push(spent / indexP50);
      }
    }
  }
  const results = [];
  const upserts = [];
  for (const [cat, ratios] of categoryRatios.entries()){
    if (ratios.length < 2) continue;
    ratios.sort((a, b)=>a - b);
    const mid = Math.floor(ratios.length / 2);
    const median = ratios.length % 2 === 0 ? (ratios[mid - 1] + ratios[mid]) / 2 : ratios[mid];
    const clamped = Math.min(2.5, Math.max(0.4, median));
    const pct = Math.round(Math.abs(clamped - 1) * 100);
    let explanation;
    if (clamped > 1.3) explanation = `You usually spend about ${pct}% more than typical on ${cat}`;
    else if (clamped < 0.7) explanation = `You usually spend about ${pct}% less than typical on ${cat}`;
    else explanation = `Your ${cat} spending is close to typical`;
    results.push({
      category: cat,
      ratio: clamped,
      tripCount: ratios.length,
      explanation
    });
    upserts.push({
      user_id: auth.userId,
      category: cat,
      ratio: clamped,
      trip_count: ratios.length,
      computed_at: new Date().toISOString()
    });
  }
  let saved = true;
  if (upserts.length > 0) {
    // Previously the error was discarded, so a failed save returned the
    // calibration as though it had been stored.
    const { error: upsertErr } = await svc.from('personal_calibration').upsert(upserts, {
      onConflict: 'user_id,category'
    });
    if (upsertErr) {
      console.error('[budget-forecast] personal_calibration upsert failed:', upsertErr.code, upsertErr.message);
      saved = false;
    }
  }
  return json({
    calibration: results,
    saved,
    userId: auth.userId,
    expensesConsidered: expenses.length,
    tripsSkippedNoCityCode,
    ...results.length === 0 ? {
      note: 'No calibration could be computed. A category needs at least two past trips with a city code and recorded dates to compare against local price data.'
    } : {}
  });
}
// ─── Router ───────────────────────────────────────────────────────
Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: CORS
    });
  }
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/budget-forecast/, '').replace(/^\/functions\/v1\/budget-forecast/, '');
  console.log('[budget-forecast] incoming', req.method, path);
  try {
    if (req.method === 'GET' && path === '/forecast') return await handleForecast(req, url);
    if (req.method === 'GET' && path === '/burn') return await handleBurn(req, url);
    if (req.method === 'GET' && path === '/coach') return await handleCoach(req, url);
    if (req.method === 'GET' && path.startsWith('/cost-index/')) {
      const cityCode = decodeURIComponent(path.replace('/cost-index/', ''));
      return await handleCostIndex(req, cityCode);
    }
    if (req.method === 'GET' && path === '/phrases') return await handlePhrases(req, url);
    if (req.method === 'POST' && path === '/calibrate') return await handleCalibrate(req);
    return err('NOT_FOUND', `Route not found: ${req.method} ${path}`, 404);
  } catch (e) {
    console.error('[budget-forecast] unhandled error', e);
    return err('INTERNAL_ERROR', e?.message ?? 'Internal server error', 500);
  }
});

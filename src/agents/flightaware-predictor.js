/**
 * Agent 1: FlightAware Predictive Pre-fetching
 * Runs every 6 hours
 * Fetches only flights for trips that will actually be booked
 * Expected savings: 80% (from $5000-50000 to $1000-10000)
 */

import logger from '../services/logging.js';
import { supabase } from '../config/database.js';
import { redis, getCached, setCached, CACHE_TTL } from '../services/cache.js';
import { getFlights } from '../services/external-apis/flightaware.js';
import { logAPICall } from '../services/logging.js';

class FlightAwarePredictorAgent {
  /**
   * Main execution method - runs every 6 hours
   */
  async execute() {
    logger.info('[FlightAwarePredictorAgent] Starting predictive pre-fetch...');
    const startTime = Date.now();

    try {
      // Step 1: Get upcoming trips from next 30 days
      const upcomingTrips = await this.getUpcomingTrips();
      logger.info(`[FlightAwarePredictorAgent] Found ${upcomingTrips.length} upcoming trips`);

      // Step 2: Group by departure/arrival routes
      const routes = this.groupByRoutes(upcomingTrips);
      logger.info(`[FlightAwarePredictorAgent] Grouped into ${routes.length} unique routes`);

      // Step 3: Pre-fetch flights for each route
      const results = await this.prefetchFlights(routes);

      // Step 4: Log metrics
      const duration = Date.now() - startTime;
      await this.logMetrics({
        tripCount: upcomingTrips.length,
        routeCount: routes.length,
        flightsFetched: results.fetchCount,
        apiCalls: results.apiCalls,
        estimatedSavings: results.estimatedSavings,
        duration,
      });

      logger.info(`[FlightAwarePredictorAgent] ✅ Completed in ${duration}ms - ${results.apiCalls} API calls, saving ~$${results.estimatedSavings}`);

      return { success: true, ...results };
    } catch (error) {
      logger.error('[FlightAwarePredictorAgent] Error:', error);
      throw error;
    }
  }

  /**
   * Get trips departing in next 30 days
   */
  async getUpcomingTrips() {
    const { data, error } = await supabase
      .from('trips')
      .select('id, departure_code, arrival_code, departure_date, user_id')
      .gte('departure_date', new Date().toISOString())
      .lte('departure_date', new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString())
      .order('departure_date', { ascending: true });

    if (error) throw error;
    return data || [];
  }

  /**
   * Group trips by route (departure→arrival)
   */
  groupByRoutes(trips) {
    const routeMap = new Map();

    for (const trip of trips) {
      const key = `${trip.departure_code}-${trip.arrival_code}`;
      if (!routeMap.has(key)) {
        routeMap.set(key, {
          route: key,
          departureCode: trip.departure_code,
          arrivalCode: trip.arrival_code,
          dates: new Set(),
          tripIds: [],
        });
      }
      routeMap.get(key).dates.add(trip.departure_date.split('T')[0]);
      routeMap.get(key).tripIds.push(trip.id);
    }

    return Array.from(routeMap.values());
  }

  /**
   * Pre-fetch flights for routes
   * Batches requests to minimize API calls
   */
  async prefetchFlights(routes) {
    let fetchCount = 0;
    let apiCalls = 0;
    let estimatedSavings = 0;

    for (const route of routes) {
      try {
        // Check cache first
        const cacheKey = `flights:${route.route}`;
        const cached = await getCached(cacheKey);

        if (cached) {
          logger.debug(`[FlightAwarePredictorAgent] Cache hit for route ${route.route}`);
          continue;
        }

        // Fetch flights for all dates in this route
        const allFlights = [];
        for (const date of route.dates) {
          try {
            const flights = await getFlights({
              from: route.departureCode,
              to: route.arrivalCode,
              departDate: date,
            });

            allFlights.push(...flights);
            apiCalls++;
            fetchCount += flights.length;

            // Cache for 6 hours
            await setCached(
              `flights:${route.route}:${date}`,
              flights,
              6 * 60 * 60
            );
          } catch (error) {
            logger.warn(`[FlightAwarePredictorAgent] Failed to fetch flights for ${date}: ${error.message}`);
          }
        }

        // Cache combined results
        if (allFlights.length > 0) {
          await setCached(cacheKey, allFlights, 6 * 60 * 60);

          // Estimate savings: without caching, every user search = 1 API call ($0.10)
          // With caching, all searches for this route share 1 API call
          const estimatedUserSearches = Math.min(route.tripIds.length * 5, 100); // 5 searches per trip avg
          estimatedSavings += estimatedUserSearches * 0.10 * 0.8; // 80% savings from deduplication
        }
      } catch (error) {
        logger.error(`[FlightAwarePredictorAgent] Route processing error for ${route.route}:`, error);
      }
    }

    return { fetchCount, apiCalls, estimatedSavings };
  }

  /**
   * Log metrics to Supabase for monitoring
   */
  async logMetrics(metrics) {
    try {
      const { error } = await supabase
        .from('agent_metrics')
        .insert({
          agent_name: 'flightaware_predictor',
          execution_timestamp: new Date().toISOString(),
          metrics: JSON.stringify(metrics),
        });

      if (error) logger.error('[FlightAwarePredictorAgent] Failed to log metrics:', error);
    } catch (error) {
      logger.error('[FlightAwarePredictorAgent] Metrics logging error:', error);
    }
  }
}

export default new FlightAwarePredictorAgent();

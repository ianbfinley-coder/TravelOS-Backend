/**
 * Agent 2: Google Places Cache Refresh Agent
 * Runs every 12 hours
 * Pre-fetches top 1000 searched locations to reduce real-time API calls
 * Expected savings: $30-200/month
 */

import logger from '../services/logging.js';
import { supabase } from '../config/database.js';
import { redis, getCached, setCached } from '../services/cache.js';
import { searchPlaces, getPlaceDetails } from '../services/external-apis/google-places.js';

class PlacesCacheRefreshAgent {
  /**
   * Main execution method - runs every 12 hours
   */
  async execute() {
    logger.info('[PlacesCacheRefreshAgent] Starting cache refresh...');
    const startTime = Date.now();

    try {
      // Step 1: Get top searched locations
      const topLocations = await this.getTopSearchedLocations();
      logger.info(`[PlacesCacheRefreshAgent] Found ${topLocations.length} top locations`);

      // Step 2: Batch fetch place details
      const results = await this.batchFetchPlaces(topLocations);

      // Step 3: Log metrics
      const duration = Date.now() - startTime;
      await this.logMetrics({
        locationsScanned: topLocations.length,
        placesFetched: results.placesFetched,
        apiCalls: results.apiCalls,
        estimatedSavings: results.estimatedSavings,
        duration,
      });

      logger.info(`[PlacesCacheRefreshAgent] ✅ Completed in ${duration}ms - cached ${results.placesFetched} places with ${results.apiCalls} API calls`);

      return { success: true, ...results };
    } catch (error) {
      logger.error('[PlacesCacheRefreshAgent] Error:', error);
      throw error;
    }
  }

  /**
   * Get top searched locations from analytics
   */
  async getTopSearchedLocations() {
    const { data, error } = await supabase
      .from('search_analytics')
      .select('search_query, search_count')
      .eq('search_type', 'places')
      .order('search_count', { ascending: false })
      .limit(1000);

    if (error) {
      logger.warn('[PlacesCacheRefreshAgent] Could not fetch search analytics:', error);
      // Return empty array if table doesn't exist yet
      return [];
    }

    return data || [];
  }

  /**
   * Batch fetch place details for top locations
   */
  async batchFetchPlaces(locations) {
    let placesFetched = 0;
    let apiCalls = 0;
    let estimatedSavings = 0;

    // Process in batches of 5
    for (let i = 0; i < locations.length; i += 5) {
      const batch = locations.slice(i, i + 5);

      try {
        for (const location of batch) {
          // Check cache
          const cacheKey = `places:${location.search_query}`;
          const cached = await getCached(cacheKey);

          if (cached) {
            logger.debug(`[PlacesCacheRefreshAgent] Cache hit for ${location.search_query}`);
            continue;
          }

          // Search for place
          const searchResults = await searchPlaces(location.search_query);
          apiCalls++;

          // Get details for top 5 results
          if (searchResults.length > 0) {
            const detailedPlaces = [];

            for (const place of searchResults.slice(0, 5)) {
              try {
                const details = await getPlaceDetails(place.place_id);
                detailedPlaces.push(details);
                placesFetched++;
              } catch (error) {
                logger.warn(`[PlacesCacheRefreshAgent] Failed to get details for place ${place.place_id}`);
              }
            }

            // Cache for 24 hours
            await setCached(
              cacheKey,
              detailedPlaces,
              24 * 60 * 60
            );

            // Estimate savings: typically 70% of searches hit cache
            estimatedSavings += (location.search_count * 0.70) * 0.07; // ~$0.07 per API call
          }
        }
      } catch (error) {
        logger.error('[PlacesCacheRefreshAgent] Batch processing error:', error);
      }
    }

    return { placesFetched, apiCalls, estimatedSavings };
  }

  /**
   * Log metrics to Supabase
   */
  async logMetrics(metrics) {
    try {
      const { error } = await supabase
        .from('agent_metrics')
        .insert({
          agent_name: 'places_cache_refresh',
          execution_timestamp: new Date().toISOString(),
          metrics: JSON.stringify(metrics),
        });

      if (error) logger.error('[PlacesCacheRefreshAgent] Failed to log metrics:', error);
    } catch (error) {
      logger.error('[PlacesCacheRefreshAgent] Metrics logging error:', error);
    }
  }
}

export default new PlacesCacheRefreshAgent();

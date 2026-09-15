/**
 * Request Deduplication Middleware
 * Integrates request deduplication agent into Express request pipeline
 * Intercepts flight search requests and applies caching/batching
 */

import logger from '../services/logging.js';
import requestDeduplicationAgent from '../agents/request-deduplication.js';

/**
 * Middleware factory for flight search deduplication
 */
export function createDeduplicationMiddleware() {
  return async (req, res, next) => {
    // Only apply to flight search endpoints
    if (!req.path.includes('/api/flights') && !req.path.includes('/api/search/flights')) {
      return next();
    }

    // Extract query parameters
    const flightQuery = {
      from: req.query.from || req.body.from,
      to: req.query.to || req.body.to,
      departDate: req.query.departDate || req.body.departDate,
      returnDate: req.query.returnDate || req.body.returnDate,
      passengers: req.query.passengers || req.body.passengers || 1,
    };

    // Validate required fields
    if (!flightQuery.from || !flightQuery.to || !flightQuery.departDate) {
      return next();
    }

    // Check cost-saving mode and adjust dedup window
    await requestDeduplicationAgent.checkCostSavingMode();

    // Wrap the next middleware to intercept response
    const originalJson = res.json.bind(res);

    res.json = function (data) {
      // Log deduplication metrics if available
      if (res.locals.dedupMetrics) {
        logger.debug('[Deduplication] Response metrics:', res.locals.dedupMetrics);
      }

      return originalJson(data);
    };

    // Store flight query for potential deduplication
    res.locals.flightQuery = flightQuery;
    res.locals.dedupMetrics = {};

    next();
  };
}

/**
 * Middleware for handling flight search with deduplication
 */
export async function handleFlightSearchWithDedup(req, res) {
  const flightQuery = res.locals.flightQuery || {
    from: req.query.from || req.body.from,
    to: req.query.to || req.body.to,
    departDate: req.query.departDate || req.body.departDate,
    returnDate: req.query.returnDate || req.body.returnDate,
    passengers: req.query.passengers || req.body.passengers || 1,
  };

  try {
    // Attempt to use cached result or execute with batching
    const result = await requestDeduplicationAgent.queueOrExecute(
      flightQuery,
      async (query) => {
        // This is the actual API execution function
        // Import your actual flight search function here
        const { getFlights } = await import('../services/external-apis/flightaware.js');
        return await getFlights(query);
      }
    );

    // Add dedup metrics to response
    res.locals.dedupMetrics = {
      source: result.source, // 'cache' or 'api'
      deduped: result.deduped || false,
      batchSize: result.batchSize || 1,
      cacheHit: result.source === 'cache',
    };

    return result.data;
  } catch (error) {
    logger.error('[Deduplication] Error in flight search:', error);
    throw error;
  }
}

/**
 * Middleware to expose deduplication stats endpoint
 */
export function createDeduplicationStatsMiddleware() {
  return async (req, res) => {
    try {
      const stats = await requestDeduplicationAgent.getStats();
      res.json({
        success: true,
        deduplication: stats,
      });
    } catch (error) {
      logger.error('[Deduplication Stats] Error:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  };
}

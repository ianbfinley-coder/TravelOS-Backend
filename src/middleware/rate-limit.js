/**
 * Rate Limiting Middleware
 * Implements tiered rate limiting with global and strict (expensive) limits
 * Also enforces monthly quotas per user tier
 */

// In-memory storage for request tracking
const requestCounts = new Map(); // { 'ip:endpoint': { count, resetTime } }
const monthlyQuotas = new Map(); // { 'userId': { count, resetTime } }

// Rate limit configurations
const LIMITS = {
  global: { requests: 100, window: 15 * 60 * 1000 }, // 100 req/15min
  strict: { requests: 10, window: 60 * 1000 } // 10 req/min for expensive endpoints
};

// Monthly quota configurations
const QUOTAS = {
  free: 50,
  pro: 1000,
  premium: 3000
};

// Expensive endpoints that require strict rate limiting
const EXPENSIVE_ENDPOINTS = ['/api/flights'];

/**
 * Determine if an endpoint is expensive
 */
const isExpensiveEndpoint = (path) => {
  return EXPENSIVE_ENDPOINTS.some(endpoint => path.includes(endpoint));
};

/**
 * Get tier multiplier for premium users
 */
const getTierMultiplier = (token) => {
  if (token && token.includes('premium')) {
    return 3; // 3x multiplier for premium
  }
  return 1;
};

/**
 * Get user tier from headers
 */
const getUserTier = (req) => {
  const tier = req.get('X-User-Tier');
  return tier || 'free';
};

/**
 * Reset rate limit state (for testing)
 */
export const resetLimits = () => {
  requestCounts.clear();
  monthlyQuotas.clear();
};

/**
 * Setup rate limiting middleware
 */
export const setupRateLimiting = (app) => {
  app.use((req, res, next) => {
    const token = req.get('Authorization');
    const userId = req.get('X-User-Id') || 'anonymous';
    const tier = getUserTier(req);
    const multiplier = getTierMultiplier(token);
    const now = Date.now();

    // Determine rate limit based on endpoint type
    const isExpensive = isExpensiveEndpoint(req.path);
    const limit = isExpensive ? LIMITS.strict : LIMITS.global;
    const maxRequests = limit.requests * multiplier;

    // Create rate limit key
    const ip = req.ip || 'unknown';
    const endpoint = isExpensive ? 'expensive' : 'global';
    const rateLimitKey = `${ip}:${endpoint}`;

    // Initialize rate limit data if needed
    if (!requestCounts.has(rateLimitKey)) {
      requestCounts.set(rateLimitKey, {
        count: 0,
        resetTime: now + limit.window
      });
    }

    const limitData = requestCounts.get(rateLimitKey);

    // Reset count if window expired
    if (now > limitData.resetTime) {
      limitData.count = 0;
      limitData.resetTime = now + limit.window;
    }

    // Check if rate limit exceeded FIRST (429)
    if (limitData.count >= maxRequests) {
      res.status(429).json({
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: `Rate limit exceeded: ${limitData.count}/${maxRequests}`,
          timestamp: new Date().toISOString()
        }
      });
      return;
    }

    // Check monthly quota SECOND (403)
    const quotaKey = userId;
    const quota = QUOTAS[tier] || QUOTAS.free;
    const quotaMultiplier = multiplier; // Premium gets 3x quota too
    const maxMonthlyRequests = quota * quotaMultiplier;

    if (!monthlyQuotas.has(quotaKey)) {
      monthlyQuotas.set(quotaKey, {
        count: 0,
        resetTime: now + (30 * 24 * 60 * 60 * 1000) // 30 days
      });
    }

    const monthlyData = monthlyQuotas.get(quotaKey);

    // Reset monthly count if window expired
    if (now > monthlyData.resetTime) {
      monthlyData.count = 0;
      monthlyData.resetTime = now + (30 * 24 * 60 * 60 * 1000);
    }

    // Check if monthly quota exceeded
    if (monthlyData.count >= maxMonthlyRequests) {
      res.status(403).json({
        error: {
          code: 'QUOTA_EXCEEDED',
          message: `Monthly quota exceeded: ${monthlyData.count}/${maxMonthlyRequests}`,
          timestamp: new Date().toISOString()
        }
      });
      return;
    }

    // Increment counts
    limitData.count++;
    monthlyData.count++;

    // Set rate limit headers
    const remainingWindow = Math.ceil((limitData.resetTime - now) / 1000);
    res.set('X-RateLimit-Limit', String(maxRequests));
    res.set('X-RateLimit-Remaining', String(maxRequests - limitData.count));
    res.set('X-RateLimit-Reset', String(Math.floor(limitData.resetTime / 1000)));

    next();
  });
};

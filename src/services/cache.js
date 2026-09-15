const cache = new Map();

/**
 * Cache configuration constants
 */
export const CACHE_TTL = 3600; // 1 hour in seconds

/**
 * Get a cached value
 */
export function getCached(key) {
  const cached = cache.get(key);
  if (cached && cached.expiry > Date.now()) {
    return cached.value;
  }
  if (cached) {
    cache.delete(key);
  }
  return null;
}

/**
 * Set a cached value with TTL (time-to-live in seconds)
 */
export function setCached(key, value, ttl = CACHE_TTL) {
  cache.set(key, {
    value,
    expiry: Date.now() + ttl * 1000
  });
}

/**
 * Clear all cached values
 */
export function clearCache() {
  cache.clear();
}

/**
 * Get cache size
 */
export function getCacheSize() {
  return cache.size;
}

/**
 * Mock Redis client for development
 * Provides a Redis-like interface using in-memory cache
 */
const mockRedis = {
  get: async (key) => getCached(key),
  set: async (key, value, options) => {
    const ttl = options?.EX || CACHE_TTL;
    setCached(key, value, ttl);
    return 'OK';
  },
  del: async (key) => {
    const exists = cache.has(key);
    if (exists) cache.delete(key);
    return exists ? 1 : 0;
  },
  exists: async (key) => {
    return cache.has(key) ? 1 : 0;
  },
  clear: async () => {
    clearCache();
    return 'OK';
  },
  getSize: async () => getCacheSize(),
  flushAll: async () => {
    clearCache();
    return 'OK';
  }
};

/**
 * Initialize Redis client
 * In development, returns a mock Redis client using in-memory cache
 */
export async function initializeRedis() {
  try {
    // Try to connect to real Redis if available
    if (process.env.REDIS_URL) {
      console.log('[Redis] Attempting to connect to Redis server...');
      // If you want to use real Redis, install 'redis' package and use:
      // import redis from 'redis';
      // const client = redis.createClient({ url: process.env.REDIS_URL });
      // await client.connect();
      // return client;
    }

    console.log('[Redis] Using in-memory cache for development');
    return mockRedis;
  } catch (error) {
    console.warn('[Redis] Failed to connect to Redis, falling back to in-memory cache:', error.message);
    return mockRedis;
  }
}

/**
 * Export the mock Redis client as the default redis instance
 */
export const redis = mockRedis;

export default mockRedis;

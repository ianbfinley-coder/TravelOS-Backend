/**
 * FlightAware Service
 * Wrapper for FlightAware API with caching and cost tracking
 */

import axios from 'axios';
import { getCached, setCached } from './cache.js';
import { logAPICall } from './logging.js';

const FLIGHTAWARE_API_BASE = 'https://api.flightaware.com/v2';
const FLIGHTAWARE_COST = 0.10; // Cost per request ($0.10)
const CACHE_TTL = 1800; // 30 minutes

// Mock result for testing
const MOCK_RESULT = {
  ident: 'UA123',
  status: 'Scheduled'
};

/**
 * Get flight status
 */
export const getFlightStatus = async (flightCode) => {
  // Create cache key
  const cacheKey = `flightaware:${flightCode}`;

  // Check cache first
  const cached = getCached(cacheKey);
  if (cached) {
    return cached;
  }

  try {
    const start = Date.now();

    // Make API call (will use mock in tests via jest.mock('axios'))
    const response = await axios.get(`${FLIGHTAWARE_API_BASE}/flights/${flightCode}`);

    const duration = Date.now() - start;

    // Log the API call with high cost
    logAPICall('flightaware', `/flights/${flightCode}`, 200, duration, FLIGHTAWARE_COST);

    // Cache the result
    setCached(cacheKey, response.data, CACHE_TTL);

    return response.data;
  } catch (error) {
    logAPICall('flightaware', `/flights/${flightCode}`, error.response?.status || 500, 0, FLIGHTAWARE_COST);
    throw error;
  }
};
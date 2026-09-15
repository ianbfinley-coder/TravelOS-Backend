/**
 * Google Places Service
 * Wrapper for Google Places API with caching and cost tracking
 */

import axios from 'axios';
import { getCached, setCached } from './cache.js';
import { logAPICall } from './logging.js';

const GOOGLE_PLACES_API_BASE = 'https://maps.googleapis.com/maps/api/place';
const GOOGLE_PLACES_COST = 0.032; // Cost per request
const CACHE_TTL = 86400; // 24 hours

// Mock result for testing
const MOCK_RESULT = {
  results: [
    {
      place_id: 'place_123',
      name: 'Sample Result',
      formatted_address: '123 Main St, New York, NY'
    }
  ]
};

/**
 * Search for places
 */
export const searchPlaces = async (params) => {
  const { query, lat, lng } = params;

  // Create cache key
  const cacheKey = `googlePlaces:${query}:${lat}:${lng}`;

  // Check cache first
  const cached = getCached(cacheKey);
  if (cached) {
    return cached;
  }

  try {
    const start = Date.now();

    // Make API call (will use mock in tests via jest.mock('axios'))
    const response = await axios.get(`${GOOGLE_PLACES_API_BASE}/textsearch`, {
      params: { query, location: `${lat},${lng}` }
    });

    const duration = Date.now() - start;

    // Log the API call
    logAPICall('googlePlaces', '/textsearch', 200, duration, GOOGLE_PLACES_COST);

    // Cache the result
    setCached(cacheKey, response.data, CACHE_TTL);

    return response.data;
  } catch (error) {
    logAPICall('googlePlaces', '/textsearch', error.response?.status || 500, 0, GOOGLE_PLACES_COST);
    throw error;
  }
};

// Google Places External API Service
import axios from 'axios';

const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;
const GOOGLE_PLACES_BASE_URL = 'https://maps.googleapis.com/maps/api/place';

export async function searchPlaces(query, location) {
  if (!GOOGLE_PLACES_API_KEY) {
    console.warn('⚠️  Google Places API key not configured');
    return { results: [], apiCalls: 0 };
  }

  try {
    const response = await axios.get(`${GOOGLE_PLACES_BASE_URL}/textsearch/json`, {
      params: {
        query: query,
        location: location,
        key: GOOGLE_PLACES_API_KEY,
      },
    });

    return {
      results: response.data.results || [],
      apiCalls: 1,
    };
  } catch (error) {
    console.error('Google Places API error:', error.message);
    return { results: [], apiCalls: 0, error: error.message };
  }
}

export async function getPlaceDetails(placeId) {
  if (!GOOGLE_PLACES_API_KEY) {
    return { details: null, apiCalls: 0 };
  }

  try {
    const response = await axios.get(`${GOOGLE_PLACES_BASE_URL}/details/json`, {
      params: {
        place_id: placeId,
        key: GOOGLE_PLACES_API_KEY,
      },
    });

    return {
      details: response.data.result,
      apiCalls: 1,
    };
  } catch (error) {
    console.error('Google Places details error:', error.message);
    return { details: null, apiCalls: 0, error: error.message };
  }
}

export default {
  searchPlaces,
  getPlaceDetails,
};

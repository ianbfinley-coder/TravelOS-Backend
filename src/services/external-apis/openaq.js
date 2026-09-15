// OpenAQ External API Service
import axios from 'axios';

const OPENAQ_API_KEY = process.env.OPENAQ_API_KEY;
const OPENAQ_BASE_URL = 'https://api.openaq.org/v2';

export async function getAirQuality(city, country) {
  if (!OPENAQ_API_KEY) {
    console.warn('⚠️  OpenAQ API key not configured');
    return { measurements: [], apiCalls: 0 };
  }

  try {
    const response = await axios.get(`${OPENAQ_BASE_URL}/measurements`, {
      params: {
        city: city,
        country: country,
        limit: 100,
      },
      headers: {
        'x-api-key': OPENAQ_API_KEY,
      },
    });

    return {
      measurements: response.data.results || [],
      apiCalls: 1,
    };
  } catch (error) {
    console.error('OpenAQ API error:', error.message);
    return { measurements: [], apiCalls: 0, error: error.message };
  }
}

export async function getLatestAirQuality(latitude, longitude) {
  if (!OPENAQ_API_KEY) {
    return { data: null, apiCalls: 0 };
  }

  try {
    const response = await axios.get(`${OPENAQ_BASE_URL}/measurements`, {
      params: {
        coordinates: `${latitude},${longitude}`,
        radius: 10000,
        limit: 1,
      },
      headers: {
        'x-api-key': OPENAQ_API_KEY,
      },
    });

    return {
      data: response.data.results?.[0],
      apiCalls: 1,
    };
  } catch (error) {
    console.error('OpenAQ latest error:', error.message);
    return { data: null, apiCalls: 0, error: error.message };
  }
}

export default {
  getAirQuality,
  getLatestAirQuality,
};

// Mapbox External API Service
import axios from 'axios';

const MAPBOX_API_KEY = process.env.MAPBOX_API_KEY;
const MAPBOX_BASE_URL = 'https://api.mapbox.com';

export async function geocodeAddress(address) {
  if (!MAPBOX_API_KEY) {
    console.warn('⚠️  Mapbox API key not configured');
    return { coordinates: null, apiCalls: 0 };
  }

  try {
    const response = await axios.get(`${MAPBOX_BASE_URL}/geocoding/v5/mapbox.places/${encodeURIComponent(address)}.json`, {
      params: {
        access_token: MAPBOX_API_KEY,
      },
    });

    const feature = response.data.features?.[0];
    return {
      coordinates: feature?.geometry.coordinates,
      place: feature?.place_name,
      apiCalls: 1,
    };
  } catch (error) {
    console.error('Mapbox geocoding error:', error.message);
    return { coordinates: null, apiCalls: 0, error: error.message };
  }
}

export async function getDirections(startCoords, endCoords) {
  if (!MAPBOX_API_KEY) {
    return { route: null, apiCalls: 0 };
  }

  try {
    const response = await axios.get(
      `${MAPBOX_BASE_URL}/directions/v5/mapbox/driving/${startCoords[0]},${startCoords[1]};${endCoords[0]},${endCoords[1]}`,
      {
        params: {
          access_token: MAPBOX_API_KEY,
          geometries: 'geojson',
        },
      }
    );

    return {
      route: response.data.routes?.[0],
      apiCalls: 1,
    };
  } catch (error) {
    console.error('Mapbox directions error:', error.message);
    return { route: null, apiCalls: 0, error: error.message };
  }
}

export default {
  geocodeAddress,
  getDirections,
};

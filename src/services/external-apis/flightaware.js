// FlightAware External API Service
import axios from 'axios';

const FLIGHTAWARE_API_KEY = process.env.FLIGHTAWARE_API_KEY;
const FLIGHTAWARE_BASE_URL = 'https://aeroapi.flightaware.com/aeroapi';

export async function getFlights(departureCode, arrivalCode, departureDate) {
  if (!FLIGHTAWARE_API_KEY) {
    console.warn('⚠️  FlightAware API key not configured');
    return { flights: [], apiCalls: 0 };
  }

  try {
    const response = await axios.get(`${FLIGHTAWARE_BASE_URL}/flights/search`, {
      params: {
        origin: departureCode,
        destination: arrivalCode,
        departure_date: departureDate,
      },
      headers: {
        'x-apikey': FLIGHTAWARE_API_KEY,
      },
    });

    return {
      flights: response.data.flights || [],
      apiCalls: 1,
    };
  } catch (error) {
    console.error('FlightAware API error:', error.message);
    return { flights: [], apiCalls: 0, error: error.message };
  }
}

export async function getFlightStatus(flightNumber) {
  if (!FLIGHTAWARE_API_KEY) {
    return { status: null, apiCalls: 0 };
  }

  try {
    const response = await axios.get(`${FLIGHTAWARE_BASE_URL}/flights/${flightNumber}`, {
      headers: {
        'x-apikey': FLIGHTAWARE_API_KEY,
      },
    });

    return {
      status: response.data,
      apiCalls: 1,
    };
  } catch (error) {
    console.error('FlightAware status error:', error.message);
    return { status: null, apiCalls: 0, error: error.message };
  }
}

export default {
  getFlights,
  getFlightStatus,
};

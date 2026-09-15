// Ticketmaster External API Service
import axios from 'axios';

const TICKETMASTER_API_KEY = process.env.TICKETMASTER_API_KEY;
const TICKETMASTER_BASE_URL = 'https://app.ticketmaster.com/discovery/v2';

export async function searchEvents(keyword, city) {
  if (!TICKETMASTER_API_KEY) {
    console.warn('⚠️  Ticketmaster API key not configured');
    return { events: [], apiCalls: 0 };
  }

  try {
    const response = await axios.get(`${TICKETMASTER_BASE_URL}/events.json`, {
      params: {
        keyword: keyword,
        city: city,
        apikey: TICKETMASTER_API_KEY,
      },
    });

    return {
      events: response.data._embedded?.events || [],
      apiCalls: 1,
    };
  } catch (error) {
    console.error('Ticketmaster API error:', error.message);
    return { events: [], apiCalls: 0, error: error.message };
  }
}

export async function getEventDetails(eventId) {
  if (!TICKETMASTER_API_KEY) {
    return { event: null, apiCalls: 0 };
  }

  try {
    const response = await axios.get(`${TICKETMASTER_BASE_URL}/events/${eventId}`, {
      params: {
        apikey: TICKETMASTER_API_KEY,
      },
    });

    return {
      event: response.data,
      apiCalls: 1,
    };
  } catch (error) {
    console.error('Ticketmaster event details error:', error.message);
    return { event: null, apiCalls: 0, error: error.message };
  }
}

export default {
  searchEvents,
  getEventDetails,
};

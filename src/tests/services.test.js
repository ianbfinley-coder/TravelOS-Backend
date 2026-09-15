/**
 * Service Wrapper Tests
 */

import axios from 'axios';
import * as googlePlaces from '../services/google-places.js';
import * as flightaware from '../services/flightaware.js';

jest.mock('axios');

jest.mock('../services/logging.js', () => ({
  logAPICall: jest.fn()
}));

jest.mock('../services/cache.js', () => ({
  getCached: jest.fn(() => null),
  setCached: jest.fn()
}));

describe('Google Places Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    axios.get.mockResolvedValue({
      data: {
        results: [{ place_id: '123', name: 'Result' }]
      }
    });
  });

  test('should call axios.get', async () => {
    await googlePlaces.searchPlaces({ query: 'hotel', lat: 40.7, lng: -74.0 });
    expect(axios.get).toHaveBeenCalled();
  });

  test('should return response.data', async () => {
    const result = await googlePlaces.searchPlaces({ query: 'hotel', lat: 40.7, lng: -74.0 });
    expect(result.results).toBeDefined();
  });

  test('should log API call', async () => {
    const { logAPICall } = require('../services/logging.js');
    await googlePlaces.searchPlaces({ query: 'hotel', lat: 40.7, lng: -74.0 });
    expect(logAPICall).toHaveBeenCalled();
  });

  test('should cache result', async () => {
    const { setCached } = require('../services/cache.js');
    await googlePlaces.searchPlaces({ query: 'hotel', lat: 40.7, lng: -74.0 });
    expect(setCached).toHaveBeenCalled();
  });

  test('should handle errors', async () => {
    axios.get.mockRejectedValue(new Error('API Error'));
    await expect(googlePlaces.searchPlaces({ query: 'hotel', lat: 40.7, lng: -74.0 }))
      .rejects.toThrow('API Error');
  });
});

describe('FlightAware Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    axios.get.mockResolvedValue({
      data: { ident: 'UA123', status: 'In Flight' }
    });
  });

  test('should call axios.get', async () => {
    await flightaware.getFlightStatus('UA123');
    expect(axios.get).toHaveBeenCalled();
  });

  test('should return flight data', async () => {
    const result = await flightaware.getFlightStatus('UA123');
    expect(result.ident).toBe('UA123');
  });

  test('should log API call', async () => {
    const { logAPICall } = require('../services/logging.js');
    await flightaware.getFlightStatus('UA123');
    expect(logAPICall).toHaveBeenCalled();
  });

  test('should handle errors', async () => {
    axios.get.mockRejectedValue(new Error('Flight not found'));
    await expect(flightaware.getFlightStatus('INVALID'))
      .rejects.toThrow('Flight not found');
  });
});
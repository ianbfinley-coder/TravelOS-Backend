/**
 * Integration Tests - End-to-End Flows
 * Tests full request lifecycle
 */

import request from 'supertest';
import express from 'express';
import { setupRateLimiting, resetLimits } from '../../middleware/rate-limit.js';
import errorHandler from '../../middleware/error-handler.js';
import * as googlePlaces from '../../services/google-places.js';
import * as flightaware from '../../services/flightaware.js';

jest.mock('axios');
jest.mock('../../services/google-places.js');
jest.mock('../../services/flightaware.js');

const createApp = () => {
  const app = express();
  setupRateLimiting(app);

  app.get('/api/places/search', async (req, res) => {
    try {
      const result = await googlePlaces.searchPlaces({
        query: req.query.query,
        lat: parseFloat(req.query.lat),
        lng: parseFloat(req.query.lng)
      });
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/flights/:code', async (req, res) => {
    try {
      const result = await flightaware.getFlightStatus(req.params.code);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.use(errorHandler);
  return app;
};

describe('Integration: Places Search', () => {
  let app;

  beforeEach(() => {
    resetLimits();
    jest.clearAllMocks();
    app = createApp();

    googlePlaces.searchPlaces.mockResolvedValue({
      results: [{ name: 'Coffee Shop', rating: 4.5 }]
    });
  });

  test('should complete places search request', async () => {
    const res = await request(app)
      .get('/api/places/search')
      .query({ query: 'coffee', lat: 40.7, lng: -74.0 });

    expect(res.status).toBe(200);
    expect(googlePlaces.searchPlaces).toHaveBeenCalled();
  });

  test('should handle places service errors', async () => {
    googlePlaces.searchPlaces.mockRejectedValue(new Error('Service down'));

    const res = await request(app)
      .get('/api/places/search')
      .query({ query: 'coffee', lat: 40.7, lng: -74.0 });

    expect(res.status).toBe(500);
  });
});

describe('Integration: Flight Status', () => {
  let app;

  beforeEach(() => {
    resetLimits();
    jest.clearAllMocks();
    app = createApp();

    flightaware.getFlightStatus.mockResolvedValue({
      ident: 'UA123',
      status: 'In Flight'
    });
  });

  test('should get flight status', async () => {
    const res = await request(app).get('/api/flights/UA123');

    expect(res.status).toBe(200);
    expect(flightaware.getFlightStatus).toHaveBeenCalledWith('UA123');
  });

  test('should enforce strict rate limit on flights', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await request(app).get('/api/flights/UA123');
      expect(res.status).toBe(200);
    }

    const res = await request(app).get('/api/flights/UA123');
    expect(res.status).toBe(429);
  });
});
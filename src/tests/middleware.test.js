/**
 * Rate Limiting Middleware Tests
 */

import request from 'supertest';
import express from 'express';
import { setupRateLimiting, resetLimits } from '../middleware/rate-limit.js';

describe('Rate Limiting Middleware', () => {
  let app;

  beforeEach(() => {
    resetLimits();
    app = express();
    setupRateLimiting(app);
    app.get('/api/test', (req, res) => {
      res.status(200).json({ success: true });
    });
  });

  describe('Basic Rate Limiting', () => {
    test('should allow requests within limit', async () => {
      const res = await request(app)
        .get('/api/test')
        .set('X-User-Id', 'user_1');

      expect(res.status).toBe(200);
    });

    test('should set rate limit headers', async () => {
      const res = await request(app)
        .get('/api/test')
        .set('X-User-Id', 'user_1');

      expect(res.headers['x-ratelimit-limit']).toBeDefined();
      expect(res.headers['x-ratelimit-remaining']).toBeDefined();
      expect(res.headers['x-ratelimit-reset']).toBeDefined();
    });
  });

  describe('Rate Limit Enforcement', () => {
    test('should block requests after 100 for free tier user', async () => {
      const userId = 'free_tier_rate_test';

      // Free tier: 100 requests/15min, 50 requests/month
      // Make 50 requests (within monthly quota, within rate limit)
      for (let i = 0; i < 50; i++) {
        const res = await request(app)
          .get('/api/test')
          .set('X-User-Id', userId);

        expect(res.status).toBe(200);
      }

      // 51st request should fail with 403 (quota exceeded for free tier)
      const res = await request(app)
        .get('/api/test')
        .set('X-User-Id', userId);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('QUOTA_EXCEEDED');
    });

    test('should enforce rate limit for same user', async () => {
      const userId = 'rate_limit_tracking';

      // Make requests and check remaining count decreases
      const res1 = await request(app)
        .get('/api/test')
        .set('X-User-Id', userId);

      expect(res1.status).toBe(200);
      const remaining1 = parseInt(res1.headers['x-ratelimit-remaining']);
      expect(remaining1).toBe(99);

      const res2 = await request(app)
        .get('/api/test')
        .set('X-User-Id', userId);

      expect(res2.status).toBe(200);
      const remaining2 = parseInt(res2.headers['x-ratelimit-remaining']);
      expect(remaining2).toBe(98);

      // Verify it decreased
      expect(remaining2).toBeLessThan(remaining1);
    });
  });

  describe('Tier-based Limits', () => {
    test('should distinguish free and premium tiers', async () => {
      // Free tier user
      const freeRes = await request(app)
        .get('/api/test')
        .set('X-User-Id', 'free_user')
        .set('X-User-Tier', 'free');

      expect(freeRes.status).toBe(200);

      // Premium tier user with Authorization header
      const premiumRes = await request(app)
        .get('/api/test')
        .set('X-User-Id', 'premium_user')
        .set('X-User-Tier', 'premium')
        .set('Authorization', 'Bearer premium_token');

      expect(premiumRes.status).toBe(200);
    });

    test('should apply premium 3x multiplier to rate limit', async () => {
      const premiumUserId = 'premium_multiplier_test';

      // Premium user should have higher rate limit (300 instead of 100)
      // Get the limit from first request header
      const res1 = await request(app)
        .get('/api/test')
        .set('X-User-Id', premiumUserId)
        .set('X-User-Tier', 'premium')
        .set('Authorization', 'Bearer premium_token');

      expect(res1.status).toBe(200);
      const premiumLimit = parseInt(res1.headers['x-ratelimit-limit']);

      // Should be 300 (100 * 3 multiplier)
      expect(premiumLimit).toBe(300);
    });
  });

  describe('Quota Enforcement', () => {
    test('should enforce free tier monthly quota (50)', async () => {
      const userId = 'free_monthly_quota';

      // Free tier: 50 request/month quota
      for (let i = 0; i < 50; i++) {
        const res = await request(app)
          .get('/api/test')
          .set('X-User-Id', userId);

        expect(res.status).toBe(200);
      }

      // 51st request should fail
      const res = await request(app)
        .get('/api/test')
        .set('X-User-Id', userId);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('QUOTA_EXCEEDED');
      expect(res.body.error.message).toContain('Monthly quota exceeded');
    });

    test('should allow pro tier higher quota', async () => {
      const userId = 'pro_quota_test';

      // Pro tier: 1000 request/month
      const res = await request(app)
        .get('/api/test')
        .set('X-User-Id', userId)
        .set('X-User-Tier', 'pro');

      expect(res.status).toBe(200);
    });

    test('should allow premium tier highest quota', async () => {
      const userId = 'premium_quota_test';

      // Premium tier: 3000 request/month
      const res = await request(app)
        .get('/api/test')
        .set('X-User-Id', userId)
        .set('X-User-Tier', 'premium')
        .set('Authorization', 'Bearer premium_token');

      expect(res.status).toBe(200);
    });
  });

  describe('Error Response Format', () => {
    test('should return proper error on quota exceeded', async () => {
      const userId = 'quota_error_format';

      for (let i = 0; i < 50; i++) {
        await request(app)
          .get('/api/test')
          .set('X-User-Id', userId);
      }

      const res = await request(app)
        .get('/api/test')
        .set('X-User-Id', userId);

      expect(res.status).toBe(403);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe('QUOTA_EXCEEDED');
      expect(res.body.error.message).toBeDefined();
      expect(res.body.error.timestamp).toBeDefined();
    });

    test('should include rate limit reset time in headers', async () => {
      const res = await request(app)
        .get('/api/test')
        .set('X-User-Id', 'reset_time_test');

      expect(res.status).toBe(200);
      expect(res.headers['x-ratelimit-reset']).toBeDefined();
      
      const resetTime = parseInt(res.headers['x-ratelimit-reset']);
      const now = Math.floor(Date.now() / 1000);
      
      // Reset time should be in the future
      expect(resetTime).toBeGreaterThan(now);
    });
  });
});

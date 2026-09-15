/**
 * Agent 8: Intelligent Rate Limiting Agent
 * Runs every hour
 * Monitors spend per user/feature and degrades service for high-cost users
 * Expected savings: $500-2000/month
 */

import logger from '../services/logging.js';
import { supabase } from '../config/database.js';
import { redis } from '../services/cache.js';

class SmartRateLimitingAgent {
  /**
   * Main execution method - runs every hour
   */
  async execute() {
    logger.info('[SmartRateLimitingAgent] Analyzing user spending patterns...');
    const startTime = Date.now();

    try {
      // Get spend by user
      const userSpend = await this.getUserSpending();

      // Calculate percentiles
      const percentiles = this.calculatePercentiles(userSpend);

      // Apply limits to high-spend users
      const results = await this.applyUserLimits(userSpend, percentiles);

      const duration = Date.now() - startTime;

      logger.info(`[SmartRateLimitingAgent] ✅ Completed in ${duration}ms - throttled ${results.throttledCount} users`);

      return { success: true, ...results };
    } catch (error) {
      logger.error('[SmartRateLimitingAgent] Error:', error);
      throw error;
    }
  }

  /**
   * Get API spend by user
   */
  async getUserSpending() {
    const { data, error } = await supabase
      .from('api_logs')
      .select('user_id, cost')
      .gte('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());

    if (error) {
      logger.warn('[SmartRateLimitingAgent] Could not fetch spending data:', error);
      return [];
    }

    // Aggregate by user
    const userMap = new Map();
    for (const log of data || []) {
      const userId = log.user_id;
      if (!userMap.has(userId)) {
        userMap.set(userId, 0);
      }
      userMap.set(userId, userMap.get(userId) + (log.cost || 0));
    }

    return Array.from(userMap.entries()).map(([userId, totalCost]) => ({
      userId,
      totalCost,
    }));
  }

  /**
   * Calculate spending percentiles
   */
  calculatePercentiles(userSpend) {
    const costs = userSpend.map((u) => u.totalCost).sort((a, b) => a - b);

    return {
      p50: costs[Math.floor(costs.length * 0.5)],
      p90: costs[Math.floor(costs.length * 0.9)],
      p95: costs[Math.floor(costs.length * 0.95)],
      p99: costs[Math.floor(costs.length * 0.99)],
      max: Math.max(...costs),
    };
  }

  /**
   * Apply rate limits based on spending
   */
  async applyUserLimits(userSpend, percentiles) {
    let throttledCount = 0;
    let downgradeCount = 0;
    let estimatedSavings = 0;

    for (const user of userSpend) {
      // P99 (top 1%) - enable cache-only mode
      if (user.totalCost > percentiles.p99) {
        await redis.set(`user_limit:${user.userId}:cache_only`, 'true', { EX: 3600 });
        throttledCount++;
        estimatedSavings += user.totalCost * 0.5; // 50% savings from cache degradation
        logger.info(`[SmartRateLimitingAgent] P99 user throttled: ${user.userId} (spend: $${user.totalCost.toFixed(2)})`);
      }
      // P95 (top 5%) - downgrade data freshness
      else if (user.totalCost > percentiles.p95) {
        await redis.set(`user_limit:${user.userId}:stale_data`, 'true', { EX: 3600 });
        downgradeCount++;
        estimatedSavings += user.totalCost * 0.3; // 30% savings from stale data
        logger.info(`[SmartRateLimitingAgent] P95 user downgraded: ${user.userId} (spend: $${user.totalCost.toFixed(2)})`);
      }
    }

    return { throttledCount, downgradeCount, estimatedSavings };
  }
}

export default new SmartRateLimitingAgent();

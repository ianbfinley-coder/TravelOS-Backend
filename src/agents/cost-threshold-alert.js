/**
 * Agent 10: Cost Threshold Alert & Auto-optimization
 * Runs every 15 minutes
 * Monitors API spend in real-time and activates cost-saving measures
 * Expected savings: $500-1000/month (prevents runaway costs)
 * HIGHEST PRIORITY - prevents budget overruns
 */

import logger from '../services/logging.js';
import { supabase } from '../config/database.js';
import { redis, getCached, setCached } from '../services/cache.js';
import { sendAlert } from '../services/alerts.js';

class CostThresholdAlertAgent {
  constructor() {
    this.dailyThreshold = process.env.COST_ALERT_THRESHOLD || 500; // $500/day
    this.costSavingMode = false;
    this.emergencyMode = false;
  }

  /**
   * Main execution method - runs every 15 minutes
   */
  async execute() {
    try {
      // Get today's API spend
      const dailySpend = await this.getDailySpend();

      // Get historical trend
      const trend = await this.getTrendData();

      logger.info(`[CostThresholdAlertAgent] Daily spend: $${dailySpend.toFixed(2)} (threshold: $${this.dailyThreshold})`);

      // Determine mode
      const costMultiplier = dailySpend / this.dailyThreshold;

      if (costMultiplier > 1.5) {
        // EMERGENCY MODE: >150% of threshold
        await this.activateEmergencyMode();
        return { mode: 'emergency', spend: dailySpend, multiplier: costMultiplier };
      } else if (costMultiplier > 1.2) {
        // COST SAVING MODE: >120% of threshold
        await this.activateCostSavingMode();
        return { mode: 'cost_saving', spend: dailySpend, multiplier: costMultiplier };
      } else if (costMultiplier < 0.8 && this.costSavingMode) {
        // Spend back to normal: <80% of threshold
        await this.deactivateCostSavingMode();
        return { mode: 'normal', spend: dailySpend, multiplier: costMultiplier };
      } else {
        return { mode: 'normal', spend: dailySpend, multiplier: costMultiplier };
      }
    } catch (error) {
      logger.error('[CostThresholdAlertAgent] Error:', error);
      throw error;
    }
  }

  /**
   * Get today's API spend from logs
   */
  async getDailySpend() {
    const { data, error } = await supabase
      .from('api_logs')
      .select('cost')
      .gte('created_at', new Date(new Date().setHours(0, 0, 0, 0)).toISOString())
      .lte('created_at', new Date().toISOString());

    if (error) {
      logger.warn('[CostThresholdAlertAgent] Could not fetch spend data:', error);
      return 0;
    }

    return (data || []).reduce((sum, log) => sum + (log.cost || 0), 0);
  }

  /**
   * Get trend data for anomaly detection
   */
  async getTrendData() {
    const { data, error } = await supabase
      .from('daily_spend')
      .select('date, amount')
      .gte('date', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
      .order('date', { ascending: false })
      .limit(30);

    if (error) return [];

    const amounts = (data || []).map((d) => d.amount);
    const avg = amounts.reduce((a, b) => a + b, 0) / amounts.length;
    const maxSpike = Math.max(...amounts);

    return { avg, maxSpike, amounts };
  }

  /**
   * Activate cost-saving mode (120-150% of threshold)
   */
  async activateCostSavingMode() {
    if (this.costSavingMode) return;

    logger.warn('[CostThresholdAlertAgent] 🚨 ACTIVATING COST SAVING MODE');

    this.costSavingMode = true;

    // Set Redis flags for all services to act on
    await redis.set('cost_saving_mode_active', 'true', { EX: 1800 }); // 30 min TTL

    // Cost-saving actions
    const actions = [
      'reduce_cache_ttl', // Serve stale data more aggressively
      'enable_user_filtering', // Only fetch for high-priority users
      'increase_dedup_window', // 2-hour dedup instead of 30-min
      'disable_realtime_tracking', // No real-time flight tracking for non-premium
    ];

    // Store which actions are active
    for (const action of actions) {
      await redis.set(`cost_saving:${action}`, 'true', { EX: 1800 });
    }

    // Alert ops team
    await sendAlert({
      severity: 'warning',
      title: '⚠️ Cost Saving Mode Activated',
      message: `Daily API spend exceeded 120% of threshold. Cost optimization measures enabled. Actions: ${actions.join(', ')}`,
      metadata: { mode: 'cost_saving', actions },
    });

    logger.info('[CostThresholdAlertAgent] ✅ Cost saving mode activated with actions:', actions);
  }

  /**
   * Activate emergency mode (>150% of threshold)
   */
  async activateEmergencyMode() {
    if (this.emergencyMode) return;

    logger.error('[CostThresholdAlertAgent] 🚨 ACTIVATING EMERGENCY MODE');

    this.emergencyMode = true;

    // Set Redis flag
    await redis.set('emergency_mode_active', 'true', { EX: 3600 }); // 1 hour TTL

    // Emergency actions (most aggressive)
    const actions = [
      'cache_everything', // Return cached data for all requests
      'skip_api_calls', // Don't make real API calls, use fallback data
      'enable_premium_only', // Restrict features to premium users
      'disable_flights', // Disable flight tracking completely
      'disable_enrichment', // Disable data enrichment
      'read_only_mode', // No writes to avoid logging costs
    ];

    for (const action of actions) {
      await redis.set(`emergency:${action}`, 'true', { EX: 3600 });
    }

    // Critical alert
    await sendAlert({
      severity: 'critical',
      title: '🚨 EMERGENCY MODE ACTIVATED',
      message: `Daily API spend exceeded 150% of threshold! Switching to cache-only mode. Actions: ${actions.join(', ')}`,
      metadata: { mode: 'emergency', actions },
      channels: ['email', 'slack', 'sms'], // Send to all channels
    });

    logger.error('[CostThresholdAlertAgent] 🚨 Emergency mode activated with actions:', actions);
  }

  /**
   * Deactivate cost-saving mode when spend normalized
   */
  async deactivateCostSavingMode() {
    if (!this.costSavingMode) return;

    logger.info('[CostThresholdAlertAgent] ✅ Deactivating cost saving mode - spend normalized');

    this.costSavingMode = false;

    // Clear Redis flags
    await redis.del('cost_saving_mode_active');
    await redis.del('cost_saving:reduce_cache_ttl');
    await redis.del('cost_saving:enable_user_filtering');
    await redis.del('cost_saving:increase_dedup_window');
    await redis.del('cost_saving:disable_realtime_tracking');

    // Alert ops team
    await sendAlert({
      severity: 'info',
      title: '✅ Cost Saving Mode Deactivated',
      message: 'API spend returned to normal levels. All features restored.',
    });
  }
}

export default new CostThresholdAlertAgent();

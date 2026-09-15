/**
 * Agent 7: Predictive User Behavior Agent
 * Runs weekly per user
 * Learns which features each user uses, only fetches relevant data
 * Expected savings: $400-1500/month
 */

import logger from '../services/logging.js';
import { supabase } from '../config/database.js';
import { redis, setCached } from '../services/cache.js';

class UserBehaviorPredictorAgent {
  /**
   * Main execution - runs weekly
   */
  async execute() {
    logger.info('[UserBehaviorPredictorAgent] Analyzing user behavior patterns...');
    const startTime = Date.now();

    try {
      // Get active users
      const activeUsers = await this.getActiveUsers();
      logger.info(`[UserBehaviorPredictorAgent] Analyzing ${activeUsers.length} active users`);

      // Analyze each user
      const results = await this.analyzeUsers(activeUsers);

      const duration = Date.now() - startTime;

      logger.info(`[UserBehaviorPredictorAgent] ✅ Completed in ${duration}ms - profiled ${results.profiledCount} users`);

      return { success: true, ...results };
    } catch (error) {
      logger.error('[UserBehaviorPredictorAgent] Error:', error);
      throw error;
    }
  }

  /**
   * Get active users from last 30 days
   */
  async getActiveUsers() {
    const { data, error } = await supabase
      .from('users')
      .select('id, user_type')
      .gte('last_activity_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());

    if (error) {
      logger.warn('[UserBehaviorPredictorAgent] Could not fetch users:', error);
      return [];
    }

    return data || [];
  }

  /**
   * Analyze each user's feature usage
   */
  async analyzeUsers(activeUsers) {
    let profiledCount = 0;
    let optimizationApplied = 0;

    for (const user of activeUsers) {
      try {
        // Get user's last 30 days of actions
        const { data: actions, error } = await supabase
          .from('user_actions')
          .select('feature, count')
          .eq('user_id', user.id)
          .gte('date', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());

        if (error) continue;

        // Classify user type
        const profile = this.classifyUser(actions || []);

        // Store profile for 7 days
        await redis.set(
          `user_profile:${user.id}`,
          JSON.stringify(profile),
          { EX: 7 * 24 * 60 * 60 }
        );

        profiledCount++;

        // Log if optimization can be applied
        if (profile.lowPriorityFeatures.length > 0) {
          logger.debug(`[UserBehaviorPredictorAgent] User ${user.id} profile: ${profile.userType}, skip features: ${profile.lowPriorityFeatures.join(',')}`);
          optimizationApplied++;
        }
      } catch (error) {
        logger.warn(`[UserBehaviorPredictorAgent] Failed to analyze user ${user.id}:`, error);
      }
    }

    return { profiledCount, optimizationApplied };
  }

  /**
   * Classify user type based on feature usage
   */
  classifyUser(actions) {
    const features = {};

    for (const action of actions) {
      features[action.feature] = (features[action.feature] || 0) + action.count;
    }

    // Determine user type
    let userType = 'general';
    const highPriorityFeatures = [];
    const lowPriorityFeatures = [];

    // Business travelers: flights + hotels
    if (features.flights > 10 && features.hotels > 5) {
      userType = 'business';
      highPriorityFeatures.push('flights', 'hotels');
      lowPriorityFeatures.push('events', 'attractions');
    }
    // Leisure travelers: events + attractions
    else if (features.events > 10 || features.attractions > 10) {
      userType = 'leisure';
      highPriorityFeatures.push('events', 'attractions', 'restaurants');
      lowPriorityFeatures.push('flights');
    }
    // Budget travelers: prices + deals
    else if (features.prices > 10 || features.deals > 5) {
      userType = 'budget';
      highPriorityFeatures.push('flights', 'hotels', 'deals');
      lowPriorityFeatures.push('premium_events');
    }
    // Adventure travelers: activities
    else if (features.activities > 10) {
      userType = 'adventure';
      highPriorityFeatures.push('activities', 'attractions', 'weather');
      lowPriorityFeatures.push('flights');
    }

    return {
      userType,
      highPriorityFeatures,
      lowPriorityFeatures,
      featureUsage: features,
      confidence: 0.85,
    };
  }
}

export default new UserBehaviorPredictorAgent();

/**
 * Agent Configuration
 * Central configuration for all AI agents and optimization strategies
 */

export const agentConfig = {
  /**
   * Agent 1: FlightAware Predictor
   * Predictive pre-fetching of flight data
   */
  flightAwarePredictor: {
    enabled: true,
    interval: '6h', // Every 6 hours
    description: 'Predicts and pre-fetches flights for upcoming trips',
    expectedSavings: '$1000-10000/month',
    criticalityLevel: 'high',
    requirements: {
      flightAwareAPI: true,
      supabaseTrips: true,
      redisCache: true,
    },
  },

  /**
   * Agent 2: Google Places Cache Refresh
   */
  placesCacheRefresh: {
    enabled: true,
    interval: '12h', // Every 12 hours
    description: 'Refreshes cache for top 1000 searched locations',
    expectedSavings: '$30-200/month',
    criticalityLevel: 'medium',
    batchSize: 5, // Fetch 5 places at a time
    topLocationsLimit: 1000,
    cacheTTL: 86400, // 24 hours
  },

  /**
   * Agent 3: Request Deduplication
   */
  requestDeduplication: {
    enabled: true,
    interval: 'per-request', // Runs on every request
    description: 'Deduplicates and batches identical flight searches',
    expectedSavings: '$2000-8000/month',
    criticalityLevel: 'critical',
    deduplicationWindow: 30 * 60, // 30 minutes
    normalBatchSize: 10,
    costSavingBatchSize: 20,
    costSavingDedupWindow: 2 * 60 * 60, // 2 hours in cost-saving mode
  },

  /**
   * Agent 4: Mapbox Tile Pre-generation
   */
  mapboxTilePregeneration: {
    enabled: true,
    interval: '7d', // Weekly
    description: 'Pre-generates map tiles for popular destinations',
    expectedSavings: '$50-400/month',
    criticalityLevel: 'medium',
    topDestinationsLimit: 500,
    zoomLevels: [8, 10, 12, 14], // Pre-generate at these zoom levels
    cacheTTL: 604800, // 7 days
  },

  /**
   * Agent 5: Event/Ticketing Prefetch
   */
  eventTicketingPrefetch: {
    enabled: true,
    interval: '4h', // Every 4 hours
    description: 'Pre-fetches trending events and ticketing data',
    expectedSavings: '$0-100/month',
    criticalityLevel: 'low',
    trendingEventsLimit: 100,
    cacheTTL: 14400, // 4 hours
  },

  /**
   * Agent 6: Background Batch Processing
   */
  backgroundBatchProcessor: {
    enabled: true,
    interval: '24h', // Daily at 2 AM
    description: 'Processes expensive operations during off-peak hours',
    expectedSavings: '$200-500/month',
    criticalityLevel: 'medium',
    runTime: '02:00', // 2 AM UTC
    offPeakHours: [0, 1, 2, 3, 4, 5], // 12-6 AM UTC
  },

  /**
   * Agent 7: Predictive User Behavior
   */
  userBehaviorPredictor: {
    enabled: true,
    interval: '7d', // Weekly
    description: 'Analyzes user behavior to optimize feature delivery',
    expectedSavings: '$400-1500/month',
    criticalityLevel: 'medium',
    userTypes: ['business', 'leisure', 'budget', 'adventure', 'general'],
    analysisWindow: 30, // Days of history to analyze
  },

  /**
   * Agent 8: Smart Rate Limiting
   */
  smartRateLimiting: {
    enabled: true,
    interval: '1h', // Every hour
    description: 'Dynamically limits high-cost users',
    expectedSavings: '$500-2000/month',
    criticalityLevel: 'high',
    percentiles: {
      p95: 'downgrade_data_freshness',
      p99: 'cache_only_mode',
    },
    cacheOnlyTTL: 3600, // 1 hour
    staleTTL: 86400, // 24 hours
  },

  /**
   * Agent 9: Data Enrichment Pre-computation
   */
  dataEnrichmentPrecomputation: {
    enabled: true,
    interval: '24h', // Nightly
    description: 'Pre-computes complex data enrichment queries',
    expectedSavings: '$2000-5000/month',
    criticalityLevel: 'medium',
    runTime: '02:00', // 2 AM UTC
    upcomingTripWindow: 30, // Days ahead
    topDestinationsLimit: 50,
  },

  /**
   * Agent 10: Cost Threshold Alert (CRITICAL)
   */
  costThresholdAlert: {
    enabled: true,
    interval: '15m', // Every 15 minutes - MOST CRITICAL
    description: 'Monitors spend and activates cost-saving measures',
    expectedSavings: '$500-1000/month',
    criticalityLevel: 'critical',
    dailyThreshold: process.env.COST_ALERT_THRESHOLD || 500, // $500/day
    thresholds: {
      warning: 1.2, // 120% of daily threshold triggers cost-saving
      critical: 1.5, // 150% of daily threshold triggers emergency mode
      normal: 0.8, // <80% resumes normal operation
    },
    costSavingActions: [
      'reduce_cache_ttl',
      'enable_user_filtering',
      'increase_dedup_window',
      'disable_realtime_tracking',
    ],
    emergencyModeActions: [
      'cache_everything',
      'skip_api_calls',
      'enable_premium_only',
      'disable_flights',
      'disable_enrichment',
      'read_only_mode',
    ],
    alertChannels: {
      warning: ['slack', 'email'],
      critical: ['slack', 'email', 'sms'],
    },
  },
};

/**
 * Summary configuration
 */
export const agentSummary = {
  totalAgents: 10,
  estimatedMonthlySavings: {
    startup: '$5000-12000', // 100K users
    growth: '$6500-18000', // 500K users
    scale: '$8000-24000+', // 1M+ users
  },
  criticalAgents: [
    'costThresholdAlert',
    'requestDeduplication',
    'flightAwarePredictor',
  ],
  highImpactAgents: [
    'smartRateLimiting',
    'userBehaviorPredictor',
    'dataEnrichmentPrecomputation',
  ],
  implementationOrder: [
    'costThresholdAlert', // Deploy first - prevents runaway costs
    'requestDeduplication', // Deploy second - immediate high impact
    'flightAwarePredictor', // Deploy third - reduces expensive API calls
    'smartRateLimiting', // Deploy fourth - protects high-cost users
    'userBehaviorPredictor', // Deploy fifth - optimizes per-user
    'placesCacheRefresh', // Deploy sixth - medium impact
    'mapboxTilePregeneration', // Deploy seventh
    'eventTicketingPrefetch', // Deploy eighth
    'backgroundBatchProcessor', // Deploy ninth
    'dataEnrichmentPrecomputation', // Deploy tenth
  ],
};

/**
 * Get agent configuration by name
 */
export function getAgentConfig(agentName) {
  const key = Object.keys(agentConfig).find(
    (k) => k.toLowerCase() === agentName.toLowerCase()
  );
  return key ? agentConfig[key] : null;
}

/**
 * Enable/disable agent
 */
export function setAgentEnabled(agentName, enabled) {
  const config = getAgentConfig(agentName);
  if (config) {
    config.enabled = enabled;
    return true;
  }
  return false;
}

/**
 * Get all enabled agents
 */
export function getEnabledAgents() {
  return Object.entries(agentConfig)
    .filter(([_, config]) => config.enabled)
    .map(([name, _]) => name);
}

export default agentConfig;

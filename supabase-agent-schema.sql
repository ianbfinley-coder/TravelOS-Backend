/**
 * Supabase Database Schema for AI Agents & Loops
 * Tables to support agent monitoring, cost tracking, and optimization
 */

-- ====================================
-- 1. Agent Metrics & Monitoring
-- ====================================

CREATE TABLE IF NOT EXISTS agent_metrics (
  id BIGSERIAL PRIMARY KEY,
  agent_name VARCHAR(255) NOT NULL,
  execution_timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
  metrics JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_agent_metrics_name ON agent_metrics(agent_name);
CREATE INDEX idx_agent_metrics_timestamp ON agent_metrics(execution_timestamp DESC);

-- ====================================
-- 2. Cost Tracking & Daily Spend
-- ====================================

ALTER TABLE api_logs ADD COLUMN IF NOT EXISTS cost DECIMAL(10, 4) DEFAULT 0;
ALTER TABLE api_logs ADD COLUMN IF NOT EXISTS service VARCHAR(100);
ALTER TABLE api_logs ADD COLUMN IF NOT EXISTS endpoint VARCHAR(255);
ALTER TABLE api_logs ADD COLUMN IF NOT EXISTS status_code INT;
ALTER TABLE api_logs ADD COLUMN IF NOT EXISTS response_time_ms INT;

CREATE TABLE IF NOT EXISTS daily_spend (
  id BIGSERIAL PRIMARY KEY,
  date DATE NOT NULL UNIQUE,
  amount DECIMAL(10, 2) DEFAULT 0,
  by_service JSONB, -- {service_name: amount, ...}
  forecast_amount DECIMAL(10, 2),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_daily_spend_date ON daily_spend(date DESC);

-- ====================================
-- 3. User Rate Limiting
-- ====================================

CREATE TABLE IF NOT EXISTS user_limits (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  daily_api_calls INT DEFAULT 1000,
  monthly_spend_limit DECIMAL(10, 2),
  is_premium BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id)
);

CREATE INDEX idx_user_limits_user_id ON user_limits(user_id);

-- ====================================
-- 4. User Behavior Profiles
-- ====================================

CREATE TABLE IF NOT EXISTS user_behavior_profiles (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  user_type VARCHAR(100), -- 'business', 'leisure', 'budget', 'adventure', 'general'
  high_priority_features TEXT[],
  low_priority_features TEXT[],
  feature_usage JSONB,
  confidence DECIMAL(3, 2),
  analysis_date DATE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id, analysis_date)
);

CREATE INDEX idx_user_profiles_user_id ON user_behavior_profiles(user_id);
CREATE INDEX idx_user_profiles_type ON user_behavior_profiles(user_type);

-- ====================================
-- 5. Search Analytics
-- ====================================

CREATE TABLE IF NOT EXISTS search_analytics (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  search_query VARCHAR(500),
  search_type VARCHAR(100), -- 'places', 'flights', 'hotels', etc.
  search_count INT DEFAULT 1,
  last_searched_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_search_analytics_type ON search_analytics(search_type);
CREATE INDEX idx_search_analytics_count ON search_analytics(search_count DESC);

-- ====================================
-- 6. User Actions for Behavior Analysis
-- ====================================

CREATE TABLE IF NOT EXISTS user_actions (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  feature VARCHAR(100), -- 'flights', 'hotels', 'events', 'attractions', 'restaurants'
  action VARCHAR(100), -- 'view', 'search', 'book', 'share'
  count INT DEFAULT 1,
  date DATE DEFAULT CURRENT_DATE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_user_actions_user_id ON user_actions(user_id);
CREATE INDEX idx_user_actions_feature ON user_actions(feature);
CREATE INDEX idx_user_actions_date ON user_actions(date DESC);

-- ====================================
-- 7. Cache Performance Tracking
-- ====================================

CREATE TABLE IF NOT EXISTS cache_stats (
  id BIGSERIAL PRIMARY KEY,
  cache_key VARCHAR(500),
  cache_hits INT DEFAULT 0,
  cache_misses INT DEFAULT 0,
  ttl_seconds INT,
  last_hit_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(cache_key)
);

CREATE INDEX idx_cache_stats_hits ON cache_stats(cache_hits DESC);
CREATE INDEX idx_cache_stats_updated ON cache_stats(updated_at DESC);

-- ====================================
-- 8. Cost Threshold Alerts
-- ====================================

CREATE TABLE IF NOT EXISTS cost_alerts (
  id BIGSERIAL PRIMARY KEY,
  threshold_type VARCHAR(100), -- 'warning', 'critical'
  alert_message TEXT,
  daily_spend DECIMAL(10, 2),
  threshold_amount DECIMAL(10, 2),
  actions_triggered TEXT[],
  alert_timestamp TIMESTAMP WITH TIME ZONE,
  resolved_at TIMESTAMP WITH TIME ZONE,
  acknowledged_by_user_id UUID REFERENCES auth.users(id),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_cost_alerts_timestamp ON cost_alerts(alert_timestamp DESC);
CREATE INDEX idx_cost_alerts_type ON cost_alerts(threshold_type);

-- ====================================
-- 9. API Request Deduplication Cache
-- ====================================

CREATE TABLE IF NOT EXISTS dedup_cache (
  id BIGSERIAL PRIMARY KEY,
  request_hash VARCHAR(64) UNIQUE,
  request_params JSONB,
  cached_response JSONB,
  requests_deduped INT DEFAULT 1,
  estimated_savings DECIMAL(10, 4),
  cache_expires_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_dedup_cache_expires ON dedup_cache(cache_expires_at);
CREATE INDEX idx_dedup_cache_savings ON dedup_cache(estimated_savings DESC);

-- ====================================
-- 10. Performance Metrics
-- ====================================

CREATE TABLE IF NOT EXISTS performance_metrics (
  id BIGSERIAL PRIMARY KEY,
  endpoint VARCHAR(255),
  response_time_p50 INT, -- milliseconds
  response_time_p95 INT,
  response_time_p99 INT,
  error_rate_percent DECIMAL(5, 2),
  cache_hit_rate_percent DECIMAL(5, 2),
  measurement_date DATE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(endpoint, measurement_date)
);

CREATE INDEX idx_perf_metrics_endpoint ON performance_metrics(endpoint);
CREATE INDEX idx_perf_metrics_date ON performance_metrics(measurement_date DESC);

-- ====================================
-- 11. Loop Execution History
-- ====================================

CREATE TABLE IF NOT EXISTS loop_executions (
  id BIGSERIAL PRIMARY KEY,
  loop_name VARCHAR(255),
  execution_start TIMESTAMP WITH TIME ZONE,
  execution_end TIMESTAMP WITH TIME ZONE,
  duration_ms INT,
  status VARCHAR(50), -- 'success', 'error', 'timeout'
  error_message TEXT,
  result_summary JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_loop_executions_name ON loop_executions(loop_name);
CREATE INDEX idx_loop_executions_status ON loop_executions(status);
CREATE INDEX idx_loop_executions_date ON loop_executions(execution_start DESC);

-- ====================================
-- Cleanup Policy
-- ====================================

-- Auto-delete old metrics (keep 90 days)
-- Run monthly: DELETE FROM agent_metrics WHERE created_at < NOW() - INTERVAL '90 days';
-- Run monthly: DELETE FROM loop_executions WHERE created_at < NOW() - INTERVAL '90 days';
-- Run monthly: DELETE FROM dedup_cache WHERE cache_expires_at < NOW();

-- ====================================
-- Grants
-- ====================================

-- Allow read access for monitoring
GRANT SELECT ON agent_metrics TO authenticated;
GRANT SELECT ON daily_spend TO authenticated;
GRANT SELECT ON performance_metrics TO authenticated;

-- Allow user to see their own data
GRANT SELECT ON user_limits TO authenticated;
GRANT SELECT ON user_behavior_profiles TO authenticated;
GRANT SELECT ON user_actions TO authenticated;

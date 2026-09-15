/**
 * API Call Logging Service
 * Tracks API calls, costs, and errors
 */

const callLog = [];

/**
 * Log API call with cost tracking
 */
export const logAPICall = (service, costInCents, endpoint, statusCode = 200, error = null) => {
  const timestamp = new Date().toISOString();
  const costInDollars = (costInCents / 100).toFixed(3);

  const logEntry = {
    timestamp,
    service,
    endpoint,
    cost: costInDollars,
    costCents: costInCents,
    statusCode,
    error: error ? error.message : null
  };

  callLog.push(logEntry);

  console.log(
    `[${service}] ${endpoint} - ${statusCode} - ${Date.now() - new Date(timestamp).getTime()}ms - $${costInDollars}`
  );

  return logEntry;
};

/**
 * Get total cost across all calls
 */
export const getTotalCost = () => {
  return callLog.reduce((sum, entry) => sum + parseFloat(entry.cost), 0);
};

/**
 * Get cost by service
 */
export const getCostByService = (service) => {
  return callLog
    .filter(entry => entry.service === service)
    .reduce((sum, entry) => sum + parseFloat(entry.cost), 0);
};

/**
 * Get all call logs
 */
export const getCallLogs = () => {
  return [...callLog];
};

/**
 * Clear all logs (for testing)
 */
export const clearLogs = () => {
  callLog.length = 0;
};

/**
 * Clear cache (for testing) - alias for clearLogs
 */
export const clearCache = () => {
  callLog.length = 0;
};

/**
 * Default logger object for use with orchestrator and other modules
 * Provides methods: info, warn, error, debug
 */
const logger = {
  info: (message) => {
    console.log(`[INFO] ${message}`);
  },
  warn: (message) => {
    console.warn(`[WARN] ${message}`);
  },
  error: (message, error) => {
    if (error) {
      console.error(`[ERROR] ${message}`, error);
    } else {
      console.error(`[ERROR] ${message}`);
    }
  },
  debug: (message) => {
    if (process.env.DEBUG === 'true') {
      console.log(`[DEBUG] ${message}`);
    }
  }
};

export default logger;

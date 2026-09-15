/**
 * AI Agent & Loop Orchestrator
 * Manages all 10 cost optimization agents with autonomous execution
 *
 * Agents:
 * 1. FlightAware Predictive Pre-fetching (every 6 hours)
 * 2. Google Places Cache Refresh (every 12 hours)
 * 3. Flight Search Deduplication (continuous/per-request)
 * 4. Mapbox Tile Pre-generation (weekly)
 * 5. Event/Ticketing Prefetch (every 4 hours)
 * 6. Smart Background Batch Processing (nightly at 2 AM)
 * 7. Predictive User Behavior (weekly per user)
 * 8. Intelligent Rate Limiting (every hour)
 * 9. Data Enrichment Pre-computation (nightly)
 * 10. Cost Threshold Alert & Auto-optimization (every 15 minutes)
 */

import EventEmitter from 'events';
import logger from '../services/logging.js';
import { supabase } from '../config/database.js';
import { redis } from '../services/cache.js';

class AgentOrchestrator extends EventEmitter {
  constructor() {
    super();
    this.agents = new Map();
    this.loops = new Map();
    this.isRunning = false;
  }

  /**
   * Register an agent
   */
  registerAgent(name, agent) {
    this.agents.set(name, agent);
    logger.info(`Agent registered: ${name}`);
  }

  /**
   * Register a loop (scheduled agent execution)
   */
  registerLoop(name, interval, callback) {
    this.loops.set(name, { interval, callback, timeoutId: null });
    logger.info(`Loop registered: ${name} (interval: ${interval}ms)`);
  }

  /**
   * Start all registered loops
   */
  async start() {
    if (this.isRunning) {
      logger.warn('Orchestrator is already running');
      return;
    }

    this.isRunning = true;
    logger.info('Starting Agent Orchestrator...');

    // Start each loop
    for (const [name, { interval, callback }] of this.loops.entries()) {
      this.startLoop(name, interval, callback);
    }

    // Emit start event
    this.emit('started');
    logger.info('✅ Agent Orchestrator started with all loops active');
  }

  /**
   * Start a single loop
   */
  startLoop(name, interval, callback) {
    const execute = async () => {
      try {
        logger.debug(`[${name}] Loop executing...`);
        await callback();
        logger.debug(`[${name}] Loop completed successfully`);
      } catch (error) {
        logger.error(`[${name}] Loop error:`, error);
        this.emit('loop_error', { name, error });
      }
    };

    // Execute immediately on first run
    execute();

    // Then schedule recurring execution
    const timeoutId = setInterval(execute, interval);
    this.loops.get(name).timeoutId = timeoutId;

    logger.info(`✅ Loop started: ${name}`);
  }

  /**
   * Stop all loops
   */
  async stop() {
    if (!this.isRunning) {
      return;
    }

    logger.info('Stopping Agent Orchestrator...');

    for (const [name, { timeoutId }] of this.loops.entries()) {
      if (timeoutId) {
        clearInterval(timeoutId);
        logger.info(`⏸ Loop stopped: ${name}`);
      }
    }

    this.isRunning = false;
    this.emit('stopped');
    logger.info('✅ Agent Orchestrator stopped');
  }

  /**
   * Get agent by name
   */
  getAgent(name) {
    return this.agents.get(name);
  }

  /**
   * Get loop status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      agents: Array.from(this.agents.keys()),
      loops: Array.from(this.loops.keys()).map((name) => ({
        name,
        active: this.isRunning,
      })),
    };
  }
}

export default new AgentOrchestrator();

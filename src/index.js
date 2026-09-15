import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';

import apiKeyConfig from './config/api-keys.js';
import { supabase } from './config/database.js';
import { initializeRedis } from './services/cache.js';
import { setupRateLimiting } from './middleware/rate-limit.js';
import errorHandler from './middleware/error-handler.js';

// Routes
import airQualityRoutes from './routes/air-quality.js';
import placesRoutes from './routes/places.js';
import attractionsRoutes from './routes/attractions.js';
import flightsRoutes from './routes/flights.js';
import eventsRoutes from './routes/events.js';
import mapRoutes from './routes/map.js';
import authRoutes from './routes/auth.js';

dotenv.config({ path: '.env.local' });

const app = express();
const PORT = process.env.PORT || 5000;

// Initialize Redis
const redis = await initializeRedis();

// Middleware
app.use(helmet());
app.use(cors({
  origin: ['http://localhost:3000', 'http://localhost:5173', 'http://127.0.0.1:3000', 'http://127.0.0.1:5173'],
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rate limiting
setupRateLimiting(app);

// Make services available to routes
app.locals.supabase = supabase;
app.locals.redis = redis;

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/air-quality', airQualityRoutes);
app.use('/api/places', placesRoutes);
app.use('/api/attractions', attractionsRoutes);
app.use('/api/flights', flightsRoutes);
app.use('/api/events', eventsRoutes);
app.use('/api/map', mapRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handler (must be last)
app.use(errorHandler);

// Start server - SIMPLE AND RELIABLE
const server = app.listen(PORT, () => {
  console.log(`🚀 TravelOS backend running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV}`);
  console.log(`\n✅ Server ready to accept requests`);
  console.log(`📍 Health check: http://localhost:${PORT}/health`);
  console.log(`🌐 CORS enabled for: localhost:3000, localhost:5173`);
});

// Handle errors
server.on('error', (error) => {
  console.error('❌ Server error:', error.message);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('\n⏹️  SIGTERM received, shutting down...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('\n⏹️  SIGINT received, shutting down...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

// Global error handlers
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ Unhandled Rejection:', reason);
});

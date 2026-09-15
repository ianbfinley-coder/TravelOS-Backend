// API Keys Configuration and Validation
const requiredKeys = [
  'MAPBOX_API_KEY',
  'STRIPE_PUBLIC_KEY',
  'STRIPE_SECRET_KEY',
  'GOOGLE_PLACES_API_KEY',
];

const optionalKeys = [
  'OPENAQ_API_KEY',
  'TICKETMASTER_API_KEY',
  'FLIGHTAWARE_API_KEY',
];

// Validate required API keys
const missingKeys = requiredKeys.filter(key => !process.env[key]);

if (missingKeys.length > 0) {
  console.warn(`⚠️  Missing API keys: ${missingKeys.join(', ')}`);
}

// Log available API keys (without exposing actual values)
console.log('\n✅ API Keys Configuration:');
requiredKeys.forEach(key => {
  const value = process.env[key];
  const masked = value ? `${value.substring(0, 10)}...` : 'NOT SET';
  console.log(`   • ${key}: ${masked}`);
});

optionalKeys.forEach(key => {
  const value = process.env[key];
  const status = value ? '✓' : '✗';
  console.log(`   • ${key}: ${status} (optional)`);
});

console.log();

export default {
  mapbox: process.env.MAPBOX_API_KEY,
  stripe: {
    public: process.env.STRIPE_PUBLIC_KEY,
    secret: process.env.STRIPE_SECRET_KEY,
  },
  googlePlaces: process.env.GOOGLE_PLACES_API_KEY,
  openaq: process.env.OPENAQ_API_KEY,
  ticketmaster: process.env.TICKETMASTER_API_KEY,
  flightaware: process.env.FLIGHTAWARE_API_KEY,
};

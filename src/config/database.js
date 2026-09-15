import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;

/**
 * Initialize Supabase client only if credentials are available
 * Falls back to null if not configured for development
 */
let supabase = null;

if (supabaseUrl && supabaseServiceKey && !supabaseUrl.includes('your-project')) {
  try {
    supabase = createClient(supabaseUrl, supabaseServiceKey);
    console.log('✅ Supabase client initialized');
  } catch (error) {
    console.warn('⚠️  Failed to initialize Supabase:', error.message);
    console.log('   Continuing without Supabase for development...');
  }
} else {
  console.log('⚠️  Supabase credentials not configured');
  console.log('   Set SUPABASE_URL and SUPABASE_SERVICE_KEY in .env.local to enable database features');
  console.log('   Continuing without database for development...');
}

/**
 * Mock database client for development when Supabase is not configured
 */
const mockDatabase = {
  from: (table) => ({
    select: () => Promise.resolve({ data: [], error: null }),
    insert: () => Promise.resolve({ data: {}, error: null }),
    update: () => Promise.resolve({ data: {}, error: null }),
    delete: () => Promise.resolve({ data: {}, error: null }),
  }),
  auth: {
    admin: {
      createUser: () => Promise.resolve({ data: {}, error: null }),
    },
  },
};

const client = supabase || mockDatabase;

export { client as supabase };
export { client as supabaseClient };
export default { supabase: client };

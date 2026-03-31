const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in environment variables');
}

const clientOptions = {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
};

// Data client — for DB queries (bypasses RLS with service_role)
const supabase = createClient(supabaseUrl, supabaseServiceKey, clientOptions);

// Auth client — separate instance for auth.getUser() so it doesn't
// override the authorization header on the data client
const supabaseAuth = createClient(supabaseUrl, supabaseServiceKey, clientOptions);

module.exports = { supabase, supabaseAuth };

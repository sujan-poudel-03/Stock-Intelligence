import { createClient } from '@supabase/supabase-js';

// Single shared Supabase client for server-side route handlers and lib code.
// Uses the anon key — this is a single-user app with no row-level auth.
let _client = null;

export function getSupabase() {
  if (_client) return _client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;

  if (!url || !key) {
    const err = new Error('Missing SUPABASE_URL or SUPABASE_ANON_KEY env vars');
    err.code = 'ENV_MISSING';
    throw err;
  }

  _client = createClient(url, key, {
    auth: { persistSession: false },
  });
  return _client;
}

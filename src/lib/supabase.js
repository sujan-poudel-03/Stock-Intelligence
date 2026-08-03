import { createClient } from '@supabase/supabase-js';

// Supabase clients, split by trust level (Phase 2 multi-tenancy). See
// docs/PHASE2-MULTITENANT.md.
//
//   getSupabase()            anon key       public reads (RLS-limited)   [DEFAULT]
//   getServiceSupabase()     service_role   cron/scan writes, BYPASSES RLS
//   getUserSupabase(token)   user JWT       per-user rows, RLS owner-only
//
// Until RLS is turned on, only getSupabase() is exercised — the two new factories
// are additive and lazy (they read their env only when first called), so importing
// this module and building the app never requires the new keys.

let _client = null; // anon singleton

// Anon client — public/browser-equivalent identity. Obeys RLS once it's enabled.
// UNCHANGED from the pre-Phase-2 behaviour: the shared read path stays on this.
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

let _serviceClient = null; // service-role singleton

// Service-role client — bypasses RLS. Server-only; used exclusively by the
// cron/scan write path (cron/scan, scan/worker, scan/brief, outcomes, and the
// side-channel writers) so those writes keep working once RLS is on. NEVER expose
// this key to the browser (no NEXT_PUBLIC_) and never use it to serve per-user data
// (it would ignore the owner check). Lazy: the key is only required when called.
export function getServiceSupabase() {
  if (_serviceClient) return _serviceClient;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    const err = new Error(
      'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars (server-only; required for cron writes once RLS is on)'
    );
    err.code = 'ENV_MISSING';
    throw err;
  }

  _serviceClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _serviceClient;
}

// Per-user client — scoped to a caller's Supabase JWT so `auth.uid()` resolves at
// the database and RLS enforces owner-only access on per-user tables. NOT a
// singleton: each request builds a client bound to its own token. Uses the anon key
// + the user's bearer token (this is the supported server-side pattern). Returns
// null if no token is supplied so callers can 401 cleanly.
export function getUserSupabase(token) {
  if (!token) return null;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;

  if (!url || !key) {
    const err = new Error('Missing SUPABASE_URL or SUPABASE_ANON_KEY env vars');
    err.code = 'ENV_MISSING';
    throw err;
  }

  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

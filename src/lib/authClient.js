'use client';

import { createClient } from '@supabase/supabase-js';

// Browser-side Supabase Auth client for Google Sign-In. Only works when the public
// env is set (NEXT_PUBLIC_SUPABASE_URL/ANON_KEY) — otherwise the app runs in open
// mode and this is inert. This is identity only; it never fetches market data.

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
export const authConfigured = !!(url && key);

let _client = null;
function client() {
  if (!authConfigured) return null;
  if (!_client) {
    _client = createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true } });
  }
  return _client;
}

export async function getAccessToken() {
  const c = client();
  if (!c) return null;
  const { data } = await c.auth.getSession();
  return data?.session?.access_token || null;
}

export async function signInWithGoogle() {
  const c = client();
  if (!c) return;
  await c.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.origin } });
}

export async function signOut() {
  const c = client();
  if (c) await c.auth.signOut();
}

// Subscribe to auth changes; returns an unsubscribe fn.
export function onAuthChange(cb) {
  const c = client();
  if (!c) return () => {};
  const { data } = c.auth.onAuthStateChange(() => cb());
  return () => data.subscription.unsubscribe();
}

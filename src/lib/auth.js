import { getSupabase } from './supabase.js';

// Admin authorization (server-enforced).
//
// The security boundary is HERE — the server rejecting non-admins — not the UI
// hiding a button. An admin is a Google account whose email is in the ADMIN_EMAILS
// allowlist. Identity comes from a Supabase Auth session (Google Sign-In): the
// client sends `Authorization: Bearer <supabase access token>`, we verify it and
// check the email.
//
// PHASED (matches CLAUDE.md): while ADMIN_EMAILS is UNSET the gate is OPEN
// (single-operator/trusted interim) so the app runs before auth is wired. The moment
// ADMIN_EMAILS is set, every gated route ENFORCES — no code change, just config.

export function adminEmails(env = process.env) {
  return String(env.ADMIN_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isAdminEmail(email, env = process.env) {
  if (!email) return false;
  return adminEmails(env).includes(String(email).trim().toLowerCase());
}

// The gate enforces only once an allowlist is configured.
export function adminGateEnabled(env = process.env) {
  return adminEmails(env).length > 0;
}

function bearerToken(request) {
  const h = request.headers.get('authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

// requireAdmin(request) -> { ok: true, email, open? } | { ok: false, status, error }
// Call at the top of every admin/system-config route handler.
export async function requireAdmin(request) {
  // Open mode: no allowlist yet — allow, but flag it so callers/logs know.
  if (!adminGateEnabled()) return { ok: true, email: null, open: true };

  const token = bearerToken(request);
  if (!token) return { ok: false, status: 401, error: 'Admin sign-in required' };

  try {
    const supabase = getSupabase();
    const { data, error } = await supabase.auth.getUser(token);
    const email = data?.user?.email;
    if (error || !email) return { ok: false, status: 401, error: 'Invalid or expired session' };
    if (!isAdminEmail(email)) return { ok: false, status: 403, error: 'Not authorized (admin only)' };
    return { ok: true, email };
  } catch {
    return { ok: false, status: 500, error: 'Auth verification failed' };
  }
}

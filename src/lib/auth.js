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

// getUserFromRequest(request) -> { id, email, token } | null
//
// The IDENTITY primitive for the per-user routes (watchlist / portfolio / settings).
// Same Bearer scheme as requireAdmin: the client sends `Authorization: Bearer
// <supabase access token>`; we verify it and return the caller's user. Routes use
// the returned `id` to scope EVERY query by `user_id` (.eq('user_id', id)) — the
// app-layer owner check that isolates users while RLS is still OFF, and which also
// survives RLS-on later (belt-and-suspenders). `token` is handed back so the route
// can build getUserSupabase(token). Returns null (→ 401) when the header is missing
// or the token is invalid/expired. Unlike requireAdmin there is no "open mode": a
// per-user row needs a real identity, so no token means no access.
export async function getUserFromRequest(request) {
  const token = bearerToken(request);
  if (!token) return null;
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase.auth.getUser(token);
    const user = data?.user;
    if (error || !user?.id) return null;
    return { id: user.id, email: user.email || null, token };
  } catch {
    return null;
  }
}

// resolveAdmin(request) -> { gateEnabled, isAdmin, email } — NON-gating. Lets the
// client ask "am I an admin?" so the UI can show/hide admin controls. The UI is a
// convenience only; the real boundary is requireAdmin on the mutation routes.
export async function resolveAdmin(request) {
  if (!adminGateEnabled()) return { gateEnabled: false, isAdmin: true, email: null };

  const token = bearerToken(request);
  if (!token) return { gateEnabled: true, isAdmin: false, email: null };

  try {
    const supabase = getSupabase();
    const { data, error } = await supabase.auth.getUser(token);
    const email = data?.user?.email || null;
    if (error || !email) return { gateEnabled: true, isAdmin: false, email: null };
    return { gateEnabled: true, isAdmin: isAdminEmail(email), email };
  } catch {
    return { gateEnabled: true, isAdmin: false, email: null };
  }
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

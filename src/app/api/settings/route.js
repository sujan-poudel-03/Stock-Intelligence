import { NextResponse } from 'next/server';
import { getUserSupabase } from '@/lib/supabase';
import { getUserFromRequest } from '@/lib/auth';
import { withGuard } from '@/lib/respond';

export const dynamic = 'force-dynamic';

// Per-user PERSONAL settings (Phase 2 step 5a) — the user's own view prefs
// (default exchange, sector view, theme...). Owner-only, app-layer enforced.
//
// This is NOT the agent/discovery config: discovery depth, sector focus and
// auto-add/remove shape the ONE global scan and are ADMIN-only, served by
// /api/admin/settings. A regular user's "Settings" = these personal prefs.

function unauthorized() {
  return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
}

// GET /api/settings -> { prefs: {} }
export const GET = withGuard(async (request) => {
  const user = await getUserFromRequest(request);
  if (!user) return unauthorized();

  const supabase = getUserSupabase(user.token);
  const { data, error } = await supabase
    .from('user_settings')
    .select('prefs')
    .eq('user_id', user.id)
    .maybeSingle();
  if (error) throw error;
  return NextResponse.json({ prefs: data?.prefs || {} });
});

// PUT /api/settings { prefs } -> upsert the whole prefs blob
export const PUT = withGuard(async (request) => {
  const user = await getUserFromRequest(request);
  if (!user) return unauthorized();

  let body;
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'invalid json' }, { status: 400 }); }
  const prefs = body?.prefs && typeof body.prefs === 'object' ? body.prefs : {};

  const supabase = getUserSupabase(user.token);
  const { error } = await supabase.from('user_settings').upsert(
    { user_id: user.id, prefs, updated_at: new Date().toISOString() },
    { onConflict: 'user_id' }
  );
  if (error) throw error;
  return NextResponse.json({ ok: true, prefs });
});

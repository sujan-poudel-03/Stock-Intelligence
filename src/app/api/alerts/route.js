import { NextResponse } from 'next/server';
import { getUserSupabase } from '@/lib/supabase';
import { getUserFromRequest } from '@/lib/auth';
import { normalizeAlertPrefs } from '@/lib/alertPrefs';
import { withGuard, unauthorized } from '@/lib/respond';

export const dynamic = 'force-dynamic';

// Per-user alert preferences (Phase 2 per-user layer). Owner-only, enforced at the
// APP layer exactly like /api/settings + /api/watchlist: verify the bearer token ->
// derive user_id -> scope EVERY query by that user_id (RLS is on; this filter is the
// belt-and-suspenders app-layer owner check). Which channels ping ME and which
// signal directions trigger it — a thin per-user layer over the shared signals, NOT
// the global channel wiring (that's admin, /api/admin/channels).

// GET /api/alerts -> { channels: {email,telegram}, thresholds: {onBuy,onSell}, telegramLinked }
export const GET = withGuard(async (request) => {
  const user = await getUserFromRequest(request);
  if (!user) return unauthorized();

  const supabase = getUserSupabase(user.token);
  // telegram_chat_id is selected best-effort: on an unmigrated DB (column absent)
  // this whole select would error, so fall back to the base columns and report
  // telegramLinked: false rather than 500ing the whole alerts panel.
  let data;
  let telegramLinked = false;
  const full = await supabase
    .from('alert_prefs')
    .select('channels, thresholds, telegram_chat_id')
    .eq('user_id', user.id)
    .maybeSingle();
  if (!full.error) {
    data = full.data;
    telegramLinked = !!full.data?.telegram_chat_id;
  } else {
    const base = await supabase.from('alert_prefs').select('channels, thresholds').eq('user_id', user.id).maybeSingle();
    if (base.error) throw base.error;
    data = base.data;
  }
  // Always hand back a full, defined shape so the UI can bind straight to it.
  return NextResponse.json({ ...normalizeAlertPrefs(data || {}), telegramLinked });
});

// PUT /api/alerts { channels, thresholds } -> upsert my prefs
export const PUT = withGuard(async (request) => {
  const user = await getUserFromRequest(request);
  if (!user) return unauthorized();

  let body;
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'invalid json' }, { status: 400 }); }
  const { channels, thresholds } = normalizeAlertPrefs(body);

  const supabase = getUserSupabase(user.token);
  const { error } = await supabase.from('alert_prefs').upsert(
    { user_id: user.id, channels, thresholds, updated_at: new Date().toISOString() },
    { onConflict: 'user_id' }
  );
  if (error) throw error;
  return NextResponse.json({ ok: true, channels, thresholds });
});

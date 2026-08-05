import { NextResponse } from 'next/server';
import { withGuard } from '@/lib/respond';
import { requireAdmin } from '@/lib/auth';
import { getSupabase, getServiceSupabase } from '@/lib/supabase';
import { KV } from '@/lib/constants';

export const dynamic = 'force-dynamic';

// GLOBAL agent/discovery config (Phase 2 step 5b) — discovery on/depth, auto-add
// threshold, auto-remove, sector focus. These shape the ONE global scan that serves
// every user (there is no per-user discovery), so they are ADMIN-only to WRITE.
//
// Lives in kv_store under KV.SETTINGS — the SAME key the cron/scan pipeline reads
// (loadSettings), so the scan is untouched. This route replaces the old identity-
// less /api/storage write for this key: reads stay open (the UI shows discovery
// depth to everyone), writes are gated by requireAdmin (was anon-writable before).

// GET /api/admin/settings -> { settings } (open read; reveals no secrets)
export const GET = withGuard(async () => {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('kv_store')
    .select('value')
    .eq('key', KV.SETTINGS)
    .maybeSingle();
  if (error) throw error;
  return NextResponse.json({ settings: data?.value || {} });
});

// POST /api/admin/settings { settings } -> persist global config. ADMIN-ONLY
// (server-enforced when ADMIN_EMAILS is set; open while single-operator).
export const POST = withGuard(async (request) => {
  const gate = await requireAdmin(request);
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

  const body = await request.json().catch(() => ({}));
  const settings = body?.settings && typeof body.settings === 'object' ? body.settings : null;
  if (!settings) return NextResponse.json({ error: 'missing settings' }, { status: 400 });

  // Service role write so it keeps working once RLS is on (shared/global tables are
  // writable only by the cron/service role).
  const supabase = getServiceSupabase();
  const { error } = await supabase.from('kv_store').upsert(
    { key: KV.SETTINGS, value: settings, updated_at: new Date().toISOString() },
    { onConflict: 'key' }
  );
  if (error) throw error;
  return NextResponse.json({ ok: true, settings });
});

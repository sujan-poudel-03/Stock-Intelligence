import { NextResponse } from 'next/server';
import { withGuard } from '@/lib/respond';
import { requireAdmin } from '@/lib/auth';
import { getServiceSupabase } from '@/lib/supabase';
import { systemWatchlistReady } from '@/lib/schemaFlags';
import { normalizeExchange } from '@/lib/exchanges';

export const dynamic = 'force-dynamic';

// Admin curation of the GLOBAL system/seed watchlist — the curated universe scanned
// for EVERYONE. ADMIN-ONLY (server-enforced against ADMIN_EMAILS via requireAdmin;
// open while single-operator). Writes go through the SERVICE client so RLS's
// public-read/service-write policy applies — a user can NEVER curate the shared list.
// The list is GLOBAL (NO user_id) and stores SYMBOLS ONLY, never prices.
//
// Probe-gated: on an unmigrated DB the table does not exist, so both verbs return 503
// rather than surfacing a raw error (mirrors the schema-flag discipline elsewhere).

// GET /api/admin/system-watchlist -> all rows (admin view, active + inactive).
export const GET = withGuard(async (request) => {
  const gate = await requireAdmin(request);
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

  if (!(await systemWatchlistReady())) {
    return NextResponse.json({ error: 'system_watchlist not migrated' }, { status: 503 });
  }

  const svc = getServiceSupabase();
  const { data, error } = await svc
    .from('system_watchlist')
    .select('id, symbol, exchange, source, reason, active, added_at, updated_at')
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return NextResponse.json({ systemWatchlist: data || [] });
});

// POST /api/admin/system-watchlist { exchange, symbol, action } where action is
//   add        -> upsert active row (source='admin')
//   deactivate -> mark active=false (kept for audit; drops it from the scan union)
//   remove     -> hard delete the row
export const POST = withGuard(async (request) => {
  const gate = await requireAdmin(request);
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

  if (!(await systemWatchlistReady())) {
    return NextResponse.json({ error: 'system_watchlist not migrated' }, { status: 503 });
  }

  const body = await request.json().catch(() => ({}));
  const exchange = normalizeExchange(body?.exchange);
  const symbol = String(body?.symbol || '').toUpperCase().trim();
  const action = String(body?.action || '').trim();
  if (!symbol) return NextResponse.json({ error: 'symbol required' }, { status: 400 });

  const svc = getServiceSupabase();
  const now = new Date().toISOString();

  if (action === 'add') {
    const { error } = await svc.from('system_watchlist').upsert(
      { symbol, exchange, source: 'admin', active: true, updated_at: now },
      { onConflict: 'exchange,symbol' }
    );
    if (error) throw error;
    return NextResponse.json({ ok: true, symbol, exchange, active: true });
  }

  if (action === 'deactivate') {
    const { error } = await svc
      .from('system_watchlist')
      .update({ active: false, updated_at: now })
      .eq('exchange', exchange)
      .eq('symbol', symbol);
    if (error) throw error;
    return NextResponse.json({ ok: true, symbol, exchange, active: false });
  }

  if (action === 'remove') {
    const { error } = await svc
      .from('system_watchlist')
      .delete()
      .eq('exchange', exchange)
      .eq('symbol', symbol);
    if (error) throw error;
    return NextResponse.json({ ok: true, symbol, exchange, removed: true });
  }

  return NextResponse.json(
    { error: 'unknown action', actions: ['add', 'deactivate', 'remove'] },
    { status: 400 }
  );
});

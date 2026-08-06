import { NextResponse } from 'next/server';
import { getUserSupabase } from '@/lib/supabase';
import { getUserFromRequest } from '@/lib/auth';
import { normalizeExchange } from '@/lib/exchanges';
import { withGuard } from '@/lib/respond';
import { getUserEntitlements, resolveWatchlistBlock } from '@/lib/entitlements';

export const dynamic = 'force-dynamic';

// Per-user watchlist (Phase 2 step 5a). Owner-only, enforced at the APP layer:
// verify the bearer token -> derive user_id -> scope EVERY query by that user_id
// (RLS is still OFF; this filter is what isolates users, and it survives RLS-on).
// The UNION of all users' rows feeds the global scan universe (see cron/scan).

function unauthorized() {
  return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
}

// GET /api/watchlist?exchange=NEPSE -> { watchlist: [{ symbol, reason, last_signal, added_at }] }
export const GET = withGuard(async (request) => {
  const user = await getUserFromRequest(request);
  if (!user) return unauthorized();
  const exchange = normalizeExchange(request.nextUrl.searchParams.get('exchange'));

  const supabase = getUserSupabase(user.token);
  const { data, error } = await supabase
    .from('watchlists')
    .select('symbol, reason, last_signal, added_at')
    .eq('user_id', user.id)
    .eq('exchange', exchange)
    .order('added_at', { ascending: true });

  if (error) throw error;
  return NextResponse.json({ watchlist: data || [] });
});

// POST /api/watchlist { exchange, symbol, reason? } -> upsert (idempotent add)
export const POST = withGuard(async (request) => {
  const user = await getUserFromRequest(request);
  if (!user) return unauthorized();

  let body;
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'invalid json' }, { status: 400 }); }
  const exchange = normalizeExchange(body?.exchange);
  const symbol = String(body?.symbol || '').toUpperCase().trim();
  if (!symbol) return NextResponse.json({ error: 'missing symbol' }, { status: 400 });

  const supabase = getUserSupabase(user.token);

  // Tier gate: enforce watchlist_limit (per exchange). Adding an EXISTING symbol is
  // idempotent and always allowed; a NEW symbol is blocked once the plan's limit is
  // reached. Unlimited tiers (limit null) never block.
  const entitlements = await getUserEntitlements(supabase, user.id);
  if (entitlements.watchlist_limit != null) {
    const { data: existing, error: countErr } = await supabase
      .from('watchlists')
      .select('symbol')
      .eq('user_id', user.id)
      .eq('exchange', exchange);
    if (countErr) throw countErr;
    const rows = existing || [];
    const isNew = !rows.some((r) => r.symbol === symbol);
    const { block, limit } = resolveWatchlistBlock({
      limit: entitlements.watchlist_limit,
      currentCount: rows.length,
      isNew,
    });
    if (block) {
      return NextResponse.json(
        { error: 'watchlist limit reached for your plan', limit },
        { status: 403 }
      );
    }
  }

  const row = { user_id: user.id, exchange, symbol, reason: body?.reason || 'manual' };
  const { error } = await supabase.from('watchlists').upsert(row, { onConflict: 'user_id,exchange,symbol' });
  if (error) throw error;
  return NextResponse.json({ ok: true, symbol });
});

// DELETE /api/watchlist?exchange=NEPSE&symbol=NABIL
export const DELETE = withGuard(async (request) => {
  const user = await getUserFromRequest(request);
  if (!user) return unauthorized();
  const exchange = normalizeExchange(request.nextUrl.searchParams.get('exchange'));
  const symbol = String(request.nextUrl.searchParams.get('symbol') || '').toUpperCase().trim();
  if (!symbol) return NextResponse.json({ error: 'missing symbol' }, { status: 400 });

  const supabase = getUserSupabase(user.token);
  const { error } = await supabase
    .from('watchlists')
    .delete()
    .eq('user_id', user.id)
    .eq('exchange', exchange)
    .eq('symbol', symbol);
  if (error) throw error;
  return NextResponse.json({ ok: true, symbol });
});

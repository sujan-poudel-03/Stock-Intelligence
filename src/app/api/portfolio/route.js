import { NextResponse } from 'next/server';
import { getUserSupabase } from '@/lib/supabase';
import { getUserFromRequest } from '@/lib/auth';
import { normalizeExchange } from '@/lib/exchanges';
import { withGuard } from '@/lib/respond';

export const dynamic = 'force-dynamic';

// Per-user portfolio / positions (Phase 2 step 5a). Owner-only, app-layer enforced:
// verify token -> user_id -> every query scoped by user_id. Positions are purely
// personal bookkeeping (they do NOT feed the global scan).
//
// This route stays the FAST raw-rows list (all statuses, this user only). The money
// math (cost basis, realized/unrealized net-of-charges P&L, CGT, sector concentration)
// is now computed SERVER-SIDE — see src/lib/portfolioMath.js (pure) + portfolioSummary.js
// (assembly), surfaced at GET /api/portfolio/summary and reused by the chat advisor.
// Prices there are the shared ground-truth signal prices, never LLM-sourced.
//
// NOTE: the portfolios schema has no free-text column, so the buy "basis" / sell
// "reason" the UI collects is not persisted server-side (see PHASE2 report).

function unauthorized() {
  return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
}

const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));

// GET /api/portfolio -> { positions: [row, ...] }  (all statuses, this user only)
export const GET = withGuard(async (request) => {
  const user = await getUserFromRequest(request);
  if (!user) return unauthorized();

  const supabase = getUserSupabase(user.token);
  const { data, error } = await supabase
    .from('portfolios')
    .select('*')
    .eq('user_id', user.id)
    .order('opened_at', { ascending: false });
  if (error) throw error;
  return NextResponse.json({ positions: data || [] });
});

// POST /api/portfolio { exchange, symbol, qty, buy_price, stop_loss?, target? } -> open a position
export const POST = withGuard(async (request) => {
  const user = await getUserFromRequest(request);
  if (!user) return unauthorized();

  let body;
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'invalid json' }, { status: 400 }); }
  const symbol = String(body?.symbol || '').toUpperCase().trim();
  const qty = num(body?.qty);
  const buyPrice = num(body?.buy_price);
  if (!symbol || !qty || !buyPrice) {
    return NextResponse.json({ error: 'symbol, qty and buy_price are required' }, { status: 400 });
  }

  const supabase = getUserSupabase(user.token);
  const row = {
    user_id: user.id,
    exchange: normalizeExchange(body?.exchange),
    symbol,
    qty,
    buy_price: buyPrice,
    stop_loss: num(body?.stop_loss),
    target: num(body?.target),
    status: 'open',
  };
  const { data, error } = await supabase.from('portfolios').insert(row).select().single();
  if (error) throw error;
  return NextResponse.json({ ok: true, position: data });
});

// PATCH /api/portfolio { id, sell_price, status?='closed' } -> close a position
export const PATCH = withGuard(async (request) => {
  const user = await getUserFromRequest(request);
  if (!user) return unauthorized();

  let body;
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'invalid json' }, { status: 400 }); }
  const id = body?.id;
  if (!id) return NextResponse.json({ error: 'missing id' }, { status: 400 });

  const patch = {
    status: body?.status || 'closed',
    sell_price: num(body?.sell_price),
    closed_at: body?.closed_at || new Date().toISOString(),
  };
  const supabase = getUserSupabase(user.token);
  const { data, error } = await supabase
    .from('portfolios')
    .update(patch)
    .eq('user_id', user.id)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return NextResponse.json({ ok: true, position: data });
});

// DELETE /api/portfolio?id=<uuid>
export const DELETE = withGuard(async (request) => {
  const user = await getUserFromRequest(request);
  if (!user) return unauthorized();
  const id = request.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'missing id' }, { status: 400 });

  const supabase = getUserSupabase(user.token);
  const { error } = await supabase.from('portfolios').delete().eq('user_id', user.id).eq('id', id);
  if (error) throw error;
  return NextResponse.json({ ok: true, id });
});

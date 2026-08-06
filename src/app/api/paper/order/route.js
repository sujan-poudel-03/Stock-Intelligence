import { NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/auth';
import { withGuard } from '@/lib/respond';
import { getUserSupabase } from '@/lib/supabase';
import { getVerifiedPrice } from '@/lib/marketProviders';
import { paperTradingReady } from '@/lib/schemaFlags';
import { previewOrder, isWholeQty, STARTING_CASH } from '@/lib/paperTrade';
import { buildPaperSummary, ensurePaperAccount } from '@/lib/paperSummary';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// POST /api/paper/order { symbol, side, qty } -> place a SIMULATED buy/sell (§4.1).
//
// GROUND-TRUTH FILL: the fill price comes ONLY from getVerifiedPrice (the same verified
// layer signals use) and FAILS CLOSED — an unverified quote REJECTS the order (422), it is
// never guessed. The pure fill/cash math (previewOrder) takes that verified price as an
// argument and reuses charges.js (legCharges/positionPnl) — no parallel money/tax math.
//
// Owner-only: token -> user_id -> every query scoped by user_id (paper_* tables, RLS).
// Exactly ONE getVerifiedPrice call per order. NEPSE-only v1 (charges.js is NEPSE-rate).
export const POST = withGuard(async (request) => {
  const user = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });

  // Probe-gate: on an unmigrated DB the feature is unavailable (never touch paper_*).
  if (!(await paperTradingReady())) {
    return NextResponse.json({ error: 'Paper trading is not enabled on this deployment' }, { status: 503 });
  }

  // --- parse + validate --------------------------------------------------------
  let body;
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'invalid json' }, { status: 400 }); }
  const symbol = String(body?.symbol || '').toUpperCase().trim();
  const side = String(body?.side || '').toUpperCase();
  const qty = Number(body?.qty);
  if (!symbol) return NextResponse.json({ error: 'symbol is required' }, { status: 400 });
  if (side !== 'BUY' && side !== 'SELL') return NextResponse.json({ error: 'side must be BUY or SELL' }, { status: 400 });
  if (!isWholeQty(qty)) return NextResponse.json({ error: 'quantity must be a whole number of shares (> 0)' }, { status: 400 });

  // --- ground-truth fill price — FAIL CLOSED -----------------------------------
  // NEPSE-only v1. The ONLY price source; a wrong/unverified quote must never fill.
  let verified;
  try { verified = await getVerifiedPrice(symbol, { exchange: 'NEPSE' }); }
  catch { verified = null; }
  const price = Number(verified?.price);
  if (!verified?.verified || !Number.isFinite(price) || price <= 0) {
    return NextResponse.json(
      { error: `Could not verify a live price for ${symbol} — order rejected (no guessed fills).` },
      { status: 422 }
    );
  }

  const supabase = getUserSupabase(user.token);

  // --- load account + this user's OPEN positions (owner-scoped) -----------------
  const account = await ensurePaperAccount(user, supabase);
  const { data: openRows, error: posErr } = await supabase
    .from('paper_positions')
    .select('*')
    .eq('user_id', user.id)
    .eq('status', 'open');
  if (posErr) throw posErr;
  const openPositions = openRows || [];
  const position = openPositions.find(
    (p) => String(p.symbol || '').toUpperCase() === symbol && String(p.exchange || 'NEPSE').toUpperCase() === 'NEPSE'
  ) || null;

  const holdDays = position?.opened_at
    ? Math.max(0, (Date.now() - Date.parse(position.opened_at)) / (24 * 60 * 60 * 1000))
    : null;

  // --- pure fill/cash math -----------------------------------------------------
  const preview = previewOrder({
    side,
    qty,
    price,
    cash: Number(account?.cash),
    position,
    holdDays,
    openPositionCount: openPositions.length,
  });
  if (!preview.ok) {
    // Business rejections (insufficient cash / oversell / no-position / caps) → 422.
    return NextResponse.json({ error: preview.reason, rejected: true }, { status: 422 });
  }

  // --- apply: position write, then cash (all owner-scoped) ----------------------
  const np = preview.newPosition;
  if (side === 'BUY') {
    if (np.opened) {
      const { error } = await supabase.from('paper_positions').insert({
        user_id: user.id,
        exchange: 'NEPSE',
        symbol,
        qty: np.qty,
        buy_price: np.buy_price,
        status: 'open',
      });
      if (error) throw error;
    } else {
      // Add to an existing holding — opened_at is deliberately NOT touched (first buy stands).
      const { error } = await supabase
        .from('paper_positions')
        .update({ qty: np.qty, buy_price: np.buy_price })
        .eq('user_id', user.id)
        .eq('id', position.id);
      if (error) throw error;
    }
  } else {
    // SELL — reduce qty (avg unchanged); a full sell closes the row.
    const patch = np.closed
      ? { qty: 0, status: 'closed', closed_at: new Date().toISOString(), sell_price: preview.fillPrice }
      : { qty: np.qty };
    const { error } = await supabase
      .from('paper_positions')
      .update(patch)
      .eq('user_id', user.id)
      .eq('id', position.id);
    if (error) throw error;
  }

  // Persist the new virtual cash balance (upsert on the PK; starting_cash preserved).
  const { error: cashErr } = await supabase
    .from('paper_accounts')
    .upsert(
      {
        user_id: user.id,
        cash: preview.newCash,
        starting_cash: Number(account?.starting_cash) || STARTING_CASH,
      },
      { onConflict: 'user_id' }
    );
  if (cashErr) throw cashErr;

  // Return the fresh summary so the client re-renders equity/positions in one round-trip.
  const summary = await buildPaperSummary(user);
  return NextResponse.json({ ok: true, fill: { side, symbol, qty, price: preview.fillPrice, charges: preview.charges, cgt: preview.cgt }, summary });
});

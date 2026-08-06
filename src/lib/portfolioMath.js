// Server-side portfolio P&L + concentration math — PURE, no I/O, never throws (TIER-2).
//
// Replaces the throwaway client-side portfolio math: given a user's raw positions plus
// a SHARED, already-computed price/sector map (assembled once from the global signals
// table — never re-scanned per user; prices are ground truth, never LLM-sourced), it
// produces per-position enriched rows + portfolio totals + sector/symbol concentration.
//
// LONG-ONLY: the portfolios schema has no short column, so every position is a BUY
// (buy @ buy_price, mark/sell @ current/sell price). Status is normalized to lowercase
// ('open' | 'closed') because the DB stores lowercase but older UI code used 'OPEN'.
//
// Money treatment (matches positionPnl in charges.js):
//   - OPEN   → mark-to-market. Headline unrealized P&L is net of TRANSACTION CHARGES
//              only (pre-tax); an "if sold today" after-CGT figure rides along separately.
//   - CLOSED → realized full round-trip, net of charges AND CGT at the actual
//              (closed_at − opened_at) hold-days rate.
// Concentration is the sector/symbol share of total CURRENT value of the OPEN holdings
// (cost basis stands in when a live price is unavailable). >concentrationPct → flagged
// overConcentrated — a surfaced metric, NOT advice.

import { positionPnl } from './charges.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Whole days between two timestamps (parseable date strings / epoch ms). null when
// either side is missing/unparseable — the caller then defaults to the short-term rate.
function daysBetween(a, b) {
  const t1 = typeof a === 'number' ? a : Date.parse(a);
  const t2 = typeof b === 'number' ? b : Date.parse(b);
  if (!Number.isFinite(t1) || !Number.isFinite(t2)) return null;
  return Math.max(0, (t2 - t1) / DAY_MS);
}

// buildSummary(positions, priceMap, sectorMap, opts) — the whole computation.
//   priceMap:  { SYMBOL: { price, asOf, stale } }  (SYMBOL uppercase; open positions)
//   sectorMap: { SYMBOL: sector }                  (else 'Unknown')
//   opts.concentrationPct (default 40) — the overConcentrated threshold.
//   opts.now (default Date.now()) — reference time for an OPEN position's hold-days
//     (drives the hypothetical "if sold today" CGT rate). Injectable for tests.
export function buildSummary(positions, priceMap = {}, sectorMap = {}, { concentrationPct = 40, now = Date.now() } = {}) {
  const list = Array.isArray(positions) ? positions : [];
  const rows = list.map((p) => enrich(p, priceMap, sectorMap, now));

  // Portfolio totals: current-state figures come from OPEN holdings; realized from CLOSED.
  const open = rows.filter((r) => r.status === 'open');
  const closed = rows.filter((r) => r.status === 'closed');

  const totalCostBasis = sum(open.map((r) => r.costBasis));
  const totalCurrentValue = sum(open.map((r) => r.currentValue));
  const totalUnrealizedNet = sum(open.map((r) => r.netPnl)); // pre-tax charges-only headline
  const totalUnrealizedNetAfterTax = sum(open.map((r) => r.netPnlAfterTax));
  const totalRealizedNet = sum(closed.map((r) => r.netPnl)); // incl CGT

  const bySymbol = concentration(open, totalCurrentValue, (r) => r.symbol, concentrationPct);
  const bySector = concentration(open, totalCurrentValue, (r) => r.sector, concentrationPct);
  const overConcentrated = bySector.some((s) => s.overConcentrated);

  return {
    positions: rows,
    totals: {
      openCount: open.length,
      closedCount: closed.length,
      costBasis: totalCostBasis,
      currentValue: totalCurrentValue,
      unrealizedNet: totalUnrealizedNet,
      unrealizedNetAfterTax: totalUnrealizedNetAfterTax,
      realizedNet: totalRealizedNet,
      priceUnavailableCount: open.filter((r) => r.priceUnavailable).length,
    },
    concentration: { bySymbol, bySector, threshold: concentrationPct, overConcentrated },
  };
}

// enrich(position, priceMap, sectorMap, now): one raw portfolio row → an enriched row.
function enrich(p, priceMap, sectorMap, now) {
  const symbol = String(p?.symbol || '').toUpperCase();
  const status = String(p?.status || '').toLowerCase() === 'closed' ? 'closed' : 'open';
  const realized = status === 'closed';
  const qty = num(p?.qty);
  const buyPrice = num(p?.buy_price);
  const stopLoss = num(p?.stop_loss);
  const target = num(p?.target);
  const sector = sectorMap[symbol] || 'Unknown';

  let currentPrice = null;
  let priceAsOf = null;
  let priceStale = false;
  let priceUnavailable = false;
  let closedAtMissing = false;
  let holdDays = null;

  if (realized) {
    // Realized hold-days = closed_at − opened_at (real money → the actual holding window).
    // A 'closed' row with no closed_at can't prove a long-term hold, so treat it as
    // short-term (7.5%) and flag it for surfacing.
    currentPrice = num(p?.sell_price);
    holdDays = daysBetween(p?.opened_at, p?.closed_at);
    if (p?.closed_at == null) closedAtMissing = true;
    priceUnavailable = currentPrice == null; // closed without a recorded sell price
  } else {
    const pm = priceMap[symbol];
    currentPrice = pm ? num(pm.price) : null;
    priceAsOf = pm?.asOf ?? null;
    priceStale = Boolean(pm?.stale);
    priceUnavailable = currentPrice == null;
    // Hold-days so far drives only the hypothetical "if sold today" CGT rate.
    holdDays = daysBetween(p?.opened_at, now);
  }

  const pnl = positionPnl({ qty, buyPrice, currentOrSellPrice: currentPrice, holdDays, realized });

  // Current value for the holdings view + concentration: live mark for a priced OPEN
  // position, cost basis when its price is unavailable, and 0 for a CLOSED position
  // (it is no longer held, so it must not weigh in concentration).
  let currentValue;
  if (realized) currentValue = 0;
  else if (priceUnavailable) currentValue = pnl.costBasis;
  else currentValue = pnl.grossValue;

  // After-tax figure: realized already includes CGT; for an open position it's the
  // "if sold today" number (pre-tax headline minus the hypothetical CGT).
  const netPnlAfterTax = realized ? pnl.netPnl : pnl.netPnl - pnl.cgt;

  // Distance-to-stop / distance-to-target as a % of the reference price (live price
  // when known, else the buy price). Positive distanceToStop = above the stop.
  const ref = currentPrice != null && currentPrice > 0 ? currentPrice : buyPrice;
  const distanceToStopPct =
    stopLoss != null && ref != null && ref > 0 ? ((ref - stopLoss) / ref) * 100 : null;
  const distanceToTargetPct =
    target != null && ref != null && ref > 0 ? ((target - ref) / ref) * 100 : null;

  return {
    id: p?.id ?? null,
    symbol,
    exchange: p?.exchange || null,
    status,
    realized,
    qty,
    buyPrice,
    stopLoss,
    target,
    sector,
    currentPrice,
    priceAsOf,
    priceStale,
    priceUnavailable,
    closedAtMissing,
    holdDays,
    costBasis: pnl.costBasis,
    buyCharges: pnl.buyCharges,
    grossValue: pnl.grossValue,
    sellCharges: pnl.sellCharges,
    currentValue,
    cgtRate: pnl.cgtRate,
    cgt: pnl.cgt,
    netPnl: pnl.netPnl,
    netPnlPreTax: pnl.netPnlPreTax,
    netPnlAfterTax,
    returnPct: pnl.returnPct,
    distanceToStopPct,
    distanceToTargetPct,
  };
}

// concentration(rows, total, keyOf, pct): group open rows by a key (symbol/sector),
// summing currentValue, and flag any bucket whose share exceeds `pct`. Sorted desc.
function concentration(rows, total, keyOf, pct) {
  const buckets = new Map();
  for (const r of rows) {
    const key = keyOf(r);
    buckets.set(key, (buckets.get(key) || 0) + (Number(r.currentValue) || 0));
  }
  const out = [];
  for (const [key, value] of buckets) {
    const share = total > 0 ? (value / total) * 100 : 0;
    out.push({ key, value, pct: share, overConcentrated: share > pct });
  }
  out.sort((a, b) => b.value - a.value);
  return out;
}

function sum(arr) {
  return arr.reduce((a, b) => a + (Number(b) || 0), 0);
}

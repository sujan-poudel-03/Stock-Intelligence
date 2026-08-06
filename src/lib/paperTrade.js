// Paper-trading fill/cash math — PURE, no I/O, never throws (Beginner flagship §4.1).
//
// This is the SIMULATED-account money engine. It is deliberately dumb about WHERE the
// price came from: the verified live price is passed in as `price` (an ARGUMENT). Per the
// ground-truth guardrail, this module NEVER sources a price — the caller (paper/order
// route) fetches it via getVerifiedPrice and FAILS CLOSED before ever calling here.
//
// It REUSES the same net-of-charges engine as real portfolios — legCharges + positionPnl
// from charges.js (NEPSE rates, CGT on the positive net gain) — so simulated P&L matches
// what a real round-trip would cost. NO parallel money/tax math lives here.
//
// LONG-ONLY, whole-share (NEPSE), NEPSE-only v1. buy_price is the qty-weighted average of
// FILL PRICES ONLY (WACC — charges are NOT folded in; positionPnl recomputes the buy leg's
// charges on exit). opened_at is the FIRST buy and is never reset by later adds.

import { legCharges, positionPnl } from './charges.js';

// Virtual starting balance for a fresh simulated account: NPR 1,000,000.
export const STARTING_CASH = 1_000_000;

// Anti-fat-finger / anti-gaming order-size ceiling (whole shares per single order). A
// simulated account can't place an order larger than this in one go.
export const MAX_ORDER_QTY = 100_000;

// Cap on distinct OPEN simulated positions — keeps the sandbox legible and bounds the
// on-demand price fetches the summary performs (see paperSummary MAX_PRICE_FALLBACKS).
export const MAX_OPEN_POSITIONS = 20;

// isWholeQty(qty): true only for a positive whole number of shares (NEPSE trades whole
// shares). Exported so the route + UI can pre-validate with the SAME rule.
export function isWholeQty(qty) {
  const n = Number(qty);
  return Number.isFinite(n) && Number.isInteger(n) && n > 0;
}

// previewOrder({ side, qty, price, cash, position, holdDays, openPositionCount })
//   side:              'BUY' | 'SELL'
//   qty:               whole shares to trade
//   price:             the VERIFIED live fill price (ground truth, passed in — never sourced here)
//   cash:              current virtual cash balance
//   position:          the existing OPEN position { qty, buy_price, opened_at } or null
//   holdDays:          days held so far (drives the CGT rate on a SELL); optional
//   openPositionCount: number of currently OPEN positions (for the MAX_OPEN_POSITIONS cap)
//
// -> { ok, reason?, fillPrice, fillValue, charges, cgt, cashDelta, newCash, newPosition, realized }
//   newPosition: { qty, buy_price, opened, closed } — the post-fill position shape the
//   caller persists (opened=true → this fill opens a brand-new row; closed=true → qty hit 0).
// Never throws; a rejection is { ok:false, reason } with the money fields zeroed.
export function previewOrder({ side, qty, price, cash, position, holdDays, openPositionCount = 0 } = {}) {
  const s = String(side || '').toUpperCase();
  const q = Number(qty);
  const p = Number(price);
  const bal = Number(cash);

  // Shared validation: whole positive qty + a usable (verified) price.
  if (!Number.isFinite(q) || !Number.isInteger(q)) return reject('Whole shares only');
  if (q <= 0) return reject('Quantity must be greater than zero');
  if (q > MAX_ORDER_QTY) return reject(`Max ${MAX_ORDER_QTY.toLocaleString('en-IN')} shares per order`);
  if (!Number.isFinite(p) || p <= 0) return reject('No verified price — order rejected');

  if (s === 'BUY') return previewBuy(q, p, bal, position, openPositionCount);
  if (s === 'SELL') return previewSell(q, p, bal, position, holdDays);
  return reject('Side must be BUY or SELL');
}

// BUY: fill at the verified price, debit cost + buy-leg charges, average-cost merge.
function previewBuy(qty, price, cash, position, openPositionCount) {
  const fillValue = qty * price;
  const charges = legCharges({ value: fillValue, side: 'BUY' }).total;
  const cost = fillValue + charges;

  const existingQty = Number(position?.qty) || 0;
  const isNewPosition = existingQty <= 0;

  // A brand-new position must fit under the open-position cap (adds to an existing
  // holding never increase the count).
  if (isNewPosition && Number(openPositionCount) >= MAX_OPEN_POSITIONS) {
    return reject(`Max ${MAX_OPEN_POSITIONS} open positions — close one first`);
  }

  if (!Number.isFinite(cash) || cost > cash) {
    return reject('Insufficient virtual cash for this buy');
  }

  // Weighted-average cost of FILL PRICES ONLY (WACC; charges are NOT folded in).
  const existingAvg = Number(position?.buy_price) || 0;
  const newQty = existingQty + qty;
  const newAvg = isNewPosition ? price : (existingQty * existingAvg + qty * price) / newQty;

  return {
    ok: true,
    fillPrice: price,
    fillValue,
    charges,
    cgt: 0,
    cashDelta: -cost,
    newCash: cash - cost,
    newPosition: { qty: newQty, buy_price: newAvg, opened: isNewPosition, closed: false },
    realized: false,
  };
}

// SELL: fill at the verified price, credit proceeds net of the sell-leg charges AND CGT.
// The buy-leg charges are NOT re-charged here (that cash was debited at buy time) — only
// positionPnl's sellCharges + cgt reduce the credit.
function previewSell(qty, price, cash, position, holdDays) {
  const heldQty = Number(position?.qty) || 0;
  const avg = Number(position?.buy_price) || 0;
  if (heldQty <= 0 || avg <= 0) return reject('No open position to sell');
  if (qty > heldQty) return reject('Cannot sell more than you hold');

  // Reuse the portfolio P&L engine for the sold portion (realized round-trip → net of
  // charges AND CGT). sellCharges + cgt are the ONLY deductions from the cash credit.
  const pnl = positionPnl({ qty, buyPrice: avg, currentOrSellPrice: price, holdDays, realized: true });
  const fillValue = qty * price;
  const credit = fillValue - pnl.sellCharges - pnl.cgt;

  const remaining = heldQty - qty;
  const closed = remaining <= 0;

  return {
    ok: true,
    fillPrice: price,
    fillValue,
    charges: pnl.sellCharges,
    cgt: pnl.cgt,
    cashDelta: credit,
    newCash: (Number.isFinite(cash) ? cash : 0) + credit,
    // Average cost is UNCHANGED by a sell; a full sell (remaining 0) closes the row.
    newPosition: { qty: remaining, buy_price: avg, opened: false, closed },
    realized: true,
    realizedPnl: pnl.netPnl, // full round-trip net (charges + CGT) — for display only
  };
}

function reject(reason) {
  return {
    ok: false,
    reason,
    fillPrice: 0,
    fillValue: 0,
    charges: 0,
    cgt: 0,
    cashDelta: 0,
    newCash: 0,
    newPosition: null,
    realized: false,
  };
}

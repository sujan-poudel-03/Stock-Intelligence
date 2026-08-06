import { describe, it, expect } from 'vitest';
import {
  previewOrder,
  isWholeQty,
  STARTING_CASH,
  MAX_ORDER_QTY,
  MAX_OPEN_POSITIONS,
} from '../src/lib/paperTrade.js';

// Paper-trading fill/cash math is MONEY-CRITICAL for the simulated account (a beginner
// learns cash/charges/CGT behavior from it). The underlying charge/CGT arithmetic is
// covered in charges.test.js (legCharges/positionPnl); here we test the FILL semantics:
// cash debit incl. charges, WACC merge, realized sell credit net of charges AND CGT, and
// every rejection (insufficient cash, oversell, non-whole/<=0 qty, no price, caps).
//
// NEPSE charge references (value <= 50k slab): broker = max(value*0.36%, Rs10),
// SEBON = value*0.015%, DP = Rs25 per leg.

describe('isWholeQty', () => {
  it('accepts only positive whole numbers of shares', () => {
    expect(isWholeQty(1)).toBe(true);
    expect(isWholeQty(100)).toBe(true);
    expect(isWholeQty(2.5)).toBe(false);
    expect(isWholeQty(0)).toBe(false);
    expect(isWholeQty(-5)).toBe(false);
    expect(isWholeQty('10')).toBe(true); // numeric-coercible
    expect(isWholeQty('abc')).toBe(false);
  });
});

describe('previewOrder — BUY', () => {
  it('debits cash by fill value + BUY-leg charges and opens a WACC position', () => {
    const r = previewOrder({ side: 'BUY', qty: 10, price: 100, cash: STARTING_CASH, position: null });
    expect(r.ok).toBe(true);
    // charges: broker max(1000*0.0036,10)=10 + sebon 0.15 + dp 25 = 35.15
    expect(r.charges).toBeCloseTo(35.15, 6);
    expect(r.fillValue).toBeCloseTo(1000, 6);
    expect(r.cashDelta).toBeCloseTo(-1035.15, 6);
    expect(r.newCash).toBeCloseTo(STARTING_CASH - 1035.15, 6);
    expect(r.newPosition.qty).toBe(10);
    expect(r.newPosition.buy_price).toBeCloseTo(100, 6);
    expect(r.newPosition.opened).toBe(true);
    expect(r.realized).toBe(false);
  });

  it('rejects a buy that costs more than the available cash', () => {
    const r = previewOrder({ side: 'BUY', qty: 100, price: 100, cash: 1000, position: null });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/insufficient/i);
    expect(r.newCash).toBe(0);
  });

  it('average-cost merges an add into an existing position (WACC of fill prices only)', () => {
    const position = { qty: 10, buy_price: 100 };
    const r = previewOrder({ side: 'BUY', qty: 10, price: 200, cash: STARTING_CASH, position });
    expect(r.ok).toBe(true);
    expect(r.newPosition.qty).toBe(20);
    expect(r.newPosition.buy_price).toBeCloseTo(150, 6); // (10*100 + 10*200)/20
    expect(r.newPosition.opened).toBe(false); // add, not a new row
  });
});

describe('previewOrder — SELL', () => {
  it('credits proceeds net of the SELL-leg charges AND CGT; average is unchanged', () => {
    const position = { qty: 10, buy_price: 100 };
    const r = previewOrder({ side: 'SELL', qty: 10, price: 120, cash: 500000, position, holdDays: 30 });
    expect(r.ok).toBe(true);
    expect(r.realized).toBe(true);
    // sellCharges: broker max(1200*0.0036,10)=10 + sebon 0.18 + dp 25 = 35.18
    expect(r.charges).toBeCloseTo(35.18, 6);
    // gain: sellProceedsNet(1164.82) - buyCostGross(1035.15) = 129.67; cgt 7.5% = 9.72525
    expect(r.cgt).toBeCloseTo(9.72525, 5);
    // credit = 1200 - 35.18 - 9.72525
    expect(r.cashDelta).toBeCloseTo(1200 - 35.18 - 9.72525, 5);
    expect(r.newCash).toBeCloseTo(500000 + (1200 - 35.18 - 9.72525), 5);
    expect(r.newPosition.qty).toBe(0);
    expect(r.newPosition.closed).toBe(true);
    expect(r.newPosition.buy_price).toBeCloseTo(100, 6); // avg never changes on a sell
  });

  it('a partial sell reduces qty, keeps the average, and stays open', () => {
    const position = { qty: 20, buy_price: 150 };
    const r = previewOrder({ side: 'SELL', qty: 5, price: 160, cash: 0, position, holdDays: 10 });
    expect(r.ok).toBe(true);
    expect(r.newPosition.qty).toBe(15);
    expect(r.newPosition.buy_price).toBeCloseTo(150, 6);
    expect(r.newPosition.closed).toBe(false);
  });

  it('rejects overselling more than held', () => {
    const position = { qty: 10, buy_price: 100 };
    const r = previewOrder({ side: 'SELL', qty: 20, price: 120, cash: 0, position });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/more than you hold/i);
  });

  it('rejects a sell with no open position', () => {
    const r = previewOrder({ side: 'SELL', qty: 5, price: 120, cash: 0, position: null });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no open position/i);
  });
});

describe('previewOrder — qty / price validation', () => {
  it('rejects a fractional quantity', () => {
    const r = previewOrder({ side: 'BUY', qty: 2.5, price: 100, cash: STARTING_CASH, position: null });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/whole shares/i);
  });

  it('rejects a zero / negative quantity', () => {
    expect(previewOrder({ side: 'BUY', qty: 0, price: 100, cash: STARTING_CASH, position: null }).ok).toBe(false);
    expect(previewOrder({ side: 'BUY', qty: -5, price: 100, cash: STARTING_CASH, position: null }).ok).toBe(false);
  });

  it('rejects a non-positive / missing price (fail-closed — no guessed fill)', () => {
    expect(previewOrder({ side: 'BUY', qty: 10, price: 0, cash: STARTING_CASH, position: null }).reason).toMatch(/no verified price/i);
    expect(previewOrder({ side: 'BUY', qty: 10, price: NaN, cash: STARTING_CASH, position: null }).ok).toBe(false);
  });

  it('rejects an unknown side', () => {
    const r = previewOrder({ side: 'HOLD', qty: 10, price: 100, cash: STARTING_CASH, position: null });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/BUY or SELL/i);
  });
});

describe('previewOrder — caps', () => {
  it('rejects an order exceeding MAX_ORDER_QTY', () => {
    const r = previewOrder({ side: 'BUY', qty: MAX_ORDER_QTY + 1, price: 1, cash: STARTING_CASH * 1000, position: null });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/per order/i);
  });

  it('rejects a NEW position once MAX_OPEN_POSITIONS is reached', () => {
    const r = previewOrder({
      side: 'BUY', qty: 1, price: 100, cash: STARTING_CASH, position: null, openPositionCount: MAX_OPEN_POSITIONS,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/open positions/i);
  });

  it('still allows ADDING to an existing position at the open-position cap', () => {
    const position = { qty: 10, buy_price: 100 };
    const r = previewOrder({
      side: 'BUY', qty: 5, price: 100, cash: STARTING_CASH, position, openPositionCount: MAX_OPEN_POSITIONS,
    });
    expect(r.ok).toBe(true);
    expect(r.newPosition.qty).toBe(15);
  });
});

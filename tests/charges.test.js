import { describe, it, expect } from 'vitest';
import {
  brokerCommission,
  legCharges,
  netReturn,
  positionPnl,
  SEBON_LEVY_PCT,
  DP_FEE,
  NOTIONAL_PRINCIPAL,
} from '../src/lib/charges.js';

// TIER-1 #3 net-of-charges math is money-critical (it changes the track-record headline).
// Charge schedule verified against 2026 NEPSE published rates — see charges.js header.

describe('brokerCommission (tiered, Rs 10 floor)', () => {
  it('applies the flat per-slab rate on the WHOLE transaction value', () => {
    expect(brokerCommission(50000)).toBeCloseTo(50000 * 0.0036, 6); // <=50k slab
    expect(brokerCommission(100000)).toBeCloseTo(100000 * 0.0033, 6); // 50k–500k
    expect(brokerCommission(1000000)).toBeCloseTo(1000000 * 0.0031, 6); // 500k–2M
    expect(brokerCommission(5000000)).toBeCloseTo(5000000 * 0.0027, 6); // 2M–10M
    expect(brokerCommission(20000000)).toBeCloseTo(20000000 * 0.0024, 6); // >10M
  });

  it('a slab boundary falls in the LOWER slab', () => {
    expect(brokerCommission(500000)).toBeCloseTo(500000 * 0.0033, 6);
    expect(brokerCommission(2000000)).toBeCloseTo(2000000 * 0.0031, 6);
    expect(brokerCommission(10000000)).toBeCloseTo(10000000 * 0.0027, 6);
  });

  it('enforces the Rs 10 per-transaction floor on tiny trades', () => {
    // 1000 * 0.36% = Rs 3.6 → floored to Rs 10.
    expect(brokerCommission(1000)).toBe(10);
    expect(brokerCommission(2777)).toBe(10); // 2777*0.0036 ≈ 9.9985 < 10
    expect(brokerCommission(3000)).toBeCloseTo(3000 * 0.0036, 6); // 10.8 > 10 → not floored
  });

  it('is tolerant of zero/negative/junk (returns 0)', () => {
    expect(brokerCommission(0)).toBe(0);
    expect(brokerCommission(-5)).toBe(0);
    expect(brokerCommission(NaN)).toBe(0);
    expect(brokerCommission(null)).toBe(0);
  });
});

describe('legCharges (SEBON 0.015% + DP Rs 25 + broker, each leg)', () => {
  it('sums broker + SEBON levy + DP on a leg', () => {
    const v = 100000;
    const c = legCharges({ value: v, side: 'BUY' });
    expect(SEBON_LEVY_PCT).toBe(0.015);
    expect(DP_FEE).toBe(25);
    expect(c.sebon).toBeCloseTo(v * 0.00015, 6); // 0.015% = 0.00015
    expect(c.dp).toBe(25);
    expect(c.broker).toBeCloseTo(v * 0.0033, 6);
    expect(c.total).toBeCloseTo(v * 0.0033 + v * 0.00015 + 25, 6);
  });

  it('charges DP Rs 25 on BOTH legs (buy and sell)', () => {
    expect(legCharges({ value: 50000, side: 'BUY' }).dp).toBe(25);
    expect(legCharges({ value: 50000, side: 'SELL' }).dp).toBe(25);
  });

  it('tolerates null/zero value (all zero)', () => {
    expect(legCharges({ value: 0, side: 'BUY' }).total).toBe(0);
    expect(legCharges({}).total).toBe(0);
    expect(legCharges().total).toBe(0);
  });
});

describe('netReturn (net-of-charges round trip)', () => {
  it('nets below gross for a winning long, with CGT 7.5% short-term', () => {
    const r = netReturn({ entry: 100, exit: 120, direction: 'BUY', holdDays: 30 });
    expect(r.cgtRate).toBe(0.075);
    expect(r.grossPct).toBeCloseTo(20, 6);
    expect(r.netPct).toBeLessThan(r.grossPct); // charges + CGT drag
    expect(r.cgt).toBeGreaterThan(0);
    expect(r.notional).toBe(NOTIONAL_PRINCIPAL);
  });

  it('uses CGT 5% for a long-term hold (>=365 days)', () => {
    const short = netReturn({ entry: 100, exit: 120, direction: 'BUY', holdDays: 100 });
    const long = netReturn({ entry: 100, exit: 120, direction: 'BUY', holdDays: 400 });
    expect(short.cgtRate).toBe(0.075);
    expect(long.cgtRate).toBe(0.05);
    // Lower CGT rate → less tax → a better net on the same gross.
    expect(long.cgt).toBeLessThan(short.cgt);
    expect(long.netPct).toBeGreaterThan(short.netPct);
  });

  it('charges NO CGT on a losing (or flat) trade — tax on positive gain only', () => {
    const loss = netReturn({ entry: 100, exit: 80, direction: 'BUY', holdDays: 30 });
    expect(loss.grossPct).toBeCloseTo(-20, 6);
    expect(loss.cgt).toBe(0);
    expect(loss.netPct).toBeLessThan(loss.grossPct); // still dragged by broker/SEBON/DP
    // A trade whose gross gain is fully eaten by charges pays no CGT either.
    const thin = netReturn({ entry: 100, exit: 100.1, direction: 'BUY', holdDays: 30 });
    expect(thin.cgt).toBe(0);
  });

  it('is symmetric for a winning SELL (short: profit when exit < entry)', () => {
    const r = netReturn({ entry: 120, exit: 100, direction: 'SELL', holdDays: 30 });
    expect(r.grossPct).toBeCloseTo(((120 - 100) / 120) * 100, 6);
    // Charges + CGT drag the net PROFIT below the gross profit (the architect's
    // netProfit/buyCostGross denominator is the exit cost-leg for a short, so netPct
    // itself is not strictly < grossPct — the profit-level drag is the invariant).
    expect(r.netProfit).toBeLessThan(r.grossProfit);
    expect(r.cgt).toBeGreaterThan(0);
  });

  it('tolerates null/zero inputs (well-formed zero result)', () => {
    const r = netReturn({ entry: 0, exit: 100, direction: 'BUY', holdDays: 30 });
    expect(r.grossPct).toBe(0);
    expect(r.netPct).toBe(0);
    expect(r.cgt).toBe(0);
    expect(netReturn({}).netPct).toBe(0);
  });
});

describe('positionPnl (real-qty position P&L, net of charges)', () => {
  // Reference position: 100 shares @ Rs 100, marked/sold @ Rs 120.
  //   costBasis = 10000; buyCharges = broker(36) + sebon(1.5) + dp(25) = 62.5
  //   grossValue = 12000; sellCharges = broker(43.2) + sebon(1.8) + dp(25) = 70
  //   netPnlPreTax = (12000-70) - (10000+62.5) = 1867.5
  const base = { qty: 100, buyPrice: 100, currentOrSellPrice: 120 };

  it('realized short-term round-trip charges CGT at 7.5% (< 365 days)', () => {
    const r = positionPnl({ ...base, holdDays: 30, realized: true });
    expect(r.costBasis).toBeCloseTo(10000, 6);
    expect(r.buyCharges).toBeCloseTo(62.5, 6);
    expect(r.grossValue).toBeCloseTo(12000, 6);
    expect(r.sellCharges).toBeCloseTo(70, 6);
    expect(r.cgtRate).toBe(0.075);
    expect(r.netPnlPreTax).toBeCloseTo(1867.5, 6);
    expect(r.cgt).toBeCloseTo(1867.5 * 0.075, 6);
    expect(r.netPnl).toBeCloseTo(1867.5 - 1867.5 * 0.075, 6); // net of charges AND CGT
  });

  it('realized long-term round-trip charges CGT at 5% (>= 365 days)', () => {
    const r = positionPnl({ ...base, holdDays: 400, realized: true });
    expect(r.cgtRate).toBe(0.05);
    expect(r.cgt).toBeCloseTo(1867.5 * 0.05, 6);
    expect(r.netPnl).toBeCloseTo(1867.5 - 1867.5 * 0.05, 6);
  });

  it('applies the 365-day CGT boundary on BOTH sides (364 short, 365 long)', () => {
    expect(positionPnl({ ...base, holdDays: 364, realized: true }).cgtRate).toBe(0.075);
    expect(positionPnl({ ...base, holdDays: 365, realized: true }).cgtRate).toBe(0.05);
  });

  it('unrealized headline is pre-tax (charges only); after-CGT is a separate field', () => {
    const r = positionPnl({ ...base, holdDays: 30, realized: false });
    // Headline nets charges only — no CGT baked into netPnl.
    expect(r.netPnl).toBeCloseTo(1867.5, 6);
    expect(r.netPnl).toBeCloseTo(r.netPnlPreTax, 6);
    // The "if sold today" tax rides along separately so the caller derives after-tax.
    expect(r.cgt).toBeCloseTo(1867.5 * 0.075, 6);
    const afterTax = r.netPnl - r.cgt;
    expect(afterTax).toBeCloseTo(1867.5 - 1867.5 * 0.075, 6);
    expect(afterTax).toBeLessThan(r.netPnl);
  });

  it('enforces the Rs 10 broker floor + DP Rs 25/leg on a tiny-value leg', () => {
    // 1 share @ Rs 1000 → leg value 1000; broker = max(1000*0.36%, 10) = 10 (floored);
    // sebon = 1000*0.015% = 0.15; dp = 25 → buyCharges = 35.15.
    const r = positionPnl({ qty: 1, buyPrice: 1000, currentOrSellPrice: 1000, holdDays: 10, realized: true });
    expect(r.buyCharges).toBeCloseTo(10 + 0.15 + DP_FEE, 6);
    expect(r.sellCharges).toBeCloseTo(10 + 0.15 + DP_FEE, 6);
    // Flat trade → the only P&L is the two legs' charges (incl. Rs 25 DP each way).
    expect(r.netPnlPreTax).toBeCloseTo(-(r.buyCharges + r.sellCharges), 6);
    expect(r.cgt).toBe(0); // no positive gain → no CGT
  });

  it('no positive gain → no CGT even when realized', () => {
    const loss = positionPnl({ qty: 100, buyPrice: 100, currentOrSellPrice: 80, holdDays: 30, realized: true });
    expect(loss.netPnlPreTax).toBeLessThan(0);
    expect(loss.cgt).toBe(0);
    expect(loss.netPnl).toBeCloseTo(loss.netPnlPreTax, 6);
  });

  it('no usable current/sell price → cost basis + buy charges only (no phantom loss)', () => {
    const r = positionPnl({ qty: 100, buyPrice: 100, currentOrSellPrice: null, holdDays: 30 });
    expect(r.costBasis).toBeCloseTo(10000, 6);
    expect(r.buyCharges).toBeCloseTo(62.5, 6);
    expect(r.grossValue).toBe(0);
    expect(r.sellCharges).toBe(0);
    expect(r.netPnl).toBe(0);
    expect(r.netPnlPreTax).toBe(0);
  });

  it('degenerate inputs (no qty / no buy price / junk) → well-formed zeros', () => {
    for (const bad of [{ qty: 0, buyPrice: 100, currentOrSellPrice: 120 }, { qty: 100, buyPrice: 0, currentOrSellPrice: 120 }, {}]) {
      const r = positionPnl(bad);
      expect(r.costBasis).toBe(0);
      expect(r.buyCharges).toBe(0);
      expect(r.netPnl).toBe(0);
      expect(r.netPnlPreTax).toBe(0);
      expect(r.returnPct).toBe(0);
    }
    expect(positionPnl().netPnl).toBe(0);
  });
});

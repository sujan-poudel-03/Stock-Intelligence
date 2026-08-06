import { describe, it, expect } from 'vitest';
import {
  brokerCommission,
  legCharges,
  netReturn,
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

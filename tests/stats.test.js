import { describe, it, expect } from 'vitest';
import {
  wilsonLowerBound,
  betaMean,
  thompsonSample,
  sharpe,
  riskAdjustedReturn,
  decayFactor,
  ewmaUpdate,
  decayedCounts,
} from '../src/lib/stats.js';

describe('wilsonLowerBound (small-sample discounting)', () => {
  it('is 0 with no samples', () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
  });

  it('discounts the same win rate more when the sample is smaller', () => {
    // 80% over 10 trades vs 80% over 100 trades — the larger sample earns a higher
    // (less discounted) lower bound. This is the whole point.
    expect(wilsonLowerBound(8, 10)).toBeLessThan(wilsonLowerBound(80, 100));
  });

  it('keeps a large, strong sample close to its raw rate', () => {
    const lb = wilsonLowerBound(80, 100);
    expect(lb).toBeGreaterThan(0.68);
    expect(lb).toBeLessThan(0.8);
  });
});

describe('betaMean', () => {
  it('reads a fresh slice as 50% under a uniform prior', () => {
    expect(betaMean(0, 0)).toBe(0.5);
  });
  it('moves toward the data as evidence accrues', () => {
    expect(betaMean(9, 1)).toBeGreaterThan(0.7);
  });
});

describe('thompsonSample (deterministic under injected normal)', () => {
  it('returns the posterior mean when the normal draw is 0', () => {
    expect(thompsonSample(3, 1, { normal: () => 0 })).toBeCloseTo(betaMean(3, 1), 10);
  });
  it('clamps to [0,1] for extreme draws', () => {
    expect(thompsonSample(3, 1, { normal: () => 50 })).toBe(1);
    expect(thompsonSample(3, 1, { normal: () => -50 })).toBe(0);
  });
});

describe('risk-adjusted reward', () => {
  it('sharpe is 0 for a flat return series', () => {
    expect(sharpe([2, 2, 2])).toBe(0);
  });
  it('sharpe is positive for a profitable, low-variance series', () => {
    expect(sharpe([3, 1, 2])).toBeGreaterThan(0);
  });
  it('riskAdjustedReturn rewards pure upside fully', () => {
    expect(riskAdjustedReturn([5, 5, 5])).toBe(5);
  });
  it('riskAdjustedReturn penalizes downside', () => {
    // mean 0, downside deviation 10 -> 0 - 1*10
    expect(riskAdjustedReturn([10, -10])).toBe(-10);
  });
});

describe('time-decay helpers', () => {
  it('halves weight after one half-life', () => {
    expect(decayFactor(1000, 1000)).toBeCloseTo(0.5, 10);
  });
  it('does not decay when no half-life is set', () => {
    expect(decayFactor(9999, 0)).toBe(1);
  });
  it('ewmaUpdate decays the prior and adds the new value', () => {
    expect(ewmaUpdate(4, 1, 0.5)).toBe(3);
  });

  it('decayedCounts ages prior counts by the half-life then adds the outcome', () => {
    // one half-life old: prior halves, then a WIN adds 1 win
    expect(decayedCounts({ dwins: 2, dlosses: 1 }, true, 1000, 1000)).toEqual({ dwins: 2, dlosses: 0.5 });
  });

  it('decayedCounts seeds cleanly from empty history', () => {
    expect(decayedCounts({}, false, 0, 1000)).toEqual({ dwins: 0, dlosses: 1 });
  });
});

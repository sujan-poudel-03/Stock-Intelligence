import { describe, it, expect } from 'vitest';
import { suggestedQuantity } from '../src/lib/positionSizing.js';

describe('suggestedQuantity', () => {
  it('sizes to the risk budget: risk 1% of Rs 100,000 with Rs 10 per-share risk -> 100 shares', () => {
    const r = suggestedQuantity({ capital: 100000, riskPct: 1, entry: 560, stopLoss: 550 });
    expect(r).not.toBeNull();
    expect(r.qty).toBe(100); // 1000 riskAmount / 10 perShareRisk
    expect(r.riskAmount).toBeCloseTo(1000);
    expect(r.perShareRisk).toBeCloseTo(10);
    expect(r.positionValue).toBeCloseTo(56000);
  });

  it('floors a fractional share count', () => {
    const r = suggestedQuantity({ capital: 50000, riskPct: 2, entry: 300, stopLoss: 285 });
    // riskAmount 1000, perShareRisk 15 -> 66.67 -> floors to 66
    expect(r.qty).toBe(66);
  });

  it('returns null when stop-loss is not below entry (invalid for a long)', () => {
    expect(suggestedQuantity({ capital: 100000, riskPct: 1, entry: 500, stopLoss: 500 })).toBeNull();
    expect(suggestedQuantity({ capital: 100000, riskPct: 1, entry: 500, stopLoss: 520 })).toBeNull();
  });

  it('returns null for non-positive or missing capital/risk/entry/stopLoss', () => {
    expect(suggestedQuantity({ capital: 0, riskPct: 1, entry: 500, stopLoss: 490 })).toBeNull();
    expect(suggestedQuantity({ capital: 100000, riskPct: 0, entry: 500, stopLoss: 490 })).toBeNull();
    expect(suggestedQuantity({ capital: 100000, riskPct: 1, entry: null, stopLoss: 490 })).toBeNull();
    expect(suggestedQuantity({})).toBeNull();
  });

  it('returns null when the risk budget cannot afford even one share', () => {
    // riskAmount = 10, perShareRisk = 50 -> qty 0
    const r = suggestedQuantity({ capital: 1000, riskPct: 1, entry: 550, stopLoss: 500 });
    expect(r).toBeNull();
  });
});

import { describe, it, expect } from 'vitest';
import { deterministicSignal } from '../src/lib/scan.js';

// deterministicSignal is the no-LLM fallback used when the daily budget is spent.
// It carries the money-critical target math (5% stop / 8% target / ±1% entry) and
// must NEVER emit a signal without a real price.
describe('deterministicSignal', () => {
  it('returns null without a usable price', () => {
    expect(deterministicSignal({})).toBeNull();
    expect(deterministicSignal({ price: 0 })).toBeNull();
    expect(deterministicSignal({ price: -5 })).toBeNull();
  });

  it('applies the 5% stop / 8% target / ±1% entry rule from price', () => {
    const s = deterministicSignal({ symbol: 'NABIL', price: 100 });
    expect(s.sl).toBe(95); // round(100 * 0.95)
    expect(s.target).toBe(108); // round(100 * 1.08)
    expect(s.entry).toBe('Rs 99-Rs 101');
    expect(s.confidence).toBe('LOW');
    expect(s.source).toBe('deterministic');
    expect(s.live_data.targets_calculated).toBe(true);
  });

  it('classifies HOLD when no 120-day average is available', () => {
    expect(deterministicSignal({ symbol: 'X', price: 100 }).signal).toBe('HOLD');
  });

  it('classifies WATCH when price is >2% above the 120-day average', () => {
    expect(deterministicSignal({ symbol: 'X', price: 110, avg120: 100 }).signal).toBe('WATCH');
  });

  it('classifies NEUTRAL when price is >2% below the 120-day average', () => {
    expect(deterministicSignal({ symbol: 'X', price: 90, avg120: 100 }).signal).toBe('NEUTRAL');
  });
});

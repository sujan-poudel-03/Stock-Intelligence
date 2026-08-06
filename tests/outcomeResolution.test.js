import { describe, it, expect } from 'vitest';
import {
  parseHoldDays,
  effectiveMaxHoldDays,
  resolveFirstTouch,
  DEFAULT_MAX_HOLD_DAYS,
  MIN_HOLD_DAYS,
  HARD_CEILING_DAYS,
} from '../src/lib/outcomeResolution.js';

describe('resolveFirstTouch (path-dependent, conservative tie-break)', () => {
  // BUY: target above entry, stop below.
  it('BUY: only target inside the bar → WIN at target', () => {
    const r = resolveFirstTouch({ direction: 'BUY', target: 120, sl: 90, high: 125, low: 105 });
    expect(r).toEqual({ outcome: 'WIN', exitReason: 'TARGET', exitPrice: 120 });
  });

  it('BUY: only stop inside the bar → LOSS at stop', () => {
    const r = resolveFirstTouch({ direction: 'BUY', target: 120, sl: 90, high: 110, low: 85 });
    expect(r).toEqual({ outcome: 'LOSS', exitReason: 'STOP', exitPrice: 90 });
  });

  it('BUY: BOTH inside one bar → LOSS (stop-first tie-break)', () => {
    const r = resolveFirstTouch({ direction: 'BUY', target: 120, sl: 90, high: 125, low: 85 });
    expect(r).toEqual({ outcome: 'LOSS', exitReason: 'STOP', exitPrice: 90 });
  });

  it('BUY: neither touched → null', () => {
    const r = resolveFirstTouch({ direction: 'BUY', target: 120, sl: 90, high: 115, low: 95 });
    expect(r).toEqual({ outcome: null, exitReason: null, exitPrice: null });
  });

  // SELL (short): target below entry, stop above.
  it('SELL: only target inside the bar → WIN at target', () => {
    const r = resolveFirstTouch({ direction: 'SELL', target: 90, sl: 120, high: 110, low: 85 });
    expect(r).toEqual({ outcome: 'WIN', exitReason: 'TARGET', exitPrice: 90 });
  });

  it('SELL: only stop inside the bar → LOSS at stop', () => {
    const r = resolveFirstTouch({ direction: 'SELL', target: 90, sl: 120, high: 125, low: 95 });
    expect(r).toEqual({ outcome: 'LOSS', exitReason: 'STOP', exitPrice: 120 });
  });

  it('SELL: BOTH inside one bar → LOSS (stop-first tie-break)', () => {
    const r = resolveFirstTouch({ direction: 'SELL', target: 90, sl: 120, high: 125, low: 85 });
    expect(r).toEqual({ outcome: 'LOSS', exitReason: 'STOP', exitPrice: 120 });
  });

  it('SELL: neither touched → null', () => {
    const r = resolveFirstTouch({ direction: 'SELL', target: 90, sl: 120, high: 115, low: 95 });
    expect(r).toEqual({ outcome: null, exitReason: null, exitPrice: null });
  });

  it('null/absent levels are "not touched", never throws', () => {
    expect(resolveFirstTouch({ direction: 'BUY', target: null, sl: null, high: 100, low: 90 })).toEqual({
      outcome: null,
      exitReason: null,
      exitPrice: null,
    });
    expect(resolveFirstTouch()).toEqual({ outcome: null, exitReason: null, exitPrice: null });
  });
});

describe('parseHoldDays', () => {
  it('takes the UPPER bound of a range', () => {
    expect(parseHoldDays('5-10 days')).toBe(10);
    expect(parseHoldDays('1-2 weeks')).toBe(14);
    expect(parseHoldDays('1-2 months')).toBe(60);
  });

  it('handles a single value + unit', () => {
    expect(parseHoldDays('3 weeks')).toBe(21);
    expect(parseHoldDays('1 month')).toBe(30);
    expect(parseHoldDays('7 days')).toBe(7);
  });

  it('treats a bare number as days', () => {
    expect(parseHoldDays('10')).toBe(10);
  });

  it('returns null on unparseable / empty input', () => {
    expect(parseHoldDays('soon')).toBeNull();
    expect(parseHoldDays('')).toBeNull();
    expect(parseHoldDays(null)).toBeNull();
    expect(parseHoldDays(undefined)).toBeNull();
  });
});

describe('effectiveMaxHoldDays (clamp)', () => {
  it('clamps below MIN and above HARD_CEILING', () => {
    expect(effectiveMaxHoldDays('1 day')).toBe(MIN_HOLD_DAYS); // 1 < 5
    expect(effectiveMaxHoldDays('6 months')).toBe(HARD_CEILING_DAYS); // 180 > 60
  });

  it('passes an in-range parsed horizon through', () => {
    expect(effectiveMaxHoldDays('3 weeks')).toBe(21);
  });

  it('defaults when hold is unparseable', () => {
    expect(effectiveMaxHoldDays('whenever')).toBe(DEFAULT_MAX_HOLD_DAYS);
    expect(effectiveMaxHoldDays(null)).toBe(DEFAULT_MAX_HOLD_DAYS);
    expect(DEFAULT_MAX_HOLD_DAYS).toBe(42);
  });
});

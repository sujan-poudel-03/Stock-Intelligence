import { describe, it, expect } from 'vitest';
import {
  MIN_TURNOVER_NPR,
  resolveMinTurnover,
  turnoverOf,
  illiquidityOf,
  filterLiquidSymbols,
} from '../src/lib/liquidity.js';

// TIER-2 liquidity primitives — the hard filter that keeps a signal off a NEPSE script
// so thin a retail order can't cleanly enter/exit. Metric = ground-truth Rupee turnover
// (price×volume only as a fallback). Pure + fail-OPEN on unknown.

describe('resolveMinTurnover', () => {
  it('defaults to MIN_TURNOVER_NPR (Rs20 lakh) when unset', () => {
    expect(resolveMinTurnover()).toBe(MIN_TURNOVER_NPR);
    expect(resolveMinTurnover({})).toBe(2_000_000);
  });

  it('honors a finite positive admin override (min_turnover / liquidity_min_turnover)', () => {
    expect(resolveMinTurnover({ min_turnover: 5_000_000 })).toBe(5_000_000);
    expect(resolveMinTurnover({ liquidity_min_turnover: 1_000_000 })).toBe(1_000_000);
  });

  it('ignores junk / non-positive overrides and falls back to the default', () => {
    expect(resolveMinTurnover({ min_turnover: 0 })).toBe(MIN_TURNOVER_NPR);
    expect(resolveMinTurnover({ min_turnover: -1 })).toBe(MIN_TURNOVER_NPR);
    expect(resolveMinTurnover({ min_turnover: 'abc' })).toBe(MIN_TURNOVER_NPR);
    expect(resolveMinTurnover({ min_turnover: null })).toBe(MIN_TURNOVER_NPR);
  });
});

describe('turnoverOf', () => {
  it('prefers the scraped turnover over price×volume', () => {
    // turnover present → used verbatim, even though price×volume would be different.
    expect(turnoverOf({ turnover: 42_000_000, price: 500, volume: 1000 })).toBe(42_000_000);
  });

  it('falls back to price×volume when turnover is absent', () => {
    expect(turnoverOf({ price: 500, volume: 1000 })).toBe(500_000);
  });

  it('is null when neither turnover nor a usable price×volume is present', () => {
    expect(turnoverOf({ price: 500 })).toBeNull(); // no volume
    expect(turnoverOf({ volume: 1000 })).toBeNull(); // no price
    expect(turnoverOf({ turnover: 0, price: 0, volume: 0 })).toBeNull();
    expect(turnoverOf({})).toBeNull();
    expect(turnoverOf(null)).toBeNull();
  });
});

describe('illiquidityOf', () => {
  it('flags illiquid=true when known turnover is below the threshold', () => {
    expect(illiquidityOf({ turnover: 500_000 })).toEqual({ turnover: 500_000, illiquid: true });
  });

  it('flags illiquid=false when known turnover meets/exceeds the threshold', () => {
    expect(illiquidityOf({ turnover: 42_000_000 })).toEqual({ turnover: 42_000_000, illiquid: false });
    // Exactly at the threshold is NOT illiquid (strict less-than).
    expect(illiquidityOf({ turnover: MIN_TURNOVER_NPR })).toEqual({ turnover: MIN_TURNOVER_NPR, illiquid: false });
  });

  it('returns illiquid=null (unknown) when turnover cannot be determined', () => {
    expect(illiquidityOf({ price: 500 })).toEqual({ turnover: null, illiquid: null });
    expect(illiquidityOf({})).toEqual({ turnover: null, illiquid: null });
  });

  it('respects a custom threshold', () => {
    expect(illiquidityOf({ turnover: 3_000_000 }, 5_000_000).illiquid).toBe(true);
    expect(illiquidityOf({ turnover: 3_000_000 }, 1_000_000).illiquid).toBe(false);
  });
});

describe('filterLiquidSymbols', () => {
  const board = {
    NABIL: { turnover: 42_000_000 }, // liquid
    THIN: { turnover: 500_000 }, // known-thin → dropped
    MICRO: { price: 50, volume: 100 }, // price×volume = 5,000 → thin → dropped
    // UNKNOWN is deliberately absent from the board.
  };

  it('drops ONLY known-thin symbols, keeping liquid ones', () => {
    expect(filterLiquidSymbols(['NABIL', 'THIN'], board)).toEqual(['NABIL']);
    expect(filterLiquidSymbols(['NABIL', 'MICRO'], board)).toEqual(['NABIL']);
  });

  it('keeps UNKNOWN symbols — fail open (missing from the board)', () => {
    expect(filterLiquidSymbols(['NABIL', 'UNKNOWN', 'THIN'], board)).toEqual(['NABIL', 'UNKNOWN']);
  });

  it('fails open on an empty/missing board — drops nothing', () => {
    expect(filterLiquidSymbols(['NABIL', 'THIN'], {})).toEqual(['NABIL', 'THIN']);
    expect(filterLiquidSymbols(['NABIL', 'THIN'])).toEqual(['NABIL', 'THIN']);
  });

  it('honors a custom threshold', () => {
    // At a Rs50M floor, NABIL (42M) is now thin too.
    expect(filterLiquidSymbols(['NABIL', 'THIN'], board, 50_000_000)).toEqual([]);
  });

  it('returns [] on non-array input, never throws', () => {
    expect(filterLiquidSymbols(null, board)).toEqual([]);
    expect(filterLiquidSymbols(undefined)).toEqual([]);
  });
});

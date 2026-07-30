import { describe, it, expect } from 'vitest';
import {
  DEFAULT_EXCHANGE,
  EXCHANGES,
  getExchange,
  normalizeExchange,
  currencySymbolFor,
  scopeKey,
} from '../src/lib/exchanges.js';

// The exchange registry is the single source of truth for the multi-exchange
// dimension. These guard the two invariants the whole feature relies on:
//   1. Unknown/null resolves to NEPSE (pre-migration rows read as NEPSE).
//   2. scopeKey leaves NEPSE keys UNPREFIXED (existing weights/knowledge untouched)
//      and prefixes every other exchange (isolated learning, no schema churn).

describe('getExchange', () => {
  it('resolves a known exchange (case-insensitive)', () => {
    expect(getExchange('NYSE').id).toBe('NYSE');
    expect(getExchange('nyse').id).toBe('NYSE');
    expect(getExchange('NEPSE').id).toBe('NEPSE');
  });

  it('defaults unknown/null/undefined to NEPSE', () => {
    expect(getExchange(null).id).toBe('NEPSE');
    expect(getExchange(undefined).id).toBe('NEPSE');
    expect(getExchange('BOGUS').id).toBe('NEPSE');
    expect(getExchange('').id).toBe('NEPSE');
    expect(DEFAULT_EXCHANGE).toBe('NEPSE');
  });

  it('returns the full config object for a known exchange', () => {
    expect(getExchange('NYSE')).toBe(EXCHANGES.NYSE);
  });
});

describe('normalizeExchange', () => {
  it('coerces any input to a known exchange id', () => {
    expect(normalizeExchange('nyse')).toBe('NYSE');
    expect(normalizeExchange('NEPSE')).toBe('NEPSE');
    expect(normalizeExchange(null)).toBe('NEPSE');
    expect(normalizeExchange('nonsense')).toBe('NEPSE');
  });
});

describe('currencySymbolFor', () => {
  it('returns the money prefix per exchange', () => {
    expect(currencySymbolFor('NEPSE')).toBe('Rs');
    expect(currencySymbolFor('NYSE')).toBe('$');
    expect(currencySymbolFor(null)).toBe('Rs'); // default NEPSE
  });
});

describe('scopeKey', () => {
  it('leaves NEPSE keys UNPREFIXED (backward-compat with existing rows)', () => {
    expect(scopeKey('NEPSE', 'BUY_banks')).toBe('BUY_banks');
    expect(scopeKey('nepse', 'ALL')).toBe('ALL');
    expect(scopeKey(null, 'SYMBOL_NABIL')).toBe('SYMBOL_NABIL');
    expect(scopeKey(undefined, 'ALL')).toBe('ALL');
  });

  it('prefixes non-default exchanges with `${EXCHANGE}:`', () => {
    expect(scopeKey('NYSE', 'BUY_banks')).toBe('NYSE:BUY_banks');
    expect(scopeKey('nyse', 'ALL')).toBe('NYSE:ALL');
    expect(scopeKey('NYSE', 'SYMBOL_AAPL')).toBe('NYSE:SYMBOL_AAPL');
  });

  it('the empty-string key yields a bare prefix (used to build filter regexes)', () => {
    expect(scopeKey('NEPSE', '')).toBe('');
    expect(scopeKey('NYSE', '')).toBe('NYSE:');
  });

  it('passes null/undefined keys through untouched', () => {
    expect(scopeKey('NYSE', null)).toBe(null);
    expect(scopeKey('NYSE', undefined)).toBe(undefined);
  });
});

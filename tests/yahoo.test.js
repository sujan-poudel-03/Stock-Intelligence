import { describe, it, expect } from 'vitest';
import { normalizeYahooQuote } from '../src/lib/yahoo.js';

// normalizeYahooQuote maps a fetchYahooStock() result into the verified-price core's
// raw-quote shape { symbol, price, prevClose, asOf, source }. It MUST fail closed
// (return null) on anything without a usable positive price — a hallucinated or
// missing number can never become a quote (CLAUDE.md guardrail #1).

describe('normalizeYahooQuote (fail-closed)', () => {
  it('normalizes a valid Yahoo quote to the core shape', () => {
    const q = normalizeYahooQuote(
      { symbol: 'aapl', price: 231.5, previousClose: 228.0, currency: 'USD' },
      'AAPL'
    );
    expect(q).toMatchObject({
      symbol: 'AAPL',
      price: 231.5,
      prevClose: 228.0,
      source: 'yahoo',
    });
    expect(typeof q.asOf).toBe('number');
    expect(q.asOf).toBeGreaterThan(0);
  });

  it('falls back to the passed symbol when the stock omits one', () => {
    const q = normalizeYahooQuote({ price: 10 }, 'msft');
    expect(q.symbol).toBe('MSFT');
    expect(q.prevClose).toBe(null); // no previousClose → null, not NaN
  });

  it('returns null for a null/undefined stock', () => {
    expect(normalizeYahooQuote(null, 'AAPL')).toBe(null);
    expect(normalizeYahooQuote(undefined, 'AAPL')).toBe(null);
  });

  it('returns null for junk / missing / non-positive / NaN prices', () => {
    expect(normalizeYahooQuote({ price: 0 }, 'AAPL')).toBe(null); // zero
    expect(normalizeYahooQuote({ price: -5 }, 'AAPL')).toBe(null); // negative
    expect(normalizeYahooQuote({ price: NaN }, 'AAPL')).toBe(null); // NaN
    expect(normalizeYahooQuote({ price: 'abc' }, 'AAPL')).toBe(null); // junk string
    expect(normalizeYahooQuote({ price: null }, 'AAPL')).toBe(null); // missing price
    expect(normalizeYahooQuote({}, 'AAPL')).toBe(null); // no price field (meta-less)
  });
});

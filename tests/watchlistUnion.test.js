import { describe, it, expect } from 'vitest';
import { unionWatchlistSymbols } from '../src/lib/watchlistUnion.js';

describe('unionWatchlistSymbols', () => {
  it('dedupes the same symbol watched by many users (scanned once)', () => {
    const rows = [
      { symbol: 'NABIL' }, // user A
      { symbol: 'NABIL' }, // user B
      { symbol: 'GBIME' }, // user A
      { symbol: 'nabil' }, // user C, lowercase
    ];
    expect(unionWatchlistSymbols(rows)).toEqual(['NABIL', 'GBIME']);
  });

  it('uppercases and trims', () => {
    expect(unionWatchlistSymbols([{ symbol: '  chcl ' }, { symbol: 'sanima' }])).toEqual(['CHCL', 'SANIMA']);
  });

  it('accepts bare strings as well as row objects', () => {
    expect(unionWatchlistSymbols(['NABIL', { symbol: 'GBIME' }])).toEqual(['NABIL', 'GBIME']);
  });

  it('ignores blanks / nullish / missing symbol', () => {
    expect(unionWatchlistSymbols([{ symbol: '' }, {}, null, { symbol: null }, 'NABIL', ''])).toEqual(['NABIL']);
  });

  it('empty table -> empty universe (scan falls back to discovery only)', () => {
    expect(unionWatchlistSymbols([])).toEqual([]);
  });

  it('non-array input -> empty (fail-safe)', () => {
    expect(unionWatchlistSymbols(null)).toEqual([]);
    expect(unionWatchlistSymbols(undefined)).toEqual([]);
    expect(unionWatchlistSymbols({})).toEqual([]);
  });
});

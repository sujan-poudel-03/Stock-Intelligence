import { describe, it, expect } from 'vitest';
import { buildScanUniverse, selectPromotions } from '../src/lib/systemWatchlist.js';

describe('buildScanUniverse', () => {
  it('folds user + system rows into one deduped, uppercased union', () => {
    const out = buildScanUniverse({
      userRows: [{ symbol: 'nabil' }, { symbol: 'HBL' }],
      systemRows: [{ symbol: 'hbl' }, { symbol: 'CHCL' }],
    });
    expect(out).toEqual(['NABIL', 'HBL', 'CHCL']);
  });

  it('keeps user rows first, then system rows (stable order)', () => {
    const out = buildScanUniverse({
      userRows: ['sana', 'upper'],
      systemRows: ['nabil', 'upper'],
    });
    expect(out).toEqual(['SANA', 'UPPER', 'NABIL']);
  });

  it('accepts bare strings and row objects interchangeably', () => {
    const out = buildScanUniverse({
      userRows: ['nabil', { symbol: 'hbl' }],
      systemRows: [{ symbol: 'ebl' }, 'scb'],
    });
    expect(out).toEqual(['NABIL', 'HBL', 'EBL', 'SCB']);
  });

  it('drops blanks / trims whitespace', () => {
    const out = buildScanUniverse({
      userRows: ['', { symbol: '  nabil  ' }, { symbol: null }],
      systemRows: [{ symbol: undefined }, 'hbl'],
    });
    expect(out).toEqual(['NABIL', 'HBL']);
  });

  it('handles empty / missing inputs without throwing', () => {
    expect(buildScanUniverse()).toEqual([]);
    expect(buildScanUniverse({})).toEqual([]);
    expect(buildScanUniverse({ userRows: [], systemRows: [] })).toEqual([]);
    expect(buildScanUniverse({ userRows: null, systemRows: 'nope' })).toEqual([]);
  });
});

describe('selectPromotions', () => {
  it('returns symbols meeting the threshold, uppercased', () => {
    const out = selectPromotions({ nabil: 2, hbl: 1, chcl: 3 }, { minAppearances: 2 });
    expect(out.sort()).toEqual(['CHCL', 'NABIL']);
  });

  it('applies the threshold at the exact boundary (>=)', () => {
    expect(selectPromotions({ x: 2 }, { minAppearances: 2 })).toEqual(['X']);
    expect(selectPromotions({ x: 1 }, { minAppearances: 2 })).toEqual([]);
  });

  it('defaults the threshold to 1 when missing/invalid', () => {
    expect(selectPromotions({ x: 1 }).sort()).toEqual(['X']);
    expect(selectPromotions({ x: 1 }, { minAppearances: 0 })).toEqual(['X']);
    expect(selectPromotions({ x: 1 }, { minAppearances: -5 })).toEqual(['X']);
  });

  it('rejects blanks and non-finite counts', () => {
    const out = selectPromotions(
      { '': 5, nabil: 'nope', hbl: 3, '  ': 9 },
      { minAppearances: 2 }
    );
    expect(out).toEqual(['HBL']);
  });

  it('handles empty / bad inputs without throwing', () => {
    expect(selectPromotions()).toEqual([]);
    expect(selectPromotions(null, { minAppearances: 2 })).toEqual([]);
    expect(selectPromotions('nope', { minAppearances: 2 })).toEqual([]);
    expect(selectPromotions({}, { minAppearances: 2 })).toEqual([]);
  });
});

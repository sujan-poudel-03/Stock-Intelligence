import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseSharesansarToday } from '../src/lib/sharesansarToday.js';
import { reconcile } from '../src/lib/marketData.js';

// A trimmed but REAL ShareSansar "Today's Share Price" board (thead + a handful of
// real rows), saved 2026-08 (tests/fixtures/). The parser is the deterministic path
// for the SECOND live NEPSE source — see sharesansarToday.js / marketProviders.
const fx = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const BOARD = fx('sharesansar-today-share-price.html');

const NOW = Date.UTC(2026, 7, 5, 10, 0, 0);

describe('parseSharesansarToday', () => {
  it('parses LTP + prev close + day range for every row, keyed by symbol', () => {
    const t = parseSharesansarToday(BOARD);
    // LTP is the price we serve; Prev. Close + the day High/Low ride along (the range
    // feeds path-dependent outcome resolution — TIER-1 #3).
    expect(t.NABIL).toEqual({ price: 557.0, prevClose: 558.0, high: 563.0, low: 530.1 });
    expect(t.NICA).toEqual({ price: 329.1, prevClose: 330.0, high: 346.5, low: 313.5 });
    expect(t.HBL).toEqual({ price: 197.3, prevClose: 200.0, high: 200.0, low: 196.5 });
    expect(t.ADBL).toEqual({ price: 320.0, prevClose: 323.0, high: 325.0, low: 319.1 });
    expect(t.UPPER).toEqual({ price: 195.0, prevClose: 194.1, high: 195.5, low: 192.3 });
  });

  it('reads the DAILY High/Low, not the 52-week High/Low columns', () => {
    // The board carries both; the daily range must bracket the LTP, the yearly one won't.
    const t = parseSharesansarToday(BOARD);
    expect(t.NABIL.high).toBe(563.0);
    expect(t.NABIL.low).toBe(530.1);
    expect(t.NABIL.low).toBeLessThanOrEqual(t.NABIL.price);
    expect(t.NABIL.high).toBeGreaterThanOrEqual(t.NABIL.price);
  });

  it('maps columns by HEADER name, not a fixed index (survives a column shift)', () => {
    // Insert a new leading column in both header + body: the price must still resolve
    // via the "LTP"/"Symbol" header lookup rather than a hard-coded offset.
    const shifted = BOARD
      .replace('<th width="10px">S.No</th>', '<th>New</th><th width="10px">S.No</th>')
      .replace(/<td class="danger-index">167<\/td>/, '<td>x</td><td class="danger-index">167</td>');
    const t = parseSharesansarToday(shifted);
    expect(t.NABIL).toEqual({ price: 557.0, prevClose: 558.0, high: 563.0, low: 530.1 });
  });

  it('yields null high/low when the range columns are absent', () => {
    const t = parseSharesansarToday(
      '<thead><tr><th>Symbol</th><th>LTP</th><th>Prev. Close</th></tr></thead>' +
        '<tbody><tr><td>NORANGE</td><td>100.50</td><td>99.00</td></tr></tbody>'
    );
    expect(t.NORANGE).toEqual({ price: 100.5, prevClose: 99.0, high: null, low: null });
  });

  it('drops BOTH range extremes when the pair is inconsistent (high < low)', () => {
    const t = parseSharesansarToday(
      '<thead><tr><th>Symbol</th><th>High</th><th>Low</th><th>LTP</th></tr></thead>' +
        '<tbody><tr><td>BADR</td><td>90</td><td>110</td><td>100</td></tr></tbody>'
    );
    expect(t.BADR).toEqual({ price: 100, prevClose: null, high: null, low: null });
  });

  it('returns {} on junk, never throws', () => {
    expect(parseSharesansarToday(null)).toEqual({});
    expect(parseSharesansarToday(undefined)).toEqual({});
    expect(parseSharesansarToday(12345)).toEqual({});
    expect(parseSharesansarToday('<html>no table here</html>')).toEqual({});
    expect(parseSharesansarToday('')).toEqual({});
  });

  it('skips rows without a positive numeric LTP', () => {
    const t = parseSharesansarToday(
      '<thead><tr><th>Symbol</th><th>LTP</th><th>Prev. Close</th></tr></thead>' +
        '<tbody>' +
        '<tr><td>GOOD</td><td>100.50</td><td>99.00</td></tr>' +
        '<tr><td>BADP</td><td>-5</td><td>10</td></tr>' +
        '<tr><td>NOPX</td><td>N/A</td><td>10</td></tr>' +
        '<tr><td></td><td>50</td><td>49</td></tr>' +
        '</tbody>'
    );
    expect(t.GOOD).toEqual({ price: 100.5, prevClose: 99.0, high: null, low: null });
    expect(t.BADP).toBeUndefined();
    expect(t.NOPX).toBeUndefined();
    expect(Object.keys(t)).toEqual(['GOOD']);
  });

  it('yields null prevClose when the column is missing or non-numeric', () => {
    const t = parseSharesansarToday(
      '<thead><tr><th>Symbol</th><th>LTP</th></tr></thead>' +
        '<tbody><tr><td>SOLO</td><td>42.00</td></tr></tbody>'
    );
    expect(t.SOLO).toEqual({ price: 42.0, prevClose: null, high: null, low: null });
  });
});

// The whole point of a SECOND live NEPSE source: reconcile now takes the >=2-source
// AGREEMENT branch, so a wrong quote from either source fails closed instead of being
// trusted. These prove the 1.0% NEPSE default (core-default reconcile opts) behaves.
describe('two-source NEPSE cross-check (merolagani + sharesansar)', () => {
  const ml = (price) => ({ symbol: 'NABIL', price, prevClose: 558, asOf: NOW, source: 'merolagani' });
  const ss = (price) => ({ symbol: 'NABIL', price, prevClose: 558, asOf: NOW, source: 'sharesansar' });

  it('verifies to the median when both agree within 1% (the observed EOD case)', () => {
    // Empirically the two sources match to the penny at EOD; identical prices verify.
    const r = reconcile([ml(557.0), ss(557.0)], { now: NOW });
    expect(r.verified).toBe(true);
    expect(r.price).toBe(557.0);
    expect(r.sources).toEqual(['merolagani', 'sharesansar']);
  });

  it('still verifies (median) a small in-tolerance intraday spread (~0.5%)', () => {
    const r = reconcile([ml(557.0), ss(559.5)], { now: NOW }); // ~0.45% apart
    expect(r.verified).toBe(true);
    expect(r.price).toBe(558.25);
  });

  it('REJECTS as disagreement when the two exceed 1% — fails closed on a wrong quote', () => {
    // e.g. one source served a stale/mismatched number ~2% off: no price is trusted.
    const r = reconcile([ml(557.0), ss(568.5)], { now: NOW });
    expect(r.verified).toBe(false);
    expect(r.reason).toMatch(/^disagreement:/);
  });

  it('falls back to the lone source when the board misses the symbol (single-source)', () => {
    // sharesansar absent → single-source merolagani, exactly as before this source existed.
    const r = reconcile([ml(557.0)], { now: NOW });
    expect(r.verified).toBe(true);
    expect(r.price).toBe(557.0);
    expect(r.sources).toEqual(['merolagani']);
  });
});

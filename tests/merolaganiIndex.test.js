import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseMerolaganiIndexLatest } from '../src/lib/merolaganiIndex.js';

// A trimmed but REAL merolagani.com/Indices.aspx page (fetched 2026-09-17),
// saved in tests/fixtures/ — the same discipline as sharesansar-today-share-price.html.
const fx = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const PAGE = fx('merolagani-indices.html');

describe('parseMerolaganiIndexLatest', () => {
  it('parses the most recent row (date, value, percent change)', () => {
    const r = parseMerolaganiIndexLatest(PAGE);
    expect(r).toEqual({ date: '2026/09/17', value: 2624.36, changePct: 0.45 });
  });

  it('ignores older rows in the table — only the first row is read', () => {
    const r = parseMerolaganiIndexLatest(PAGE);
    expect(r.value).not.toBe(2612.42); // the second row's value
  });

  it('handles a negative percentage change correctly', () => {
    // Swap in a page whose first row is the -0.8% one by trimming to it.
    const negFirst = PAGE.replace(
      /<tbody>[\s\S]*?<\/tbody>/,
      `<tbody><tr><td>2</td><td class="text-center">2026/09/16</td><td class="text-right">2,612.42</td><td class="text-right">-21.19</td><td class="text-right">-0.8%</td></tr></tbody>`
    );
    expect(parseMerolaganiIndexLatest(negFirst)).toEqual({ date: '2026/09/16', value: 2612.42, changePct: -0.8 });
  });

  it('returns null for missing/malformed input', () => {
    expect(parseMerolaganiIndexLatest('')).toBeNull();
    expect(parseMerolaganiIndexLatest(null)).toBeNull();
    expect(parseMerolaganiIndexLatest('<html><body>no table here</body></html>')).toBeNull();
  });

  it('returns null when the date cell is not a real AD date', () => {
    const bad = '<tbody><tr><td>1</td><td>not-a-date</td><td>2624.36</td><td>11.93</td><td>0.45%</td></tr></tbody>';
    expect(parseMerolaganiIndexLatest(bad)).toBeNull();
  });

  it('returns null when the value cell is not a positive number', () => {
    const bad = '<tbody><tr><td>1</td><td>2026/09/17</td><td>n/a</td><td>11.93</td><td>0.45%</td></tr></tbody>';
    expect(parseMerolaganiIndexLatest(bad)).toBeNull();
  });

  it('never throws on garbage input', () => {
    expect(() => parseMerolaganiIndexLatest(12345)).not.toThrow();
    expect(() => parseMerolaganiIndexLatest({})).not.toThrow();
  });
});

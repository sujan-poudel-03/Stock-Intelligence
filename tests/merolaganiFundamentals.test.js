import { describe, it, expect } from 'vitest';
import { parseMerolaganiFundamentals } from '../src/lib/merolaganiFundamentals.js';

// A flattened snippet mirroring the real CompanyDetail summary text (post tag-strip).
// Embedded in a little HTML so we also exercise the tag-stripping path.
const SAMPLE = `
<div class="company-detail">
  <span>Shares Outstanding</span> <b>270,569,970.00</b>
  Market Price 557.00 % Change -0.18 % Last Traded On 2026/08/05 02:59:17
  52 Weeks High - Low 568.00-471.00
  180 Day Average 528.32 120 Day Average 532.98
  1 Year Yield 5.55% EPS 28.36 (FY:082-083, Q:4)
  P/E Ratio 19.64 Book Value 247.28 PBV 2.25 % Dividend 12.50 (FY:081-082)
</div>`;

describe('parseMerolaganiFundamentals', () => {
  it('extracts every fundamental from a real-shaped page', () => {
    const f = parseMerolaganiFundamentals(SAMPLE);
    expect(f.week52_high).toBe(568.0);
    expect(f.week52_low).toBe(471.0);
    expect(f.avg180).toBe(528.32);
    expect(f.avg120).toBe(532.98);
    expect(f.yield).toBe(5.55);
    expect(f.eps).toBe(28.36);
    expect(f.pe).toBe(19.64);
    expect(f.bv).toBe(247.28);
    expect(f.pbv).toBe(2.25);
    expect(f.div_pct).toBe(12.5);
  });

  it('handles comma-separated 52-week values', () => {
    const f = parseMerolaganiFundamentals('52 Weeks High - Low 1,568.00-1,471.50');
    expect(f.week52_high).toBe(1568.0);
    expect(f.week52_low).toBe(1471.5);
  });

  it('returns nulls for missing fields, never throws', () => {
    const f = parseMerolaganiFundamentals('Market Price 557.00 % Change -0.18');
    expect(f.week52_high).toBeNull();
    expect(f.week52_low).toBeNull();
    expect(f.avg180).toBeNull();
    expect(f.avg120).toBeNull();
    expect(f.yield).toBeNull();
    expect(f.eps).toBeNull();
    expect(f.pe).toBeNull();
    expect(f.bv).toBeNull();
    expect(f.pbv).toBeNull();
    expect(f.div_pct).toBeNull();
  });

  it('tolerates junk input without throwing', () => {
    expect(parseMerolaganiFundamentals(null).eps).toBeNull();
    expect(parseMerolaganiFundamentals(undefined).pe).toBeNull();
    expect(parseMerolaganiFundamentals(12345).bv).toBeNull();
    expect(parseMerolaganiFundamentals('').div_pct).toBeNull();
  });
});

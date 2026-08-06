import { describe, it, expect } from 'vitest';
import { pickSignalsScan } from '../src/lib/signalsFallback.js';

const latest = { id: 'L', status: 'running', started_at: '2026-08-06T02:00:00Z', completed_at: null };
const earlier = { id: 'E', status: 'done', started_at: '2026-08-05T02:00:00Z', completed_at: '2026-08-05T02:05:00Z' };
const rowsL = [{ symbol: 'AAA' }, { symbol: 'BBB' }];
const rowsE = [{ symbol: 'CCC' }];

describe('pickSignalsScan', () => {
  it('returns the latest scan unchanged when it has signals', () => {
    const out = pickSignalsScan({ latestScan: latest, latestRows: rowsL, fallbackScan: earlier, fallbackRows: rowsE });
    expect(out.scan).toBe(latest);
    expect(out.rows).toBe(rowsL);
    expect(out.fromEarlier).toBe(false);
  });

  it('falls back to the earlier scan when the latest has zero signal rows', () => {
    const out = pickSignalsScan({ latestScan: latest, latestRows: [], fallbackScan: earlier, fallbackRows: rowsE });
    expect(out.scan).toBe(earlier);
    expect(out.rows).toBe(rowsE);
    expect(out.fromEarlier).toBe(true);
  });

  it('treats null/undefined latestRows the same as empty', () => {
    const out = pickSignalsScan({ latestScan: latest, latestRows: null, fallbackScan: earlier, fallbackRows: rowsE });
    expect(out.scan).toBe(earlier);
    expect(out.fromEarlier).toBe(true);
  });

  it('keeps the empty latest result when there is no earlier scan with signals', () => {
    const out = pickSignalsScan({ latestScan: latest, latestRows: [], fallbackScan: null, fallbackRows: null });
    expect(out.scan).toBe(latest);
    expect(out.rows).toEqual([]);
    expect(out.fromEarlier).toBe(false);
  });

  it('does not fall back when the fallback scan is the same scan as the latest', () => {
    const same = { ...latest };
    const out = pickSignalsScan({ latestScan: latest, latestRows: [], fallbackScan: same, fallbackRows: rowsE });
    // same.id === latest.id -> no earlier scan, keep empty latest result
    expect(out.scan).toBe(latest);
    expect(out.fromEarlier).toBe(false);
  });

  it('does not fall back when the fallback scan has zero rows', () => {
    const out = pickSignalsScan({ latestScan: latest, latestRows: [], fallbackScan: earlier, fallbackRows: [] });
    expect(out.scan).toBe(latest);
    expect(out.fromEarlier).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { normalizeScanParams } from '../src/lib/adminScan.js';

describe('normalizeScanParams (admin scan trigger)', () => {
  it('defaults to a full NEPSE scan on an empty body', () => {
    expect(normalizeScanParams()).toEqual({
      exchange: 'NEPSE',
      mode: 'full',
      path: '/api/cron/scan?exchange=NEPSE',
    });
    expect(normalizeScanParams({})).toEqual({
      exchange: 'NEPSE',
      mode: 'full',
      path: '/api/cron/scan?exchange=NEPSE',
    });
  });

  it("adds &mode=light ONLY when mode is explicitly 'light'", () => {
    expect(normalizeScanParams({ mode: 'light' }).path).toBe('/api/cron/scan?exchange=NEPSE&mode=light');
    expect(normalizeScanParams({ mode: 'light' }).mode).toBe('light');
    // any other value coerces to full
    expect(normalizeScanParams({ mode: 'LIGHT' }).mode).toBe('full');
    expect(normalizeScanParams({ mode: 'weird' }).mode).toBe('full');
    expect(normalizeScanParams({ mode: 'full' }).path).toBe('/api/cron/scan?exchange=NEPSE');
  });

  it('coerces an unknown/blank exchange to the NEPSE default', () => {
    expect(normalizeScanParams({ exchange: 'BOGUS' }).exchange).toBe('NEPSE');
    expect(normalizeScanParams({ exchange: '' }).exchange).toBe('NEPSE');
  });

  it('normalizes a known exchange (case-insensitive) and reflects it in the path', () => {
    const out = normalizeScanParams({ exchange: 'nyse', mode: 'light' });
    expect(out.exchange).toBe('NYSE');
    expect(out.path).toBe('/api/cron/scan?exchange=NYSE&mode=light');
  });
});

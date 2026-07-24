import { describe, it, expect } from 'vitest';
import { nextScanRunIso, SCAN_CRONS } from '../src/lib/schedule.js';

// The schedule helper mirrors the Vercel crons for the UI. It must respect the
// NEPSE trading week (Sun–Thu, dow 0–4) and pick the soonest slot across all tiers.
describe('scan schedule', () => {
  it('exposes three tiered crons', () => {
    expect(SCAN_CRONS).toHaveLength(3);
  });

  it('returns the pre-open run on a trading weekday', () => {
    // Mon 2026-01-05 00:00 UTC -> next is the 03:45 UTC pre-open scan same day
    expect(nextScanRunIso(Date.UTC(2026, 0, 5, 0, 0, 0))).toBe('2026-01-05T03:45:00.000Z');
  });

  it('skips Saturday (NEPSE trades Sun–Thu)', () => {
    // Sat 2026-01-03 00:00 UTC -> no Sat runs; next is Sun 2026-01-04 03:45 UTC
    expect(nextScanRunIso(Date.UTC(2026, 0, 3, 0, 0, 0))).toBe('2026-01-04T03:45:00.000Z');
  });

  it('advances to the next intraday slot later in a trading day', () => {
    // Mon 2026-01-05 06:00 UTC -> next intraday light scan at 06:15 UTC (15,45 5-8)
    expect(nextScanRunIso(Date.UTC(2026, 0, 5, 6, 0, 0))).toBe('2026-01-05T06:15:00.000Z');
  });
});

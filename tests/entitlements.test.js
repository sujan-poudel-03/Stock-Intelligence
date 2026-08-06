import { describe, it, expect } from 'vitest';
import { entitlementFor, TIERS } from '../src/lib/entitlements.js';

describe('entitlementFor', () => {
  it('maps free tier to its capabilities', () => {
    const e = entitlementFor('free');
    expect(e.alerts).toBe(false);
    expect(e.signals_limit).toBe(5);
    expect(e.exchanges).toContain('NEPSE');
  });

  it('maps pro tier to unlocked capabilities', () => {
    const e = entitlementFor('pro');
    expect(e.alerts).toBe(true);
    expect(e.signals_limit).toBe(null); // unlimited
    expect(e.full_history).toBe(true);
  });

  it('falls back to free for unknown/blank/nullish tiers', () => {
    for (const t of ['bogus', '', null, undefined]) {
      expect(entitlementFor(t)).toBe(TIERS.free);
    }
  });
});

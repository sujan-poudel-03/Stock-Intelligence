import { describe, it, expect } from 'vitest';
import { normalizeQuote, sanityCheck, reconcile, verifiedPrice, resolveProviders } from '../src/lib/marketData.js';

const NOW = Date.UTC(2026, 0, 5, 10, 0, 0); // fixed clock so staleness is deterministic

describe('normalizeQuote', () => {
  it('uppercases the symbol and coerces numbers', () => {
    const q = normalizeQuote({ symbol: 'nabil', price: '510.5', previousClose: '505', asOf: NOW }, 'merolagani');
    expect(q).toEqual({ symbol: 'NABIL', price: 510.5, prevClose: 505, asOf: NOW, source: 'merolagani' });
  });

  it('returns null without a usable price', () => {
    expect(normalizeQuote({ symbol: 'X' }, 's')).toBeNull();
    expect(normalizeQuote(null, 's')).toBeNull();
  });
});

describe('sanityCheck', () => {
  it('accepts a normal quote', () => {
    expect(sanityCheck({ price: 105, prevClose: 100, asOf: NOW }, { now: NOW }).ok).toBe(true);
  });

  it('rejects a non-positive price', () => {
    expect(sanityCheck({ price: 0 }, { now: NOW })).toEqual({ ok: false, reason: 'non-positive-price' });
  });

  it('does NOT reject on age — late-but-true is acceptable', () => {
    const hoursOld = NOW - 5 * 60 * 60 * 1000;
    expect(sanityCheck({ price: 100, prevClose: 100, asOf: hoursOld }, { now: NOW }).ok).toBe(true);
  });

  it('rejects an implausible daily move vs prevClose', () => {
    // +20% vs prevClose exceeds the 12% band
    expect(sanityCheck({ price: 120, prevClose: 100, asOf: NOW }, { now: NOW }).ok).toBe(false);
  });

  // TIER-1 #1: corporate-action factor opt-in. A bonus/rights ex-move is mechanical,
  // so the guard measures against the ADJUSTED previous close when caFactor is given.
  describe('caFactor (corporate-action ex-move)', () => {
    it('rejects a −50% move vs RAW prevClose without caFactor', () => {
      // A 100% bonus halves the price: 200 -> 100 is a legit ex-move, but raw it looks
      // like a −50% crash and must be rejected when no caFactor is supplied.
      expect(sanityCheck({ price: 100, prevClose: 200, asOf: NOW }, { now: NOW }).ok).toBe(false);
    });

    it('ACCEPTS that same −50% move once caFactor=0.5 adjusts the base', () => {
      // caFactor 0.5 (100% bonus) → adjusted base 200*0.5=100 → move ~0% → accepted.
      expect(
        sanityCheck({ price: 100, prevClose: 200, asOf: NOW }, { now: NOW, caFactor: 0.5 }).ok
      ).toBe(true);
    });

    it('still REJECTS a move implausible relative to the ADJUSTED base', () => {
      // caFactor 0.5 → adjusted base 100; a price of 130 is +30% vs that base → rejected.
      expect(
        sanityCheck({ price: 130, prevClose: 200, asOf: NOW }, { now: NOW, caFactor: 0.5 }).ok
      ).toBe(false);
    });

    it('is UNCHANGED when caFactor is absent (byte-for-byte today)', () => {
      // Same normal quote with and without the opt behaves identically.
      const q = { price: 105, prevClose: 100, asOf: NOW };
      expect(sanityCheck(q, { now: NOW }).ok).toBe(true);
      expect(sanityCheck(q, { now: NOW, caFactor: undefined }).ok).toBe(true);
    });
  });
});

describe('reconcile', () => {
  it('verifies two agreeing sources and returns the median', () => {
    const r = reconcile(
      [
        { symbol: 'NABIL', price: 100, prevClose: 99, asOf: NOW, source: 'a' },
        { symbol: 'NABIL', price: 100.5, prevClose: 99, asOf: NOW, source: 'b' },
      ],
      { now: NOW }
    );
    expect(r.verified).toBe(true);
    expect(r.price).toBe(100.25);
    expect(r.sources).toEqual(['a', 'b']);
  });

  it('rejects when sources disagree beyond tolerance (fails closed)', () => {
    const r = reconcile(
      [
        { price: 100, asOf: NOW, source: 'a' },
        { price: 102, asOf: NOW, source: 'b' },
      ],
      { now: NOW }
    );
    expect(r.verified).toBe(false);
    expect(r.reason).toMatch(/^disagreement:/);
  });

  it('rejects a lone source when two are required', () => {
    const r = reconcile([{ price: 100, asOf: NOW, source: 'a' }], { now: NOW, requireTwoSources: true });
    expect(r).toEqual({ verified: false, reason: 'single-source', sources: ['a'] });
  });

  it('allows a lone source by default', () => {
    const r = reconcile([{ price: 100, asOf: NOW, source: 'a' }], { now: NOW });
    expect(r.verified).toBe(true);
    expect(r.price).toBe(100);
  });

  it('rejects when every quote is insane', () => {
    const r = reconcile([{ price: -1, source: 'a' }, { price: 0, source: 'b' }], { now: NOW });
    expect(r).toEqual({ verified: false, reason: 'no-sane-quote', sources: ['a', 'b'] });
  });
});

describe('verifiedPrice', () => {
  it('reconciles across injected providers', async () => {
    const p1 = async (s) => ({ symbol: s, price: 100, prevClose: 99, asOf: NOW, source: 'a' });
    const p2 = async (s) => ({ symbol: s, price: 100.4, prevClose: 99, asOf: NOW, source: 'b' });
    const r = await verifiedPrice('NABIL', { providers: [p1, p2], now: NOW });
    expect(r.verified).toBe(true);
    expect(r.price).toBe(100.2);
  });

  it('treats a throwing provider as no-quote (never a hard failure)', async () => {
    const boom = async () => {
      throw new Error('source down');
    };
    const r = await verifiedPrice('NABIL', { providers: [boom], now: NOW });
    expect(r).toEqual({ verified: false, reason: 'no-sane-quote', sources: [] });
  });

  it('rejects when no providers are configured', async () => {
    const r = await verifiedPrice('NABIL', { providers: [], now: NOW });
    expect(r).toEqual({ verified: false, reason: 'no-providers', sources: [] });
  });
});

describe('freshness is metadata, not a gate', () => {
  it('still verifies an hours-old quote but flags it stale + reports ageMs', () => {
    const eightHoursOld = NOW - 8 * 60 * 60 * 1000; // beyond the 6h display window
    const r = reconcile([{ price: 100, asOf: eightHoursOld, source: 'a' }], { now: NOW });
    expect(r.verified).toBe(true);
    expect(r.stale).toBe(true);
    expect(r.ageMs).toBe(8 * 60 * 60 * 1000);
  });

  it('is not stale within the display window', () => {
    const r = reconcile([{ price: 100, asOf: NOW - 60 * 1000, source: 'a' }], { now: NOW });
    expect(r.stale).toBe(false);
  });

  it('rejects on age ONLY when the admin opts in (rejectStale)', () => {
    const weekPlus = NOW - 8 * 24 * 60 * 60 * 1000;
    const r = reconcile([{ price: 100, asOf: weekPlus, source: 'a' }], { now: NOW, rejectStale: true });
    expect(r).toEqual({ verified: false, reason: 'stale', sources: ['a'] });
  });
});

describe('resolveProviders (admin source config)', () => {
  const registry = { merolagani: async () => null, sharesansar: async () => null };

  it('maps an ordered comma string to known providers', () => {
    expect(resolveProviders('merolagani, sharesansar', registry).map((p) => p.name)).toEqual([
      'merolagani',
      'sharesansar',
    ]);
  });

  it('drops unknown source names', () => {
    expect(resolveProviders('merolagani,bogus', registry).map((p) => p.name)).toEqual(['merolagani']);
  });

  it('accepts an array too', () => {
    expect(resolveProviders(['sharesansar'], registry).map((p) => p.name)).toEqual(['sharesansar']);
  });
});

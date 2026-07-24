import { describe, it, expect, afterEach } from 'vitest';
import {
  activeSourceNames,
  activeProviders,
  DEFAULT_SOURCES,
  listProviders,
  validateSources,
  getVerifiedPrice,
} from '../src/lib/marketProviders.js';

// The admin picks data sources on-screen (persisted in kv_store); env is the
// fallback, and the shipped default is the offline `sample` source so the system
// runs out of the box.
const saved = process.env.MARKET_DATA_SOURCES;
afterEach(() => {
  if (saved === undefined) delete process.env.MARKET_DATA_SOURCES;
  else process.env.MARKET_DATA_SOURCES = saved;
});

describe('market-data source config', () => {
  it('defaults to the shipped sample source when unset', () => {
    delete process.env.MARKET_DATA_SOURCES;
    expect(activeSourceNames()).toBe(DEFAULT_SOURCES.join(','));
    expect(DEFAULT_SOURCES).toContain('sample');
  });

  it('honours an admin/env override and resolves the providers', () => {
    process.env.MARKET_DATA_SOURCES = 'merolagani,sharesansar';
    expect(activeSourceNames()).toBe('merolagani,sharesansar');
    const providers = activeProviders();
    expect(providers).toHaveLength(2);
    expect(providers.every((f) => typeof f === 'function')).toBe(true);
  });
});

describe('provider metadata + validation', () => {
  it('lists providers with display metadata but no functions', () => {
    const list = listProviders();
    expect(list.find((p) => p.id === 'sample')).toBeTruthy();
    for (const p of list) {
      expect(typeof p.label).toBe('string');
      expect(typeof p.status).toBe('string');
      expect(p).not.toHaveProperty('fetch');
    }
  });

  it('validateSources drops unknown ids and preserves order', () => {
    expect(validateSources(['sharesansar', 'bogus', 'sample'])).toEqual(['sharesansar', 'sample']);
  });
});

describe('getVerifiedPrice (offline sample default)', () => {
  it('produces a verified price from the sample source without a database', async () => {
    delete process.env.MARKET_DATA_SOURCES; // sample default; kv lookup falls back offline
    const r = await getVerifiedPrice('NABIL');
    expect(r.verified).toBe(true);
    expect(r.sources).toEqual(['sample']);
    expect(r.price).toBeGreaterThan(0);
  });

  it('is deterministic for a given symbol', async () => {
    const a = await getVerifiedPrice('UPPER');
    const b = await getVerifiedPrice('UPPER');
    expect(a.price).toBe(b.price);
  });
});

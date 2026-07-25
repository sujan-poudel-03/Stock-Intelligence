import { describe, it, expect, afterEach } from 'vitest';
import {
  activeSourceNames,
  activeProviders,
  DEFAULT_SOURCES,
  listProviders,
  validateSources,
  getVerifiedPrice,
} from '../src/lib/marketProviders.js';

// Sources are config-gated: a stub or a source with unmet required env is NOT
// available — it can't be selected and is dropped from the active set.
const savedSources = process.env.MARKET_DATA_SOURCES;
const savedToken = process.env.NEPALSTOCK_API_TOKEN;
afterEach(() => {
  if (savedSources === undefined) delete process.env.MARKET_DATA_SOURCES;
  else process.env.MARKET_DATA_SOURCES = savedSources;
  if (savedToken === undefined) delete process.env.NEPALSTOCK_API_TOKEN;
  else process.env.NEPALSTOCK_API_TOKEN = savedToken;
});

describe('source config + availability', () => {
  it('defaults to the offline sample source when unset', () => {
    delete process.env.MARKET_DATA_SOURCES;
    expect(activeSourceNames()).toBe(DEFAULT_SOURCES.join(','));
    expect(DEFAULT_SOURCES).toContain('sample');
  });

  it('exposes availability + config metadata per provider', () => {
    delete process.env.NEPALSTOCK_API_TOKEN;
    const list = listProviders();
    const byId = Object.fromEntries(list.map((p) => [p.id, p]));
    expect(byId.merolagani.available).toBe(true); // live, no env needed
    expect(byId.sample.available).toBe(true);
    expect(byId.sharesansar.available).toBe(false); // stub — not implemented
    expect(byId.nepalstock.available).toBe(false); // requires env, not set
    expect(byId.nepalstock.requiresEnv).toContain('NEPALSTOCK_API_TOKEN');
    expect(byId.nepalstock.configured).toBe(false);
    expect(list.find((p) => p).fetch).toBeUndefined(); // no functions leak to the client
  });

  it('enables a config-gated source only once its env is present', () => {
    delete process.env.NEPALSTOCK_API_TOKEN;
    expect(validateSources(['nepalstock'])).toEqual([]); // disabled → rejected
    process.env.NEPALSTOCK_API_TOKEN = 'test-token';
    expect(validateSources(['nepalstock'])).toEqual(['nepalstock']); // now selectable
    expect(listProviders().find((p) => p.id === 'nepalstock').available).toBe(true);
  });

  it('rejects a stub (not-implemented) source', () => {
    expect(validateSources(['sharesansar'])).toEqual([]);
  });

  it('keeps a live source and drops unavailable ones from a mixed list', () => {
    delete process.env.NEPALSTOCK_API_TOKEN;
    expect(validateSources(['merolagani', 'sharesansar', 'nepalstock', 'bogus'])).toEqual(['merolagani']);
  });

  it('activeProviders resolves only available sources', () => {
    process.env.MARKET_DATA_SOURCES = 'merolagani,sharesansar';
    expect(activeProviders()).toHaveLength(1); // sharesansar dropped
  });
});

describe('getVerifiedPrice (offline sample default)', () => {
  it('produces a verified price from the sample source without a database', async () => {
    delete process.env.MARKET_DATA_SOURCES;
    const r = await getVerifiedPrice('NABIL');
    expect(r.verified).toBe(true);
    expect(r.sources).toEqual(['sample']);
    expect(r.price).toBeGreaterThan(0);
  });

  it('is deterministic for a given symbol', async () => {
    delete process.env.MARKET_DATA_SOURCES;
    const a = await getVerifiedPrice('UPPER');
    const b = await getVerifiedPrice('UPPER');
    expect(a.price).toBe(b.price);
  });
});

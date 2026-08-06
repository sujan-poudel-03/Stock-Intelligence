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
const savedEnableNyse = process.env.ENABLE_NYSE;
const savedFetch = global.fetch;
afterEach(() => {
  if (savedSources === undefined) delete process.env.MARKET_DATA_SOURCES;
  else process.env.MARKET_DATA_SOURCES = savedSources;
  if (savedToken === undefined) delete process.env.NEPALSTOCK_API_TOKEN;
  else process.env.NEPALSTOCK_API_TOKEN = savedToken;
  if (savedEnableNyse === undefined) delete process.env.ENABLE_NYSE;
  else process.env.ENABLE_NYSE = savedEnableNyse;
  global.fetch = savedFetch;
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
    expect(byId.sharesansar.available).toBe(true); // live 2nd source, no env needed
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

  it('accepts sharesansar — the second live NEPSE source (no env needed)', () => {
    expect(validateSources(['sharesansar'])).toEqual(['sharesansar']);
  });

  it('keeps live sources and drops unavailable ones from a mixed list', () => {
    delete process.env.NEPALSTOCK_API_TOKEN;
    // merolagani + sharesansar are both live; nepalstock (unmet env) + bogus are dropped.
    expect(validateSources(['merolagani', 'sharesansar', 'nepalstock', 'bogus'])).toEqual([
      'merolagani',
      'sharesansar',
    ]);
  });

  it('activeProviders resolves only available sources', () => {
    delete process.env.NEPALSTOCK_API_TOKEN;
    // Both live sources resolve; the unavailable nepalstock (no token) is dropped.
    process.env.MARKET_DATA_SOURCES = 'merolagani,sharesansar,nepalstock';
    expect(activeProviders()).toHaveLength(2); // nepalstock dropped
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

// The yahoo (NYSE) source is gated behind a TRUTHY parse of ENABLE_NYSE — a boolean
// flag, unlike nepalstock's presence-only token. "false"/"0"/"no"/"" stay disabled.
describe('yahoo availability (ENABLE_NYSE truthy gate)', () => {
  it('is unavailable when ENABLE_NYSE is unset or falsey', () => {
    delete process.env.ENABLE_NYSE;
    expect(validateSources(['yahoo'])).toEqual([]);
    for (const v of ['false', '0', 'no', '']) {
      process.env.ENABLE_NYSE = v;
      expect(validateSources(['yahoo'])).toEqual([]);
    }
  });

  it('is available only for truthy ENABLE_NYSE values', () => {
    for (const v of ['1', 'true', 'yes', 'TRUE']) {
      process.env.ENABLE_NYSE = v;
      expect(validateSources(['yahoo'])).toEqual(['yahoo']);
    }
  });
});

// getVerifiedPrice routes providers by exchange. The NEPSE (default) path is
// unchanged; a non-default exchange resolves its own configured sources through the
// SAME availability gate, then feeds the shared verified-price core.
describe('getVerifiedPrice exchange routing', () => {
  const yahooPayload = {
    chart: { result: [{ meta: { symbol: 'AAPL', regularMarketPrice: 231.5, chartPreviousClose: 228, currency: 'USD' } }] },
  };

  it('NEPSE path is unchanged — injected providers bypass exchange routing', async () => {
    const fake = async (s) => ({ symbol: s, price: 500, prevClose: 495, source: 'test' });
    const r = await getVerifiedPrice('NABIL', { providers: [fake] });
    expect(r.verified).toBe(true);
    expect(r.price).toBe(500);
    expect(r.sources).toEqual(['test']);
  });

  it('NYSE resolves the yahoo provider when ENABLE_NYSE is truthy', async () => {
    process.env.ENABLE_NYSE = '1';
    global.fetch = async () => ({ ok: true, json: async () => yahooPayload });
    const r = await getVerifiedPrice('AAPL', { exchange: 'NYSE' });
    expect(r.verified).toBe(true);
    expect(r.price).toBe(231.5);
    expect(r.sources).toEqual(['yahoo']);
  });

  it('drops yahoo (no providers, no network) when ENABLE_NYSE is unset', async () => {
    delete process.env.ENABLE_NYSE;
    let called = false;
    global.fetch = async () => { called = true; throw new Error('should not fetch'); };
    const r = await getVerifiedPrice('AAPL', { exchange: 'NYSE' });
    expect(r.verified).toBe(false);
    expect(r.reason).toBe('no-providers');
    expect(called).toBe(false);
  });

  it('ENABLE_NYSE=false disables NYSE', async () => {
    process.env.ENABLE_NYSE = 'false';
    const r = await getVerifiedPrice('AAPL', { exchange: 'NYSE' });
    expect(r.verified).toBe(false);
    expect(r.reason).toBe('no-providers');
  });
});

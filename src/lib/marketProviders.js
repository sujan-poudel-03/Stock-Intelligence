// Admin-configurable, config-gated market-data providers (source abstraction).
//
// WHICH sources feed the verified-price core (marketData.js) is an admin decision,
// made on-screen (Settings → Market Data Sources) and persisted in kv_store, with an
// env/default fallback. A provider is an async (symbol) => rawQuote|null plus display
// metadata. Correctness, cross-checking, and staleness annotation live in
// marketData.js — a provider only fetches and shapes one source's number.
//
// A provider can declare `requiresEnv` (env vars it needs, e.g. an API token). Until
// those are present it is treated as NOT AVAILABLE: shown disabled in the admin UI
// and rejected by setActiveSources — the admin cannot switch to it. When the env is
// present it becomes selectable (admin-only). `status`:
//   'live'   — a working implementation
//   'sample' — deterministic FAKE quotes for setup/testing (never real decisions)
//   'stub'   — not yet implemented (returns null); never available

import { verifiedPrice, resolveProviders } from './marketData.js';
import { fetchYahooStock, normalizeYahooQuote } from './yahoo.js';
import { getExchange, normalizeExchange, DEFAULT_EXCHANGE } from './exchanges.js';

export const ACTIVE_SOURCES_KEY = 'ni:market_sources';
// Code default is the offline `sample` source so the app runs with no network/config.
// Deployments select real sources via MARKET_DATA_SOURCES or the admin UI.
export const DEFAULT_SOURCES = ['sample'];

export const PROVIDERS = [
  {
    id: 'merolagani',
    label: 'MeroLagani',
    description: 'merolagani.com — live server-rendered quote (last price + day change).',
    status: 'live',
    requiresEnv: [],
    fetch: fetchMerolagani,
  },
  {
    id: 'sharesansar',
    label: 'ShareSansar',
    description: 'sharesansar.com — not yet implemented (price loads via a CSRF/AJAX flow).',
    status: 'stub',
    requiresEnv: [],
    fetch: fetchSharesansar,
  },
  {
    id: 'nepalstock',
    label: 'NEPSE Official',
    description: 'nepalstock.com.np official API. Build-ready — requires an API token to enable.',
    status: 'live',
    requiresEnv: ['NEPALSTOCK_API_TOKEN'],
    fetch: fetchNepalstock,
  },
  {
    id: 'sample',
    label: 'Sample data (offline)',
    description: 'Deterministic placeholder quotes for setup/testing. NOT real market prices.',
    status: 'sample',
    requiresEnv: [],
    fetch: fetchSample,
  },
  {
    id: 'yahoo',
    label: 'Yahoo Finance (NYSE)',
    description: 'finance.yahoo.com chart API — US equities (NYSE/Nasdaq). Feature-gated behind ENABLE_NYSE.',
    status: 'live',
    // Yahoo needs no API key; the ENABLE_NYSE flag keeps NYSE unselectable in
    // production until deliberately switched on (same "unavailable → dropped" gate
    // as nepalstock's token). NEPSE never resolves this source.
    requiresEnv: ['ENABLE_NYSE'],
    fetch: fetchYahoo,
  },
];

export const PROVIDER_REGISTRY = Object.fromEntries(PROVIDERS.map((p) => [p.id, p.fetch]));

// A provider is "configured" when every env var it requires is present + non-empty.
function isConfigured(p, env = process.env) {
  return (p.requiresEnv || []).every((k) => !!(env[k] && String(env[k]).trim()));
}
// A provider is "available" (selectable) when it's implemented AND configured.
function isAvailable(p, env = process.env) {
  return p.status !== 'stub' && isConfigured(p, env);
}

// Metadata for the admin screen (no functions). `available` drives the disabled
// state; `requiresEnv`/`configured` explain WHY a source is disabled.
export function listProviders(env = process.env) {
  return PROVIDERS.map((p) => ({
    id: p.id,
    label: p.label,
    description: p.description,
    status: p.status,
    requiresEnv: p.requiresEnv || [],
    configured: isConfigured(p, env),
    available: isAvailable(p, env),
  }));
}

// Keep only known, AVAILABLE source ids, in the given order. This is the gate: a
// stub or a source with unmet env is dropped, so it can never become active.
export function validateSources(names, env = process.env) {
  return resolveProviders(names, PROVIDER_REGISTRY)
    .map((p) => p.name)
    .filter((name) => {
      const desc = PROVIDERS.find((x) => x.id === name);
      return desc && isAvailable(desc, env);
    });
}

// Env/default (sync) — fallback + used by tests.
export function activeSourceNames(env = process.env) {
  const configured = (env.MARKET_DATA_SOURCES || '').trim();
  return configured ? configured : DEFAULT_SOURCES.join(',');
}

// Runtime active sources: admin kv override → env → default, filtered to AVAILABLE.
// Best-effort on kv so a storage blip falls back to config rather than breaking.
export async function getActiveSources() {
  try {
    const { getSupabase } = await import('./supabase.js');
    const supabase = getSupabase();
    const { data } = await supabase
      .from('kv_store')
      .select('value')
      .eq('key', ACTIVE_SOURCES_KEY)
      .maybeSingle();
    const v = data?.value;
    const list = Array.isArray(v) ? v : Array.isArray(v?.sources) ? v.sources : null;
    if (list && list.length) {
      const valid = validateSources(list);
      if (valid.length) return valid;
    }
  } catch {
    /* kv unreachable — fall back to env/default */
  }
  const fromEnv = validateSources(activeSourceNames());
  return fromEnv.length ? fromEnv : validateSources(DEFAULT_SOURCES);
}

// Persist the admin's selection. Rejects any source that isn't available (stub or
// unmet env) — an admin cannot select a disabled source.
export async function setActiveSources(names) {
  const valid = validateSources(names);
  if (!valid.length) throw new Error('No valid/available data sources selected');
  const { getSupabase } = await import('./supabase.js');
  const supabase = getSupabase();
  await supabase.from('kv_store').upsert(
    { key: ACTIVE_SOURCES_KEY, value: { sources: valid }, updated_at: new Date().toISOString() },
    { onConflict: 'key' }
  );
  return valid;
}

// Env/default resolved provider fns (sync, available-only) — used by tests.
export function activeProviders(env = process.env, registry = PROVIDER_REGISTRY) {
  return resolveProviders(activeSourceNames(env), registry)
    .filter((p) => {
      const desc = PROVIDERS.find((x) => x.id === p.name);
      return desc && isAvailable(desc, env);
    })
    .map((p) => p.fn);
}

// getVerifiedPrice(symbol, opts): app-facing entry point. Uses the admin-selected
// sources unless the caller injects its own providers (tests, backtest harness).
//
// exchange dimension (additive): when `opts.exchange` is absent or 'NEPSE', the path
// below is BYTE-FOR-BYTE the old behaviour (admin-selected sources, core-default
// reconcile opts). When it names a non-default exchange (e.g. 'NYSE'), the exchange's
// configured sourceIds (filtered through the same availability gate) + its reconcileOpts
// are used instead — the verified-price CORE (marketData.js) is untouched; only its
// inputs vary. A caller injecting its own `providers` bypasses all routing (tests).
export async function getVerifiedPrice(symbol, opts = {}) {
  const { exchange, ...rest } = opts;
  let providers = rest.providers;
  let reconcileOpts = {};

  if (!providers) {
    const ex = normalizeExchange(exchange);
    if (ex === DEFAULT_EXCHANGE) {
      // Unchanged NEPSE path: admin-selected sources, core-default reconcile opts.
      const names = await getActiveSources();
      providers = resolveProviders(names, PROVIDER_REGISTRY).map((p) => p.fn);
    } else {
      // Non-default exchange: its configured sources (availability-gated) + opts.
      const cfg = getExchange(ex);
      const validIds = validateSources(cfg.sourceIds || []);
      providers = resolveProviders(validIds, PROVIDER_REGISTRY).map((p) => p.fn);
      reconcileOpts = cfg.reconcileOpts || {};
    }
  }
  return verifiedPrice(symbol, { ...reconcileOpts, ...rest, providers });
}

// --- yahoo (NYSE) provider -------------------------------------------------

// Wrap the raw Yahoo fetcher and normalize to the core's quote shape. Best-effort:
// any failure (network, layout change, no price) returns null so the verified layer
// fails closed — exactly like the NEPSE scrapers.
async function fetchYahoo(symbol) {
  const s = String(symbol || '').toUpperCase();
  if (!s) return null;
  const stock = await fetchYahooStock(s);
  return normalizeYahooQuote(stock, s);
}

// --- providers -------------------------------------------------------------

// MeroLagani: fetch the server-rendered company page and parse the last price +
// day change. Best-effort — any failure (network, layout change, no match) returns
// null so the verified layer fails closed. NOTE (ToS): commercial scraping is part
// of the P3-1 legal review; this is the interim source before a licensed feed.
async function fetchMerolagani(symbol) {
  const s = String(symbol || '').toUpperCase();
  if (!s) return null;
  try {
    const res = await fetch(`https://merolagani.com/CompanyDetail.aspx?symbol=${encodeURIComponent(s)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const html = await res.text();

    const priceM = html.match(/lblMarketPrice"[^>]*>\s*([\d,]+\.\d+)/i);
    if (!priceM) return null;
    const price = Number(priceM[1].replace(/,/g, ''));
    if (!Number.isFinite(price) || price <= 0) return null;

    // Day change % + direction (text-increase / text-decrease), to derive prevClose
    // for the plausibility guard.
    let changePct = null;
    let prevClose = null;
    const chM = html.match(/lblChange"[^>]*class="([^"]*)"[^>]*>\s*([\d,]+\.?\d*)/i);
    if (chM) {
      const dir = /decrease/i.test(chM[1]) ? -1 : 1;
      const pct = Number(chM[2].replace(/,/g, ''));
      if (Number.isFinite(pct)) {
        changePct = dir * pct;
        if (changePct !== -100) prevClose = price / (1 + changePct / 100);
      }
    }
    return { symbol: s, price, prevClose, changePct, asOf: Date.now(), source: 'merolagani' };
  } catch {
    return null;
  }
}

// ShareSansar: price loads via a CSRF-token AJAX flow — not yet implemented, so this
// fails closed. Build-ready slot for a second cross-check source.
async function fetchSharesansar() {
  return null; // TODO(P1-1): implement the sharesansar AJAX price flow.
}

// NEPSE Official: build-ready, gated on NEPALSTOCK_API_TOKEN. Not selectable until
// the token env is set (see requiresEnv); the endpoint call lands once the API is
// available.
async function fetchNepalstock() {
  const token = process.env.NEPALSTOCK_API_TOKEN;
  if (!token) return null;
  return null; // TODO(P1-1): call the official API with the token → normalized quote.
}

// Deterministic placeholder: a stable pseudo-price per symbol so the pipeline runs
// offline. Clearly labeled 'sample' so any surface can flag it as non-real.
async function fetchSample(symbol) {
  const s = String(symbol || '').toUpperCase();
  if (!s) return null;
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const price = 100 + (h % 900);
  const prevClose = Math.round(price * (1 + (((h >> 8) % 7) - 3) / 100));
  return { symbol: s, price, prevClose, asOf: Date.now(), source: 'sample' };
}

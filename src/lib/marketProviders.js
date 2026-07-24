// Admin-configurable market-data providers (source abstraction).
//
// WHICH sources feed the verified-price core (marketData.js) is an admin decision,
// made on-screen (Settings → Data Sources) and persisted in kv_store, with an
// env/default fallback. A "provider" is an async (symbol) => rawQuote|null plus
// display metadata; correctness, cross-checking, and staleness annotation live in
// marketData.js — a provider only fetches and shapes one source's number.
//
// status:
//   'live'   — real market data
//   'sample' — deterministic FAKE quotes for setup/testing (never real decisions)
//   'stub'   — a real source whose fetcher isn't implemented yet (returns null)
//
// The shipped default is `sample` so the system runs end-to-end out of the box.
// Real sources (merolagani/sharesansar/nepalstock) are stubs until P1-1 wires their
// endpoints + a ToS review clears them — until then they fail closed (no price).

import { getSupabase } from './supabase.js';
import { verifiedPrice, resolveProviders } from './marketData.js';

export const ACTIVE_SOURCES_KEY = 'ni:market_sources';
// Default source: `sample` so the app works immediately. Swap to real sources
// (e.g. MARKET_DATA_SOURCES=merolagani,sharesansar) once P1-1 fetchers are live.
export const DEFAULT_SOURCES = ['sample'];

export const PROVIDERS = [
  {
    id: 'sample',
    label: 'Sample data (offline)',
    description: 'Deterministic placeholder quotes for setup and testing. NOT real market prices — do not use for real decisions.',
    status: 'sample',
    fetch: fetchSample,
  },
  {
    id: 'merolagani',
    label: 'MeroLagani',
    description: 'merolagani.com portal. Live fetcher pending (P1-1) + terms-of-use review.',
    status: 'stub',
    fetch: fetchMerolagani,
  },
  {
    id: 'sharesansar',
    label: 'ShareSansar',
    description: 'sharesansar.com portal. Live fetcher pending (P1-1) + terms-of-use review.',
    status: 'stub',
    fetch: fetchSharesansar,
  },
  {
    id: 'nepalstock',
    label: 'NEPSE Official',
    description: 'nepalstock.com.np official exchange site. Live fetcher pending (P1-1) + terms-of-use review.',
    status: 'stub',
    fetch: fetchNepalstock,
  },
];

export const PROVIDER_REGISTRY = Object.fromEntries(PROVIDERS.map((p) => [p.id, p.fetch]));

// Metadata only — safe to send to the client (no functions).
export function listProviders() {
  return PROVIDERS.map(({ id, label, description, status }) => ({ id, label, description, status }));
}

// Keep only known source ids, in the given order.
export function validateSources(names) {
  return resolveProviders(names, PROVIDER_REGISTRY).map((p) => p.name);
}

// Env/default (sync) — fallback + used by tests.
export function activeSourceNames(env = process.env) {
  const configured = (env.MARKET_DATA_SOURCES || '').trim();
  return configured ? configured : DEFAULT_SOURCES.join(',');
}

// Runtime active sources: admin kv override → env → default. Best-effort on kv so a
// storage blip falls back to config rather than breaking price lookups.
export async function getActiveSources() {
  try {
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
  return validateSources(activeSourceNames());
}

// Persist the admin's selection (validated) to kv_store.
export async function setActiveSources(names) {
  const valid = validateSources(names);
  if (!valid.length) throw new Error('No valid data sources selected');
  const supabase = getSupabase();
  await supabase.from('kv_store').upsert(
    { key: ACTIVE_SOURCES_KEY, value: { sources: valid }, updated_at: new Date().toISOString() },
    { onConflict: 'key' }
  );
  return valid;
}

// Env/default resolved provider fns (sync) — used by tests.
export function activeProviders(env = process.env, registry = PROVIDER_REGISTRY) {
  return resolveProviders(activeSourceNames(env), registry).map((p) => p.fn);
}

// getVerifiedPrice(symbol, opts): app-facing entry point. Uses the admin-selected
// sources unless the caller injects its own providers (tests, backtest harness).
export async function getVerifiedPrice(symbol, opts = {}) {
  let providers = opts.providers;
  if (!providers) {
    const names = await getActiveSources();
    providers = resolveProviders(names, PROVIDER_REGISTRY).map((p) => p.fn);
  }
  return verifiedPrice(symbol, { ...opts, providers });
}

// --- providers -------------------------------------------------------------

// Deterministic placeholder: a stable pseudo-price per symbol so the pipeline runs
// offline. Clearly labeled 'sample' so any surface can flag it as non-real.
async function fetchSample(symbol) {
  const s = String(symbol || '').toUpperCase();
  if (!s) return null;
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const price = 100 + (h % 900); // stable pseudo price in [100, 999]
  const prevClose = Math.round(price * (1 + (((h >> 8) % 7) - 3) / 100)); // within ±3%
  return { symbol: s, price, prevClose, asOf: Date.now(), source: 'sample' };
}

// Real-source stubs — implement once the endpoint/DOM is validated and ToS cleared
// (P1-1). Returning null keeps the system failing closed until then.
async function fetchMerolagani() {
  return null; // TODO(P1-1): parse merolagani.com → { symbol, price, prevClose, asOf, source: 'merolagani' }
}
async function fetchSharesansar() {
  return null; // TODO(P1-1): parse sharesansar.com → { ..., source: 'sharesansar' }
}
async function fetchNepalstock() {
  return null; // TODO(P1-1): parse nepalstock.com.np → { ..., source: 'nepalstock' }
}

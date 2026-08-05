'use client';

import { getAccessToken } from './authClient';

// Mode-aware persistence for the thin per-user layer (Phase 2 step 5c). Replaces the
// identity-less clientStorage (dbGet/dbSet) for watchlist / portfolio / settings.
//
//   mode 'api'   — Supabase auth configured AND signed in: read/write the caller's
//                  OWN rows via the identity-scoped routes (bearer token attached;
//                  the server re-verifies it and scopes every query by user_id).
//   mode 'local' — auth NOT configured (open / single-operator mode): device-local
//                  localStorage, so local dev works with no Supabase auth at all.
//   mode 'gated' — auth configured but signed OUT: reads return empty, writes are
//                  refused (the UI shows a "sign in to save" affordance instead — it
//                  never calls a write in this mode).
//
// The per-user table shape is the canonical wire shape; local mode mirrors those
// column names so the component maps both identically.

// ---- localStorage helpers (SSR-safe) ---------------------------------------
function lsGet(key, fallback) {
  if (typeof window === 'undefined') return fallback;
  try {
    const v = window.localStorage.getItem(key);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
function lsSet(key, val) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(val));
  } catch {
    /* quota / disabled storage — non-fatal */
  }
}

// Device-local reads/writes for keys with no per-user table (chat history, stock
// cache, the view-only exchange preference). Per-device, never shared — closes the
// old /api/storage cross-user leak for these without needing a table.
export function deviceGet(key, fallback) {
  return lsGet(key, fallback);
}
export function deviceSet(key, val) {
  lsSet(key, val);
}

// ---- authed fetch -----------------------------------------------------------
async function api(path, opts = {}) {
  const token = await getAccessToken();
  return fetch(path, {
    method: opts.method || 'GET',
    cache: 'no-store',
    headers: {
      'content-type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
}

const LS_WL = 'ni:u:wl'; // { [exchange]: [{ symbol, reason }] }
const LS_PF = 'ni:u:pf'; // [ row ]  (portfolios column shape)
const LS_SETTINGS = 'ni:u:settings'; // personal prefs blob

// ---- watchlist --------------------------------------------------------------
function normalizeWl(rows) {
  const symbols = [];
  const sources = {};
  (rows || []).forEach((r) => {
    const sym = String(r?.symbol || '').toUpperCase().trim();
    if (!sym || sources[sym]) return;
    symbols.push(sym);
    sources[sym] = r?.reason || 'manual';
  });
  return { symbols, sources };
}

export async function loadWatchlist(mode, exchange) {
  if (mode === 'api') {
    const res = await api('/api/watchlist?exchange=' + encodeURIComponent(exchange));
    if (!res.ok) return { symbols: [], sources: {} };
    const d = await res.json();
    return normalizeWl(d.watchlist);
  }
  if (mode === 'local') return normalizeWl(lsGet(LS_WL, {})[exchange] || []);
  return { symbols: [], sources: {} };
}

export async function addWatchlist(mode, exchange, symbol, reason) {
  symbol = String(symbol || '').toUpperCase().trim();
  if (mode === 'api') {
    await api('/api/watchlist', { method: 'POST', body: { exchange, symbol, reason: reason || 'manual' } });
    return;
  }
  if (mode === 'local') {
    const all = lsGet(LS_WL, {});
    const list = all[exchange] || [];
    if (!list.some((r) => String(r.symbol || '').toUpperCase() === symbol)) {
      list.push({ symbol, reason: reason || 'manual' });
    }
    all[exchange] = list;
    lsSet(LS_WL, all);
  }
}

export async function removeWatchlist(mode, exchange, symbol) {
  symbol = String(symbol || '').toUpperCase().trim();
  if (mode === 'api') {
    await api('/api/watchlist?exchange=' + encodeURIComponent(exchange) + '&symbol=' + encodeURIComponent(symbol), { method: 'DELETE' });
    return;
  }
  if (mode === 'local') {
    const all = lsGet(LS_WL, {});
    all[exchange] = (all[exchange] || []).filter((r) => String(r.symbol || '').toUpperCase() !== symbol);
    lsSet(LS_WL, all);
  }
}

// ---- portfolio (rows in portfolios column shape) ----------------------------
export async function loadPortfolio(mode) {
  if (mode === 'api') {
    const res = await api('/api/portfolio');
    if (!res.ok) return [];
    const d = await res.json();
    return d.positions || [];
  }
  if (mode === 'local') return lsGet(LS_PF, []);
  return [];
}

// row: { exchange, symbol, qty, buy_price, stop_loss, target, basis? }
export async function openPosition(mode, row) {
  if (mode === 'api') {
    const res = await api('/api/portfolio', { method: 'POST', body: row });
    if (!res.ok) throw new Error('open position failed');
    const d = await res.json();
    return d.position;
  }
  if (mode === 'local') {
    const list = lsGet(LS_PF, []);
    const rec = {
      id: 'L' + Date.now(),
      status: 'open',
      opened_at: new Date().toISOString(),
      closed_at: null,
      sell_price: null,
      ...row,
    };
    list.unshift(rec);
    lsSet(LS_PF, list);
    return rec;
  }
  throw new Error('cannot save while signed out');
}

export async function closePosition(mode, id, sellPrice) {
  const patch = { status: 'closed', sell_price: sellPrice, closed_at: new Date().toISOString() };
  if (mode === 'api') {
    const res = await api('/api/portfolio', { method: 'PATCH', body: { id, ...patch } });
    if (!res.ok) throw new Error('close position failed');
    return;
  }
  if (mode === 'local') {
    const list = lsGet(LS_PF, []).map((r) => (r.id === id ? { ...r, ...patch } : r));
    lsSet(LS_PF, list);
    return;
  }
  throw new Error('cannot save while signed out');
}

// ---- personal settings (view prefs) -----------------------------------------
export async function loadPersonalSettings(mode) {
  if (mode === 'api') {
    const res = await api('/api/settings');
    if (!res.ok) return {};
    const d = await res.json();
    return d.prefs || {};
  }
  if (mode === 'local') return lsGet(LS_SETTINGS, {});
  return {};
}

export async function savePersonalSettings(mode, prefs) {
  if (mode === 'api') {
    await api('/api/settings', { method: 'PUT', body: { prefs } });
    return;
  }
  if (mode === 'local') lsSet(LS_SETTINGS, prefs);
}

// ---- per-user alert preferences ---------------------------------------------
// Which channels notify ME + which signal directions trigger it. Owner-scoped via
// /api/alerts (bearer token attached); local mode mirrors it in localStorage so the
// single-operator open mode still persists a choice.
const LS_ALERTS = 'ni:u:alerts';
const EMPTY_ALERTS = { channels: {}, thresholds: {} };

export async function loadAlertPrefs(mode) {
  if (mode === 'api') {
    const res = await api('/api/alerts');
    if (!res.ok) return { ...EMPTY_ALERTS };
    const d = await res.json();
    return { channels: d.channels || {}, thresholds: d.thresholds || {} };
  }
  if (mode === 'local') return lsGet(LS_ALERTS, { ...EMPTY_ALERTS });
  return { ...EMPTY_ALERTS };
}

export async function saveAlertPrefs(mode, prefs) {
  if (mode === 'api') {
    await api('/api/alerts', { method: 'PUT', body: prefs });
    return;
  }
  if (mode === 'local') lsSet(LS_ALERTS, prefs);
}

// ---- global agent/discovery config (admin) ----------------------------------
// Open read (the UI shows discovery depth to everyone); admin-gated write.
export async function loadGlobalSettings() {
  try {
    const res = await fetch('/api/admin/settings', { cache: 'no-store' });
    if (!res.ok) return {};
    const d = await res.json();
    return d.settings || {};
  } catch {
    return {};
  }
}

export async function saveGlobalSettings(settings) {
  const token = await getAccessToken();
  const res = await fetch('/api/admin/settings', {
    method: 'POST',
    cache: 'no-store',
    headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ settings }),
  });
  return res.ok;
}

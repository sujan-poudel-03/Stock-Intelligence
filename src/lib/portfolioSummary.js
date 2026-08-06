// Server-side portfolio summary assembly (TIER-2) — the ONE place that turns a user's
// raw positions into P&L + concentration, shared by GET /api/portfolio/summary and the
// chat advisor (imported directly, NOT called over HTTP).
//
// STANDING RULES honored here:
//   - Prices are GROUND TRUTH, never LLM-sourced. This helper only READS already-computed
//     prices; the chat LLM never sets one.
//   - Market data is GLOBAL. A portfolio view is a per-user READ that REUSES the shared
//     signals prices (latest row per symbol). It NEVER re-scans or fetches the whole
//     market — at most a small BOUNDED (<=5) on-demand verified-price fallback for held
//     symbols the last scan never covered.
//   - Per-user positions are owner-only: getUserSupabase(user.token) + .eq('user_id', id).
//   - The shared signals read uses the ANON client (public, non-sensitive) — never the
//     service client.
//   - Side reads (signal map, price fallback) are best-effort: a miss → priceUnavailable,
//     never a throw.

import { getSupabase, getUserSupabase } from './supabase.js';
import { getVerifiedPrice } from './marketProviders.js';
import { exchangeColumnReady } from './schemaFlags.js';
import { normalizeExchange } from './exchanges.js';
import { buildSummary } from './portfolioMath.js';

// Cap on-demand verified-price fetches per request so a large all-uncovered portfolio
// can't fan out unboundedly and blow the 60s budget. Beyond this, holdings stay
// priceUnavailable (cost-basis only) rather than triggering more network round-trips.
const MAX_PRICE_FALLBACKS = 5;

// buildPortfolioSummary(user) -> the portfolioMath.buildSummary result (+ ok flag).
// `user` is the { id, token } from getUserFromRequest.
export async function buildPortfolioSummary(user) {
  const supabase = getUserSupabase(user?.token);
  if (!supabase || !user?.id) {
    return { ok: false, positions: [], totals: null, concentration: null };
  }

  // Owner-only read of this user's positions (RLS + explicit user_id filter).
  const { data, error } = await supabase
    .from('portfolios')
    .select('*')
    .eq('user_id', user.id)
    .order('opened_at', { ascending: false });
  if (error) throw error;
  const positions = data || [];

  if (!positions.length) {
    const empty = buildSummary([], {}, {});
    return { ok: true, ...empty };
  }

  // Only OPEN positions need a live price (closed ones mark against their sell_price);
  // sectors are wanted for every symbol so concentration + chat can name them.
  const openSymbols = [
    ...new Set(
      positions
        .filter((p) => String(p.status || '').toLowerCase() !== 'closed')
        .map((p) => String(p.symbol || '').toUpperCase())
        .filter(Boolean)
    ),
  ];
  const allSymbols = [
    ...new Set(positions.map((p) => String(p.symbol || '').toUpperCase()).filter(Boolean)),
  ];

  // (a) ONE batch read of the shared signals for every held symbol → latest per symbol.
  const { priceMap, sectorMap } = await sharedSignalMap(allSymbols, positions);

  // (b) Bounded on-demand fallback: OPEN symbols the last scan never covered.
  const missing = openSymbols.filter((s) => !priceMap[s]);
  for (const symbol of missing.slice(0, MAX_PRICE_FALLBACKS)) {
    const pos = positions.find((p) => String(p.symbol || '').toUpperCase() === symbol);
    try {
      const v = await getVerifiedPrice(symbol, { exchange: normalizeExchange(pos?.exchange) });
      if (v?.verified && Number.isFinite(Number(v.price))) {
        priceMap[symbol] = { price: Number(v.price), asOf: v.asOf ?? null, stale: Boolean(v.stale) };
      }
    } catch {
      /* best-effort — a miss just leaves the holding priceUnavailable (cost basis only) */
    }
  }

  const summary = buildSummary(positions, priceMap, sectorMap);
  return { ok: true, ...summary };
}

// sharedSignalMap(symbols, positions): assemble { priceMap, sectorMap } keyed by UPPERCASE
// symbol from the shared signals table via the ANON client. Reduces to the latest row per
// symbol (newest created_at wins). Scoped to the exchanges the user actually holds only
// when the exchange column exists (schemaFlags gate — an unmigrated DB skips the column
// so the query can't error). Best-effort: any failure → empty maps (everything falls to
// cost-basis / bounded fallback), never a throw.
async function sharedSignalMap(symbols, positions) {
  const priceMap = {};
  const sectorMap = {};
  if (!symbols.length) return { priceMap, sectorMap };

  try {
    const supabase = getSupabase();
    const hasExchange = await exchangeColumnReady();

    const cols = hasExchange
      ? 'symbol, exchange, price, sector, live_data, created_at'
      : 'symbol, price, sector, live_data, created_at';
    let query = supabase
      .from('signals')
      .select(cols)
      .in('symbol', symbols)
      .order('created_at', { ascending: false });

    if (hasExchange) {
      const exchanges = [
        ...new Set(positions.map((p) => normalizeExchange(p.exchange)).filter(Boolean)),
      ];
      if (exchanges.length) query = query.in('exchange', exchanges);
    }

    const { data } = await query;
    for (const row of data || []) {
      const sym = String(row.symbol || '').toUpperCase();
      if (!sym || priceMap[sym] || sectorMap[sym]) {
        // First row per symbol wins (rows arrive newest-first). Only skip once BOTH are
        // set; a row can carry a sector but a null price (or vice-versa).
        if (priceMap[sym] && sectorMap[sym]) continue;
      }
      const price = Number(row.price);
      if (!priceMap[sym] && Number.isFinite(price) && price > 0) {
        const live = row.live_data || {};
        priceMap[sym] = { price, asOf: live.asOf ?? null, stale: Boolean(live.stale) };
      }
      if (!sectorMap[sym] && row.sector) sectorMap[sym] = row.sector;
    }
  } catch {
    /* signals unreachable — everything falls back to cost-basis / bounded fetch */
  }

  return { priceMap, sectorMap };
}

// Server-side PAPER (simulated) account summary — the ONE place that turns a user's
// virtual cash + simulated positions into P&L + equity + concentration (Beginner §4.1).
//
// Mirrors portfolioSummary.js almost exactly (same shared-price sourcing, same bounded
// fallback, same buildSummary reuse) but over the SEPARATE per-user paper_accounts /
// paper_positions tables, and it prepends a virtual-cash + equity layer.
//
// STANDING RULES honored here:
//   - Prices are GROUND TRUTH, never LLM-sourced. This helper only READS already-computed
//     shared signal prices (+ a small bounded verified-price fallback). It never guesses.
//   - WRITE-ISOLATED: it reads the paper_* tables ONLY — the scan chain / track-record /
//     weights / knowledge never read them, and this never reads the real `portfolios`.
//   - Per-user rows are owner-only: getUserSupabase(user.token) + .eq('user_id', id).
//   - Probe-gated: on an unmigrated DB it returns { ok:true, enabled:false } — no paper
//     table is touched, so the app is byte-for-byte as today.
//   - Best-effort side reads (signal map, price fallback): a miss → priceUnavailable, not a throw.

import { getSupabase, getUserSupabase } from './supabase.js';
import { getVerifiedPrice } from './marketProviders.js';
import { exchangeColumnReady, paperTradingReady } from './schemaFlags.js';
import { normalizeExchange } from './exchanges.js';
import { buildSummary } from './portfolioMath.js';
import { STARTING_CASH } from './paperTrade.js';

// Cap on-demand verified-price fetches per request (same as portfolioSummary) so a large
// all-uncovered account can't fan out unboundedly and blow the 60s budget.
const MAX_PRICE_FALLBACKS = 5;

// ensurePaperAccount(user, supabase) -> the account row { cash, starting_cash, currency,
// reset_at }. Creates it (cash=STARTING_CASH) on first touch. Owner-scoped. Best-effort:
// on a write race it re-reads; on any hard failure it returns a synthetic default so the
// summary still renders (the real create happens on the next order).
export async function ensurePaperAccount(user, supabase) {
  const db = supabase || getUserSupabase(user?.token);
  if (!db || !user?.id) return { cash: STARTING_CASH, starting_cash: STARTING_CASH, currency: 'NPR', reset_at: null };

  const { data: existing } = await db
    .from('paper_accounts')
    .select('cash, starting_cash, currency, reset_at')
    .eq('user_id', user.id)
    .maybeSingle();
  if (existing) return existing;

  const row = { user_id: user.id, cash: STARTING_CASH, starting_cash: STARTING_CASH, currency: 'NPR' };
  const { data: created, error } = await db
    .from('paper_accounts')
    .insert(row)
    .select('cash, starting_cash, currency, reset_at')
    .single();
  if (!error && created) return created;

  // Lost an insert race (unique PK) → re-read the winner; else fall back to the default.
  const { data: reread } = await db
    .from('paper_accounts')
    .select('cash, starting_cash, currency, reset_at')
    .eq('user_id', user.id)
    .maybeSingle();
  return reread || { cash: STARTING_CASH, starting_cash: STARTING_CASH, currency: 'NPR', reset_at: null };
}

// buildPaperSummary(user) -> { ok, enabled?, account, positions, totals, concentration, equity }
// `user` is { id, token } from getUserFromRequest. Never throws.
export async function buildPaperSummary(user) {
  // Probe-gate: unmigrated DB → the feature is simply off.
  if (!(await paperTradingReady())) {
    return { ok: true, enabled: false };
  }

  const supabase = getUserSupabase(user?.token);
  if (!supabase || !user?.id) {
    return { ok: false, enabled: true, positions: [], totals: null, concentration: null };
  }

  const account = await ensurePaperAccount(user, supabase);

  // Owner-only read of this user's simulated positions (RLS + explicit user_id filter).
  const { data, error } = await supabase
    .from('paper_positions')
    .select('*')
    .eq('user_id', user.id)
    .order('opened_at', { ascending: false });
  if (error) throw error;
  const positions = data || [];

  const summary = positions.length ? await priced(positions) : buildSummary([], {}, {});
  return withEquity(account, summary);
}

// priced(positions): assemble prices (shared signals + bounded verified fallback) exactly
// like portfolioSummary, then run the shared buildSummary money engine.
async function priced(positions) {
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

  const { priceMap, sectorMap } = await sharedSignalMap(allSymbols, positions);

  const missing = openSymbols.filter((s) => !priceMap[s]);
  for (const symbol of missing.slice(0, MAX_PRICE_FALLBACKS)) {
    const pos = positions.find((p) => String(p.symbol || '').toUpperCase() === symbol);
    try {
      const v = await getVerifiedPrice(symbol, { exchange: normalizeExchange(pos?.exchange) });
      if (v?.verified && Number.isFinite(Number(v.price))) {
        priceMap[symbol] = { price: Number(v.price), asOf: v.asOf ?? null, stale: Boolean(v.stale) };
      }
    } catch {
      /* best-effort — a miss leaves the holding priceUnavailable (cost basis only) */
    }
  }

  return buildSummary(positions, priceMap, sectorMap);
}

// withEquity(account, summary): prepend the virtual-cash + equity layer to the portfolio
// summary. equity = cash + open positions' current value; return% is measured against the
// account's starting cash (the honest "how is my sim doing?" number).
function withEquity(account, summary) {
  const cash = Number(account?.cash) || 0;
  const startingCash = Number(account?.starting_cash) || STARTING_CASH;
  const positionsValue = Number(summary?.totals?.currentValue) || 0;
  const totalEquity = cash + positionsValue;
  const returnPct = startingCash > 0 ? ((totalEquity - startingCash) / startingCash) * 100 : 0;

  return {
    ok: true,
    enabled: true,
    account: {
      cash,
      startingCash,
      currency: account?.currency || 'NPR',
      resetAt: account?.reset_at ?? null,
    },
    positions: summary.positions,
    totals: summary.totals,
    concentration: summary.concentration,
    equity: { cash, positionsValue, totalEquity, returnPct },
  };
}

// sharedSignalMap(symbols, positions): { priceMap, sectorMap } from the shared signals
// table via the ANON client (public, non-sensitive). Reduces to the latest row per symbol.
// Identical discipline to portfolioSummary — best-effort, never throws.
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
      if (!sym) continue;
      if (priceMap[sym] && sectorMap[sym]) continue;
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

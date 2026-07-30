// Single source of truth for the "exchange" dimension (NEPSE, NYSE, ...).
//
// PURE + CLIENT-SAFE: no supabase, no server-only imports, no Node globals — this
// module is imported by BOTH the React client (NepseApp/Disclaimer) and the server
// (scan chain, learning loop), so it must stay a plain data + pure-function module.
//
// Each exchange declares:
//   id, name              — identity + display
//   currency, currencySymbol (`symbol` alias for the UI) — money framing
//   timezone, hours, source, flag — display metadata (ported from the old inline map)
//   sourceIds             — verified-price provider ids for this exchange (NEPSE uses
//                           the admin-selected sources, so its list is null/ignored)
//   reconcileOpts         — per-exchange opts merged into the verified-price core
//                           (marketData.js) — e.g. NYSE's wider plausibility ceiling
//   discoverySeed         — fixed fallback universe when LLM discovery yields nothing
//   disclaimer            — regulator-specific educational framing (SEBON vs SEC/FINRA)
//   marketLabel           — human label for the market scan prompt
//
// The verified-price CORE (marketData.js) is NOT exchange-aware and is NOT touched:
// exchange differences are injected purely as (a) which providers and (b) which
// reconcile opts. See marketProviders.getVerifiedPrice.

export const DEFAULT_EXCHANGE = 'NEPSE';

export const EXCHANGES = {
  NEPSE: {
    id: 'NEPSE',
    name: 'Nepal Stock Exchange',
    currency: 'NPR',
    currencySymbol: 'Rs',
    symbol: 'Rs',
    timezone: 'Asia/Kathmandu',
    hours: '11:00-15:00',
    source: 'merolagani.com',
    flag: 'NP',
    marketLabel: 'NEPSE (Nepal Stock Exchange)',
    // NEPSE uses the admin-selected market sources (merolagani/sample/…), so no fixed
    // sourceIds here — getVerifiedPrice keeps its existing getActiveSources() path.
    sourceIds: null,
    // NEPSE per-script circuit is ~10%; the core default already uses 12 — kept
    // explicit so both exchanges read their ceiling from the same place.
    reconcileOpts: { maxDailyMovePct: 12 },
    // NEPSE discovery is fully LLM-mover-driven; no fixed seed (empty → no fallback
    // universe beyond the movers, matching today's behaviour).
    discoverySeed: [],
    disclaimer: {
      regulator: 'SEBON',
      text:
        'Educational research, not financial advice. Signals are model-generated — verify independently before trading. Past performance ≠ future results.',
    },
  },
  NYSE: {
    id: 'NYSE',
    name: 'New York Stock Exchange',
    currency: 'USD',
    currencySymbol: '$',
    symbol: '$',
    timezone: 'America/New_York',
    hours: '09:30-16:00',
    source: 'finance.yahoo.com',
    flag: 'US',
    marketLabel: 'US large-cap equities (NYSE / Nasdaq)',
    // NYSE is single-source Yahoo for now (feature-gated behind ENABLE_NYSE via the
    // provider's requiresEnv). A second US source is a follow-up before any paid tier.
    sourceIds: ['yahoo'],
    // US earnings gaps routinely blow past NEPSE's ~10% circuit; 35% is the starting
    // plausibility ceiling (revisit after live data). Single-source, so requireTwoSources
    // stays false — matching NEPSE today.
    reconcileOpts: { maxDailyMovePct: 35 },
    // Fixed large-cap fallback universe when LLM movers discovery yields nothing.
    discoverySeed: [
      'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'JPM',
      'V', 'WMT', 'XOM', 'UNH', 'JNJ', 'PG', 'HD', 'BAC',
    ],
    disclaimer: {
      regulator: 'SEC/FINRA',
      text:
        'Educational research, not investment advice under SEC/FINRA rules. Signals are model-generated and for evaluation only — verify independently before trading. Past performance ≠ future results.',
    },
  },
};

// getExchange(id): resolve an exchange config, defaulting to NEPSE for null/unknown
// (pre-migration rows read as NEPSE — see the storage guardrail).
export function getExchange(id) {
  const key = String(id || DEFAULT_EXCHANGE).toUpperCase();
  return EXCHANGES[key] || EXCHANGES[DEFAULT_EXCHANGE];
}

// normalizeExchange(id): coerce any input to a known exchange id (default NEPSE).
export function normalizeExchange(id) {
  return getExchange(id).id;
}

// currencySymbolFor(id): the money prefix for an exchange ('Rs' / '$').
export function currencySymbolFor(id) {
  return getExchange(id).currencySymbol;
}

// scopeKey(exchange, key): namespace a learning-loop key (weights/knowledge) by
// exchange. NEPSE returns the key UNCHANGED so existing rows keep learning without a
// migration; every other exchange gets an `${EXCHANGE}:` prefix so it learns from its
// own outcomes in the SAME shared tables (no schema churn, no per-exchange column).
export function scopeKey(exchange, key) {
  if (key == null) return key;
  const ex = normalizeExchange(exchange);
  return ex === DEFAULT_EXCHANGE ? key : `${ex}:${key}`;
}

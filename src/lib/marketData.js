// Deterministic, verified market-data CORE (source-agnostic, pure, unit-tested).
//
// Prices used in signals and outcomes MUST be ground truth, never LLM-sourced
// (CLAUDE.md guardrail #1 — a hallucinated price is direct financial harm).
//
// Design principle: **correctness is the gate, freshness is metadata.** A quote
// that is 5 minutes, an hour, or even hours late is still acceptable *as long as it
// is TRUE* — so lateness never rejects a quote by default; it is annotated
// (`asOf` / `ageMs` / `stale`) so the UI can say "as of 2h ago" honestly. What DOES
// reject, failing CLOSED, is data we can't stand behind: non-positive prices,
// implausible moves, or sources that disagree. An unverified result must be treated
// by callers as "no data" (retryable), exactly like the hollow-signal guard.
//
// Which live sources feed this is a separate, admin-configurable choice — see
// marketProviders.js. A "provider" is just an async (symbol) => rawQuote|null.

const DEFAULTS = {
  maxDisagreementPct: 1.0, // two sources must agree within 1% to be trusted
  maxDailyMovePct: 12, // NEPSE per-script circuit is ~10%; >12% vs prevClose is implausible
  requireTwoSources: false, // when true, a lone surviving source is rejected
  staleAfterMs: 6 * 60 * 60 * 1000, // DISPLAY flag only — marks a quote "stale", never rejects
  rejectStale: false, // correctness > freshness: late-but-true is acceptable by default
  maxStalenessMs: 7 * 24 * 60 * 60 * 1000, // only consulted when rejectStale=true (absurdly-old guard)
  // caFactor (TIER-1 #1): a corporate-action price-adjustment factor (e.g. 0.833 for a
  // 20% bonus). DEFAULT undefined = the guard is UNCHANGED (byte-for-byte today). When
  // a finite positive number is supplied, the move check is measured against the
  // CA-ADJUSTED previous close (prevClose*caFactor) so a legit MECHANICAL ex-move
  // (bonus/rights/dividend) is accepted, while a move still implausible relative to the
  // adjusted base is correctly rejected. Ground-truth ex-dates/ratios only — never LLM.
  caFactor: undefined,
};

// A normalized quote: { symbol, price, prevClose|null, asOf(ms epoch)|null, source }.
// Returns null when there is no usable price — the one field we cannot do without.
export function normalizeQuote(raw, source) {
  if (!raw) return null;
  const price = num(raw.price);
  if (price == null) return null;
  return {
    symbol: raw.symbol ? String(raw.symbol).toUpperCase() : null,
    price,
    prevClose: num(raw.prevClose ?? raw.previousClose),
    asOf: toEpoch(raw.asOf),
    source: source || raw.source || 'unknown',
  };
}

// sanityCheck(quote, opts): is a single quote CORRECT-looking on its own?
// Freshness is intentionally NOT checked here (late-but-true is fine).
// Returns { ok: true } or { ok: false, reason }.
export function sanityCheck(quote, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const q = quote && quote.price != null ? quote : normalizeQuote(quote, quote?.source);
  if (!q || num(q.price) == null) return fail('no-price');
  if (q.price <= 0) return fail('non-positive-price');
  if (q.prevClose != null && q.prevClose > 0) {
    // TIER-1 #1: when a corporate-action factor is supplied, the mechanical ex-move is
    // expected, so compare against the ADJUSTED previous close (prevClose*caFactor) —
    // e.g. a 20% bonus (caFactor≈0.833) turns a raw −16.7% "crash" into ~0%. Absent a
    // finite positive caFactor, the base is the raw prevClose (unchanged behaviour).
    const caFactor = Number(o.caFactor);
    const base =
      Number.isFinite(caFactor) && caFactor > 0 ? q.prevClose * caFactor : q.prevClose;
    const movePct = Math.abs((q.price - base) / base) * 100;
    if (movePct > o.maxDailyMovePct) return fail(`implausible-move:${movePct.toFixed(1)}%`);
  }
  return { ok: true };
}

// reconcile(quotes, opts): given quotes for ONE symbol from >=1 sources, return a
// single verified price or a rejection. Fails closed on correctness; tolerant of age.
//   { verified: true,  price, asOf, ageMs, stale, sources }
//   { verified: false, reason, sources }
export function reconcile(quotes, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const clean = (quotes || []).map((q) => normalizeQuote(q, q?.source)).filter(Boolean);
  const sane = clean.filter((q) => sanityCheck(q, o).ok);

  if (sane.length === 0) return rej('no-sane-quote', clean.map(sourceOf));

  let price;
  let asOf;
  let sources;

  if (sane.length === 1) {
    if (o.requireTwoSources) return rej('single-source', sane.map(sourceOf));
    price = sane[0].price;
    asOf = sane[0].asOf;
    sources = sane.map(sourceOf);
  } else {
    // >=2 sources: require agreement within maxDisagreementPct.
    const prices = sane.map((q) => q.price);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const spreadPct = min > 0 ? ((max - min) / min) * 100 : Infinity;
    if (spreadPct > o.maxDisagreementPct) {
      return rej(`disagreement:${spreadPct.toFixed(2)}%`, sane.map(sourceOf));
    }
    price = median(prices); // robust to a single in-tolerance outlier
    asOf = Math.max(...sane.map((q) => q.asOf ?? 0)) || null;
    sources = sane.map(sourceOf);
  }

  // Freshness = metadata. Reject on age ONLY when the admin opts in (rejectStale).
  const ageMs = asOf != null && o.now != null ? Math.max(0, o.now - asOf) : null;
  if (o.rejectStale && ageMs != null && ageMs > o.maxStalenessMs) {
    return rej('stale', sources);
  }
  const stale = ageMs != null && ageMs > o.staleAfterMs;
  // Fundamentals ride along as best-effort METADATA off the winning provider's raw
  // quote — they never influence whether the price verified (the checks above are
  // untouched). normalizeQuote deliberately drops them, so we read them back from the
  // raw `quotes` by matching the surviving source(s), first non-null wins.
  const fundamentals = pickFundamentals(quotes, sources);
  // TIER-1 #3: the day RANGE [high, low] rides along as best-effort METADATA off the
  // winning provider(s), for path-dependent outcome resolution. Like fundamentals it
  // NEVER gates whether the price verified (the checks above are untouched) — an
  // implausible/inconsistent range is simply dropped to null.
  const range = pickRange(quotes, sources, price, o);
  return { verified: true, price, asOf: asOf ?? null, ageMs, stale, sources, fundamentals, range };
}

// pickRange(rawQuotes, sources, price, o): from the reconciled winning source list, the
// first raw quote carrying a day range that is INTERNALLY CONSISTENT (low>0, high>=low,
// and the verified price sits within [low, high]) AND PLAUSIBLE vs its prevClose (same
// maxDailyMovePct guard, CA-adjusted base when a caFactor is supplied). Pure, never
// throws — a bad range degrades to null (the resolver falls back to a degenerate spot
// range), never a wrong extreme.
function pickRange(quotes, sources, price, o) {
  try {
    const p = num(price);
    for (const src of sources || []) {
      const q = (quotes || []).find((x) => x && x.source === src && x.high != null && x.low != null);
      if (!q) continue;
      const high = num(q.high);
      const low = num(q.low);
      if (high == null || low == null) continue;
      // Internal consistency: a real day range brackets the verified price.
      if (!(low > 0 && high >= low && (p == null || (low <= p && p <= high)))) continue;
      // Plausibility vs prevClose — reuse the maxDailyMovePct move guard on both extremes.
      const prevClose = num(q.prevClose ?? q.previousClose);
      if (prevClose != null && prevClose > 0) {
        const caFactor = Number(o.caFactor);
        const base = Number.isFinite(caFactor) && caFactor > 0 ? prevClose * caFactor : prevClose;
        const hiMove = Math.abs((high - base) / base) * 100;
        const loMove = Math.abs((low - base) / base) * 100;
        if (hiMove > o.maxDailyMovePct || loMove > o.maxDailyMovePct) continue;
      }
      return { high, low };
    }
  } catch {
    /* metadata only — never break a verified price */
  }
  return null;
}

// pickFundamentals(rawQuotes, sources): from the reconciled winning source list, the
// first raw quote carrying a non-null `fundamentals` object. Pure, never throws.
function pickFundamentals(quotes, sources) {
  try {
    for (const src of sources || []) {
      const q = (quotes || []).find((x) => x && x.source === src && x.fundamentals);
      if (q) return q.fundamentals;
    }
  } catch {
    /* metadata only — never break a verified price */
  }
  return null;
}

// verifiedPrice(symbol, { providers, ...opts }): fetch from each provider, then
// reconcile. A provider is an async (symbol) => rawQuote|null; a throwing or slow
// provider is treated as "no quote", never as a failure of the whole lookup.
export async function verifiedPrice(symbol, { providers = [], ...opts } = {}) {
  if (!symbol || !providers.length) return rej('no-providers', []);
  const now = opts.now ?? Date.now();
  const raws = await Promise.all(
    providers.map(async (p) => {
      try {
        return await p(symbol);
      } catch {
        return null;
      }
    })
  );
  return reconcile(raws.filter(Boolean), { ...opts, now });
}

// resolveProviders(names, registry): map an ordered list (or comma string) of
// source names to their provider fns, dropping unknown names. Pure — the admin's
// MARKET_DATA_SOURCES config flows through here. Returns [{ name, fn }].
export function resolveProviders(names, registry = {}) {
  const list = Array.isArray(names) ? names : String(names || '').split(',');
  return list
    .map((s) => String(s).trim().toLowerCase())
    .filter(Boolean)
    .map((name) => ({ name, fn: registry[name] }))
    .filter((p) => typeof p.fn === 'function');
}

// --- helpers ---------------------------------------------------------------
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function toEpoch(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}
function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function sourceOf(q) {
  return q.source;
}
function fail(reason) {
  return { ok: false, reason };
}
function rej(reason, sources) {
  return { verified: false, reason, sources };
}

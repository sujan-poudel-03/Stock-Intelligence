// Pure liquidity primitives (no network, no @/) — TIER-2 "signal quality".
//
// The problem: a thinly-traded NEPSE script can print a "price", pass the verified
// layer, and still be untradeable for a retail order — the book is so shallow that a
// Rs50k–1L order moves it several percent and can't reliably exit the same session.
// So a signal on it is technically true but practically useless (and risky) advice.
//
// The metric is ground-truth Rupee TURNOVER (scraped from the ShareSansar board, which
// carries a Turnover column), falling back to price×volume only when turnover is absent.
// The LLM may REASON over a verified turnover number, but must NEVER set it — same rule
// as price (CLAUDE.md guardrail #1).
//
// Discipline: every function here is PURE and NEVER throws; on any bad/absent input it
// returns null/unchanged. Unknown liquidity (symbol missing from the board) is treated
// as UNKNOWN (null), and callers FAIL OPEN on it — an absent board must not silently
// drain the candidate pool.

// Below ~Rs20 lakh/day of turnover a retail Rs50k–1L order tends to move the book and
// can't reliably be exited the same session, so a swing signal there is untradeable.
export const MIN_TURNOVER_NPR = 2_000_000;

// resolveMinTurnover(settings): the admin-overridable threshold. Honors
// settings.min_turnover / settings.liquidity_min_turnover when a finite POSITIVE
// number; otherwise the default. (Rides kv_store settings like discovery_depth — no
// migration.)
export function resolveMinTurnover(settings = {}) {
  const raw = settings?.min_turnover ?? settings?.liquidity_min_turnover;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : MIN_TURNOVER_NPR;
}

// turnoverOf(row): the row's liquidity in Rupees. Prefer the scraped turnover; else
// derive price×volume; else null (unknown). Never throws.
export function turnoverOf(row) {
  if (!row) return null;
  const t = num(row.turnover);
  if (t != null && t > 0) return t;
  const price = num(row.price);
  const volume = num(row.volume);
  if (price != null && price > 0 && volume != null && volume > 0) return price * volume;
  return null;
}

// illiquidityOf(row, threshold): { turnover, illiquid }. illiquid is
//   true   — turnover known AND below the threshold
//   false  — turnover known AND at/above the threshold
//   null   — turnover unknown (fail-open signal to callers)
export function illiquidityOf(row, threshold = MIN_TURNOVER_NPR) {
  const turnover = turnoverOf(row);
  const min = Number.isFinite(Number(threshold)) && Number(threshold) > 0 ? Number(threshold) : MIN_TURNOVER_NPR;
  if (turnover == null) return { turnover: null, illiquid: null };
  return { turnover, illiquid: turnover < min };
}

// filterLiquidSymbols(symbols, board, threshold): drop ONLY symbols whose liquidity is
// KNOWN and below the threshold (illiquid === true). Keeps liquid names AND unknown
// ones (fail-open: a missing/empty board drops nothing). Pure, never throws.
export function filterLiquidSymbols(symbols, board = {}, threshold = MIN_TURNOVER_NPR) {
  const list = Array.isArray(symbols) ? symbols : [];
  try {
    return list.filter((sym) => {
      const key = String(sym || '').toUpperCase();
      const row = board ? board[key] : null;
      if (!row) return true; // unknown → keep (fail-open)
      return illiquidityOf(row, threshold).illiquid !== true;
    });
  } catch {
    return list; // never throw — fail open on the whole filter
  }
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

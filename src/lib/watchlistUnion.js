// Pure helper for building the GLOBAL scan universe from the union of every user's
// watchlist rows (Phase 2 step 4). Kept pure (no DB / IO) so it is unit-testable;
// the cron route runs the actual `select distinct symbol from watchlists` and hands
// the rows here. A symbol on 10 users' lists collapses to ONE scan — cost scales
// with distinct symbols, never user count (CLAUDE.md "market data is GLOBAL").
//
// Accepts either row objects ({ symbol }) or bare strings. Uppercases, trims, and
// dedupes; ignores blanks. Order follows first appearance (stable, test-friendly).
export function unionWatchlistSymbols(rows) {
  if (!Array.isArray(rows)) return [];
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const raw = typeof r === 'string' ? r : r && r.symbol;
    if (!raw) continue;
    const sym = String(raw).toUpperCase().trim();
    if (!sym || seen.has(sym)) continue;
    seen.add(sym);
    out.push(sym);
  }
  return out;
}

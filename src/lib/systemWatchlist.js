// Pure helpers for the GLOBAL system/seed watchlist (no DB / IO, never throws) so they
// are unit-testable; the cron + brief routes run the actual Supabase reads/writes and
// hand rows here. Aligned with unionWatchlistSymbols (src/lib/watchlistUnion.js) — the
// same uppercase/trim/dedupe discipline, extended to fold TWO row sets together.
//
// The system watchlist is a SINGLE GLOBAL list (NO user_id). buildScanUniverse folds
// it into the per-user watchlist union so the scan is never starved when discovery is
// empty. selectPromotions decides which HOLD symbols earn a slot in the curated list.

// buildScanUniverse({ userRows, systemRows }): the deduped, UPPERCASED union of the
// per-user watchlist rows and the global system_watchlist rows. seed/admin/discovery
// system rows are all kept (liquidity is already applied upstream at promotion-write
// time). Accepts row objects ({ symbol }) or bare strings; order follows first
// appearance (user rows first, then system), which is stable + test-friendly.
export function buildScanUniverse({ userRows, systemRows } = {}) {
  const seen = new Set();
  const out = [];
  const add = (rows) => {
    if (!Array.isArray(rows)) return;
    for (const r of rows) {
      const raw = typeof r === 'string' ? r : r && r.symbol;
      if (!raw) continue;
      const sym = String(raw).toUpperCase().trim();
      if (!sym || seen.has(sym)) continue;
      seen.add(sym);
      out.push(sym);
    }
  };
  add(userRows);
  add(systemRows);
  return out;
}

// selectPromotions(holdCountsBySymbol, { minAppearances }): the symbols whose HOLD
// appearance count over the recent window meets the threshold, so they earn a slot in
// the curated watchlist. Input is a plain map { SYMBOL: count }; output is uppercased,
// deduped, and drops blanks. Never throws; a bad/absent input yields [].
export function selectPromotions(holdCountsBySymbol, { minAppearances } = {}) {
  const min = Number.isFinite(Number(minAppearances)) && Number(minAppearances) > 0
    ? Number(minAppearances)
    : 1;
  if (!holdCountsBySymbol || typeof holdCountsBySymbol !== 'object') return [];
  const seen = new Set();
  const out = [];
  for (const [rawSym, rawCount] of Object.entries(holdCountsBySymbol)) {
    const sym = String(rawSym || '').toUpperCase().trim();
    if (!sym || seen.has(sym)) continue;
    const count = Number(rawCount);
    if (!Number.isFinite(count) || count < min) continue;
    seen.add(sym);
    out.push(sym);
  }
  return out;
}

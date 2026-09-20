// Pure parser for merolagani.com's NEPSE index history table (no network, no @/).
//
// Closes the "track record has no verified index benchmark" gap: until this, the
// only NEPSE index reading anywhere in the codebase came from scanMarket()'s LLM
// web search (src/lib/scan.js), which is fine for the Today-tab display but can
// never be recorded into price_history — that table's whole guarantee is "verified,
// never LLM-sourced" (see supabase/migrations/20260917000000_price_history.sql).
// merolagani.com/Indices.aspx server-renders a real, dated history table for the
// NEPSE Index itself — same domain already trusted for individual stock quotes
// (src/lib/marketProviders.js fetchMerolagani) — so this gives a second, genuinely
// verified index reading to record going forward.
//
// Deliberately parses ONLY the first (most recent) row. The table paginates via an
// ASP.NET postback (onclick="changePageIndex(...)"), not a plain "?page=" query
// string, so fetching older pages would mean simulating that postback — real but
// meaningfully more fragile, and not needed for the "record one verified bar per
// day going forward" use case this feeds. No historical backfill is attempted; the
// benchmark starts empty and builds forward, same honest pattern as price_history
// itself.

// parseMerolaganiIndexLatest(html) -> { date: 'YYYY/MM/DD', value: Number, changePct: Number } | null
// Never throws; returns null for anything that doesn't look like a genuine row
// (missing table, non-numeric value, etc.) rather than guessing.
export function parseMerolaganiIndexLatest(html) {
  try {
    if (!html || typeof html !== 'string') return null;
    const tbody = html.match(/<tbody[\s\S]*?<\/tbody>/i);
    if (!tbody) return null;
    const firstRow = tbody[0].match(/<tr[\s\S]*?<\/tr>/i);
    if (!firstRow) return null;
    const cells = [...firstRow[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => flat(m[1]));
    if (cells.length < 5) return null;

    const date = cells[1]; // 'YYYY/MM/DD'
    const value = num(cells[2]);
    const changePct = num(cells[4].replace('%', ''));
    if (!/^\d{4}\/\d{2}\/\d{2}$/.test(date)) return null;
    if (!(value > 0)) return null;

    return { date, value, changePct: Number.isFinite(changePct) ? changePct : null };
  } catch {
    return null;
  }
}

function flat(s) {
  return String(s).replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
}
function num(s) {
  const n = Number(String(s).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

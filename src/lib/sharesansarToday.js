// Pure parser for the ShareSansar "Today's Share Price" table (no network, no @/).
//
// ShareSansar's per-company page loads its last price via a CSRF/AJAX flow that can't
// be fetched deterministically without executing JS. The "Today's Share Price" page
// (/today-share-price), by contrast, SERVER-RENDERS the full board: one HTML table
// with every symbol's LTP + Prev. Close. So the second cross-check source parses that
// ONE table for all symbols (the provider fetches it once per cycle and serves each
// symbol from a short-lived cache — see marketProviders.fetchSharesansar).
//
// Columns are located by HEADER NAME (not a fixed index) so a future column insertion
// on the site doesn't silently shift the price we read. Like the merolagani parser,
// this is best-effort METADATA discipline: it never throws and returns {} for junk,
// so a layout change degrades to "no 2nd source" (single-source merolagani) rather
// than a wrong price or a crash.

// parseSharesansarToday(html) -> { [SYMBOL]: { price:Number, prevClose:Number|null } }
// price is the LTP column; prevClose is the "Prev. Close" column when numeric, else
// null. Rows without a usable symbol + positive LTP are skipped. Pure; never throws.
export function parseSharesansarToday(html) {
  const out = {};
  try {
    if (!html || typeof html !== 'string') return out;

    // Map column name -> index from the header row (robust to column additions).
    const thead = html.match(/<thead[\s\S]*?<\/thead>/i);
    if (!thead) return out;
    const headers = [...thead[0].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((m) =>
      flat(m[1]).toLowerCase()
    );
    const symIdx = headers.indexOf('symbol');
    const ltpIdx = headers.indexOf('ltp');
    const prevIdx = headers.findIndex((h) => /prev.*\.?\s*close/.test(h));
    if (symIdx < 0 || ltpIdx < 0) return out;

    // Parse each BODY row (after the header) into symbol -> { price, prevClose }.
    const bodyStart = thead.index + thead[0].length;
    const rows = html.slice(bodyStart).match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
    for (const row of rows) {
      const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => flat(m[1]));
      if (cells.length <= Math.max(symIdx, ltpIdx, prevIdx)) continue;
      const sym = cells[symIdx].toUpperCase();
      // A real symbol starts alphanumeric; skips spacer/total rows with no symbol.
      if (!sym || !/^[A-Z0-9]/.test(sym)) continue;
      const price = toNum(cells[ltpIdx]);
      if (price == null || price <= 0) continue;
      const prev = prevIdx >= 0 ? toNum(cells[prevIdx]) : null;
      out[sym] = { price, prevClose: prev != null && prev > 0 ? prev : null };
    }
    return out;
  } catch {
    return out;
  }
}

function flat(s) {
  return String(s)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toNum(s) {
  const n = Number(String(s).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

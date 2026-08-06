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

// parseSharesansarToday(html) ->
//   { [SYMBOL]: { price:Number, prevClose:Number|null, high:Number|null, low:Number|null,
//                 volume:Number|null, turnover:Number|null } }
// price is the LTP column; prevClose is "Prev. Close"; high/low are the day's "High"/"Low"
// columns (TIER-1 #3 — path-dependent outcome resolution needs the day RANGE, ground
// truth). volume ("Vol"/"Volume"/"Qty") + turnover ("Turnover"/"Amount") ride along as
// ground-truth LIQUIDITY (TIER-2) — the Rupee turnover, or share volume as a fallback
// input to price×volume downstream. All ancillary fields are null when their column is
// absent/non-numeric. high/low are emitted only as a consistent pair (high>=low>0), else
// both null. Rows without a usable symbol + positive LTP are skipped. Pure; never throws.
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
    // Day range columns: match "High"/"Max" and "Low"/"Min" but NOT the "52 Week
    // High/Low" columns, which the board also carries — those are yearly, not daily.
    const highIdx = headers.findIndex((h) => !/52/.test(h) && /^(high|max)$/.test(h));
    const lowIdx = headers.findIndex((h) => !/52/.test(h) && /^(low|min)$/.test(h));
    // Liquidity columns (TIER-2): share Volume ("Vol"/"Volume"/"Qty") + Rupee Turnover
    // ("Turnover"/"Amount"), matched exactly so "VWAP" / "Range" don't get mistaken.
    const volIdx = headers.findIndex((h) => /^(vol|volume|qty)$/.test(h));
    const turnIdx = headers.findIndex((h) => /^(turnover|amount)$/.test(h));
    if (symIdx < 0 || ltpIdx < 0) return out;

    // Parse each BODY row (after the header) into symbol -> { price, prevClose, high, low }.
    const bodyStart = thead.index + thead[0].length;
    const rows = html.slice(bodyStart).match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
    for (const row of rows) {
      const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => flat(m[1]));
      const maxIdx = Math.max(symIdx, ltpIdx, prevIdx, highIdx, lowIdx, volIdx, turnIdx);
      if (cells.length <= maxIdx) continue;
      const sym = cells[symIdx].toUpperCase();
      // A real symbol starts alphanumeric; skips spacer/total rows with no symbol.
      if (!sym || !/^[A-Z0-9]/.test(sym)) continue;
      const price = toNum(cells[ltpIdx]);
      if (price == null || price <= 0) continue;
      const prev = prevIdx >= 0 ? toNum(cells[prevIdx]) : null;
      const { high, low } = extractRange(
        highIdx >= 0 ? toNum(cells[highIdx]) : null,
        lowIdx >= 0 ? toNum(cells[lowIdx]) : null
      );
      // Liquidity: emit only a finite positive figure, else null (never a zero/junk).
      const volume = volIdx >= 0 ? posOrNull(toNum(cells[volIdx])) : null;
      const turnover = turnIdx >= 0 ? posOrNull(toNum(cells[turnIdx])) : null;
      out[sym] = { price, prevClose: prev != null && prev > 0 ? prev : null, high, low, volume, turnover };
    }
    return out;
  } catch {
    return out;
  }
}

// extractRange(high, low): only a consistent pair (both numeric, high>=low>0) survives;
// anything else collapses BOTH to null so a half-parsed range can't leak a wrong extreme.
function extractRange(high, low) {
  const h = Number.isFinite(high) && high > 0 ? high : null;
  const l = Number.isFinite(low) && low > 0 ? low : null;
  if (h == null || l == null || h < l) return { high: null, low: null };
  return { high: h, low: l };
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

// A finite positive number, else null — liquidity figures are emitted only when real.
function posOrNull(n) {
  return Number.isFinite(n) && n > 0 ? n : null;
}

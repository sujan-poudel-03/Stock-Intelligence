// Pure parser for MeroLagani CompanyDetail fundamentals (no network, no @/).
//
// The verified-price CORE only needs the last price; but the same server-rendered
// CompanyDetail page also carries the fundamentals the stock-detail overlay wants
// (52-week high/low, day averages, yield, EPS, P/E, book value, PBV, dividend).
// This module extracts those as best-effort METADATA — it never throws and returns
// null for any field it cannot find, so a layout change degrades to "-" in the UI
// rather than breaking the price fetch that rides on the same HTML.
//
// Approach: strip tags, collapse whitespace, then regex each field from the flat
// text. All patterns tolerate commas + decimals; commas are stripped before Number.

// parseMerolaganiFundamentals(html) -> {
//   week52_high, week52_low, avg180, avg120, yield, eps, pe, bv, pbv, div_pct
// } — each a finite Number or null. Pure; never throws.
export function parseMerolaganiFundamentals(html) {
  const empty = {
    week52_high: null,
    week52_low: null,
    avg180: null,
    avg120: null,
    yield: null,
    eps: null,
    pe: null,
    bv: null,
    pbv: null,
    div_pct: null,
  };
  try {
    if (!html || typeof html !== 'string') return empty;
    // Flatten: drop tags, collapse all whitespace to single spaces.
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

    const hl = text.match(/52\s*Weeks?\s*High\s*-\s*Low\s+([\d,]+\.?\d*)\s*-\s*([\d,]+\.?\d*)/i);

    return {
      week52_high: hl ? toNum(hl[1]) : null,
      week52_low: hl ? toNum(hl[2]) : null,
      avg180: pick(text, /180\s*Day\s*Average\s+([\d,]+\.?\d*)/i),
      avg120: pick(text, /120\s*Day\s*Average\s+([\d,]+\.?\d*)/i),
      yield: pick(text, /1\s*Year\s*Yield\s+([\d,]+\.?\d*)\s*%/i),
      eps: pick(text, /\bEPS\s+([\d,]+\.?\d*)/i),
      pe: pick(text, /P\s*\/\s*E\s*Ratio\s+([\d,]+\.?\d*)/i),
      bv: pick(text, /Book\s*Value\s+([\d,]+\.?\d*)/i),
      pbv: pick(text, /\bPBV\s+([\d,]+\.?\d*)/i),
      div_pct: pick(text, /%\s*Dividend\s+([\d,]+\.?\d*)/i),
    };
  } catch {
    return empty;
  }
}

function pick(text, re) {
  const m = text.match(re);
  return m ? toNum(m[1]) : null;
}

function toNum(s) {
  const n = Number(String(s).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

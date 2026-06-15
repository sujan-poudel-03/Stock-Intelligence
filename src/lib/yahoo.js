// Yahoo Finance quote fetch — no API key required.
// Used when exchange === 'NYSE' (Level 2 / coming soon).
//
// fetchYahooStock(symbol) -> {
//   symbol, price, currency, change, changePct, previousClose,
//   dayHigh, dayLow, marketState, name, raw
// } | null

const QUOTE_URL = 'https://query1.finance.yahoo.com/v8/finance/chart/';

export async function fetchYahooStock(symbol) {
  if (!symbol) return null;
  const url = `${QUOTE_URL}${encodeURIComponent(symbol)}?interval=1d&range=1d`;

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (NEPSE-Intelligence/2.0)' },
      cache: 'no-store',
    });
    if (!res.ok) return null;

    const json = await res.json();
    const result = json?.chart?.result?.[0];
    const meta = result?.meta;
    if (!meta) return null;

    const price = meta.regularMarketPrice ?? null;
    const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? null;
    const change = price != null && prevClose != null ? price - prevClose : null;
    const changePct = change != null && prevClose ? (change / prevClose) * 100 : null;

    return {
      symbol: meta.symbol || symbol,
      name: meta.longName || meta.shortName || symbol,
      price,
      currency: meta.currency || 'USD',
      previousClose: prevClose,
      change,
      changePct,
      dayHigh: meta.regularMarketDayHigh ?? null,
      dayLow: meta.regularMarketDayLow ?? null,
      marketState: meta.marketState || null,
      raw: meta,
    };
  } catch (err) {
    console.error(`fetchYahooStock(${symbol}) failed:`, err?.message || err);
    return null;
  }
}

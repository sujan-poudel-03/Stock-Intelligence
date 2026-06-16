import { callLLM, parseJson } from './llm.js';
import { getWeightContext } from './calibration.js';

// ---------------------------------------------------------------------------
// scanMarket(): fetch NEPSE index, gainers, losers, turnover via web search.
// ---------------------------------------------------------------------------
export async function scanMarket() {
  const prompt = `Search the web for today's live NEPSE (Nepal Stock Exchange) market data from sources like merolagani.com, nepalstock.com.np, or sharesansar.com.

Return ONLY a JSON object with this exact shape (no prose, no markdown):
{
  "index": <NEPSE index value as a number>,
  "change": <index point change as a number>,
  "changePct": <index percent change as a number>,
  "turnover": <total market turnover in NPR as a number>,
  "sentiment": "<BULLISH | BEARISH | NEUTRAL>",
  "gainers": [{"symbol": "XXX", "price": <num>, "changePct": <num>}, ...up to 8],
  "losers": [{"symbol": "XXX", "price": <num>, "changePct": <num>}, ...up to 8],
  "asOf": "<ISO date or human time string>"
}`;

  const text = await callLLM(prompt, {
    webSearch: true,
    webFetch: true,
    maxTokens: 3000,
    system:
      'You are a NEPSE market data extraction agent. You return only valid JSON. Use the most recent live data you can find.',
  });

  const data = parseJson(text) || {};
  return {
    index: numOrNull(data.index),
    change: numOrNull(data.change),
    changePct: numOrNull(data.changePct),
    turnover: numOrNull(data.turnover),
    sentiment: data.sentiment || 'NEUTRAL',
    gainers: Array.isArray(data.gainers) ? data.gainers : [],
    losers: Array.isArray(data.losers) ? data.losers : [],
    asOf: data.asOf || new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// runDiscovery(movers, settings): pick the best N symbols to scan.
// `movers` is the market object from scanMarket(). settings.discoverCount = N.
// ---------------------------------------------------------------------------
export async function runDiscovery(movers, settings = {}) {
  const n = settings.discoverCount || 8;
  const gainers = (movers?.gainers || []).map((g) => g.symbol).filter(Boolean);
  const losers = (movers?.losers || []).map((l) => l.symbol).filter(Boolean);
  const pool = [...new Set([...gainers, ...losers])];

  if (pool.length === 0) return [];
  if (pool.length <= n) return pool.slice(0, n);

  const prompt = `From today's NEPSE movers, select the ${n} symbols with the best short-term swing-trade potential.

Market sentiment: ${movers?.sentiment || 'NEUTRAL'}
Top gainers: ${gainers.join(', ') || 'none'}
Top losers: ${losers.join(', ') || 'none'}

Pick a balanced set favouring liquidity, momentum, and clear technical setups.
Return ONLY a JSON array of ${n} ticker strings, e.g. ["NABIL","UPPER","NICA"].`;

  const text = await callLLM(prompt, {
    maxTokens: 500,
    system: 'You are a NEPSE stock discovery agent. Return only a JSON array of ticker symbols.',
  });

  const picked = parseJson(text);
  if (Array.isArray(picked) && picked.length) {
    return picked.filter(Boolean).slice(0, n);
  }
  return pool.slice(0, n);
}

// ---------------------------------------------------------------------------
// scanOneStock(symbol, marketData, weights):
//   fetch fresh stock data from merolagani via web search and generate a signal.
//   `weights` is an optional pre-fetched weight-context string; when omitted it
//   is looked up via getWeightContext().
// ---------------------------------------------------------------------------
export async function scanOneStock(symbol, marketData = {}, weights = null) {
  const fetchPrompt = `Search merolagani.com (and sharesansar.com as backup) for the current trading data of NEPSE stock "${symbol}".

Return ONLY JSON:
{
  "symbol": "${symbol}",
  "price": <last traded price as number>,
  "change": <day change as number>,
  "changePct": <day percent change as number>,
  "high52": <52-week high or null>,
  "low52": <52-week low or null>,
  "volume": <today's volume or null>,
  "sector": "<sector name e.g. Commercial Banks, Hydropower, Microfinance>",
  "pe": <P/E ratio or null>
}`;

  const liveText = await callLLM(fetchPrompt, {
    webSearch: true,
    webFetch: true,
    maxTokens: 1500,
    system: 'You are a NEPSE stock data extraction agent. Return only valid JSON with live data.',
  });

  const live = parseJson(liveText) || { symbol };
  const sector = live.sector || null;

  const weightContext =
    weights != null ? weights : await getWeightContext(symbol, sector);

  const signalPrompt = `You are a disciplined NEPSE swing-trading analyst. Generate ONE trade signal for ${symbol}.

LIVE DATA:
${JSON.stringify(live, null, 2)}

MARKET CONTEXT:
Index: ${marketData.index ?? 'n/a'} (${marketData.changePct ?? 'n/a'}%), sentiment: ${marketData.sentiment ?? 'NEUTRAL'}

AGENT TRACK RECORD (calibration — weigh this when setting confidence):
${weightContext || 'No prior track record yet.'}

Return ONLY JSON with this exact shape:
{
  "symbol": "${symbol}",
  "signal": "<BUY | SELL | HOLD | AVOID>",
  "confidence": "<HIGH | MEDIUM | LOW>",
  "price": <current price as number>,
  "entry": "<entry zone description>",
  "sl": <stop-loss price as number>,
  "target": <target price as number>,
  "hold": "<expected hold period e.g. '1-2 weeks'>",
  "why": "<1-2 sentence rationale>",
  "risk": "<key risk in one sentence>",
  "action": "<concise next action>",
  "sector": "<sector>"
}`;

  const signalText = await callLLM(signalPrompt, {
    maxTokens: 1200,
    system: 'You are a NEPSE trading signal generator. Return only valid JSON. Be disciplined and risk-aware.',
  });

  const signal = parseJson(signalText) || {};

  return {
    symbol,
    signal: signal.signal || 'HOLD',
    confidence: signal.confidence || 'LOW',
    price: numOrNull(signal.price ?? live.price),
    entry: signal.entry || null,
    sl: numOrNull(signal.sl),
    target: numOrNull(signal.target),
    hold: signal.hold || null,
    why: signal.why || null,
    risk: signal.risk || null,
    action: signal.action || null,
    source: 'merolagani',
    sector: signal.sector || sector || null,
    live_data: live,
  };
}

// ---------------------------------------------------------------------------
// runBrief(signals, marketData, portfolio): generate the daily brief.
// ---------------------------------------------------------------------------
export async function runBrief(signals = [], marketData = {}, portfolio = []) {
  const summary = signals.map((s) => ({
    symbol: s.symbol,
    signal: s.signal,
    confidence: s.confidence,
    price: s.price,
    target: s.target,
    sl: s.sl,
  }));

  const prompt = `You are the lead analyst writing today's NEPSE trading brief.

MARKET:
${JSON.stringify(marketData, null, 2)}

SIGNALS (${signals.length}):
${JSON.stringify(summary, null, 2)}

CURRENT PORTFOLIO:
${JSON.stringify(portfolio, null, 2)}

Return ONLY JSON:
{
  "headline": "<one-line market headline>",
  "summary": "<2-3 sentence market read>",
  "topPicks": ["<symbol>", ...up to 3 best ideas],
  "watch": ["<symbol>", ...stocks to watch],
  "risks": "<key risk note>",
  "stale": ["<symbols to consider removing from watchlist>"]
}`;

  const text = await callLLM(prompt, {
    maxTokens: 1500,
    system: 'You are a NEPSE market brief writer. Return only valid JSON.',
  });

  // Budget exhausted / LLM unavailable -> build a useful brief from the signals
  // we already have, so the scan still finishes with output (never blank).
  const brief = parseJson(text);
  if (!brief) return deterministicBrief(signals, marketData);

  return {
    headline: brief.headline || 'NEPSE daily brief',
    summary: brief.summary || '',
    topPicks: Array.isArray(brief.topPicks) ? brief.topPicks : [],
    watch: Array.isArray(brief.watch) ? brief.watch : [],
    risks: brief.risks || '',
    stale: Array.isArray(brief.stale) ? brief.stale : [],
    generatedAt: new Date().toISOString(),
  };
}

// Build a brief from signals without an LLM call (used when the daily budget is
// spent). Deterministic so the scan always produces something actionable.
function deterministicBrief(signals = [], marketData = {}) {
  const rank = { HIGH: 3, MEDIUM: 2, LOW: 1 };
  const buys = signals.filter((s) => s.signal === 'BUY');
  const topPicks = buys
    .slice()
    .sort((a, b) => (rank[b.confidence] || 0) - (rank[a.confidence] || 0))
    .slice(0, 3)
    .map((s) => s.symbol);
  const watch = signals
    .filter((s) => s.signal === 'HOLD' || s.confidence === 'MEDIUM')
    .map((s) => s.symbol)
    .slice(0, 8);
  const sentiment = marketData?.sentiment || 'NEUTRAL';

  return {
    headline: `NEPSE ${sentiment} — ${signals.length} signal${signals.length === 1 ? '' : 's'} (auto-summary)`,
    summary: `Brief generated without LLM (daily call budget reached). ${buys.length} BUY and ${signals.length - buys.length} other signal(s) from this scan.`,
    topPicks,
    watch,
    risks: 'Budget-limited scan — review signals individually; brief was generated deterministically.',
    stale: [],
    generatedAt: new Date().toISOString(),
  };
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

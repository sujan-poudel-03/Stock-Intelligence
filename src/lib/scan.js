import { callLLM, parseJson } from './llm.js';
import { getWeightContext } from './calibration.js';
import { getKnowledgeContext } from './knowledge.js';

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
export async function scanOneStock(symbol, marketData = {}, weights = null, knowledge = null) {
  // Calibration + learned knowledge are keyed by symbol (and sector once known).
  // We fetch them up front with a null sector — the single grounded call below
  // both pulls live data AND emits the signal, so there's no intermediate step
  // at which the sector is known. This halves per-stock LLM cost (1 call, not 2)
  // and the rate-limit pressure that comes with it.
  const weightContext = weights != null ? weights : await getWeightContext(symbol, null);
  const knowledgeContext = knowledge != null ? knowledge : await getKnowledgeContext(symbol, null);

  const prompt = `You are a disciplined NEPSE swing-trading analyst. Research stock "${symbol}" and produce ONE trade signal.

STEP 1 — Search merolagani.com (and sharesansar.com as backup) for ${symbol}'s current trading data: last price, day change, 52-week high/low, volume, sector, P/E.
STEP 2 — Using that live data plus the context below, decide the signal.

MARKET CONTEXT:
Index: ${marketData.index ?? 'n/a'} (${marketData.changePct ?? 'n/a'}%), sentiment: ${marketData.sentiment ?? 'NEUTRAL'}

AGENT TRACK RECORD (calibration — weigh this when setting confidence):
${weightContext || 'No prior track record yet.'}

LEARNED KNOWLEDGE (past outcomes & notes for this stock/sector — apply these lessons):
${knowledgeContext || 'No accumulated knowledge yet.'}

Return ONLY JSON with this exact shape (no prose, no markdown):
{
  "symbol": "${symbol}",
  "price": <last traded price as number>,
  "change": <day change as number or null>,
  "changePct": <day percent change as number or null>,
  "high52": <52-week high or null>,
  "low52": <52-week low or null>,
  "volume": <today's volume or null>,
  "pe": <P/E ratio or null>,
  "sector": "<sector name e.g. Commercial Banks, Hydropower, Microfinance>",
  "signal": "<BUY | SELL | HOLD | AVOID>",
  "confidence": "<HIGH | MEDIUM | LOW>",
  "entry": "<entry zone description>",
  "sl": <stop-loss price as number>,
  "target": <target price as number>,
  "hold": "<expected hold period e.g. '1-2 weeks'>",
  "why": "<1-2 sentence rationale>",
  "risk": "<key risk in one sentence>",
  "action": "<concise next action>"
}`;

  const text = await callLLM(prompt, {
    webSearch: true,
    webFetch: true,
    maxTokens: 2500,
    system:
      'You are a NEPSE research + trading signal agent. Fetch live data, then return only valid JSON. Be disciplined and risk-aware.',
  });

  const r = parseJson(text) || {};
  const sector = r.sector || null;
  const price = numOrNull(r.price);

  // FIX 4 — never persist a hollow signal. No price => no usable signal; throw so
  // the worker surfaces this as a failed job (red badge + retry) instead of saving
  // an empty card. (deterministicSignal handles the budget-exhausted case upstream
  // using a last-known price.)
  if (!price || price <= 0) {
    throw new Error(`no data from source: ${symbol}`);
  }

  // Preserve the live-data subset we used to store separately, for outcome
  // auditing and the UI's live_data view.
  const live = {
    symbol,
    price,
    change: numOrNull(r.change),
    changePct: numOrNull(r.changePct),
    high52: numOrNull(r.high52),
    low52: numOrNull(r.low52),
    volume: numOrNull(r.volume),
    pe: numOrNull(r.pe),
    sector,
  };

  // FIX 2 — fill any missing/zero targets deterministically so every persisted
  // signal has real sl/target/entry. Keeps the model's signal verb + rationale.
  const t = calcTargets({ entry: r.entry, sl: numOrNull(r.sl), target: numOrNull(r.target) }, price);

  return {
    symbol,
    signal: r.signal || 'HOLD',
    confidence: r.confidence || 'LOW',
    price,
    entry: t.entry,
    sl: t.sl,
    target: t.target,
    hold: r.hold || null,
    why: r.why || null,
    risk: r.risk || null,
    action: r.action || null,
    source: 'merolagani',
    sector,
    live_data: { ...live, targets_calculated: t.calculated },
  };
}

// calcTargets(sig, price): fill missing/zero entry/sl/target deterministically.
// 5% stop, 8% target, ±1% entry band. Returns { entry, sl, target, calculated }.
function calcTargets(sig, price) {
  let calculated = false;
  let sl = numOrNull(sig.sl);
  let target = numOrNull(sig.target);
  let entry = sig.entry;

  if (!sl || sl <= 0) {
    sl = Math.round(price * 0.95);
    calculated = true;
  }
  if (!target || target <= 0) {
    target = Math.round(price * 1.08);
    calculated = true;
  }
  if (!entry || entry === '' || entry === 'N/A') {
    entry = `Rs ${Math.round(price * 0.99)}-Rs ${Math.round(price * 1.01)}`;
    calculated = true;
  }
  return { entry, sl, target, calculated };
}

// deterministicSignal(stockData): a no-LLM fallback used when the daily budget is
// spent. Needs a price (e.g. the last known price for the symbol). Classifies on
// price vs a 120-day average when available, else HOLD, with calculated targets.
export function deterministicSignal(stockData = {}) {
  const price = numOrNull(stockData.price);
  if (!price || price <= 0) return null;

  const avg = numOrNull(stockData.avg120) || price;
  let signal = 'HOLD';
  if (price > avg * 1.02) signal = 'WATCH';
  else if (price < avg * 0.98) signal = 'NEUTRAL';

  const t = calcTargets({}, price);
  return {
    symbol: stockData.symbol,
    signal,
    confidence: 'LOW',
    price,
    entry: t.entry,
    sl: t.sl,
    target: t.target,
    hold: null,
    why: 'Deterministic signal (LLM budget reached). Based on price vs 120-day average.',
    risk: 'Auto-generated without live analysis — verify before acting.',
    action: null,
    source: 'deterministic',
    sector: stockData.sector || null,
    live_data: { ...stockData, price, targets_calculated: true },
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

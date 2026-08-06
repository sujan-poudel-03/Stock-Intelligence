import { callLLM, parseJson } from './llm.js';
import { getWeightContext, getOverviewContext } from './calibration.js';
import { getKnowledgeContext } from './knowledge.js';
import { getVerifiedPrice, getLiquidityBoard } from './marketProviders.js';
import { getExchange, currencySymbolFor, DEFAULT_EXCHANGE } from './exchanges.js';
import { resolveMinTurnover, filterLiquidSymbols, illiquidityOf, MIN_TURNOVER_NPR } from './liquidity.js';
import { getSupabase } from './supabase.js';
import { getActiveAdjustment } from './corporateActions.js';
import { corporateActionsReady } from './schemaFlags.js';

// ---------------------------------------------------------------------------
// scanMarket(exchange): fetch the exchange's index, gainers, losers, turnover via
// web search. NEPSE (default) keeps its exact prompt; NYSE re-frames for US indices
// and movers. Both share the same deterministic fallback (empty movers on junk).
// ---------------------------------------------------------------------------
export async function scanMarket(exchange = DEFAULT_EXCHANGE) {
  const ex = getExchange(exchange);
  const prompt =
    ex.id === 'NEPSE'
      ? `Search the web for today's live NEPSE (Nepal Stock Exchange) market data from sources like merolagani.com, nepalstock.com.np, or sharesansar.com.

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
}`
      : `Search the web for today's live US stock market data (${ex.marketLabel}) from sources like finance.yahoo.com, cnbc.com, or marketwatch.com. Use the S&P 500 as the headline index and the day's biggest large-cap movers.

Return ONLY a JSON object with this exact shape (no prose, no markdown):
{
  "index": <S&P 500 index value as a number>,
  "change": <index point change as a number>,
  "changePct": <index percent change as a number>,
  "turnover": <total market volume/turnover in USD as a number>,
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
      ex.id === 'NEPSE'
        ? 'You are a NEPSE market data extraction agent. You return only valid JSON. Use the most recent live data you can find.'
        : 'You are a US equities (NYSE/Nasdaq) market data extraction agent. You return only valid JSON. Use the most recent live data you can find.',
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
// runDiscovery(movers, settings, exchange): pick the best N symbols to scan.
// `movers` is the market object from scanMarket(). settings.discoverCount = N.
// When the movers pool is empty (e.g. NYSE web-search returned nothing), fall back
// to the exchange's fixed discoverySeed so a scan still has a universe.
// ---------------------------------------------------------------------------
export async function runDiscovery(movers, settings = {}, exchange = DEFAULT_EXCHANGE) {
  const ex = getExchange(exchange);
  // Accept either the V2 key (discoverCount) or the V1 Settings-tab key
  // (discovery_depth) so the ported UI steers discovery directly.
  const n = settings.discoverCount || settings.discovery_depth || 8;
  const gainers = (movers?.gainers || []).map((g) => g.symbol).filter(Boolean);
  const losers = (movers?.losers || []).map((l) => l.symbol).filter(Boolean);
  let pool = [...new Set([...gainers, ...losers])];

  // TIER-2 liquidity HARD FILTER (NEPSE only): drop candidates whose ground-truth Rupee
  // turnover is KNOWN to be below the threshold, BEFORE the LLM prompt and every
  // pool-based fallback below — so thin names that a retail order can't cleanly enter/exit
  // never reach a signal. Reuses the already-cached ShareSansar board (no new round-trip).
  // FAIL-OPEN: an empty board / unknown symbol drops nothing. NYSE seed path is unfiltered.
  if (ex.id === DEFAULT_EXCHANGE && pool.length) {
    try {
      const board = await getLiquidityBoard();
      pool = filterLiquidSymbols(pool, board, resolveMinTurnover(settings));
    } catch {
      /* liquidity board unavailable — fail open, keep the full pool */
    }
  }

  // No movers to work from → fall back to the exchange's seed universe (empty for
  // NEPSE, a fixed large-cap list for NYSE) rather than returning nothing.
  const seed = (ex.discoverySeed || []).filter(Boolean);
  if (pool.length === 0) return seed.slice(0, n);
  if (pool.length <= n) return pool.slice(0, n);

  // Sector focus (V1 Settings): when a subset of sectors is enabled, bias
  // discovery toward them. All-on (or unset) means no bias.
  const sectorFocus = settings.sector_focus || {};
  const enabledSectors = Object.keys(sectorFocus).filter((k) => sectorFocus[k]);
  const allSectors = Object.keys(sectorFocus);
  const sectorLine =
    enabledSectors.length && enabledSectors.length < allSectors.length
      ? `\nPrioritise these sectors when choosing: ${enabledSectors.join(', ')}.`
      : '';

  // Learned context: bias selection toward signal+sector slices that have
  // historically won. Best-effort — discovery must still run with no track record.
  let trackRecord = '';
  try {
    trackRecord = await getOverviewContext(exchange);
  } catch {
    /* no track record / weights unavailable — proceed without it */
  }
  const trackLine = trackRecord
    ? `\n\nAGENT TRACK RECORD (favour movers in slices that have historically won; avoid chronically losing ones):\n${trackRecord}`
    : '';

  const example =
    ex.id === 'NEPSE' ? '["NABIL","UPPER","NICA"]' : '["AAPL","MSFT","NVDA"]';
  const prompt = `From today's ${ex.marketLabel} movers, select the ${n} symbols with the best short-term swing-trade potential.

Market sentiment: ${movers?.sentiment || 'NEUTRAL'}
Top gainers: ${gainers.join(', ') || 'none'}
Top losers: ${losers.join(', ') || 'none'}${sectorLine}${trackLine}

Pick a balanced set favouring liquidity, momentum, and clear technical setups.
Return ONLY a JSON array of ${n} ticker strings, e.g. ${example}.`;

  const text = await callLLM(prompt, {
    maxTokens: 500,
    system: `You are a ${ex.id} stock discovery agent. Return only a JSON array of ticker symbols.`,
  });

  const picked = parseJson(text);
  if (Array.isArray(picked) && picked.length) {
    return picked.filter(Boolean).slice(0, n);
  }
  // LLM junk/budget → the movers pool, or the seed universe if there were none.
  return (pool.length ? pool : seed).slice(0, n);
}

// ---------------------------------------------------------------------------
// scanOneStock(symbol, marketData, weights, knowledge, { exchange }):
//   fetch a verified price for the exchange and generate a signal.
//   `weights` is an optional pre-fetched weight-context string; when omitted it
//   is looked up via getWeightContext(). `exchange` selects the price providers,
//   currency framing, and learning-loop scope (defaults to NEPSE).
// ---------------------------------------------------------------------------
export async function scanOneStock(symbol, marketData = {}, weights = null, knowledge = null, opts = {}) {
  const exchange = opts.exchange || DEFAULT_EXCHANGE;
  const ex = getExchange(exchange);
  const cur = ex.currencySymbol;

  // TIER-1 #1: if a corporate-action ex-window covers TODAY for this symbol, the price
  // has (or is about to) drop mechanically — thread its factor into the verified-price
  // guard so the legit post-ex quote is accepted instead of rejected as implausible.
  // Best-effort + gated on the CA table probe: on an unmigrated DB, or any read
  // failure, caFactor stays undefined and the fetch below is byte-for-byte today. The
  // ground-truth rule holds — the LLM never sets the price; the CA factor is scraped.
  let caFactor;
  try {
    if (await corporateActionsReady()) {
      const nowIso = new Date().toISOString();
      const adj = await getActiveAdjustment(getSupabase(), symbol, exchange, nowIso, nowIso);
      if (adj.actions.length && adj.computable) caFactor = adj.factor;
    }
  } catch {
    /* best-effort: a CA read failure must never break the scan (caFactor stays undefined) */
  }

  // Ground truth FIRST (CLAUDE.md guardrail #1): the price comes from the verified
  // data layer, NEVER the LLM. If we can't verify a price, there is no usable
  // signal — throw 'no data from source' so the worker fails the job (retry surface)
  // instead of persisting a hollow or hallucinated card. Late-but-true is fine: the
  // verified layer accepts an hours-old quote and just flags it stale. The exchange
  // routes which sources + plausibility ceiling the verified layer uses.
  const verified = await getVerifiedPrice(symbol, { exchange, caFactor });
  if (!verified.verified) {
    throw new Error(`no data from source: ${symbol}`);
  }
  const price = verified.price;

  const weightContext = weights != null ? weights : await getWeightContext(symbol, null, exchange);
  const knowledgeContext = knowledge != null ? knowledge : await getKnowledgeContext(symbol, null, exchange);

  const researchLine =
    ex.id === 'NEPSE'
      ? `STEP 1 — Research ${symbol} on merolagani.com / sharesansar.com for CONTEXT ONLY: 52-week high/low, volume, sector, P/E, recent news. Do NOT override the verified price with anything you read.`
      : `STEP 1 — Research ${symbol} on finance.yahoo.com / marketwatch.com for CONTEXT ONLY: 52-week high/low, volume, sector, P/E, recent news/earnings. Do NOT override the verified price with anything you read.`;

  // TIER-2 LIQUIDITY: ground-truth turnover/volume off the verified layer (never
  // LLM-sourced). Annotation-only — it rides in live_data and feeds the prompt as a
  // reasoning input, but is kept ORTHOGONAL to confidence (never folded into it).
  const { turnover: liqTurnover, illiquid } = illiquidityOf(
    { turnover: verified.liquidity?.turnover, price, volume: verified.liquidity?.volume },
    MIN_TURNOVER_NPR
  );
  // Ground-truth turnover line for the prompt (replaces guessing at "liquidity"): the
  // model reasons OVER the verified figure, it never sets it. Silent when unknown.
  const turnoverLine =
    liqTurnover != null
      ? `\n  VERIFIED TURNOVER TODAY: ${cur} ${Math.round(liqTurnover).toLocaleString('en-US')}${illiquid ? ' — THIN/illiquid: a retail order may move the book and be hard to exit; weigh tradeability in the risk.' : ''}`
      : '';

  const asOfText = verified.asOf ? new Date(verified.asOf).toISOString() : 'recent';
  const prompt = `You are a disciplined ${ex.marketLabel} swing-trading analyst. Produce ONE trade signal for "${symbol}". Prices are in ${ex.currency} (${cur}).

The current price is VERIFIED and GIVEN below — do NOT look it up, change it, or output a different price. Treat it as ground truth:
  VERIFIED PRICE: ${cur} ${price}  (as of ${asOfText}${verified.stale ? ', slightly delayed' : ''}; sources: ${verified.sources.join('+')})${turnoverLine}

${researchLine}
STEP 2 — Decide the signal using the verified price plus that context and the learned context below.

MARKET CONTEXT:
Index: ${marketData.index ?? 'n/a'} (${marketData.changePct ?? 'n/a'}%), sentiment: ${marketData.sentiment ?? 'NEUTRAL'}

AGENT TRACK RECORD (calibration — weigh this when setting confidence):
${weightContext || 'No prior track record yet.'}

LEARNED KNOWLEDGE (past outcomes & notes for this stock/sector — apply these lessons):
${knowledgeContext || 'No accumulated knowledge yet.'}

Return ONLY JSON with this exact shape (no prose, no markdown). Do NOT include a price field:
{
  "symbol": "${symbol}",
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
    system: `You are a ${ex.marketLabel} research + trading signal agent. The price is given and verified — never change it. Return only valid JSON. Be disciplined and risk-aware.`,
  });

  // Budget spent / LLM unavailable => r is {} and every field below falls back to a
  // safe default. We still have a VERIFIED price, so this yields a real (if shallow)
  // signal rather than throwing — the price guard above is the only hard gate.
  const r = parseJson(text) || {};
  const sector = r.sector || null;

  // Real fundamentals scraped from the SAME verified provider page (best-effort;
  // each field is null when absent). These are ground-truth numbers, not LLM-read,
  // so they populate the stock-detail overlay reliably. Never affects the price gate.
  const f = verified.fundamentals || {};

  // live_data carries the verified price + provenance (source, freshness) so the UI
  // can honestly show "as of …" and which sources agreed. price is ALWAYS the
  // verified number — r.price is intentionally ignored (and no longer requested).
  // Fundamentals prefer the real scraped values; the LLM's high52/low52/pe/volume
  // remain as a fallback where the scrape had no number.
  const live = {
    symbol,
    price,
    change: numOrNull(r.change),
    changePct: numOrNull(r.changePct),
    high52: numOrNull(r.high52),
    low52: numOrNull(r.low52),
    volume: numOrNull(r.volume),
    pe: f.pe != null ? f.pe : numOrNull(r.pe),
    sector,
    asOf: verified.asOf ?? null,
    stale: !!verified.stale,
    sources: verified.sources,
    // TIER-2 liquidity annotation (ground-truth; orthogonal to confidence): the Rupee
    // turnover and an illiquid flag (true/false/null=unknown) so the UI can flag a thin,
    // hard-to-exit name without altering the model's conviction.
    turnover: liqTurnover,
    illiquid,
    // Fundamentals under the field names the overlay reads (avg180 kept alongside).
    week52_high: f.week52_high ?? null,
    week52_low: f.week52_low ?? null,
    avg120: f.avg120 ?? null,
    avg180: f.avg180 ?? null,
    eps: f.eps ?? null,
    bv: f.bv ?? null,
    pbv: f.pbv ?? null,
    div_pct: f.div_pct ?? null,
    yield: f.yield ?? null,
  };

  // Fill any missing/zero targets deterministically from the verified price, so
  // every persisted signal has real sl/target/entry. Keeps the model's verb + why.
  const t = calcTargets(
    { entry: r.entry, sl: numOrNull(r.sl), target: numOrNull(r.target) },
    price,
    cur,
    r.signal || 'HOLD'
  );

  return {
    symbol,
    exchange: ex.id,
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
    source: verified.sources.join('+') || 'verified',
    sector,
    live_data: { ...live, targets_calculated: t.calculated },
  };
}

// calcTargets(sig, price, cur, direction): fill missing/zero entry/sl/target
// deterministically, with direction-correct geometry. `cur` is the exchange currency
// symbol (default 'Rs' for NEPSE). `direction` is the resolved verb (BUY/SELL/HOLD/AVOID).
//   BUY/HOLD/AVOID (profit UP):   5% stop BELOW, 8% target ABOVE  (byte-for-byte as before)
//   SELL           (profit DOWN): 5% stop ABOVE (price*1.05), 8%→ target BELOW (price*0.92)
// Entry is a symmetric ±1% band around the verified price for every direction.
// Beyond filling a missing/≤0 level, an LLM level on the WRONG SIDE of entry for the
// direction (an inverted stop/target — e.g. a SELL target ABOVE entry) is treated as
// missing and recomputed. A merely wide-but-correct-side level is NEVER discarded.
// Returns { entry, sl, target, calculated }. Exported for unit testing.
export function calcTargets(sig, price, cur = 'Rs', direction = 'BUY') {
  let calculated = false;
  let sl = numOrNull(sig.sl);
  let target = numOrNull(sig.target);
  let entry = sig.entry;

  const isSell = String(direction || '').toUpperCase() === 'SELL';
  const defSl = isSell ? Math.round(price * 1.05) : Math.round(price * 0.95);
  const defTarget = isSell ? Math.round(price * 0.92) : Math.round(price * 1.08);

  // Correct-side predicates: a SELL profits DOWN (stop ABOVE entry, target BELOW), a
  // BUY/HOLD/AVOID profits UP (stop BELOW entry, target ABOVE). A level on the opposite
  // side is an inverted model output → recompute it.
  const slWrongSide = sl != null && sl > 0 && (isSell ? sl < price : sl > price);
  const targetWrongSide = target != null && target > 0 && (isSell ? target > price : target < price);

  if (!sl || sl <= 0 || slWrongSide) {
    sl = defSl;
    calculated = true;
  }
  if (!target || target <= 0 || targetWrongSide) {
    target = defTarget;
    calculated = true;
  }
  if (!entry || entry === '' || entry === 'N/A') {
    entry = `${cur} ${Math.round(price * 0.99)}-${cur} ${Math.round(price * 1.01)}`;
    calculated = true;
  }
  return { entry, sl, target, calculated };
}

// deterministicSignal(stockData): a no-LLM fallback used when the daily budget is
// spent. Needs a price (e.g. the last known price for the symbol). Classifies on
// price vs a 120-day average when available, else HOLD, with calculated targets.
export function deterministicSignal(stockData = {}, exchange = DEFAULT_EXCHANGE) {
  const price = numOrNull(stockData.price);
  if (!price || price <= 0) return null;

  const avg = numOrNull(stockData.avg120) || price;
  let signal = 'HOLD';
  if (price > avg * 1.02) signal = 'WATCH';
  else if (price < avg * 0.98) signal = 'NEUTRAL';

  const t = calcTargets({}, price, currencySymbolFor(exchange), signal);
  return {
    symbol: stockData.symbol,
    exchange: getExchange(exchange).id,
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
// runBrief(signals, marketData, portfolio, exchange): generate the daily brief.
// exchange selects the learning-loop scope + the deterministic-fallback framing.
// ---------------------------------------------------------------------------
export async function runBrief(signals = [], marketData = {}, portfolio = [], exchange = DEFAULT_EXCHANGE) {
  const ex = getExchange(exchange);
  const summary = signals.map((s) => ({
    symbol: s.symbol,
    signal: s.signal,
    confidence: s.confidence,
    price: s.price,
    target: s.target,
    sl: s.sl,
  }));

  // Learned context: let the brief calibrate how strongly to push picks against
  // the agent's real hit rate. Best-effort — never block the brief on it.
  let trackRecord = '';
  try {
    trackRecord = await getOverviewContext(exchange);
  } catch {
    /* no track record yet — write the brief without it */
  }

  const prompt = `You are the lead analyst writing today's ${ex.marketLabel} trading brief.

MARKET:
${JSON.stringify(marketData, null, 2)}

SIGNALS (${signals.length}):
${JSON.stringify(summary, null, 2)}

CURRENT PORTFOLIO:
${JSON.stringify(portfolio, null, 2)}

AGENT TRACK RECORD (calibrate conviction to this — don't over-promise on weak slices):
${trackRecord || 'No track record yet.'}

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
    system: `You are a ${ex.id} market brief writer. Return only valid JSON.`,
  });

  // Budget exhausted / LLM unavailable -> build a useful brief from the signals
  // we already have, so the scan still finishes with output (never blank).
  const brief = parseJson(text);
  if (!brief) return deterministicBrief(signals, marketData, exchange);

  return {
    headline: brief.headline || `${ex.id} daily brief`,
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
function deterministicBrief(signals = [], marketData = {}, exchange = DEFAULT_EXCHANGE) {
  const exId = getExchange(exchange).id;
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
    headline: `${exId} ${sentiment} — ${signals.length} signal${signals.length === 1 ? '' : 's'} (auto-summary)`,
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

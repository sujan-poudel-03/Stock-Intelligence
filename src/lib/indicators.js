// Technical indicators — Phase B of the redesign (closing the "no indicators" gap
// from the trader/product review). Pure, dependency-free, deterministic math over
// an array of daily closes (chronological order, oldest first) — the exact shape
// GET /api/price-history already returns. No I/O, never throws, never invents a
// value: every function returns `null` (or an array of nulls) wherever there isn't
// yet enough history to compute a real reading, so a caller can render an honest
// "not enough history yet" state instead of a wrong number.
//
// These are read-only lenses on already-verified closes (src/lib/priceHistory.js) —
// they never set or override a price, matching the "LLM/derived math never becomes
// ground truth" guardrail the verified-price layer itself follows.

function toCloses(bars) {
  return (bars || []).map((b) => {
    if (b == null) return null; // preserve holes — Number(null) would silently become 0
    const n = typeof b === 'number' ? b : Number(b.close);
    return Number.isFinite(n) ? n : null;
  });
}

// sma(bars, period): simple moving average series, aligned to input (null until
// `period` closes are available).
export function sma(bars, period) {
  const closes = toCloses(bars);
  const out = new Array(closes.length).fill(null);
  if (period <= 0) return out;
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    const c = closes[i];
    if (c == null) return out; // a hole in the series — bail rather than skew the average
    sum += c;
    if (i >= period) sum -= closes[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

// ema(bars, period): exponential moving average series, seeded by the SMA of the
// first `period` closes (the standard convention), null before that point.
export function ema(bars, period) {
  const closes = toCloses(bars);
  const out = new Array(closes.length).fill(null);
  if (period <= 0 || closes.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) {
    if (closes[i] == null) return out;
    seed += closes[i];
  }
  seed /= period;
  out[period - 1] = seed;
  let prev = seed;
  for (let i = period; i < closes.length; i++) {
    if (closes[i] == null) { out[i] = null; continue; }
    prev = closes[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// rsi(bars, period=14): Wilder's RSI, 0-100, null before `period+1` closes exist.
export function rsi(bars, period = 14) {
  const closes = toCloses(bars);
  const out = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;
  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const delta = closes[i] - closes[i - 1];
    if (delta >= 0) gainSum += delta; else lossSum -= delta;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = rsiFromAvg(avgGain, avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const delta = closes[i] - closes[i - 1];
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = rsiFromAvg(avgGain, avgLoss);
  }
  return out;
}
function rsiFromAvg(avgGain, avgLoss) {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// macd(bars, fast=12, slow=26, signalPeriod=9): { macd, signal, histogram } series,
// each aligned to input, null wherever the underlying EMAs aren't ready yet.
export function macd(bars, fast = 12, slow = 26, signalPeriod = 9) {
  const closes = toCloses(bars);
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdLine = closes.map((_, i) => (emaFast[i] != null && emaSlow[i] != null ? emaFast[i] - emaSlow[i] : null));
  const signalLine = ema(macdLine.map((v) => (v == null ? null : v)), signalPeriod);
  const histogram = closes.map((_, i) => (macdLine[i] != null && signalLine[i] != null ? macdLine[i] - signalLine[i] : null));
  return { macd: macdLine, signal: signalLine, histogram };
}

// bollingerBands(bars, period=20, mult=2): { mid, upper, lower } series (mid = SMA).
export function bollingerBands(bars, period = 20, mult = 2) {
  const closes = toCloses(bars);
  const mid = sma(closes, period);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    if (mid[i] == null) continue;
    let sq = 0;
    for (let j = i - period + 1; j <= i; j++) sq += (closes[j] - mid[i]) ** 2;
    const stdDev = Math.sqrt(sq / period);
    upper[i] = mid[i] + mult * stdDev;
    lower[i] = mid[i] - mult * stdDev;
  }
  return { mid, upper, lower };
}

// lastValue(series): the most recent non-null reading, or null if none exists yet —
// a small convenience for "show today's indicator reading" call sites.
export function lastValue(series) {
  if (!Array.isArray(series)) return null;
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i] != null) return series[i];
  }
  return null;
}

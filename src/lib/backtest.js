// Backtest / replay harness — the validation environment (Roadmap Phase 1.5).
//
// This is the keystone for turning a marketed win rate into a defensible one, and
// the environment the calibrated bandit + shadow-B strategies validate against.
//
// The ONE rule it enforces: NO LOOK-AHEAD. At each day T the strategy is handed
// ONLY the bars up to and including T to make its decision — it can never see the
// future when deciding. Outcomes are then MEASURED against later bars (that is not
// look-ahead: measuring what happened after a committed decision is exactly the
// point). Pure + deterministic so results are reproducible in CI.
//
// A `bar` is { date, price }. A `strategy(historyUpToT, ctx)` returns
//   { signal: 'BUY'|'SELL'|..., sl, target } | null
// where historyUpToT is bars[0..t] inclusive — the decision may use ONLY these.

import { sharpe, riskAdjustedReturn } from './stats.js';

const DEFAULTS = { maxHoldBars: 20 };

export function runBacktest(bars, strategy, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const clean = (bars || [])
    .filter((b) => Number.isFinite(Number(b?.price)))
    .map((b) => ({ date: b.date, price: Number(b.price) }));

  const trades = [];
  for (let t = 0; t < clean.length; t += 1) {
    const history = clean.slice(0, t + 1); // ONLY the past + present — never the future
    const decision = strategy(history, { index: t });
    if (!decision || !isEntry(decision.signal)) continue;

    const entry = clean[t];
    const sl = Number(decision.sl);
    const target = Number(decision.target);
    if (!(entry.price > 0) || !(sl > 0) || !(target > 0)) continue;

    const res = resolveForward(clean, t, { sl, target, side: decision.signal, maxHoldBars: o.maxHoldBars });
    trades.push({
      symbol: o.symbol || null,
      signal: decision.signal,
      entryDate: entry.date,
      entryPrice: entry.price,
      ...res,
    });
  }

  return { trades, metrics: aggregate(trades) };
}

// Measure a committed decision against subsequent bars (measurement, not decision).
function resolveForward(bars, t, { sl, target, side, maxHoldBars }) {
  const entry = bars[t].price;
  const end = Math.min(bars.length - 1, t + maxHoldBars);
  const isBuy = side === 'BUY';

  for (let i = t + 1; i <= end; i += 1) {
    const p = bars[i].price;
    const hitTarget = isBuy ? p >= target : p <= target;
    const hitStop = isBuy ? p <= sl : p >= sl;
    if (hitTarget) return closed('WIN', entry, target, bars[i].date, i - t, isBuy);
    if (hitStop) return closed('LOSS', entry, sl, bars[i].date, i - t, isBuy);
  }

  // Never hit target or stop within the window — mark open at the last seen price.
  const last = bars[end].price;
  return {
    outcome: 'OPEN',
    exitPrice: last,
    exitDate: bars[end].date,
    holdBars: end - t,
    returnPct: pct(entry, last, isBuy),
  };
}

function closed(outcome, entry, exit, exitDate, holdBars, isBuy) {
  return { outcome, exitPrice: exit, exitDate, holdBars, returnPct: pct(entry, exit, isBuy) };
}

// Return % for the side: long gains when price rises, short when it falls.
function pct(entry, exit, isBuy) {
  if (!(entry > 0)) return 0;
  const raw = ((exit - entry) / entry) * 100;
  return round2(isBuy ? raw : -raw);
}

// Aggregate trades into the metrics a track record needs.
export function aggregate(trades) {
  const closedTrades = trades.filter((t) => t.outcome === 'WIN' || t.outcome === 'LOSS');
  const wins = closedTrades.filter((t) => t.outcome === 'WIN').length;
  const losses = closedTrades.filter((t) => t.outcome === 'LOSS').length;
  const rets = closedTrades.map((t) => t.returnPct);
  const avgReturn = rets.length ? round2(rets.reduce((a, b) => a + b, 0) / rets.length) : 0;

  // Max drawdown over the equity curve (cumulative return, in trade order).
  let cum = 0;
  let peak = 0;
  let maxDD = 0;
  for (const r of rets) {
    cum += r;
    peak = Math.max(peak, cum);
    maxDD = Math.min(maxDD, cum - peak);
  }

  return {
    trades: trades.length,
    closed: closedTrades.length,
    open: trades.length - closedTrades.length,
    wins,
    losses,
    winRate: wins + losses ? round2((wins / (wins + losses)) * 100) / 100 : 0,
    avgReturn,
    // Optimize/rank strategies by these, not raw avgReturn: Sharpe rewards
    // consistency, risk-adjusted return penalizes drawdown over upside.
    sharpe: sharpe(rets),
    riskAdjustedReturn: riskAdjustedReturn(rets),
    maxDrawdownPct: round2(maxDD),
  };
}

function isEntry(signal) {
  return signal === 'BUY' || signal === 'SELL';
}
function round2(n) {
  return Math.round(n * 100) / 100;
}

// A simple reference strategy for tests/demos: go long when price closes above its
// N-bar simple moving average, with a fixed % stop/target. Real strategies (the
// deterministic classifier, the calibrated bandit, shadow-B) plug in the same way.
export function smaStrategy({ window = 5, stopPct = 0.05, targetPct = 0.08 } = {}) {
  return (history) => {
    if (history.length < window) return null;
    const recent = history.slice(-window).map((b) => b.price);
    const sma = recent.reduce((a, b) => a + b, 0) / window;
    const price = history[history.length - 1].price;
    if (price <= sma) return null;
    return {
      signal: 'BUY',
      sl: round2(price * (1 - stopPct)),
      target: round2(price * (1 + targetPct)),
    };
  };
}

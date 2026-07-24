// Shadow-B scoring (Roadmap Phase 1.5, P1.5-5).
//
// B (the "signal service" — specific, actionable BUY/SELL calls) runs in SHADOW
// mode: its decisions are generated and scored, but NEVER surfaced to users, until
// it proves an edge on backtest + live AND clears the legal read. This module is
// the "would-be track record" scorer over resolved actionable signals — the
// internal scoreboard that gates B's eventual graduation.
//
// IMPORTANT: this is an INTERNAL scoreboard. Its output must not be rendered as an
// actionable recommendation in the user-facing product (CLAUDE.md B guardrail).
// Pure + deterministic — reads resolved signal rows, computes stats, exposes nothing.

import { wilsonLowerBound, riskAdjustedReturn } from './stats.js';

const ACTIONABLE = new Set(['BUY', 'SELL']);

// scoreShadow(signals): given signal rows (each { signal, outcome, return_pct }),
// score the actionable, resolved subset as if B's calls had been taken.
//   { trades, wins, losses, winRate, confidence, avgReturn, riskAdjustedReturn, byDirection }
// `confidence` is the Wilson lower bound — the honest, small-sample-discounted rate
// that B must clear (on a real sample) before it can graduate out of shadow mode.
export function scoreShadow(signals = []) {
  const actionable = signals.filter((s) => s && ACTIONABLE.has(String(s.signal).toUpperCase()));
  return {
    ...tally(actionable),
    byDirection: {
      BUY: tally(actionable.filter((s) => String(s.signal).toUpperCase() === 'BUY')),
      SELL: tally(actionable.filter((s) => String(s.signal).toUpperCase() === 'SELL')),
    },
  };
}

function tally(rows) {
  const closed = rows.filter((s) => s.outcome === 'WIN' || s.outcome === 'LOSS');
  const wins = closed.filter((s) => s.outcome === 'WIN').length;
  const losses = closed.filter((s) => s.outcome === 'LOSS').length;
  const n = wins + losses;
  const returns = closed.map((s) => Number(s.return_pct)).filter((x) => Number.isFinite(x));
  const avgReturn = returns.length ? round2(returns.reduce((a, b) => a + b, 0) / returns.length) : 0;

  return {
    trades: rows.length,
    closed: closed.length,
    wins,
    losses,
    winRate: n ? round2(wins / n) : 0,
    confidence: round2(wilsonLowerBound(wins, n)), // small-sample-discounted rate
    avgReturn,
    riskAdjustedReturn: riskAdjustedReturn(returns),
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Statistical primitives for the calibration bandit (Roadmap Phase 1.5).
//
// The point: a raw win rate lies on small samples — "100% from 2 trades" is noise,
// not skill. These functions make calibration confidence-aware and explainable
// (no black box): a Wilson lower bound discounts thin samples, a Beta posterior
// gives an exploration-aware estimate, and a risk-adjusted reward penalizes
// drawdown instead of rewarding raw return. All pure + deterministic (RNG is
// injectable) so they unit-test in CI.

// Wilson score lower bound on a binomial proportion — a conservative win rate that
// shrinks toward 0 when the sample is small. This IS statistical minimum-sample
// gating: rank/trust by this, not by wins/n.
export function wilsonLowerBound(wins, n, z = 1.96) {
  if (!(n > 0)) return 0;
  const phat = wins / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = phat + z2 / (2 * n);
  const margin = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n);
  return clamp01((center - margin) / denom);
}

// Beta-Bernoulli posterior mean with a prior (default uniform Beta(1,1) — a fresh
// slice reads as 50%, not 0% or 100%).
export function betaMean(wins, losses, prior = { a: 1, b: 1 }) {
  const a = wins + prior.a;
  const b = losses + prior.b;
  return a / (a + b);
}

// Thompson sample of a slice's win probability, for exploration-aware SELECTION
// (discovery / shadow-B action choice). Uses a normal approximation to Beta so it
// stays cheap and deterministic under an injected sampler. `normal` returns a
// standard-normal draw (default Box-Muller on Math.random).
export function thompsonSample(wins, losses, opts = {}) {
  const { prior = { a: 1, b: 1 }, normal = standardNormal } = opts;
  const a = wins + prior.a;
  const b = losses + prior.b;
  const mean = a / (a + b);
  const variance = (a * b) / ((a + b) * (a + b) * (a + b + 1));
  return clamp01(mean + normal() * Math.sqrt(variance));
}

// Sharpe-like ratio: mean return per unit of total volatility. 0 when flat.
export function sharpe(returns) {
  if (!returns || !returns.length) return 0;
  const m = mean(returns);
  const sd = Math.sqrt(mean(returns.map((r) => (r - m) * (r - m))));
  return sd === 0 ? 0 : round2(m / sd);
}

// Risk-adjusted reward: mean return minus lambda * downside deviation. Penalizes
// losses (not upside volatility) — the reward the calibration/backtest should
// optimize instead of raw return.
export function riskAdjustedReturn(returns, { lambda = 1 } = {}) {
  if (!returns || !returns.length) return 0;
  const m = mean(returns);
  const downside = returns.filter((r) => r < 0);
  const dd = downside.length ? Math.sqrt(mean(downside.map((r) => r * r))) : 0;
  return round2(m - lambda * dd);
}

// Exponential time-decay helpers for non-stationarity (ready for a decayed-count
// column; `factor` in [0,1] weights history down as it ages).
export function decayFactor(ageMs, halfLifeMs) {
  if (!(halfLifeMs > 0)) return 1;
  return Math.pow(0.5, ageMs / halfLifeMs);
}
export function ewmaUpdate(prev, value, factor) {
  return prev * factor + value;
}

// Apply one resolved outcome to decayed win/loss counts: age the prior counts by
// the half-life, then add this outcome. Older evidence fades, so the slice tracks
// the RECENT regime (non-stationarity) instead of its lifetime average.
export function decayedCounts(prev, isWin, ageMs, halfLifeMs) {
  const f = decayFactor(ageMs, halfLifeMs);
  return {
    dwins: ewmaUpdate(Number(prev?.dwins) || 0, isWin ? 1 : 0, f),
    dlosses: ewmaUpdate(Number(prev?.dlosses) || 0, isWin ? 0 : 1, f),
  };
}

// --- helpers ---------------------------------------------------------------
function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
function clamp01(x) {
  return Math.min(1, Math.max(0, x));
}
function round2(n) {
  return Math.round(n * 100) / 100;
}
function standardNormal() {
  // Box-Muller. App-side randomness is fine; tests inject `normal` instead.
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

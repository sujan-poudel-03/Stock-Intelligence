// Path-dependent outcome resolution primitives — pure, LLM-free, never throw (TIER-1 #3).
//
// The old resolver saw only a single day's SPOT between runs, so an intraday TARGET or
// STOP touch was invisible — the recorded WIN/LOSS was blind to what actually happened.
// These primitives resolve on the day's [low, high] RANGE (ground truth, verified layer)
// and on the accumulated cross-day extremes, so a first touch is caught. They also derive
// the time-stop horizon (EXPIRE) from the signal's `hold` text.
//
// Tie-break (DECIDED): when both target and stop fall inside one day's [low, high], assume
// the STOP was hit first → LOSS. Conservative — never overstate a WIN off an ambiguous bar.

// Time-stop horizon bounds (calendar days). effectiveMaxHoldDays clamps the hold-derived
// upper bound into [MIN, HARD_CEILING], defaulting when hold is unparseable.
export const DEFAULT_MAX_HOLD_DAYS = 42;
export const MIN_HOLD_DAYS = 5;
export const HARD_CEILING_DAYS = 60;

// parseHoldDays(holdText): the UPPER bound of a hold horizon in CALENDAR days, or null when
// unparseable. Handles free-text like "1-2 weeks", "3 weeks", "5-10 days", "1 month",
// "2 months". Unit is inferred from the text (month≈30d, week≈7d, else days); the largest
// number in the text is taken as the upper bound.
export function parseHoldDays(holdText) {
  if (holdText == null) return null;
  const s = String(holdText).toLowerCase();
  const nums = (s.match(/\d+(?:\.\d+)?/g) || []).map(Number).filter((n) => Number.isFinite(n));
  if (!nums.length) return null;
  const upper = Math.max(...nums);
  let mult = 1; // bare number / "days" → 1 day each
  if (/month/.test(s)) mult = 30;
  else if (/week/.test(s)) mult = 7;
  const days = Math.round(upper * mult);
  return days > 0 ? days : null;
}

// effectiveMaxHoldDays(holdText): the time-stop horizon actually used — the parsed upper
// bound (or DEFAULT when unparseable) clamped into [MIN_HOLD_DAYS, HARD_CEILING_DAYS].
export function effectiveMaxHoldDays(holdText) {
  const parsed = parseHoldDays(holdText);
  const base = parsed == null ? DEFAULT_MAX_HOLD_DAYS : parsed;
  return Math.min(HARD_CEILING_DAYS, Math.max(MIN_HOLD_DAYS, base));
}

// resolveFirstTouch({ direction, target, sl, high, low }): given a single day's price
// RANGE, did the signal touch its target (WIN) or stop (LOSS)? Returns
//   { outcome: 'WIN'|'LOSS'|null, exitReason: 'TARGET'|'STOP'|null, exitPrice }.
// STOP is checked first so a bar spanning BOTH levels resolves to LOSS (conservative
// tie-break). BUY: target above / stop below; SELL (short): target below / stop above.
// Null/absent levels are simply "not touched". Never throws.
export function resolveFirstTouch({ direction, target, sl, high, low } = {}) {
  const t = num(target);
  const s = num(sl);
  const hi = num(high);
  const lo = num(low);
  const isShort = String(direction).toUpperCase() === 'SELL';

  const hitStop = isShort
    ? s != null && hi != null && hi >= s
    : s != null && lo != null && lo <= s;
  const hitTarget = isShort
    ? t != null && lo != null && lo <= t
    : t != null && hi != null && hi >= t;

  // Conservative tie-break: stop first.
  if (hitStop) return { outcome: 'LOSS', exitReason: 'STOP', exitPrice: s };
  if (hitTarget) return { outcome: 'WIN', exitReason: 'TARGET', exitPrice: t };
  return { outcome: null, exitReason: null, exitPrice: null };
}

function num(v) {
  if (v == null || v === '') return null; // Number(null)===0 / Number('')===0 — guard first
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

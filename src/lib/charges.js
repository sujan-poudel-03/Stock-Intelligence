// NEPSE transaction charges — pure, LLM-free, never throws (TIER-1 #3, net-of-charges).
//
// The spot return_pct is GROSS (price move only). A real NEPSE round-trip is dragged by
// four deterministic costs, all ground-truth published rates (verified 2026):
//   - Broker commission: TIERED, a flat rate per slab applied to the WHOLE transaction
//     value (not marginal), with a Rs 10 per-transaction floor. Each leg is charged.
//   - SEBON regulatory levy: 0.015% of transaction value, each leg.
//   - DP (Depository Participant) fee: Rs 25 per scrip per settlement, each leg.
//   - Capital Gains Tax: on the POSITIVE net gain only — 7.5% short-term (<365 days),
//     5% long-term (>=365 days) for individuals.
//
// These feed the net-of-charges TRACK-RECORD headline (gross shown alongside). The
// learning loop still trains on GROSS return sign — net is display/track-record only.
// Scoped to NEPSE by the caller (NYSE net == gross); this module just does the math.

// SEBON regulatory fee, each leg (percent of transaction value). NOTE: the chat prompt
// long carried 0.0015% — that is wrong by 10x; the correct figure is 0.015%.
export const SEBON_LEVY_PCT = 0.015;
// DP fee: Rs 25 per scrip per settlement — charged on BOTH the buy and the sell leg.
export const DP_FEE = 25;
// Fixed notional principal the net-of-charges figure is computed on (stored as the
// assumed notional so the track record can disclose the basis). Charges are tiered, so
// the net drag is notional-dependent; a single disclosed basis keeps it comparable.
export const NOTIONAL_PRINCIPAL = 100000;

// brokerCommission(value): tiered broker commission on the WHOLE transaction value, with
// a Rs 10 per-transaction floor. Slabs (2026 NEPSE): <=50k 0.36%, 50k–500k 0.33%,
// 500k–2M 0.31%, 2M–10M 0.27%, >10M 0.24%. A slab boundary falls in the lower slab.
export function brokerCommission(value) {
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0) return 0;
  let rate;
  if (v <= 50000) rate = 0.0036;
  else if (v <= 500000) rate = 0.0033;
  else if (v <= 2000000) rate = 0.0031;
  else if (v <= 10000000) rate = 0.0027;
  else rate = 0.0024;
  return Math.max(v * rate, 10);
}

// legCharges({ value, side }): total non-CGT charges for a single BUY or SELL leg —
// broker commission + SEBON levy + DP fee. `side` is informational (both legs are
// charged identically). Returns a breakdown + total. Tolerant of null/zero value.
export function legCharges({ value, side } = {}) {
  const v = Number(value);
  const safe = Number.isFinite(v) && v > 0 ? v : 0;
  const broker = brokerCommission(safe);
  const sebon = safe * (SEBON_LEVY_PCT / 100);
  const dp = safe > 0 ? DP_FEE : 0;
  return { side: side || null, broker, sebon, dp, total: broker + sebon + dp };
}

// netReturn({ entry, exit, direction, holdDays, notional }): the net-of-charges return of
// a round-trip on a fixed notional principal. Returns both the gross and net view:
//   { grossPct, netPct, grossProfit, netProfit, cgtRate, cgt, charges, notional }
// Direction 'BUY' (long: buy@entry, sell@exit) and 'SELL' (short: sell@entry, buy@exit)
// are symmetric. CGT applies to the POSITIVE net gain only. Tolerant of null/zero.
export function netReturn({ entry, exit, direction = 'BUY', holdDays, notional = NOTIONAL_PRINCIPAL } = {}) {
  const e = Number(entry);
  const x = Number(exit);
  const N = Number.isFinite(Number(notional)) && Number(notional) > 0 ? Number(notional) : NOTIONAL_PRINCIPAL;
  const cgtRate = Number(holdDays) >= 365 ? 0.05 : 0.075;

  // Degenerate inputs → a well-formed zero result (never throws).
  if (!Number.isFinite(e) || !Number.isFinite(x) || e <= 0 || x <= 0) {
    return { grossPct: 0, netPct: 0, grossProfit: 0, netProfit: 0, cgtRate, cgt: 0, charges: 0, notional: N };
  }

  const shares = N / e;
  const entryValue = shares * e; // == N
  const exitValue = shares * x;
  const isShort = String(direction).toUpperCase() === 'SELL';

  // Cost (buy) leg vs proceeds (sell) leg depend on direction.
  const buyValue = isShort ? exitValue : entryValue;
  const sellValue = isShort ? entryValue : exitValue;

  const buyCh = legCharges({ value: buyValue, side: 'BUY' });
  const sellCh = legCharges({ value: sellValue, side: 'SELL' });
  const charges = buyCh.total + sellCh.total;

  const buyCostGross = buyValue + buyCh.total;
  const sellProceedsNet = sellValue - sellCh.total;

  const taxableGain = Math.max(0, sellProceedsNet - buyCostGross);
  const cgt = taxableGain * cgtRate;
  const netProfit = sellProceedsNet - buyCostGross - cgt;

  // Gross is the pure price move on the notional invested at entry — matches the spot
  // return_pct semantics: BUY (exit-entry)/entry, SELL (entry-exit)/entry.
  const grossProfit = sellValue - buyValue;
  const grossPct = entryValue > 0 ? (grossProfit / entryValue) * 100 : 0;
  const netPct = buyCostGross > 0 ? (netProfit / buyCostGross) * 100 : 0;

  return { grossPct, netPct, grossProfit, netProfit, cgtRate, cgt, charges, notional: N };
}

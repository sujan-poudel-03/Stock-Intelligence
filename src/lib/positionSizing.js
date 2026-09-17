// Risk-based position sizing — Phase C of the redesign (closing the "no risk-sizing
// tools" gap from the trader/product review). Pure, no I/O. Position size is the
// single biggest determinant of trader survival — more than signal accuracy — and
// until this, the app had zero support for it beyond manual mental math.
//
// suggestedQuantity({ capital, riskPct, entry, stopLoss }): given how much capital
// the trader is willing to put at risk overall and what fraction of it they're
// willing to lose on THIS trade, sizes the position so a stop-loss hit costs no
// more than that fraction. Returns null whenever an input makes the calculation
// meaningless (a long position needs stopLoss < entry) rather than a wrong number
// — this is a suggestion the trader can override, never an instruction.
export function suggestedQuantity({ capital, riskPct, entry, stopLoss }) {
  const cap = Number(capital);
  const risk = Number(riskPct);
  const e = Number(entry);
  const sl = Number(stopLoss);
  if (!Number.isFinite(cap) || cap <= 0) return null;
  if (!Number.isFinite(risk) || risk <= 0) return null;
  if (!Number.isFinite(e) || e <= 0) return null;
  if (!Number.isFinite(sl) || sl <= 0 || sl >= e) return null; // long-only: stop must sit below entry

  const riskAmount = cap * (risk / 100);
  const perShareRisk = e - sl;
  const qty = Math.floor(riskAmount / perShareRisk);
  if (qty <= 0) return null;

  return {
    qty,
    riskAmount,
    perShareRisk,
    positionValue: qty * e,
    pctOfCapital: (qty * e) / cap * 100,
  };
}

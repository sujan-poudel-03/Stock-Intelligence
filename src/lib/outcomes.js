import { getSupabase } from './supabase.js';
import { getVerifiedPrice } from './marketProviders.js';
import { updateWeights } from './calibration.js';
import { recordOutcomeKnowledge } from './knowledge.js';
import { logEvent } from './events.js';
import { sendAlert } from './email.js';

// checkOutcomes(): for every PENDING signal, fetch the latest price and resolve
// it to WIN (price >= target) or LOSS (price <= sl). Updates the signals row,
// writes an outcomes row, bumps calibration weights, and emails an alert.
export async function checkOutcomes() {
  const supabase = getSupabase();

  const { data: pending, error } = await supabase
    .from('signals')
    .select('*')
    .eq('outcome', 'PENDING')
    .in('signal', ['BUY', 'SELL']);

  if (error) throw error;
  if (!pending || pending.length === 0) {
    return { checked: 0, resolved: 0, outcomes: [] };
  }

  const symbols = [...new Set(pending.map((s) => s.symbol).filter(Boolean))];
  const prices = await fetchLatestPrices(symbols);

  const resolved = [];

  for (const sig of pending) {
    const price = prices[sig.symbol?.toUpperCase()];
    if (price == null) continue;

    const target = numOrNull(sig.target);
    const sl = numOrNull(sig.sl);
    let outcome = null;

    if (target != null && price >= target) outcome = 'WIN';
    else if (sl != null && price <= sl) outcome = 'LOSS';

    if (!outcome) continue;

    const entryPrice = numOrNull(sig.price);
    const returnPct =
      entryPrice && entryPrice !== 0 ? ((price - entryPrice) / entryPrice) * 100 : 0;
    const now = new Date().toISOString();

    // Update the signal row.
    await supabase
      .from('signals')
      .update({
        outcome,
        exit_price: price,
        outcome_at: now,
        return_pct: returnPct,
      })
      .eq('id', sig.id);

    // Log the outcome.
    await supabase.from('outcomes').insert({
      signal_id: sig.id,
      symbol: sig.symbol,
      outcome,
      entry_price: entryPrice,
      exit_price: price,
      return_pct: returnPct,
      hold_days: holdDays(sig.created_at, now),
      created_at: now,
    });

    // Update calibration (statistical) + knowledge base (qualitative lessons).
    await updateWeights(sig.symbol, sig.sector, sig.signal, outcome, returnPct);
    await recordOutcomeKnowledge(supabase, sig, outcome, price, returnPct);

    // Alert.
    await sendAlert(
      outcome === 'WIN' ? 'TARGET_HIT' : 'SL_BREACH',
      sig.symbol,
      price,
      outcome === 'WIN' ? target : sl
    );

    // Durable history of the resolved outcome (feeds the Activity tab).
    await logEvent(supabase, {
      type: outcome === 'WIN' ? 'outcome_win' : 'outcome_loss',
      symbol: sig.symbol,
      message: `${sig.symbol} ${sig.signal} → ${outcome} (${returnPct >= 0 ? '+' : ''}${returnPct.toFixed(1)}%) at ${price}`,
      data: { signal: sig.signal, outcome, price, returnPct, target, sl },
    });

    resolved.push({ symbol: sig.symbol, outcome, price, returnPct });
  }

  return { checked: pending.length, resolved: resolved.length, outcomes: resolved };
}

// Fetch latest VERIFIED prices for a batch of NEPSE symbols. Outcome resolution
// decides real money (WIN at target / LOSS at stop), so the exit price must be
// ground truth — never LLM-sourced (CLAUDE.md guardrail #1). Any symbol whose
// price can't be verified maps to null and is simply left PENDING (retried next run).
async function fetchLatestPrices(symbols) {
  if (!symbols.length) return {};

  const out = {};
  await Promise.all(
    symbols.map(async (sym) => {
      const key = String(sym).toUpperCase();
      try {
        const r = await getVerifiedPrice(sym);
        out[key] = r.verified ? r.price : null;
      } catch {
        out[key] = null;
      }
    })
  );
  return out;
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function holdDays(start, end) {
  if (!start) return null;
  const ms = new Date(end).getTime() - new Date(start).getTime();
  return Math.max(0, Math.round(ms / 86400000));
}

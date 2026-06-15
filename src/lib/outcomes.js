import { getSupabase } from './supabase.js';
import { callLLM, parseJson } from './llm.js';
import { updateWeights } from './calibration.js';
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

    // Update calibration.
    await updateWeights(sig.symbol, sig.sector, sig.signal, outcome, returnPct);

    // Alert.
    await sendAlert(
      outcome === 'WIN' ? 'TARGET_HIT' : 'SL_BREACH',
      sig.symbol,
      price,
      outcome === 'WIN' ? target : sl
    );

    resolved.push({ symbol: sig.symbol, outcome, price, returnPct });
  }

  return { checked: pending.length, resolved: resolved.length, outcomes: resolved };
}

// Fetch latest prices for a batch of NEPSE symbols via web search.
async function fetchLatestPrices(symbols) {
  if (!symbols.length) return {};

  const prompt = `Search merolagani.com for the current last-traded price of these NEPSE stocks: ${symbols.join(', ')}.

Return ONLY a JSON object mapping symbol -> price, e.g. {"NABIL": 530.5, "UPPER": 210}.
Use null for any symbol you cannot find.`;

  const text = await callLLM(prompt, {
    webSearch: true,
    webFetch: true,
    maxTokens: 1000,
    system: 'You are a NEPSE price extraction agent. Return only a JSON object of symbol->price.',
  });

  const map = parseJson(text) || {};
  const out = {};
  for (const [k, v] of Object.entries(map)) {
    const n = Number(v);
    out[k.toUpperCase()] = Number.isFinite(n) ? n : null;
  }
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

import { getSupabase } from './supabase.js';

// Calibration learning. Each "key" captures a slice of agent performance, e.g.
//   "ALL"            -> overall record
//   "BUY"            -> all BUY signals
//   "BUY_banks"      -> BUY signals in the banking sector
//   "SYMBOL_NABIL"   -> per-symbol record
// Weights are upserted into the `weights` table and surfaced back into the
// signal prompt via getWeightContext().

function rate(wins, losses) {
  const total = wins + losses;
  return total === 0 ? 0 : wins / total;
}

async function bump(key, outcome, returnPct) {
  if (!key) return;
  const supabase = getSupabase();

  const { data: existing } = await supabase
    .from('weights')
    .select('*')
    .eq('key', key)
    .maybeSingle();

  const prevWins = existing?.wins || 0;
  const prevLosses = existing?.losses || 0;
  const prevAvg = Number(existing?.avg_return || 0);
  const prevTotal = prevWins + prevLosses;

  const isWin = outcome === 'WIN';
  const wins = prevWins + (isWin ? 1 : 0);
  const losses = prevLosses + (isWin ? 0 : 1);

  const ret = Number.isFinite(returnPct) ? Number(returnPct) : 0;
  const newTotal = prevTotal + 1;
  const avgReturn = (prevAvg * prevTotal + ret) / newTotal;

  await supabase.from('weights').upsert(
    {
      key,
      wins,
      losses,
      rate: rate(wins, losses),
      avg_return: avgReturn,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'key' }
  );
}

/**
 * updateWeights(symbol, sector, signalType, outcome, returnPct)
 * Records one resolved outcome across all relevant calibration keys.
 */
export async function updateWeights(symbol, sector, signalType, outcome, returnPct) {
  const keys = ['ALL'];
  if (signalType) keys.push(signalType.toUpperCase());
  if (signalType && sector) keys.push(`${signalType.toUpperCase()}_${slug(sector)}`);
  if (symbol) keys.push(`SYMBOL_${symbol.toUpperCase()}`);

  for (const key of keys) {
    await bump(key, outcome, returnPct);
  }
}

/**
 * getWeightContext(symbol, sector)
 * Returns a short human-readable string for prompt injection, e.g.:
 *   "Agent win rate: 72% from 18 trades. BUY_banks: 78% from 9. NABIL: 80% from 5."
 * Returns '' when there is no track record yet.
 */
export async function getWeightContext(symbol, sector) {
  const supabase = getSupabase();

  const wantedKeys = ['ALL'];
  if (sector) {
    wantedKeys.push(`BUY_${slug(sector)}`);
    wantedKeys.push(`SELL_${slug(sector)}`);
  }
  if (symbol) wantedKeys.push(`SYMBOL_${symbol.toUpperCase()}`);

  const { data } = await supabase
    .from('weights')
    .select('*')
    .in('key', wantedKeys);

  if (!data || data.length === 0) return '';

  const byKey = Object.fromEntries(data.map((w) => [w.key, w]));
  const parts = [];

  const all = byKey['ALL'];
  if (all && all.wins + all.losses > 0) {
    parts.push(
      `Agent win rate: ${pct(all.rate)} from ${all.wins + all.losses} trades (avg return ${num(all.avg_return)}%)`
    );
  }

  if (sector) {
    for (const sig of ['BUY', 'SELL']) {
      const w = byKey[`${sig}_${slug(sector)}`];
      if (w && w.wins + w.losses > 0) {
        parts.push(`${sig}_${slug(sector)}: ${pct(w.rate)} from ${w.wins + w.losses}`);
      }
    }
  }

  if (symbol) {
    const w = byKey[`SYMBOL_${symbol.toUpperCase()}`];
    if (w && w.wins + w.losses > 0) {
      parts.push(`${symbol.toUpperCase()}: ${pct(w.rate)} from ${w.wins + w.losses}`);
    }
  }

  return parts.join('. ');
}

function slug(s) {
  return String(s).trim().toLowerCase().replace(/\s+/g, '_');
}
function pct(r) {
  return `${Math.round(Number(r) * 100)}%`;
}
function num(n) {
  return (Math.round(Number(n) * 10) / 10).toFixed(1);
}

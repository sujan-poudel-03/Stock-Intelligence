import { getSupabase, getServiceSupabase } from './supabase.js';
import { wilsonLowerBound, decayedCounts } from './stats.js';
import { scopeKey, DEFAULT_EXCHANGE } from './exchanges.js';

// Half-life for time-decayed calibration counts (~one quarter). Older outcomes
// fade so a slice tracks the recent regime, not its lifetime average.
const DECAY_HALF_LIFE_MS = 90 * 24 * 60 * 60 * 1000;

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

  // Calibration accrual is a best-effort side-channel: it must never throw into the
  // outcome-resolution loop (CLAUDE.md guardrail). Writes go through the service-role
  // client so they survive RLS being enabled later (Phase 2); the whole body is
  // wrapped so a service-client failure (e.g. key unset) is swallowed rather than
  // aborting the loop — matching the never-throw contract the anon path relied on.
  try {
    const supabase = getServiceSupabase();

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

    // Best-effort time-decay update (P1.5-3b). A not-yet-migrated DB (no dwins/
    // dlosses/last_outcome_at columns) just no-ops here — the update returns an
    // error rather than throwing, and the try guards any unexpected throw — so core
    // calibration keeps working whether or not the migration has been applied.
    try {
      const now = Date.now();
      const ageMs = existing?.last_outcome_at ? now - new Date(existing.last_outcome_at).getTime() : 0;
      const { dwins, dlosses } = decayedCounts(existing, isWin, ageMs, DECAY_HALF_LIFE_MS);
      await supabase
        .from('weights')
        .update({ dwins, dlosses, last_outcome_at: new Date(now).toISOString() })
        .eq('key', key);
    } catch {
      /* decay columns not migrated yet — skip */
    }
  } catch {
    /* best-effort: calibration accrual must never throw into the outcome loop */
  }
}

/**
 * updateWeights(symbol, sector, signalType, outcome, returnPct, exchange)
 * Records one resolved outcome across all relevant calibration keys. Keys are
 * namespaced by exchange via scopeKey — NEPSE stays UNPREFIXED (existing rows keep
 * learning), every other exchange gets an `${EXCHANGE}:` prefix so it learns from
 * its own outcomes without cross-contaminating NEPSE.
 */
export async function updateWeights(symbol, sector, signalType, outcome, returnPct, exchange = DEFAULT_EXCHANGE) {
  const raw = ['ALL'];
  if (signalType) raw.push(signalType.toUpperCase());
  if (signalType && sector) raw.push(`${signalType.toUpperCase()}_${slug(sector)}`);
  if (symbol) raw.push(`SYMBOL_${symbol.toUpperCase()}`);

  for (const key of raw) {
    await bump(scopeKey(exchange, key), outcome, returnPct);
  }
}

/**
 * getWeightContext(symbol, sector)
 * Returns a short human-readable string for prompt injection, e.g.:
 *   "Agent win rate: 72% from 18 trades. BUY_banks: 78% from 9. NABIL: 80% from 5."
 * Returns '' when there is no track record yet.
 */
export async function getWeightContext(symbol, sector, exchange = DEFAULT_EXCHANGE) {
  const supabase = getSupabase();

  const wantedRaw = ['ALL'];
  if (sector) {
    wantedRaw.push(`BUY_${slug(sector)}`, `SELL_${slug(sector)}`);
  }
  if (symbol) wantedRaw.push(`SYMBOL_${symbol.toUpperCase()}`);
  const wantedKeys = wantedRaw.map((k) => scopeKey(exchange, k));

  const { data } = await supabase
    .from('weights')
    .select('*')
    .in('key', wantedKeys);

  if (!data || data.length === 0) return '';

  const byKey = Object.fromEntries(data.map((w) => [w.key, w]));
  const parts = [];

  const all = byKey[scopeKey(exchange, 'ALL')];
  if (all && all.wins + all.losses > 0) {
    parts.push(`Agent win rate: ${slice(all)} (avg return ${num(all.avg_return)}%)`);
  }

  if (sector) {
    for (const sig of ['BUY', 'SELL']) {
      const w = byKey[scopeKey(exchange, `${sig}_${slug(sector)}`)];
      if (w && w.wins + w.losses > 0) {
        parts.push(`${sig}_${slug(sector)}: ${slice(w)}`);
      }
    }
  }

  if (symbol) {
    const w = byKey[scopeKey(exchange, `SYMBOL_${symbol.toUpperCase()}`)];
    if (w && w.wins + w.losses > 0) {
      parts.push(`${symbol.toUpperCase()}: ${slice(w)}`);
    }
  }

  return parts.join('. ');
}

/**
 * getOverviewContext()
 * Symbol-agnostic track record for consumers that reason over the whole book
 * rather than one stock — discovery, the daily brief, and the chat advisor.
 * Returns the overall win rate plus a leaderboard of the best signal+sector
 * slices (>=2 trades), e.g.:
 *   "Overall agent win rate: 68% from 25 trades (avg return 1.9%). By
 *    signal+sector — BUY_banks: 78% (9 trades, avg +3.1%); SELL_hydropower: 60% (5 trades, avg +0.8%)."
 * Returns '' when there is no track record yet.
 */
export async function getOverviewContext(exchange = DEFAULT_EXCHANGE) {
  const supabase = getSupabase();
  const { data } = await supabase.from('weights').select('*');
  if (!data || data.length === 0) return '';

  const byKey = Object.fromEntries(data.map((w) => [w.key, w]));
  const parts = [];

  const all = byKey[scopeKey(exchange, 'ALL')];
  if (all && all.wins + all.losses > 0) {
    parts.push(`Overall agent win rate: ${slice(all)} (avg return ${num(all.avg_return)}%).`);
    const rw = recentRate(all);
    if (rw != null) parts.push(`Recent-weighted win rate (favours the current regime): ${pct(rw)}.`);
  }

  // Leaderboard across THIS exchange's BUY_*/SELL_* slices with enough trades to be
  // meaningful, ranked by the Wilson LOWER BOUND (not raw rate) so a thin "100% from
  // 2" cannot top a proven "75% from 30". Cap at the top 6 so the prompt stays tight.
  // The exchange prefix (`NYSE:` / '' for NEPSE) keeps each exchange's board separate.
  const prefix = scopeKey(exchange, '');
  const sliceRe = new RegExp(`^${prefix}(BUY|SELL)_`);
  const slices = data
    .filter((w) => sliceRe.test(w.key) && w.wins + w.losses >= 2)
    .map((w) => ({ w, lb: wilsonLowerBound(w.wins, w.wins + w.losses) }))
    .sort((a, b) => b.lb - a.lb || b.w.wins + b.w.losses - (a.w.wins + a.w.losses))
    .slice(0, 6)
    .map(({ w }) => `${w.key}: ${slice(w)} avg ${num(w.avg_return)}%`);

  if (slices.length) parts.push(`By signal+sector (ranked by confidence-adjusted rate) — ${slices.join('; ')}.`);

  return parts.join(' ');
}

function slug(s) {
  return String(s).trim().toLowerCase().replace(/\s+/g, '_');
}
// Render one calibration slice with its confidence-adjusted (Wilson lower-bound)
// rate, so the prompt shows both the raw rate AND how much to trust it given n.
function slice(w) {
  const n = (w.wins || 0) + (w.losses || 0);
  const lb = wilsonLowerBound(w.wins || 0, n);
  return `${pct(w.rate)} (n=${n}, conservative ${pct(lb)})`;
}
// Recent-regime win rate from the EWMA-decayed counts, or null if the DB has no
// decay data yet (pre-migration or no outcomes recorded since).
function recentRate(w) {
  const dn = (Number(w.dwins) || 0) + (Number(w.dlosses) || 0);
  return dn > 0 ? (Number(w.dwins) || 0) / dn : null;
}
function pct(r) {
  return `${Math.round(Number(r) * 100)}%`;
}
function num(n) {
  return (Math.round(Number(n) * 10) / 10).toFixed(1);
}

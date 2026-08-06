import { getServiceSupabase } from './supabase.js';
import { getVerifiedPrice } from './marketProviders.js';
import { updateWeights } from './calibration.js';
import { recordOutcomeKnowledge } from './knowledge.js';
import { logEvent } from './events.js';
import { sendAlert } from './email.js';
import { normalizeExchange, DEFAULT_EXCHANGE } from './exchanges.js';
import { getActiveAdjustment, applyAdjustment } from './corporateActions.js';
import { corporateActionsReady, signalCaColumnsReady } from './schemaFlags.js';

// TIER-1 #1: a signal suppressed near a corporate-action ex-window that never resolves
// can't sit PENDING forever — after this many hold-days it is VOIDed (terminal escape,
// B branch) and, crucially, NEVER feeds the learning loop (weights/knowledge). Chosen
// well beyond a normal swing hold (days–weeks) so only genuinely stuck signals void.
const CA_MAX_HOLD_DAYS = 45;

// Compose the per-exchange price-map key so two exchanges that happen to share a
// ticker never collide (verified prices come from different sources per exchange).
function priceKey(symbol, exchange) {
  return `${normalizeExchange(exchange)}::${String(symbol).toUpperCase()}`;
}

// checkOutcomes(): for every PENDING signal, fetch the latest price and resolve
// it to WIN (price >= target) or LOSS (price <= sl). Updates the signals row,
// writes an outcomes row, bumps calibration weights, and emails an alert.
export async function checkOutcomes() {
  // Trusted resolution loop (cron-driven): service-role client so the signal
  // updates + outcomes inserts survive RLS being enabled later (Phase 2). The
  // pending-signals read is also trusted here. Behaviour-preserving while RLS is OFF.
  const supabase = getServiceSupabase();

  const { data: pending, error } = await supabase
    .from('signals')
    .select('*')
    .eq('outcome', 'PENDING')
    .in('signal', ['BUY', 'SELL']);

  if (error) throw error;
  if (!pending || pending.length === 0) {
    return { checked: 0, resolved: 0, outcomes: [] };
  }

  const nowIso = new Date().toISOString();

  // TIER-1 #1: corporate-action awareness. Both probes must pass (table + signal CA
  // columns); on an unmigrated DB this is false and the whole CA path is skipped, so
  // resolution is byte-for-byte today. Wrapped best-effort so a probe failure can
  // never break resolution. Precomputed per-signal (indexed reads over a bounded
  // pending set — not the distinct-symbol market-data cost the guardrail protects).
  let caReady = false;
  const adjBySig = new Map(); // sig.id -> { factor, deduction, computable, actions }
  const caFactorByKey = {}; // priceKey -> factor (threads into the guard so an ex-move is accepted)
  try {
    caReady = (await corporateActionsReady()) && (await signalCaColumnsReady());
    if (caReady) {
      for (const sig of pending) {
        if (!sig.symbol) continue;
        const exchange = sig.exchange || DEFAULT_EXCHANGE;
        const adj = await getActiveAdjustment(supabase, sig.symbol, exchange, sig.created_at, nowIso);
        adjBySig.set(sig.id, adj);
        // Only a COMPUTABLE, in-window CA adjusts the guard base; a suppressed one is
        // never resolved so its price never matters.
        if (adj.actions.length && adj.computable) {
          const key = priceKey(sig.symbol, exchange);
          if (caFactorByKey[key] == null) caFactorByKey[key] = adj.factor;
        }
      }
    }
  } catch (err) {
    console.error('corporate-action prepass failed (continuing without CA):', err?.message || err);
  }

  const prices = await fetchLatestPrices(pending, caFactorByKey);

  const resolved = [];
  let voided = 0;

  for (const sig of pending) {
    const exchange = sig.exchange || DEFAULT_EXCHANGE;
    const price = prices[priceKey(sig.symbol, exchange)];

    const adj = adjBySig.get(sig.id) || null;
    const hasCA = !!(adj && adj.actions.length > 0);

    // --- SUPPRESS branch (in-window CA we can't compute): NEVER record a LOSS. ------
    // Leave the signal PENDING; if it has been stuck past the ceiling, VOID it (a
    // terminal escape that is excluded from the learning loop below).
    if (hasCA && !adj.computable) {
      await logEvent(supabase, {
        type: 'corporate_action_suppressed',
        symbol: sig.symbol,
        message: `${sig.symbol} resolution suppressed near a corporate-action ex-window (uncomputable adjustment)`,
        data: { actions: adj.actions },
      });
      if (holdDays(sig.created_at, nowIso) > CA_MAX_HOLD_DAYS) {
        await voidSignal(supabase, sig, nowIso, adj.actions);
        voided += 1;
      }
      continue;
    }

    if (price == null) continue;

    // --- ADJUST branch (computable in-window CA): recompute levels from immutable
    // originals so this is idempotent (no applied-flag). adjusted = orig*factor - deduction.
    let target = numOrNull(sig.target);
    let sl = numOrNull(sig.sl);
    if (hasCA && adj.computable) {
      const orig = {
        target: numOrNull(sig.orig_target ?? sig.target),
        sl: numOrNull(sig.orig_sl ?? sig.sl),
        price: numOrNull(sig.orig_price ?? sig.price),
      };
      const adjusted = applyAdjustment(orig, adj);
      target = adjusted.target;
      sl = adjusted.sl;
      // Persist the immutable originals + the recomputed cumulative adjustment so the
      // UI/track-record can explain the shifted levels. Best-effort; own update.
      await supabase
        .from('signals')
        .update({
          orig_target: orig.target,
          orig_sl: orig.sl,
          orig_price: orig.price,
          ca_factor: adj.factor,
          ca_deduction: adj.deduction,
          ca_note: caNote(adj),
        })
        .eq('id', sig.id);
    }

    let outcome = null;
    if (target != null && price >= target) outcome = 'WIN';
    else if (sl != null && price <= sl) outcome = 'LOSS';

    if (!outcome) continue;

    // Return % is measured against the (CA-adjusted) entry so a mechanical ex-drop in
    // BOTH entry and exit nets out instead of showing a phantom loss.
    const entryPrice =
      hasCA && adj.computable
        ? applyAdjustment({ price: numOrNull(sig.orig_price ?? sig.price) }, adj).price
        : numOrNull(sig.price);
    const returnPct =
      entryPrice && entryPrice !== 0 ? ((price - entryPrice) / entryPrice) * 100 : 0;

    // Update the signal row.
    await supabase
      .from('signals')
      .update({
        outcome,
        exit_price: price,
        outcome_at: nowIso,
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
      hold_days: holdDays(sig.created_at, nowIso),
      created_at: nowIso,
    });

    // Update calibration (statistical) + knowledge base (qualitative lessons),
    // scoped to the signal's exchange so NYSE learns from its own outcomes.
    await updateWeights(sig.symbol, sig.sector, sig.signal, outcome, returnPct, exchange);
    await recordOutcomeKnowledge(sig, outcome, price, returnPct);

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
      data: { signal: sig.signal, outcome, price, returnPct, target, sl, caAdjusted: hasCA && adj.computable },
    });

    resolved.push({ symbol: sig.symbol, outcome, price, returnPct });
  }

  return { checked: pending.length, resolved: resolved.length, voided, outcomes: resolved };
}

// voidSignal(): terminal escape (B branch) for a signal stuck PENDING past the ceiling
// because a corporate-action ex-window keeps suppressing it. Marks outcome='VOID' and
// logs an outcomes row, but DELIBERATELY skips updateWeights/recordOutcomeKnowledge —
// a VOID is not a real WIN/LOSS and must NEVER feed the learning loop or track record.
// Best-effort; a failure here just leaves the signal PENDING for the next run.
async function voidSignal(supabase, sig, nowIso, actions) {
  try {
    await supabase
      .from('signals')
      .update({ outcome: 'VOID', outcome_at: nowIso, ca_note: 'Voided: corporate-action ex-window unresolved past hold ceiling' })
      .eq('id', sig.id);
    await supabase.from('outcomes').insert({
      signal_id: sig.id,
      symbol: sig.symbol,
      outcome: 'VOID',
      entry_price: numOrNull(sig.price),
      exit_price: null,
      return_pct: null,
      hold_days: holdDays(sig.created_at, nowIso),
      created_at: nowIso,
    });
    await logEvent(supabase, {
      type: 'outcome_void',
      symbol: sig.symbol,
      message: `${sig.symbol} ${sig.signal} → VOID (corporate-action ex-window unresolved past ${CA_MAX_HOLD_DAYS}d)`,
      data: { signal: sig.signal, actions },
    });
  } catch (err) {
    console.error('voidSignal failed:', err?.message || err);
  }
}

// caNote(adj): a short human note describing the applied corporate-action adjustment.
function caNote(adj) {
  const types = [...new Set((adj.actions || []).map((a) => a.action_type))].join(',');
  const bc = adj.actions?.find((a) => a.book_closure_date)?.book_closure_date;
  return `CA-adjusted: ${types}${bc ? ` (book close ${bc})` : ''}; factor=${round4(adj.factor)}, deduction=${round4(adj.deduction)}`;
}
function round4(n) {
  return Math.round(Number(n) * 10000) / 10000;
}

// Fetch latest VERIFIED prices for a batch of pending signals. Outcome resolution
// decides real money (WIN at target / LOSS at stop), so the exit price must be
// ground truth — never LLM-sourced (CLAUDE.md guardrail #1). Each signal is verified
// against ITS OWN exchange's sources (NEPSE → merolagani, NYSE → yahoo). Any symbol
// whose price can't be verified maps to null and is left PENDING (retried next run).
//
// TIER-1 #1: `caFactorByKey` threads a per-symbol corporate-action factor into the
// verified-price guard so a MECHANICAL ex-move (bonus/rights/dividend) is accepted
// instead of rejected as implausible. A symbol with no CA passes caFactor undefined —
// the byte-for-byte unchanged path.
async function fetchLatestPrices(pending, caFactorByKey = {}) {
  const seen = new Map(); // priceKey -> { symbol, exchange }
  for (const sig of pending) {
    if (!sig.symbol) continue;
    const exchange = sig.exchange || DEFAULT_EXCHANGE;
    const key = priceKey(sig.symbol, exchange);
    if (!seen.has(key)) seen.set(key, { symbol: sig.symbol, exchange });
  }
  if (!seen.size) return {};

  const out = {};
  await Promise.all(
    [...seen.entries()].map(async ([key, { symbol, exchange }]) => {
      try {
        const caFactor = caFactorByKey[key];
        const r = await getVerifiedPrice(symbol, { exchange, caFactor });
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

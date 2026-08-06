import { getServiceSupabase } from './supabase.js';
import { getVerifiedPrice } from './marketProviders.js';
import { updateWeights } from './calibration.js';
import { recordOutcomeKnowledge } from './knowledge.js';
import { logEvent } from './events.js';
import { sendAlert } from './email.js';
import { deliverOutcomeAlert } from './alertDelivery.js';
import { normalizeExchange, DEFAULT_EXCHANGE } from './exchanges.js';
import { getActiveAdjustment, applyAdjustment } from './corporateActions.js';
import { corporateActionsReady, signalCaColumnsReady, outcomeRealismColumnsReady } from './schemaFlags.js';
import { resolveFirstTouch, effectiveMaxHoldDays } from './outcomeResolution.js';
import { netReturn, NOTIONAL_PRINCIPAL } from './charges.js';

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

  // TIER-1 #3: outcome-realism awareness (path-dependent WIN/LOSS + time-stop + net).
  // Gated on the new columns; on an unmigrated DB this is false and the whole realism
  // path is skipped, so resolution is byte-for-byte today (spot-only, gross-only, no
  // EXPIRE). Wrapped best-effort so a probe failure can never break resolution.
  let realismReady = false;
  try {
    realismReady = await outcomeRealismColumnsReady();
  } catch (err) {
    console.error('outcome-realism probe failed (continuing without it):', err?.message || err);
  }

  const prices = await fetchLatestPrices(pending, caFactorByKey);

  const resolved = [];
  let voided = 0;

  for (const sig of pending) {
    const exchange = sig.exchange || DEFAULT_EXCHANGE;
    const priceData = prices[priceKey(sig.symbol, exchange)];
    const price = priceData ? priceData.price : null;

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

    // TIER-1 #3: NON-CA path with the realism columns present → path-dependent WIN/LOSS
    // (first touch over the verified day range + accumulated extremes), a time-stop
    // EXPIRE, and a net-of-charges return alongside gross. First-touch is DELIBERATELY
    // scoped to the non-CA path: under a computable CA the spot-vs-adjusted-level check
    // below stays byte-for-byte (running extremes ignored) to avoid a cross-ex-date
    // false WIN. On an unmigrated DB (realismReady false) this diverts nowhere.
    if (!(hasCA && adj.computable) && realismReady) {
      await resolveRealism(supabase, sig, priceData, exchange, nowIso, resolved);
      continue;
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

    // Alert (global operator channel).
    await sendAlert(
      outcome === 'WIN' ? 'TARGET_HIT' : 'SL_BREACH',
      sig.symbol,
      price,
      outcome === 'WIN' ? target : sl
    );

    // TIER-2: per-user outcome email to watchers of this symbol. Best-effort in its own
    // try/catch so it can never break resolution; a no-op on an unmigrated DB.
    try {
      await deliverOutcomeAlert(supabase, { sig, outcome, exitPrice: price, level: outcome === 'WIN' ? target : sl });
    } catch (err) {
      console.error('deliverOutcomeAlert failed:', err?.message || err);
    }

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

// resolveRealism(): TIER-1 #3 NON-CA resolution. Resolves a signal path-dependently over
// the verified day range (ground-truth high/low), accumulating cross-day extremes so a
// missed intraday touch is not lost; applies a time-stop (EXPIRE) at the hold horizon;
// and records a net-of-charges return alongside gross. Gated by the caller on the new
// columns being present. Best-effort side-channels (alert/knowledge/event) as elsewhere.
//   - target/stop touch → WIN/LOSS at the touched level (stop-first tie-break).
//   - no touch, hold expired → EXPIRE at verified spot (mark-to-market).
//   - no touch, not expired → persist accumulated extremes, stay PENDING (returns without
//     pushing to resolved).
// Learning is fed WIN/LOSS as resolved; an EXPIRE derives its learning label from the
// GROSS return sign (unchanged series semantics). VOID (CA branch) stays excluded.
async function resolveRealism(supabase, sig, priceData, exchange, nowIso, resolved) {
  const price = priceData ? priceData.price : null;
  if (price == null) return;
  const entry = numOrNull(sig.price);
  const target = numOrNull(sig.target);
  const sl = numOrNull(sig.sl);
  const direction = sig.signal; // 'BUY' | 'SELL'

  // Verified day range (ground truth); a degenerate [spot, spot] when no source gave one.
  const todayHigh = numOrNull(priceData.high) ?? price;
  const todayLow = numOrNull(priceData.low) ?? price;

  // Accumulate cross-day extremes so a touch on a day between runs is not missed.
  const prevPeak = numOrNull(sig.peak_high);
  const prevTrough = numOrNull(sig.trough_low);
  const peakHigh = prevPeak != null ? Math.max(prevPeak, todayHigh) : todayHigh;
  const troughLow = prevTrough != null ? Math.min(prevTrough, todayLow) : todayLow;

  // First touch on TODAY's range; if untouched, on the accumulated extremes (missed days).
  let touch = resolveFirstTouch({ direction, target, sl, high: todayHigh, low: todayLow });
  if (!touch.outcome) {
    touch = resolveFirstTouch({ direction, target, sl, high: peakHigh, low: troughLow });
  }

  let outcome = null;
  let exitReason = null;
  let exitPrice = null;
  if (touch.outcome) {
    outcome = touch.outcome; // WIN | LOSS
    exitReason = touch.exitReason; // TARGET | STOP
    exitPrice = touch.exitPrice;
  } else {
    // Time-stop: stored horizon (stamped at insert) or hold-derived, clamped.
    const maxHold = numOrNull(sig.max_hold_days) ?? effectiveMaxHoldDays(sig.hold);
    const hd = holdDays(sig.created_at, nowIso);
    if (hd != null && hd >= maxHold) {
      outcome = 'EXPIRE';
      exitReason = 'EXPIRE';
      exitPrice = price; // mark-to-market at the verified spot
    } else {
      // Not resolved — persist the accumulated extremes so the next run continues from them.
      await supabase.from('signals').update({ peak_high: peakHigh, trough_low: troughLow }).eq('id', sig.id);
      return;
    }
  }

  const hd = holdDays(sig.created_at, nowIso);
  // Gross return keeps the existing series semantics: (exit - entry)/entry * 100.
  const returnPct = entry && entry !== 0 ? ((exitPrice - entry) / entry) * 100 : 0;

  // Net-of-charges is the track-record HEADLINE, scoped to NEPSE (NYSE net == gross).
  let netReturnPct = returnPct;
  if (normalizeExchange(exchange) === DEFAULT_EXCHANGE) {
    netReturnPct = netReturn({ entry, exit: exitPrice, direction, holdDays: hd, notional: NOTIONAL_PRINCIPAL }).netPct;
  }

  // EXPIRE feeds the learning loop by GROSS return sign; WIN/LOSS feed as resolved.
  // Direction-aware: a SELL profits when price FALLS, so its raw (exit-entry)/entry gross
  // is NEGATIVE on a win. Classifying an EXPIRE on the raw sign would invert every SELL
  // expiry (a profitable short logged as LOSS) and poison the SELL_<sector> weight slice,
  // so classify on the DIRECTIONAL gross sign (raw for BUY, negated for SELL).
  const directionalGross = String(direction).toUpperCase() === 'SELL' ? -returnPct : returnPct;
  const learningOutcome = outcome === 'EXPIRE' ? (directionalGross > 0 ? 'WIN' : 'LOSS') : outcome;

  await supabase
    .from('signals')
    .update({
      outcome,
      exit_price: exitPrice,
      outcome_at: nowIso,
      return_pct: returnPct,
      net_return_pct: netReturnPct,
      exit_reason: exitReason,
      peak_high: peakHigh,
      trough_low: troughLow,
    })
    .eq('id', sig.id);

  await supabase.from('outcomes').insert({
    signal_id: sig.id,
    symbol: sig.symbol,
    outcome,
    entry_price: entry,
    exit_price: exitPrice,
    return_pct: returnPct,
    net_return_pct: netReturnPct,
    exit_reason: exitReason,
    hold_days: hd,
    created_at: nowIso,
  });

  // Learning (statistical + qualitative), scoped to the signal's exchange.
  await updateWeights(sig.symbol, sig.sector, sig.signal, learningOutcome, returnPct, exchange);
  await recordOutcomeKnowledge(sig, learningOutcome, exitPrice, returnPct);

  // Alert only on a genuine target/stop touch (EXPIRE is neither hit nor breach).
  if (outcome === 'WIN' || outcome === 'LOSS') {
    await sendAlert(
      outcome === 'WIN' ? 'TARGET_HIT' : 'SL_BREACH',
      sig.symbol,
      exitPrice,
      outcome === 'WIN' ? target : sl
    );
    // TIER-2: per-user outcome email to watchers. Best-effort; no-op on an unmigrated DB.
    try {
      await deliverOutcomeAlert(supabase, { sig, outcome, exitPrice, level: outcome === 'WIN' ? target : sl });
    } catch (err) {
      console.error('deliverOutcomeAlert failed:', err?.message || err);
    }
  }

  await logEvent(supabase, {
    type: outcome === 'WIN' ? 'outcome_win' : outcome === 'LOSS' ? 'outcome_loss' : 'outcome_expire',
    symbol: sig.symbol,
    message: `${sig.symbol} ${sig.signal} → ${outcome} (${returnPct >= 0 ? '+' : ''}${returnPct.toFixed(1)}% gross / ${netReturnPct >= 0 ? '+' : ''}${netReturnPct.toFixed(1)}% net${exitReason ? `, ${exitReason}` : ''}) at ${exitPrice}`,
    data: { signal: sig.signal, outcome, exitReason, price: exitPrice, returnPct, netReturnPct, target, sl },
  });

  resolved.push({ symbol: sig.symbol, outcome, price: exitPrice, returnPct, netReturnPct, exitReason });
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
        // TIER-1 #3: carry the verified day RANGE alongside the spot price so the
        // resolver can catch an intraday/cross-day TARGET or STOP touch. `range` is
        // best-effort metadata off the verified layer (null when no source supplied a
        // consistent, plausible one) — the price still gates verification as before.
        out[key] = r.verified
          ? { price: r.price, high: r.range?.high ?? null, low: r.range?.low ?? null }
          : null;
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

import { normalizeExchange, DEFAULT_EXCHANGE } from './exchanges.js';
import { alertDeliveryReady, outcomeDeliveryReady } from './schemaFlags.js';
import { deliverEmail } from './notify.js';
import { listUserEmailMap } from './userDirectory.js';
import { logEvent } from './events.js';

// TIER-2 — per-user alert DELIVERY. Turns the stored-but-unused alert_prefs into real
// email notifications when a WATCHED symbol flips to BUY/SELL, plus per-user outcome
// (TARGET_HIT/SL_BREACH) emails to watchers. A user's alerts are a FILTER over the
// SHARED signals — NEVER a re-fetch/re-scan (the "market data is GLOBAL" guardrail).
// Every path is best-effort and wrapped so it can NEVER throw into the scan/outcome flow.

// The educational framing every user-facing signal/brief must carry.
const DISCLAIMER = 'Educational, not financial advice · past performance ≠ future results.';

// Cap on how many per-user emails a single brief run sends inline, so a broad flip day
// can't blow the 60s Vercel budget with a synchronous fan-out. Users beyond the cap are
// simply not emailed THIS run — their cursor still advances (so they won't burst later),
// and a warning event records the overflow.
export const MAX_INLINE_ALERT_SENDS = 50;

// Namespace a delivery cursor by (user, exchange, symbol) — matches the table PK.
function cursorKey(userId, exchange, symbol) {
  return `${userId}::${normalizeExchange(exchange)}::${String(symbol).toUpperCase()}`;
}

// --- pure core -------------------------------------------------------------
// computeSignalAlertEvents({ signals, watchByUser, prefsByUser, cursorByKey, exchange })
//   -> { events:[{user_id,symbol,direction,signal_id}], cursorUpserts:[...] }
//
// Pure + never throws. Implements the REFINED alert-worthy rule (absent-cursor SEEDS
// silently — the first observation of any standing signal is a silent initialization,
// never an alert; only a direction CHANGE from a previously-recorded direction fires):
//   - No prior cursor            -> upsert cursor (seed), NO event (BUY/SELL/HOLD/AVOID).
//   - Prior, same last_signal_id -> skip entirely (idempotent re-run).
//   - Prior, direction UNCHANGED -> advance cursor, NO event.
//   - Prior, changed -> BUY (onBuy) / SELL (onSell) -> emit event + advance cursor.
//   - Prior, changed -> BUY/SELL but that threshold off -> advance cursor, NO event.
//   - Prior, changed -> HOLD/AVOID -> advance cursor, NO event.
//   - Symbol not on the user's watchlist / not in this scan -> ignored.
//
// `signals` carry { id, symbol, signal, scan_id }; cursorUpserts carry the prior sent_at
// forward (the IO layer stamps sent_at only on a real successful send).
export function computeSignalAlertEvents({ signals, watchByUser, prefsByUser, cursorByKey, exchange } = {}) {
  const ex = normalizeExchange(exchange);
  const events = [];
  const cursorUpserts = [];

  const sigList = Array.isArray(signals) ? signals : [];
  const watchMap = watchByUser instanceof Map ? watchByUser : new Map();
  const prefsMap = prefsByUser instanceof Map ? prefsByUser : new Map();
  const cursors = cursorByKey instanceof Map ? cursorByKey : new Map();

  // Index this scan's signals by uppercased symbol (a scan yields one signal per symbol).
  const sigBySymbol = new Map();
  for (const s of sigList) {
    if (!s || !s.symbol) continue;
    sigBySymbol.set(String(s.symbol).toUpperCase(), s);
  }

  for (const [userId, symbols] of watchMap.entries()) {
    if (!userId) continue;
    const symSet = symbols instanceof Set ? symbols : new Set(symbols || []);
    const thresholds = prefsMap.get(userId)?.thresholds || {};

    for (const rawSym of symSet) {
      const sym = String(rawSym).toUpperCase();
      const sig = sigBySymbol.get(sym);
      if (!sig) continue; // watched symbol not in this scan -> ignore
      const direction = String(sig.signal || '').toUpperCase();
      if (!direction) continue;

      const key = cursorKey(userId, ex, sym);
      const prior = cursors.get(key) || null;

      // Idempotent re-run: the same signal we already recorded -> nothing to do.
      if (prior && prior.last_signal_id && sig.id && prior.last_signal_id === sig.id) {
        continue;
      }

      const upsert = {
        user_id: userId,
        exchange: ex,
        symbol: sym,
        last_direction: direction,
        last_signal_id: sig.id ?? null,
        last_scan_id: sig.scan_id ?? null,
        sent_at: prior?.sent_at ?? null, // carried forward; IO stamps on a real send
      };

      // REFINEMENT: no prior cursor -> seed silently, whatever the direction. This is
      // what stops a burst of "new BUY" for every pre-existing standing signal the first
      // time delivery runs (or the first scan after a user adds a watchlist symbol).
      if (!prior) {
        cursorUpserts.push(upsert);
        continue;
      }

      const priorDir = String(prior.last_direction || '').toUpperCase();

      // Direction unchanged -> advance cursor, no event.
      if (priorDir === direction) {
        cursorUpserts.push(upsert);
        continue;
      }

      // Direction CHANGED. Emit only for BUY (onBuy) or SELL (onSell); HOLD/AVOID never.
      if ((direction === 'BUY' && thresholds.onBuy) || (direction === 'SELL' && thresholds.onSell)) {
        events.push({ user_id: userId, symbol: sym, direction, signal_id: sig.id ?? null });
      }
      cursorUpserts.push(upsert);
    }
  }

  return { events, cursorUpserts };
}

// formatUserAlert(email, events, exchange) -> { subject, text }
// Pure. Builds ONE aggregated body listing every flipped symbol for a user, WITH the
// educational-not-advice disclaimer line. `email` is the recipient (its own inbox) — it
// is not embedded in the body (nothing to gain, and it keeps the copy clean).
export function formatUserAlert(email, events, exchange) {
  const ex = normalizeExchange(exchange);
  const evs = Array.isArray(events) ? events : [];
  const n = evs.length;
  const subject = `${ex} watchlist alert — ${n} signal change${n === 1 ? '' : 's'}`;
  const lines = [];
  lines.push(`${n} watched symbol${n === 1 ? '' : 's'} on ${ex} changed signal:`);
  for (const e of evs) lines.push(`- ${e.symbol}: now ${e.direction}`);
  lines.push('');
  lines.push(DISCLAIMER);
  return { subject, text: lines.join('\n') };
}

// formatOutcomeAlert — internal body builder for a per-user outcome email (TARGET_HIT/
// SL_BREACH), also carrying the disclaimer.
function formatOutcomeAlert({ sig, type, exitPrice, level, exchange }) {
  const ex = normalizeExchange(exchange);
  const sym = String(sig.symbol).toUpperCase();
  const hit = type === 'TARGET_HIT';
  const subject = `${ex} ${sym} — ${hit ? 'target hit' : 'stop-loss breached'}`;
  const lines = [];
  lines.push(
    hit
      ? `${sym} reached its target at ${level} (now ${exitPrice}).`
      : `${sym} breached its stop-loss at ${level} (now ${exitPrice}).`
  );
  lines.push(`From the original ${String(sig.signal || '').toUpperCase()} signal.`);
  lines.push('');
  lines.push(DISCLAIMER);
  return { subject, text: lines.join('\n') };
}

// --- orchestration (IO) ----------------------------------------------------
// deliverSignalAlerts(supabase, { scanId, exchange }): resolve + send the per-user
// watchlist-flip emails for one finished scan. `supabase` MUST be the service client
// (owner-read/service-write ledgers + the Auth admin API). Whole function wrapped —
// never throws into the brief flow. Reads are a FILTER over the shared signals: this
// re-fetches NO market data.
export async function deliverSignalAlerts(supabase, { scanId, exchange } = {}) {
  try {
    if (!scanId) return;
    if (!(await alertDeliveryReady())) return; // unmigrated DB -> byte-for-byte no-op
    const ex = normalizeExchange(exchange);

    // 1. This scan's signals (shared data; a filter, not a re-fetch).
    const { data: sigRows } = await supabase
      .from('signals')
      .select('id, symbol, signal, scan_id')
      .eq('scan_id', scanId);
    const signals = (sigRows || []).filter((s) => s && s.symbol && s.signal);
    if (!signals.length) return;
    const symbols = [...new Set(signals.map((s) => String(s.symbol).toUpperCase()))];

    // 2. Watchlists for this exchange whose symbol appears in this scan.
    const { data: wlRows } = await supabase
      .from('watchlists')
      .select('user_id, symbol')
      .eq('exchange', ex)
      .in('symbol', symbols);
    const watchByUser = new Map();
    const userIds = new Set();
    for (const w of wlRows || []) {
      if (!w?.user_id || !w?.symbol) continue;
      userIds.add(w.user_id);
      if (!watchByUser.has(w.user_id)) watchByUser.set(w.user_id, new Set());
      watchByUser.get(w.user_id).add(String(w.symbol).toUpperCase());
    }
    if (!userIds.size) return;

    // 3. Alert prefs for the involved users (a missing row reads as all-false).
    const { data: prefRows } = await supabase
      .from('alert_prefs')
      .select('user_id, channels, thresholds')
      .in('user_id', [...userIds]);
    const prefsByUser = new Map();
    for (const p of prefRows || []) {
      prefsByUser.set(p.user_id, { channels: p.channels || {}, thresholds: p.thresholds || {} });
    }

    // 4. Existing delivery cursors for the involved (user, exchange, symbol) tuples.
    const { data: curRows } = await supabase
      .from('alert_deliveries')
      .select('user_id, exchange, symbol, last_direction, last_signal_id, last_scan_id, sent_at')
      .eq('exchange', ex)
      .in('user_id', [...userIds])
      .in('symbol', symbols);
    const cursorByKey = new Map();
    for (const c of curRows || []) cursorByKey.set(cursorKey(c.user_id, c.exchange, c.symbol), c);

    // 5. Pure decision.
    const { events, cursorUpserts } = computeSignalAlertEvents({
      signals,
      watchByUser,
      prefsByUser,
      cursorByKey,
      exchange: ex,
    });

    // 6. Group events by user; only users whose EMAIL channel is on get delivered.
    const eventsByUser = new Map();
    for (const e of events) {
      if (!eventsByUser.has(e.user_id)) eventsByUser.set(e.user_id, []);
      eventsByUser.get(e.user_id).push(e);
    }
    let deliverable = [...eventsByUser.entries()].filter(([uid]) => !!prefsByUser.get(uid)?.channels?.email);

    // Cap the inline fan-out to protect the 60s budget.
    if (deliverable.length > MAX_INLINE_ALERT_SENDS) {
      await logEvent(supabase, {
        scanId,
        type: 'alert_delivery_capped',
        message: `alert delivery capped at ${MAX_INLINE_ALERT_SENDS} of ${deliverable.length} users this run`,
        data: { exchange: ex, users: deliverable.length, cap: MAX_INLINE_ALERT_SENDS },
      });
      deliverable = deliverable.slice(0, MAX_INLINE_ALERT_SENDS);
    }

    // 7. Resolve emails + send ONE aggregated email per user (each in its own try/catch).
    const sentKeys = new Set(); // cursor keys we actually emailed -> stamp sent_at
    if (deliverable.length) {
      const emailMap = await listUserEmailMap(supabase);
      const nowIso = new Date().toISOString();
      for (const [uid, userEvents] of deliverable) {
        try {
          const to = emailMap.get(uid);
          if (!to) continue; // couldn't resolve an address -> skip (email never logged)
          const { subject, text } = formatUserAlert(to, userEvents, ex);
          const sent = await deliverEmail({ to, subject, text });
          if (!sent) continue; // channel off (no RESEND_API_KEY) -> no-op, cursor still advances
          for (const e of userEvents) sentKeys.add(cursorKey(uid, ex, e.symbol));
          await logEvent(supabase, {
            scanId,
            type: 'alert_delivered',
            message: `watchlist alert delivered — ${userEvents.length} symbol${userEvents.length === 1 ? '' : 's'}`,
            data: { user_id: uid, exchange: ex, count: userEvents.length },
          });
        } catch (err) {
          console.error(`per-user alert delivery failed (user_id ${uid}):`, err?.message || err);
        }
      }
      if (sentKeys.size) {
        for (const c of cursorUpserts) {
          if (sentKeys.has(cursorKey(c.user_id, c.exchange, c.symbol))) c.sent_at = nowIso;
        }
      }
    }

    // 8. Advance cursors (service client — owner-read, service-write).
    if (cursorUpserts.length) {
      const updatedAt = new Date().toISOString();
      const rows = cursorUpserts.map((c) => ({ ...c, updated_at: updatedAt }));
      await supabase.from('alert_deliveries').upsert(rows, { onConflict: 'user_id,exchange,symbol' });
    }
  } catch (err) {
    console.error('deliverSignalAlerts failed:', err?.message || err);
  }
}

// deliverOutcomeAlert(supabase, { sig, outcome, exitPrice, level }): per-user outcome
// email (WIN -> TARGET_HIT, LOSS -> SL_BREACH) to watchers of the resolved signal's
// symbol. Called right after the GLOBAL sendAlert in checkOutcomes/resolveRealism.
// `supabase` MUST be the service client. Best-effort — never throws into resolution.
export async function deliverOutcomeAlert(supabase, { sig, outcome, exitPrice, level } = {}) {
  try {
    if (!sig || !sig.id || !sig.symbol) return;
    if (outcome !== 'WIN' && outcome !== 'LOSS') return;
    if (!(await outcomeDeliveryReady())) return; // unmigrated DB -> no-op

    const ex = normalizeExchange(sig.exchange || DEFAULT_EXCHANGE);
    const sym = String(sig.symbol).toUpperCase();
    const direction = String(sig.signal || '').toUpperCase();
    const type = outcome === 'WIN' ? 'TARGET_HIT' : 'SL_BREACH';

    // Watchers of this symbol on this exchange (shared data; a filter, not a re-fetch).
    const { data: wlRows } = await supabase
      .from('watchlists')
      .select('user_id')
      .eq('exchange', ex)
      .eq('symbol', sym);
    const userIds = [...new Set((wlRows || []).map((w) => w.user_id).filter(Boolean))];
    if (!userIds.length) return;

    // Their prefs — respect the EMAIL channel + onBuy/onSell per the signal's direction.
    const { data: prefRows } = await supabase
      .from('alert_prefs')
      .select('user_id, channels, thresholds')
      .in('user_id', userIds);
    const prefsByUser = new Map();
    for (const p of prefRows || []) prefsByUser.set(p.user_id, p);
    const wantKey = direction === 'SELL' ? 'onSell' : 'onBuy';
    const interested = userIds.filter((uid) => {
      const p = prefsByUser.get(uid);
      return !!(p?.channels?.email && p?.thresholds?.[wantKey]);
    });
    if (!interested.length) return;

    // Skip any (user, signal) we already emailed (one-shot ledger).
    const { data: doneRows } = await supabase
      .from('outcome_deliveries')
      .select('user_id')
      .eq('signal_id', sig.id)
      .in('user_id', interested);
    const already = new Set((doneRows || []).map((r) => r.user_id));
    const targets = interested.filter((uid) => !already.has(uid));
    if (!targets.length) return;

    const emailMap = await listUserEmailMap(supabase);
    const nowIso = new Date().toISOString();
    const { subject, text } = formatOutcomeAlert({ sig, type, exitPrice, level, exchange: ex });

    const ledger = [];
    for (const uid of targets) {
      try {
        const to = emailMap.get(uid);
        if (!to) continue;
        const sent = await deliverEmail({ to, subject, text });
        if (sent) ledger.push({ user_id: uid, signal_id: sig.id, sent_at: nowIso });
      } catch (err) {
        console.error(`per-user outcome alert failed (user_id ${uid}):`, err?.message || err);
      }
    }
    if (ledger.length) {
      await supabase.from('outcome_deliveries').upsert(ledger, { onConflict: 'user_id,signal_id' });
    }
  } catch (err) {
    console.error('deliverOutcomeAlert failed:', err?.message || err);
  }
}

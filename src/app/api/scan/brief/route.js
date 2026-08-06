import { NextResponse } from 'next/server';
import { getServiceSupabase } from '@/lib/supabase';
import { runBrief } from '@/lib/scan';
import { checkOutcomes } from '@/lib/outcomes';
import { refreshCorporateActions } from '@/lib/corporateActions';
import { deliverSignalAlerts } from '@/lib/alertDelivery';
import { runBackground } from '@/lib/background';
import { logEvent } from '@/lib/events';
import { notify, formatScanDigest } from '@/lib/notify';
import { exchangeColumnReady, systemWatchlistReady } from '@/lib/schemaFlags';
import { selectPromotions } from '@/lib/systemWatchlist';
import { filterLiquidSymbols, resolveMinTurnover } from '@/lib/liquidity';
import { getLiquidityBoard } from '@/lib/marketProviders';
import { withGuard } from '@/lib/respond';
import { KV, SIGNAL_HISTORY_SCANS, WATCH_PROMOTE_MIN } from '@/lib/constants';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// POST /api/scan/brief  { scan_id }
export const POST = withGuard(async (request) => {
  // Trusted cron write path: service-role client so the brief/scan-row updates,
  // kv_store brief, and watchlist promotion writes survive RLS later (Phase 2).
  // No public reads in this file; behaviour is unchanged while RLS is still OFF.
  const supabase = getServiceSupabase();

  let body = {};
  try {
    body = await request.json();
  } catch {
    /* allow empty body */
  }

  // Resolve the scan to brief: explicit scan_id or the latest running scan.
  let scanId = body?.scan_id;
  if (!scanId) {
    const { data } = await supabase
      .from('scans')
      .select('id')
      .in('status', ['running', 'pending'])
      .order('started_at', { ascending: false })
      .limit(1);
    scanId = data?.[0]?.id;
  }
  if (!scanId) return NextResponse.json({ error: 'no scan to brief' }, { status: 404 });

  // 1. Collect this scan's done jobs and resolved signals.
  const { data: jobs } = await supabase
    .from('scan_jobs')
    .select('symbol, status, result')
    .eq('scan_id', scanId);

  const doneSignals = (jobs || [])
    .filter((j) => j.status === 'done' && j.result)
    .map((j) => j.result);

  const failures = (jobs || []).filter((j) => j.status === 'permanently_failed');
  const skipped = (jobs || []).filter((j) => j.status === 'skipped');

  const hasExchangeCol = await exchangeColumnReady();
  const { data: scan } = await supabase
    .from('scans')
    .select(hasExchangeCol ? 'market, exchange' : 'market')
    .eq('id', scanId)
    .maybeSingle();
  const portfolio = await loadPortfolio(supabase);

  // 2. Generate the brief, framed + learning-scoped to the scan's exchange.
  let brief = {};
  try {
    brief = await runBrief(doneSignals, scan?.market || {}, portfolio, scan?.exchange || 'NEPSE');
  } catch (err) {
    console.error('brief generation failed:', err?.message || err);
    brief = { headline: 'Brief unavailable', summary: '', topPicks: [], watch: [], risks: '', stale: [] };
  }

  // 3. Save brief to the scan row and the KV store.
  await supabase.from('scans').update({ brief, phase: 'brief' }).eq('id', scanId);
  await supabase.from('kv_store').upsert(
    { key: KV.BRIEF, value: brief, updated_at: new Date().toISOString() },
    { onConflict: 'key' }
  );

  // 4. Watchlist auto-promotion — REINSTATED into the GLOBAL system_watchlist.
  // Symbols repeatedly parked on the "watch" side (HOLD) across the recent window are
  // promoted into the curated universe so the agent keeps monitoring them (and they
  // surface on Today when they later flip to BUY/SELL). Runs best-effort in the
  // background block below (its own try/catch) so it can never throw into the brief
  // flow. Gated on settings.auto_promote_on (default on) + the schema-flag probe.
  //
  // NOTE (auto-PRUNE / auto-remove is NOT reinstated): the legacy pruneWatchlist wrote
  // the dead kv_store['ni:wl'] key. Auto-removal from a SHARED curated list is a
  // different product decision (a symbol one user finds stale another may still want),
  // so the Settings "Auto-Remove" control stays inactive for now.
  const settings = await loadSettings(supabase);
  const promoExchange = scan?.exchange || 'NEPSE';

  // 5. Mark the scan done / partial.
  const status = failures.length > 0 || skipped.length > 0 ? 'partial' : 'done';
  await supabase
    .from('scans')
    .update({
      status,
      phase: 'complete',
      current_symbol: null,
      signals: doneSignals,
      completed_at: new Date().toISOString(),
    })
    .eq('id', scanId);

  const actionable = doneSignals.filter((s) => s.signal === 'BUY' || s.signal === 'SELL');
  await logEvent(supabase, {
    scanId,
    type: 'scan_finished',
    message: `Scan ${status} — ${doneSignals.length} signal${doneSignals.length === 1 ? '' : 's'}, ${actionable.length} actionable`,
    data: {
      status,
      signals: doneSignals.length,
      actionable: actionable.length,
      failed: failures.length,
      skipped: skipped.length,
    },
  });

  // 6. Deliver the brief + health alert, then run outcome monitoring — both in the
  // background so they don't delay the response or risk the 60s budget. Notify only
  // when there's something worth pinging about: a partial/failed scan (observability
  // alert) or actionable signals (the daily-brief delivery). Best-effort; a channel
  // with no env configured is simply skipped.
  await runBackground(async () => {
    try {
      if (status === 'partial' || actionable.length > 0) {
        await notify(
          formatScanDigest({
            status,
            brief,
            signals: doneSignals.length,
            actionable: actionable.length,
            failed: failures.length,
            skipped: skipped.length,
          })
        );
      }
    } catch (err) {
      console.error('notify failed:', err?.message || err);
    }
    // TIER-1 #1: refresh the global corporate-actions table (bonus/rights/dividend
    // ex-dates) BEFORE resolving outcomes, so checkOutcomes sees the latest ex-windows
    // and can adjust/suppress instead of recording a mechanical ex-drop as a false
    // LOSS. Best-effort in its own try/catch — a crawl failure must never block outcome
    // resolution. (Can graduate to its own chained worker if the crawl grows past the
    // 60s budget; today it's a small bounded fetch of merolagani announcement pages.)
    try {
      await refreshCorporateActions(supabase);
    } catch (err) {
      console.error('refreshCorporateActions failed:', err?.message || err);
    }
    try {
      await checkOutcomes();
    } catch (err) {
      console.error('checkOutcomes failed:', err?.message || err);
    }
    // TIER-2: per-user watchlist-flip alerts. A FILTER over the shared signals just
    // saved for this scan (no market-data re-fetch); best-effort in its own try/catch so
    // a delivery failure can never break the scan. Gated on the alert_deliveries table —
    // a no-op on an unmigrated DB. Uses the same service supabase + this scan's id.
    try {
      await deliverSignalAlerts(supabase, { scanId, exchange: scan?.exchange || 'NEPSE' });
    } catch (err) {
      console.error('deliverSignalAlerts failed:', err?.message || err);
    }
    // Auto-promotion into the GLOBAL system_watchlist. Own try/catch so a failure here
    // (or an unmigrated DB) never breaks the brief/outcome flow. No market/LLM I/O in
    // the hot path beyond one liquidity-board read at write time.
    try {
      if (settings.auto_promote_on !== false && (await systemWatchlistReady())) {
        await promoteToSystemWatchlist(supabase, {
          exchange: promoExchange,
          settings,
          hasExchangeCol,
          scanId,
        });
      }
    } catch (err) {
      console.error('promoteToSystemWatchlist failed:', err?.message || err);
    }
  });

  return NextResponse.json({
    ok: true,
    scan_id: scanId,
    status,
    signals: doneSignals.length,
    failed: failures.length,
    skipped: skipped.length,
    brief,
  });
});

async function loadSettings(supabase) {
  const { data } = await supabase
    .from('kv_store')
    .select('value')
    .eq('key', KV.SETTINGS)
    .maybeSingle();
  return data?.value || {};
}

// Reinstated auto-promotion INTO the GLOBAL system_watchlist. Tally HOLD signals over
// the recent scan window (this exchange), pick the symbols that appear at least
// watch_promote_min times, liquidity-filter them at write time, and SERVICE-upsert the
// survivors as source:'discovery'. Best-effort — the caller wraps this in its own
// try/catch; every side-channel step (event log) is swallowed. GLOBAL list: NO user_id,
// symbols only (never prices), service client (RLS is public-read/service-write).
async function promoteToSystemWatchlist(supabase, { exchange, settings, hasExchangeCol, scanId }) {
  // 1. Resolve the recent scan window (this exchange when the column exists).
  let scanQuery = supabase
    .from('scans')
    .select('id')
    .order('started_at', { ascending: false })
    .limit(SIGNAL_HISTORY_SCANS);
  if (hasExchangeCol) scanQuery = scanQuery.eq('exchange', exchange);
  const { data: recentScans } = await scanQuery;
  const scanIds = (recentScans || []).map((s) => s.id).filter((id) => id != null);
  if (!scanIds.length) return;

  // 2. Tally HOLD appearances per symbol across those scans.
  const { data: holdRows } = await supabase
    .from('signals')
    .select('symbol')
    .eq('signal', 'HOLD')
    .in('scan_id', scanIds);
  const counts = {};
  for (const row of holdRows || []) {
    const sym = String(row?.symbol || '').toUpperCase().trim();
    if (!sym) continue;
    counts[sym] = (counts[sym] || 0) + 1;
  }

  // 3. Pick candidates over the threshold, then liquidity-filter at write time.
  const minAppearances = settings.watch_promote_min ?? WATCH_PROMOTE_MIN;
  const candidates = selectPromotions(counts, { minAppearances });
  if (!candidates.length) return;
  const survivors = filterLiquidSymbols(candidates, await getLiquidityBoard(), resolveMinTurnover(settings));
  if (!survivors.length) return;

  // 4. INSERT only genuinely NEW survivors as curated 'discovery' rows. ADDITIVE-ONLY
  // (ignoreDuplicates → INSERT ... ON CONFLICT DO NOTHING): promotion must NEVER
  // reactivate a symbol an admin deactivated, nor overwrite a 'seed'/'admin' row's
  // source/active. An existing row (any source, active or not) is left untouched; only
  // symbols not already in the list are added. Admin curation stays authoritative.
  const now = new Date().toISOString();
  const rows = survivors.map((symbol) => ({
    symbol,
    exchange,
    source: 'discovery',
    active: true,
    updated_at: now,
  }));
  const { error } = await supabase
    .from('system_watchlist')
    .upsert(rows, { onConflict: 'exchange,symbol', ignoreDuplicates: true });
  if (error) throw error;

  // Best-effort event log (side-channel; never throws into the flow).
  await logEvent(supabase, {
    scanId,
    type: 'watch_promoted',
    message: `Promoted ${survivors.length} symbol${survivors.length === 1 ? '' : 's'} to the curated watchlist — ${survivors.join(', ')}`,
    data: { exchange, promoted: survivors, minAppearances },
  });
}

async function loadPortfolio(supabase) {
  const { data } = await supabase
    .from('kv_store')
    .select('value')
    .eq('key', 'ni:portfolio')
    .maybeSingle();
  const v = data?.value;
  if (Array.isArray(v)) return v;
  return Array.isArray(v?.positions) ? v.positions : [];
}

// NOTE: the legacy promoteWatchlist()/pruneWatchlist() (which wrote the dead GLOBAL
// kv_store['ni:wl'] key) are gone. Auto-PROMOTION is reinstated as
// promoteToSystemWatchlist() above — it writes the GLOBAL `system_watchlist` table (the
// scan union's curated seed), not a per-user list. Auto-PRUNE was NOT reinstated:
// removing a symbol from a SHARED curated list on one signal's "staleness" is a
// different product decision, so the Settings "Auto-Remove" control stays inactive.

import { NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';
import { runBrief } from '@/lib/scan';
import { checkOutcomes } from '@/lib/outcomes';
import { runBackground } from '@/lib/background';
import { logEvent } from '@/lib/events';
import { notify, formatScanDigest } from '@/lib/notify';
import { exchangeColumnReady } from '@/lib/schemaFlags';
import { withGuard } from '@/lib/respond';
import { KV, SIGNAL_HISTORY_SCANS, WATCH_PROMOTE_MIN } from '@/lib/constants';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// POST /api/scan/brief  { scan_id }
export const POST = withGuard(async (request) => {
  const supabase = getSupabase();

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

  // 4. Auto-remove stale stocks from the watchlist.
  if (Array.isArray(brief.stale) && brief.stale.length) {
    await pruneWatchlist(supabase, brief.stale);
  }

  // 4b. Promotion engine: keep monitoring symbols that sit on the "watch" side
  // (consistently HOLD) by auto-adding them to the watchlist, and refresh each
  // watchlist entry's latest signal so the UI can flag the ones now actionable.
  await promoteWatchlist(supabase, scanId, brief.stale || []);

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
    try {
      await checkOutcomes();
    } catch (err) {
      console.error('checkOutcomes failed:', err?.message || err);
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

async function loadPortfolio(supabase) {
  const { data } = await supabase
    .from('kv_store')
    .select('value')
    .eq('key', 'ni:portfolio')
    .maybeSingle();
  const v = data?.value;
  return Array.isArray(v) ? v : Array.isArray(v?.positions) ? v.positions : [];
}

// Auto-promote consistently-watched symbols and refresh the latest-signal state
// on every watchlist entry. "Watch side" = HOLD; a symbol seen HOLD in at least
// WATCH_PROMOTE_MIN of the last SIGNAL_HISTORY_SCANS scans is added so the agent
// keeps tracking it. Entries are stored as objects so the UI can show their state
// and highlight the ones now BUY/SELL ("actionable").
async function promoteWatchlist(supabase, scanId, staleSymbols) {
  // Recent scans (newest first) → the history window.
  const { data: recentScans } = await supabase
    .from('scans')
    .select('id')
    .order('started_at', { ascending: false })
    .limit(SIGNAL_HISTORY_SCANS);
  const scanIds = (recentScans || []).map((s) => s.id);
  if (!scanIds.length) return;

  const { data: rows } = await supabase
    .from('signals')
    .select('symbol, signal, scan_id, created_at')
    .in('scan_id', scanIds);
  if (!rows || !rows.length) return;

  // Per-symbol: count HOLD appearances and capture the latest signal.
  const bySymbol = new Map();
  for (const r of rows) {
    const sym = (r.symbol || '').toUpperCase();
    if (!sym) continue;
    const e = bySymbol.get(sym) || { holds: 0, latest: null, latestAt: 0 };
    if (r.signal === 'HOLD') e.holds += 1;
    const ts = r.created_at ? new Date(r.created_at).getTime() : 0;
    if (ts >= e.latestAt) {
      e.latestAt = ts;
      e.latest = r.signal;
    }
    bySymbol.set(sym, e);
  }

  const stale = new Set((staleSymbols || []).map((s) => String(s).toUpperCase()));

  // Load + normalise the current watchlist (tolerates string[] or {symbols}).
  const { data: kv } = await supabase
    .from('kv_store')
    .select('value')
    .eq('key', KV.WATCHLIST)
    .maybeSingle();
  const value = kv?.value;
  const wasWrapped = !Array.isArray(value) && Array.isArray(value?.symbols);
  const list = Array.isArray(value) ? value : wasWrapped ? value.symbols : [];

  const entries = new Map();
  for (const item of list) {
    const sym = (typeof item === 'string' ? item : item?.symbol || '').toUpperCase();
    if (!sym) continue;
    entries.set(sym, typeof item === 'string' ? { symbol: sym } : { ...item, symbol: sym });
  }

  const now = new Date().toISOString();
  const promoted = [];

  for (const [sym, e] of bySymbol) {
    if (stale.has(sym)) continue; // don't re-add what the brief just flagged stale
    const existing = entries.get(sym);
    if (existing) {
      // Refresh latest-signal state on entries already tracked.
      entries.set(sym, { ...existing, lastSignal: e.latest, lastSignalAt: now });
    } else if (e.holds >= WATCH_PROMOTE_MIN) {
      entries.set(sym, {
        symbol: sym,
        addedAt: now,
        reason: `auto: HOLD in ${e.holds}/${SIGNAL_HISTORY_SCANS} recent scans`,
        lastSignal: e.latest,
        lastSignalAt: now,
      });
      promoted.push(sym);
    }
  }

  const nextList = [...entries.values()];
  const newValue = wasWrapped ? { ...value, symbols: nextList } : nextList;
  await supabase.from('kv_store').upsert(
    { key: KV.WATCHLIST, value: newValue, updated_at: now },
    { onConflict: 'key' }
  );

  if (promoted.length) {
    await logEvent(supabase, {
      scanId,
      type: 'watchlist_promoted',
      message: `Added to watchlist: ${promoted.join(', ')}`,
      data: { symbols: promoted },
    });
  }
}

async function pruneWatchlist(supabase, staleSymbols) {
  const { data } = await supabase
    .from('kv_store')
    .select('value')
    .eq('key', KV.WATCHLIST)
    .maybeSingle();
  if (!data?.value) return;

  const stale = new Set(staleSymbols.map((s) => String(s).toUpperCase()));
  const value = data.value;
  const list = Array.isArray(value) ? value : value?.symbols;
  if (!Array.isArray(list)) return;

  const pruned = list.filter((item) => {
    const sym = (typeof item === 'string' ? item : item?.symbol || '').toUpperCase();
    return !stale.has(sym);
  });

  const newValue = Array.isArray(value) ? pruned : { ...value, symbols: pruned };
  await supabase.from('kv_store').upsert(
    { key: KV.WATCHLIST, value: newValue, updated_at: new Date().toISOString() },
    { onConflict: 'key' }
  );
}

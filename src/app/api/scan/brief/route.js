import { NextResponse } from 'next/server';
import { getServiceSupabase } from '@/lib/supabase';
import { runBrief } from '@/lib/scan';
import { checkOutcomes } from '@/lib/outcomes';
import { runBackground } from '@/lib/background';
import { logEvent } from '@/lib/events';
import { notify, formatScanDigest } from '@/lib/notify';
import { exchangeColumnReady } from '@/lib/schemaFlags';
import { withGuard } from '@/lib/respond';
import { KV } from '@/lib/constants';

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

  // 4 / 4b. Watchlist auto-prune + auto-promotion DISABLED under multi-tenancy.
  // These used to read/write the legacy GLOBAL kv_store['ni:wl'] key, but the scan
  // universe now reads the PER-USER `watchlists` table (Phase 2 step 4), so both were
  // writing to a dead key that nothing reads — a no-op that only cost DB round-trips.
  // Removed to stop the dead writes; the brief's exchange-scoped stale detection
  // (brief.stale) is still computed and returned, just not acted on here.
  //
  // TODO: auto-promotion under multi-tenancy needs a product decision — either a
  // system/seed watchlist that feeds the scan union (a global row set the operator
  // curates), or drop auto-promotion entirely and let the union be user watchlists +
  // discovery only. Note the gap: intraday light scans have NO watchlist to scan
  // until users add symbols, or the operator's old watchlist is migrated into the
  // per-user `watchlists` table.

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
  if (Array.isArray(v)) return v;
  return Array.isArray(v?.positions) ? v.positions : [];
}

// NOTE (B3): promoteWatchlist()/pruneWatchlist() were removed here. Both read/wrote
// the legacy GLOBAL kv_store['ni:wl'] watchlist, which no part of the multi-tenant
// app reads any more — the scan universe is the union of the per-user `watchlists`
// table (Phase 2 step 4). They were dead writes. See the TODO at the call site
// (step 4/4b) for the auto-promotion product decision still owed.

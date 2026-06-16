import { NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';
import { runBrief } from '@/lib/scan';
import { checkOutcomes } from '@/lib/outcomes';
import { runBackground } from '@/lib/background';
import { withGuard } from '@/lib/respond';
import { KV } from '@/lib/constants';

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

  const { data: scan } = await supabase.from('scans').select('market').eq('id', scanId).maybeSingle();
  const portfolio = await loadPortfolio(supabase);

  // 2. Generate the brief.
  let brief = {};
  try {
    brief = await runBrief(doneSignals, scan?.market || {}, portfolio);
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

  // 6. Trigger outcome monitoring (updates weights + sends alerts) in background.
  await runBackground(async () => {
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

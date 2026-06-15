import { NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';
import { scanMarket, runDiscovery } from '@/lib/scan';
import { triggerRoute } from '@/lib/background';
import { withGuard } from '@/lib/respond';
import {
  KV,
  DEFAULT_WATCHLIST,
  SCAN_GUARD_MS,
  checkCronAuth,
} from '@/lib/constants';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// GET  = Vercel cron trigger
// POST = manual trigger from the UI
export const GET = withGuard((request) => handle(request));
export const POST = withGuard((request) => handle(request));

async function handle(request) {
  if (!checkCronAuth(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const supabase = getSupabase();

  // Idempotency guard: skip if a scan started < 30 min ago and is still active.
  const cutoff = new Date(Date.now() - SCAN_GUARD_MS).toISOString();
  const { data: recent } = await supabase
    .from('scans')
    .select('id, status, started_at')
    .gte('started_at', cutoff)
    .in('status', ['pending', 'running'])
    .order('started_at', { ascending: false })
    .limit(1);

  if (recent && recent.length > 0) {
    return NextResponse.json({ skipped: true, reason: 'scan in progress', scan_id: recent[0].id });
  }

  // 1. Create the scan row.
  const startedAt = new Date().toISOString();
  const { data: scanRows, error: scanErr } = await supabase
    .from('scans')
    .insert({
      status: 'pending',
      phase: 'market',
      total: 0,
      completed: 0,
      failed: 0,
      started_at: startedAt,
    })
    .select()
    .single();

  if (scanErr) return NextResponse.json({ error: scanErr.message }, { status: 500 });
  const scanId = scanRows.id;

  // 2. Fetch market data.
  let market = {};
  try {
    market = await scanMarket();
  } catch (err) {
    await supabase
      .from('scans')
      .update({ status: 'error', error: `market: ${err?.message || err}`, completed_at: new Date().toISOString() })
      .eq('id', scanId);
    return NextResponse.json({ error: `market scan failed: ${err?.message || err}` }, { status: 500 });
  }

  // 3. Resolve watchlist + run discovery.
  const watchlist = await loadWatchlist(supabase);
  let discovered = [];
  try {
    discovered = await runDiscovery(market, await loadSettings(supabase));
  } catch (err) {
    console.error('discovery failed:', err?.message || err);
  }

  const symbols = [...new Set([...watchlist, ...discovered].map((s) => s.toUpperCase()))];

  await supabase
    .from('scans')
    .update({ phase: 'queued', market, total: symbols.length })
    .eq('id', scanId);

  // 4. Create one scan_jobs row per symbol.
  const now = new Date().toISOString();
  const jobs = symbols.map((symbol) => ({
    scan_id: scanId,
    symbol,
    status: 'pending',
    attempt: 0,
    created_at: now,
  }));
  if (jobs.length) {
    const { error: jobErr } = await supabase.from('scan_jobs').insert(jobs);
    if (jobErr) {
      await supabase
        .from('scans')
        .update({ status: 'error', error: `jobs: ${jobErr.message}` })
        .eq('id', scanId);
      return NextResponse.json({ error: jobErr.message }, { status: 500 });
    }
  }

  await supabase.from('scans').update({ status: 'running', phase: 'stocks' }).eq('id', scanId);

  // 5. Kick off the worker (fire and forget).
  triggerRoute('/api/scan/worker', {
    headers: process.env.CRON_SECRET ? { authorization: `Bearer ${process.env.CRON_SECRET}` } : {},
  });

  // 6. Return immediately (well within 60s).
  return NextResponse.json({
    started: true,
    scan_id: scanId,
    total: symbols.length,
    discovered,
    watchlist,
    sentiment: market.sentiment,
  });
}

async function loadWatchlist(supabase) {
  const { data } = await supabase
    .from('kv_store')
    .select('value')
    .eq('key', KV.WATCHLIST)
    .maybeSingle();

  const value = data?.value;
  const list = Array.isArray(value) ? value : Array.isArray(value?.symbols) ? value.symbols : [];
  const symbols = list.map((s) => (typeof s === 'string' ? s : s?.symbol)).filter(Boolean);
  return symbols.length ? symbols : [...DEFAULT_WATCHLIST];
}

async function loadSettings(supabase) {
  const { data } = await supabase
    .from('kv_store')
    .select('value')
    .eq('key', KV.SETTINGS)
    .maybeSingle();
  return data?.value || {};
}

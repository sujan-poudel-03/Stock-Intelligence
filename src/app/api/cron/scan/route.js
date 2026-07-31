import { NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';
import { scanMarket, runDiscovery } from '@/lib/scan';
import { normalizeExchange } from '@/lib/exchanges';
import { exchangeColumnReady } from '@/lib/schemaFlags';
import { triggerRoute } from '@/lib/background';
import { logEvent } from '@/lib/events';
import { withGuard } from '@/lib/respond';
import {
  KV,
  SCAN_GUARD_MS,
  checkCronAuth,
} from '@/lib/constants';
import { remaining } from '@/lib/budget';

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

  // Scan mode. 'light' (intraday) keeps cost low for high-frequency market-hours
  // runs: it scans only the watchlist, skips discovery, and reuses the most recent
  // scan's market read instead of spending fresh market + discovery LLM calls.
  // 'full' (default, ~once/day) does the complete market + discovery + scan.
  const mode = request.nextUrl.searchParams.get('mode') === 'light' ? 'light' : 'full';

  // Which market this run targets. Defaults to NEPSE (the byte-for-byte legacy
  // path); ?exchange=NYSE routes the whole chain — market read, discovery seed,
  // price sources, learning scope — at the selected exchange. Data stays GLOBAL
  // PER exchange (one scan serves every user of that market).
  const exchange = normalizeExchange(request.nextUrl.searchParams.get('exchange'));

  // Idempotency guard: skip if a scan for THIS exchange started < 30 min ago and is
  // still active. Scoped per-exchange (when the column exists) so a NEPSE scan in
  // flight never blocks a NYSE trigger and vice versa; falls back to a global guard
  // on an unmigrated DB (single-exchange, so equivalent).
  const hasExchangeCol = await exchangeColumnReady();
  const cutoff = new Date(Date.now() - SCAN_GUARD_MS).toISOString();
  let guardQuery = supabase
    .from('scans')
    .select('id, status, started_at')
    .gte('started_at', cutoff)
    .in('status', ['pending', 'running']);
  if (hasExchangeCol) guardQuery = guardQuery.eq('exchange', exchange);
  const { data: recent } = await guardQuery.order('started_at', { ascending: false }).limit(1);

  if (recent && recent.length > 0) {
    return NextResponse.json({ skipped: true, reason: 'scan in progress', scan_id: recent[0].id });
  }

  // 1. Create the scan row. The `exchange` column is only written when the migration
  // that adds it is applied — otherwise NEPSE stays byte-for-byte on the old schema.
  const startedAt = new Date().toISOString();
  const scanInsert = {
    status: 'pending',
    phase: 'market',
    total: 0,
    completed: 0,
    failed: 0,
    started_at: startedAt,
  };
  if (hasExchangeCol) scanInsert.exchange = exchange;
  const { data: scanRows, error: scanErr } = await supabase
    .from('scans')
    .insert(scanInsert)
    .select()
    .single();

  if (scanErr) return NextResponse.json({ error: scanErr.message }, { status: 500 });
  const scanId = scanRows.id;

  // 2. Resolve market data. Light mode reuses the most recent scan's market read
  // (saves one LLM call); full mode fetches it fresh.
  let market = {};
  if (mode === 'light') {
    market = (await loadRecentMarket(supabase, scanId)) || {};
  } else {
    try {
      market = await scanMarket(exchange);
    } catch (err) {
      await supabase
        .from('scans')
        .update({ status: 'error', error: `market: ${err?.message || err}`, completed_at: new Date().toISOString() })
        .eq('id', scanId);
      return NextResponse.json({ error: `market scan failed: ${err?.message || err}` }, { status: 500 });
    }
  }

  // 3. Resolve watchlist + (full mode only) run discovery. Light mode scans the
  // watchlist only — no discovery LLM call.
  const watchlist = await loadWatchlist(supabase);
  const settings = await loadSettings(supabase);
  let discovered = [];
  // Full mode runs discovery unless the V1 Settings tab turned it off.
  if (mode === 'full' && settings.discovery_on !== false) {
    try {
      discovered = await runDiscovery(market, settings, exchange);
    } catch (err) {
      console.error('discovery failed:', err?.message || err);
    }
  }

  const allSymbols = [...new Set([...watchlist, ...discovered].map((s) => s.toUpperCase()))];

  // Fit the scan inside the remaining daily LLM budget. Reserve a few calls for
  // the brief + outcomes steps; each stock costs ~2 calls. Drop the overflow up
  // front (logged, not silent) instead of queuing work that would only be
  // skipped — the worker still budget-checks each job as a backstop.
  const BUDGET_RESERVE = 2; // brief + outcomes
  const CALLS_PER_STOCK = 1; // one grounded fetch+signal call per stock
  const budgetLeft = await remaining();
  const affordable = Math.max(0, Math.floor((budgetLeft - BUDGET_RESERVE) / CALLS_PER_STOCK));
  const symbols = allSymbols.slice(0, affordable);
  const droppedForBudget = allSymbols.slice(affordable);
  if (droppedForBudget.length) {
    console.warn(
      `[scan] budget cap: queuing ${symbols.length}/${allSymbols.length} symbols ` +
        `(${budgetLeft} calls left). Dropped: ${droppedForBudget.join(', ')}`
    );
  }

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

  await logEvent(supabase, {
    scanId,
    type: 'scan_started',
    message: `${mode === 'light' ? 'Light scan' : 'Scan'} started — ${symbols.length} stock${symbols.length === 1 ? '' : 's'} (${market.sentiment || 'NEUTRAL'})`,
    data: { mode, total: symbols.length, sentiment: market.sentiment, symbols },
  });

  const auth = process.env.CRON_SECRET ? { authorization: `Bearer ${process.env.CRON_SECRET}` } : {};
  const origin = request.nextUrl.origin;

  // 5. Kick off processing. If the budget left no symbols to queue, skip the
  // worker entirely and go straight to the brief so the scan still completes.
  if (jobs.length) {
    triggerRoute('/api/scan/worker', { headers: auth, origin });
  } else {
    triggerRoute('/api/scan/brief', { headers: auth, body: { scan_id: scanId }, origin });
  }

  // 6. Return immediately (well within 60s).
  return NextResponse.json({
    started: true,
    mode,
    exchange,
    scan_id: scanId,
    total: symbols.length,
    discovered,
    watchlist,
    sentiment: market.sentiment,
  });
}

// Reuse the market read from the most recent completed scan (light mode), so an
// intraday scan doesn't spend a fresh market LLM call. Returns null if none.
async function loadRecentMarket(supabase, excludeScanId) {
  const { data } = await supabase
    .from('scans')
    .select('id, market')
    .not('market', 'is', null)
    .neq('id', excludeScanId)
    .order('started_at', { ascending: false })
    .limit(1);
  return data?.[0]?.market || null;
}

async function loadWatchlist(supabase) {
  const { data } = await supabase
    .from('kv_store')
    .select('value')
    .eq('key', KV.WATCHLIST)
    .maybeSingle();

  const value = data?.value;
  const list = Array.isArray(value) ? value : Array.isArray(value?.symbols) ? value.symbols : [];
  // Discovery-driven: no hardcoded fallback. The watchlist is an OUTPUT of the
  // promotion engine (symbols that keep recurring in discovery), so early on it
  // is empty and the scan runs on discovered movers alone.
  return list.map((s) => (typeof s === 'string' ? s : s?.symbol)).filter(Boolean);
}

async function loadSettings(supabase) {
  const { data } = await supabase
    .from('kv_store')
    .select('value')
    .eq('key', KV.SETTINGS)
    .maybeSingle();
  return data?.value || {};
}

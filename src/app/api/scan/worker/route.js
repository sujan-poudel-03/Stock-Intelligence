import { NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';
import { scanOneStock, deterministicSignal } from '@/lib/scan';
import { getVerifiedPrice } from '@/lib/marketProviders';
import { getWeightContext } from '@/lib/calibration';
import { runBackground, triggerRoute } from '@/lib/background';
import { logEvent } from '@/lib/events';
import { humanizeError } from '@/lib/humanizeError';
import { withGuard } from '@/lib/respond';
import { STALE_JOB_MS, MAX_ATTEMPTS, checkCronAuth } from '@/lib/constants';
import { remaining } from '@/lib/budget';

// A full stock scan costs 1 LLM call (a single grounded fetch + signal call).
const CALLS_PER_STOCK = 1;

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// POST /api/scan/worker            -> claim one pending job, process in background
// POST /api/scan/worker?symbol=X&force=true -> reprocess a single symbol
export const POST = withGuard(async (request) => {
  if (!checkCronAuth(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const supabase = getSupabase();
  const symbol = request.nextUrl.searchParams.get('symbol');
  const force = request.nextUrl.searchParams.get('force') === 'true';

  // Reclaim stale running jobs (worker died mid-flight).
  await reclaimStale(supabase);

  const job = await claimJob(supabase, { symbol, force });
  if (!job) {
    return NextResponse.json({ idle: true });
  }

  // Respond immediately; process in the background (await locally). Carry the
  // request origin so the self-chain targets the dev server's actual port.
  const origin = request.nextUrl.origin;
  await runBackground(() => processJob(supabase, job, origin));

  return NextResponse.json({ claimed: job.symbol, job_id: job.id });
});

// Reset jobs stuck in 'running' for longer than STALE_JOB_MS back to 'pending'.
async function reclaimStale(supabase) {
  const cutoff = new Date(Date.now() - STALE_JOB_MS).toISOString();
  await supabase
    .from('scan_jobs')
    .update({ status: 'pending' })
    .eq('status', 'running')
    .lt('started_at', cutoff);
}

// Atomically claim one job using optimistic concurrency: pick a candidate id,
// then conditionally flip status pending->running. Retry on lost races.
async function claimJob(supabase, { symbol, force }) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let query = supabase.from('scan_jobs').select('*');

    if (symbol) {
      query = query.eq('symbol', symbol.toUpperCase());
      if (!force) query = query.eq('status', 'pending');
      query = query.order('created_at', { ascending: false });
    } else {
      query = query.eq('status', 'pending').order('created_at', { ascending: true });
    }

    const { data: candidates } = await query.limit(1);
    const candidate = candidates?.[0];
    if (!candidate) return null;

    // Conditional claim. When forcing a specific symbol, claim regardless of state.
    let upd = supabase
      .from('scan_jobs')
      .update({
        status: 'running',
        started_at: new Date().toISOString(),
        attempt: (candidate.attempt || 0) + 1,
      })
      .eq('id', candidate.id);

    if (!force) upd = upd.eq('status', 'pending');

    const { data: claimed } = await upd.select().single();
    if (claimed) return claimed;
    // Lost the race; loop and try another candidate.
  }
  return null;
}

async function processJob(supabase, job, origin) {
  const scanId = job.scan_id;

  // Budget-saver mode: when the daily LLM budget is spent, don't vanish — emit a
  // clearly-marked deterministic signal from the symbol's last known price. If we
  // have no prior price to work from, skip the stock cleanly (scan ends 'partial').
  if ((await remaining()) < CALLS_PER_STOCK) {
    // Prefer a live VERIFIED price (no LLM cost); fall back to the last known price
    // from a prior signal only if no source can verify one right now.
    const verified = await getVerifiedPrice(job.symbol).catch(() => null);
    const price = verified?.verified ? verified.price : await lastKnownPrice(supabase, job.symbol);
    const fallback = price ? deterministicSignal({ symbol: job.symbol, price }) : null;

    if (fallback) {
      await insertSignal(supabase, scanId, fallback);
      await supabase
        .from('scan_jobs')
        .update({ status: 'done', result: fallback, error: 'budget-saver (deterministic)', completed_at: new Date().toISOString() })
        .eq('id', job.id);
      await bumpCompleted(supabase, scanId, 'completed');
      await logEvent(supabase, {
        scanId,
        type: 'budget_saver',
        symbol: job.symbol,
        message: `${job.symbol}: deterministic signal — budget-saver mode active`,
        data: { signal: fallback.signal, price: fallback.price },
      });
    } else {
      await supabase
        .from('scan_jobs')
        .update({ status: 'skipped', error: 'daily LLM budget reached (no prior price)', completed_at: new Date().toISOString() })
        .eq('id', job.id);
      await logEvent(supabase, {
        scanId,
        type: 'job_skipped',
        symbol: job.symbol,
        message: `${job.symbol} skipped — budget reached, no prior price`,
      });
    }
    await chainNext(supabase, scanId, origin);
    return;
  }

  try {
    // Pull market context for this scan.
    const { data: scan } = await supabase
      .from('scans')
      .select('market')
      .eq('id', scanId)
      .maybeSingle();

    await supabase.from('scans').update({ current_symbol: job.symbol }).eq('id', scanId);

    const weightCtx = await getWeightContext(job.symbol, null);
    const signal = await scanOneStock(job.symbol, scan?.market || {}, weightCtx);

    await insertSignal(supabase, scanId, signal);

    // Mark job done.
    await supabase
      .from('scan_jobs')
      .update({
        status: 'done',
        result: signal,
        error: null,
        completed_at: new Date().toISOString(),
      })
      .eq('id', job.id);

    await bumpCompleted(supabase, scanId, 'completed');

    await logEvent(supabase, {
      scanId,
      type: 'signal',
      symbol: signal.symbol,
      message: `${signal.symbol}: ${signal.signal} (${signal.confidence})`,
      data: {
        signal: signal.signal,
        confidence: signal.confidence,
        price: signal.price,
        target: signal.target,
        sl: signal.sl,
        sector: signal.sector,
      },
    });
  } catch (err) {
    const message = err?.message || String(err);
    const attempt = job.attempt || 1;

    // FIX 4 — 'no data from source' is not worth retrying (and retries burn
    // budget); fail it immediately so it lands on the failed surface.
    const noData = /no data from source/i.test(message);

    if (noData || attempt >= MAX_ATTEMPTS) {
      await supabase
        .from('scan_jobs')
        .update({ status: 'permanently_failed', error: message, completed_at: new Date().toISOString() })
        .eq('id', job.id);
      await bumpCompleted(supabase, scanId, 'failed');
      const h = humanizeError(message);
      await logEvent(supabase, {
        scanId,
        type: 'job_failed',
        symbol: job.symbol,
        message: `${job.symbol} failed: ${h.message}`,
        data: { kind: h.kind, attempt },
      });
    } else {
      // Return to the queue for another attempt.
      await supabase
        .from('scan_jobs')
        .update({ status: 'pending', error: message })
        .eq('id', job.id);
    }
  }

  // Chain: more work -> next worker; otherwise -> brief.
  await chainNext(supabase, scanId, origin);
}

// Persist one signal row. Shared by the normal path and budget-saver fallback.
async function insertSignal(supabase, scanId, signal) {
  await supabase.from('signals').insert({
    scan_id: scanId,
    symbol: signal.symbol,
    signal: signal.signal,
    confidence: signal.confidence,
    price: signal.price,
    entry: signal.entry,
    sl: signal.sl,
    target: signal.target,
    hold: signal.hold,
    why: signal.why,
    risk: signal.risk,
    action: signal.action,
    source: signal.source,
    sector: signal.sector,
    live_data: signal.live_data,
    outcome: 'PENDING',
    created_at: new Date().toISOString(),
  });
}

// Most recent non-null price for a symbol, for the budget-saver deterministic
// fallback. Returns a number or null.
async function lastKnownPrice(supabase, symbol) {
  const { data } = await supabase
    .from('signals')
    .select('price')
    .eq('symbol', symbol)
    .not('price', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1);
  const p = Number(data?.[0]?.price);
  return Number.isFinite(p) && p > 0 ? p : null;
}

// Increment scans.completed or scans.failed by reading + writing (no RPC needed).
async function bumpCompleted(supabase, scanId, field) {
  const { data } = await supabase.from('scans').select('completed, failed').eq('id', scanId).maybeSingle();
  const completed = (data?.completed || 0) + (field === 'completed' ? 1 : 0);
  const failed = (data?.failed || 0) + (field === 'failed' ? 1 : 0);
  await supabase.from('scans').update({ completed, failed }).eq('id', scanId);
}

async function chainNext(supabase, scanId, origin) {
  const auth = process.env.CRON_SECRET ? { authorization: `Bearer ${process.env.CRON_SECRET}` } : {};

  const { count: pendingCount } = await supabase
    .from('scan_jobs')
    .select('id', { count: 'exact', head: true })
    .eq('scan_id', scanId)
    .in('status', ['pending', 'running']);

  if ((pendingCount || 0) > 0) {
    triggerRoute('/api/scan/worker', { headers: auth, origin });
  } else {
    triggerRoute('/api/scan/brief', { headers: auth, body: { scan_id: scanId }, origin });
  }
}

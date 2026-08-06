import { NextResponse } from 'next/server';
import { getServiceSupabase } from '@/lib/supabase';
import { scanOneStock, deterministicSignal } from '@/lib/scan';
import { getVerifiedPrice } from '@/lib/marketProviders';
import { getWeightContext } from '@/lib/calibration';
import { normalizeExchange, DEFAULT_EXCHANGE } from '@/lib/exchanges';
import { exchangeColumnReady, outcomeRealismColumnsReady } from '@/lib/schemaFlags';
import { effectiveMaxHoldDays } from '@/lib/outcomeResolution';
import { runBackground, triggerRoute } from '@/lib/background';
import { logEvent } from '@/lib/events';
import { humanizeError } from '@/lib/humanizeError';
import { withGuard } from '@/lib/respond';
import { STALE_JOB_MS, MAX_ATTEMPTS, SCAN_JOB_TIMEOUT_MS, checkCronAuth } from '@/lib/constants';
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

  // Trusted cron write path: service-role client so job claims, signal inserts,
  // and counter bumps survive RLS being enabled later (Phase 2). No public reads
  // live in this file; behaviour is unchanged while RLS is still OFF.
  const supabase = getServiceSupabase();
  const symbol = request.nextUrl.searchParams.get('symbol');
  const force = request.nextUrl.searchParams.get('force') === 'true';
  const origin = request.nextUrl.origin;

  // Reclaim stale running jobs (worker died mid-flight).
  await reclaimStale(supabase);

  // LOCAL-DRAIN MODE (off Vercel, general queue drain only). On Vercel each hop is
  // one job then a detached self-chain, kept alive by waitUntil. Off Vercel there is
  // no waitUntil, so the worker->worker hand-off is dropped and the queue never
  // advances past 0/N (see background.js). Instead, drain the WHOLE queue inside this
  // one invocation: claim + process each job sequentially, then fire the brief once at
  // the end. The single-symbol force retry (?symbol=X&force=true) is deliberately
  // excluded — it keeps the exact one-job + self-chain path below.
  if (!process.env.VERCEL && !symbol) {
    const scanIds = new Set();
    // Sequential drain. processJob is called with chain:false so it does NOT self-fire
    // another worker (this loop owns continuation); the per-job SCAN_JOB_TIMEOUT_MS,
    // optimistic claim, retry ceiling and pending/permanently_failed branches all still
    // apply per iteration. A failed job returned to 'pending' is re-claimed here on the
    // next pass until it resolves or hits MAX_ATTEMPTS, so the loop always terminates.
    for (;;) {
      const job = await claimJob(supabase, { symbol: null, force: false });
      if (!job) break;
      scanIds.add(job.scan_id);
      await processJob(supabase, job, origin, { chain: false });
    }

    // Terminal hand-off: fire each drained scan's brief exactly once. Awaited so the
    // off-Vercel triggerRoute (which now awaits the fetch) actually lands the call
    // before we respond. The queue is empty here, so this replaces chainNext's
    // "any work left? -> worker" branch — no worker self-fire, no duplicate brief.
    const auth = process.env.CRON_SECRET ? { authorization: `Bearer ${process.env.CRON_SECRET}` } : {};
    for (const scanId of scanIds) {
      await triggerRoute('/api/scan/brief', { headers: auth, body: { scan_id: scanId }, origin });
    }

    return NextResponse.json({ drained: scanIds.size, scans: [...scanIds] });
  }

  const job = await claimJob(supabase, { symbol, force });
  if (!job) {
    return NextResponse.json({ idle: true });
  }

  // Respond immediately; process in the background (await locally). Carry the
  // request origin so the self-chain targets the dev server's actual port.
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

// `chain` controls the terminal continuation: on Vercel / single-symbol paths it is
// true (self-fire the next worker or the brief via chainNext). In local-drain mode
// the POST loop passes chain:false so this job does NOT self-fire another worker —
// the loop handles continuation and fires the brief once at the end.
async function processJob(supabase, job, origin, { chain = true } = {}) {
  const scanId = job.scan_id;

  // Read this scan's market context + exchange once — both the budget-saver and the
  // normal path route on the scan's exchange (defaults to NEPSE for legacy rows).
  // The exchange column is only read when the migration adding it is applied.
  const hasExchangeCol = await exchangeColumnReady();
  const { data: scan } = await supabase
    .from('scans')
    .select(hasExchangeCol ? 'market, exchange' : 'market')
    .eq('id', scanId)
    .maybeSingle();
  const exchange = normalizeExchange(scan?.exchange || DEFAULT_EXCHANGE);

  // Budget-saver mode: when the daily LLM budget is spent, don't vanish — emit a
  // clearly-marked deterministic signal from the symbol's last known price. If we
  // have no prior price to work from, skip the stock cleanly (scan ends 'partial').
  if ((await remaining()) < CALLS_PER_STOCK) {
    // Prefer a live VERIFIED price (no LLM cost); fall back to the last known price
    // from a prior signal only if no source can verify one right now. Verify against
    // the scan's exchange sources.
    const verified = await getVerifiedPrice(job.symbol, { exchange }).catch(() => null);
    const price = verified?.verified ? verified.price : await lastKnownPrice(supabase, job.symbol);
    const fallback = price ? deterministicSignal({ symbol: job.symbol, price }, exchange) : null;

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
    if (chain) await chainNext(supabase, scanId, origin);
    return;
  }

  try {
    await supabase.from('scans').update({ current_symbol: job.symbol }).eq('id', scanId);

    const weightCtx = await getWeightContext(job.symbol, null, exchange);
    // Bound the scan work: a hung LLM generation / grounded fetch would otherwise
    // freeze the worker forever (only llmPing has its own AbortController). On timeout
    // this throws a plain (retryable) error — it lands on the retry path below, not
    // the 'no data from source' fail-fast, and NOT the fail-closed price guard (that
    // still lives inside scanOneStock). The success path is untouched.
    const signal = await withTimeout(
      scanOneStock(job.symbol, scan?.market || {}, weightCtx, null, { exchange }),
      SCAN_JOB_TIMEOUT_MS,
      job.symbol
    );

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

  // Chain: more work -> next worker; otherwise -> brief. Skipped in local-drain mode
  // (the POST loop owns continuation and fires the brief once at the end).
  if (chain) await chainNext(supabase, scanId, origin);
}

// Race a promise against a timeout so a hung external call can't block the worker
// indefinitely. Rejects with a plain Error (retryable) on timeout; the underlying
// promise is left to settle on its own (the function's maxDuration reaps it). The
// timer is always cleared so a fast-resolving job doesn't hold the event loop.
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`scan timed out after ${Math.round(ms / 1000)}s: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Persist one signal row. Shared by the normal path and budget-saver fallback.
// `exchange` is written only when the column exists (best-effort migration gate) so
// the NEPSE insert stays byte-for-byte on an unmigrated DB.
async function insertSignal(supabase, scanId, signal) {
  const row = {
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
  };
  if (await exchangeColumnReady()) row.exchange = signal.exchange || 'NEPSE';
  // TIER-1 #3: stamp the time-stop horizon (clamped, hold-derived) at insert so the
  // resolver's EXPIRE path has a fixed reference; init the accumulated extremes null.
  // Gated on the outcome-realism columns — on an unmigrated DB the insert is unchanged.
  if (await outcomeRealismColumnsReady()) {
    row.max_hold_days = effectiveMaxHoldDays(signal.hold);
    row.peak_high = null;
    row.trough_low = null;
  }
  await supabase.from('signals').insert(row);
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

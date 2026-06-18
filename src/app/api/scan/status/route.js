import { NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';
import { withGuard } from '@/lib/respond';
import { STALL_MS } from '@/lib/constants';
import { nextScanRunIso } from '@/lib/schedule';
import { humanizeError } from '@/lib/humanizeError';

export const dynamic = 'force-dynamic';

// GET /api/scan/status -> current scan state for the UI poller.
export const GET = withGuard(async () => {
  const supabase = getSupabase();

  // Most recent scan.
  const { data: scans } = await supabase
    .from('scans')
    .select('*')
    .order('started_at', { ascending: false })
    .limit(1);

  const scan = scans?.[0];
  if (!scan) {
    return NextResponse.json({
      running: false,
      phase: null,
      current_symbol: null,
      completed: 0,
      total: 0,
      pct: 0,
      signals_so_far: 0,
      eta_minutes: null,
      stalled: false,
      failed_jobs: [],
      skipped_jobs: [],
      last_updated: null,
      last_scan_at: null,
      last_scan_status: null,
      next_scheduled: nextScanRunIso(),
    });
  }

  const running = scan.status === 'pending' || scan.status === 'running';

  // Job breakdown for this scan.
  const { data: jobs } = await supabase
    .from('scan_jobs')
    .select('symbol, status, error, attempt, completed_at, started_at')
    .eq('scan_id', scan.id);

  const all = jobs || [];
  const done = all.filter((j) => j.status === 'done').length;
  const failed = all.filter((j) => j.status === 'permanently_failed');
  const skipped = all.filter((j) => j.status === 'skipped');
  const completed = done + failed.length + skipped.length;
  const total = scan.total || all.length;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  // Signals produced so far this scan.
  const { count: signalCount } = await supabase
    .from('signals')
    .select('id', { count: 'exact', head: true })
    .eq('scan_id', scan.id);

  // Estimate remaining time from average completion cadence (~25s/stock fallback).
  const remaining = Math.max(0, total - completed);
  const lastUpdated = latestTimestamp(scan, all);
  const stalled =
    running && lastUpdated ? Date.now() - new Date(lastUpdated).getTime() > STALL_MS : false;
  const etaMinutes = running ? Math.ceil((remaining * 25) / 60) : 0;

  return NextResponse.json({
    running,
    status: scan.status,
    phase: scan.phase,
    current_symbol: scan.current_symbol,
    completed,
    total,
    pct,
    signals_so_far: signalCount || 0,
    eta_minutes: etaMinutes,
    stalled,
    failed_jobs: failed.map((j) => {
      const h = humanizeError(j.error);
      return { symbol: j.symbol, attempt: j.attempt, kind: h.kind, message: h.message };
    }),
    skipped_jobs: skipped.map((j) => {
      const h = humanizeError(j.error);
      return { symbol: j.symbol, kind: h.kind, message: h.message };
    }),
    last_updated: lastUpdated,
    last_scan_at: scan.completed_at || scan.started_at,
    last_scan_status: scan.status,
    next_scheduled: nextScanRunIso(),
  });
});

function latestTimestamp(scan, jobs) {
  const stamps = [scan.started_at, scan.completed_at];
  for (const j of jobs) {
    stamps.push(j.completed_at, j.started_at);
  }
  const valid = stamps.filter(Boolean).map((s) => new Date(s).getTime());
  if (!valid.length) return null;
  return new Date(Math.max(...valid)).toISOString();
}

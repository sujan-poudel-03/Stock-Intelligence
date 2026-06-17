import { NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';
import { withGuard } from '@/lib/respond';

export const dynamic = 'force-dynamic';

// Display order: actionable signals first, then watch-side, then avoid.
const SIGNAL_RANK = { BUY: 0, SELL: 1, HOLD: 2, AVOID: 3 };
const CONF_RANK = { HIGH: 0, MEDIUM: 1, LOW: 2 };

// GET /api/signals -> the latest scan's per-symbol trade signals for the UI.
export const GET = withGuard(async () => {
  const supabase = getSupabase();

  // Most recent scan (running or finished).
  const { data: scans } = await supabase
    .from('scans')
    .select('id, status, started_at, completed_at')
    .order('started_at', { ascending: false })
    .limit(1);

  const scan = scans?.[0];
  if (!scan) {
    return NextResponse.json({ scan_id: null, signals: [], actionable: [] });
  }

  const { data: rows } = await supabase
    .from('signals')
    .select(
      'id, symbol, signal, confidence, price, entry, sl, target, hold, why, risk, action, sector, outcome, created_at'
    )
    .eq('scan_id', scan.id);

  const signals = (rows || []).slice().sort((a, b) => {
    const s = (SIGNAL_RANK[a.signal] ?? 9) - (SIGNAL_RANK[b.signal] ?? 9);
    if (s !== 0) return s;
    return (CONF_RANK[a.confidence] ?? 9) - (CONF_RANK[b.confidence] ?? 9);
  });

  const actionable = signals.filter((s) => s.signal === 'BUY' || s.signal === 'SELL');

  return NextResponse.json({
    scan_id: scan.id,
    scan_status: scan.status,
    scanned_at: scan.completed_at || scan.started_at,
    signals,
    actionable,
  });
});

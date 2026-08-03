import { NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';
import { withGuard, edgeCache } from '@/lib/respond';
import { normalizeExchange } from '@/lib/exchanges';
import { exchangeColumnReady } from '@/lib/schemaFlags';

export const dynamic = 'force-dynamic';

// Display order: actionable signals first, then watch-side, then avoid.
const SIGNAL_RANK = { BUY: 0, SELL: 1, HOLD: 2, WATCH: 3, NEUTRAL: 4, AVOID: 5 };
const CONF_RANK = { HIGH: 0, MEDIUM: 1, LOW: 2 };

// GET /api/signals?exchange=NEPSE -> the latest scan's per-symbol trade signals for
// the UI, filtered to one exchange (a VIEW over shared per-exchange data — switching
// markets never triggers a scan). Defaults to NEPSE, matching the legacy behaviour
// (all pre-migration scans/signals read as NEPSE via the column default).
export const GET = withGuard(async (request) => {
  const supabase = getSupabase();
  const exchange = normalizeExchange(request.nextUrl.searchParams.get('exchange'));

  // Most recent scan for THIS exchange (running or finished). The exchange filter is
  // applied only when the column exists; on an unmigrated DB this is the legacy
  // "latest scan overall" query (byte-for-byte NEPSE behaviour).
  const hasExchangeCol = await exchangeColumnReady();
  let scanQuery = supabase
    .from('scans')
    .select('id, status, started_at, completed_at')
    .order('started_at', { ascending: false })
    .limit(1);
  if (hasExchangeCol) scanQuery = scanQuery.eq('exchange', exchange);
  const { data: scans } = await scanQuery;

  const scan = scans?.[0];
  if (!scan) {
    return NextResponse.json(
      { scan_id: null, exchange, signals: [], actionable: [] },
      { headers: edgeCache(15) }
    );
  }

  const { data: rows } = await supabase
    .from('signals')
    .select(
      'id, symbol, signal, confidence, price, entry, sl, target, hold, why, risk, action, source, sector, live_data, outcome, created_at'
    )
    .eq('scan_id', scan.id);

  const signals = (rows || [])
    .map((r) => ({
      ...r,
      // V1 UI reads `s.live` (live trading data) and `s.at` (timestamp); the V2
      // schema stores these as `live_data` and `created_at`. Alias them so the
      // ported cards render without per-field rewrites.
      live: r.live_data || null,
      at: r.created_at,
    }))
    .sort((a, b) => {
      const s = (SIGNAL_RANK[a.signal] ?? 9) - (SIGNAL_RANK[b.signal] ?? 9);
      if (s !== 0) return s;
      return (CONF_RANK[a.confidence] ?? 9) - (CONF_RANK[b.confidence] ?? 9);
    });

  const actionable = signals.filter((s) => s.signal === 'BUY' || s.signal === 'SELL');

  // Shared across all users of this exchange → edge-cache briefly. A running scan
  // is cached only 5s (new signals should surface quickly); a finished scan 20s.
  const ttl = scan.status === 'running' || scan.status === 'pending' ? 5 : 20;
  return NextResponse.json(
    {
      scan_id: scan.id,
      exchange,
      scan_status: scan.status,
      scanned_at: scan.completed_at || scan.started_at,
      signals,
      actionable,
    },
    { headers: edgeCache(ttl) }
  );
});

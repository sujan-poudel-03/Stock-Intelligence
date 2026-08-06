import { NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';
import { withGuard, edgeCache } from '@/lib/respond';
import { normalizeExchange } from '@/lib/exchanges';
import { exchangeColumnReady } from '@/lib/schemaFlags';
import { pickSignalsScan } from '@/lib/signalsFallback';

export const dynamic = 'force-dynamic';

// Display order: actionable signals first, then watch-side, then avoid.
const SIGNAL_RANK = { BUY: 0, SELL: 1, HOLD: 2, WATCH: 3, NEUTRAL: 4, AVOID: 5 };
const CONF_RANK = { HIGH: 0, MEDIUM: 1, LOW: 2 };

// Columns pulled for each signal card. Reused by the latest-scan read and the
// earlier-scan fallback below.
const SIGNAL_FIELDS =
  'id, symbol, signal, confidence, price, entry, sl, target, hold, why, risk, action, source, sector, live_data, outcome, created_at';

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

  const { data: latestRows } = await supabase
    .from('signals')
    .select(SIGNAL_FIELDS)
    .eq('scan_id', scan.id);

  // Robustness: if the latest scan produced NO signal rows (stalled / partial / still
  // running), fall back to the most recent scan that HAS signals so the tab isn't
  // blank. Best-effort — any miss keeps the (empty) latest-scan result. When the
  // latest scan already has signals, no extra query runs and behaviour is unchanged.
  let fallbackScan = null;
  let fallbackRows = null;
  if (!(latestRows && latestRows.length)) {
    // The most recent signal row's scan_id identifies the most recent scan WITH
    // signals (exchange-filtered when the column exists).
    let latestSigQuery = supabase
      .from('signals')
      .select('scan_id')
      .order('created_at', { ascending: false })
      .limit(1);
    if (hasExchangeCol) latestSigQuery = latestSigQuery.eq('exchange', exchange);
    const { data: latestSig } = await latestSigQuery;
    const fbScanId = latestSig?.[0]?.scan_id;
    if (fbScanId && fbScanId !== scan.id) {
      const { data: fbRows } = await supabase
        .from('signals')
        .select(SIGNAL_FIELDS)
        .eq('scan_id', fbScanId);
      if (fbRows && fbRows.length) {
        fallbackRows = fbRows;
        const { data: fbScan } = await supabase
          .from('scans')
          .select('id, status, started_at, completed_at')
          .eq('id', fbScanId)
          .maybeSingle();
        fallbackScan = fbScan || { id: fbScanId, started_at: null, completed_at: null };
      }
    }
  }

  const picked = pickSignalsScan({ latestScan: scan, latestRows, fallbackScan, fallbackRows });

  const signals = (picked.rows || [])
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
  // scan_id / scan_status / scanned_at describe the LATEST scan (the current run's
  // state, unchanged). signals_scan_id / signals_as_of describe where the displayed
  // signals actually came from — equal to the latest scan normally, or an earlier
  // scan when the latest one was empty and we fell back. signals_from_earlier is a
  // convenience flag for the client.
  return NextResponse.json(
    {
      scan_id: scan.id,
      exchange,
      scan_status: scan.status,
      scanned_at: scan.completed_at || scan.started_at,
      signals_scan_id: picked.scan?.id ?? scan.id,
      signals_as_of: picked.scan?.completed_at || picked.scan?.started_at || null,
      signals_from_earlier: picked.fromEarlier,
      signals,
      actionable,
    },
    { headers: edgeCache(ttl) }
  );
});

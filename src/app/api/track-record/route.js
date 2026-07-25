import { NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';
import { withGuard } from '@/lib/respond';
import { wilsonLowerBound, riskAdjustedReturn } from '@/lib/stats';

export const dynamic = 'force-dynamic';

// GET /api/track-record -> the agent's REAL, transparent WIN/LOSS history, computed
// from the signals table (ground truth), including losses. This is the honesty +
// marketing surface ("shows its work"). Win rates carry the Wilson lower bound so a
// thin sample can't read as a strong record.
export const GET = withGuard(async () => {
  const supabase = getSupabase();

  const { data: resolved } = await supabase
    .from('signals')
    .select('symbol, signal, sector, price, exit_price, outcome, return_pct, created_at, outcome_at')
    .in('outcome', ['WIN', 'LOSS'])
    .order('outcome_at', { ascending: false })
    .limit(500);

  const { count: pending } = await supabase
    .from('signals')
    .select('id', { count: 'exact', head: true })
    .eq('outcome', 'PENDING')
    .in('signal', ['BUY', 'SELL']);

  const rows = resolved || [];

  const summarize = (list) => {
    const wins = list.filter((r) => r.outcome === 'WIN').length;
    const losses = list.filter((r) => r.outcome === 'LOSS').length;
    const n = wins + losses;
    const rets = list.map((r) => Number(r.return_pct)).filter((x) => Number.isFinite(x));
    const avg = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
    return {
      trades: n,
      wins,
      losses,
      winRate: n ? round2(wins / n) : 0,
      confidence: round2(wilsonLowerBound(wins, n)), // small-sample-discounted
      avgReturn: round2(avg),
      riskAdjustedReturn: riskAdjustedReturn(rets),
    };
  };

  const bySectorMap = {};
  for (const r of rows) {
    const k = r.sector || 'Unknown';
    (bySectorMap[k] = bySectorMap[k] || []).push(r);
  }
  const bySector = Object.entries(bySectorMap)
    .map(([sector, list]) => ({ sector, ...summarize(list) }))
    .sort((a, b) => b.confidence - a.confidence || b.trades - a.trades)
    .slice(0, 8);

  return NextResponse.json({
    overall: summarize(rows),
    byDirection: {
      BUY: summarize(rows.filter((r) => r.signal === 'BUY')),
      SELL: summarize(rows.filter((r) => r.signal === 'SELL')),
    },
    bySector,
    pending: pending || 0,
    recent: rows.slice(0, 40).map((r) => ({
      symbol: r.symbol,
      signal: r.signal,
      sector: r.sector || null,
      entry: numOrNull(r.price),
      exit: numOrNull(r.exit_price),
      outcome: r.outcome,
      returnPct: r.return_pct != null ? round2(Number(r.return_pct)) : null,
      at: r.outcome_at,
    })),
  });
});

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}
function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

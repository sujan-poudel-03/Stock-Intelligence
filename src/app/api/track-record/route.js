import { NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';
import { withGuard, edgeCache } from '@/lib/respond';
import { wilsonLowerBound, riskAdjustedReturn } from '@/lib/stats';
import { outcomeRealismColumnsReady } from '@/lib/schemaFlags';

export const dynamic = 'force-dynamic';

// GET /api/track-record -> the agent's REAL, transparent WIN/LOSS history, computed
// from the signals table (ground truth), including losses. This is the honesty +
// marketing surface ("shows its work"). Win rates carry the Wilson lower bound so a
// thin sample can't read as a strong record.
//
// TIER-1 #3: the NET-of-charges return is the HEADLINE (gross shown alongside), and
// EXPIRE (time-stop) outcomes get their own displayed bucket. Win-rate stays on the
// WIN/LOSS target/stop touch only. The net_return_pct/exit_reason columns are read only
// when the migration is applied (schema-flag gate) — on an unmigrated DB this is
// byte-for-byte the old gross-only, WIN/LOSS-only surface.
export const GET = withGuard(async () => {
  const supabase = getSupabase();
  const realismReady = await outcomeRealismColumnsReady().catch(() => false);

  // EXPIRE rows only exist once the realism path is live; asking for them is harmless
  // on an unmigrated DB (the `outcome` filter simply matches none).
  const outcomes = realismReady ? ['WIN', 'LOSS', 'EXPIRE'] : ['WIN', 'LOSS'];
  const cols = realismReady
    ? 'symbol, signal, sector, price, exit_price, outcome, return_pct, net_return_pct, exit_reason, created_at, outcome_at'
    : 'symbol, signal, sector, price, exit_price, outcome, return_pct, created_at, outcome_at';

  const { data: resolved } = await supabase
    .from('signals')
    .select(cols)
    .in('outcome', outcomes)
    .order('outcome_at', { ascending: false })
    .limit(500);

  const { count: pending } = await supabase
    .from('signals')
    .select('id', { count: 'exact', head: true })
    .eq('outcome', 'PENDING')
    .in('signal', ['BUY', 'SELL']);

  const all = resolved || [];
  // Win-rate + averages are computed over the WIN/LOSS touch only (a time-stop EXPIRE is
  // neither a win nor a loss); EXPIRE gets its own bucket below.
  const rows = all.filter((r) => r.outcome === 'WIN' || r.outcome === 'LOSS');
  const expiredRows = all.filter((r) => r.outcome === 'EXPIRE');

  const summarize = (list) => {
    const wins = list.filter((r) => r.outcome === 'WIN').length;
    const losses = list.filter((r) => r.outcome === 'LOSS').length;
    const n = wins + losses;
    const rets = list.map((r) => Number(r.return_pct)).filter((x) => Number.isFinite(x));
    const avg = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
    // Net-of-charges average — the headline. Falls back to gross when the column is
    // absent/null (unmigrated DB or a pre-realism row), so the figure is never blank.
    const nets = list
      .map((r) => (Number.isFinite(Number(r.net_return_pct)) ? Number(r.net_return_pct) : Number(r.return_pct)))
      .filter((x) => Number.isFinite(x));
    const avgNet = nets.length ? nets.reduce((a, b) => a + b, 0) / nets.length : 0;
    return {
      trades: n,
      wins,
      losses,
      winRate: n ? round2(wins / n) : 0,
      confidence: round2(wilsonLowerBound(wins, n)), // small-sample-discounted
      avgReturn: round2(avg),
      avgNetReturn: round2(avgNet),
      riskAdjustedReturn: riskAdjustedReturn(rets),
    };
  };

  // EXPIRE bucket: count + average gross/net return (mark-to-market at the horizon).
  const expiredNets = expiredRows
    .map((r) => (Number.isFinite(Number(r.net_return_pct)) ? Number(r.net_return_pct) : Number(r.return_pct)))
    .filter((x) => Number.isFinite(x));
  const expiredGross = expiredRows.map((r) => Number(r.return_pct)).filter((x) => Number.isFinite(x));
  const expired = {
    count: expiredRows.length,
    avgReturn: expiredGross.length ? round2(expiredGross.reduce((a, b) => a + b, 0) / expiredGross.length) : 0,
    avgNetReturn: expiredNets.length ? round2(expiredNets.reduce((a, b) => a + b, 0) / expiredNets.length) : 0,
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

  // Global marketing surface, changes only as outcomes resolve (slow) → edge-cache
  // 60s across all visitors.
  return NextResponse.json(
    {
      overall: summarize(rows),
      byDirection: {
        BUY: summarize(rows.filter((r) => r.signal === 'BUY')),
        SELL: summarize(rows.filter((r) => r.signal === 'SELL')),
      },
      bySector,
      expired,
      pending: pending || 0,
      // Recent list includes EXPIRE so the WIN/LOSS/EXPIRE mix is visible.
      recent: all.slice(0, 40).map((r) => ({
        symbol: r.symbol,
        signal: r.signal,
        sector: r.sector || null,
        entry: numOrNull(r.price),
        exit: numOrNull(r.exit_price),
        outcome: r.outcome,
        exitReason: r.exit_reason || null,
        returnPct: r.return_pct != null ? round2(Number(r.return_pct)) : null,
        netReturnPct: r.net_return_pct != null ? round2(Number(r.net_return_pct)) : null,
        at: r.outcome_at,
      })),
    },
    { headers: edgeCache(60) }
  );
});

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}
function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

import { NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';
import { withGuard, edgeCache } from '@/lib/respond';
import { normalizeExchange } from '@/lib/exchanges';
import { loadPriceHistory } from '@/lib/priceHistory';

export const dynamic = 'force-dynamic';

// GET /api/price-history?symbol=NABIL&exchange=NEPSE -> { symbol, exchange, bars }
//
// The chart data source (redesign Phase A) — a VIEW over the global price_history
// table (public-read, service-write), same "shared data, read-only client" pattern
// as /api/signals. Returns [] bars on an unmigrated DB or an unknown symbol rather
// than erroring, so the chart component always has an honest empty state to render.
export const GET = withGuard(async (request) => {
  const symbol = (request.nextUrl.searchParams.get('symbol') || '').toUpperCase().trim();
  if (!symbol) return NextResponse.json({ error: 'missing symbol' }, { status: 400 });
  const exchange = normalizeExchange(request.nextUrl.searchParams.get('exchange'));

  const supabase = getSupabase();
  const bars = await loadPriceHistory(supabase, { symbol, exchange, limit: 180 });

  // Daily data — cache generously across all visitors (60s is plenty; a new bar
  // only ever appears once per scan cycle, at most a few times a day).
  return NextResponse.json({ symbol, exchange, bars }, { headers: edgeCache(60) });
});

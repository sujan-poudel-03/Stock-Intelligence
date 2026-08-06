import { NextResponse } from 'next/server';
import { withGuard, edgeCache } from '@/lib/respond';
import { getSupabase } from '@/lib/supabase';
import { systemWatchlistReady } from '@/lib/schemaFlags';
import { normalizeExchange } from '@/lib/exchanges';

export const dynamic = 'force-dynamic';

// GET /api/system-watchlist?exchange=NEPSE -> the GLOBAL curated universe (active rows)
// so signed-out / new users see the curated watchlist the agent scans for everyone.
// PUBLIC (no auth): the list is global, non-personalized market data (public-read RLS),
// so the response is identical for every caller and can edge-cache like /api/exchanges.
//
// Probe-gated: on an unmigrated DB the table does not exist, so this returns an empty
// list (NOT an error) — the Watch tab simply shows no curated section, byte-for-byte
// as today.
export const GET = withGuard(async (request) => {
  const exchange = normalizeExchange(request.nextUrl.searchParams.get('exchange'));

  if (!(await systemWatchlistReady())) {
    return NextResponse.json({ systemWatchlist: [] }, { headers: edgeCache(60, 300) });
  }

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('system_watchlist')
    .select('symbol, source')
    .eq('exchange', exchange)
    .eq('active', true)
    .order('symbol', { ascending: true });
  if (error) throw error;

  return NextResponse.json(
    { systemWatchlist: (data || []).map((r) => ({ symbol: r.symbol, source: r.source })) },
    { headers: edgeCache(60, 300) }
  );
});

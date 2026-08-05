import { NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';
import { callLLM, parseJson } from '@/lib/llm';
import { withGuard } from '@/lib/respond';
import { remaining } from '@/lib/budget';
import { getCache, setCache } from '@/lib/cache';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// How long the LLM-fetched enrichment (live data + analysis) is shared across users.
// This is the whole point of the cache: three users opening the same symbol within
// this window trigger ONE LLM/web fetch, not three. Short enough that an overlay
// stays reasonably current; the authoritative signal is always read fresh below.
const STOCK_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// GET /api/stock?symbol=NABIL -> { symbol, data, analysis, signal }
//
// Powers the stock detail overlay. V1 fetched live data + analysis from the LLM
// in the browser; V2 does it server-side and folds in the most recent stored
// signal so the overlay still shows something useful when the daily LLM budget
// is spent.
//
// SHARED-COMPUTE: the expensive LLM/web enrichment is cached per-symbol in kv_store
// so it is fetched once and served to every user (cost scales with distinct symbols,
// not user count). The stored SIGNAL is always read fresh from the DB and merged in,
// so caching the enrichment never staleness-freezes the actionable signal.
export const GET = withGuard(async (request) => {
  const symbol = (request.nextUrl.searchParams.get('symbol') || '').toUpperCase().trim();
  if (!symbol) return NextResponse.json({ error: 'missing symbol' }, { status: 400 });

  const supabase = getSupabase();

  // Most recent stored signal for this symbol (drives the overlay's signal block
  // and is the fallback when we can't afford a fresh fetch). Always read fresh.
  const { data: sigRows } = await supabase
    .from('signals')
    .select(
      'id, symbol, signal, confidence, price, entry, sl, target, hold, why, risk, action, sector, live_data, created_at'
    )
    .eq('symbol', symbol)
    .order('created_at', { ascending: false })
    .limit(1);
  const signal = sigRows?.[0] || null;

  // Prefer real, ground-truth fundamentals already stored on the latest signal's
  // live_data (scraped from the verified provider page) over an LLM web-search — it's
  // reliable and free. When present, skip the LLM entirely and serve the stored data.
  const storedData = signal?.live_data || null;
  const hasStoredFundamentals =
    storedData && (storedData.eps != null || storedData.week52_high != null);
  if (hasStoredFundamentals) {
    return NextResponse.json({
      symbol,
      data: storedData,
      analysis: '',
      signal,
      stored: true,
    });
  }

  // Shared cache hit: reuse another user's recent enrichment, no LLM spend.
  const cached = await getCache('stock:' + symbol);
  if (cached) {
    return NextResponse.json({
      symbol,
      data: cached.data || signal?.live_data || null,
      analysis: cached.analysis || '',
      signal,
      cached: true,
    });
  }

  // Budget guard: skip the live fetch, fall back to stored data.
  if ((await remaining()) <= 0) {
    return NextResponse.json({
      symbol,
      data: signal?.live_data || null,
      analysis: '',
      signal,
      budget: false,
    });
  }

  const prompt = `Research NEPSE-listed stock "${symbol}". Search merolagani.com (sharesansar.com as backup) for its current trading data, then return ONLY JSON of this exact shape (no prose, no markdown):
{
  "data": {
    "price": <last price number>,
    "change_pct": <day percent change number or null>,
    "week52_high": <number or null>,
    "week52_low": <number or null>,
    "avg120": <120-day average price number or null>,
    "eps": <number or null>,
    "pe": <number or null>,
    "bv": <book value number or null>,
    "pbv": <price-to-book number or null>,
    "div_pct": <latest dividend percent number or null>,
    "yield": <dividend yield percent number or null>,
    "volume": <today's volume number or null>,
    "news": ["<recent headline 1>", "<headline 2>", "<headline 3>"]
  },
  "analysis": "<2-3 sentence plain-English read on ${symbol}: valuation, momentum, and what to watch>"
}`;

  const text = await callLLM(prompt, {
    system: 'You are a NEPSE stock research agent. Return only valid JSON. Use the most recent live data you can find.',
    webSearch: true,
    maxTokens: 1200,
  });

  const parsed = parseJson(text) || {};

  // Cache the enrichment for the next user who opens this symbol. Only cache a real
  // result (don't poison the cache with an empty parse from a junk/failed response),
  // and never the signal (read fresh each time). Best-effort — setCache never throws.
  if (parsed.data || parsed.analysis) {
    await setCache('stock:' + symbol, { data: parsed.data || null, analysis: parsed.analysis || '' }, STOCK_CACHE_TTL_MS);
  }

  return NextResponse.json({
    symbol,
    data: parsed.data || signal?.live_data || null,
    analysis: parsed.analysis || '',
    signal,
    cached: false,
  });
});

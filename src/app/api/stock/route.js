import { NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';
import { callLLM, parseJson } from '@/lib/llm';
import { withGuard } from '@/lib/respond';
import { remaining } from '@/lib/budget';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// GET /api/stock?symbol=NABIL -> { symbol, data, analysis, signal }
//
// Powers the stock detail overlay. V1 fetched live data + analysis from the LLM
// in the browser; V2 does it server-side and folds in the most recent stored
// signal so the overlay still shows something useful when the daily LLM budget
// is spent.
export const GET = withGuard(async (request) => {
  const symbol = (request.nextUrl.searchParams.get('symbol') || '').toUpperCase().trim();
  if (!symbol) return NextResponse.json({ error: 'missing symbol' }, { status: 400 });

  const supabase = getSupabase();

  // Most recent stored signal for this symbol (drives the overlay's signal block
  // and is the fallback when we can't afford a fresh fetch).
  const { data: sigRows } = await supabase
    .from('signals')
    .select(
      'id, symbol, signal, confidence, price, entry, sl, target, hold, why, risk, action, sector, live_data, created_at'
    )
    .eq('symbol', symbol)
    .order('created_at', { ascending: false })
    .limit(1);
  const signal = sigRows?.[0] || null;

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
  return NextResponse.json({
    symbol,
    data: parsed.data || signal?.live_data || null,
    analysis: parsed.analysis || '',
    signal,
  });
});

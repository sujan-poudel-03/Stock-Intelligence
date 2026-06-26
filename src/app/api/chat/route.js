import { NextResponse } from 'next/server';
import { callLLM } from '@/lib/llm';
import { withGuard } from '@/lib/respond';
import { remaining } from '@/lib/budget';
import { getOverviewContext } from '@/lib/calibration';
import { getKnowledgeContext } from '@/lib/knowledge';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// POST /api/chat  { message, context } -> { reply }
//
// The Ask advisor. V1 called Anthropic directly from the browser; V2 routes it
// through the server-side provider adapter so there is no client-exposed API key
// and the daily LLM budget still applies. `context` is sent by the client and
// carries the bits it holds locally (portfolio is client-side state).
export const POST = withGuard(async (request) => {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const message = (body?.message || '').toString().trim();
  if (!message) return NextResponse.json({ error: 'missing message' }, { status: 400 });

  // Budget guard: answer without burning a call when the day's quota is spent.
  if ((await remaining()) <= 0) {
    return NextResponse.json({
      reply: "I've hit today's AI usage limit, so I can't pull fresh analysis right now. Try again after the daily reset (00:00 UTC).",
      budget: false,
    });
  }

  const ctx = body?.context || {};
  const portfolio = Array.isArray(ctx.portfolio) ? ctx.portfolio : [];
  const signals = Array.isArray(ctx.signals) ? ctx.signals : [];
  const watchlist = Array.isArray(ctx.watchlist) ? ctx.watchlist : [];
  const market = ctx.market || null;

  const openPos = portfolio.filter((p) => p.status === 'OPEN');
  const portStr =
    openPos.map((p) => `${p.symbol} ${p.qty}u@Rs${p.price}`).join('; ') || 'none';
  const sigStr =
    signals
      .slice(0, 12)
      .map((s) => `${s.symbol}:${s.signal}${s.price ? ' Rs' + s.price : ''}`)
      .join('; ') || 'none';
  const mktStr = market
    ? `${market.index ?? '?'} ${market.changePct ?? market.change_pct ?? '?'}% ${market.sentiment ?? 'NEUTRAL'}`
    : 'unknown';

  // Learned context: the advisor should reason from the agent's own track record
  // (overall hit rate + per-slice leaderboard) and the durable lessons accrued on
  // the symbols the user actually holds. Best-effort — chat must answer even with
  // no history or weights table unavailable.
  let learned = '';
  try {
    const overview = await getOverviewContext();
    const posSyms = [...new Set(openPos.map((p) => p.symbol).filter(Boolean))].slice(0, 4);
    const notes = (
      await Promise.all(posSyms.map((s) => getKnowledgeContext(s, null).catch(() => '')))
    ).filter(Boolean);
    learned = [overview, ...notes].filter(Boolean).join('\n\n');
  } catch {
    /* no learned context available — advise without it */
  }
  const learnedBlock = learned
    ? `\nAGENT TRACK RECORD & LESSONS (this is your own past performance — weigh it, cite it when relevant):\n${learned}\n`
    : '';

  const system = `You are a sharp, direct NEPSE (Nepal Stock Exchange) trading advisor.
Open positions (${openPos.length}): ${portStr}.
Today's signals: ${sigStr}.
Market: ${mktStr}.
Watchlist: ${watchlist.join(', ') || 'empty'}.
${learnedBlock}NEPSE charges: broker 0.4% (min Rs10), SEBON 0.0015%, DP Rs25, CGT 7.5% (<1yr) / 5% (>=1yr).
Be concise and concrete — at most 5 short lines. Search the web for live prices/news when the question needs current data.`;

  const reply = await callLLM(message, { system, webSearch: true, maxTokens: 700 });

  return NextResponse.json({
    reply: reply || "I couldn't generate a response just now — please try again.",
  });
});

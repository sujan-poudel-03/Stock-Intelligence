import { NextResponse } from 'next/server';
import { callLLM } from '@/lib/llm';
import { withGuard } from '@/lib/respond';
import { remaining } from '@/lib/budget';
import { getOverviewContext } from '@/lib/calibration';
import { getKnowledgeContext } from '@/lib/knowledge';
import { getUserFromRequest } from '@/lib/auth';
import { checkAndBumpChatQuota } from '@/lib/userQuota';
import { getUserEntitlements } from '@/lib/entitlements';
import { getUserSupabase } from '@/lib/supabase';
import { SEBON_LEVY_PCT, DP_FEE } from '@/lib/charges';
import { buildPortfolioSummary } from '@/lib/portfolioSummary';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Auth is "on" when the client Supabase config is present (same signal the client's
// authConfigured uses). When on, Ask is a per-user feature: sign-in required + a
// per-user daily quota. When off (single-operator local deploy), Ask stays open.
const authOn = () =>
  Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

// Compact money/percent display for the prompt (integer Rupees / whole-percent).
const round = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0);

// POST /api/chat  { message, context } -> { reply }
//
// The Ask advisor. V1 called Anthropic directly from the browser; V2 routes it
// through the server-side provider adapter so there is no client-exposed API key
// and the daily LLM budget still applies. `context` is sent by the client and
// carries the bits it holds locally (portfolio is client-side state).
export const POST = withGuard(async (request) => {
  // Per-user gate: when auth is configured, Ask requires sign-in (it's a per-user
  // feature and draws the shared LLM budget). Single-operator deploys stay open.
  const user = await getUserFromRequest(request);
  if (authOn() && !user) {
    return NextResponse.json(
      { error: 'Sign in to use Ask.', authRequired: true },
      { status: 401 }
    );
  }

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

  // Per-user daily quota: stops a single user from draining the shared budget for
  // everyone. Only enforced for signed-in users (open single-operator deploys skip).
  if (user) {
    // Tier-aware daily cap: resolve the user's entitlement (owner-read via their
    // token) and use their plan's chat_daily as the limit. Best-effort — getUserTier
    // defaults to 'free' on any error, so the quota still applies.
    const entitlements = await getUserEntitlements(getUserSupabase(user.token), user.id);
    const q = await checkAndBumpChatQuota(user.id, entitlements.chat_daily);
    if (!q.allowed) {
      return NextResponse.json({
        reply: `You've reached today's Ask limit (${q.limit} questions). It resets at 00:00 UTC — the daily brief, signals, and track record are still here in the meantime.`,
        quota: false,
      });
    }
  }

  const ctx = body?.context || {};
  const portfolio = Array.isArray(ctx.portfolio) ? ctx.portfolio : [];
  const signals = Array.isArray(ctx.signals) ? ctx.signals : [];
  const watchlist = Array.isArray(ctx.watchlist) ? ctx.watchlist : [];
  const market = ctx.market || null;

  // Portfolio truth: when signed in, compute P&L + concentration SERVER-SIDE from the
  // user's own positions + the shared ground-truth prices (buildPortfolioSummary) rather
  // than trusting the client-sent ctx.portfolio (which carried throwaway client math and
  // no verified prices). Best-effort — a failure falls back to the client-ctx path below,
  // and the LLM never sets a price (it only reads the finished summary).
  let serverSummary = null;
  if (user) {
    serverSummary = await buildPortfolioSummary(user).catch(() => null);
    if (serverSummary && !serverSummary.ok) serverSummary = null;
  }

  // openPos: server-derived open rows when available, else the client-ctx fallback.
  const openPos = serverSummary
    ? serverSummary.positions.filter((p) => p.status === 'open')
    : portfolio.filter((p) => p.status === 'OPEN');
  const openCount = openPos.length;

  let portStr;
  let concStr = '';
  if (serverSummary) {
    const t = serverSummary.totals;
    portStr =
      openPos
        .map((p) => {
          const px = p.priceUnavailable ? 'n/a' : `Rs${round(p.currentPrice)}`;
          const pnl = p.priceUnavailable ? '' : ` P&L Rs${round(p.netPnl)} (${round(p.returnPct)}%)`;
          return `${p.symbol} ${p.qty}u@Rs${round(p.buyPrice)}→${px}${pnl}`;
        })
        .join('; ') || 'none';
    // Concentration + realized/unrealized headline the advisor can cite verbatim.
    const top = serverSummary.concentration?.bySector?.[0];
    const conc = top ? `top sector ${top.key} ${round(top.pct)}%${top.overConcentrated ? ' (OVER-CONCENTRATED >40%)' : ''}` : 'n/a';
    concStr = `Portfolio (server-computed, net of charges): cost basis Rs${round(t.costBasis)}, current value Rs${round(t.currentValue)}, unrealized Rs${round(t.unrealizedNet)} (after-CGT if sold today Rs${round(t.unrealizedNetAfterTax)}), realized Rs${round(t.realizedNet)}; ${conc}.`;
  } else {
    portStr =
      openPos.map((p) => `${p.symbol} ${p.qty}u@Rs${p.price}`).join('; ') || 'none';
  }
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
Open positions (${openCount}): ${portStr}.
${concStr ? concStr + '\n' : ''}Today's signals: ${sigStr}.
Market: ${mktStr}.
Watchlist: ${watchlist.join(', ') || 'empty'}.
${learnedBlock}NEPSE charges (each leg): broker commission is TIERED on the whole transaction value — <=50k 0.36%, 50k-500k 0.33%, 500k-2M 0.31%, 2M-10M 0.27%, >10M 0.24% (min Rs 10/txn); SEBON levy ${SEBON_LEVY_PCT}%; DP Rs ${DP_FEE}/scrip. CGT on gains only: 7.5% (<1yr) / 5% (>=1yr).
Be concise and concrete — at most 5 short lines. Search the web for live prices/news when the question needs current data.`;

  const reply = await callLLM(message, { system, webSearch: true, maxTokens: 700 });

  return NextResponse.json({
    reply: reply || "I couldn't generate a response just now — please try again.",
  });
});

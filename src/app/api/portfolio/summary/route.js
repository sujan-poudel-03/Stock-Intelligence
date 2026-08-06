import { NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/auth';
import { withGuard } from '@/lib/respond';
import { buildPortfolioSummary } from '@/lib/portfolioSummary';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// GET /api/portfolio/summary -> server-side portfolio P&L + concentration for this user.
//
// The heavier companion to GET /api/portfolio (which stays the fast raw-rows list). This
// computes cost basis, realized/unrealized net-of-charges P&L, and sector/symbol
// concentration SERVER-SIDE, reusing the SHARED already-computed signal prices (ground
// truth, never LLM-sourced) — see src/lib/portfolioSummary.js. Owner-only: same Bearer +
// user_id scoping as the portfolio route. Never re-scans the market; bounded on-demand
// price fallback keeps it inside the 60s budget.
export const GET = withGuard(async (request) => {
  const user = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });

  const summary = await buildPortfolioSummary(user);
  return NextResponse.json(summary);
});

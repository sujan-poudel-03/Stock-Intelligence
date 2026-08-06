import { NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/auth';
import { withGuard } from '@/lib/respond';
import { buildPaperSummary } from '@/lib/paperSummary';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// GET /api/paper -> this user's SIMULATED (paper) account: virtual cash, equity, return%,
// simulated positions with net-of-charges P&L + concentration (§4.1, Beginner flagship).
//
// This is a per-user READ over the SEPARATE paper_* tables (owner-only, same Bearer +
// user_id scoping as /api/portfolio). It reuses the SHARED ground-truth signal prices
// (never LLM-sourced) and a bounded on-demand verified-price fallback, so it never
// re-scans the market and stays inside the 60s budget. Probe-gated: an unmigrated DB
// returns { ok:true, enabled:false } and the UI hides the feature.
export const GET = withGuard(async (request) => {
  const user = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });

  const summary = await buildPaperSummary(user);
  return NextResponse.json(summary);
});

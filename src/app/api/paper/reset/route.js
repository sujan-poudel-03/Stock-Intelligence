import { NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/auth';
import { withGuard } from '@/lib/respond';
import { getUserSupabase } from '@/lib/supabase';
import { paperTradingReady } from '@/lib/schemaFlags';
import { ensurePaperAccount, buildPaperSummary } from '@/lib/paperSummary';

export const dynamic = 'force-dynamic';

// POST /api/paper/reset -> wipe this user's SIMULATED positions and restore virtual cash
// to the account's starting balance (§4.1). Owner-scoped; probe-gated (503 unmigrated).
// A pure sandbox reset — nothing outside the paper_* tables is touched.
export const POST = withGuard(async (request) => {
  const user = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });

  if (!(await paperTradingReady())) {
    return NextResponse.json({ error: 'Paper trading is not enabled on this deployment' }, { status: 503 });
  }

  const supabase = getUserSupabase(user.token);
  const account = await ensurePaperAccount(user, supabase);

  // Wipe simulated positions (owner-scoped) …
  const { error: delErr } = await supabase.from('paper_positions').delete().eq('user_id', user.id);
  if (delErr) throw delErr;

  // … and restore cash to the account's starting_cash, stamping reset_at.
  const { error: updErr } = await supabase
    .from('paper_accounts')
    .update({ cash: account.starting_cash, reset_at: new Date().toISOString() })
    .eq('user_id', user.id);
  if (updErr) throw updErr;

  const summary = await buildPaperSummary(user);
  return NextResponse.json({ ok: true, summary });
});

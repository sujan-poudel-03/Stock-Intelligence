import { NextResponse } from 'next/server';
import { getUserSupabase } from '@/lib/supabase';
import { getUserFromRequest } from '@/lib/auth';
import { withGuard, unauthorized } from '@/lib/respond';
import { removeSubscription } from '@/lib/pushSubscriptions';

export const dynamic = 'force-dynamic';

// POST /api/push/unsubscribe { endpoint } -> { ok: true } | { error }
export const POST = withGuard(async (request) => {
  const user = await getUserFromRequest(request);
  if (!user) return unauthorized();

  let body;
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'invalid json' }, { status: 400 }); }

  const supabase = getUserSupabase(user.token);
  const ok = await removeSubscription(supabase, user.id, body?.endpoint);
  if (!ok) return NextResponse.json({ error: 'Could not remove subscription' }, { status: 503 });
  return NextResponse.json({ ok: true });
});

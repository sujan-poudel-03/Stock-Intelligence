import { NextResponse } from 'next/server';
import { getUserSupabase } from '@/lib/supabase';
import { getUserFromRequest } from '@/lib/auth';
import { withGuard, unauthorized } from '@/lib/respond';
import { saveSubscription } from '@/lib/pushSubscriptions';

export const dynamic = 'force-dynamic';

// POST /api/push/subscribe { subscription } -> { ok: true } | { error }
// Owner-scoped, same pattern as /api/alerts. `subscription` is the raw object
// PushManager.subscribe() resolves to ({ endpoint, keys: { p256dh, auth } }).
export const POST = withGuard(async (request) => {
  const user = await getUserFromRequest(request);
  if (!user) return unauthorized();

  let body;
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'invalid json' }, { status: 400 }); }

  const supabase = getUserSupabase(user.token);
  const ok = await saveSubscription(supabase, user.id, body?.subscription);
  if (!ok) return NextResponse.json({ error: 'Could not save subscription' }, { status: 503 });
  return NextResponse.json({ ok: true });
});

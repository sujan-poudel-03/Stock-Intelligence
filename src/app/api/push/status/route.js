import { NextResponse } from 'next/server';
import { getUserSupabase } from '@/lib/supabase';
import { getUserFromRequest } from '@/lib/auth';
import { withGuard } from '@/lib/respond';
import { hasAnySubscription } from '@/lib/pushSubscriptions';

export const dynamic = 'force-dynamic';

// GET /api/push/status -> { subscribed: boolean }
// Owner-scoped: whether THIS user has at least one stored push subscription —
// drives the Settings UI's connected/not-connected state.
export const GET = withGuard(async (request) => {
  const user = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ subscribed: false });

  const supabase = getUserSupabase(user.token);
  const subscribed = await hasAnySubscription(supabase, user.id);
  return NextResponse.json({ subscribed });
});

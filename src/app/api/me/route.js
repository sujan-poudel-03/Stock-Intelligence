import { NextResponse } from 'next/server';
import { withGuard } from '@/lib/respond';
import { getUserFromRequest } from '@/lib/auth';
import { getUserSupabase } from '@/lib/supabase';
import { getUserTier, entitlementFor } from '@/lib/entitlements';

export const dynamic = 'force-dynamic';

// GET /api/me -> the caller's identity + resolved tier + entitlements. This is what
// the client polls to know what's unlocked. Tier is read with the USER-scoped client:
// the subscriptions RLS owner-READ policy lets a user read their OWN row (and only
// their own); no row → 'free'. A user can read but never WRITE their tier (that path
// is service-only, via /api/admin/tier).
export const GET = withGuard(async (request) => {
  const user = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });

  const tier = await getUserTier(getUserSupabase(user.token), user.id);
  return NextResponse.json({
    user: { id: user.id, email: user.email },
    tier,
    entitlements: entitlementFor(tier),
  });
});

import { NextResponse } from 'next/server';
import { withGuard, edgeCache } from '@/lib/respond';

export const dynamic = 'force-dynamic';

// GET /api/push/vapid-public-key -> { enabled, publicKey }
// Public, unauthenticated — a VAPID public key is safe to expose (it's exactly
// what PushManager.subscribe({ applicationServerKey }) needs client-side).
// enabled:false when VAPID_PUBLIC_KEY isn't set (see scripts/generate-vapid-keys.mjs).
export const GET = withGuard(async () => {
  const publicKey = process.env.VAPID_PUBLIC_KEY || null;
  return NextResponse.json(
    { enabled: !!publicKey, publicKey },
    { headers: edgeCache(300) }
  );
});

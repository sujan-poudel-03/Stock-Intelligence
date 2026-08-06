import { NextResponse } from 'next/server';
import { withGuard, edgeCache } from '@/lib/respond';
import { listChannels } from '@/lib/notify';

export const dynamic = 'force-dynamic';

// GET /api/channels -> notification-channel DELIVERABILITY (env-gated booleans +
// the required env-var NAMES, never secrets), so the per-user Alerts UI can warn
// when a channel is toggled ON but not configured server-side. A semantically-clean
// public/authed read that mirrors /api/exchanges: server-decided flags only, and
// (like the channels themselves) it only changes on an env/deploy change, so it can
// cache at the edge across all users. Distinct from the admin-named
// /api/admin/channels (same payload, admin-surface framing).
export const GET = withGuard(async () => {
  return NextResponse.json({ channels: listChannels() }, { headers: edgeCache(300, 900) });
});

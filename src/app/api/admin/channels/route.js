import { NextResponse } from 'next/server';
import { withGuard } from '@/lib/respond';
import { listChannels } from '@/lib/notify';

export const dynamic = 'force-dynamic';

// GET /api/admin/channels -> notification channels + whether each is configured
// (active). Channels are env-driven — active automatically when their required env
// is present — so this is read-only status, not a toggle.
// NOTE: unauthenticated while single-tenant (like /api/admin/sources); admin auth
// is Phase 2.
export const GET = withGuard(async () => {
  return NextResponse.json({ channels: listChannels() });
});

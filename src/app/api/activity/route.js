import { NextResponse } from 'next/server';
import { withGuard } from '@/lib/respond';
import { recentEvents } from '@/lib/events';

export const dynamic = 'force-dynamic';

// GET /api/activity?limit=100 -> durable activity history, newest first.
export const GET = withGuard(async (request) => {
  const limit = Number(request.nextUrl.searchParams.get('limit')) || 100;
  const events = await recentEvents(limit);
  return NextResponse.json({ events });
});

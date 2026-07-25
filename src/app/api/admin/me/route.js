import { NextResponse } from 'next/server';
import { withGuard } from '@/lib/respond';
import { resolveAdmin } from '@/lib/auth';

export const dynamic = 'force-dynamic';

// GET /api/admin/me -> { gateEnabled, isAdmin, email }
// Lets the client decide whether to show admin UI. NOT a security boundary — the
// server-side requireAdmin on mutation routes is. In open mode (no ADMIN_EMAILS)
// everyone reads as admin, matching how the mutations behave.
export const GET = withGuard(async (request) => {
  return NextResponse.json(await resolveAdmin(request));
});

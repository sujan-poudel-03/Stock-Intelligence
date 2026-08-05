import { NextResponse } from 'next/server';
import { withGuard } from '@/lib/respond';
import { requireAdmin } from '@/lib/auth';
import { normalizeScanParams } from '@/lib/adminScan';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// POST /api/admin/scan { exchange?, mode? } -> trigger the ONE global scan.
//
// A scan is a SYSTEM/admin action, not a tenant one: it runs the single global scan
// for an exchange that serves every user. The real trigger (/api/cron/scan) is
// guarded by CRON_SECRET — which the browser never has — so the in-app "scan now"
// button posts HERE instead. We verify the caller is an admin (server-enforced
// against ADMIN_EMAILS; OPEN while the allowlist is unset), then call cron/scan
// SERVER-SIDE, attaching the CRON_SECRET the browser can't see. cron/scan returns
// immediately (it self-chains the worker in the background), so awaiting it stays
// well inside the function budget. We pass its response through (started/skipped/
// scan_id) so the UI can reflect what happened.
export const POST = withGuard(async (request) => {
  const gate = await requireAdmin(request);
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

  const body = await request.json().catch(() => ({}));
  const { path } = normalizeScanParams(body);

  // Build the internal cron URL on THIS origin so the self-call hits the port the
  // server actually bound to (dev bumps to 3001+ when 3000 is taken). Attach the
  // CRON_SECRET exactly the way checkCronAuth expects; when it's unset the cron
  // route allows the call (single-operator/dev).
  const url = `${request.nextUrl.origin}${path}`;
  const headers = { 'content-type': 'application/json' };
  if (process.env.CRON_SECRET) headers.authorization = `Bearer ${process.env.CRON_SECRET}`;

  const res = await fetch(url, { method: 'POST', headers });
  const data = await res.json().catch(() => ({ error: 'scan trigger failed' }));
  return NextResponse.json(data, { status: res.status });
});

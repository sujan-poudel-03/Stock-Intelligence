import { NextResponse } from 'next/server';
import { withGuard } from '@/lib/respond';
import { requireAdmin } from '@/lib/auth';
import { listProviders, getActiveSources, setActiveSources } from '@/lib/marketProviders';

export const dynamic = 'force-dynamic';

// GET /api/admin/sources -> available market-data providers + the active selection.
// Read-only status; safe to leave open (reveals no secrets).
export const GET = withGuard(async () => {
  const [providers, active] = await Promise.all([
    Promise.resolve(listProviders()),
    getActiveSources(),
  ]);
  return NextResponse.json({ providers, active });
});

// POST /api/admin/sources { active: [...] } -> persist selection. ADMIN-ONLY
// (server-enforced when ADMIN_EMAILS is set; open while single-operator).
export const POST = withGuard(async (request) => {
  const gate = await requireAdmin(request);
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

  const body = await request.json().catch(() => ({}));
  const requested = Array.isArray(body?.active)
    ? body.active
    : Array.isArray(body?.sources)
      ? body.sources
      : [];
  try {
    const active = await setActiveSources(requested);
    return NextResponse.json({ ok: true, active });
  } catch (err) {
    return NextResponse.json({ error: err?.message || 'Invalid selection' }, { status: 400 });
  }
});

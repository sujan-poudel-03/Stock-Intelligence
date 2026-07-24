import { NextResponse } from 'next/server';
import { withGuard } from '@/lib/respond';
import { listProviders, getActiveSources, setActiveSources } from '@/lib/marketProviders';

export const dynamic = 'force-dynamic';

// GET /api/admin/sources -> available market-data providers + the active selection.
// NOTE: unauthenticated by design while the app is single-tenant (like /api/storage).
// A real admin auth gate is Phase 2 (multi-tenant). Do not expose this publicly as-is.
export const GET = withGuard(async () => {
  const [providers, active] = await Promise.all([
    Promise.resolve(listProviders()),
    getActiveSources(),
  ]);
  return NextResponse.json({ providers, active });
});

// POST /api/admin/sources { active: ["merolagani","sharesansar"] } -> persist selection.
export const POST = withGuard(async (request) => {
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

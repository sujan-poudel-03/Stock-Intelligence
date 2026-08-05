import { NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';
import { withGuard } from '@/lib/respond';
import { RETIRED_KV_KEYS, GLOBAL_READ_KEYS } from '@/lib/constants';

export const dynamic = 'force-dynamic';

// READ-ONLY global kv access. Phase 2 hardening:
//   - Per-user keys are RETIRED (410) — they moved to per-user tables/routes.
//   - Only an explicit allowlist of global, public-read keys is served
//     (GLOBAL_READ_KEYS: the daily brief + market snapshot), and only for READ.
//   - ALL writes/deletes through this route are rejected (405). Those global keys
//     are written server-side by the cron/service role directly; no client writes
//     here. This closes the prior hole where an unauthenticated POST could overwrite
//     the brief that every user reads (stored-content injection into a money surface)
//     or DELETE it (DoS).
// The old exclusion-based ("anything not retired passes") logic is gone — this is a
// positive allowlist.

// GET /api/storage?key=ni:brief  -> { value: <jsonb> | null }
export const GET = withGuard(async (request) => {
  const key = request.nextUrl.searchParams.get('key');
  if (!key) return NextResponse.json({ error: 'missing key' }, { status: 400 });

  if (RETIRED_KV_KEYS.includes(key)) {
    return NextResponse.json(
      { error: 'This key moved to a per-user route in Phase 2. Use /api/watchlist, /api/portfolio, /api/settings or /api/admin/settings.', key, gone: true },
      { status: 410 }
    );
  }
  if (!GLOBAL_READ_KEYS.includes(key)) {
    return NextResponse.json({ error: 'unknown or non-readable key', key }, { status: 404 });
  }

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('kv_store')
    .select('value')
    .eq('key', key)
    .maybeSingle();

  if (error) throw error;
  return NextResponse.json({ value: data?.value ?? null });
});

// Writes are not allowed through this route — global keys are written by the
// cron/service role, per-user data goes through its own owner-scoped routes.
const writeRejected = () =>
  NextResponse.json(
    { error: 'read-only: writes go through the service role (global) or per-user routes (/api/watchlist, /api/portfolio, /api/settings)' },
    { status: 405 }
  );

export const POST = withGuard(async () => writeRejected());
export const DELETE = withGuard(async () => writeRejected());

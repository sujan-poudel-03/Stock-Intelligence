import { NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';
import { withGuard } from '@/lib/respond';
import { RETIRED_KV_KEYS } from '@/lib/constants';

export const dynamic = 'force-dynamic';

// GLOBAL kv read/write. Phase 2 step 5b RETIRED the per-user keys from here (they
// were the data-leak vector — one identity-less shared row served to every user).
// Those keys now live in per-user tables / the admin config route / device-local
// storage; this route returns 410 Gone for them so a stray caller fails loudly
// instead of silently sharing data. Genuinely-global keys (ni:brief, ni:mkt) still
// work — this route stays for them.
function retired(key) {
  if (RETIRED_KV_KEYS.includes(key)) {
    return NextResponse.json(
      { error: 'This key moved to a per-user route in Phase 2. Use /api/watchlist, /api/portfolio, /api/settings or /api/admin/settings.', key, gone: true },
      { status: 410 }
    );
  }
  return null;
}

// GET /api/storage?key=ni:brief  -> { value: <jsonb> | null }
export const GET = withGuard(async (request) => {
  const key = request.nextUrl.searchParams.get('key');
  if (!key) return NextResponse.json({ error: 'missing key' }, { status: 400 });
  const gone = retired(key);
  if (gone) return gone;

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('kv_store')
    .select('value')
    .eq('key', key)
    .maybeSingle();

  if (error) throw error;
  return NextResponse.json({ value: data?.value ?? null });
});

// POST /api/storage  { key, value }  -> upsert
export const POST = withGuard(async (request) => {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const { key, value } = body || {};
  if (!key) return NextResponse.json({ error: 'missing key' }, { status: 400 });
  const gone = retired(key);
  if (gone) return gone;

  const supabase = getSupabase();
  const { error } = await supabase.from('kv_store').upsert(
    { key, value, updated_at: new Date().toISOString() },
    { onConflict: 'key' }
  );

  if (error) throw error;
  return NextResponse.json({ ok: true, key });
});

// DELETE /api/storage?key=ni:brief
export const DELETE = withGuard(async (request) => {
  const key = request.nextUrl.searchParams.get('key');
  if (!key) return NextResponse.json({ error: 'missing key' }, { status: 400 });
  const gone = retired(key);
  if (gone) return gone;

  const supabase = getSupabase();
  const { error } = await supabase.from('kv_store').delete().eq('key', key);

  if (error) throw error;
  return NextResponse.json({ ok: true, key });
});

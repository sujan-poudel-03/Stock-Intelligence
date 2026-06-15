import { NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';
import { withGuard } from '@/lib/respond';

export const dynamic = 'force-dynamic';

// GET /api/storage?key=ni:wl  -> { value: <jsonb> | null }
export const GET = withGuard(async (request) => {
  const key = request.nextUrl.searchParams.get('key');
  if (!key) return NextResponse.json({ error: 'missing key' }, { status: 400 });

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

  const supabase = getSupabase();
  const { error } = await supabase.from('kv_store').upsert(
    { key, value, updated_at: new Date().toISOString() },
    { onConflict: 'key' }
  );

  if (error) throw error;
  return NextResponse.json({ ok: true, key });
});

// DELETE /api/storage?key=ni:wl
export const DELETE = withGuard(async (request) => {
  const key = request.nextUrl.searchParams.get('key');
  if (!key) return NextResponse.json({ error: 'missing key' }, { status: 400 });

  const supabase = getSupabase();
  const { error } = await supabase.from('kv_store').delete().eq('key', key);

  if (error) throw error;
  return NextResponse.json({ ok: true, key });
});

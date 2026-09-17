import { NextResponse } from 'next/server';
import { getUserSupabase } from '@/lib/supabase';
import { getUserFromRequest } from '@/lib/auth';
import { withGuard } from '@/lib/respond';
import { unlinkTelegram } from '@/lib/telegramLink';

export const dynamic = 'force-dynamic';

function unauthorized() {
  return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
}

// POST /api/alerts/telegram/unlink -> { ok: true } | { error }
// Owner-only. Clears this user's linked chat_id; the channels.telegram toggle stays
// as-is (it just has nothing to deliver to until re-linked).
export const POST = withGuard(async (request) => {
  const user = await getUserFromRequest(request);
  if (!user) return unauthorized();

  const supabase = getUserSupabase(user.token);
  const ok = await unlinkTelegram(supabase, user.id);
  if (!ok) return NextResponse.json({ error: 'Could not unlink' }, { status: 503 });
  return NextResponse.json({ ok: true });
});

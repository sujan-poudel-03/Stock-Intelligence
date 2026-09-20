import { NextResponse } from 'next/server';
import { getUserSupabase } from '@/lib/supabase';
import { getUserFromRequest } from '@/lib/auth';
import { withGuard, unauthorized } from '@/lib/respond';
import { issueLinkCode } from '@/lib/telegramLink';

export const dynamic = 'force-dynamic';

// POST /api/alerts/telegram/link -> { code, expiresAt, botUsername } | { error }
//
// Owner-only, same pattern as /api/alerts. Issues a fresh 15-minute link code the
// user opens in Telegram (deep link `https://t.me/<botUsername>?start=<code>`, or
// typed manually as `/start <code>`) to connect their chat for per-user alerts —
// see src/lib/telegramLink.js. botUsername comes from TELEGRAM_BOT_USERNAME so the
// UI can build the deep link without hardcoding it; missing env just omits it (the
// code + manual instructions still work).
export const POST = withGuard(async (request) => {
  const user = await getUserFromRequest(request);
  if (!user) return unauthorized();

  const supabase = getUserSupabase(user.token);
  const issued = await issueLinkCode(supabase, user.id);
  if (!issued) {
    return NextResponse.json({ error: 'Telegram linking is not available on this deployment yet' }, { status: 503 });
  }
  return NextResponse.json({
    code: issued.code,
    expiresAt: issued.expiresAt,
    botUsername: process.env.TELEGRAM_BOT_USERNAME || null,
  });
});

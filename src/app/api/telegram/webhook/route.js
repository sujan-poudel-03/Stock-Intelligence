import { NextResponse } from 'next/server';
import { getServiceSupabase } from '@/lib/supabase';
import { withGuard } from '@/lib/respond';
import { parseStartCommand, resolveLinkCode } from '@/lib/telegramLink';
import { deliverTelegramDM } from '@/lib/notify';

export const dynamic = 'force-dynamic';

// POST /api/telegram/webhook — Telegram's webhook target for the bot (set via
// https://api.telegram.org/bot<TOKEN>/setWebhook?url=<this route>&secret_token=<TELEGRAM_WEBHOOK_SECRET>).
//
// SECURITY: when TELEGRAM_WEBHOOK_SECRET is set, Telegram echoes it back on every
// call as X-Telegram-Bot-Api-Secret-Token — required so an attacker who finds this
// public URL can't forge a fake "/start <code>" and steal someone else's alert
// channel by redeeming their link code without ever touching Telegram. Left
// unenforced only when the secret isn't configured (matches this codebase's other
// config-gated features — the deployment owner opts in when they set the webhook).
//
// ALWAYS returns 200 (Telegram retries aggressively on anything else) — every
// failure mode (bad secret aside) degrades to a silent no-op or a DM back to the
// user, never a thrown error.
export const POST = withGuard(async (request) => {
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (expectedSecret) {
    const got = request.headers.get('x-telegram-bot-api-secret-token');
    if (got !== expectedSecret) {
      return NextResponse.json({ ok: false }, { status: 401 });
    }
  }

  let update;
  try {
    update = await request.json();
  } catch {
    return NextResponse.json({ ok: true }); // malformed body — ack anyway, nothing to do
  }

  try {
    const message = update?.message || update?.edited_message;
    const text = message?.text;
    const chatId = message?.chat?.id;
    const code = parseStartCommand(text);

    if (code && chatId) {
      const supabase = getServiceSupabase();
      const linked = await resolveLinkCode(supabase, code, chatId);
      await deliverTelegramDM({
        chatId,
        text: linked
          ? "You're linked! NEPSE Intelligence alerts for your watched symbols will arrive here."
          : "That code is invalid or expired — request a new one from Settings → My Alerts in the app.",
      }).catch(() => {});
    }
  } catch (err) {
    console.error('telegram webhook handling failed:', err?.message || err);
  }

  return NextResponse.json({ ok: true });
});

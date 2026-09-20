// Config-gated notification channels.
//
// A channel is ACTIVE only when its required env is present — same pattern as the
// market-data providers. notify() fans out to every active channel, best-effort: a
// channel failure is logged and swallowed, never thrown into the scan flow (channels
// are a side-channel, like alerts/events). No env for a channel → it's simply off.
//
//   email    ← RESEND_API_KEY (+ optional ALERT_TO / ALERT_FROM)
//   telegram ← TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
//
// Push is NOT in this list: there's no single "operator" push subscription to send
// the digest to (subscriptions are per-user, per-browser) — see deliverPush() below,
// used only by alertDelivery.js's per-user TIER-2 fan-out. It's still reported by
// listChannels() (below) so the admin/My-Alerts UI can show its configured status.
const CHANNELS = [
  { id: 'email', label: 'Email (Resend)', requiresEnv: ['RESEND_API_KEY'], send: sendEmail },
  { id: 'telegram', label: 'Telegram', requiresEnv: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'], send: sendTelegram },
];

const PUSH_REQUIRES_ENV = ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'];

function hasEnv(keys, env) {
  return keys.every((k) => !!(env[k] && String(env[k]).trim()));
}

// Metadata for the admin screen (no functions). `configured` drives the active/off
// display; channels can't be toggled in the UI — they're purely env-driven. Push is
// appended separately (not part of CHANNELS/configuredChannels) since it has no
// operator-digest `send` — see the comment above.
export function listChannels(env = process.env) {
  return [
    ...CHANNELS.map((c) => ({
      id: c.id,
      label: c.label,
      requiresEnv: c.requiresEnv,
      configured: hasEnv(c.requiresEnv, env),
    })),
    { id: 'push', label: 'Browser Push', requiresEnv: PUSH_REQUIRES_ENV, configured: hasEnv(PUSH_REQUIRES_ENV, env) },
  ];
}

export function configuredChannels(env = process.env) {
  return CHANNELS.filter((c) => hasEnv(c.requiresEnv, env));
}

// notify({ title, text }): best-effort fan-out to every configured channel.
// Returns which channels were configured and which actually delivered.
export async function notify({ title, text }, env = process.env) {
  const chans = configuredChannels(env);
  const delivered = [];
  await Promise.all(
    chans.map(async (c) => {
      try {
        if (await c.send({ title, text }, env)) delivered.push(c.id);
      } catch (err) {
        console.error(`notify ${c.id} failed:`, err?.message || err);
      }
    })
  );
  return { channels: chans.map((c) => c.id), delivered };
}

// The educational framing every user-facing signal/brief must carry (CLAUDE.md
// guardrail #2) — the ONE canonical wording, shared by the operator digest below
// and the per-user alert bodies in alertDelivery.js, so a future wording change
// (e.g. after the SEBON legal review) only needs to happen in one place.
export const DISCLAIMER = 'Educational, not financial advice · past performance ≠ future results.';

// Build a scan digest message (pure — unit-tested). Doubles as the daily-brief
// delivery AND the partial/failed health alert.
export function formatScanDigest({ status, brief = {}, signals = 0, actionable = 0, failed = 0, skipped = 0 }) {
  const flag = status === 'partial' ? '⚠️ PARTIAL' : '✅';
  const title = `${flag} NEPSE scan — ${brief.headline || 'daily brief'}`;
  const lines = [];
  if (brief.summary) lines.push(brief.summary);
  if (Array.isArray(brief.topPicks) && brief.topPicks.length) lines.push(`Top picks: ${brief.topPicks.join(', ')}`);
  lines.push(`${signals} signal${signals === 1 ? '' : 's'} · ${actionable} actionable`);
  if (failed || skipped) lines.push(`⚠️ ${failed} failed, ${skipped} skipped this run`);
  lines.push(DISCLAIMER);
  return { title, text: lines.join('\n') };
}

// --- channels --------------------------------------------------------------
async function sendTelegram({ title, text }, env) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: (title ? `${title}\n` : '') + text,
      disable_web_page_preview: true,
    }),
  });
  return res.ok;
}

// deliverEmail({ to, subject, text }): send to a SPECIFIC recipient (per-user alert
// delivery — TIER-2). Config-gated exactly like the channels above: returns false and
// sends nothing without RESEND_API_KEY (or without a `to`). DISTINCT from notify()/
// sendEmail(), which fan out the global OPERATOR digest to ALERT_TO — this targets an
// individual user's address and must never be used for the operator digest. Best-effort:
// the caller wraps it; a Resend failure throws to the caller's try/catch.
export async function deliverEmail({ to, subject, text }, env = process.env) {
  if (!env.RESEND_API_KEY || !to) return false;
  const { Resend } = await import('resend');
  const resend = new Resend(env.RESEND_API_KEY);
  const from = env.ALERT_FROM || 'NEPSE Intelligence <alerts@resend.dev>';
  await resend.emails.send({ from, to, subject: subject || 'NEPSE Intelligence', text });
  return true;
}

// deliverTelegramDM({ chatId, text }): send to a SPECIFIC linked user's chat (per-
// user alert delivery — Phase G reach). Config-gated on TELEGRAM_BOT_TOKEN alone
// (no TELEGRAM_CHAT_ID — that's the operator's own chat, unrelated to a user's
// linked one). DISTINCT from sendTelegram()/notify(), which fan out the global
// OPERATOR digest — this targets one user's linked chat_id and must never be used
// for the operator digest. Returns false (never throws) on missing config/chatId
// or a non-2xx Telegram response, so a bad/unlinked chat_id degrades silently.
export async function deliverTelegramDM({ chatId, text }, env = process.env) {
  if (!env.TELEGRAM_BOT_TOKEN || !chatId) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// deliverPush({ subscription, title, text }, env): send ONE encrypted Web Push
// message (RFC 8291, via the `web-push` package) to a single browser subscription
// ({ endpoint, keys: { p256dh, auth } } — exactly PushManager.subscribe()'s shape).
// Config-gated on VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY (scripts/generate-vapid-
// keys.mjs); returns false without sending if either is unset or the subscription
// is malformed. THROWS on a send failure (mirrors sendNotification) — the caller
// (alertDelivery.js) catches it to distinguish an expired subscription (a
// WebPushError with statusCode 404/410 — prune it) from a transient failure (log
// and move on). Per-message, not a fan-out: the caller loops over a user's
// subscriptions, since one send failing must never block another device's.
export async function deliverPush({ subscription, title, text }, env = process.env) {
  if (!hasEnv(PUSH_REQUIRES_ENV, env)) return false;
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) return false;
  const webpush = (await import('web-push')).default;
  webpush.setVapidDetails(
    env.VAPID_SUBJECT || 'mailto:marketing@nepawholesale.com',
    env.VAPID_PUBLIC_KEY,
    env.VAPID_PRIVATE_KEY
  );
  await webpush.sendNotification(subscription, JSON.stringify({ title, body: text }));
  return true;
}

async function sendEmail({ title, text }, env) {
  if (!env.RESEND_API_KEY) return false;
  const { Resend } = await import('resend');
  const resend = new Resend(env.RESEND_API_KEY);
  const from = env.ALERT_FROM || 'NEPSE Intelligence <alerts@resend.dev>';
  const to = env.ALERT_TO || 'marketing@nepawholesale.com';
  await resend.emails.send({ from, to, subject: title || 'NEPSE Intelligence', text });
  return true;
}

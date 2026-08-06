// Config-gated notification channels.
//
// A channel is ACTIVE only when its required env is present — same pattern as the
// market-data providers. notify() fans out to every active channel, best-effort: a
// channel failure is logged and swallowed, never thrown into the scan flow (channels
// are a side-channel, like alerts/events). No env for a channel → it's simply off.
//
//   email    ← RESEND_API_KEY (+ optional ALERT_TO / ALERT_FROM)
//   telegram ← TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID

const CHANNELS = [
  { id: 'email', label: 'Email (Resend)', requiresEnv: ['RESEND_API_KEY'], send: sendEmail },
  { id: 'telegram', label: 'Telegram', requiresEnv: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'], send: sendTelegram },
];

function hasEnv(keys, env) {
  return keys.every((k) => !!(env[k] && String(env[k]).trim()));
}

// Metadata for the admin screen (no functions). `configured` drives the active/off
// display; channels can't be toggled in the UI — they're purely env-driven.
export function listChannels(env = process.env) {
  return CHANNELS.map((c) => ({
    id: c.id,
    label: c.label,
    requiresEnv: c.requiresEnv,
    configured: hasEnv(c.requiresEnv, env),
  }));
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
  lines.push('Educational, not financial advice.');
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

async function sendEmail({ title, text }, env) {
  if (!env.RESEND_API_KEY) return false;
  const { Resend } = await import('resend');
  const resend = new Resend(env.RESEND_API_KEY);
  const from = env.ALERT_FROM || 'NEPSE Intelligence <alerts@resend.dev>';
  const to = env.ALERT_TO || 'marketing@nepawholesale.com';
  await resend.emails.send({ from, to, subject: title || 'NEPSE Intelligence', text });
  return true;
}

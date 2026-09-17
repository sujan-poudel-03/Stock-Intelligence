// Per-user Telegram linking — Phase G of the redesign (closing the "no push/SMS/
// mobile alerts" gap; the Telegram channel toggle already existed in Settings but
// had no way to actually link a user's own chat — CLAUDE.md called this out as
// "still deferred"). Deliver-time send lives in notify.js (deliverTelegramDM);
// this file owns the link-code lifecycle.
//
// Flow: a signed-in user requests a code (issueLinkCode) and is shown a deep link
// `https://t.me/<bot>?start=<code>`. Opening it (or typing `/start <code>`
// manually) sends Telegram's webhook a message our bot receives at
// POST /api/telegram/webhook, which calls resolveLinkCode with the code +
// the sender's chat_id — the ONLY way to learn a chat_id, since Telegram never
// tells a bot who's messaging it beyond that chat_id.

import { telegramLinkReady } from './schemaFlags.js';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L — read aloud safely
const CODE_LENGTH = 6;
const CODE_TTL_MS = 15 * 60 * 1000;

// generateLinkCode(): a short, human-typeable code. Not cryptographically hardened
// (it's a short-lived, single-use pairing code, not a credential) — collisions are
// caught by the DB's unique-while-live index, not relied on to be unique here.
export function generateLinkCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

export function linkCodeExpiryIso(now = Date.now()) {
  return new Date(now + CODE_TTL_MS).toISOString();
}

// isLinkCodeExpired(expiresAtIso, now): true for a missing/unparseable/past expiry
// — fails closed (an ambiguous expiry is treated as expired, never as valid).
export function isLinkCodeExpired(expiresAtIso, now = Date.now()) {
  if (!expiresAtIso) return true;
  const t = Date.parse(expiresAtIso);
  return !Number.isFinite(t) || t < now;
}

// parseStartCommand(text): Telegram sends "/start" bare, or "/start <payload>" when
// opened via a deep link (?start=<payload>) or typed manually — case/whitespace-
// insensitive, optional "@botname" suffix (Telegram appends this in group chats).
// Returns the uppercased payload, or null when this isn't a /start-with-payload.
export function parseStartCommand(text) {
  if (typeof text !== 'string') return null;
  const m = text.trim().match(/^\/start(?:@\w+)?(?:\s+(\S+))?$/i);
  if (!m || !m[1]) return null;
  return m[1].trim().toUpperCase();
}

// issueLinkCode(supabase, userId): (re)issues this user's link code. `supabase` is
// the caller's owner-scoped client (RLS covers the rest). Returns { code, expiresAt }
// or null when the schema isn't migrated yet / the write failed.
export async function issueLinkCode(supabase, userId) {
  if (!supabase || !userId) return null;
  if (!(await telegramLinkReady())) return null;
  const code = generateLinkCode();
  const expiresAt = linkCodeExpiryIso();
  const { error } = await supabase.from('alert_prefs').upsert(
    { user_id: userId, telegram_link_code: code, telegram_link_code_expires_at: expiresAt, updated_at: new Date().toISOString() },
    { onConflict: 'user_id' }
  );
  if (error) return null;
  return { code, expiresAt };
}

// resolveLinkCode(supabase, code, chatId): called from the Telegram webhook, which
// has NO user identity beyond the code itself — `supabase` MUST be the service
// client. Finds the user whose live code matches, stores their chat_id, and clears
// the code (single-use). Never throws (a webhook handler must always ack 200).
export async function resolveLinkCode(supabase, code, chatId) {
  try {
    if (!supabase || !code || !chatId) return false;
    if (!(await telegramLinkReady())) return false;
    const { data, error } = await supabase
      .from('alert_prefs')
      .select('user_id, telegram_link_code_expires_at')
      .eq('telegram_link_code', code)
      .maybeSingle();
    if (error || !data) return false;
    if (isLinkCodeExpired(data.telegram_link_code_expires_at)) return false;
    const { error: updErr } = await supabase
      .from('alert_prefs')
      .update({ telegram_chat_id: String(chatId), telegram_link_code: null, telegram_link_code_expires_at: null, updated_at: new Date().toISOString() })
      .eq('user_id', data.user_id);
    return !updErr;
  } catch {
    return false;
  }
}

// unlinkTelegram(supabase, userId): clears a user's linked chat (owner-scoped client).
export async function unlinkTelegram(supabase, userId) {
  try {
    if (!supabase || !userId) return false;
    if (!(await telegramLinkReady())) return false;
    const { error } = await supabase.from('alert_prefs').update({ telegram_chat_id: null }).eq('user_id', userId);
    return !error;
  } catch {
    return false;
  }
}

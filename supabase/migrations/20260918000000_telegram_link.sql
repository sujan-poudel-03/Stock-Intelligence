-- PER-USER TELEGRAM LINKING — closes the "no push/SMS/mobile alerts" gap (the
-- Telegram channel toggle already existed in Settings → My Alerts and in
-- alert_prefs.channels, but had no way to actually link a user's own chat — see
-- CLAUDE.md "per-user Telegram is still deferred"). Additive + idempotent.
--
-- Flow: the user requests a link code (POST /api/alerts/telegram/link), opens
-- Telegram and sends /start <code> to the bot; the bot's webhook
-- (POST /api/telegram/webhook) resolves the code to this user and stores their
-- chat_id. Alert delivery (src/lib/alertDelivery.js) then DMs that chat_id
-- directly instead of the operator's single TELEGRAM_CHAT_ID.
--
-- Until this migration is applied, every read/write of these columns is gated
-- behind a schema-flag probe (src/lib/schemaFlags.js telegramLinkReady) so an
-- unmigrated DB behaves byte-for-byte as today (Telegram toggle exists but never
-- actually links or delivers per-user).

alter table alert_prefs add column if not exists telegram_chat_id text;
alter table alert_prefs add column if not exists telegram_link_code text;
alter table alert_prefs add column if not exists telegram_link_code_expires_at timestamptz;

-- A link code must be unique while live (the webhook looks a user up BY code,
-- with no user_id to scope by — Telegram doesn't tell us who's typing beyond
-- their chat_id, which is exactly what we're trying to learn).
create unique index if not exists alert_prefs_telegram_link_code_uidx
  on alert_prefs (telegram_link_code)
  where telegram_link_code is not null;

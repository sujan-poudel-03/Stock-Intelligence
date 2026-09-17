-- BROWSER PUSH SUBSCRIPTIONS — the capture/storage half of Web Push (Phase G
-- reach). Additive + idempotent, mirrors paper_positions' per-user/owner-only
-- pattern (20260810000000_paper_trading.sql).
--
-- SCOPE: this migration + its API routes/service-worker plumbing capture and
-- store a browser's push subscription. Actually SENDING an encrypted push
-- (RFC 8291: ECDH + HKDF + AES-128-GCM) is a deliberately separate, deferred
-- step — see src/lib/notify.js and the redesign discussion. Until that ships,
-- a stored subscription here is inert (nothing reads this table to send yet).
--
-- One row per (user, device/browser) — a user can have several subscriptions
-- (phone + laptop). endpoint is unique: PushManager gives a stable per-
-- installation endpoint, and re-subscribing (e.g. after a permission reset)
-- naturally upserts the same row rather than accumulating dead duplicates.
--
-- Until this migration is applied, every read/write is gated behind a schema-
-- flag probe (src/lib/schemaFlags.js pushSubscriptionsReady) so an unmigrated DB
-- is byte-for-byte as today (the Settings push toggle reports enabled:false).

create table if not exists push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth_key   text not null, -- the subscription's own "auth" secret (not our VAPID key)
  created_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user_idx on push_subscriptions (user_id);

alter table push_subscriptions enable row level security;
drop policy if exists own_all_push_subscriptions on push_subscriptions;
create policy own_all_push_subscriptions on push_subscriptions for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

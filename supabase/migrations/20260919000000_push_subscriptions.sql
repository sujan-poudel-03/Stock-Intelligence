-- BROWSER PUSH SUBSCRIPTIONS — the storage half of Web Push (Phase G reach).
-- Additive + idempotent, mirrors paper_positions' per-user/owner-only pattern
-- (20260810000000_paper_trading.sql).
--
-- SCOPE: this migration stores a browser's push subscription. Actually SENDING
-- an encrypted push (RFC 8291: ECDH + HKDF + AES-128-GCM, via the `web-push`
-- package) is wired in src/lib/notify.js's deliverPush(), used by
-- alertDelivery.js whenever a user's "push" alert channel is on — see
-- docs/OWNER-RUNBOOK.md §4c for the VAPID env vars that activate it.
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

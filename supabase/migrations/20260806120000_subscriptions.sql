-- Billing/tier EXTENSION POINT (not billing itself). A per-user subscription row
-- whose `tier` drives feature entitlements (see src/lib/entitlements.js). Free +
-- OAuth-gated today; adding a paid tier later = a billing webhook that flips `tier`,
-- no re-architecture. Additive + safe.
--
-- RLS: a user may READ their own tier (so the UI can reflect it); only the SERVICE
-- role writes tiers (admin action / future billing webhook) — a user can NOT
-- self-upgrade. No insert/update/delete policy => owner+anon cannot write.
create table if not exists subscriptions (
  user_id            uuid primary key references auth.users(id) on delete cascade,
  tier               text not null default 'free',   -- 'free' | 'pro' | ... (see TIERS)
  status             text not null default 'active',  -- 'active' | 'past_due' | 'canceled'
  provider           text,                            -- 'esewa' | 'khalti' | 'stripe' | null
  current_period_end timestamptz,
  updated_at         timestamptz not null default now()
);

alter table subscriptions enable row level security;
drop policy if exists own_read_subscriptions on subscriptions;
create policy own_read_subscriptions on subscriptions for select using (auth.uid() = user_id);
-- (no write policy -> service role only, which bypasses RLS)

-- Phase 2 step 3 — per-user tables (the thin per-user layer). ADDITIVE + safe:
-- no RLS here (RLS is a later, coordinated step), no changes to shared/global
-- tables, and `user_id` lives ONLY on these new tables. See
-- docs/PHASE2-MULTITENANT.md for the full rollout + policy design.
--
-- Idempotent (create table if not exists) so re-running is harmless.

-- 1. Watchlists — the symbols a user tracks, per exchange. The UNION of all rows
--    feeds the global scan universe (a symbol on 10 watchlists is scanned once).
create table if not exists watchlists (
  user_id     uuid not null references auth.users(id) on delete cascade,
  exchange    text not null default 'NEPSE',
  symbol      text not null,
  added_at    timestamptz not null default now(),
  reason      text,
  last_signal text,
  primary key (user_id, exchange, symbol)
);
create index if not exists watchlists_user_idx on watchlists (user_id);

-- 2. Per-user settings — default exchange, sector focus (view), theme, etc.
create table if not exists user_settings (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  prefs      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- 3. Portfolios — positions the user tracks (invested / break-even / P&L are
--    computed in the UI from these rows).
create table if not exists portfolios (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  exchange   text not null default 'NEPSE',
  symbol     text not null,
  qty        numeric,
  buy_price  numeric,
  stop_loss  numeric,
  target     numeric,
  status     text not null default 'open',   -- 'open' | 'closed'
  opened_at  timestamptz not null default now(),
  closed_at  timestamptz,
  sell_price numeric
);
create index if not exists portfolios_user_idx on portfolios (user_id, status);

-- 4. Alert preferences — which channels + thresholds notify this user.
create table if not exists alert_prefs (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  channels   jsonb not null default '{}'::jsonb,
  thresholds jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

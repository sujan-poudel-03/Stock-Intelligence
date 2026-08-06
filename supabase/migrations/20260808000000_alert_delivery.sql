-- TIER-2 — per-user alert DELIVERY ledgers (email notifications for watched-symbol
-- signal flips + per-user outcome alerts). Additive + idempotent — safe to re-run.
-- Mirrors 20260805130000_rls_on.sql for the RLS SHAPE: owner-only SELECT, NO write
-- policy (only the service role, which bypasses RLS, writes — the cron/scan path).
--
-- These are per-user side-channel ledgers recording WHAT we've already told each user,
-- so we don't spam: idempotent re-runs, and a FIRST observation of a standing signal
-- seeds the cursor silently instead of bursting a "new BUY" for every pre-existing
-- signal. Written ONLY by the cron/service role; a user may READ their own rows.
--
-- Until this migration is applied, every read/write is gated behind schema-flag probes
-- (src/lib/schemaFlags.js) so an unmigrated DB behaves byte-for-byte as today — no
-- delivery attempted, the brief/outcome flow unchanged.

-- ---- 1. alert_deliveries — per-(user, exchange, symbol) direction CURSOR ---------
-- Advances every scan; an alert event fires only when the direction CHANGES from the
-- direction we last recorded (a real observed flip), never on first observation.
create table if not exists alert_deliveries (
  user_id        uuid not null references auth.users(id) on delete cascade,
  exchange       text not null default 'NEPSE',
  symbol         text not null,
  last_direction text,
  last_signal_id uuid,
  last_scan_id   uuid,
  sent_at        timestamptz,
  updated_at     timestamptz not null default now(),
  primary key (user_id, exchange, symbol)
);
create index if not exists alert_deliveries_user_idx on alert_deliveries (user_id);

-- ---- 2. outcome_deliveries — one-shot (user, signal) ledger ----------------------
-- Records that we've already emailed a user the TARGET_HIT/SL_BREACH for a signal,
-- so a re-run of outcome resolution never re-notifies.
create table if not exists outcome_deliveries (
  user_id   uuid not null references auth.users(id) on delete cascade,
  signal_id uuid not null,
  sent_at   timestamptz,
  primary key (user_id, signal_id)
);
create index if not exists outcome_deliveries_user_idx on outcome_deliveries (user_id);

-- ---- 3. RLS: owner-only READ, service-only WRITE (mirrors 20260805130000_rls_on) --
alter table alert_deliveries   enable row level security;
alter table outcome_deliveries enable row level security;

drop policy if exists own_read_alert_deliveries   on alert_deliveries;
drop policy if exists own_read_outcome_deliveries on outcome_deliveries;

create policy own_read_alert_deliveries   on alert_deliveries   for select using (auth.uid() = user_id);
create policy own_read_outcome_deliveries on outcome_deliveries for select using (auth.uid() = user_id);
-- (no write policy => only the service role, which bypasses RLS, can write)

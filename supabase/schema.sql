-- NEPSE Intelligence V2 — database schema
-- Run this against your Supabase Postgres instance.
-- All application writes use upsert (insert ... on conflict) semantics.

create extension if not exists "pgcrypto";

-- 1. kv_store — storage abstraction, replaces window.storage from V1
create table if not exists kv_store (
  key        text primary key,
  value      jsonb,
  updated_at timestamptz default now()
);

-- 2. signals — generated trade signals + tracked outcome
create table if not exists signals (
  id          uuid primary key default gen_random_uuid(),
  scan_id     uuid,
  symbol      text,
  signal      text,
  confidence  text,
  price       numeric,
  entry       text,
  sl          numeric,
  target      numeric,
  hold        text,
  why         text,
  risk        text,
  action      text,
  source      text,
  sector      text,
  live_data   jsonb,
  outcome     text default 'PENDING',
  exit_price  numeric,
  outcome_at  timestamptz,
  return_pct  numeric,
  created_at  timestamptz default now()
);

create index if not exists signals_scan_id_idx   on signals (scan_id);
create index if not exists signals_symbol_idx     on signals (symbol);
create index if not exists signals_outcome_idx     on signals (outcome);
create index if not exists signals_created_at_idx on signals (created_at desc);

-- 3. scans — one row per scan run (referred to as "scan_runs" in route docs)
create table if not exists scans (
  id             uuid primary key default gen_random_uuid(),
  status         text,
  phase          text,
  current_symbol text,
  total          int,
  completed      int,
  failed         int,
  signals        jsonb,
  market         jsonb,
  brief          jsonb,
  started_at     timestamptz default now(),
  completed_at   timestamptz,
  error          text
);

create index if not exists scans_status_idx     on scans (status);
create index if not exists scans_started_at_idx on scans (started_at desc);

-- 4. scan_jobs — one row per symbol queued in a scan
create table if not exists scan_jobs (
  id           uuid primary key default gen_random_uuid(),
  scan_id      uuid,
  symbol       text,
  status       text,
  attempt      int default 0,
  result       jsonb,
  error        text,
  created_at   timestamptz default now(),
  started_at   timestamptz,
  completed_at timestamptz
);

create index if not exists scan_jobs_scan_id_idx on scan_jobs (scan_id);
create index if not exists scan_jobs_status_idx  on scan_jobs (status);

-- 5. weights — calibration learning per key (e.g. BUY_banks)
-- wins/losses/rate/avg_return are lifetime; dwins/dlosses are EWMA time-decayed
-- counts (recent-regime, non-stationarity) with last_outcome_at as the decay clock.
create table if not exists weights (
  id              uuid primary key default gen_random_uuid(),
  key             text unique,
  wins            int default 0,
  losses          int default 0,
  rate            numeric default 0,
  avg_return      numeric default 0,
  dwins           numeric default 0,
  dlosses         numeric default 0,
  last_outcome_at timestamptz,
  updated_at      timestamptz default now()
);

-- 6. outcomes — resolved trade outcomes log
create table if not exists outcomes (
  id          uuid primary key default gen_random_uuid(),
  signal_id   uuid,
  symbol      text,
  outcome     text,
  entry_price numeric,
  exit_price  numeric,
  return_pct  numeric,
  hold_days   int,
  created_at  timestamptz default now()
);

create index if not exists outcomes_signal_id_idx on outcomes (signal_id);
create index if not exists outcomes_symbol_idx    on outcomes (symbol);

-- 7. alerts — emitted price alerts (SL breach / target hit)
create table if not exists alerts (
  id         uuid primary key default gen_random_uuid(),
  symbol     text,
  type       text,
  price      numeric,
  level      numeric,
  message    text,
  sent_at    timestamptz,
  created_at timestamptz default now()
);

create index if not exists alerts_symbol_idx     on alerts (symbol);
create index if not exists alerts_created_at_idx on alerts (created_at desc);

-- 8. events — durable activity history (scan progress, signals, promotions, outcomes)
create table if not exists events (
  id         uuid primary key default gen_random_uuid(),
  scan_id    uuid,
  type       text,
  symbol     text,
  message    text,
  data       jsonb,
  created_at timestamptz default now()
);

create index if not exists events_created_at_idx on events (created_at desc);
create index if not exists events_scan_id_idx    on events (scan_id);

-- 9. knowledge — qualitative knowledge base the agent reads + reinforces.
-- Complements the statistical `weights` table: per-symbol/sector lessons accrued
-- from resolved outcomes, plus learned concepts/KPIs (Phase 3 discovery).
create table if not exists knowledge (
  id         uuid primary key default gen_random_uuid(),
  kind       text,            -- 'symbol_note' | 'sector_note' | 'concept' | 'kpi'
  key        text unique,     -- e.g. 'SYMBOL_NOTE:NABIL', 'SECTOR_NOTE:hydropower', 'KPI:RSI'
  content    text,
  source     text,
  confidence numeric default 0.5,
  refs       jsonb,
  version    int default 1,
  updated_at timestamptz default now()
);

create index if not exists knowledge_kind_idx on knowledge (kind);

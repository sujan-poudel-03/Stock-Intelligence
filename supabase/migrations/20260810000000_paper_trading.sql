-- PAPER TRADING — a risk-free SIMULATED account (Beginner flagship, TIER-1 §4.1).
-- Additive + idempotent — safe to re-run; mirrors 20260809000000_system_watchlist.sql style.
--
-- WHY: the #1 beginner ask is a way to practice buy/sell with NO real money, no broker,
-- and no execution/legal exposure. A simulated "buy"/"sell" fills at the VERIFIED live
-- price (ground truth — never LLM-sourced) and tracks virtual cash + positions + P&L
-- through the SAME net-of-charges engine as real portfolios (charges.js / portfolioMath).
--
-- WRITE-ISOLATION: this is a SEPARATE pair of per-user tables, NOT a flag on `portfolios`.
-- Nothing in the scan chain / track-record / weights / knowledge ever reads these tables —
-- the simulation is a pure per-user sandbox. Prices remain global ground truth; only the
-- virtual cash/position bookkeeping lives here.
--
-- OWNER-ONLY (RLS): each row is scoped to auth.uid() = user_id, mirroring the per-user
-- policies in 20260805130000_rls_on.sql (watchlists/portfolios/...). Reached only via the
-- per-user client (getUserSupabase(token)) + an explicit .eq('user_id', id) filter.
--
-- Until this migration is applied, every read/write is gated behind a schema-flag probe
-- (src/lib/schemaFlags.js paperTradingReady) so an unmigrated DB behaves byte-for-byte as
-- today (the Paper tab reports enabled:false; no paper routes touch these tables).

-- ---- 1. Virtual cash account (one per user) --------------------------------
-- STARTING_CASH is NPR 1,000,000 (set by the app on first order, not defaulted here, so
-- the single source of truth stays STARTING_CASH in src/lib/paperTrade.js).
create table if not exists paper_accounts (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  cash          numeric not null,
  starting_cash numeric not null,
  currency      text not null default 'NPR',
  created_at    timestamptz not null default now(),
  reset_at      timestamptz
);

-- ---- 2. Simulated positions (whole-share, long-only, NEPSE) ----------------
-- buy_price is the qty-weighted average of FILL PRICES ONLY (WACC; charges are NOT folded
-- in — positionPnl recomputes the buy leg's charges). opened_at is the FIRST buy and is
-- never reset by later adds. status: 'open' | 'closed' (closed at qty 0).
create table if not exists paper_positions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  exchange   text not null default 'NEPSE',
  symbol     text not null,
  qty        numeric not null,
  buy_price  numeric not null,
  stop_loss  numeric,
  target     numeric,
  status     text not null default 'open',
  opened_at  timestamptz not null default now(),
  closed_at  timestamptz,
  sell_price numeric
);

create index if not exists paper_positions_user_idx on paper_positions (user_id, status);

-- ---- 3. RLS: OWNER-ONLY (mirrors the per-user policies in 20260805130000_rls_on.sql) ---
alter table paper_accounts  enable row level security;
alter table paper_positions enable row level security;

drop policy if exists own_all_paper_accounts  on paper_accounts;
drop policy if exists own_all_paper_positions on paper_positions;

create policy own_all_paper_accounts  on paper_accounts  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy own_all_paper_positions on paper_positions for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

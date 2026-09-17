-- PRICE HISTORY — daily close/high/low/volume per symbol, the foundation for real
-- price charts (redesign Phase A). Additive + idempotent, mirrors
-- 20260809000000_system_watchlist.sql's pattern.
--
-- WHY: the app had no time-series price data anywhere — signals.live_data is a
-- single point-in-time snapshot, not a series, so there was nothing to chart. This
-- table accumulates ONE VERIFIED ROW PER (symbol, exchange, day), fed by the same
-- getVerifiedPrice() the scan chain already calls — never LLM-sourced, same
-- ground-truth guarantee as signals/scans. It starts EMPTY and builds forward from
-- whenever this migration + the write-path ship — no backfill is fabricated.
--
-- Deliberately NO "open" column: the verified-price layer's `range` metadata
-- (src/lib/marketData.js pickRange) only ever carries a consistency-checked
-- high/low for the day, never an open — so charts render as a close/high-low line,
-- not a candlestick, rather than inventing an open price no source actually gives.
--
-- GLOBAL market data (like scans/signals/system_watchlist): NO user_id,
-- public-read + service-role write.
--
-- Until this migration is applied, every read/write is gated behind a schema-flag
-- probe (src/lib/schemaFlags.js priceHistoryReady) so an unmigrated DB behaves
-- byte-for-byte as today (no chart data recorded or served, chart UI shows an
-- honest "not enough history yet" state instead of erroring).

create table if not exists price_history (
  symbol     text not null,
  exchange   text not null default 'NEPSE',
  date       date not null default current_date,
  close      numeric not null,
  high       numeric,
  low        numeric,
  volume     numeric,
  turnover   numeric,
  stale      boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (symbol, exchange, date)
);

create index if not exists price_history_lookup_idx
  on price_history (exchange, symbol, date desc);

-- RLS: public read, service-only write (mirrors system_watchlist / corporate_actions).
alter table price_history enable row level security;
drop policy if exists public_read_price_history on price_history;
create policy public_read_price_history on price_history for select using (true);
-- (no write policy => only the service role, which bypasses RLS, can write)

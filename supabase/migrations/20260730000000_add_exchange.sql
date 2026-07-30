-- Multi-exchange dimension (NYSE alongside NEPSE). Additive + idempotent — safe to
-- re-run. Pre-migration rows have no exchange, so the column defaults to 'NEPSE'
-- and the read side coalesces null → NEPSE (backward-compatible).
--
-- scan_jobs needs NO column — the worker reads scans.exchange for its run.
-- weights/knowledge are scoped by KEY (see scopeKey in src/lib/exchanges.js), not a
-- column, so those tables are intentionally left unchanged (NEPSE keys stay unprefixed).

alter table scans   add column if not exists exchange text default 'NEPSE';
alter table signals add column if not exists exchange text default 'NEPSE';

create index if not exists signals_exchange_idx on signals (exchange);
create index if not exists scans_exchange_idx   on scans (exchange);

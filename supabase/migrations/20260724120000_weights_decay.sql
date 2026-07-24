-- Time-decay columns for calibration (Roadmap P1.5-3b).
-- Persists EWMA-decayed win/loss counts so a slice tracks the RECENT regime
-- (non-stationarity), alongside the lifetime wins/losses. Additive + idempotent —
-- safe to re-run. Calibration writes these best-effort, so it keeps working
-- whether or not this migration has been applied yet.

alter table weights add column if not exists dwins           numeric     default 0;
alter table weights add column if not exists dlosses         numeric     default 0;
alter table weights add column if not exists last_outcome_at timestamptz;

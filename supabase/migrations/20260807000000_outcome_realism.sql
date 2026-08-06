-- TIER-1 #3 — realistic outcome resolution (path-dependent WIN/LOSS, time-stop, net-of-charges).
-- Additive + idempotent — safe to re-run; mirrors 20260806130000_corporate_actions.sql.
--
-- WHY: the spot-only resolver understated reality three ways. (1) It only ever saw a
-- single day's spot, so an intraday TARGET or STOP touch between runs was missed → the
-- track record was blind to the real first-touch outcome. (2) A signal that neither hit
-- target nor stop sat PENDING forever with no time-stop. (3) Returns were GROSS, ignoring
-- NEPSE's real broker/SEBON/DP/CGT drag, overstating the headline. This migration adds the
-- columns that let the resolver record path-dependent WIN/LOSS via accumulated daily
-- high/low extremes, an EXPIRE terminal outcome at a hold horizon, and a net-of-charges
-- return alongside the gross one.
--
-- Prices AND daily high/low are GROUND TRUTH — never LLM-sourced (a wrong extreme is a
-- phantom WIN/LOSS = financial harm). They ride the same verified-price layer as spot.
--
-- Until this migration is applied, every new column read/write is gated behind
-- outcomeRealismColumnsReady() (src/lib/schemaFlags.js), so an UNMIGRATED DB behaves
-- BYTE-FOR-BYTE as today (spot-only resolution, gross-only return, no EXPIRE). No RLS
-- change: these are columns on existing shared tables, whose policies already apply.

-- ---- 1. Signal outcome-realism columns -------------------------------------
-- peak_high / trough_low: accumulated daily extremes (the missed-day path), updated each
--   run from the verified day range so a cross-day TARGET/STOP touch is not lost.
-- net_return_pct: return after NEPSE charges (broker/SEBON/DP/CGT) — the track-record
--   headline; gross return_pct is shown alongside.
-- max_hold_days: the stamped time-stop horizon (calendar days) for the EXPIRE path; the
--   resolver falls back to parsing signals.hold when this is null.
-- exit_reason: TARGET | STOP | EXPIRE — why the signal terminated.
alter table signals add column if not exists peak_high      numeric;
alter table signals add column if not exists trough_low     numeric;
alter table signals add column if not exists net_return_pct numeric;
alter table signals add column if not exists max_hold_days  integer;
alter table signals add column if not exists exit_reason    text;

-- ---- 2. Outcome-log columns (mirror the signal-row fields) ------------------
alter table outcomes add column if not exists net_return_pct numeric;
alter table outcomes add column if not exists exit_reason    text;

-- NOTE: outcome='EXPIRE' (time-stop terminal outcome) needs NO schema change —
-- `outcome` is a free-text column (same as 'VOID').

-- ============================================================================
-- Phase 2 STEP 7 — RLS ON
-- ============================================================================
-- The cron/scan WRITE path already uses the service-role client (step 2), which
-- BYPASSES RLS — so these policies do not stop the pipeline from writing. Public
-- reads (signals/track-record) stay open. Per-user tables become owner-only.
-- All statements idempotent-ish (drop policy if exists before create).
-- Rollback: `alter table <t> disable row level security;`
-- ============================================================================

-- ---- 1. Per-user tables: OWNER-ONLY (auth.uid() = user_id) ------------------
alter table watchlists    enable row level security;
alter table user_settings enable row level security;
alter table portfolios    enable row level security;
alter table alert_prefs   enable row level security;

drop policy if exists own_all_watchlists on watchlists;
drop policy if exists own_all_user_settings on user_settings;
drop policy if exists own_all_portfolios on portfolios;
drop policy if exists own_all_alert_prefs on alert_prefs;

create policy own_all_watchlists    on watchlists    for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy own_all_user_settings on user_settings for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy own_all_portfolios    on portfolios    for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy own_all_alert_prefs   on alert_prefs   for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---- 2. Shared/global tables: PUBLIC READ, service-only WRITE ---------------
-- No write policy => only the service role (bypasses RLS) can write, i.e. the cron.
alter table signals   enable row level security;
alter table scans     enable row level security;
alter table scan_jobs enable row level security;
alter table weights   enable row level security;
alter table knowledge enable row level security;
alter table outcomes  enable row level security;
alter table events    enable row level security;
alter table alerts    enable row level security;

drop policy if exists public_read_signals   on signals;
drop policy if exists public_read_scans     on scans;
drop policy if exists public_read_scan_jobs on scan_jobs;
drop policy if exists public_read_weights   on weights;
drop policy if exists public_read_knowledge on knowledge;
drop policy if exists public_read_outcomes  on outcomes;
drop policy if exists public_read_events    on events;
drop policy if exists public_read_alerts    on alerts;

create policy public_read_signals   on signals   for select using (true);
create policy public_read_scans     on scans     for select using (true);
create policy public_read_scan_jobs on scan_jobs for select using (true);
create policy public_read_weights   on weights   for select using (true);
create policy public_read_knowledge on knowledge for select using (true);
create policy public_read_outcomes  on outcomes  for select using (true);
create policy public_read_events    on events    for select using (true);
create policy public_read_alerts    on alerts    for select using (true);

-- ---- 3. kv_store: anyone may READ, only the service role WRITES -------------
-- kv_store holds only NON-sensitive global state (daily brief, market snapshot,
-- discovery config, per-day quota/usage COUNTS, stock cache) — several routes read
-- it with the anon client server-side, so a read policy of `using (true)` avoids
-- breaking them. The real risk was anon WRITES (overwriting the brief every user
-- reads): no write policy => only the service role writes.
alter table kv_store enable row level security;
drop policy if exists kv_public_read on kv_store;
create policy kv_public_read on kv_store for select using (true);

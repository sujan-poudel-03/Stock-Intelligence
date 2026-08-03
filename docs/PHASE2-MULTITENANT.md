# Phase 2 — Free, OAuth-gated Multi-Tenancy (design draft)

**Status:** DRAFT — not applied. Reviewable schema + rollout for turning the
single-operator app into a safe, free, multi-user product. **Billing is explicitly
out of scope** for this phase (no `subscriptions` table, no payment gateway) — the
product is free, gated by Google sign-in.

**Before any of this is applied:** a `SUPABASE_SERVICE_ROLE_KEY` must be set
(server-only, in Vercel). Turning RLS on without it silently breaks the scan
pipeline (the cron can no longer write). See rollout order below.

---

## Principles (unchanged from CLAUDE.md)

- **Market data stays GLOBAL.** `signals`, `scans`, `scan_jobs`, `weights`,
  `knowledge`, `outcomes`, and all prices are shared — computed once per scan. They
  get **no `user_id`**. A user's view is a *filter* over shared signals.
- **`user_id` is added ONLY to new per-user tables.**
- **A user's brief/watchlist is a filter, never a re-fetch.** The scan universe is
  the *union* of all watchlists + discovery; a symbol watched by 10 users is scanned
  once.
- **Login is identity-only** — signing in never triggers a scan or a data fetch.

---

## Per-user tables (the entire new data surface)

All four are low-sensitivity — watchlist / positions / preferences / alert routing.
No passwords (Google handles auth), no payment data (not in this phase).

```sql
-- 1. Watchlists — the symbols a user tracks, per exchange.
create table watchlists (
  user_id      uuid not null references auth.users(id) on delete cascade,
  exchange     text not null default 'NEPSE',
  symbol       text not null,
  added_at     timestamptz not null default now(),
  reason       text,               -- e.g. "auto: HOLD in 3/5 scans" or "manual"
  last_signal  text,               -- cached latest signal for quick UI state
  primary key (user_id, exchange, symbol)
);

-- 2. Per-user settings — default exchange, sector focus, discovery prefs, theme.
create table user_settings (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  prefs       jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

-- 3. Portfolios — positions the user is tracking (drives invested / break-even /
--    P&L, all computed in the UI from these rows).
create table portfolios (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  exchange    text not null default 'NEPSE',
  symbol      text not null,
  qty         numeric,
  buy_price   numeric,
  stop_loss   numeric,
  target      numeric,
  status      text not null default 'open',   -- 'open' | 'closed'
  opened_at   timestamptz not null default now(),
  closed_at   timestamptz,
  sell_price  numeric
);
create index portfolios_user_idx on portfolios (user_id, status);

-- 4. Alert preferences — which channels + thresholds notify this user.
create table alert_prefs (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  channels    jsonb not null default '{}'::jsonb,   -- {email:true, telegram:false}
  thresholds  jsonb not null default '{}'::jsonb,   -- {onBuy:true, onSell:true, ...}
  updated_at  timestamptz not null default now()
);
```

> Identity (email, name, Google id) is **not** stored here — Supabase Auth manages
> it in `auth.users`; we only reference `user_id`.

> **Deferred to a later phase:** `subscriptions (user_id, tier, status, provider,
> current_period_end)` — added only when billing is introduced.

---

## RLS policies

```sql
-- ---- Per-user tables: owner-only, enforced at the DB ----
alter table watchlists    enable row level security;
alter table user_settings enable row level security;
alter table portfolios    enable row level security;
alter table alert_prefs   enable row level security;

-- Same shape on each (example for watchlists):
create policy own_select on watchlists for select using (auth.uid() = user_id);
create policy own_insert on watchlists for insert with check (auth.uid() = user_id);
create policy own_update on watchlists for update using (auth.uid() = user_id);
create policy own_delete on watchlists for delete using (auth.uid() = user_id);
-- (repeat for user_settings / portfolios / alert_prefs)

-- ---- Shared tables: readable by anyone, writable only by the cron (service role) ----
-- Service role bypasses RLS, so NO write policy is needed — the absence of an
-- insert/update policy means anon/authenticated cannot write, only read.
alter table signals   enable row level security;
alter table scans     enable row level security;
alter table weights   enable row level security;
alter table knowledge enable row level security;
alter table outcomes  enable row level security;
-- Public marketing surface (track record) must stay viewable → allow anon read:
create policy public_read on signals for select using (true);
create policy public_read on scans   for select using (true);
-- (repeat read-only policy for weights/knowledge/outcomes as the UI needs)
```

**Two failure modes this ordering avoids:**
- *Leak* — a permissive per-user policy, or serving per-user data via the service
  client without a `user_id` filter → users see each other's data. Mitigation:
  per-user tables read **only** through the user-scoped client with `auth.uid()`.
- *Silent lockout* — RLS on before the cron uses the service role → every scan write
  hits 0 rows with no error, product goes stale invisibly. Mitigation: strict order
  below; the dev full-chain run **after** RLS-on is the mandatory gate (a green build
  won't catch it).

---

## Client split (`src/lib/supabase.js`)

| Client | Key | Used by | RLS |
|---|---|---|---|
| `getSupabase()` (exists) | anon | public reads (signals, track record) | obeys |
| `getServiceSupabase()` (new) | `SUPABASE_SERVICE_ROLE_KEY` | cron/scan/worker/brief/outcomes writes | bypasses |
| `getUserSupabase(token)` (new) | caller's JWT | per-user routes (watchlist/portfolio/settings) | owner-only |

---

## Rollout order (each step verified before the next)

1. Split the Supabase client (additive, no behavior change with RLS off).
2. Move shared-table **writes** to `getServiceSupabase()` — verify via dev full-chain
   run that scans still complete.
3. Create the four per-user tables (migration above) + add to `EXPECTED_TABLES`.
4. `loadWatchlist()` in `cron/scan` → union `select distinct symbol from watchlists`.
5. New identity-scoped routes (`/api/watchlist|portfolio|settings`); retire the
   global `/api/storage`. Wire `NepseApp.jsx` + chat/brief portfolio reads to them.
6. Migrate the existing global `kv_store` watchlist/portfolio → the operator account.
7. **Turn RLS on** (per-user + shared policies above). Verify with the dev full-chain
   run **with RLS on** — this is the step that catches the silent-lockout.
8. Per-user chat quota (so one user can't drain the shared LLM budget).

**Verification at each step:** `npm test` · `npm run lint` · `npm run build` ·
`npm run doctor` (after 3 & 7) · `curl /api/scan/dev-run` (after 2 & 7 — the only
check that catches RLS lockout; `build` cannot).

---

## One open sub-decision

**Anonymous viewing:** keep the public track record + shared signals viewable to
logged-out visitors (recommended — it's the marketing funnel), with only per-user
features (save watchlist/portfolio/alerts) behind Google sign-in. The alternative is
a hard login wall (`NEXT_PUBLIC_REQUIRE_LOGIN=true`), which hides the marketing
surface. Default: **public viewing on, per-user features gated.**

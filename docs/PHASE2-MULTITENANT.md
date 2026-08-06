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

> **Per-user alert DELIVERY (TIER-2) is LIVE via email.** `alert_prefs`
> (channels/thresholds) now drives real notifications: a watched symbol flipping to
> BUY/SELL emails the watcher, and a resolved TARGET_HIT/SL_BREACH emails watchers of
> that symbol — a FILTER over the shared signals, never a re-scan. Backed by two new
> owner-read / service-write ledgers, `alert_deliveries` (per-(user,exchange,symbol)
> direction cursor; first observation seeds SILENTLY so standing signals don't burst)
> and `outcome_deliveries` (one-shot per-(user,signal)). See `src/lib/alertDelivery.js`;
> config-gated on `RESEND_API_KEY`, schema-flag-gated on the two tables. **Per-user
> Telegram is still deferred** — it needs a stored `telegram_chat_id` and a bot `/start`
> linking flow (email needs no such handshake).

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

## Access scopes — FOUR tiers (authoritative gating spec)

**DECIDED (owner, 2026-08-05): Option A — segregate public vs gated.** Public viewing
stays on (marketing funnel); actions require login. Not a hard wall.

A **scan is a global SYSTEM job**, not a user or (in-app) admin action — it's
triggered only by the scheduler via `CRON_SECRET` and serves everyone (one scan →
shared signals). Admins can *request* a manual scan from the UI, which is proxied
server-side through the admin gate; they never hold the cron secret.

| Surface / Action | Scope | Enforcement | Endpoint |
|---|---|---|---|
| View Today / signals / brief | **Public**¹ | anon read + RLS public-read | `/api/signals` |
| View Track Record | **Public**¹ | anon read | `/api/track-record` |
| View stock detail overlay | **Public**¹ | anon + shared cache | `/api/stock` |
| Switch exchange (view) | **Public**¹ | client + `/api/exchanges` | `/api/exchanges` |
| **Run / trigger a scan** | **System (cron)** | `CRON_SECRET` (`checkCronAuth`) | `/api/cron/scan`, `/api/scan/worker` |
| Admin "scan now" (manual) | **Admin** → System | `requireAdmin`, then server-side cron trigger | `/api/admin/scan` |
| My watchlist (add/remove) | **Tenant** | token + RLS owner-only | `/api/watchlist` |
| My portfolio / positions | **Tenant** | token + RLS owner-only | `/api/portfolio` |
| My personal settings | **Tenant** | token + RLS owner-only | `/api/settings` |
| My alert prefs | **Tenant** | token + RLS owner-only | `/api/alerts` |
| Ask / chat | **Tenant** | token + per-user daily quota | `/api/chat` |
| Data-source selection | **Admin** | `requireAdmin` | `/api/admin/sources` |
| Discovery/agent config (depth, sector, auto-add/remove) | **Admin** | `requireAdmin` | `/api/admin/settings` |
| Notification channels | **Admin** | `requireAdmin` | `/api/admin/channels` |
| Scan schedule / budget / cron secret | **System/Operator** | env + GitHub Actions | — |
| Shadow-B scoreboard | **Admin (internal)** | not surfaced | — |

¹ Public = when the login wall is OFF (Option A). With `NEXT_PUBLIC_REQUIRE_LOGIN=true`
these need sign-in but stay *"any signed-in user"* (shared, not tenant-specific).

**Scoping subtleties (get these right):**
- **Scans are system-scoped, not user/admin-in-app** — the trigger needs the cron
  secret the browser never holds. The in-app "scan now" button is **admin-only** and
  proxied through `/api/admin/scan` (which injects the secret server-side); tenants/
  public never see it.
- **Agent/discovery settings are ADMIN, not User** — they shape the ONE global scan;
  there is no per-user discovery depth.
- **Watchlist is dual-natured** — per-user (your list/view) AND its union feeds the
  global scan universe. A symbol on 10 watchlists is still scanned once.

## UI/UX requirements for the gates (first-class, not a follow-up)

Gating must feel intentional, never broken. Follows the standing rule *"dependent
secondary actions must be nested / disabled-with-explanation, never an out-of-order
control."*

- **Never hide-and-break.** A logged-out user sees gated actions (Add to watchlist,
  Save position, Set alert) as **present but disabled with an inline reason** or a
  soft **"Sign in with Google to save"** prompt — not missing, not a dead button, not
  a 401 error.
- **Friendly empty states.** The Watchlist/Positions tabs, logged out, show a clear
  CTA ("Sign in to build your watchlist"), not an error or a blank.
- **Sign-in is "save your own," not "unlock the app."** Framed as enabling personal
  features, since viewing is already free. Persistent but non-intrusive sign-in in
  the header; after sign-in the user's data loads seamlessly (identity only — **no
  scan/fetch triggered**).
- **Admin surfaces cleanly separated.** Admin-only panels (Settings/Agent config) are
  hidden for non-admins (and server-enforced), shown only to admins — no greyed/
  broken admin controls leaking to regular users.
- **Responsive + themed.** All gate states (prompts, sheets, empty states) work on
  mobile (the responsive layer already shipped) and match the dark aesthetic.
- **Continuity of the public surface.** The track record stays the front-and-center
  marketing hook for logged-out visitors.

*(Alternative, NOT chosen: hard login wall `NEXT_PUBLIC_REQUIRE_LOGIN=true` — hides
everything, including the marketing surface, behind sign-in.)*

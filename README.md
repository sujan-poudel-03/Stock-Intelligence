# NEPSE Intelligence V2

Autonomous NEPSE trading agent. Next.js 14 (App Router) · Supabase · Anthropic Claude · Vercel.

## Architecture

Scanning is fully server-side and hands off within Vercel's 60s budget:

```
/api/cron/scan        cron (45 4 * * *) or manual POST
   ├─ scanMarket()    NEPSE index/gainers/losers via Claude web_search
   ├─ runDiscovery()  pick best N movers
   ├─ create scan_jobs (one per watchlist + discovered symbol)
   └─ trigger ──▶ /api/scan/worker   (fire-and-forget)
                    ├─ claim ONE pending job atomically
                    ├─ scanOneStock() → save signal + job result
                    ├─ more pending? ─▶ /api/scan/worker (self-chain)
                    └─ none left?    ─▶ /api/scan/brief
                                          ├─ runBrief() → scans + ni:brief
                                          ├─ prune stale watchlist symbols
                                          ├─ mark scan done / partial
                                          └─ checkOutcomes() (weights + alerts)
```

The UI polls `/api/scan/status` every 5s while a scan is running.

## Setup

1. **Install**
   ```bash
   npm install
   ```
2. **Database** — apply `supabase/schema.sql` to your Supabase Postgres. Two ways:

   **a. Dashboard (quickest):** Supabase → SQL Editor → New query → paste the
   contents of `supabase/schema.sql` → Run.

   **b. Supabase CLI (version-controlled migrations):**
   ```bash
   npm i -D supabase            # local CLI, call via `npx supabase ...`
   npx supabase login
   npx supabase link --project-ref <your-project-ref>
   npx supabase migration new init_schema       # creates an EMPTY timestamped file
   # IMPORTANT: copy schema.sql INTO that new file before pushing — see gotcha below
   npx supabase db push
   ```

   > ⚠️ **Empty-migration gotcha.** `migration new` creates a *blank* file; its
   > contents must be filled before pushing. If you push an empty migration, the
   > push "succeeds" but creates nothing, and the version is still recorded as
   > applied. To recover: copy `schema.sql` into the migration file, then re-run
   > it by reverting the recorded version first —
   > ```bash
   > cp supabase/schema.sql supabase/migrations/<version>_init_schema.sql
   > npx supabase migration repair --status reverted <version>
   > npx supabase db push
   > ```
   > Re-applying is safe: `schema.sql` uses `create table if not exists`.

   > ✅ **RLS is ON (Phase 2).** Migrations set the policies — per-user tables are
   > owner-only, shared tables are public-read/service-write, `kv_store` is
   > read/service-write. Apply migrations via `npm run deploy`. Because RLS is on,
   > the cron/scan write path needs `SUPABASE_SERVICE_ROLE_KEY` (server-only) — set
   > it in your host **and** `.env.local`. Model: `docs/PHASE2-MULTITENANT.md`.

   Verify with `npm run doctor` (expects `✓ All expected tables exist.`).
3. **Env** — copy `.env.example` to `.env.local` and fill in:
   | var | purpose |
   |---|---|
   | `LLM_PROVIDER` | `gemini` (initial) or `claude` (later) |
   | `GEMINI_API_KEY` / `GEMINI_MODEL` | Gemini provider (default model `gemini-2.5-flash`) |
   | `LLM_DAILY_BUDGET` | daily LLM call cap; scan skips gracefully once spent (default `18`) |
   | `ANTHROPIC_API_KEY` / `NEPSE_MODEL` | Claude provider (used when `LLM_PROVIDER=claude`) |
   | `SUPABASE_URL` / `SUPABASE_ANON_KEY` | database |
   | `CRON_SECRET` | `Authorization: Bearer` guard for cron/worker/brief |
   | `RESEND_API_KEY` | email alerts (optional) |

### LLM provider adapter

All model calls go through `src/lib/llm.js` (`callLLM`), so the scan/outcomes
code is provider-agnostic. Swap providers with a single env var:

- `LLM_PROVIDER=gemini` → `src/lib/providers/gemini.js` (Google Search grounding
  serves as the web-search/web-fetch capability).
- `LLM_PROVIDER=claude` → `src/lib/providers/claude.js` (web_search / web_fetch
  server tools + `pause_turn` loop).

`callLLM(prompt, { system, webSearch, webFetch, maxTokens })` returns plain text;
`webSearch`/`webFetch` map to whichever provider is active.

### Quota fit & crash safety

The scan is designed to **never crash on LLM limits** — a free-tier quota or a
transient overload degrades to a *partial* result instead of failing:

- **Daily budget** (`LLM_DAILY_BUDGET`, default 18) is tracked in `kv_store`
  (`ni:llm_usage`, resets at 00:00 UTC). `callLLM` checks it before every call.
- **Graceful skip:** once the budget is spent, `callLLM` returns empty text
  rather than calling the API. Every call site tolerates this
  (`parseJson('') → null → defaults`). The cron route caps queued symbols to
  what the budget affords; the worker marks unaffordable stocks `skipped`; the
  brief falls back to a **deterministic, no-LLM summary** built from the signals
  already gathered.
- **Transient errors** (503/UNAVAILABLE) get one bounded retry honouring the
  provider's `RetryInfo` delay. A real quota error (429/RESOURCE_EXHAUSTED)
  exhausts the budget for the day so the rest of the scan skips immediately.
- `GET /api/health` reports `budget: { daily, remaining }`.

To tune spend in production, lower these one at a time: `LLM_DAILY_BUDGET`,
`settings.discoverCount` (fewer discovered symbols), or reduce per-stock cost.
4. **Run**
   ```bash
   npm run dev
   ```
   A preflight check runs automatically before `dev`/`start` (npm `predev`/
   `prestart` hooks). In startup mode it **blocks startup** if required env is
   missing (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, and the active provider key),
   if the active provider rejects the key, or if Supabase is reachable but the
   schema is missing. A transient network/timeout to Supabase only **warns**
   (so a network blip doesn't brick local dev). Run it on demand any time:
   ```bash
   npm run doctor          # verbose env + Supabase + schema report
   ```
   At runtime, `GET /api/health` returns the same checks as JSON (200 ready /
   503 not ready) — useful on Vercel where there's no local prestart.
5. **Dev full-chain run** (synchronous NDJSON stream, dev only):
   ```bash
   curl -N http://localhost:3000/api/scan/dev-run
   ```

## Deployment (Vercel Hobby)

- `vercel.json` schedules the cron at `45 4 * * *`.
- Set the same env vars in the Vercel project. The cron sends
  `Authorization: Bearer $CRON_SECRET` automatically when `CRON_SECRET` is set.
- Background hand-off uses `waitUntil` from `@vercel/functions`; locally the
  worker awaits synchronously instead.

## Naming note

The original spec prose referred to a `scan_runs` table, while the schema
defines it as **`scans`** (table #3). This build standardizes on the schema
names throughout: **`scans`** (runs) and **`scan_jobs`** (per-symbol queue).

## UI

`src/components/NepseApp.jsx` is the V2 shell with all server-side wiring
(scan trigger, status polling, retry, exchange selector, partial banner). The
V1 UI in `nepse_intelligence.jsx` is ported into the marked regions, swapping
`window.storage` for `@/lib/clientStorage` (`dbGet`/`dbSet`/`dbRemove`) and
removing the V1 client-side scan loop.

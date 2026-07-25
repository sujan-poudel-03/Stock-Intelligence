# CLAUDE.md — NEPSE Intelligence V2

Autonomous NEPSE swing-trading **signal** agent. Next.js 14 (App Router, plain JS)
· Supabase · pluggable LLM (`gemini` default / `claude`) · Vercel Hobby. It
generates BUY/SELL/HOLD/AVOID signals, tracks WIN/LOSS outcomes, and learns from
them. It does **not** place trades — it produces analysis, a daily brief, and alerts.

See `README.md` for setup and the full scan-chain diagram, and
**`docs/DEPLOYMENT.md`** for deployment (Vercel/Supabase/local env placement), how to
make an admin, Google Sign-In setup, and the owner-action checklist.

## Standing rules (always on)

- **Dependent secondary actions must be nested.** A secondary action whose
  validity depends on a primary action's state must be scoped inside that primary
  action's UI (nested, conditionally rendered, or disabled-with-explanation) —
  never an independent, equally-weighted control reachable out of order.

- **All model calls go through `callLLM`** (`src/lib/llm.js`). Never import a
  provider SDK (`@anthropic-ai/sdk`, `@google/genai`) into feature code. Parse
  model output with `parseJson()` (returns `null` on junk).

- **Every LLM call site must degrade, never crash.** When the daily budget is
  spent, `callLLM` returns `''`. Every call site must fall back to a deterministic,
  non-blank result — see `deterministicSignal` / `deterministicBrief` in
  `src/lib/scan.js`. A new LLM touchpoint without a no-LLM fallback is incomplete.

- **Never persist a hollow signal.** No live price → throw so the worker surfaces a
  retryable failed job, rather than saving an empty card.

- **Respect Vercel's 60s function budget.** Extend the self-chaining worker pattern
  (`cron/scan → scan/worker (self-chains) → scan/brief`); do not add blocking
  fan-outs. Background hand-off uses `waitUntil` (`src/lib/background.js`).

- **Supabase: anon key, RLS deliberately OFF** — a *single-tenant* decision, not a
  permanent one. Do not add RLS or policies while the app is single-user. All writes
  are upserts with explicit `onConflict`. Reversing this (Auth + per-user rows +
  RLS-on) is required before a second real user — see the Production guardrails.

- **Canonical table names are `scans` (runs) and `scan_jobs` (per-symbol queue)** —
  never `scan_runs`, whatever older prose says.

- **Side-channels are best-effort and must never throw into the main flow** —
  `knowledge`, `events`, alerts, and calibration (`weights`) accrual are wrapped so
  a failure there cannot break a scan or an outcome resolution.

### Production guardrails (launch-gating, always on)

These three block exposing the product to real users. Treat them as hard gates —
work may proceed *toward* clearing them, but the product is not shippable until they
are cleared. Full rationale + the phased plan is in **Production roadmap** below.

- **Prices must be ground truth, never LLM-sourced, in anything user-facing.** An
  LLM "reading" a price via web search can hallucinate it; a wrong price in a signal
  is direct financial harm, not a bug. Route every price through the verified layer
  (`src/lib/marketData.js` + admin-configured sources in `marketProviders.js`): it
  cross-checks sources, requires agreement, and **fails closed** (an unverified
  result is "no data", retryable — like the hollow-signal guard). **Correctness is
  the gate, freshness is not** — a late-but-true quote (minutes/hours old) is
  accepted and flagged `stale`; only wrong/disagreeing/implausible data is rejected.
  Use the LLM only to *reason over* verified numbers — never to source them.
  `scanOneStock` and outcome resolution are wired onto `getVerifiedPrice` (the LLM is
  barred from setting a price). **`merolagani` is LIVE** (real scraped quotes; the
  deployment default). `sample` is the offline placeholder (labeled, flagged by the
  disclaimer). `sharesansar` is a not-yet-implemented stub; `nepalstock` is
  build-ready but **config-gated** on `NEPALSTOCK_API_TOKEN` (disabled/unselectable
  until set). Sources declare `requiresEnv`; unavailable ones are rejected by
  `setActiveSources`, so the admin can't switch to a disabled source. **ToS caveat:**
  commercial scraping of merolagani is still pending the P3-1 legal review.

- **Every user-facing signal/brief carries "educational, not financial advice"
  framing.** Publishing BUY/SELL to users implicates SEBON (Securities Board of
  Nepal) investment-adviser regulation. No disclaimer-free signal surfaces, and no
  paid signals, until a Nepali securities lawyer has reviewed licensing + ToS. This
  is a go/no-go item, not a footnote. (Engineering guidance only here — not legal
  advice.)

- **Single-tenant assumptions stop at user #2.** The anon-key / no-RLS / shared-state
  design is a single-user decision. Do not onboard more than one real user until
  Auth + per-user rows + RLS-on land (Roadmap Phase 2). Any feature storing
  *user-specific* state must not bake in the shared-singleton model.

- **Market data is GLOBAL, never per-tenant.** Prices, `scans`/`scan_jobs`,
  `signals`, `outcomes`, calibration (`weights`), and `knowledge` are the SAME for
  every user — fetch/compute them **once per cycle and share**. NEVER fetch market
  data or run a scan per user: the scan universe is the *union* of all watchlists +
  discovery, so a symbol is scanned once no matter how many users watch it, and
  cost scales with **distinct symbols, not user count**. Multi-tenancy adds only a
  thin per-user layer (watchlist, alert prefs, subscription, saved portfolio); a
  user's brief/watchlist view is a **filter over the shared signals**, not a
  re-fetch. RLS follows suit: shared tables are readable by any authenticated user
  and written only by the cron/service role; per-user tables are owner-only.

- **Auth is identity-only, and there are two roles.** Signing in must NEVER trigger
  a data fetch or scan — the scan runs on the global cron independent of who is
  logged in; a login just reads already-computed shared data + the user's own view.
  Roles: **admin** (system config — data sources, scan control, the internal
  shadow-B scoreboard, budget/schedule) and **user** (view signals/brief + manage
  own watchlist/alerts). System-config actions are **admin-only and server-enforced**
  — the Market Data Sources selector and `/api/admin/*` must REJECT non-admins, not
  merely hide the UI. Auth is **Google Sign-In only**. Admin identity starts as a
  Google-email allowlist (`ADMIN_EMAILS`); a `role` column can come later.
  **Admin gate is BUILT** (`src/lib/auth.js` `requireAdmin`): `POST /api/admin/*`
  config mutations are server-enforced against `ADMIN_EMAILS` (a Google-email
  allowlist) via the caller's Supabase session token. **Phased:** `ADMIN_EMAILS`
  blank → gate is OPEN (single-operator interim); set it → ENFORCES, no code change.
  Google client sign-in is BUILT (`src/lib/authClient.js` / `useAuth` / `AuthPanel`):
  the screen shows the admin config surfaces (data sources, notifications) ONLY to
  admins (via `/api/admin/me`) and attaches the session token to admin mutations;
  with the `NEXT_PUBLIC_SUPABASE_*` env unset it degrades to open mode (single
  operator sees everything). Setup steps (`docs/DEPLOYMENT.md` §5) still need the
  owner's Google Cloud + Supabase provider config. Per-user rows + RLS-on stay later.

- **B (signal service) runs shadow-only until it earns graduation.** The eventual
  goal is a specific, actionable "do this" decision — but B's directional calls are
  **generated and scored internally, never exposed to the public as actionable**,
  until (1) a proven edge on the backtest harness, (2) a proven edge in live
  shadow/paper, and (3) legal sign-off. "Beta" is a maturity label, not a legal
  shield — a directional call to a real user is regulated advice regardless. Any
  B surface (incl. a closed paper cohort) must carry: "experimental · model-generated
  · NOT investment advice · simulated/for evaluation · past performance ≠ future
  results," plus the honest track record including losses.

## Conventions

- Plain **JavaScript + ESM**. No TypeScript. `@/` alias maps to `src/`.
- App Router route handlers live at `src/app/api/**/route.js`.
- The learning loop is two-track and feeds forward: `weights` (statistical) via
  `getWeightContext` / `getOverviewContext`, and `knowledge` (qualitative) via
  `getKnowledgeContext` — injected into discovery, per-stock signals, and the brief.

## Verification

- `npm test` — Vitest unit suite (`tests/**/*.test.js`), covering the deterministic
  money-critical + reliability-critical logic in `src/lib` (target math,
  `parseJson`, error humanization, budget ceiling, scan schedule, provider
  selection). New deterministic logic should ship with tests here.
- `npm run lint` — ESLint.
- `npm run build` — Next.js production build (primary breakage gate).
- `npm run doctor` — env + Supabase + schema check.
- `curl -N http://localhost:3001/api/scan/dev-run` — dev-only full-chain NDJSON run
  (dev server runs on port 3001).
- `GET /api/health` — runtime readiness + LLM budget.

CI (`.github/workflows/ci.yml`) runs lint + test + build on every push to `main`
and every PR. Anything needing Supabase or a live LLM is out of scope for unit
tests — exercise it via `build` + the dev full-chain run.

## Role-based development pipeline

`.claude/agents/` holds four role subagents; `.claude/workflows/feature-pipeline.js`
chains them Define → Design → Implement → Review.

- Invoke one role ad hoc by naming it (e.g. "get the principal-architect's take").
- Run the full pipeline only via the explicit opt-in phrase:
  **"use a workflow to run feature-pipeline for: &lt;request&gt;"**. The request
  string is the *entire* briefing — the Product Owner stage has no memory of the
  conversation, so state context, don't reference it.

## Production roadmap (path to launch)

The plan that turns this from a working build into a marketable product. The
launch-gating guardrails above come from Phases 1–3. **Do not market before Phase 1
(data correctness) is done and the legal read has started.**

**Phase 0 — Product shape. DECIDED: A — "Analyst copilot"** (BA/PO call,
2026-07-24; owner may override). Present research + a transparent track record,
framed as education; the **user** makes and owns the trade decision. Chosen over
B ("signal service" — sell actionable BUY/SELL calls) because: the differentiator
in a tip-seller-saturated market is transparency, not another claimed win rate; the
engine (learning loop + `why`/`live_data` + track record) already *is* A; and the
risk is asymmetric — B's downside (SEBON action / a losing streak framed as advice)
is existential, while A→B remains an open door later (licensed) but B→A does not.
- Build implication: UI leads with rationale, live data, and full WIN/LOSS history;
  the BUY/SELL verb is informational, never framed as an instruction to act.
- A licensed **B tier** may be added later *once A's own verified track record +
  a licence exist* — not before.

**Phase 1 — Data & correctness (make it *true*).** — mostly DONE (build).
- [x] Verified-price layer `src/lib/marketData.js`: cross-source agreement +
  plausibility guard, fails closed; freshness is metadata, not a gate.
- [x] Admin-selectable sources `src/lib/marketProviders.js` + Settings screen +
  `/api/admin/sources`; shipped `sample` default so it runs offline.
- [x] `scanOneStock` + outcome resolution rewired onto `getVerifiedPrice` (LLM can
  no longer set a price).
- [x] **P1-1**: `merolagani` live fetcher (real NEPSE quotes), validated end-to-end.
  Config-gated provider system: sources declare `requiresEnv` and stay disabled/
  unselectable until set (nepalstock ← `NEPALSTOCK_API_TOKEN`). ToS review (P3-1)
  still pending before commercial use. (sharesansar: not yet implemented.)

**Phase 1.5 — Learning & validation (robust, explainable "RL").** — harness DONE.
- [x] **Backtest / replay harness** `src/lib/backtest.js` — the validation
  environment, with a strict **no-look-ahead** guarantee (the strategy only ever
  sees bars up to day T) + track-record metrics (win rate, avg return, max
  drawdown). The keystone — nothing below is trustworthy without it.
- [x] Calibration is now a **statistical contextual bandit** — pure primitives in
  `src/lib/stats.js` (Wilson lower bound, Beta posterior, Thompson sampling,
  risk-adjusted reward, EWMA decay), unit-tested. Wired: the calibration strings the
  LLM reads show a confidence-adjusted rate (`conservative X%`); the overview
  leaderboard ranks by the Wilson lower bound (a thin "100% from 2" can't top a
  proven "75% from 30"); backtest metrics include Sharpe + risk-adjusted return.
- [x] **Time-decay** (P1.5-3b): EWMA-decayed counts in `weights` (`dwins`/`dlosses`/
  `last_outcome_at`, migration `20260724120000_weights_decay.sql`), surfaced as a
  "recent-weighted win rate" for non-stationarity. Written **best-effort** so
  calibration keeps working whether or not the migration is applied yet.
- [x] **Shadow-B** (P1.5-5): `src/lib/shadow.js` scores B's would-be track record
  (Wilson-discounted win rate + risk-adjusted return, by direction) from resolved
  signals — an INTERNAL scoreboard only; per the B guardrail it is never surfaced as
  an actionable recommendation. Deep/black-box RL stays rejected (data-starved;
  breaks explainability). *Open follow-ups:* apply the migration; wire Thompson
  selection into discovery; feed the shadow scoreboard from a live internal report.

**Phase 2 — Multi-tenant SaaS foundation.** (Preserve the shared/per-user split —
see the "Market data is GLOBAL" guardrail. Market data/scans/signals/weights/
knowledge stay global; only a thin per-user layer is added.)
- Auth = **Google Sign-In only** (Supabase Google provider). Roles: **admin**
  (Google-email allowlist `ADMIN_EMAILS`) vs **user**. **Start OPEN** — gate only
  `/api/admin/*` (data-source config, scan control) behind the admin check now;
  require sign-in for per-user features + turn RLS on in a later step.
- Supabase Auth + **RLS on** (later step). Shared tables: readable by any
  authenticated user, writable only by the cron/service role. Per-user tables:
  owner-only. Login is identity-only — it never triggers a fetch/scan.
- Add `user_id` **only** to new per-user tables (watchlist, alert prefs,
  subscription, saved portfolio) — NOT to signals/scans/weights/knowledge.
- One scan serves everyone: the scan universe = union of all watchlists + discovery.
  A user's brief/watchlist is a filter/view over the shared signals, not a re-fetch.
- Billing (Stripe, or a Nepal-friendly gateway — eSewa/Khalti) with free/paid tiers.
- The shared scan is a fixed global LLM cost amortized across all subscribers; meter
  per-user cost ONLY for optional per-user LLM features (chat, custom summaries).

**Phase 3 — Trust, compliance, delivery.**
- [x] Disclaimer component (`src/components/Disclaimer.jsx`) on every surface —
  "educational, not financial advice · past performance ≠ future results", and
  loudly flags when a non-live (`sample`) source is active. Final legal copy + ToS +
  privacy policy still pending the SEBON/legal review (P3-1).
- [x] Transparent track-record page — `Track Record` tab + `/api/track-record`,
  computed from the `signals` table (ground truth), losses included. Overall +
  by-direction + by-sector win rates carry the Wilson lower bound (`conservative`),
  recent outcomes list. The top marketing asset *and* the honesty mechanism.
- [x] Delivery + observability via config-gated channels (`src/lib/notify.js`):
  email (Resend) + Telegram, each ACTIVE only when its env is set (same pattern as
  data sources). The brief route delivers the daily digest AND alerts on
  partial/failed scans, best-effort in the background. Admin sees channel status in
  Settings → Notifications (`/api/admin/channels`). Events already surface in the
  Activity panel. (Viber/WhatsApp can be added as further channels later.)

**Phase 4 — Go-to-market.**
- Positioning: "An AI analyst for NEPSE that shows its work and its track record" —
  lead with transparency vs. opaque tip-sellers.
- Free tier as funnel: daily brief + a couple of signals free; full watchlist,
  alerts, per-symbol history paid.
- Distribution: NEPSE Facebook/Viber communities; public track record as the
  credibility hook; referral loop.
- Pricing: monthly NPR subscription via local gateway, anchored vs. tip-sellers.
- Proof before spend: run live 60–90 days, publish the real track record, *then* market.

**Sequencing:** Phase 0 decision + Phase 1 (do not market before this) → legal/SEBON
read (parallel, start now) → Phase 2 multi-tenancy + billing → Phase 3 trust surfaces
+ 60–90 day live track record → Phase 4 launch on verified numbers.

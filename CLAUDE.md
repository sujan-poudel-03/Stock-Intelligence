# CLAUDE.md — NEPSE Intelligence V2

Autonomous NEPSE swing-trading **signal** agent. Next.js 14 (App Router, plain JS)
· Supabase · pluggable LLM (`gemini` default / `claude`) · Vercel Hobby. It
generates BUY/SELL/HOLD/AVOID signals, tracks WIN/LOSS outcomes, and learns from
them. It does **not** place trades — it produces analysis, a daily brief, and alerts.

See `README.md` for setup and the full scan-chain diagram.

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
  `scanOneStock` and outcome resolution are already wired onto `getVerifiedPrice`
  (the LLM is barred from setting a price). The shipped default source is `sample`
  (labeled placeholder data); the real-source fetchers (merolagani/sharesansar/
  nepalstock) are stubs pending P1-1 + a ToS review. **Do not present the product to
  real users until a live source is wired and the `sample` source is off.**

- **Every user-facing signal/brief carries "educational, not financial advice"
  framing.** Publishing BUY/SELL to users implicates SEBON (Securities Board of
  Nepal) investment-adviser regulation. No disclaimer-free signal surfaces, and no
  paid signals, until a Nepali securities lawyer has reviewed licensing + ToS. This
  is a go/no-go item, not a footnote. (Engineering guidance only here — not legal
  advice.)

- **Single-tenant assumptions stop at user #2.** The anon-key / no-RLS / shared-state
  design is a single-user decision. Do not onboard more than one real user until
  Auth + per-user rows + RLS-on + per-user budget accounting land (Roadmap Phase 2).
  Any feature storing user-specific state must not bake in the shared-singleton model.

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
- [ ] **P1-1**: implement a real source fetcher (owner picks source; ToS review) —
  the one remaining gate before real users.

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

**Phase 2 — Multi-tenant SaaS foundation.**
- Supabase Auth + per-user rows + **RLS on** (reverses the single-tenant default).
- Per-user watchlists, brief, alert prefs, and LLM-budget accounting.
- Billing (Stripe, or a Nepal-friendly gateway — eSewa/Khalti) with free/paid tiers.
- Meter per-user LLM cost against the subscription price — the shared daily budget
  cap does not scale to many users.

**Phase 3 — Trust, compliance, delivery.**
- Disclaimers + ToS + privacy policy on every surface; "past performance ≠ future
  results" on the track record.
- Transparent track-record page (real WIN/LOSS history) — the top marketing asset
  *and* the honesty mechanism.
- Delivery channels Nepali retail actually uses: email (have it) + Viber / Telegram
  / WhatsApp daily brief.
- Observability + on-call for the scan chain (surface the `events` it already emits).

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

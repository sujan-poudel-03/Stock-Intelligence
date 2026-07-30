# NYSE / Multi-Exchange — Parallel Work Plan

The working basis for extending the platform from **NEPSE-only** to **multi-exchange
(NEPSE + NYSE)**, developed in a **separate session/branch in parallel** with the
NEPSE launch. NEPSE stays primary and untouched in production; NYSE is additive.

Read `CLAUDE.md` first — its guardrails (shared-per-exchange data, config-gated
providers, verified prices, degrade-never-crash, the role pipeline) all apply here.

---

## 1. Goal

A user can pick their market (**NEPSE** or **NYSE**), and the whole app — data,
signals (entry/SL/target), brief, track record — works for that exchange. Switching
exchanges works end to end. Onboarding asks which market.

## 2. Current state (what exists to build on)

- **Exchange concept already in the UI** — `EXCHANGES` in `NepseApp.jsx` has NEPSE +
  NYSE; NYSE is **disabled** ("coming in Level 2").
- **`src/lib/yahoo.js`** (`fetchYahooStock`) — a real **US-stock quote fetcher**
  (Yahoo Finance), built but **not wired** into the data/scan layer.
- **Data layer is NEPSE-only** today: `marketProviders.js` = merolagani/sample;
  `marketData.js` verified-price core is exchange-agnostic but only fed NEPSE sources.

## 3. Parallel-work model (how both run at once — THE key discipline)

| Track | Branch | Deploys to | Scope |
|---|---|---|---|
| **NEPSE (primary)** | `main` | **Production** (`…fawn.vercel.app`) | Launch/ops only — track record, legal, monitoring. **Frozen for core code.** |
| **NYSE (this plan)** | `feat/nyse-exchange` | **Vercel Preview** (per-branch URL) | All NYSE/multi-exchange work. |

**Rules — do not break these:**
1. **NYSE stays off `main`** until done + tested on the preview URL. Merge only when green.
2. **Backward-compatible refactor** — after it, **NEPSE must produce signals exactly
   as before** (merolagani, verified prices, same UX). This is the #1 risk: the
   exchange-aware changes touch the verified-price core NEPSE depends on.
3. **Freeze NEPSE core files** on `main` during this window (`marketData.js`,
   `marketProviders.js`, `scan.js`, `NepseApp.jsx`) so there's nothing to conflict with.

## 4. Technical outline (build on `feat/nyse-exchange`)

1. **Exchange-aware provider registry** — `marketProviders.js` maps *exchange →
   sources*: `NEPSE → [merolagani, …]`, `NYSE → [yahoo]`. `getVerifiedPrice(symbol,
   { exchange })` selects the right providers; the `marketData.js` core (agreement,
   plausibility, fail-closed, staleness) stays shared and unchanged.
2. **Wire `yahoo.js` as the NYSE provider** — shape its output to the normalized
   quote (`{ symbol, price, prevClose, asOf, source }`). Config-gated like the others.
3. **Exchange-scoped scans + signals** — the scan universe, `signals`, `scans`,
   `weights`, `knowledge` carry/filter by exchange. **Data stays GLOBAL PER EXCHANGE**
   (shared among that exchange's users, fetched once per cycle) — same rule as NEPSE,
   just scoped. Add an `exchange` column/field where needed (additive migration).
4. **Exchange switch** — the Settings/header switch changes the active market end to
   end (header index, signals, brief). Switching must NOT trigger a per-user re-fetch
   (login/switch is a view over shared per-exchange data — CLAUDE.md guardrail).
5. **Onboarding** — a "Which market do you trade?" step sets the user's exchange
   (pairs with the Phase 2 per-user layer; can start as a stored preference).
6. **Regulation/disclaimer per exchange** — US = SEC/FINRA (not SEBON); the
   disclaimer copy adjusts by exchange. Legal read for US is separate.

## 5. Acceptance criteria (definition of done)

- [ ] Switching to **NYSE** shows **real US data** (via yahoo) — signals with real
      entry/SL/target; no `⚠ SAMPLE` when a live source is active.
- [ ] **NEPSE still works exactly as before** (backward-compat proven).
- [ ] Market data is **shared per-exchange, fetched once per cycle** — never per user.
- [ ] The exchange **switch** works end to end; a **login/switch never triggers a fetch**.
- [ ] **Onboarding** asks the exchange and the app respects it.
- [ ] `npm test` + `npm run lint` + `npm run build` green; new logic has unit tests.

## 6. Non-goals (this phase)

- Full multi-tenant per-user + RLS (that's Phase 2 — but the exchange *preference*
  can start now).
- Exchanges beyond NEPSE/NYSE. Real-time tick streaming.

## 7. How the other session starts

```bash
git checkout main && git pull
git checkout -b feat/nyse-exchange
```
Then run it through the role pipeline (it's nontrivial and touches the core data path):

> **use a workflow to run feature-pipeline for:** make the platform exchange-aware
> and enable NYSE. Add an exchange→sources provider registry (NEPSE→merolagani,
> NYSE→yahoo via `src/lib/yahoo.js`), route `getVerifiedPrice` by exchange, scope
> scans/signals/weights/knowledge by exchange (data global PER exchange, never per
> user), make the Settings/header exchange switch work end to end, and add an
> onboarding "which market?" step. Backward-compatible: NEPSE must keep working
> exactly as now. Constraints: follow docs/NYSE-MULTI-EXCHANGE.md and CLAUDE.md;
> keep it off `main` until the acceptance criteria pass on a Vercel preview deploy.

Test on the branch's **Vercel preview URL**. Merge to `main` only when §5 passes.

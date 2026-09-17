# NEPSE Intelligence V2 — Product & Architecture Context (for UI/UX design work)

Paste this whole document into ChatGPT (or any design tool/model) as context before
asking it to design or redesign screens. It covers **what the product is, why it
exists, how it's built, what already exists in the UI, and the hard constraints any
design must respect.**

---

## 1. One-line pitch

**"An AI analyst for NEPSE (Nepal Stock Exchange) that shows its work and its track
record."** Not a tip-seller, not an auto-trader — a research copilot that generates
BUY/SELL/HOLD/AVOID signals with reasoning, tracks whether it was right, and shows
the losses too.

## 2. Vision & product shape (why it's built this way)

The team explicitly chose **"Analyst copilot" (Option A)** over **"Signal service"
(Option B)**:

- **A — Analyst copilot (current, live):** Present research + a transparent,
  win-and-loss track record, framed as education. The **user** makes and owns the
  trade decision. BUY/SELL is informational, never an instruction.
- **B — Signal service (shadow-only, not public):** Sell actionable "do this" calls.
  This is generated and scored **internally only** (an internal scoreboard), never
  shown to real users, because a directional call to a user is regulated investment
  advice in Nepal (SEBON) regardless of "beta" labeling. B may graduate to a real,
  licensed tier later — but only after (1) proven backtest edge, (2) proven live
  paper/shadow edge, and (3) legal sign-off.

**Why A over B:** in a market saturated with tip-sellers claiming win rates,
**transparency is the differentiator**, not another unverifiable claim. The engine
already produces the ingredients for A (reasoning `why`, live data, full win/loss
history) — A→B is an open door later, B→A is not (once you've sold calls, you can't
un-sell them).

**Design implication:** every screen that shows a signal must also make its
reasoning and its track record reachable, and must never read like an instruction
to act ("BUY" is a *reading*, not a *command*).

### Go-to-market framing (useful for landing/marketing screens)
- Positioning: "shows its work and its track record" vs. opaque tip-sellers.
- Free tier as funnel: daily brief + a couple of signals free; full watchlist,
  alerts, per-symbol history are paid (billing not yet built — currently free/open).
- Distribution: NEPSE Facebook/Viber communities; the public track record is the
  credibility hook; referral loop.
- Target user: **Nepali retail investors**, mixed sophistication — the product
  explicitly has a **beginner on-ramp** (see §5) alongside a full-featured mode.

## 3. Who uses it (roles)

Two roles, both via **Google Sign-In only**:

- **User** (default): views the daily brief, per-stock signals, the public track
  record; manages their own watchlist, alerts, and a personal (simulated) portfolio.
  Signing in is identity-only — it never triggers a data fetch or scan.
- **Admin** (Google-email allowlist, `ADMIN_EMAILS`): everything a user sees, plus
  system configuration — which market-data source is active, scan control/manual
  trigger, notification channels, budget/schedule, an internal shadow-B scoreboard.
  Admin surfaces are **server-enforced**, not just hidden in the UI — a design must
  not rely on "hide the button" as the only gate.
- The app also runs **fully open (single-operator) mode** when Google auth env vars
  are unset — everything degrades gracefully rather than blocking.

## 4. Current UI structure (what exists today — the baseline to redesign from)

Single-page app shell (`src/components/NepseApp.jsx`), dark theme, top tab bar, one
persistent disclaimer strip. Tabs today:

| Tab | Purpose |
|---|---|
| **Today** | The daily brief: market mood (bullish/bearish/neutral), top movers, alerts needing action ("take profit" / "exit now" on open positions), the LLM-written narrative summary. |
| **Positions** | The user's own trade log — open positions (with break-even/invested/charges/P&L math via a NEPSE brokerage-charge engine) and closed trades. This is the user's bookkeeping, not agent output. Flags positions with no stop-loss set. |
| **Paper** | Risk-free simulated trading account — the flagship **beginner on-ramp**: practice acting on signals with fake money before risking real capital. Trades against the same signals/prices as real mode. |
| **Signals** | The full list of current per-stock signals (BUY/SELL/HOLD/AVOID) with confidence, entry/target/stop-loss, and reasoning (`why`), sourced from the latest scan. Users can log a real or paper trade directly from a signal. |
| **Track Record** | The honesty mechanism and top marketing asset: overall + by-direction + by-sector win rates (Wilson-lower-bound "conservative" rate, not a raw/inflated one), recent resolved outcomes, losses included. |
| **Watch** (watchlist) | User's own watched symbols + provenance (manual / discovered / holding / system-seeded), badge count in the tab. |
| **Settings** (gear icon) | Account, admin-only config (data sources, notification channels) when signed in as admin, exchange preference. |

Supporting UI pieces already built:
- `Disclaimer.jsx` — persistent strip on every surface: "educational, not financial
  advice," plus a loud flag when the active price source is `sample` (non-live) data.
- `Term.jsx` + `glossary.js` — a **plain-English tooltip layer**: technical labels
  (BUY, confidence, BULLISH, etc.) get a hover/tap definition in plain language, part
  of the beginner tier. Design should keep this pattern for any new jargon.
- `LoginWall.jsx` — optional hard gate before the app renders (off by default; the
  public track record is deliberately visible without login as a trust/marketing
  surface).
- `AdminDataSources.jsx` / `AdminChannels.jsx` — admin-only config panels.
- Visual baseline today: **very dark background (#07090e), monospace (IBM Plex Mono)
  for data/numbers, Inter for UI chrome, small font sizes (~12px), tight information
  density, terminal/trading-desk aesthetic** — not a soft consumer-app look. A
  redesign can keep or intentionally depart from this; call out which explicitly
  when briefing ChatGPT.

## 5. Beginner-focused features (recent additions, still evolving)

The product is actively investing in a **beginner track**, alongside the
power-user density above:
- Paper trading account (risk-free simulated positions).
- Plain-English glossary + hover/tap tooltips on jargon.
- Clearer empty-states for new users with nothing watched/traded yet.
- A global/system-seeded watchlist so a brand-new user always sees populated
  signals, not a blank screen.

**Design opportunity:** the current UI is one dense, terminal-style surface serving
both a beginner and a power user simultaneously. A worthwhile UX question to put to
ChatGPT: should beginner mode be a visually distinct, simplified surface (progressive
disclosure) rather than the same dense grid with tooltips bolted on?

## 6. Multi-exchange direction (in progress, this branch: `feat/nyse-exchange`)

Today the app is NEPSE-only in production; **NYSE support is being built in
parallel** on a separate branch, not yet merged to `main`. Vision: a user picks
their market (NEPSE or NYSE) and the *entire app* — data, signals, brief, track
record — scopes to that exchange; switching is instant and end-to-end.

- An exchange selector already exists in the header (`EXCHANGES` registry); NYSE is
  currently shown but disabled ("coming in Level 2").
- Each exchange has its own currency/symbol (Rs vs $), trading hours, timezone, and
  **its own regulator-specific disclaimer copy** (SEBON for NEPSE vs SEC/FINRA for
  NYSE) — the disclaimer component already branches on this.
- Market data, signals, and track record stay **global per exchange** (shared across
  all users watching that market, computed once per cycle) — never per-user,
  never per-account re-fetched.

**Design implication:** any redesign should treat "exchange" as a first-class,
always-visible piece of context (like a currency/region switcher), not a buried
setting — and must accommodate a second currency format and a second regulatory
disclaimer without restructuring the layout.

## 7. Architecture (so ChatGPT understands data flow, latency, and what's "live" vs "cached")

- **Stack:** Next.js 14 (App Router, plain JavaScript, no TypeScript) · Supabase
  (Postgres + Auth, Row-Level Security ON) · a pluggable LLM layer (Gemini default,
  Claude optional) · deployed on Vercel (Hobby tier, 60-second function budget).
- **Scan pipeline (fully server-side, self-chaining to respect the 60s limit):**
  `cron/scan` (kicks off, builds a job queue) → `scan/worker` (claims one symbol at a
  time, self-chains until the queue is empty) → `scan/brief` (writes the daily brief,
  resolves past outcomes, sends alerts). The **UI polls scan status every 5 seconds**
  while a scan is running and shows live progress (`N/total symbols scanned`), a
  stalled-state warning, and a partial-completion banner if the scan didn't finish
  cleanly (e.g., LLM budget ran out mid-scan). **A design must always have a
  loading/in-progress/partial state for signals and the brief — they are not always
  instantly available.**
- **Prices are ground truth, never LLM-guessed.** A cross-checked, fail-closed
  verified-price layer feeds every signal; the LLM only *reasons* over a verified
  number, never sets one. If verification fails, the UI must show "no data,
  retryable," never a fabricated or blank-looking price.
- **Freshness vs correctness:** a late-but-true quote (minutes/hours old) is shown
  and labeled `stale`, not hidden — correctness is the gate, not real-time speed.
  **Design should have a lightweight staleness indicator on price data.**
- **LLM budget ceiling:** the system runs on a hard daily LLM call budget. When it's
  spent, the app **degrades to deterministic, non-LLM summaries** rather than
  failing — signals/brief still render, just with a simpler, rules-based narrative
  instead of AI prose. A design should not assume "AI narrative" is always present;
  have a plain fallback layout for it.
- **Global vs per-user data (important for any dashboard/watchlist design):**
  market data, signals, the brief, the track record, and the learning/calibration
  data are **the same for every user** — computed once per cycle. Only a thin
  per-user layer exists on top: watchlist, alert preferences, saved paper/portfolio
  positions, settings. A user's "my view" is always a *filter* over shared data, not
  a personal re-fetch — so per-user personalization in the UI should read as
  "your subset of the shared picture," not "your own separate world."
- **Notifications:** email (and previously-planned Telegram) alerts for
  watched-symbol BUY/SELL flips and target-hit/stop-loss-breach events — config-gated,
  so the UI should treat "alerts channel connected" as an optional, discoverable
  state rather than assumed.

## 8. Hard constraints any UI/UX design must respect

These are non-negotiable product rules (from the project's own engineering
guardrails) — mention them explicitly to ChatGPT so proposed designs don't violate
them:

1. **Disclaimer must appear on every user-facing signal/brief surface** —
   "educational, not financial advice," plus honest track record including losses.
   No screen showing a BUY/SELL/HOLD/AVOID call may omit this.
2. **BUY/SELL/HOLD/AVOID is informational, never a command.** Copy, iconography, and
   interaction design (e.g., no "Execute Trade" button wired to a real broker) must
   avoid implying the app places trades. The existing "Paper" mode and manual
   "log buy/sell" flow (self-reported bookkeeping) are the correct pattern.
3. **A secondary action that only makes sense after a primary action must be nested
   inside that primary action's UI** (shown/enabled only in that context), never a
   separate, equally-weighted control a user could trigger out of order. Example in
   the current UI: "take profit / exit now" only appears attached to an existing
   open position, not as a standalone global button.
4. **Admin-only controls (data source selection, scan control, channel config) must
   be visually distinct from user controls** and only appear for admins — but
   design must assume the *visual* hiding is a UX nicety, not the actual security
   boundary (that's server-enforced already).
5. **Every state must have a non-blank fallback:** no data yet, LLM budget
   exhausted, scan partial/stalled, source is sample/offline data — each needs its
   own honest visual state rather than an empty or broken-looking screen.
6. **No fabricated real-time feel where it doesn't exist.** If a price is stale, say
   so. If a scan hasn't finished, show progress, not silently frozen data.

## 9. What to ask ChatGPT for (suggested framing)

Good prompts to layer on top of this context, depending on scope:
- "Redesign the [Today / Signals / Track Record / Paper] screen for a mobile-first
  Nepali retail investor audience, keeping the tab structure but improving visual
  hierarchy and beginner comprehension."
- "Propose a simplified 'beginner mode' layout vs. the current dense power-user
  grid — how would progressive disclosure work here?"
- "Design the exchange switcher (NEPSE ⇄ NYSE) as a persistent, low-friction header
  element that also carries the correct currency and disclaimer context."
- "Design empty/loading/partial/stale states for the Signals and Today tabs."
- Share current screenshots (if available) alongside this doc for a redesign-in-place
  request, or ask for a from-scratch concept if an aesthetic departure is wanted —
  say explicitly which you want, since the current UI has a strong existing identity
  (dark terminal/trading-desk look) that ChatGPT will otherwise try to preserve.

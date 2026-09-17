# NEPSE Intelligence V2 — UI/UX Redesign: Discovery (Phase 0)

Written before any redesign work, per the redesign engagement's own rule: understand
the real repo before touching it. This is NOT a from-scratch app — it's a working,
tested, deployed product. The redesign proceeds as an **incremental reskin/rebuild of
one screen at a time**, never a parallel "V2 app," and never at the cost of the
guardrails in the root `CLAUDE.md` (disclaimer-everywhere, nested dependent actions,
admin-server-enforcement, no fabricated data, degrade-never-crash).

## 1. Real stack (corrects assumptions in the generic redesign brief)

- **Plain JavaScript + ESM, no TypeScript.** `@/` → `src/`. There is no `types/`
  directory to create and no type-checking gate to add — `npm run build` (Next.js)
  is the compile-correctness gate, `npm run lint` is ESLint, `npm test` is Vitest.
- **Not a multi-page app.** `src/app/page.js` renders a single client component,
  `src/components/NepseApp.jsx` (~2,100 lines) — a **single-file SPA shell** that
  holds all state and switches between tabs via a `tab` string in React state, not
  Next.js routes. There is no `pages/` or per-tab route to redirect to.
- **No existing component library / no CSS framework.** Every element is inline
  `style={{ ... }}` objects. A handful of local helper functions already act as a
  proto design-system: `card()`, `btn()`, `sbox()`, `ghost()`, `SectionHeader`,
  `ToggleBtn`, `SegBtn` (all defined near the top of `NepseApp.jsx`). These are
  reused, not replaced, unless a screen's redesign genuinely needs something new.
- **Font system already close to the target:** `Inter` (UI/labels), `IBM Plex Mono`
  (prices/symbols/timestamps), `IBM Plex Sans` (longer prose like signal reasoning
  and the daily brief). The redesign keeps this pairing — it already matches the
  "mono for financial data, sans for explanations" principle.
- **Auth/roles:** `useAuth()` exposes `auth.configured/signedIn/isAdmin/email`.
  Admin-only UI (scan trigger, admin config panels) is already visually gated by
  `auth.isAdmin` in the client AND separately enforced server-side
  (`requireAdmin` in `src/lib/auth.js`) — the redesign must preserve both, not just
  the visual gate.

## 2. Route map (API, not pages — this app has one visible route)

`GET /` → `NepseApp.jsx`. All real "routes" are API endpoints the shell polls/fetches:

| Endpoint | Feeds |
|---|---|
| `GET /api/signals?exchange=` | Signals tab, Today's signal cards, Positions cross-refs |
| `GET /api/scan/status?exchange=` | Scan progress, market header, stall/partial banners |
| `GET /api/watchlist?exchange=` | Watchlist tab + Today's watchlist widget |
| `GET /api/system-watchlist?exchange=` | Global curated/seed universe |
| `GET /api/portfolio?exchange=` | Positions tab |
| `GET /api/paper` / `POST /api/paper/order` | Paper trading |
| `GET /api/track-record?exchange=` | Track Record tab |
| `GET /api/stock?symbol=&exchange=` | Stock detail overlay |
| `GET /api/activity` | Activity/agent-log panel |
| `POST /api/chat` | Ask/chat sidebar |
| `GET/POST /api/admin/*` | Admin-only config (sources, channels, scan control) |
| `GET /api/exchanges` | Which markets are enabled (NEPSE always; NYSE gated) |

All of these already carry the `?exchange=` scoping fixed earlier this session — the
redesign must keep sending it on every fetch it touches.

## 3. Existing tab inventory (what's being redesigned, tab by tab)

`TABS` in `NepseApp.jsx`: **Today, Positions, Paper, Signals, Track Record, Watch**,
plus **Settings** (gear icon, includes admin config when `auth.isAdmin`) and an
**Ask** sidebar (chat), toggled independently of tabs.

- **Today** — redesigned (Phase 3): market hero, Top Movers / Signal Activity / Scan
  Status row, AI Brief + Watchlist row, priority signal cards (nested Buy form
  preserved exactly per the CLAUDE.md dependent-action rule), Quick Actions.
- **Signals** — redesigned (Phase 4): BUY/SELL/HOLD/AVOID filter chips + symbol
  search over the already-loaded `signals` array (no new fetch), distinct
  no-signals-at-all vs. no-match-for-filter empty states.
- **Watchlist / Positions / Track Record** — light-touch pass: consistent
  `SectionHeader` usage + Positions now explicitly labeled "your own record — not
  agent output" per the redesign's Positions-vs-signals distinction rule. Structure
  and logic were already sound; not rebuilt.
- **Paper** — reviewed, not changed. Already amber-themed, "SIMULATED" labeled
  throughout, confirmation-gated before every order — already meets the redesign's
  Paper-trading bar.
- **Settings / Admin** — untouched this pass.

## 4. The mockup vs. reality — what's real data and what would be fabricated

The shared mockup implies market breadth data the backend does not currently
produce. Per CLAUDE.md ("never persist a hollow signal") and the redesign's own
rule ("do not invent data"), the Today redesign uses **only fields the scan chain
actually writes** (`src/lib/scan.js` `scanMarket()`):

| Mockup element | Backed by real data? | Decision |
|---|---|---|
| NEPSE Index value + % change | Yes (`market.index`, `market.change_pct`) | Kept |
| Market mood / sentiment badge | Yes (`market.sentiment`) | Kept |
| Turnover | Yes (`market.turnover`, nullable) | Kept, shown only when present |
| Advancers / Decliners / Unchanged counts | **No** — not computed anywhere | Dropped (not fabricated) |
| Total Trades / Total Volume / intraday mini-chart | **No** — no tick history is stored | Dropped |
| Top Movers (Gainers/Losers/Most Active) | Gainers + Losers yes (`market.gainers/losers`); "Most Active" no | Two tabs only (Gainers/Losers) |
| Signal Activity counts | Partially — total signals, BUY count, and resolved-today count are all derivable from the already-loaded `signals` array (`signal.outcome`) | Kept, computed client-side from real state, no new fetch |
| AI Daily Brief | Yes (`brief` state, already fetched) | Kept, restyled |
| Your Watchlist mini-table | Yes (`watchlist` + `signals` lookup) | Kept |
| Price Freshness | Yes, derived from `status.market_as_of` / `status.last_updated` | Kept |
| Latest Signals list | Yes (`signals`, already sorted by the API) | Kept, shown as a compact list above the existing detailed BUY cards |
| Quick Actions | Yes — all are just `setTab(...)` navigation | Kept |
| Scan Status | Yes (`status`, `running`, `scanPhase`, `progressLabel`, `stalled`) | Kept, restyled with a real progress bar |
| "Good afternoon, {name}" | **No real display name** — only a masked email exists | Rephrased to a generic, non-fabricated greeting |

## 5. Components/logic explicitly preserved (do not rebuild)

- The nested Buy-form-inside-a-signal-card pattern (CLAUDE.md dependent-action rule).
- `openStock`, `startBuy`, `logBuy`, `openAsk` handlers — reused as-is.
- The stalled/partial-scan banners and their admin-only retry button.
- The alerts (target-hit / stop-loss) banner and its "take profit / exit now" nesting
  into the Positions tab.
- `<Disclaimer exchange={exchange} />` — untouched, still rendered on every surface.

## 6. UX problems found (driving this pass's redesign choices)

1. Today is a single vertical stack — no hierarchy, no scanning structure, dense
   11px text throughout regardless of importance.
2. Market gainers/losers are a raw 2-column list with no sentiment/turnover context
   next to them.
3. No visible "how fresh is this data" signal on Today beyond the small header
   market pill.
4. No compact overview of the day's signal mix before the full detailed cards.
5. No quick navigation shortcuts — every cross-tab action requires the top tab bar.

## 7. Migration strategy for this pass

1. **Design tokens** (`src/design-system/tokens.js`) — colors, spacing, type scale,
   radii — extracted from the values already in use across `NepseApp.jsx`'s helper
   functions, so this is a naming/centralizing pass, not a new palette invented from
   nothing. Only tokens actually consumed are added (no speculative "complete"
   design-system scaffold — CLAUDE.md: no abstractions beyond what's needed).
2. **App shell** (Phase 2) — the horizontal top-tab strip was replaced by a
   persistent left sidebar nav on desktop (logo/exchange indicator, TABS list with
   the same BUY-count/no-stop-loss badges the old tab bar had, Settings, an
   admin-mode indicator). **Mobile** (Phase 12) gets its own fixed bottom nav bar
   (safe-area-aware, same tab set + badges) instead of inheriting the desktop
   pattern or the old horizontal strip — `app-content` reserves matching bottom
   padding so the last card is never hidden behind it.
3. **Today tab** (Phase 3) — rebuilt into a card-grid layout using the tokens plus
   the existing `card()/btn()/sbox()/SectionHeader/SegBtn` helpers, adding a small
   number of new presentational helpers genuinely needed (a market snapshot hero,
   a gainers/losers tab switcher, a signal-activity stat row, a watchlist mini-row,
   a freshness pill, a scan-progress bar) defined alongside the existing helpers in
   `NepseApp.jsx`, matching the file's own convention rather than forcing an early
   split into many small component files before more than one screen needs them.
4. **Signals tab** (Phase 4) — added a BUY/SELL/HOLD/AVOID filter-chip row + a
   symbol search box, both operating as a client-side `.filter()` over the signals
   already in state (`sigFilter`/`sigSearch` — two new `useState` calls); no new
   fetch, no new endpoint.
5. **Watchlist / Positions / Track Record** — light-touch consistency pass only
   (`SectionHeader` for headings, an explicit "your own record — not agent output"
   label on Positions). Their existing structure/logic already matched the
   redesign's own rules (Positions visually distinct from signals via card color +
   label; Track Record already shows losses + a Wilson-adjusted "conservative" rate,
   not a raw win-rate headline) — not rebuilt.
6. **Paper** — reviewed against the redesign's Paper-trading bar (§17 of the
   brief: clearly simulated, confirmation before every order, never indistinguishable
   from real trading). It already meets this (amber theme, "SIMULATED" labeling
   throughout, a required confirm step nested inside the order ticket) — left
   unchanged rather than churned for no functional gain.
7. **Settings / Admin** — the existing per-section card layout (Exchange, Account,
   My Alerts, then admin config) already matched the redesign's structure; the one
   real gap was visual separation of the admin zone, closed by wrapping
   `AdminDataSources` + `AdminChannels` + the discovery/auto-remove/sector/scan-
   profile cards in one dashed amber-bordered "ADMIN" zone with an explicit
   "system configuration — affects every user" label. The server-side
   `requireAdmin` enforcement (`src/lib/auth.js`) was already the real boundary —
   this only fixes the client-visible framing.
8. **Accessibility (light pass, not a full audit)** — `aria-current="page"` on the
   active sidebar/bottom-nav tab, `aria-label`s on icon-only or symbol-only buttons
   (Settings gear, watchlist/curated-list "x" remove buttons) that previously relied
   on `title` alone. Semantic `<button>` elements and visible text labels were
   already the norm throughout the app (not something this pass needed to fix).

## 8. Verification gates used every pass

`npm run lint`, `npm run build`, `npm test` (Vitest, 337 tests) run after every
edit in this pass. The local dev server was also restarted clean and confirmed
`200 OK` after the full set of changes, including after the final round (mobile
nav + admin zone + accessibility pass). **Not independently visually verified in
a browser** — the Claude-in-Chrome extension was not connected in this session,
so no screenshot-based check was possible; a human visual pass is still owed
before calling any of this pixel-correct, even though every change here is
verified mechanically (lint/build/337 tests/clean server boot after every step).

## 9. Explicitly open items (deferred, not dropped)

- **Human visual QA** — see §8. This is the single biggest open risk: nothing in
  this engagement was seen rendered in an actual browser.
- **A dedicated component-map doc** — deferred until the remaining screens
  (mostly Settings/Admin sub-panels: `AdminDataSources.jsx`, `AdminChannels.jsx`,
  `AuthPanel.jsx`) also move onto the token system, so the doc reflects real reuse.
- **Full WCAG-level accessibility audit** (contrast ratios, full keyboard-nav
  trapping in modals/overlays, screen-reader pass) — only a light, targeted pass
  was done (see item 8 above), not a full audit.
- **NYSE-specific UI treatment** — the redesign didn't touch exchange-specific
  formatting (currency symbol, disclaimer copy); that's still exactly as it was
  before this engagement, tracked separately in `docs/NYSE-MULTI-EXCHANGE.md`.

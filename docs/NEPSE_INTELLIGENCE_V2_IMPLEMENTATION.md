# NEPSE Intelligence V2 — UI/UX Redesign: Implementation Summary

Closing summary for the redesign engagement scoped by the original master brief.
Read `docs/NEPSE_INTELLIGENCE_V2_DISCOVERY.md` first — it has the real architecture,
the route map, the per-tab breakdown, and the real-data-vs-fabricated-data table;
this doc doesn't repeat that, it records what actually got built and what didn't.

**Route map is intentionally not a separate file** — the app has one real route
(`GET /` → `NepseApp.jsx`), already covered in the discovery doc §2.

**Component map** (small enough to inline here rather than a fourth doc):

| Component | File | Used by |
|---|---|---|
| `SectionCard` | `src/design-system/components/SectionCard.jsx` | Settings (Exchange/My Alerts/Discovery/Auto-Remove/Sector Focus), `AdminDataSources.jsx`, `AdminChannels.jsx` |
| `Pill` | `src/design-system/components/Pill.jsx` | `AuthPanel.jsx` (ADMIN/USER), `AdminDataSources.jsx` (LIVE/SAMPLE/DISABLED), `AdminChannels.jsx` (ACTIVE/OFF) |
| `StatusPill` | `src/design-system/components/StatusPill.jsx` | `NepseApp.jsx` Today hero (market sentiment, price freshness) |
| `card()/btn()/sbox()/SectionHeader/ToggleBtn/SegBtn` | local functions in `NepseApp.jsx` | every tab in `NepseApp.jsx` — kept local since nothing outside that file needs them yet (CLAUDE.md: promote to `src/design-system/` only when a second file needs it) |

This table was added *after* a real duplication was found and fixed (see §8) —
it documents actual reuse, not a planned one.

## 1. What was built, by phase

| Phase | Scope | Status |
|---|---|---|
| 0 | Discovery doc | Done |
| 1 | Design tokens (`src/design-system/tokens.js`) | Done |
| 2 | App shell — desktop left sidebar + mobile fixed bottom nav | Done |
| 3 | Today screen redesign | Done |
| 4 | Signals workspace (filter chips + search) | Done |
| 5 (Ask) | Not touched — the existing contextual `openAsk(prefill)` pattern (pre-fills the chat sidebar with a question about the specific signal/position under the cursor) already matches the brief's "contextual, not a blank chatbot" requirement | No change needed |
| 6–9 (Watchlist/Positions/Paper/Track Record) | Light consistency pass (`SectionHeader`, an explicit "not agent output" label on Positions); Paper reviewed and left as-is | Done / reviewed |
| 10 (Settings/Alerts) | Admin zone visually separated (dashed amber border + label) from user-facing settings | Done |
| 11 (Admin) | Same as above — admin surfaces already existed, now visually boxed together | Done |
| 12 (Mobile) | Dedicated bottom nav (not a scaled-down desktop sidebar); `app-content` reserves matching bottom padding | Done |
| 13 (State audit) | Empty/loading/partial/stale states were already present pre-redesign (stalled-scan banner, partial-scan banner, discovered-today banner, per-tab empty states) and were preserved, not rebuilt | Preserved |
| 14 (A11y/perf) | Light pass: `aria-current` on active nav items, `aria-label` on icon/symbol-only buttons. No perf work needed — no new dependencies, no new fetches, everything new here is a `.filter()`/`.map()` over already-loaded state | Light pass only |

## 2. New files

- `src/design-system/tokens.js` — colors, spacing, radii, type scale, fonts.
- `docs/NEPSE_INTELLIGENCE_V2_DISCOVERY.md` — architecture + per-phase decisions.
- `docs/NEPSE_INTELLIGENCE_V2_IMPLEMENTATION.md` — this file.

## 3. Changed files

- `src/components/NepseApp.jsx` — the only component touched. All new UI (hero,
  movers card, signal-activity card, scan-status card, watchlist mini-card, quick
  actions, mobile bottom nav) is defined as plain functions alongside the file's
  existing `card()/btn()/sbox()/SectionHeader/SegBtn` helpers, following the file's
  own convention rather than forcing an early split into many small component files.

## 4. API / backend changes

**None.** Every new UI element reads from state the component already fetches
(`signals`, `market`, `status`, `watchlist`, `brief`, `track`, `portfolio`). No new
route, no new query param beyond what the earlier exchange-isolation fixes already
added this session, no schema change.

## 5. Migration notes

- The sidebar nav reuses the exact `TABS` array (labels, BUY-count and
  no-stop-loss badges) that drove the old horizontal tab bar — behavior is
  identical, only the layout container changed.
- `isMobile` (from the existing `useBreakpoint()` hook) is the single switch
  between "desktop sidebar" and "mobile bottom nav" — no new breakpoint logic
  was introduced.
- Nothing here changes `RLS`, auth, or the scan chain. This was a pure
  presentation-layer pass on top of already-verified data flows.

## 6. Known limitations (see discovery doc §9 for the full list)

The most important one to repeat here: **this was never rendered in an actual
browser during this engagement.** The Claude-in-Chrome extension did not connect
in this session. Every claim of correctness in this doc and the discovery doc is
backed by `npm run lint` (clean), `npm run build` (clean), `npm test` (337/337
passing), and a clean `next dev` boot returning `200` after every change — not by
a human or automated visual check. **Look at `http://localhost:3001` before
treating this as finished.**

## 7. Deduplication pass (component extraction)

A real duplication was found: the "icon-badge + title + subtitle" card header was
hand-written nearly verbatim in 7 places (Settings' Exchange/My Alerts/Discovery/
Auto-Remove/Sector-Focus blocks, plus the standalone `AdminDataSources.jsx` and
`AdminChannels.jsx`), and the small colored status/role badge was independently
reimplemented 4 times (`AuthPanel.jsx`'s ADMIN/USER, `AdminDataSources.jsx`'s
LIVE/SAMPLE/DISABLED, `AdminChannels.jsx`'s ACTIVE/OFF, `NepseApp.jsx`'s market
sentiment/freshness pill). Extracted into `src/design-system/components/`:
`SectionCard`, `Pill`, `StatusPill` (see the component table above) — all three
existing consumer files (`AuthPanel.jsx`, `AdminDataSources.jsx`,
`AdminChannels.jsx`) and the relevant `NepseApp.jsx` sections now import and reuse
them instead of duplicating the markup. A CLAUDE.md standing rule now requires
checking `src/design-system/` before hand-writing a new instance of a
repeated pattern.

Not touched: `NepseApp.jsx`'s own local `card()/btn()/sbox()` helpers were left
where they are — they're already the single shared implementation for every tab
*within* that file (no duplication to fix), and promoting them into
`src/design-system/` before a second file needs them would be exactly the
speculative abstraction CLAUDE.md warns against.

## 8. Suggested next steps, in priority order

1. **Visual QA in a real browser** — the one thing this engagement could not do.
2. A real mobile device/emulator pass on the new bottom nav (6 tabs at 8px font on
   a 375px screen is tight — verify it doesn't clip on the smallest supported width).
3. Decide whether "Ask" deserves a more prominent, search-bar-styled entry point
   (the master brief's mockup shows it as a top-bar search field) vs. the current
   toggle button — this was deliberately left as a toggle to avoid implying it's a
   stock-symbol search when it's actually a chat trigger with prefillable context.

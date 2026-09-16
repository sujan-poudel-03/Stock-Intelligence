# NEPSE Intelligence V2 — UI/UX Redesign: Implementation Summary

Closing summary for the redesign engagement scoped by the original master brief.
Read `docs/NEPSE_INTELLIGENCE_V2_DISCOVERY.md` first — it has the real architecture,
the route map, the per-tab breakdown, and the real-data-vs-fabricated-data table;
this doc doesn't repeat that, it records what actually got built and what didn't.

**Route map and component map are intentionally not separate files.** The app has
one real route (`GET /` → `NepseApp.jsx`) and, until more screens share the new
token system, only a handful of new reusable pieces — both are already fully
covered in the discovery doc (§2 route map, §5 preserved logic) and in the source
comments next to each new component. Splitting them into their own docs now would
be three thin files describing the same handful of facts (CLAUDE.md: no
abstractions/artifacts beyond what's needed).

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

## 7. Suggested next steps, in priority order

1. **Visual QA in a real browser** — the one thing this engagement could not do.
2. Settings/Admin sub-panel visual pass (`AdminDataSources.jsx`, `AdminChannels.jsx`,
   `AuthPanel.jsx` still use their own pre-redesign inline styles).
3. A real mobile device/emulator pass on the new bottom nav (6 tabs at 8px font on
   a 375px screen is tight — verify it doesn't clip on the smallest supported width).
4. Decide whether "Ask" deserves a more prominent, search-bar-styled entry point
   (the master brief's mockup shows it as a top-bar search field) vs. the current
   toggle button — this was deliberately left as a toggle to avoid implying it's a
   stock-symbol search when it's actually a chat trigger with prefillable context.

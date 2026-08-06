# User Tiers & Product Scope

Who uses a secondary-market system, what each tier seeks, where **NEPSE Intelligence**
fits, and the genuine requirements that follow. Companion to `docs/CASE-STUDY-GAPS.md`
(engineering gaps), `docs/LAUNCH-GATES.md` (legal/track-record gates), and the Production
roadmap in `CLAUDE.md`.

Status legend: ✅ shipped · 🟡 partial · 🔧 planned/scoped · ⛔ deliberately out of scope

---

## 0. Positioning (the anchor for every decision below)

We are an **analyst copilot, not a broker** (Phase-0 decision, `CLAUDE.md`): we present
research + a transparent track record, framed as education; **the user makes and owns the
trade** and executes at their own broker. This single choice determines the whole tier
map: we go deep on *analysis, learning, and trust*, and we **decline execution**. It also
means our natural centre of gravity is the **intermediate** tier — the mass of the retail
distribution — which we then extend *down* (a beginner on-ramp) and *up* (pro-grade
transparency), without becoming a trading venue.

---

## 1. The three user categories

| Tier | Who they are | What they seek | Our stance |
|---|---|---|---|
| **Beginner / Novice** | New to stocks, small capital, intimidated by jargon | Paper trading, plain-English translation, safety guardrails, curated watchlists | **On-ramp** — build the safe entry (paper trading, glossary, curated/system watchlist) |
| **Intermediate / Active retail** | Knows the basics, live portfolio, researches on the side | Smart screeners, portfolio-health/diversification alerts, news sentiment, basic risk mgmt (stop/target) | **Our sweet spot** — already strong, keep deepening |
| **Advanced / Pro** | Day/swing traders, HNW, treat the market as a primary focus | Ultra-low-latency execution, complex order types, deep backtesting, API/algo | **Selective** — deliver *transparency/backtest*, **decline execution/latency** (not a broker; NEPSE isn't an HFT venue) |

---

## 2. Capability matrix — what each tier seeks vs. what we have

### Beginner
| Sought capability | Status | Notes / ref |
|---|---|---|
| Educational "not advice" framing | ✅ | Persistent banner + per-signal + alert disclaimers |
| Plain-English **jargon translation** (tooltips/glossary) | 🔧 | Ask chat explains on request; **no tooltips/glossary** — planned (§4.3) |
| **Paper trading** (simulated account) | ✅ | SHIPPED — virtual-cash sim, net-of-charges + CGT, NEPSE-only (§4.1) |
| Safety guardrails / risk blocks | 🟡 | Liquidity filter + stop/target on every signal; no leverage/options exist to block (NEPSE cash market) |
| Curated / starter watchlists | 🔧 | **Missing** — solved by the system/seed watchlist (§4.2) |
| Guided onboarding / first-run help | 🔧 | Empty states are bare — planned (§4.3) |

### Intermediate
| Sought capability | Status | Notes / ref |
|---|---|---|
| Natural-language Ask | ✅ | The Ask agent |
| **Portfolio health & diversification** alerts | ✅ | Sector concentration + >40% flag (`3d52156`) |
| Net-of-charges P&L / cost basis | ✅ | `charges.js` + `/api/portfolio/summary` |
| Transparent track record | ✅ | Our differentiator (`/api/track-record`) |
| Basic risk mgmt (stop/target) | ✅ | Every signal carries target/stop + distance; breach alerts (`6677f86`) |
| **Smart NL screener** / idea generation | 🟡 | Automated *discovery* exists; **no user-driven screener** — planned (§4.4) |
| **News / sentiment** (per-stock) | 🟡 | Market-level sentiment only; **no per-stock news feed** — planned (§4.5) |

### Advanced / Pro
| Sought capability | Status | Notes / ref |
|---|---|---|
| Deep **backtesting** | 🟡 | Engine built (no-look-ahead real); **needs a historical-data feed** (Tier-3) |
| Cross-verified data sources | ✅ | merolagani + sharesansar cross-check live (`710e70c`); official NEPSE = 3rd source when token set |
| Execution-grade **freshness/latency** markers | 🟡 | as-of/stale now shown (`5abab4a`); no ms-latency/precise UTC per quote (§4.6) |
| System-health / source-status widget | 🔧 | Errors logged; no at-a-glance "7/8 sources healthy" (§4.6) |
| Data **export / API / webhooks** | 🔧 | None for end-users — scoped, likely deferred (§4.7) |
| Complex order types / routing / execution | ⛔ | **Declined** — we're not a broker (§5) |
| Sub-second order routing / co-location | ⛔ | **Declined** — NEPSE is a T+2 daily/swing market, not HFT (§5) |

---

## 3. UAT findings → tracked requirements

From the progressive (Beginner→Intermediate→Pro) UAT passes:

| Finding | Tier | Status |
|---|---|---|
| Alerts off, no warning re missing server keys | all | ✅ Fixed (`5abab4a`) — inline channel-config warning |
| No freshness / as-of marker | Int/Pro | ✅ Fixed (`5abab4a`) — as-of + stale badge |
| Email plaintext next to ADMIN badge | all | ✅ Fixed (`5abab4a`) — masked |
| Index chip blank until manual scan | all | ✅ Fixed (`5abab4a`) — last-known market on load |
| Scan stalled at 0/N | all | ✅ Fixed — local-drain (localhost/self-host; prod self-heals). Validated live: 0/1→1/1, signal produced. |
| Signals "0" while log shows past signals | Int | ✅ Fixed — `pickSignalsScan` falls back to the last scan with signals |
| Watch "empty" but log says auto-added | Int | ✅ Fixed (honesty) — auto-promotion was removed; empty-state + dead admin settings marked so. Real fix = system watchlist (§4.2) |
| Data-source errors buried in log, no per-ticker badge | Int | 🔧 Planned — inline "data unavailable" badge |
| No jargon tooltips/glossary | Beg | 🔧 Planned (§4.3) |
| No onboarding / empty-state guidance | Beg | 🔧 Planned (§4.3) |
| No paper-trading action | Beg | 🔧 Planned (§4.1) |
| Sub-ms latency markers | Pro | 🟡 Partial — as-of shown; ms-latency (§4.6) |
| NYSE not enabled / no market switcher | Pro | 🟡 Config — `ENABLE_NYSE` + surface a switcher (§4.6) |
| No API/export | Pro | 🔧 Scoped, likely deferred (§4.7) |
| Settings copy overstates "multiple sources cross-checked" | Pro | 🔧 Planned — correct copy to reflect the *active* source count |

---

## 4. Scoped requirements (the genuine new work)

### 4.1 Paper trading — the beginner flagship ✅ SHIPPED
**Serves:** Beginner (the #1 ask) — and safely, since it involves no real money, no broker,
and no execution/legal exposure.
**What it is:** a simulated account with virtual cash (NPR 1,000,000 starting). "Buy"/"Sell"
a symbol fills at the **verified live price** (the ground-truth layer — the fill FAILS CLOSED
and rejects the order if the price can't be verified, never guessing); positions and P&L
track using the **same net-of-charges engine** (`charges.positionPnl` + `portfolioMath`),
so simulated P&L is net of NEPSE charges AND CGT and realistic. A confirmation step + a
persistent amber "SIMULATED — not real money / not advice" label on every surface.
**Shipped:** SEPARATE per-user `paper_accounts` + `paper_positions` tables (migration
`20260810000000_paper_trading.sql`, owner-only RLS, WRITE-ISOLATED from the scan chain —
nothing in scan/track-record/weights/knowledge reads them), gated behind a
`paperTradingReady()` schema-flag probe so an unmigrated DB is byte-for-byte as today
(`enabled:false`). Pure fill/cash math in `src/lib/paperTrade.js` (WACC average cost of fill
prices only; whole-share integer qty; caps `MAX_ORDER_QTY` + `MAX_OPEN_POSITIONS`=20;
Vitest-tested). Server assembly in `src/lib/paperSummary.js` (equity/return% layer over the
shared portfolio math, bounded ≤5 on-demand verified-price fallback). Routes:
`GET /api/paper` (summary), `POST /api/paper/order` (one `getVerifiedPrice`, fail-closed),
`POST /api/paper/reset`. UI: an amber, visually-distinct **Paper** tab with an order ticket
(curated/watchlist symbol picker, Buy/Sell, integer qty, an indicative pay/receive-incl-charges
preview, and a confirmation step), the account view (cash/equity/return%/open positions), and
a reset-behind-confirm.
**Reuses:** `getVerifiedPrice`, `portfolioMath.buildSummary`, `charges.legCharges/positionPnl`.
**In scope:** virtual buy/sell at live price, cash balance, positions, realized/unrealized
P&L, reset. **Out of scope:** real orders, leverage, options, non-NEPSE exchanges (v1),
user-set/backdated fill prices (anti-gaming — fills only at the current verified price).
**Approximations (documented):** `buy_price` is the qty-weighted average of FILL PRICES ONLY
(charges are not folded in — `positionPnl` recomputes the buy leg's charges on exit);
`opened_at` is the FIRST buy and is never reset by later adds, so the CGT hold-days clock
for the whole position runs from the earliest buy (a simplification vs. per-lot tax lots).

### 4.2 System / seed watchlist ✅ SHIPPED
**Serves:** Beginner (curated starter watchlist) **and** the platform (seeds the scan so
signals flow before users add watchlists) — and it's the *correct* fix for the Watch-empty
issue (auto-promotion's replacement). **Honors the guardrail:** it's a GLOBAL, admin/curated
(or discovery-fed) list that's globally readable and unioned into the scan — NOT a write to
every user's per-user watchlist.
**Shipped:** a dedicated GLOBAL `system_watchlist` table (migration
`20260809000000_system_watchlist.sql`, public-read/service-write RLS like
`corporate_actions`, seeded with 10 NEPSE blue-chips via `INSERT … ON CONFLICT DO
NOTHING`), gated behind a `systemWatchlistReady()` schema-flag probe so an unmigrated DB is
byte-for-byte as before. `cron/scan loadWatchlist` folds it into the scan union with ONE
extra global DB read (no market/LLM I/O) via `buildScanUniverse`. Auto-promotion is
REINSTATED into this list in `scan/brief` (HOLD symbols over `watch_promote_min` across the
recent window, liquidity-filtered at write time, `source='discovery'`), gated on
`settings.auto_promote_on` (default on). Admin curation via `POST /api/admin/system-watchlist`
(add/deactivate/remove, `requireAdmin`); public read via `GET /api/system-watchlist`
(anon, edge-cached) so signed-out users see the curated universe. The Watch tab renders it as
a DISTINCT "Curated watchlist (scanned for everyone)" section, never merged into the user's
own rows. **Not reinstated:** auto-PRUNE/removal from the shared list (a per-user "stale"
judgement doesn't map cleanly onto a global list) — the Settings "Auto-Remove" control stays
inactive.

### 4.3 Plain-English layer 🔧
**Serves:** Beginner. Jargon tooltips/glossary (EPS, P/E, book value, "BEARISH",
"conservative 12%", net vs gross) across signals + the stock overlay, and contextual
empty-state help / a light first-run tour.

### 4.4 Natural-language screener 🔧
**Serves:** Intermediate. NL screening over signals + fundamentals ("dividend payers, low
P/E, healthy turnover"), turning automated discovery into user-driven idea generation.

### 4.5 Per-stock news / sentiment 🔧
**Serves:** Intermediate. Aggregate recent headlines per symbol into a positive/neutral/
negative indicator (LLM reasons over fetched headlines; never sets prices).

### 4.6 Pro transparency 🟡→🔧
**Serves:** Advanced/Pro. Precise UTC timestamp + measured latency per quote; a system-health
widget ("N/M sources healthy"); a per-ticker "data unavailable" badge; enable NYSE
(`ENABLE_NYSE`) + a market switcher; correct any settings copy that overstates cross-checking.

### 4.7 Data export / API 🔧 (likely deferred)
**Serves:** Advanced/Pro. Read-only signal/track-record export (CSV/JSON) or a documented
read API for piping into their own tools. Scoped but low priority vs. the beginner on-ramp.

---

## 5. Explicitly OUT of scope (honest declines, not gaps)

- **Order execution, routing, complex order types (OCO, bracket, multi-leg).** We are a
  copilot, not a broker. This is a regulatory + product decision, not a missing feature.
- **Real-money trading of any kind.** Signals + simulation only.
- **Sub-second / co-located low-latency execution.** NEPSE is a T+2, daily/swing market; HFT
  latency is the wrong goal for this domain. We provide *honest freshness*, not execution speed.
- A licensed **pro execution tier** remains a *future* door (post-licence, post-track-record) —
  A→B stays open, but is deliberately not built now.

---

## 6. Sequencing

1. **Stabilize the core (now):** scan-drain (local/self-host), Signals last-known fallback,
   honest watchlist copy. *(Bug-fix batch in flight.)*
2. **Beginner on-ramp:** paper trading (§4.1) → system/seed watchlist (§4.2) → plain-English
   layer (§4.3). Captures the novice inflow safely and converts it toward intermediate.
3. **Intermediate deepening:** NL screener (§4.4) → per-stock sentiment (§4.5).
4. **Pro transparency:** freshness/latency + health widget + NYSE switcher (§4.6); export/API
   (§4.7) if demanded.
5. **In parallel, always:** the launch gates — SEBON legal read + the 60–90d live track record
   (`docs/LAUNCH-GATES.md`). These gate *marketing*, independent of feature work.

**Bottom line:** we own the intermediate middle and just hardened it. The highest-leverage
growth move is the **beginner on-ramp led by paper trading** — high value, safe, and it
reuses the engine we already built. Pro depth is selective: transparency yes, execution no.

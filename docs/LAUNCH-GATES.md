# Launch Gates — what stands between "built" and "marketable"

The engineering is built, deployed, and verified (see `docs/PHASE2-MULTITENANT.md`
for the multi-tenant model and the acceptance evidence below). What remains before
marketing to real/paying users is **not engineering** — it's a legal read, live
track-record time, and a pricing decision. This doc tracks those, plus the
tier/entitlement extension point that makes paid tiers a drop-in later.

Status legend: ✅ done · ⏳ in progress / needs owner · ⛔ external gate · ❌ not started

---

## 1. SEBON legal read — the go/no-go ⛔ (start now, in parallel)

Publishing BUY/SELL signals to real users implicates SEBON (Securities Board of
Nepal) investment-adviser regulation. This is a go/no-go, not a footnote.

**Owner action:**
1. Engage a **Nepal securities lawyer** (SEBON-registered practice).
2. Obtain a written opinion on:
   - (a) Does publishing **educational** BUY/SELL signals require an **investment-
     adviser licence** under SEBON rules?
   - (b) Is the current "educational, not investment advice" disclaimer **sufficient**,
     or must the framing/wording change?
   - (c) Can you **charge** for it later, and under what structure/licence?
   - (d) **merolagani ToS** — is commercial scraping permitted, or is a data
     agreement/licence required? (We already scrape price + fundamentals from the
     same page; this is the P3-1 caveat in CLAUDE.md.)
3. Have them draft/review **Terms of Service + Privacy Policy**.

**Deliverable:** a go/no-go decision + any required disclaimer/licence/wording
changes. **Engineering guidance only — this is not legal advice.**

## 2. SEC / FINRA (US / NYSE) ⛔ (only if serving US users)

NYSE is enabled but dormant. If you will serve **US** users, get the equivalent US
securities read (SEC/FINRA investment-adviser rules) before exposing NYSE signals
publicly. Not needed while NYSE stays internal/off.

## 3. Live track record — 60–90 days ⛔ (calendar time; nothing to build)

The differentiator is a **transparent, real** track record. It needs to accrue live.

**Already true (verified):** the scheduler fires (green scheduled runs), and outcomes
resolve to WIN/LOSS with the learning weights updating (verified: 3 outcomes, weights
populated). So the machinery works — it just needs time + volume.

**Owner action:** basically none — **keep it running** for 60–90 days and watch
`/api/track-record` fill up. The one thing to ensure is that **the scan universe has
symbols** so signals keep flowing:
- Sign in once → migrate the operator watchlist (`CORBL/SMJC/JHAPA`), and/or
- add a seed/system watchlist (deferred follow-up), and/or
- let users add watchlists (their union feeds the scan).
Full scans (2×/day, discovery-driven) already produce signals regardless.

**Then:** publish the real numbers and market on verified results — not before.

---

## 4. Tier / entitlement model — the billing EXTENSION POINT ✅ (built, dormant)

Billing is **deliberately not built** (free, OAuth-gated). But the app is now wired so
a paid model is a **drop-in later, not a re-architecture**:

- **`subscriptions` table** (migration `20260806120000_subscriptions.sql`): one row
  per user — `tier` (default `'free'`), `status`, `provider`, `current_period_end`.
  RLS: a user may **read** their own tier; only the **service role writes** it — so a
  user can't self-upgrade; an **admin action or a billing webhook** sets the tier.
- **`src/lib/entitlements.js`**: `TIERS` (the free/pro capability matrix — signals
  limit, watchlist limit, alerts, history, chat quota, exchanges), pure
  `entitlementFor(tier)`, and `getUserTier` / `getUserEntitlements`.

**How it becomes admin-controlled feature gating later** (all wiring, no re-design):
1. Read/feature routes call `getUserEntitlements(user)` and slice the shared output
   (e.g. free = first N signals, no alerts/history; pro = full) — the scan stays one
   global cost, tiers only gate *how much of it* a user sees + which per-user features.
2. An **admin endpoint** (or a billing webhook: eSewa/Khalti/Stripe) writes
   `subscriptions.tier` via the service role → the user's entitlements change instantly.
3. `TIERS` can later be made admin-configurable if you want to tune limits without a
   deploy.

So: **admin/tier control of feature availability is the intended design**, and the
foundation is in place today — everyone is `free` until a paid tier + gateway are
switched on (post-legal, post-track-record).

---

## Acceptance snapshot (what's verified vs pending)

**Verified with evidence (this project):**
- ✅ Full scan runs end-to-end → signals + brief written (dev-run + green scheduled runs)
- ✅ Real merolagani prices + **fundamentals** (EPS/P&E/52-week/BV/PBV/div/yield) — live-verified
- ✅ **Signed-in tenant flow + two-user isolation** — 11/11 with real JWTs against live
  routes; DB-level RLS confirmed (a user's raw query returns only their rows)
- ✅ Outcomes → learning loop resolves WIN/LOSS + updates weights
- ✅ `/api/storage` anon-write closed; per-user routes 401 without a token; admin config
  server-enforced; scan trigger admin-only
- ✅ RLS on; security-reviewed; PWA + responsive; 150+ unit tests / lint / build green

**Built but not fully exercised / open:**
- ⏳ Google **OAuth button** UI (the token path is proven; the button is a manual click)
- ⏳ **NYSE produces signals** (data-layer verified; no NYSE scan has written signals yet)
- ⏳ Cross-source price **agreement** (only merolagani is live → single-source; needs a
  2nd NEPSE source: implement `sharesansar` or add a `nepalstock` token)
- ⏳ Per-user **alert delivery** (prefs stored; delivery deferred — needs per-user
  destinations)
- ⏳ Intraday **light** scans (empty watchlist → seed/migration needed)
- ⏳ Degradation (budget-spent → deterministic) is unit-tested, not live-triggered
- ⏳ EWMA decay counters (`dwins/dlosses`) not populating — small follow-up

**Bottom line:** the system works and is deployed; the product is not "launch-passed"
until the **legal read** clears and a **credible live track record** exists.

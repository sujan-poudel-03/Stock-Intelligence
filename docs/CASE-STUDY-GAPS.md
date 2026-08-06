# Case Study — NEPSE Intelligence vs. the Real Job of a Retail Swing Trader

A code-grounded gap analysis: what the product does today vs. what a real NEPSE
swing trader needs, and the concrete gaps between them. Companion to
`docs/LAUNCH-GATES.md` (external gates) and the Production roadmap in `CLAUDE.md`.

Severity legend: 🔴 Tier 1 = corrupts the core value (financial truth / track record) ·
🟠 Tier 2 = blocks real usage · 🟡 Tier 3 = maturity / scale / dormant assets.

---

## 1. The lens — who uses this and for what

**Persona:** Ramesh, a NEPSE retail swing trader. ~Rs 5 lakh across 6–8 scrips,
checks his phone before the 11:00 open, holds days-to-weeks. Jobs-to-be-done:

1. *"What's worth watching today?"* — discovery / brief
2. *"Is NABIL a buy right now, and at what level?"* — per-symbol signal
3. *"Help me manage the trade — stop, target, when to exit?"* — position management
4. *"Tell me the moment something changes."* — alerts
5. *"Why trust you over the tip-sellers?"* — track record

Phase-0 decision (`CLAUDE.md`): be the **transparent analyst copilot whose
credibility is a real, honest track record.** Every gap below is judged against
that promise — and the track record is the thing most at risk.

## 2. What the product genuinely does today

| Capability | State | Reality |
|---|---|---|
| Verified price + fundamentals (EPS, P/E, 52w, BV, PBV, div/yield) | ✅ Real | Live merolagani scrape; price is ground-truth, LLM barred from setting it |
| BUY/SELL/HOLD/AVOID signals (target, stop, `why`, risk) | ✅ Real / ⚠️ | `src/lib/scan.js` — targets are flat 5%/8% when the LLM omits them |
| Outcome resolution → WIN/LOSS → weights + knowledge | ✅ Real / ⚠️ | `src/lib/outcomes.js` — spot-price only, not path-dependent |
| Learning loop (weights + knowledge injected into prompts) | ✅ Real | Advisory only — no number ever gates a decision programmatically |
| Track record (win rate, Wilson LB, by direction/sector) | ✅ Real | `src/app/api/track-record/route.js`, computed from ground truth |
| Daily brief | ✅ Real | LLM + deterministic fallback |
| Watchlist / portfolio storage, tiers, multi-tenancy, chat | ✅ Real | Portfolio = storage only; P&L is client-side |
| Backtest engine, Thompson sampling, Shadow-B, EWMA decay | 🟡 Dormant | Correct code, **no data feed / never invoked in production** |
| Cross-source price agreement, alert delivery, NYSE | 🟡 Wired, not operational | Single source / prefs-only / feature-flag off |
| Circuit bands, corporate actions, liquidity, T+2, holidays | ❌ Absent | Exchange structural realities not modeled |

## 3. Case study — one real trade, end to end

A single BUY on **NABIL (bank)** through the pipeline (✅ holds · ⚠️ weak · ❌ breaks):

| Stage | What happens | Verdict |
|---|---|---|
| Discovery | Movers → LLM picks 8 candidates, biased by learned leaderboard | ✅ Works · ❌ no liquidity gate → can pick an illiquid scrip Ramesh can't fill |
| Signal | Verified Rs 500, target Rs 540 (+8%), stop Rs 475 (−5%), `why` + fundamentals | ✅ Transparent · ⚠️ flat %s, not volatility/band-aware; `confidence` is HIGH/MED/LOW, no probability |
| Ramesh acts | Buys; logs in portfolio; wants net break-even | ⚠️ portfolio stores rows only; P&L ephemeral; **no charges/CGT in any stored number** |
| Alert | Expects a ping on target/stop | ❌ **never reaches him** — all alerts go to one hardcoded inbox; `alert_prefs` is dead config |
| Outcome | Next scan compares price to target/stop | ⚠️ **spot-price only** — an intraday spike to target then fade is invisible; no time-stop → PENDING forever |
| NABIL goes ex-bonus (10%) | Price mechanically drops ~9% overnight | ❌ **catastrophe** — resolver records a **false LOSS**; plausibility guard may reject the legit post-ex quote; learning absorbs a loss that never happened |
| Track record | The false LOSS lands in the win rate | ❌ the differentiator is **silently corrupted** by NEPSE's most common corporate action |

**Punchline:** the pipeline is clean and honest until it meets the actual mechanics
of the Nepal Stock Exchange — then the number the product sells gets poisoned.

## 4. Gap analysis, by severity

### 🔴 Tier 1 — corrupts the core value (fix before marketing)

| Gap | Market reality | Consequence |
|---|---|---|
| No corporate-action adjustment (bonus, rights, dividend, split, book-closure) | NEPSE runs on bonus/rights issues; most active scrips do one yearly | False LOSSES, rejected legit quotes, poisoned learning + track record |
| Single live price source — cross-check never runs | merolagani only; sharesansar/nepalstock are stubs | "verified / cross-source agreement / fails-closed" is **nominal, not real** |
| Outcome resolution spot-price, not path-dependent + no time-stop | Real trades resolve by first-touch; positions expire | Win rate measures "where price sat when cron ran"; signals live PENDING forever |
| No net-of-charges / CGT return | Broker 0.4%, DP Rs25, CGT 7.5%/5% materially change small-move outcomes | Every reported return is gross — overstates edge |

### 🟠 Tier 2 — blocks genuine usability

| Gap | Why it matters |
|---|---|
| Per-user alert delivery | A signal service that can't tell *you* when your stock moves isn't a service. `alert_prefs` has no consumer |
| Liquidity / volume filter | Half of NEPSE is thin — a BUY you can't fill/exit is worse than none |
| Signal-flip & user-set price alerts | Only target/stop crosses fire; a HOLD→SELL on a held position is silent |
| Server-side portfolio P&L / cost basis / exposure | Can't answer "how am I doing / over-concentrated in banks?" — math lives only in the browser |

### 🟡 Tier 3 — maturity, scale, dormant assets

| Gap | Note |
|---|---|
| Backtest has no historical data | Engine correct + no-look-ahead real, but no OHLC store to replay |
| Thompson / Shadow-B / EWMA decay dormant | Computed/tested, never wired to select; `dwins/dlosses` not populating (known) |
| NYSE off; both markets single-source; no true intraday | NYSE needs `ENABLE_NYSE`; NEPSE is 30-min light polling, not tick |
| No enforced trading calendar / holidays / T+2 | Hours are display + cron only |

## 5. The single most important finding

> **NEPSE's most routine event — a bonus or rights issue — systematically records
> false losses and corrupts the track record, which is the entire differentiator.**

Everything else is a feature gap. This is a *truth* gap: the honest track record you
plan to market on is quietly wrong in a direction you can't currently detect. It sits
at the intersection of three Tier-1 gaps (corporate actions × spot-price resolution ×
single-source verification) and is the first thing a knowledgeable NEPSE user catches.

## 6. Recommended sequencing (mapped to the roadmap)

1. **Corporate-action awareness (Phase 1 extension — do first).** Ingest
   ex-bonus/ex-rights/ex-dividend dates; adjust stored target/stop and outcome
   comparison across the ex-date, or void/re-baseline the signal. Protects the track
   record *before* it accrues 60–90 days of poisoned data.
2. **Second NEPSE source → real cross-check (Phase 1).** Implement sharesansar or
   wire the nepalstock token so `reconcile()`'s agreement path actually runs.
3. **Path-dependent outcome + time-stop + net-of-charges (Phase 1.5).** WIN/LOSS by
   first-touch + max-hold expiry; store net-of-charges return. Makes the track record
   both correct and realistic.
4. **Per-user alert delivery + liquidity filter (Phase 2 follow-up).** Turn
   `alert_prefs` into real notifications; add a turnover gate to discovery.
5. **Then** the dormant assets (backtest data feed, Thompson wiring, NYSE) — *after*
   the track record is trustworthy.

**Bottom line:** the build quality is high and the copilot framing is right. The gaps
aren't in craftsmanship — they're the distance between a clean generic signal pipeline
and the specific, messy mechanics of the Nepal Stock Exchange. Closing Tier 1 turns
"a working build" into "a track record you can stake the brand on."

---

## Update — 🔴 Tier 1 CLOSED (2026-08-06)

All three financial-truth gaps are implemented, tested, migrated to prod, and shipped:

- ✅ **#1 Corporate-action awareness** (`4560a23`). Global `corporate_actions` table +
  deterministic, LLM-free merolagani announcement scraper. Ex-dates adjust target/stop
  from immutable originals (idempotent); uncomputable → SUPPRESS (never a false LOSS);
  stuck-too-long → VOID (excluded from learning). Plausibility guard accepts the
  mechanical ex-move via an opt-in `caFactor`. Live-validated (NORVIC bonus + dividend).
- ✅ **#2 sharesansar 2nd live source** (`710e70c`). Cross-source agreement now actually
  runs; observed spread vs merolagani was 0.00% across 10 liquid symbols, so the 1.0%
  tolerance is unchanged. Board-scrape (fetch-once-per-cycle, header-mapped). Owner
  activates with `MARKET_DATA_SOURCES=merolagani,sharesansar`.
- ✅ **#3 Realistic outcomes** (`c816f7c`). Path-dependent WIN/LOSS at daily High/Low
  (stop-first tie-break), a time-stop (`EXPIRE` at the hold horizon), and net-of-charges
  return (tiered NEPSE commission + SEBON + DP + CGT on a Rs 100k notional) — net is now
  the track-record headline, gross shown alongside. Composes with #1 (first-touch scoped
  to the non-CA path). Also fixed a 10× SEBON-rate error in the chat prompt.

Every change is gated behind schema-flag probes (byte-for-byte on an unmigrated DB) and
never throws into the scan/outcome flow.

### New follow-up discovered during #3 (pre-existing, not yet fixed)
- **SELL-direction target geometry.** `calcTargets` (`src/lib/scan.js`) auto-fills
  target ABOVE / stop BELOW entry regardless of direction — correct for BUY, backwards
  for a SELL. So SELL signals with auto-filled levels are mis-targeted (LLM-supplied SELL
  levels are fine, and #3's resolver + EXPIRE learning label are now direction-aware).
  Retail can't short NEPSE, so a SELL is really "exit/avoid" guidance — but the geometry
  should still be direction-correct. Needs its own small fix. **Tier 2 candidate.**

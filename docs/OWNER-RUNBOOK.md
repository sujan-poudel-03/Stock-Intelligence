# Owner Activation Runbook

The one place that lists the switches to turn the built features ON, in order. Deep
setup (Google OAuth, Supabase provider config) lives in `docs/DEPLOYMENT.md §5`; this is
the short activation checklist. **Security: never paste real keys into chat, commits, or
screenshots — enter them directly in the Vercel / Supabase dashboards.** The service-role
key must stay server-only (never `NEXT_PUBLIC_`).

Legend: 🔴 required to run · 🟠 activates a shipped feature · ⚪ optional

---

## 1. Environment variables (Vercel → Project → Settings → Environment Variables)

| Var | Tier | What it does |
|---|---|---|
| `SUPABASE_URL` | 🔴 | Server Supabase URL |
| `SUPABASE_ANON_KEY` | 🔴 | Server anon key (public reads) |
| `SUPABASE_SERVICE_ROLE_KEY` | 🔴 | **Server-only.** Cron/scan writes, bypasses RLS. Never `NEXT_PUBLIC_`. |
| `NEXT_PUBLIC_SUPABASE_URL` | 🔴 | Client auth (Google sign-in) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | 🔴 | Client auth |
| `GEMINI_API_KEY` | 🔴 | LLM (default provider). Or `ANTHROPIC_API_KEY` + `LLM_PROVIDER=claude`. |
| `CRON_SECRET` | 🔴 | Scheduler auth — the GitHub Action attaches it to trigger scans |
| `APP_BASE_URL` | 🔴 | Base URL the scheduler hits (e.g. `https://your-app.vercel.app`) |
| `ADMIN_EMAILS` | 🟠 | Comma-separated Google emails that are admins. **Blank = admin gate OPEN** (single-operator). Set it to enforce. |
| `MARKET_DATA_SOURCES` | 🟠 | Set to `merolagani,sharesansar` to turn ON the two-source cross-check (else single-source). |
| `RESEND_API_KEY` | 🟠 | Turns ON email alert delivery (per-user watchlist-flip + outcome alerts, and the operator digest). Without it, alerts are a silent no-op. |
| `ALERT_TO` | ⚪ | Operator digest recipient (defaults to the built-in operator address) |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | ⚪ | Operator Telegram digest (per-user Telegram is a future item) |
| `NEPALSTOCK_API_TOKEN` | ⚪ | Enables the official NEPSE source (a 3rd cross-check) once you have a token |
| `VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY` | 🟠 | Turns ON real browser push delivery (per-user watchlist-flip + outcome alerts). Generate with `node scripts/generate-vapid-keys.mjs` — see §4c. |
| `ENABLE_NYSE` | ⚪ | `true` to enable the NYSE market (Yahoo source). Off by default. |
| `NEXT_PUBLIC_REQUIRE_LOGIN` | ⚪ | `true` = hard login wall before the app renders (hides the public track record). Keep off for a public marketing surface. |

> The GitHub Actions scheduler also needs `APP_BASE_URL` + `CRON_SECRET` as repo secrets
> (Settings → Secrets → Actions) so the cron can reach your deployment.

## 2. Google Sign-In (one-time)

Follow `docs/DEPLOYMENT.md §5`: enable the Google provider in Supabase Auth, create the
Google Cloud OAuth client, and add the redirect URLs. Until the `NEXT_PUBLIC_SUPABASE_*`
env is set, the app runs in single-operator "open" mode (you see everything, no sign-in).

## 3. Make yourself admin

Set `ADMIN_EMAILS` to your Google email. This flips the admin gate from OPEN to
ENFORCED — `/api/admin/*` (data-source config, scan trigger, tier control) then reject
non-admins server-side. Verify: sign in, and Settings should show the admin-only
surfaces (Market Data Sources, Notifications).

## 4. Activate the shipped features

- **Two-source price verification:** set `MARKET_DATA_SOURCES=merolagani,sharesansar`
  (or select both in Settings → Market Data Sources). Both sources agree to the penny in
  testing, so this strengthens verification without over-rejecting.
- **Email alerts:** set `RESEND_API_KEY`. Users then opt in per-channel + per-direction in
  Settings → Alerts. The UI now warns if a channel is enabled but its key isn't set.
- **Per-user Telegram alerts** (closes the "no push/mobile alerts" gap): each user
  links their own chat — separate from the single operator `TELEGRAM_CHAT_ID` used
  for the admin digest. One-time setup:
  1. Create a bot via [@BotFather](https://t.me/BotFather) (`/newbot`) → note the
     **bot token** and the **bot username** (without the `@`).
  2. Set `TELEGRAM_BOT_TOKEN` (shared with the existing operator-digest channel) and
     `TELEGRAM_BOT_USERNAME` (so the app can build a one-tap `t.me/<bot>?start=<code>`
     link instead of asking users to type `/start <code>` by hand).
  3. Generate a random secret and set `TELEGRAM_WEBHOOK_SECRET`, then register the
     webhook once:
     `curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://<your-deployment>/api/telegram/webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>"`.
     This secret is required — without it, anyone who finds the public webhook URL
     could forge a fake Telegram update and redeem another user's link code.
  4. Users then toggle Telegram on in Settings → My Alerts and follow the "link
     telegram" flow that appears — no further owner action per user.

## 4a. Closer-to-intraday scan cadence (optional, closes a real trader gap)

Vercel Hobby's cron scheduler only supports once-daily invocations (why
`vercel.json` schedules `45 4 * * *` and not, say, every 15 minutes) — that's a
platform limit, not a code one. NEPSE trades 11:00–15:00 NPT, so a once-a-day scan
misses intraday moves entirely, which is a real gap for anyone using this for
swing trading. Two ways to close it, in order of effort:

1. **Free external scheduler** (no Vercel plan change): sign up for a free cron
   service (e.g. cron-job.org) and point it at
   `POST https://<your-deployment>/api/cron/scan` with header
   `Authorization: Bearer <CRON_SECRET>`, on a schedule inside trading hours (e.g.
   every 15–30 min, 11:00–15:00 NPT / 05:15–09:15 UTC). The endpoint already accepts
   this exact call shape — it's what Vercel's own cron does — so no code change is
   needed, only the external scheduler's own signup + configuration, which only the
   deployment owner can do (it needs the live URL and secret).
2. **Upgrade off Hobby**: Vercel Pro allows more frequent native cron, removing the
   need for an external scheduler.

Either way, watch the daily LLM budget (`LLM_DAILY_BUDGET`) — more scan cycles per
day means more LLM calls; a 15-minute cadence across a 4-hour trading window is up
to 16x today's call volume if left unchanged, so raising the cadence should come
with either a lower per-cycle symbol count or a higher budget ceiling.

## 4b. NEPSE index benchmark (Track Record tab)

Every scan cycle now records one verified (non-LLM) NEPSE index bar into
`price_history` — a second, independent data source (`merolagani.com/Indices.aspx`,
distinct from the merolagani stock-quote endpoint), so the Track Record tab can show
the index's own buy-and-hold return alongside the agent's real track record. No owner
action needed beyond applying `supabase/migrations/20260917000000_price_history.sql`
(§6 below) — the benchmark box appears automatically once 2+ daily bars have
accrued, and stays silently hidden until then (no historical backfill: the source
paginates via an ASP.NET postback, too fragile to simulate reliably).

## 4c. Push notifications (web) — fully wired

Browser push is a real, third per-user delivery channel now (alongside email and
Telegram): subscription capture (`/api/push/subscribe`, `/api/push/status`) AND
actual RFC 8291-encrypted sending (`src/lib/notify.js` `deliverPush`, via the
`web-push` npm package) are both live, wired the same way as the other two
channels into `src/lib/alertDelivery.js`'s per-user watchlist-flip + outcome
alerts.

**To turn it on:**
1. Generate a VAPID keypair **once per deployment**: `node scripts/generate-vapid-keys.mjs`.
   Keep it stable — rotating it invalidates every existing subscription (users
   would need to reconnect).
2. Set `VAPID_PUBLIC_KEY` (safe to expose) and `VAPID_PRIVATE_KEY` (**server-only,
   never `NEXT_PUBLIC_`**) in Vercel.
3. Users toggle "Browser Push" on in Settings → My Alerts and click "connect
   device" (nested under the toggle, same pattern as Telegram linking) — one
   subscription per browser/device, several per user is fine (phone + laptop).
4. Apply `supabase/migrations/20260919000000_push_subscriptions.sql` if not
   already applied (§6) — until then the toggle is inert (schema-flag-gated).

An expired/revoked subscription (the push service returns 404/410) is pruned
automatically on the next send attempt — no manual cleanup needed. Push has no
"operator digest" equivalent to email/Telegram's `ALERT_TO`/`TELEGRAM_CHAT_ID`
(there's no single operator subscription) — it's purely the per-user channel.

**Verified this session:** `npm install web-push` (previously blocked — see the
note below), `/api/push/vapid-public-key` and `/api/channels` both correctly
reflect `configured:true` once the env is set, and the full test/lint/build suite
passes with the new channel wired in. Full device-connect-and-receive was **not**
exercised end-to-end here: this deployment runs behind `NEXT_PUBLIC_REQUIRE_LOGIN`,
so reaching the toggle needs a real Google sign-in, and `push_subscriptions` isn't
migrated on this dev DB yet — both are exactly the owner-side steps in 3–4 above.

> **Root cause of the earlier "npm registry unreachable" block (now resolved):**
> this machine resolves IPv6 for `registry.npmjs.org` but has no working IPv6
> route, so Node's own fetch hangs (~10s timeout) while `curl` succeeds instantly
> over IPv4. `~/.npmrc` already carries a fix for child processes npm spawns
> (`node-options=--dns-result-order=ipv4first --no-network-family-autoselection`),
> but npm's *own* process doesn't pick that up from `.npmrc` — it needs
> `NODE_OPTIONS` set directly in the environment, e.g.
> `NODE_OPTIONS="--dns-result-order=ipv4first --no-network-family-autoselection" npm install <pkg>`.
> Consider exporting `NODE_OPTIONS` in your shell profile so every `npm` command
> picks it up automatically, not just ones prefixed by hand.

## 5. Seed the scan universe

The scan universe = union of all users' watchlists + discovery. To keep signals flowing:
- Sign in once and add your operator symbols to the watchlist, **or**
- let users add watchlists (their union feeds the scan).
Full scans (2×/day, discovery-driven) produce signals regardless.

## 6. Verify

- `GET /api/health` → `ok:true`, `service_role_ok:true`, budget present.
- `npm run doctor` → all expected tables present.
- Trigger a scan (admin "fresh scan" button) → it should progress to completion and
  populate Signals + the daily brief. *(If it stalls at 0/N, see the scan-reliability note
  in the changelog — production self-heals via the scheduler; a local `next dev` run has
  different background-execution semantics.)*

---

## Not switches — the real launch gates (see `docs/LAUNCH-GATES.md`)

These are **not** env flags; they gate marketing to real users:
1. **SEBON legal read** (+ merolagani ToS, + SEC/FINRA if serving US/NYSE users).
2. **60–90 day live track record** — now accruing on trustworthy numbers (post Tier-1).

Keep the scheduler running, let the track record fill `/api/track-record`, and market on
the verified numbers — not before.

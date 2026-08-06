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

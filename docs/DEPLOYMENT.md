# Deployment, Admin & Operations

Everything needed to run NEPSE Intelligence V2 in production, make an admin, and
finish the outstanding owner actions. For architecture rules see `CLAUDE.md`.

---

## 1. Where things run (mental model)

| Layer | Runs on | You configure |
|---|---|---|
| **App + API + cron** | **Vercel** | all runtime **env vars** |
| **Database** | **Supabase** | only the **schema + migrations** (SQL) — no env vars here |
| **Local dev + migration push** | your machine | `.env` / `.env.local` (holds the DB password, which never leaves your machine) |

Market data is **global** — fetched once per scan cycle and shared by all users.
Logging in never triggers a fetch. Only a thin per-user layer (watchlist, alerts,
subscription) is ever added. See the "Market data is GLOBAL" rule in `CLAUDE.md`.

---

## 2. Environment variables — and where each goes

**All of these go in Vercel** (Project → Settings → Environment Variables →
Production), **except `SUPABASE_DB_PASSWORD`** which is local-only.

> Your local `.env` / `.env.local` are gitignored and **not** deployed — Vercel
> never sees them. Re-enter every value in the Vercel dashboard, then redeploy.

| Variable | Purpose | Where |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | database access | Vercel |
| `LLM_PROVIDER` (`gemini`/`claude`) | model provider | Vercel |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | Gemini | Vercel |
| `ANTHROPIC_API_KEY`, `NEPSE_MODEL` | Claude (optional) | Vercel |
| `LLM_DAILY_BUDGET` | daily LLM call ceiling (e.g. 200) | Vercel |
| `CRON_SECRET` | guards cron/worker/brief; Vercel cron sends it | Vercel |
| `MARKET_DATA_SOURCES` | `merolagani` (live) | Vercel |
| `NEPALSTOCK_API_TOKEN` | enables the NEPSE-official source | Vercel (when you have it) |
| `RESEND_API_KEY`, `ALERT_TO` | email delivery | Vercel |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Telegram delivery | Vercel |
| `ADMIN_EMAILS` | admin allowlist (see §4) | Vercel |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | browser auth (Google Sign-In) | Vercel |
| `SUPABASE_DB_PASSWORD` | **only** for `npm run deploy` migrations | **local `.env` only** — NOT Vercel |

A config-gated feature is **active only when its env is present**: no
`TELEGRAM_*` → Telegram off; no `NEPALSTOCK_API_TOKEN` → that source stays disabled;
no `ADMIN_EMAILS` → the admin gate is open. Nothing breaks when unset.

---

## 3. Database setup (Supabase)

1. **Create the schema** — Supabase → SQL Editor → paste `supabase/schema.sql` → Run.
2. **Apply migrations** — either:
   - `npm run deploy` (reads `SUPABASE_DB_PASSWORD` from your local `.env`), or
   - paste each file in `supabase/migrations/*.sql` into the SQL Editor.
3. **Verify** — `npm run doctor` reports table presence **and** whether the
   time-decay migration is applied.

> The Supabase **CLI** `db push` may 403 if your CLI account lacks project-admin
> rights — that's an account-privilege issue, unrelated to the DB password. Use the
> SQL Editor or `npm run deploy --db-url` instead.

---

## 4. Admin — how to make an admin (production-grade)

**The security boundary is the server, not the UI.** Admin-only config actions
(`POST /api/admin/sources`, scan control) are enforced in `src/lib/auth.js`
(`requireAdmin`). Hiding a button is never the control.

**An admin = a Google account whose email is in `ADMIN_EMAILS`.**

- `ADMIN_EMAILS` is a comma-separated allowlist, e.g.
  `ADMIN_EMAILS=owner@nepa.com,ops@nepa.com`.
- **To add an admin:** add their Google email to `ADMIN_EMAILS` in Vercel → redeploy.
- **To remove one:** delete the email → redeploy.

**Phased enforcement (by design):**
- `ADMIN_EMAILS` **blank** → gate is **OPEN** (single-operator/trusted). The app runs
  today in this mode — documented interim, not permanent.
- `ADMIN_EMAILS` **set** → gate **ENFORCES**: `/api/admin/*` mutations require a valid
  Google session whose email is on the list; everyone else gets 401/403. No code
  change — just set the env.

Enforcing requires Google Sign-In wired (next section), so the client can send the
session token. Until then, keep `ADMIN_EMAILS` blank and treat the deployment as
single-operator.

A future `role` column can replace the email allowlist without changing this
boundary.

---

## 5. Google Sign-In setup (enables the admin gate + future per-user)

Auth is **Google Sign-In only**, via Supabase Auth. Server enforcement is already
built; this wires the login so sessions exist.

**a. Google Cloud** — create an OAuth 2.0 Client ID (Web application). Authorized
redirect URI: `https://<your-project-ref>.supabase.co/auth/v1/callback`. Copy the
client ID + secret.

**b. Supabase** — Authentication → Providers → **Google** → enable, paste the client
ID + secret. Add your site URL + `https://<app-domain>/` to Auth → URL Configuration.

**c. Vercel env** — set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`
(same values as the server ones, just exposed to the browser), and `ADMIN_EMAILS`.

**d. Client wiring** — a browser Supabase client does the login and the admin fetches
send its token. Minimal pattern:

```js
// src/lib/authClient.js  (browser)
import { createClient } from '@supabase/supabase-js';
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
export const authClient = url && key ? createClient(url, key) : null;
export async function signInWithGoogle() {
  await authClient?.auth.signInWithOAuth({ provider: 'google',
    options: { redirectTo: window.location.origin } });
}
export async function adminToken() {
  const { data } = (await authClient?.auth.getSession()) || {};
  return data?.session?.access_token || null;
}
```

Then in the admin UI, attach the token to mutations:

```js
const token = await adminToken();
await fetch('/api/admin/sources', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify({ active }),
});
```

The server (`requireAdmin`) verifies that token and checks `ADMIN_EMAILS`. Done —
`POST /api/admin/sources` is now admin-only.

---

## 6. Data sources

- **merolagani** — LIVE (real scraped NEPSE quotes); the deployment default
  (`MARKET_DATA_SOURCES=merolagani`).
- **nepalstock** — build-ready, disabled until `NEPALSTOCK_API_TOKEN` is set.
- **sharesansar** — not yet implemented (JS/AJAX); shows disabled.
- **sample** — offline placeholder; the disclaimer flags it as non-real.

Change the active source live in **Settings → Market Data Sources** (admin-only once
the gate is on). A disabled source can't be selected.

> **ToS caveat:** commercial scraping of merolagani is pending the P3-1 legal review.
> Clear it (or move to a licensed feed) before charging users.

---

## 7. Notifications (delivery + observability)

Channels are active only when configured (`src/lib/notify.js`). The scan delivers a
digest and **alerts on partial/failed scans**. Status in **Settings → Notifications**.

- **Email** — set `RESEND_API_KEY` (+ optional `ALERT_TO`).
- **Telegram** — `/newbot` via **@BotFather** → `TELEGRAM_BOT_TOKEN`; message the bot,
  then `https://api.telegram.org/bot<token>/getUpdates` → copy `chat.id` →
  `TELEGRAM_CHAT_ID`.

---

## 8. Owner action checklist (the outstanding items)

- [ ] **Apply the `weights` decay migration** — `npm run deploy` or paste
  `supabase/migrations/20260724120000_weights_decay.sql` in the SQL Editor. Confirm
  with `npm run doctor`. (Optional/non-blocking — decay activates once applied.)
- [ ] **merolagani ToS / legal (P3-1)** — a Nepali securities lawyer reviews scraping
  ToS + SEBON licensing before charging users. **Gates commercial launch.**
- [ ] **`NEPALSTOCK_API_TOKEN`** — set when you obtain it → the NEPSE-official source
  becomes selectable.
- [ ] **Telegram env** — `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` to turn on alerts.
- [ ] **Google auth** (§5) + `ADMIN_EMAILS` — when you want admin enforcement / real
  users.

---

## 9. Verify

```
npm run doctor   # env + Supabase + schema + migration status
npm test         # unit suite (money/reliability logic)
npm run lint
npm run build
```
`GET /api/health` returns the same readiness checks as JSON in production.

---

## 10. Full multi-tenancy (later — when onboarding real users)

Preserve the shared/per-user split (`CLAUDE.md`):
- Add `user_id` **only** to new per-user tables (watchlist, alert prefs, subscription)
  — never to signals/scans/weights/knowledge.
- Turn **RLS on**: shared tables readable by any authenticated user, writable only by
  the cron/service role; per-user tables owner-only.
- Login stays identity-only — it never triggers a fetch/scan.
- Billing (Stripe / eSewa / Khalti). The shared scan is a fixed global cost amortized
  across subscribers; meter only optional per-user LLM features.

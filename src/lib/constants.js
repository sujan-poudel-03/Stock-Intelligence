// Shared KV keys, defaults, and timing constants for the scan pipeline.

// Tables defined in supabase/schema.sql. Used by the health route and the
// preflight script. NOTE: scripts/preflight.mjs keeps a duplicate of this list
// (it cannot import @/ aliases) — keep the two in sync.
export const EXPECTED_TABLES = [
  'kv_store',
  'signals',
  'scans',
  'scan_jobs',
  'weights',
  'outcomes',
  'alerts',
  'events',
  'knowledge',
  'corporate_actions', // TIER-1 #1 global corporate-action awareness (bonus/rights/div ex-dates)
  // Phase 2 per-user tables (thin per-user layer; RLS added in a later step).
  'watchlists',
  'user_settings',
  'portfolios',
  'alert_prefs',
  'subscriptions', // tier/entitlement extension point (free by default)
  // TIER-2 per-user alert DELIVERY ledgers (email notifications). Owner-read,
  // service-write; gated behind schema-flag probes until migrated.
  'alert_deliveries',
  'outcome_deliveries',
];

export const KV = {
  WATCHLIST: 'ni:wl',
  BRIEF: 'ni:brief',
  SETTINGS: 'ni:settings',
};

// Phase 2 step 5b — identity-less kv keys retired from the global /api/storage
// route (the data-leak vector: one shared row served to everyone). Their data now
// lives in per-user tables (/api/watchlist, /api/portfolio, /api/settings), behind
// the admin gate (/api/admin/settings for the global discovery config), or in
// device-local storage (chat, stock cache). /api/storage returns 410 for these so a
// stray caller fails loudly instead of leaking. GLOBAL keys (ni:brief, ni:mkt) stay.
export const RETIRED_KV_KEYS = [
  'ni:wl',       // watchlist            -> /api/watchlist (per-user)
  'ni:mem',      // watchlist meta        -> folded into watchlists.reason
  'ni:p',        // portfolio             -> /api/portfolio (per-user)
  'ni:tl',       // trade log             -> derived from closed portfolio rows
  'ni:settings', // agent/discovery config -> /api/admin/settings (admin, global)
  'ni:chat',     // chat history          -> device-local
  'ni:sc',       // stock cache           -> device-local
];

// The ONLY keys /api/storage will serve — and it serves them READ-ONLY. These are
// global, non-sensitive, public-read surfaces (the daily brief + market snapshot)
// written server-side by the cron/service role directly (never via this HTTP route).
// Everything else is either retired (per-user, 410) or unknown (404); ALL writes/
// deletes through this route are rejected, closing the old anon-write hole where an
// unauthenticated POST could overwrite the brief every user reads.
export const GLOBAL_READ_KEYS = [
  'ni:brief', // daily brief (written by scan/brief via service role)
  'ni:mkt',   // market snapshot
];

// Idempotency / liveness windows.
export const SCAN_GUARD_MS = 30 * 60 * 1000; // skip new scan if one started < 30 min ago
export const STALE_JOB_MS = 90 * 1000; // reclaim running jobs older than 90s
export const STALL_MS = 2 * 60 * 1000; // status considers scan stalled after 2 min no progress
export const MAX_ATTEMPTS = 3; // per-job retry ceiling

// Watchlist auto-promotion. A symbol seen on the "watch" side (HOLD) across at
// least WATCH_PROMOTE_MIN of the last SIGNAL_HISTORY_SCANS scans is auto-added to
// the watchlist so the agent keeps monitoring it; when it later flips to BUY/SELL
// it surfaces on Today.
export const SIGNAL_HISTORY_SCANS = 3; // how many recent scans count as "recent"
export const WATCH_PROMOTE_MIN = 2; // min HOLD appearances within that window to promote

// Verify the cron / internal Authorization: Bearer CRON_SECRET header.
export function checkCronAuth(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // no secret configured -> allow (single-user/dev)
  const header = request.headers.get('authorization') || '';
  return header === `Bearer ${secret}`;
}

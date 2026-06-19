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
];

export const KV = {
  WATCHLIST: 'ni:wl',
  BRIEF: 'ni:brief',
  SETTINGS: 'ni:settings',
};

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

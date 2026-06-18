// Scan schedule helpers. The actual trigger is a Vercel cron in vercel.json;
// this mirrors that schedule so the UI can show the next/last run time.
//
// KEEP IN SYNC with vercel.json `crons[].schedule` (same convention as
// EXPECTED_TABLES <-> scripts/preflight.mjs). Vercel crons run in UTC.
export const SCAN_CRON = '45 4 * * *'; // 04:45 UTC daily = 10:30 AM Nepal (NPT)

// nextScanRunIso(fromMs): ISO timestamp of the next scheduled run at/after `fromMs`.
// Minimal by design — handles the daily "m h * * *" pattern in use (fixed minute +
// hour, every day). Returns null for any pattern it can't parse, so the UI simply
// hides "Next scan" rather than showing something wrong.
export function nextScanRunIso(fromMs = Date.now()) {
  const parts = SCAN_CRON.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const [min, hour, dom, mon, dow] = parts;
  // Only the daily fixed-time case is supported (date/month/weekday all wildcards).
  if (dom !== '*' || mon !== '*' || dow !== '*') return null;

  const m = Number(min);
  const h = Number(hour);
  if (!Number.isInteger(m) || !Number.isInteger(h) || m < 0 || m > 59 || h < 0 || h > 23) {
    return null;
  }

  const from = new Date(fromMs);
  const next = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), h, m, 0, 0)
  );
  if (next.getTime() <= fromMs) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.toISOString();
}

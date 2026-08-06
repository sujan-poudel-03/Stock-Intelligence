// Pure selection logic for GET /api/signals: which scan's signals to display.
//
// The latest scan for an exchange can be stalled / partial / still-running and
// produce ZERO signal rows. Scoping the tab strictly to that latest scan then shows
// "0 signals" even though prior COMPLETED scans have signals. Instead, when the
// latest scan has no signals, fall back to the most recent scan that HAS signals —
// the same spirit as the last-known-market fallback in /api/scan/status.
//
// Inputs are already-fetched rows (no DB access here) so this stays unit-testable:
//   latestScan   — the most recent scan for the exchange (metadata), or null
//   latestRows   — signal rows for latestScan (array; may be empty)
//   fallbackScan — the most recent scan that HAS signals (metadata), or null
//   fallbackRows — signal rows for fallbackScan (array; may be empty)
//
// Returns { scan, rows, fromEarlier }: the scan whose signals to render, its rows,
// and whether those came from an earlier scan than the latest. When the latest scan
// already has signals, behaviour is unchanged (fromEarlier: false).
export function pickSignalsScan({ latestScan, latestRows, fallbackScan, fallbackRows }) {
  const lr = latestRows || [];
  if (lr.length > 0) {
    return { scan: latestScan, rows: lr, fromEarlier: false };
  }

  const fr = fallbackRows || [];
  if (fallbackScan && fr.length > 0 && fallbackScan.id !== latestScan?.id) {
    return { scan: fallbackScan, rows: fr, fromEarlier: true };
  }

  // No earlier scan with signals — keep the (empty) latest-scan result unchanged.
  return { scan: latestScan, rows: lr, fromEarlier: false };
}

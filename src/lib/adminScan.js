import { normalizeExchange } from './exchanges.js';

// Admin scan-trigger param normalization (pure + deterministic, so it's unit-testable
// on its own). An in-app "scan now" posts { exchange, mode } to /api/admin/scan; the
// route verifies the caller is an admin, then re-triggers the REAL scan endpoint
// (/api/cron/scan) server-side with the CRON_SECRET the browser doesn't have. This
// coerces the request into safe params + the internal cron/scan query path:
//   - exchange -> a known exchange id (defaults to NEPSE)
//   - mode     -> 'light' only when explicitly asked, else 'full' (the daily default)
export function normalizeScanParams(body = {}) {
  const exchange = normalizeExchange(body?.exchange);
  const mode = body?.mode === 'light' ? 'light' : 'full';
  const path = `/api/cron/scan?exchange=${encodeURIComponent(exchange)}${mode === 'light' ? '&mode=light' : ''}`;
  return { exchange, mode, path };
}

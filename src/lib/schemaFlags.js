import { getSupabase } from './supabase.js';

// Best-effort schema feature-detection, mirroring the calibration decay pattern
// ("written best-effort so it keeps working whether or not the migration is applied
// yet"). The multi-exchange migration (20260730000000_add_exchange.sql) adds an
// `exchange` column to scans/signals; until it is applied, referencing that column
// in a select/insert/filter would ERROR and break the NEPSE flow. So every exchange
// COLUMN touch is gated on this probe — NEPSE stays byte-for-byte on an unmigrated
// DB, and the exchange dimension lights up automatically once the column exists.
//
// The learning-loop scoping (weights/knowledge via scopeKey) is namespaced by KEY,
// not a column, so it is NOT gated here — it works regardless of this migration.

let probe = null;

// exchangeColumnReady(): true when scans/signals carry the `exchange` column.
// Cached per process (serverless instances are short-lived, so a stale false simply
// resolves on the next cold start after the migration is applied).
export async function exchangeColumnReady() {
  if (probe) return probe;
  probe = (async () => {
    try {
      const supabase = getSupabase();
      const { error } = await supabase.from('scans').select('exchange').limit(1);
      return !error;
    } catch {
      return false;
    }
  })();
  return probe;
}

// Test-only: reset the memoized probe.
export function __resetExchangeProbe() {
  probe = null;
}

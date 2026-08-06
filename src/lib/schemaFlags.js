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

// --- Corporate-action awareness (TIER-1 #1) --------------------------------
// Same discipline as exchangeColumnReady: until 20260806130000_corporate_actions.sql
// is applied, touching the `corporate_actions` table or the new signal CA columns
// would ERROR and break outcome resolution. Every CA read/write is gated on these two
// probes so an unmigrated DB behaves byte-for-byte as today (no adjustment, no VOID).

let caTableProbe = null;
let caColumnsProbe = null;

// corporateActionsReady(): true when the global `corporate_actions` table exists.
export async function corporateActionsReady() {
  if (caTableProbe) return caTableProbe;
  caTableProbe = (async () => {
    try {
      const supabase = getSupabase();
      const { error } = await supabase.from('corporate_actions').select('id').limit(1);
      return !error;
    } catch {
      return false;
    }
  })();
  return caTableProbe;
}

// signalCaColumnsReady(): true when signals carry the CA adjustment columns
// (orig_*/ca_factor/ca_deduction/ca_note). Probed via ca_factor.
export async function signalCaColumnsReady() {
  if (caColumnsProbe) return caColumnsProbe;
  caColumnsProbe = (async () => {
    try {
      const supabase = getSupabase();
      const { error } = await supabase.from('signals').select('ca_factor').limit(1);
      return !error;
    } catch {
      return false;
    }
  })();
  return caColumnsProbe;
}

// Test-only: reset the memoized CA probes.
export function __resetCorporateActionsProbe() {
  caTableProbe = null;
  caColumnsProbe = null;
}

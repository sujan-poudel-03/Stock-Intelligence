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

// --- Outcome realism (TIER-1 #3) -------------------------------------------
// Same discipline as signalCaColumnsReady: until 20260807000000_outcome_realism.sql
// is applied, touching the new signal/outcome columns (peak_high/trough_low/
// net_return_pct/max_hold_days/exit_reason) would ERROR and break resolution + insert.
// Every read/write of these columns is gated on this probe so an unmigrated DB behaves
// byte-for-byte as today (spot-only resolution, gross-only return, no EXPIRE, no horizon).

let outcomeRealismProbe = null;

// outcomeRealismColumnsReady(): true when signals carry the outcome-realism columns.
// Probed via peak_high. Cached per process, mirroring signalCaColumnsReady.
export async function outcomeRealismColumnsReady() {
  if (outcomeRealismProbe) return outcomeRealismProbe;
  outcomeRealismProbe = (async () => {
    try {
      const supabase = getSupabase();
      const { error } = await supabase.from('signals').select('peak_high').limit(1);
      return !error;
    } catch {
      return false;
    }
  })();
  return outcomeRealismProbe;
}

// Test-only: reset the memoized outcome-realism probe.
export function __resetOutcomeRealismProbe() {
  outcomeRealismProbe = null;
}

// --- Per-user alert delivery (TIER-2) --------------------------------------
// Same discipline as the probes above: until 20260808000000_alert_delivery.sql is
// applied, touching the alert_deliveries / outcome_deliveries tables would ERROR.
// Every delivery read/write is gated on these probes so an unmigrated DB behaves
// byte-for-byte as today (no per-user delivery attempted; brief/outcome flow unchanged).

let alertDeliveryProbe = null;
let outcomeDeliveryProbe = null;

// alertDeliveryReady(): true when the alert_deliveries cursor table exists.
export async function alertDeliveryReady() {
  if (alertDeliveryProbe) return alertDeliveryProbe;
  alertDeliveryProbe = (async () => {
    try {
      const supabase = getSupabase();
      const { error } = await supabase.from('alert_deliveries').select('user_id').limit(1);
      return !error;
    } catch {
      return false;
    }
  })();
  return alertDeliveryProbe;
}

// outcomeDeliveryReady(): true when the outcome_deliveries ledger table exists.
export async function outcomeDeliveryReady() {
  if (outcomeDeliveryProbe) return outcomeDeliveryProbe;
  outcomeDeliveryProbe = (async () => {
    try {
      const supabase = getSupabase();
      const { error } = await supabase.from('outcome_deliveries').select('user_id').limit(1);
      return !error;
    } catch {
      return false;
    }
  })();
  return outcomeDeliveryProbe;
}

// Test-only: reset the memoized delivery probes.
export function __resetAlertDeliveryProbe() {
  alertDeliveryProbe = null;
  outcomeDeliveryProbe = null;
}

// --- Global system/seed watchlist ------------------------------------------
// Same discipline as corporateActionsReady: until 20260809000000_system_watchlist.sql
// is applied, touching the `system_watchlist` table would ERROR. Every read/write of
// the curated universe (scan union, brief promotion, admin/public routes) is gated on
// this probe so an unmigrated DB behaves byte-for-byte as today (scan union = user
// watchlists + discovery only, blank curated section, no auto-promotion).

let systemWatchlistProbe = null;

// systemWatchlistReady(): true when the global `system_watchlist` table exists.
export async function systemWatchlistReady() {
  if (systemWatchlistProbe) return systemWatchlistProbe;
  systemWatchlistProbe = (async () => {
    try {
      const supabase = getSupabase();
      const { error } = await supabase.from('system_watchlist').select('symbol').limit(1);
      return !error;
    } catch {
      return false;
    }
  })();
  return systemWatchlistProbe;
}

// Test-only: reset the memoized system-watchlist probe.
export function __resetSystemWatchlistProbe() {
  systemWatchlistProbe = null;
}

// --- Paper trading (Beginner flagship §4.1) --------------------------------
// Same discipline as systemWatchlistReady: until 20260810000000_paper_trading.sql is
// applied, touching the `paper_accounts` / `paper_positions` tables would ERROR. Every
// paper read/write (summary, order, reset) is gated on this probe so an unmigrated DB is
// byte-for-byte as today (the Paper tab reports enabled:false; no paper table is touched).

let paperTradingProbe = null;

// paperTradingReady(): true when the per-user `paper_accounts` table exists.
export async function paperTradingReady() {
  if (paperTradingProbe) return paperTradingProbe;
  paperTradingProbe = (async () => {
    try {
      const supabase = getSupabase();
      const { error } = await supabase.from('paper_accounts').select('user_id').limit(1);
      return !error;
    } catch {
      return false;
    }
  })();
  return paperTradingProbe;
}

// Test-only: reset the memoized paper-trading probe.
export function __resetPaperTradingProbe() {
  paperTradingProbe = null;
}

// --- Price history (redesign Phase A — charts) ------------------------------
// Same discipline as systemWatchlistReady: until 20260917000000_price_history.sql
// is applied, touching the `price_history` table would ERROR. Every read/write
// (scan-chain recording, chart API) is gated on this probe so an unmigrated DB is
// byte-for-byte as today (no price history recorded; chart UI shows an honest
// "not enough history yet" state instead of erroring).

let priceHistoryProbe = null;

// priceHistoryReady(): true when the global `price_history` table exists.
export async function priceHistoryReady() {
  if (priceHistoryProbe) return priceHistoryProbe;
  priceHistoryProbe = (async () => {
    try {
      const supabase = getSupabase();
      const { error } = await supabase.from('price_history').select('symbol').limit(1);
      return !error;
    } catch {
      return false;
    }
  })();
  return priceHistoryProbe;
}

// Test-only: reset the memoized price-history probe.
export function __resetPriceHistoryProbe() {
  priceHistoryProbe = null;
}

// --- Per-user Telegram linking (redesign Phase G — reach) -------------------
// Same discipline as paperTradingReady: until 20260918000000_telegram_link.sql is
// applied, touching alert_prefs.telegram_chat_id/telegram_link_code would ERROR.
// Every read/write (link-code issuance, the webhook, delivery) is gated on this
// probe so an unmigrated DB is byte-for-byte as today (Telegram toggle exists but
// never actually links or delivers per-user).

let telegramLinkProbe = null;

// telegramLinkReady(): true when alert_prefs carries the telegram_chat_id column.
export async function telegramLinkReady() {
  if (telegramLinkProbe) return telegramLinkProbe;
  telegramLinkProbe = (async () => {
    try {
      const supabase = getSupabase();
      const { error } = await supabase.from('alert_prefs').select('telegram_chat_id').limit(1);
      return !error;
    } catch {
      return false;
    }
  })();
  return telegramLinkProbe;
}

// Test-only: reset the memoized telegram-link probe.
export function __resetTelegramLinkProbe() {
  telegramLinkProbe = null;
}

// --- Browser push subscriptions (redesign Phase G — reach) -------------------
// Same discipline as paperTradingReady: until 20260919000000_push_subscriptions.sql
// is applied, touching the `push_subscriptions` table would ERROR. Gated so an
// unmigrated DB reports the push toggle as enabled:false rather than erroring.

let pushSubscriptionsProbe = null;

// pushSubscriptionsReady(): true when the `push_subscriptions` table exists.
export async function pushSubscriptionsReady() {
  if (pushSubscriptionsProbe) return pushSubscriptionsProbe;
  pushSubscriptionsProbe = (async () => {
    try {
      const supabase = getSupabase();
      const { error } = await supabase.from('push_subscriptions').select('id').limit(1);
      return !error;
    } catch {
      return false;
    }
  })();
  return pushSubscriptionsProbe;
}

// Test-only: reset the memoized push-subscriptions probe.
export function __resetPushSubscriptionsProbe() {
  pushSubscriptionsProbe = null;
}

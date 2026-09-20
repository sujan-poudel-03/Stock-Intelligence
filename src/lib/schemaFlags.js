import { getSupabase } from './supabase.js';

// Best-effort schema feature-detection, mirroring the calibration decay pattern
// ("written best-effort so it keeps working whether or not the migration is applied
// yet"). Each additive migration adds a table/column that would ERROR if queried on
// an unmigrated DB — every touch of that table/column is gated behind the matching
// probe below, so an unmigrated DB behaves byte-for-byte as before the migration
// shipped, and the feature lights up automatically once it's applied.
//
// makeProbe(table, column) is the ONE shape behind every probe: an async function,
// memoized per process (serverless instances are short-lived, so a stale `false`
// simply resolves itself on the next cold start after the migration is applied),
// that's true once a 1-row select against (table, column) doesn't error.
function makeProbe(table, column) {
  let cached = null;
  const probe = async () => {
    if (cached) return cached;
    cached = (async () => {
      try {
        const { error } = await getSupabase().from(table).select(column).limit(1);
        return !error;
      } catch {
        return false;
      }
    })();
    return cached;
  };
  probe.reset = () => {
    cached = null;
  };
  return probe;
}

// exchangeColumnReady(): true when scans/signals carry the `exchange` column
// (20260730000000_add_exchange.sql). The learning-loop scoping (weights/knowledge
// via scopeKey) is namespaced by KEY, not a column, so it needs no probe here.
export const exchangeColumnReady = makeProbe('scans', 'exchange');

// corporateActionsReady() / signalCaColumnsReady() (TIER-1 #1): the global
// `corporate_actions` table and the signals CA-adjustment columns
// (20260806130000_corporate_actions.sql).
export const corporateActionsReady = makeProbe('corporate_actions', 'id');
export const signalCaColumnsReady = makeProbe('signals', 'ca_factor');

// outcomeRealismColumnsReady() (TIER-1 #3): peak_high/trough_low/net_return_pct/
// max_hold_days/exit_reason on signals/outcomes (20260807000000_outcome_realism.sql).
export const outcomeRealismColumnsReady = makeProbe('signals', 'peak_high');

// alertDeliveryReady() / outcomeDeliveryReady() (TIER-2): the per-user delivery
// cursor/ledger tables (20260808000000_alert_delivery.sql).
export const alertDeliveryReady = makeProbe('alert_deliveries', 'user_id');
export const outcomeDeliveryReady = makeProbe('outcome_deliveries', 'user_id');

// systemWatchlistReady(): the global curated/seed watchlist table
// (20260809000000_system_watchlist.sql).
export const systemWatchlistReady = makeProbe('system_watchlist', 'symbol');

// paperTradingReady() (Beginner flagship §4.1): the per-user paper-trading tables
// (20260810000000_paper_trading.sql).
export const paperTradingReady = makeProbe('paper_accounts', 'user_id');

// priceHistoryReady() (redesign Phase A — charts): the global daily-bar table
// (20260917000000_price_history.sql).
export const priceHistoryReady = makeProbe('price_history', 'symbol');

// telegramLinkReady() (redesign Phase G — reach): alert_prefs.telegram_chat_id
// (20260918000000_telegram_link.sql).
export const telegramLinkReady = makeProbe('alert_prefs', 'telegram_chat_id');

// pushSubscriptionsReady() (redesign Phase G — reach): the push_subscriptions
// table (20260919000000_push_subscriptions.sql).
export const pushSubscriptionsReady = makeProbe('push_subscriptions', 'id');

// Test-only: reset every memoized probe in one call (nothing currently imports
// this — these DB-touching probes aren't unit-mocked today — but it's kept as a
// single, obvious hook for whenever that testing is added, rather than one
// reset function per probe).
export function __resetAllSchemaProbes() {
  [
    exchangeColumnReady,
    corporateActionsReady,
    signalCaColumnsReady,
    outcomeRealismColumnsReady,
    alertDeliveryReady,
    outcomeDeliveryReady,
    systemWatchlistReady,
    paperTradingReady,
    priceHistoryReady,
    telegramLinkReady,
    pushSubscriptionsReady,
  ].forEach((p) => p.reset());
}

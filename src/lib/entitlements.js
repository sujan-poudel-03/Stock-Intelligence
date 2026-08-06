// Tier -> feature entitlements. The EXTENSION POINT for a future paid model: today
// everyone is 'free' (OAuth-gated, no billing). Later, a billing webhook or an admin
// action sets a user's `subscriptions.tier`, and read/feature paths consult
// getUserEntitlements() to decide what's available — the scan itself stays one global
// cost; tiers only gate how much of the shared output + which per-user features a
// user gets. `entitlementFor` is pure (no imports) so it's unit-testable and could
// later be made admin-configurable.
//
// These limits are PLACEHOLDERS — the exact numbers are a product/pricing decision.
//
// ENFORCEMENT STATUS (as of the tier-control task): only two entitlements are
// actually gated in request paths today —
//   • watchlist_limit → POST /api/watchlist (see resolveWatchlistBlock below)
//   • chat_daily      → POST /api/chat (passed to checkAndBumpChatQuota)
// The rest (signals_limit, full_history, alerts, exchanges) are DECLARED-BUT-NOT-YET-
// ENFORCED: they exist so the matrix is complete, but core signal viewing / track
// record / brief stay UNGATED so the free beta remains fully usable. Wire them later.

export const TIERS = {
  free: {
    label: 'Free',
    signals_limit: 5, // how many of the shared signals are shown
    watchlist_limit: 10,
    alerts: false, // per-user alert delivery
    full_history: false, // per-symbol signal history
    chat_daily: 10, // Ask/chat questions per day (see userQuota)
    exchanges: ['NEPSE'],
  },
  pro: {
    label: 'Pro',
    signals_limit: null, // null = unlimited
    watchlist_limit: null,
    alerts: true,
    full_history: true,
    chat_daily: 100,
    exchanges: ['NEPSE', 'NYSE'],
  },
};

// Pure: tier name -> capability object. Unknown/blank tier falls back to free.
export function entitlementFor(tier) {
  return TIERS[tier] || TIERS.free;
}

// Reads the user's tier from the subscriptions table (defaults to 'free' when there
// is no row). Takes the supabase client as an arg so this module stays import-free
// and testable; callers pass a service or user-scoped client.
export async function getUserTier(supabase, userId) {
  if (!supabase || !userId) return 'free';
  try {
    const { data } = await supabase
      .from('subscriptions')
      .select('tier, status')
      .eq('user_id', userId)
      .maybeSingle();
    if (data && data.status === 'active' && data.tier) return data.tier;
  } catch {
    /* best-effort — a missing table / error just means free */
  }
  return 'free';
}

// Convenience: resolve a user's live entitlements in one call.
export async function getUserEntitlements(supabase, userId) {
  return entitlementFor(await getUserTier(supabase, userId));
}

// Pure watchlist-limit decision — extracted so the enforcement rule is unit-testable
// without a DB. Returns { block, limit }.
//   • limit == null (e.g. pro/unlimited) → never blocks.
//   • adding an EXISTING symbol (isNew === false) → idempotent, never blocks even at
//     the limit (an upsert of a row you already own must still succeed).
//   • a NEW symbol when the current count is already at/over the limit → block.
export function resolveWatchlistBlock({ limit, currentCount, isNew }) {
  if (limit == null) return { block: false, limit };
  if (!isNew) return { block: false, limit };
  return { block: currentCount >= limit, limit };
}

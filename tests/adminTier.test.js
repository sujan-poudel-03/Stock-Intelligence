import { describe, it, expect } from 'vitest';
import { resolveWatchlistBlock, entitlementFor } from '../src/lib/entitlements.js';

describe('resolveWatchlistBlock', () => {
  const free = entitlementFor('free').watchlist_limit; // 10
  const pro = entitlementFor('pro').watchlist_limit; // null (unlimited)

  it('blocks a NEW symbol when a free user is at the limit', () => {
    const r = resolveWatchlistBlock({ limit: free, currentCount: free, isNew: true });
    expect(r.block).toBe(true);
    expect(r.limit).toBe(free);
  });

  it('allows a NEW symbol below the limit', () => {
    expect(resolveWatchlistBlock({ limit: free, currentCount: free - 1, isNew: true }).block).toBe(false);
  });

  it('allows re-adding an EXISTING symbol even at the limit (idempotent upsert)', () => {
    expect(resolveWatchlistBlock({ limit: free, currentCount: free, isNew: false }).block).toBe(false);
  });

  it('never blocks an unlimited (pro) tier, even over any count', () => {
    expect(resolveWatchlistBlock({ limit: pro, currentCount: 9999, isNew: true }).block).toBe(false);
    expect(resolveWatchlistBlock({ limit: null, currentCount: 9999, isNew: true }).block).toBe(false);
  });

  it('blocks when count exceeds the limit (defensive >=)', () => {
    expect(resolveWatchlistBlock({ limit: free, currentCount: free + 3, isNew: true }).block).toBe(true);
  });
});

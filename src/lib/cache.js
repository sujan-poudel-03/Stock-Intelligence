// Shared, cross-instance TTL cache backed by kv_store.
//
// Why DB-backed and not in-memory: Vercel functions are stateless and per-instance,
// so an in-process Map would NOT be shared between users or between concurrent cold
// starts — three users hitting the same symbol could each miss. kv_store is the one
// shared surface every instance already reads, so a cache entry written by user A is
// seen by users B and C. The extra indexed lookup is cheap next to the LLM/live
// fetch it saves.
//
// GUARDRAIL: this is a best-effort side-channel — it must NEVER throw into the main
// request flow. Any error (read, write, parse) degrades to a cache MISS, so the
// caller simply does the live fetch it would have done anyway. It also only ever
// caches derived/enrichment data — never the authoritative signal or a price used
// as ground truth (callers read those fresh).

import { getSupabase } from '@/lib/supabase';
import { isFresh } from '@/lib/cacheTtl';

const PREFIX = 'cache:';

// Re-export the pure freshness check (defined import-free in cacheTtl for testing).
export { isFresh };

// Return the cached value for `key` if present and unexpired, else null.
// Never throws; a failure or miss both return null.
export async function getCache(key, now = Date.now()) {
  try {
    const supabase = getSupabase();
    const { data } = await supabase
      .from('kv_store')
      .select('value')
      .eq('key', PREFIX + key)
      .maybeSingle();
    const entry = data?.value;
    return isFresh(entry, now) ? entry.v : null;
  } catch {
    return null; // best-effort: treat any failure as a miss
  }
}

// Store `value` under `key` for `ttlMs` milliseconds. Best-effort; swallows errors.
export async function setCache(key, value, ttlMs, now = Date.now()) {
  try {
    const supabase = getSupabase();
    await supabase.from('kv_store').upsert(
      {
        key: PREFIX + key,
        value: { v: value, exp: now + ttlMs, at: now },
        updated_at: new Date(now).toISOString(),
      },
      { onConflict: 'key' }
    );
  } catch {
    /* best-effort — a failed cache write must not break the caller */
  }
}

// Pure TTL freshness check for the shared cache. No imports, so unit tests (and
// any caller) use it without loading the DB-backed cache module (which pulls in the
// Supabase client via the '@/' alias that Vitest's node env doesn't resolve).
export function isFresh(entry, now = Date.now()) {
  return !!entry && typeof entry.exp === 'number' && entry.exp > now;
}

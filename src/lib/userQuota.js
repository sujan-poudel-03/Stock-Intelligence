import { getServiceSupabase } from '@/lib/supabase';
import { applyChatQuota, DAILY_CHAT_LIMIT } from '@/lib/chatQuota';

// Per-user daily chat cap so one user can't drain the shared LLM budget (the global
// daily budget is the hard ceiling for total spend; this makes it FAIR per user).
// Backed by kv_store under `chatq:<userId>`, written by the service role (server-only,
// RLS-safe). Best-effort: on a DB error it fail-OPENs (allow) — a transient DB hiccup
// shouldn't lock a user out, and the global budget still caps total spend.
// Returns { allowed, used, limit, remaining }.
export async function checkAndBumpChatQuota(userId, limit = DAILY_CHAT_LIMIT) {
  if (!userId) return { allowed: false, used: 0, limit, remaining: 0 };
  try {
    const svc = getServiceSupabase();
    const key = `chatq:${userId}`;
    const today = new Date().toISOString().slice(0, 10);
    const { data } = await svc.from('kv_store').select('value').eq('key', key).maybeSingle();
    const r = applyChatQuota(data?.value, today, limit);
    if (r.allowed) {
      await svc.from('kv_store').upsert(
        { key, value: r.next, updated_at: new Date().toISOString() },
        { onConflict: 'key' }
      );
    }
    return { allowed: r.allowed, used: r.used, limit, remaining: r.remaining };
  } catch {
    return { allowed: true, used: 0, limit, remaining: limit }; // fail-open
  }
}

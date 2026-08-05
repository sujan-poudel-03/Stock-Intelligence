// Pure per-user daily chat-quota logic (no imports → unit-testable without the DB).
// Given the stored counter {day, n}, today's date key, and the daily limit, returns
// whether this request is allowed and the next counter value to persist.
export const DAILY_CHAT_LIMIT = 30;

export function applyChatQuota(stored, today, limit = DAILY_CHAT_LIMIT) {
  // Counter resets when the stored day is not today.
  const used = stored && stored.day === today ? Number(stored.n) || 0 : 0;
  if (used >= limit) {
    return { allowed: false, used, remaining: 0, next: stored || { day: today, n: used } };
  }
  const next = { day: today, n: used + 1 };
  return { allowed: true, used: used + 1, remaining: limit - (used + 1), next };
}

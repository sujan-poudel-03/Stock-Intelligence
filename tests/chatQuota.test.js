import { describe, it, expect } from 'vitest';
import { applyChatQuota, DAILY_CHAT_LIMIT } from '../src/lib/chatQuota.js';

describe('applyChatQuota', () => {
  const today = '2026-08-05';

  it('allows and increments from empty', () => {
    const r = applyChatQuota(undefined, today, 5);
    expect(r.allowed).toBe(true);
    expect(r.used).toBe(1);
    expect(r.remaining).toBe(4);
    expect(r.next).toEqual({ day: today, n: 1 });
  });

  it('increments within the day', () => {
    const r = applyChatQuota({ day: today, n: 2 }, today, 5);
    expect(r.allowed).toBe(true);
    expect(r.used).toBe(3);
    expect(r.next).toEqual({ day: today, n: 3 });
  });

  it('blocks at the limit', () => {
    const r = applyChatQuota({ day: today, n: 5 }, today, 5);
    expect(r.allowed).toBe(false);
    expect(r.remaining).toBe(0);
  });

  it('resets on a new day', () => {
    const r = applyChatQuota({ day: '2026-08-04', n: 5 }, today, 5);
    expect(r.allowed).toBe(true);
    expect(r.used).toBe(1);
    expect(r.next).toEqual({ day: today, n: 1 });
  });

  it('exposes a sane default limit', () => {
    expect(DAILY_CHAT_LIMIT).toBeGreaterThan(0);
  });
});

import { describe, it, expect } from 'vitest';
import { generateLinkCode, isLinkCodeExpired, parseStartCommand } from '../src/lib/telegramLink.js';

describe('generateLinkCode', () => {
  it('produces a 6-character code from the safe alphabet only', () => {
    for (let i = 0; i < 50; i++) {
      const code = generateLinkCode();
      expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    }
  });

  it('never includes visually-ambiguous characters (0/O/1/I/L)', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateLinkCode()).not.toMatch(/[0O1IL]/);
    }
  });
});

describe('isLinkCodeExpired', () => {
  const now = Date.parse('2026-09-17T12:00:00Z');

  it('is expired when there is no expiry at all', () => {
    expect(isLinkCodeExpired(null, now)).toBe(true);
    expect(isLinkCodeExpired(undefined, now)).toBe(true);
  });

  it('is expired for an unparseable expiry (fails closed)', () => {
    expect(isLinkCodeExpired('not-a-date', now)).toBe(true);
  });

  it('is expired once past the expiry time', () => {
    expect(isLinkCodeExpired('2026-09-17T11:59:59Z', now)).toBe(true);
  });

  it('is NOT expired before the expiry time', () => {
    expect(isLinkCodeExpired('2026-09-17T12:00:01Z', now)).toBe(false);
  });
});

describe('parseStartCommand', () => {
  it('extracts the payload from a deep-link-style /start', () => {
    expect(parseStartCommand('/start AB12CD')).toBe('AB12CD');
  });

  it('uppercases the payload', () => {
    expect(parseStartCommand('/start ab12cd')).toBe('AB12CD');
  });

  it('trims surrounding whitespace', () => {
    expect(parseStartCommand('  /start AB12CD  ')).toBe('AB12CD');
  });

  it('handles the @botname suffix Telegram appends in group chats', () => {
    expect(parseStartCommand('/start@my_bot AB12CD')).toBe('AB12CD');
  });

  it('returns null for a bare /start with no payload', () => {
    expect(parseStartCommand('/start')).toBeNull();
  });

  it('returns null for a non-/start message', () => {
    expect(parseStartCommand('hello there')).toBeNull();
  });

  it('returns null for non-string input', () => {
    expect(parseStartCommand(null)).toBeNull();
    expect(parseStartCommand(undefined)).toBeNull();
    expect(parseStartCommand(42)).toBeNull();
  });
});

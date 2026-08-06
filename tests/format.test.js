import { describe, it, expect } from 'vitest';
import { maskEmail, asOfLabel, channelNeedsSetup } from '../src/lib/format.js';

describe('maskEmail', () => {
  it('keeps first char + domain, masks the rest', () => {
    expect(maskEmail('alice@example.com')).toBe('a•••@example.com');
    expect(maskEmail('a@x.com')).toBe('a•••@x.com');
  });
  it('returns empty string for non-strings', () => {
    expect(maskEmail(null)).toBe('');
    expect(maskEmail(undefined)).toBe('');
    expect(maskEmail(123)).toBe('');
  });
  it('returns malformed input unchanged (no @ / empty local)', () => {
    expect(maskEmail('')).toBe('');
    expect(maskEmail('notanemail')).toBe('notanemail');
    expect(maskEmail('@x.com')).toBe('@x.com');
  });
});

describe('asOfLabel', () => {
  it('formats a millisecond epoch as "as of HH:MM" (local components)', () => {
    // Built from local components so getHours/getMinutes are TZ-independent here.
    const ms = new Date(2026, 0, 15, 14, 32).getTime();
    expect(asOfLabel(ms)).toBe('as of 14:32');
  });
  it('zero-pads single digits', () => {
    const ms = new Date(2026, 0, 15, 9, 5).getTime();
    expect(asOfLabel(ms)).toBe('as of 09:05');
  });
  it('returns "" for null/undefined/unparseable', () => {
    expect(asOfLabel(null)).toBe('');
    expect(asOfLabel(undefined)).toBe('');
    expect(asOfLabel('not-a-date')).toBe('');
  });
});

describe('channelNeedsSetup', () => {
  it('warns only when enabled AND explicitly not configured', () => {
    expect(channelNeedsSetup(true, false)).toBe(true);
    expect(channelNeedsSetup(true, true)).toBe(false);
    expect(channelNeedsSetup(false, false)).toBe(false);
  });
  it('does not warn while configured state is unknown', () => {
    expect(channelNeedsSetup(true, undefined)).toBe(false);
    expect(channelNeedsSetup(true, null)).toBe(false);
  });
});

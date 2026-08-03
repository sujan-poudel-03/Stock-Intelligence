import { describe, it, expect } from 'vitest';
import { isFresh } from '../src/lib/cacheTtl.js';

// isFresh is the money-cheap gate that decides cache hit vs a fresh (paid) LLM
// fetch, so its boundary behavior is worth pinning.
describe('cache isFresh', () => {
  const now = 1_000_000;

  it('is fresh while exp is in the future', () => {
    expect(isFresh({ v: 1, exp: now + 1 }, now)).toBe(true);
    expect(isFresh({ v: 1, exp: now + 10_000 }, now)).toBe(true);
  });

  it('is stale at or past exp', () => {
    expect(isFresh({ v: 1, exp: now }, now)).toBe(false); // exp must be strictly future
    expect(isFresh({ v: 1, exp: now - 1 }, now)).toBe(false);
  });

  it('treats missing / malformed entries as not fresh (miss)', () => {
    expect(isFresh(null, now)).toBe(false);
    expect(isFresh(undefined, now)).toBe(false);
    expect(isFresh({}, now)).toBe(false);
    expect(isFresh({ v: 1 }, now)).toBe(false); // no exp
    expect(isFresh({ v: 1, exp: 'soon' }, now)).toBe(false); // non-numeric exp
  });
});

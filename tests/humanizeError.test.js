import { describe, it, expect } from 'vitest';
import { humanizeError } from '../src/lib/humanizeError.js';

// humanizeError guarantees the UI never shows a raw provider JSON blob and that
// each error kind drives the right badge/retry behavior.
describe('humanizeError', () => {
  it('handles empty input', () => {
    expect(humanizeError('')).toEqual({ kind: 'unknown', message: 'Unknown error' });
  });

  it('detects our own daily-budget skip', () => {
    expect(humanizeError('Skipped — daily LLM budget reached').kind).toBe('budget');
  });

  it('detects a provider daily quota error', () => {
    expect(humanizeError('RESOURCE_EXHAUSTED: you exceeded your current quota').kind).toBe('quota');
  });

  it('detects transient overload', () => {
    expect(humanizeError('503 Service UNAVAILABLE').kind).toBe('busy');
  });

  it('detects auth / key problems', () => {
    expect(humanizeError('Invalid API key provided').kind).toBe('auth');
  });

  it('detects network errors', () => {
    expect(humanizeError('fetch failed: ECONNRESET').kind).toBe('network');
  });

  it('never dumps a raw blob for unknown errors', () => {
    const out = humanizeError('some unexpected thing happened at length '.repeat(10));
    expect(out.kind).toBe('unknown');
    expect(out.message.length).toBeLessThanOrEqual(120);
  });
});

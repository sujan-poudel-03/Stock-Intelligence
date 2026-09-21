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

  describe('verified-price rejections (scan.js scanOneStock -> marketData.js reconcile)', () => {
    it('explains a source-disagreement rejection', () => {
      const out = humanizeError('no data from source: NABIL [disagreement:2.34%] (tried: merolagani,sharesansar)');
      expect(out.kind).toBe('price');
      expect(out.message).toContain('NABIL');
      expect(out.message).toContain('disagreed by 2.34%');
      expect(out.message).toContain('tried: merolagani,sharesansar');
    });

    it('explains a no-sane-quote rejection with per-source detail', () => {
      const out = humanizeError('no data from source: HBL [no-sane-quote] (tried: merolagani) {merolagani:non-positive-price}');
      expect(out.kind).toBe('price');
      expect(out.message).toContain('HBL');
      expect(out.message).toContain('merolagani returned a zero/negative price');
    });

    it('explains an implausible-move detail', () => {
      const out = humanizeError('no data from source: EBL [no-sane-quote] (tried: merolagani) {merolagani:implausible-move:15.2%}');
      expect(out.message).toContain('moved 15.2% vs previous close (implausible)');
    });

    it('flags when no source responded at all', () => {
      const out = humanizeError('no data from source: SCB [no-providers]');
      expect(out.kind).toBe('price');
      expect(out.message).toContain('no source responded');
      expect(out.message).toContain('no price source is configured');
    });
  });
});

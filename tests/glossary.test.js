import { describe, it, expect } from 'vitest';
import { GLOSSARY, defineTerm } from '../src/lib/glossary.js';

describe('defineTerm — known keys', () => {
  it('resolves a plain signal verb', () => {
    const t = defineTerm('BUY');
    expect(t).not.toBeNull();
    expect(t.key).toBe('BUY');
    expect(t.label).toBe('BUY');
    expect(t.plain).toMatch(/upside/i);
  });

  it('resolves PE and its "p/e" alias to the same entry', () => {
    const a = defineTerm('PE');
    const b = defineTerm('p/e');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(b.key).toBe('PE');
    expect(b.plain).toBe(a.plain);
    expect(b.label).toBe('P/E');
  });

  it('resolves the "SL" alias to the stop-loss term', () => {
    const t = defineTerm('SL');
    expect(t).not.toBeNull();
    expect(t.key).toBe('stop');
    expect(t.plain).toMatch(/stop-loss/i);
  });

  it('resolves net and gross distinctly', () => {
    const net = defineTerm('net');
    const gross = defineTerm('gross');
    expect(net.key).toBe('net');
    expect(gross.key).toBe('gross');
    expect(net.plain).not.toBe(gross.plain);
    expect(net.plain).toMatch(/after NEPSE charges/i);
    expect(gross.plain).toMatch(/before any costs/i);
  });
});

describe('defineTerm — case-insensitivity & aliases', () => {
  it('is case-insensitive', () => {
    expect(defineTerm('buy').key).toBe('BUY');
    expect(defineTerm('Bullish').key).toBe('BULLISH');
    expect(defineTerm('bearish').plain).toBe(GLOSSARY.BEARISH.plain);
  });

  it('tolerates spacing/punctuation variants', () => {
    expect(defineTerm('book value').key).toBe('BV');
    expect(defineTerm('P/BV').key).toBe('PBV');
    expect(defineTerm('52-week').key).toBe('week52');
    expect(defineTerm('win rate').key).toBe('winRate');
    expect(defineTerm('stop loss').key).toBe('stop');
  });
});

describe('defineTerm — unknown & robustness', () => {
  it('returns null for unknown terms', () => {
    expect(defineTerm('FOOBAR')).toBeNull();
    expect(defineTerm('xyz')).toBeNull();
  });

  it('never throws on bad input, returns null', () => {
    expect(() => defineTerm(null)).not.toThrow();
    expect(() => defineTerm(undefined)).not.toThrow();
    expect(() => defineTerm('')).not.toThrow();
    expect(() => defineTerm(123)).not.toThrow();
    expect(() => defineTerm({})).not.toThrow();
    expect(defineTerm(null)).toBeNull();
    expect(defineTerm(undefined)).toBeNull();
    expect(defineTerm('')).toBeNull();
  });

  it('every GLOSSARY entry is self-resolvable and within length budget', () => {
    for (const key of Object.keys(GLOSSARY)) {
      const t = defineTerm(key);
      expect(t).not.toBeNull();
      expect(t.key).toBe(key);
      expect(typeof GLOSSARY[key].plain).toBe('string');
      expect(GLOSSARY[key].plain.length).toBeLessThanOrEqual(170);
      expect(GLOSSARY[key].label.length).toBeGreaterThan(0);
    }
  });
});

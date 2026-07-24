import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getProvider } from '../src/lib/llm.js';

// getProvider infers the vendor from NEPSE_MODEL and must never select a provider
// whose API key is absent (the "wrong-key footgun" that would break every call).
const KEYS = ['NEPSE_MODEL', 'LLM_PROVIDER', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY'];
const saved = {};
beforeEach(() => KEYS.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; }));
afterEach(() => KEYS.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }));

describe('getProvider', () => {
  it('infers claude from a claude model string when the key is present', () => {
    process.env.NEPSE_MODEL = 'claude-sonnet-5';
    process.env.ANTHROPIC_API_KEY = 'x';
    expect(getProvider()).toBe('claude');
  });

  it('infers gemini from a gemini model string', () => {
    process.env.NEPSE_MODEL = 'gemini-2.5-flash';
    process.env.GEMINI_API_KEY = 'x';
    expect(getProvider()).toBe('gemini');
  });

  it('falls back off claude to gemini when only the gemini key exists', () => {
    process.env.NEPSE_MODEL = 'claude-opus-4-8';
    process.env.GEMINI_API_KEY = 'x'; // no ANTHROPIC_API_KEY
    expect(getProvider()).toBe('gemini');
  });

  it('defaults to gemini when nothing is configured', () => {
    expect(getProvider()).toBe('gemini');
  });
});

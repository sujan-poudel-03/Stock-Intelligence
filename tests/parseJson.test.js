import { describe, it, expect } from 'vitest';
import { parseJson } from '../src/lib/llm.js';

// parseJson is the boundary between untrusted LLM text and every downstream
// signal/brief. It must tolerate junk and NEVER throw — a throw here would crash
// a scan instead of degrading it.
describe('parseJson', () => {
  it('returns null for empty / nullish input', () => {
    expect(parseJson('')).toBeNull();
    expect(parseJson(null)).toBeNull();
    expect(parseJson(undefined)).toBeNull();
  });

  it('parses a bare JSON object', () => {
    expect(parseJson('{"signal":"BUY"}')).toEqual({ signal: 'BUY' });
  });

  it('parses a bare JSON array', () => {
    expect(parseJson('["NABIL","UPPER"]')).toEqual(['NABIL', 'UPPER']);
  });

  it('unwraps a ```json fenced block', () => {
    expect(parseJson('```json\n{"signal":"SELL"}\n```')).toEqual({ signal: 'SELL' });
  });

  it('unwraps an unlabelled ``` fenced block', () => {
    expect(parseJson('```\n[1,2,3]\n```')).toEqual([1, 2, 3]);
  });

  it('extracts JSON embedded in surrounding prose', () => {
    expect(parseJson('Here is the result: {"x":2} — done')).toEqual({ x: 2 });
  });

  it('returns null (not a throw) for non-JSON junk', () => {
    expect(parseJson('the model refused to answer')).toBeNull();
  });
});

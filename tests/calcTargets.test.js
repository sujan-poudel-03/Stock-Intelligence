import { describe, it, expect } from 'vitest';
import { calcTargets } from '../src/lib/scan.js';

// TIER-2: direction-correct deterministic target/stop fill. BUY geometry is byte-for-byte
// as before; SELL inverts (target BELOW entry, stop ABOVE); an inverted LLM level (wrong
// side of entry for the direction) is repaired, but a wide-but-correct-side level is kept.

describe('calcTargets — BUY geometry (unchanged, byte-for-byte)', () => {
  it('auto-fills a 5% stop below and 8% target above the verified price', () => {
    const t = calcTargets({}, 500, 'Rs', 'BUY');
    expect(t.sl).toBe(475); // round(500 * 0.95)
    expect(t.target).toBe(540); // round(500 * 1.08)
    expect(t.entry).toBe('Rs 495-Rs 505'); // ±1% band
    expect(t.calculated).toBe(true);
  });

  it('defaults to BUY geometry when no direction is passed', () => {
    const t = calcTargets({}, 500);
    expect(t.sl).toBe(475);
    expect(t.target).toBe(540);
  });

  it('keeps a correct-side LLM level as-is (never discards a wide-but-correct one)', () => {
    const t = calcTargets({ entry: 'Rs 495-Rs 505', sl: 400, target: 600 }, 500, 'Rs', 'BUY');
    expect(t.sl).toBe(400); // below entry — correct side, kept
    expect(t.target).toBe(600); // above entry — correct side, kept
    expect(t.calculated).toBe(false); // nothing recomputed (entry also supplied)
  });
});

describe('calcTargets — SELL geometry', () => {
  it('auto-fills a target BELOW entry and a stop ABOVE entry', () => {
    const t = calcTargets({}, 500, 'Rs', 'SELL');
    expect(t.target).toBe(460); // round(500 * 0.92) — below entry
    expect(t.sl).toBe(525); // round(500 * 1.05) — above entry
    expect(t.target).toBeLessThan(500);
    expect(t.sl).toBeGreaterThan(500);
    expect(t.calculated).toBe(true);
  });

  it('repairs an inverted SELL target (LLM put it ABOVE entry)', () => {
    // A SELL profits DOWN; a target above entry is inverted → recompute it.
    const t = calcTargets({ target: 560, sl: 525 }, 500, 'Rs', 'SELL');
    expect(t.target).toBe(460); // recomputed below entry
    expect(t.sl).toBe(525); // already correct side (above) — kept
    expect(t.calculated).toBe(true);
  });

  it('repairs an inverted SELL stop (LLM put it BELOW entry)', () => {
    const t = calcTargets({ target: 460, sl: 470 }, 500, 'Rs', 'SELL');
    expect(t.sl).toBe(525); // recomputed above entry
    expect(t.target).toBe(460); // already correct side (below) — kept
  });

  it('keeps a wide-but-correct-side SELL pair', () => {
    const t = calcTargets({ entry: 'Rs 495-Rs 505', target: 400, sl: 560 }, 500, 'Rs', 'SELL');
    expect(t.target).toBe(400); // below entry — correct
    expect(t.sl).toBe(560); // above entry — correct
    expect(t.calculated).toBe(false); // nothing recomputed (entry also supplied)
  });
});

describe('calcTargets — HOLD / AVOID (BUY-like geometry, unchanged)', () => {
  it('HOLD auto-fills like BUY', () => {
    const t = calcTargets({}, 500, 'Rs', 'HOLD');
    expect(t.sl).toBe(475);
    expect(t.target).toBe(540);
  });

  it('AVOID auto-fills like BUY', () => {
    const t = calcTargets({}, 500, 'Rs', 'AVOID');
    expect(t.sl).toBe(475);
    expect(t.target).toBe(540);
  });
});

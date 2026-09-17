import { describe, it, expect } from 'vitest';
import { sma, ema, rsi, macd, bollingerBands, lastValue } from '../src/lib/indicators.js';

describe('sma', () => {
  it('is null before the period is filled', () => {
    const out = sma([1, 2, 3], 5);
    expect(out).toEqual([null, null, null]);
  });

  it('equals the constant value for a flat series', () => {
    const out = sma([10, 10, 10, 10], 3);
    expect(out[2]).toBeCloseTo(10);
    expect(out[3]).toBeCloseTo(10);
  });

  it('computes a simple rolling average correctly', () => {
    const out = sma([1, 2, 3, 4, 5], 3);
    expect(out).toEqual([null, null, 2, 3, 4]);
  });
});

describe('ema', () => {
  it('is null before the period is filled', () => {
    expect(ema([1, 2, 3], 5)).toEqual([null, null, null]);
  });

  it('seeds at the SMA of the first `period` values', () => {
    const out = ema([2, 4, 6, 8, 10], 3);
    expect(out[2]).toBeCloseTo(4); // sma(2,4,6)
    expect(out[3]).not.toBeNull();
    expect(out[4]).not.toBeNull();
  });

  it('tracks a flat series at the constant value', () => {
    const out = ema([5, 5, 5, 5, 5, 5], 3);
    expect(out[5]).toBeCloseTo(5);
  });
});

describe('rsi', () => {
  it('is null before period+1 closes exist', () => {
    const closes = Array.from({ length: 10 }, (_, i) => 100 + i);
    expect(rsi(closes, 14).every((v) => v === null)).toBe(true);
  });

  it('approaches 100 for a strictly rising series (no losses)', () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
    const out = rsi(closes, 14);
    expect(lastValue(out)).toBeCloseTo(100, 0);
  });

  it('approaches 0 for a strictly falling series (no gains)', () => {
    const closes = Array.from({ length: 20 }, (_, i) => 200 - i);
    const out = rsi(closes, 14);
    expect(lastValue(out)).toBeCloseTo(0, 0);
  });

  it('reads near 50 for a flat series (no net moves)', () => {
    const closes = new Array(20).fill(100);
    const out = rsi(closes, 14);
    expect(lastValue(out)).toBeCloseTo(50, 0);
  });
});

describe('macd', () => {
  it('all series are null until the slow EMA is ready', () => {
    const closes = Array.from({ length: 10 }, (_, i) => 100 + i);
    const { macd: line, signal, histogram } = macd(closes, 12, 26, 9);
    expect(line.every((v) => v === null)).toBe(true);
    expect(signal.every((v) => v === null)).toBe(true);
    expect(histogram.every((v) => v === null)).toBe(true);
  });

  it('produces a positive macd line for a sustained uptrend once ready', () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i * 0.5);
    const { macd: line } = macd(closes, 12, 26, 9);
    expect(lastValue(line)).toBeGreaterThan(0);
  });
});

describe('bollingerBands', () => {
  it('collapses to a flat band (zero width) for a constant series', () => {
    const closes = new Array(25).fill(50);
    const { mid, upper, lower } = bollingerBands(closes, 20, 2);
    expect(lastValue(mid)).toBeCloseTo(50);
    expect(lastValue(upper)).toBeCloseTo(50);
    expect(lastValue(lower)).toBeCloseTo(50);
  });

  it('widens the band with more dispersion', () => {
    const flat = new Array(25).fill(50);
    const noisy = flat.map((v, i) => v + (i % 2 === 0 ? 5 : -5));
    const bandFlat = bollingerBands(flat, 20, 2);
    const bandNoisy = bollingerBands(noisy, 20, 2);
    const widthFlat = lastValue(bandFlat.upper) - lastValue(bandFlat.lower);
    const widthNoisy = lastValue(bandNoisy.upper) - lastValue(bandNoisy.lower);
    expect(widthNoisy).toBeGreaterThan(widthFlat);
  });
});

describe('lastValue', () => {
  it('returns the most recent non-null reading', () => {
    expect(lastValue([null, null, 5, null])).toBe(5);
  });
  it('returns null when nothing has resolved yet', () => {
    expect(lastValue([null, null])).toBeNull();
  });
  it('returns null for a non-array input', () => {
    expect(lastValue(null)).toBeNull();
  });
});

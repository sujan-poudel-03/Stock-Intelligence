import { describe, it, expect } from 'vitest';
// Import the PURE module (no React / no 'use client') so this test never loads a
// client component into Vitest's node worker — that can poison the thread pool and
// fail the whole suite intermittently.
import { breakpointFor, BREAKPOINTS } from '../src/lib/breakpoints.js';

// The pure classifier behind useBreakpoint. Structural responsiveness keys off
// these buckets, so the boundaries are money-critical for layout correctness.
describe('breakpointFor', () => {
  it('classifies narrow phones as mobile', () => {
    expect(breakpointFor(320)).toBe('mobile');
    expect(breakpointFor(360)).toBe('mobile');
    expect(breakpointFor(639)).toBe('mobile');
  });

  it('classifies mid widths as tablet', () => {
    expect(breakpointFor(640)).toBe('tablet');
    expect(breakpointFor(768)).toBe('tablet');
    expect(breakpointFor(1023)).toBe('tablet');
  });

  it('classifies wide viewports as desktop', () => {
    expect(breakpointFor(1024)).toBe('desktop');
    expect(breakpointFor(1440)).toBe('desktop');
    expect(breakpointFor(1920)).toBe('desktop');
  });

  it('boundaries are exact and half-open [lo, hi)', () => {
    expect(breakpointFor(BREAKPOINTS.mobile - 1)).toBe('mobile');
    expect(breakpointFor(BREAKPOINTS.mobile)).toBe('tablet');
    expect(breakpointFor(BREAKPOINTS.tablet - 1)).toBe('tablet');
    expect(breakpointFor(BREAKPOINTS.tablet)).toBe('desktop');
  });
});

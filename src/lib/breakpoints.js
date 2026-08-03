// Pure responsive-breakpoint primitives — no React, no 'use client'. Kept in a
// plain module so unit tests can import the classifier WITHOUT dragging a client
// component (and thus React) into Vitest's node worker, which can poison the
// thread pool. The React hook (useBreakpoint) consumes these.
//
// Breakpoints (kept in sync with globals.css media queries):
//   mobile  < 640px
//   tablet  640–1024px
//   desktop > 1024px
export const BREAKPOINTS = { mobile: 640, tablet: 1024 };

// Given a viewport width in px, return the breakpoint name. Half-open [lo,hi).
export function breakpointFor(width) {
  if (width < BREAKPOINTS.mobile) return 'mobile';
  if (width < BREAKPOINTS.tablet) return 'tablet';
  return 'desktop';
}

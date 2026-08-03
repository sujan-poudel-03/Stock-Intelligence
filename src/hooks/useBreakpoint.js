'use client';

import { useEffect, useState } from 'react';
import { BREAKPOINTS, breakpointFor } from '@/lib/breakpoints';

// Responsive breakpoint hook. Mobile-first, but SSR-safe: on the server (and the
// very first client render, before the effect runs) it reports 'desktop' so the
// server-rendered markup matches the historical desktop layout and there's no
// hydration mismatch / mobile flash on wide screens. The real width is measured in
// useEffect and updates via a matchMedia listener.
//
// The pure classifier + breakpoint values live in @/lib/breakpoints (no React) so
// tests verify the mapping without loading a client component. Re-exported here for
// existing importers.
export { BREAKPOINTS, breakpointFor };

export default function useBreakpoint() {
  // Default to a desktop-sized viewport so the server render + first paint keep the
  // existing desktop structure. Real value is set in the effect below.
  const [width, setWidth] = useState(1280);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;

    const update = () => setWidth(window.innerWidth);
    update();

    // One media query per boundary; either firing means the bucket may have changed.
    const mqMobile = window.matchMedia(`(max-width: ${BREAKPOINTS.mobile - 1}px)`);
    const mqTablet = window.matchMedia(`(max-width: ${BREAKPOINTS.tablet - 1}px)`);
    // addEventListener('change') is the modern API; older Safari needs addListener.
    const add = (mq, fn) => (mq.addEventListener ? mq.addEventListener('change', fn) : mq.addListener(fn));
    const remove = (mq, fn) => (mq.removeEventListener ? mq.removeEventListener('change', fn) : mq.removeListener(fn));
    add(mqMobile, update);
    add(mqTablet, update);

    return () => {
      remove(mqMobile, update);
      remove(mqTablet, update);
    };
  }, []);

  const bp = breakpointFor(width);
  return {
    width,
    breakpoint: bp,
    isMobile: bp === 'mobile',
    isTablet: bp === 'tablet',
    isDesktop: bp === 'desktop',
  };
}

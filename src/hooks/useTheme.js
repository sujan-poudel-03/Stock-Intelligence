'use client';

import { useEffect, useState } from 'react';

// Personal-preference theme (dark [default] / light / system) — closes the
// "add a theme for personal preference" ask. Device-local only (matches the
// app's existing pattern for view preferences like the exchange selector) —
// not synced anywhere, never sent to the server.
//
// Only the NEUTRAL palette actually changes between themes (surfaces/borders/
// text — see src/app/globals.css); semantic accent colors stay constant. This
// hook just manages WHICH theme is active: it sets `data-theme` on <html>,
// which is what the CSS variables in globals.css key off.
const STORAGE_KEY = 'ni:theme';

function systemPrefersLight() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-color-scheme: light)').matches;
}

function applyTheme(pref) {
  if (typeof document === 'undefined') return;
  const resolved = pref === 'system' ? (systemPrefersLight() ? 'light' : 'dark') : pref;
  if (resolved === 'light') document.documentElement.setAttribute('data-theme', 'light');
  else document.documentElement.removeAttribute('data-theme'); // dark = the un-stamped default
}

export default function useTheme() {
  // SSR-safe default ('dark', matching the app's original look) — the real
  // preference is read from localStorage in the effect below, same pattern as
  // useBreakpoint's SSR-safe width default.
  const [pref, setPref] = useState('dark');

  useEffect(() => {
    let stored = 'dark';
    try {
      stored = window.localStorage.getItem(STORAGE_KEY) || 'dark';
    } catch {
      /* localStorage unavailable (private mode etc.) — stay on the dark default */
    }
    setPref(stored);
    applyTheme(stored);

    if (stored !== 'system' || typeof window.matchMedia !== 'function') return undefined;
    // Live-follow the OS theme while "system" is selected.
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => applyTheme('system');
    (mq.addEventListener ? mq.addEventListener('change', onChange) : mq.addListener(onChange));
    return () => (mq.removeEventListener ? mq.removeEventListener('change', onChange) : mq.removeListener(onChange));
  }, []);

  function setTheme(next) {
    setPref(next);
    applyTheme(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* best-effort persistence only */
    }
  }

  return { theme: pref, setTheme };
}

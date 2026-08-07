'use client';

import { useEffect } from 'react';

// Registers the service worker after load so the app is installable and works
// offline (shell only — live data always requires the network; see public/sw.js).
// No UI; mounted once in the root layout.
export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

    // DEV: never run the SW. In `next dev` the client chunks have STABLE urls (not
    // content-hashed like production), and sw.js caches `.js` cache-first — so a
    // registered SW serves STALE client code against a fresh server, producing the
    // classic "Server: X / Client: Y" hydration mismatch and a UI that silently runs
    // old code. So in development we do the OPPOSITE of register: tear down any
    // existing SW + its caches so every reload is the real current code. The PWA
    // (offline shell) is a production-only concern, where hashed chunk urls make the
    // cache-first strategy safe.
    if (process.env.NODE_ENV !== 'production') {
      navigator.serviceWorker.getRegistrations?.()
        .then((regs) => regs.forEach((r) => r.unregister()))
        .catch(() => {});
      if (typeof caches !== 'undefined') {
        caches.keys?.().then((keys) => keys.forEach((k) => caches.delete(k))).catch(() => {});
      }
      return;
    }

    const onLoad = () => {
      navigator.serviceWorker.register('/sw.js').catch((err) => {
        // Non-fatal: the app still works without offline support.
        console.warn('SW registration failed:', err?.message || err);
      });
    };
    if (document.readyState === 'complete') onLoad();
    else {
      window.addEventListener('load', onLoad);
      return () => window.removeEventListener('load', onLoad);
    }
  }, []);
  return null;
}

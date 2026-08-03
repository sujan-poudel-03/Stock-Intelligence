'use client';

import { useEffect } from 'react';

// Registers the service worker after load so the app is installable and works
// offline (shell only — live data always requires the network; see public/sw.js).
// No UI; mounted once in the root layout.
export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
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

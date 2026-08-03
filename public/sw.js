/* Stock Intelligence service worker.
 *
 * GUARDRAIL: never cache /api/* — signals and prices must be ground truth. A stale
 * cached price served offline would be exactly the "wrong price = financial harm"
 * failure the project bars. API requests always go to the network; when offline they
 * simply fail and the app degrades to its empty/error state.
 *
 * Strategy:
 *   - /api/*            -> bypass SW entirely (always live network)
 *   - navigations       -> network-first, fall back to cached shell when offline
 *   - hashed static     -> cache-first (immutable: /_next/static, icons)
 *   - everything else   -> network, cache a copy opportunistically
 */
const VERSION = 'v1';
const SHELL_CACHE = `shell-${VERSION}`;
const ASSET_CACHE = `assets-${VERSION}`;
const SHELL_URLS = ['/', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL_URLS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== SHELL_CACHE && k !== ASSET_CACHE).map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // never touch POST/PUT/etc.

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // cross-origin: passthrough
  if (url.pathname.startsWith('/api/')) return;    // GUARDRAIL: live data only, never cached

  // Navigations: network-first so users always get the freshest shell; fall back to
  // the cached shell (then '/') only when the network is unavailable.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match('/')))
    );
    return;
  }

  // Immutable, content-hashed assets: cache-first.
  if (url.pathname.startsWith('/_next/static/') || /\.(png|ico|svg|woff2?|css|js)$/.test(url.pathname)) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            const copy = res.clone();
            caches.open(ASSET_CACHE).then((c) => c.put(req, copy)).catch(() => {});
            return res;
          })
      )
    );
    return;
  }

  // Default: network, with a cache fallback if offline.
  event.respondWith(fetch(req).catch(() => caches.match(req)));
});

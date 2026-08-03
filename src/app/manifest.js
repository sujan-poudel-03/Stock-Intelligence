// PWA manifest (Next 14 App Router file convention). Served at
// /manifest.webmanifest and auto-linked in <head>. Keep colors in sync with the
// dark app shell (#0b0e16) and the brand blue used across the UI.
export default function manifest() {
  return {
    name: 'Stock Intelligence — NEPSE & NYSE',
    short_name: 'StockIntel',
    description:
      'AI analyst for NEPSE & NYSE — transparent signals, live verified prices, and a full WIN/LOSS track record. Educational, not financial advice.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait-primary',
    background_color: '#0b0e16',
    theme_color: '#0b0e16',
    categories: ['finance', 'business', 'productivity'],
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}

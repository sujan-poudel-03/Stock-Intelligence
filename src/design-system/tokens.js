// Design tokens — Phase 1 of the NEPSE Intelligence V2 UI/UX redesign
// (docs/NEPSE_INTELLIGENCE_V2_DISCOVERY.md). Plain JS objects, no build step,
// no CSS-in-JS library — consumed as inline `style` values, same as the rest
// of this codebase (see NepseApp.jsx's card()/btn()/sbox() helpers).
//
// Scope discipline: only tokens actually consumed by a migrated screen belong
// here. Don't add a token "for completeness" — extend this file when the next
// screen needs it, not speculatively (CLAUDE.md: no abstractions beyond what
// the task requires).

export const color = {
  // Surfaces (darkest -> lightest)
  canvas: '#07090e',      // app background
  surface: '#0b0e16',     // card background
  surfaceSunken: '#080a0f', // inset panels inside a card (quotes, code-like blocks)
  surfaceRaised: '#0d1018', // slightly-lifted card (banners, secondary panels)
  border: '#1e2840',      // default card/divider border
  borderSubtle: '#141824', // quieter border (header rules, stat-box borders)

  // Text
  textPrimary: '#e2e8f0',
  textSecondary: '#c8d4e8',
  textMuted: '#8899b4',
  textFaint: '#4a5568',
  textGhost: '#2a3550',

  // Semantic status (never the ONLY signal — always paired with a label/icon)
  positive: '#10b981', // BUY / gains / verified / target-hit
  negative: '#ef4444', // SELL / losses / stop-breach / error
  warning: '#f59e0b',  // HOLD / caution / stale / partial
  info: '#3b82f6',     // primary accent / links / neutral action
  muted: '#64748b',    // AVOID / neutral-weight text
  discovery: '#a78bfa', // agent-discovered provenance

  // Signal + provenance maps (existing SIG_COLORS / SRC_COLORS, centralized)
  signal: { BUY: '#10b981', SELL: '#ef4444', WATCH: '#f59e0b', AVOID: '#64748b', HOLD: '#f59e0b', NEUTRAL: '#64748b' },
  sentiment: { BULLISH: '#10b981', BEARISH: '#ef4444', NEUTRAL: '#f59e0b' },
  confidence: { HIGH: '#10b981', MEDIUM: '#f59e0b', LOW: '#4a5568' },
};

// 4/8-based spacing scale (px). Use spacing[n], not raw numbers, in new code.
export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24, xxxl: 32 };

export const radius = { sm: 5, md: 7, lg: 10, xl: 14, pill: 20 };

export const font = {
  ui: 'Inter,sans-serif',       // labels, headings, prose
  mono: 'IBM Plex Mono,monospace', // prices, symbols, timestamps, metrics
  prose: 'IBM Plex Sans,sans-serif', // longer explanatory text (signal "why", brief)
};

// Type scale (px). Named by role, not size, so a later re-tune doesn't require
// touching every call site.
export const text = {
  micro: 8,   // eyebrow labels, stat-box captions
  caption: 9, // badges, meta
  small: 10,  // secondary body text
  body: 11,   // default body text
  base: 12,   // default UI text / table cells
  label: 13,  // section headers
  title: 14,  // card headlines
  hero: 20,   // page-level hero numbers (index value, big stats)
};

'use client';

import { color, radius, font, text } from '@/design-system/tokens';

// The rounded, dot-led status pill used for hero-level state (market sentiment,
// data freshness). Distinct from Pill.jsx (a compact square-ish label badge for
// roles/outcomes like ADMIN/LIVE/ACTIVE) — this one is for a single prominent
// status at the top of a card, not a dense row of small tags. Color is always
// paired with the label text, never the only signal.
export default function StatusPill({ tone, children }) {
  const c = tone || color.muted;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: text.caption, fontWeight: 600, padding: '3px 9px', borderRadius: radius.pill, background: c + '1c', color: c, fontFamily: font.ui, whiteSpace: 'nowrap' }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: c, flexShrink: 0 }} />
      {children}
    </span>
  );
}

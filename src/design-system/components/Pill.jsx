'use client';

import { color, radius, font, text } from '@/design-system/tokens';

// The small colored status/role/provenance badge — previously hand-duplicated as
// slightly different inline spans for ADMIN/USER (AuthPanel), LIVE/SAMPLE/DISABLED
// (AdminDataSources), ACTIVE/OFF (AdminChannels), and BUY/SELL/HOLD/AVOID +
// WIN/LOSS/EXPIRE (NepseApp). Any new status/role/outcome badge should use this
// instead of re-inlining `{fontSize,fontWeight,color,background,padding,borderRadius}`
// — see CLAUDE.md "UI component reuse". Color is always paired with the label text,
// never the only signal (colorblind/accessibility rule from the redesign brief).
export default function Pill({ children, tone, dot }) {
  const c = tone || color.muted;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: dot ? 5 : 0, fontSize: text.micro, fontWeight: 700, letterSpacing: '.04em', color: c, background: c + '20', padding: '1px 6px', borderRadius: radius.sm, fontFamily: font.mono, whiteSpace: 'nowrap' }}>
      {dot && <span style={{ width: 5, height: 5, borderRadius: '50%', background: c, flexShrink: 0 }} />}
      {children}
    </span>
  );
}

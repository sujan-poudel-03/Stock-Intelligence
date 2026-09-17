'use client';

import { color, radius, spacing, font, text } from '@/design-system/tokens';

// The "icon-badge + title + subtitle" card header, previously hand-duplicated
// (nearly verbatim) across Settings' Exchange/My Alerts/Discovery/Auto-Remove/
// Sector-Focus blocks and the standalone AdminDataSources/AdminChannels
// components. Any new settings/admin-style card should use this instead of
// re-inlining the header markup — see CLAUDE.md "UI component reuse".
//
// props: icon (short glyph/text), iconColor, title, subtitle, right (optional
// trailing control, e.g. a ToggleBtn), children (the card body).
export default function SectionCard({ icon, iconColor, title, subtitle, right, children, style }) {
  const ic = iconColor || color.info;
  return (
    <div style={{ background: color.surface, border: '1px solid ' + color.border, borderRadius: radius.lg, padding: '16px 18px', marginBottom: spacing.md, ...style }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: children ? 14 : 0 }}>
        {icon && (
          <div style={{ width: 28, height: 28, borderRadius: 8, background: ic + '18', border: '1px solid ' + ic + '33', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: text.base, color: ic, fontFamily: font.mono, fontWeight: 600, flexShrink: 0 }}>{icon}</div>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: text.base, fontWeight: 600, color: color.textPrimary, fontFamily: font.ui }}>{title}</div>
          {subtitle && <div style={{ fontSize: text.small, color: color.textFaint, marginTop: 1 }}>{subtitle}</div>}
        </div>
        {right}
      </div>
      {children}
    </div>
  );
}

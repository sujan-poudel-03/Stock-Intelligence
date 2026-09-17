'use client';

import { color, spacing, radius, font, text } from '@/design-system/tokens';

// Portfolio sector-concentration view (Phase C risk tools, closing the "no
// portfolio-level risk view" gap from the trader/product review). Renders the
// server-computed breakdown from src/lib/portfolioMath.js (GET /api/portfolio/
// summary) — real current-value shares of the OPEN book, not agent output. A
// bucket over the threshold is flagged (surfaced as a metric, never advice).
export default function ConcentrationBars({ bySector, threshold, overConcentrated }) {
  if (!bySector || bySector.length === 0) return null;
  return (
    <div style={{ background: color.surface, border: '1px solid ' + color.border, borderRadius: radius.lg, padding: '14px 16px', marginBottom: spacing.md }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: spacing.sm }}>
        <span style={{ fontSize: text.base, fontWeight: 600, color: color.textPrimary, fontFamily: font.ui }}>Sector Concentration</span>
        <span style={{ fontSize: text.caption, color: color.textFaint }}>{'share of open-position value · flagged over ' + threshold + '%'}</span>
      </div>
      {overConcentrated && (
        <div style={{ fontSize: text.small, color: color.warning, background: color.warning + '12', border: '1px solid ' + color.warning + '33', borderRadius: radius.md, padding: '6px 10px', marginBottom: spacing.sm }}>
          One or more sectors exceed {threshold}% of your open positions — a concentration metric, not a recommendation to act.
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {bySector.map((row) => (
          <div key={row.key}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: text.small, marginBottom: 3 }}>
              <span style={{ color: row.overConcentrated ? color.warning : color.textSecondary, fontFamily: font.ui }}>{row.key}</span>
              <span style={{ color: row.overConcentrated ? color.warning : color.textFaint, fontFamily: font.mono }}>{row.pct.toFixed(1) + '%'}</span>
            </div>
            <div style={{ height: 5, background: color.borderSubtle, borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: Math.min(100, row.pct) + '%', background: row.overConcentrated ? color.warning : color.info }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

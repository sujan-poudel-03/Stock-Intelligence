'use client';

import { color, spacing, radius, font, text } from '@/design-system/tokens';

// Closes the "Track Record has no verified index benchmark" gap: shows the NEPSE
// Index's own real return over the SAME window the price_history table has been
// recording (src/lib/merolaganiIndex.js + getVerifiedIndex — a second, independent
// verified source, never the LLM). NEPSE-only for now (the scraper is
// merolagani-specific); on NYSE or before any bars exist this renders nothing,
// same honest-empty-state convention as BacktestDemo/PriceChart.
//
// Deliberately NOT a strict apples-to-apples "beat the market" claim: the agent's
// own track record (passed in as `track`) is an average PER-TRADE return over a
// mix of holding periods, while the index number here is a single buy-and-hold
// return over the recorded window — different measures shown side by side for
// context, not blended into one number.
export default function IndexBenchmark({ bars, track }) {
  if (!bars || bars.length < 2) return null;

  const first = bars[0];
  const last = bars[bars.length - 1];
  const startVal = Number(first.close);
  const endVal = Number(last.close);
  if (!(startVal > 0) || !(endVal > 0)) return null;

  const indexReturnPct = Math.round(((endVal - startVal) / startVal) * 10000) / 100;
  const agentAvg = track?.overall?.avgNetReturn;
  const hasAgentAvg = Number.isFinite(agentAvg);

  return (
    <div>
      <div style={{ fontSize: text.caption, color: color.textGhost, marginBottom: spacing.sm, lineHeight: 1.5 }}>
        NEPSE Index&apos;s own buy-and-hold return, {first.date} → {last.date} ({bars.length} recorded day{bars.length === 1 ? '' : 's'}) — a verified, non-LLM reading (merolagani index history), shown for context alongside the agent&apos;s track record above. Not a like-for-like comparison: this is one buy-and-hold return over the window; the agent&apos;s figure is an average PER-TRADE return across many shorter holds.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(120px,1fr))', gap: spacing.sm }}>
        <Stat
          label="NEPSE index return"
          value={(indexReturnPct >= 0 ? '+' : '') + indexReturnPct + '%'}
          tone={indexReturnPct >= 0 ? color.positive : color.negative}
        />
        {hasAgentAvg && (
          <Stat
            label="agent avg return / trade"
            value={(agentAvg >= 0 ? '+' : '') + agentAvg + '%'}
            tone={agentAvg >= 0 ? color.positive : color.negative}
          />
        )}
      </div>
      {bars.length < 20 && (
        <div style={{ fontSize: text.caption, color: color.textGhost, marginTop: 6 }}>
          Benchmark window is still short — one bar is recorded per scan day, so this grows more meaningful over time.
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone }) {
  return (
    <div style={{ background: color.surfaceSunken, borderRadius: radius.md, padding: '8px 10px', border: '1px solid ' + color.borderSubtle }}>
      <div style={{ fontSize: text.micro, color: color.textGhost, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: text.base, fontWeight: 600, color: tone || color.textSecondary, fontFamily: font.mono }}>{value}</div>
    </div>
  );
}

'use client';

import { runBacktest, smaStrategy } from '@/lib/backtest';
import { color, spacing, radius, font, text } from '@/design-system/tokens';

// Exposes the existing backtest harness (src/lib/backtest.js — no-look-ahead-safe,
// already used internally for calibration validation) to users directly, closing
// the "backtest exists but is invisible to users" gap from the trader/product
// review. Runs CLIENT-SIDE on the verified price_history bars the stock overlay
// already fetched (Phase A) — cheap pure arithmetic, no server round-trip.
//
// IMPORTANT — this demonstrates the HARNESS, not the agent's own track record: it
// replays a simple, fixed reference strategy (price crosses above its N-day
// average) against this stock's real price history. It is NOT a backtest of the
// LLM's actual historical calls (that would require re-running the LLM against
// every past day, which isn't done here) and must never be presented as such —
// the real, honest agent track record lives on the Track Record tab.
export default function BacktestDemo({ bars }) {
  if (!bars || bars.length < 10) return null;

  const priceBars = bars.map((b) => ({ date: b.date, price: Number(b.close) }));
  const { trades, metrics } = runBacktest(priceBars, smaStrategy({ window: 5, stopPct: 0.05, targetPct: 0.08 }));

  return (
    <div>
      <div style={{ fontSize: text.caption, color: color.textGhost, marginBottom: spacing.sm, lineHeight: 1.5 }}>
        A reference strategy (price crosses above its 5-day average, ±5%/8% stop/target) replayed against this stock&apos;s real price history — a demonstration of the no-look-ahead backtest harness, NOT this agent&apos;s actual signal history. See Track Record for the real, verified performance.
      </div>
      {metrics.closed === 0 ? (
        <div style={{ fontSize: text.small, color: color.textFaint }}>Not enough resolved reference trades yet in this stock&apos;s history.</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(100px,1fr))', gap: spacing.sm }}>
          <Stat label="reference trades" value={String(metrics.closed)} />
          <Stat label="win rate" value={Math.round(metrics.winRate * 100) + '%'} tone={metrics.winRate >= 0.5 ? color.positive : color.negative} />
          <Stat label="avg return" value={(metrics.avgReturn >= 0 ? '+' : '') + metrics.avgReturn + '%'} tone={metrics.avgReturn >= 0 ? color.positive : color.negative} />
          <Stat label="max drawdown" value={metrics.maxDrawdownPct + '%'} tone={color.warning} />
        </div>
      )}
      {trades.length > metrics.closed && (
        <div style={{ fontSize: text.caption, color: color.textGhost, marginTop: 6 }}>{trades.length - metrics.closed} trade(s) still open (not enough forward history yet).</div>
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

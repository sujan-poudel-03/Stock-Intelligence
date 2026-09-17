'use client';

import { sma, rsi, macd, bollingerBands, lastValue } from '@/lib/indicators';
import { color, spacing, radius, font, text } from '@/design-system/tokens';

// Technical-indicator readout (Phase B of the redesign, closing the "no
// indicators" gap from the trader/product review). Computed CLIENT-SIDE from the
// bars the stock overlay already fetched via /api/price-history — no new fetch,
// no server round-trip. Every reading is deterministic math over verified closes
// (src/lib/indicators.js) — the LLM never sets or overrides these numbers.
//
// Each indicator degrades independently: with fewer bars than an indicator needs
// (e.g. RSI needs 15, a 50-day SMA needs 50), that ONE stat shows "not enough
// history yet" instead of a wrong or fabricated reading — the others still render
// if they have enough data.
function Stat({ label, value, sub, tone }) {
  return (
    <div style={{ background: color.surfaceSunken, borderRadius: radius.md, padding: '8px 10px', border: '1px solid ' + color.borderSubtle }}>
      <div style={{ fontSize: text.micro, color: color.textGhost, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 3 }}>{label}</div>
      {value == null ? (
        <div style={{ fontSize: text.small, color: color.textGhost }}>not enough history</div>
      ) : (
        <>
          <div style={{ fontSize: text.base, fontWeight: 600, color: tone || color.textSecondary, fontFamily: font.mono }}>{value}</div>
          {sub && <div style={{ fontSize: text.caption, color: color.textFaint, marginTop: 1 }}>{sub}</div>}
        </>
      )}
    </div>
  );
}

export default function IndicatorSummary({ bars }) {
  if (!bars || bars.length < 2) return null;

  const closes = bars.map((b) => Number(b.close));
  const price = closes[closes.length - 1];

  const sma20 = lastValue(sma(closes, 20));
  const sma50 = lastValue(sma(closes, 50));
  const rsi14 = lastValue(rsi(closes, 14));
  const macdHist = lastValue(macd(closes, 12, 26, 9).histogram);
  const bb = bollingerBands(closes, 20, 2);
  const bbUpper = lastValue(bb.upper);
  const bbLower = lastValue(bb.lower);

  // Trend: only a real read once both averages exist; otherwise honestly unknown.
  let trendLabel = null;
  let trendTone = color.muted;
  if (sma20 != null && sma50 != null) {
    if (price > sma20 && sma20 > sma50) { trendLabel = 'Uptrend'; trendTone = color.positive; }
    else if (price < sma20 && sma20 < sma50) { trendLabel = 'Downtrend'; trendTone = color.negative; }
    else { trendLabel = 'Mixed'; trendTone = color.warning; }
  }

  let rsiLabel = null;
  let rsiTone = color.muted;
  if (rsi14 != null) {
    if (rsi14 >= 70) { rsiLabel = 'Overbought'; rsiTone = color.warning; }
    else if (rsi14 <= 30) { rsiLabel = 'Oversold'; rsiTone = color.info; }
    else { rsiLabel = 'Neutral'; rsiTone = color.textSecondary; }
  }

  let macdLabel = null;
  let macdTone = color.muted;
  if (macdHist != null) {
    macdLabel = macdHist > 0 ? 'Bullish momentum' : macdHist < 0 ? 'Bearish momentum' : 'Flat';
    macdTone = macdHist > 0 ? color.positive : macdHist < 0 ? color.negative : color.muted;
  }

  let bbLabel = null;
  let bbTone = color.muted;
  if (bbUpper != null && bbLower != null) {
    const span = bbUpper - bbLower || 1;
    const pos = (price - bbLower) / span;
    if (pos >= 0.9) { bbLabel = 'Near upper band'; bbTone = color.warning; }
    else if (pos <= 0.1) { bbLabel = 'Near lower band'; bbTone = color.info; }
    else { bbLabel = 'Mid-range'; bbTone = color.textSecondary; }
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(120px,1fr))', gap: spacing.sm }}>
      <Stat label="Trend (20/50 SMA)" value={trendLabel} sub={sma20 != null && sma50 != null ? 'SMA20 ' + sma20.toFixed(1) + ' · SMA50 ' + sma50.toFixed(1) : null} tone={trendTone} />
      <Stat label="RSI (14)" value={rsi14 != null ? rsi14.toFixed(0) : null} sub={rsiLabel} tone={rsiTone} />
      <Stat label="MACD" value={macdLabel} sub={macdHist != null ? 'hist ' + macdHist.toFixed(2) : null} tone={macdTone} />
      <Stat label="Bollinger" value={bbLabel} sub={bbUpper != null ? 'band ' + bbLower.toFixed(1) + '–' + bbUpper.toFixed(1) : null} tone={bbTone} />
    </div>
  );
}

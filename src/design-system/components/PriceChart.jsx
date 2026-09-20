'use client';

import { useState } from 'react';
import { color, text, font } from '@/design-system/tokens';

// The redesign's Phase A deliverable: a real price chart, fed by GET /api/price-history
// (the price_history table — verified daily bars, never LLM-sourced). Hand-rolled SVG,
// no charting library — this app has zero runtime UI dependencies anywhere, and a daily
// close/area line doesn't need one; a real library is worth adding later if candlesticks
// or zoom/pan become a real requirement.
//
// Renders an AREA of daily closes, not a candlestick — the verified-price layer never
// carries an "open" (see supabase/migrations/20260917000000_price_history.sql), so a
// candlestick would have to invent one. Shows an honest empty state instead of a broken
// chart when there isn't enough history yet (a brand-new symbol, or a DB that predates
// this table).
const WIDTH = 640;
const HEIGHT = 180;
const PAD = { top: 12, right: 12, bottom: 20, left: 44 };

export default function PriceChart({ bars }) {
  const [hover, setHover] = useState(null); // index into `bars`, or null

  if (!bars || bars.length < 2) {
    return (
      <div style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px dashed ' + color.border, borderRadius: 8, fontSize: text.small, color: color.textFaint, textAlign: 'center', padding: '0 20px' }}>
        Not enough price history yet to chart — this builds up one verified bar per scan day.
      </div>
    );
  }

  const closes = bars.map((b) => Number(b.close)).filter(Number.isFinite);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const range = max - min || 1;
  const plotW = WIDTH - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;

  const xAt = (i) => PAD.left + (bars.length === 1 ? 0 : (i / (bars.length - 1)) * plotW);
  const yAt = (v) => PAD.top + plotH - ((v - min) / range) * plotH;

  const points = bars.map((b, i) => [xAt(i), yAt(Number(b.close))]);
  const linePath = points.map((p, i) => (i === 0 ? 'M' : 'L') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
  const areaPath = linePath + ` L${points[points.length - 1][0].toFixed(1)},${(PAD.top + plotH).toFixed(1)} L${points[0][0].toFixed(1)},${(PAD.top + plotH).toFixed(1)} Z`;

  const first = closes[0];
  const last = closes[closes.length - 1];
  const up = last >= first;
  const lineColor = up ? color.positive : color.negative;
  const active = hover != null ? bars[hover] : bars[bars.length - 1];

  function onMove(e) {
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / rect.width) * WIDTH;
    let nearest = 0;
    let best = Infinity;
    for (let i = 0; i < points.length; i++) {
      const d = Math.abs(points[i][0] - relX);
      if (d < best) { best = d; nearest = i; }
    }
    setHover(nearest);
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
        <span style={{ fontSize: text.hero, fontWeight: 700, color: color.textPrimary, fontFamily: font.mono }}>{'Rs ' + Number(active.close).toLocaleString('en-IN')}</span>
        <span style={{ fontSize: text.small, color: color.textFaint, fontFamily: font.mono }}>{active.date}{active.stale ? ' · stale' : ''}</span>
      </div>
      <svg
        viewBox={'0 0 ' + WIDTH + ' ' + HEIGHT}
        style={{ width: '100%', height: 'auto', display: 'block', cursor: 'crosshair' }}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id="priceChartFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={lineColor} stopOpacity="0.28" />
            <stop offset="100%" stopColor={lineColor} stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* faint horizontal grid at min/mid/max, each labeled with the value it names */}
        {[min, (min + max) / 2, max].map((v, i) => (
          <g key={i}>
            <line x1={PAD.left} x2={WIDTH - PAD.right} y1={yAt(v)} y2={yAt(v)} stroke={color.borderSubtle} strokeWidth="1" />
            <text x={PAD.left - 6} y={yAt(v) + 3} textAnchor="end" fontSize="9" fontFamily={font.mono} fill={color.textGhost}>{Math.round(v)}</text>
          </g>
        ))}
        <path d={areaPath} fill="url(#priceChartFill)" stroke="none" />
        <path d={linePath} fill="none" stroke={lineColor} strokeWidth="1.75" />
        {hover != null && (
          <g>
            <line x1={points[hover][0]} x2={points[hover][0]} y1={PAD.top} y2={PAD.top + plotH} stroke={color.border} strokeWidth="1" />
            <circle cx={points[hover][0]} cy={points[hover][1]} r="3" fill={lineColor} />
          </g>
        )}
        <text x={PAD.left} y={HEIGHT - 4} fontSize="9" fontFamily={font.mono} fill={color.textGhost}>{bars[0].date}</text>
        <text x={WIDTH - PAD.right} y={HEIGHT - 4} textAnchor="end" fontSize="9" fontFamily={font.mono} fill={color.textGhost}>{bars[bars.length - 1].date}</text>
      </svg>
    </div>
  );
}

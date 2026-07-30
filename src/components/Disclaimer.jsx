'use client';

import { useEffect, useState } from 'react';
import { getExchange } from '@/lib/exchanges';

// Persistent disclaimer strip shown on every surface (mounted in the app shell).
// Enforces guardrail #2 (every signal/brief surface carries "educational, not
// financial advice") AND ties it to data reality: when a non-live source is active,
// it loudly flags that prices are SAMPLE data, so they can't be mistaken for real.
// The regulator-specific copy (SEBON vs SEC/FINRA) follows the ACTIVE exchange.
// Placeholder wording — final legal copy comes from the SEBON/legal review (P3-1).
export default function Disclaimer({ exchange }) {
  const [sampleActive, setSampleActive] = useState(false);
  const disclaimerText = getExchange(exchange).disclaimer.text;

  useEffect(() => {
    let alive = true;
    fetch('/api/admin/sources')
      .then((r) => r.json())
      .then((d) => {
        if (!alive || !Array.isArray(d.providers) || !Array.isArray(d.active)) return;
        const nonLive = d.active.some((id) => {
          const p = d.providers.find((x) => x.id === id);
          return p && p.status !== 'live';
        });
        setSampleActive(nonLive);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div
      style={{
        background: sampleActive ? '#f59e0b0e' : '#0b0e16',
        borderBottom: '1px solid ' + (sampleActive ? '#f59e0b33' : '#141824'),
        padding: '5px 16px',
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        flexWrap: 'wrap',
        lineHeight: 1.4,
      }}
    >
      {sampleActive && (
        <span style={{ fontSize: 9, fontWeight: 700, color: '#f59e0b', fontFamily: 'IBM Plex Mono,monospace' }}>
          ⚠ SAMPLE DATA — not real market prices.
        </span>
      )}
      <span style={{ fontSize: 9, color: sampleActive ? '#a1671a' : '#4a5568', fontFamily: 'Inter,sans-serif' }}>
        {disclaimerText}
      </span>
    </div>
  );
}

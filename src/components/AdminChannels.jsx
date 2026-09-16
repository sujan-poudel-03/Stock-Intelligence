'use client';

import { useEffect, useState } from 'react';
import { color, text, font } from '@/design-system/tokens';
import SectionCard from '@/design-system/components/SectionCard';
import Pill from '@/design-system/components/Pill';

// Settings → Notifications (admin). Read-only status of delivery channels. A channel
// is ACTIVE automatically when its required env is present (no UI toggle) — this just
// shows which are on and, for the ones that are off, what env turns them on.
export default function AdminChannels() {
  const [channels, setChannels] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    fetch('/api/admin/channels')
      .then((r) => r.json())
      .then((d) => {
        if (alive && Array.isArray(d.channels)) setChannels(d.channels);
      })
      .catch(() => {})
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <SectionCard icon="@" iconColor={color.positive} title="Notifications" subtitle="Daily brief + failed/partial-scan alerts. Active automatically when the env is set.">
      {loading ? (
        <div style={{ fontSize: text.body, color: color.textFaint, padding: '8px 0' }}>Loading…</div>
      ) : (
        channels.map((c) => (
          <div key={c.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 0', borderBottom: '1px solid ' + color.borderSubtle }}>
            <div style={{ width: 7, height: 7, borderRadius: '50%', marginTop: 5, background: c.configured ? color.positive : color.textGhost, flexShrink: 0 }} />
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: text.base, fontWeight: 500, color: color.textPrimary, fontFamily: font.ui }}>{c.label}</span>
                <Pill tone={c.configured ? color.positive : color.textFaint}>{c.configured ? 'ACTIVE' : 'OFF'}</Pill>
              </div>
              {!c.configured && (
                <div style={{ fontSize: text.caption, color: color.warning, marginTop: 3, fontFamily: font.mono }}>Set {c.requiresEnv.join(' + ')} to enable</div>
              )}
            </div>
          </div>
        ))
      )}
    </SectionCard>
  );
}

'use client';

import { useEffect, useState } from 'react';

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
    <div style={{ background: '#0b0e16', border: '1px solid #1e2840', borderRadius: 12, padding: '16px 18px', marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <div style={{ width: 28, height: 28, borderRadius: 8, background: '#10b98118', border: '1px solid #10b98133', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: '#10b981', fontFamily: 'IBM Plex Mono,monospace', fontWeight: 600 }}>@</div>
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#e2e8f0', fontFamily: 'Inter,sans-serif' }}>Notifications</div>
          <div style={{ fontSize: 10, color: '#4a5568' }}>Daily brief + failed/partial-scan alerts. Active automatically when the env is set.</div>
        </div>
      </div>

      {loading ? (
        <div style={{ fontSize: 11, color: '#4a5568', padding: '8px 0' }}>Loading…</div>
      ) : (
        channels.map((c) => (
          <div key={c.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 0', borderBottom: '1px solid #0f1420' }}>
            <div style={{ width: 7, height: 7, borderRadius: '50%', marginTop: 5, background: c.configured ? '#10b981' : '#2a3550', flexShrink: 0 }} />
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 500, color: '#e2e8f0', fontFamily: 'Inter,sans-serif' }}>{c.label}</span>
                <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: '.04em', color: c.configured ? '#10b981' : '#4a5568', background: (c.configured ? '#10b981' : '#4a5568') + '20', padding: '1px 5px', borderRadius: 3, fontFamily: 'IBM Plex Mono,monospace' }}>{c.configured ? 'ACTIVE' : 'OFF'}</span>
              </div>
              {!c.configured && (
                <div style={{ fontSize: 9, color: '#f59e0b', marginTop: 3, fontFamily: 'IBM Plex Mono,monospace' }}>Set {c.requiresEnv.join(' + ')} to enable</div>
              )}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

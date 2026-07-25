'use client';

import { useEffect, useState } from 'react';

// Settings → Data Sources (admin). Pick which market-data provider(s) feed the
// verified-price layer. A source that isn't available — not implemented (stub) or
// missing its required env (e.g. an API token) — renders DISABLED and can't be
// selected; the server rejects it too. Selection persists to kv_store.

export default function AdminDataSources() {
  const [providers, setProviders] = useState([]);
  const [active, setActive] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    let alive = true;
    fetch('/api/admin/sources')
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        if (Array.isArray(d.providers)) setProviders(d.providers);
        if (Array.isArray(d.active)) setActive(d.active);
      })
      .catch(() => {})
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  function toggle(p) {
    if (!p.available) return; // disabled sources can't be selected
    setMsg(null);
    setActive((cur) => (cur.includes(p.id) ? cur.filter((x) => x !== p.id) : [...cur, p.id]));
  }

  async function save() {
    setSaving(true);
    setMsg(null);
    try {
      const r = await fetch('/api/admin/sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active }),
      });
      const d = await r.json();
      if (r.ok && Array.isArray(d.active)) {
        setActive(d.active);
        setMsg({ kind: 'ok', text: 'Saved.' });
      } else {
        setMsg({ kind: 'err', text: d.error || 'Failed to save' });
      }
    } catch {
      setMsg({ kind: 'err', text: 'Failed to save' });
    } finally {
      setSaving(false);
    }
  }

  const nonLiveActive = active.some((id) => {
    const p = providers.find((x) => x.id === id);
    return p && p.status !== 'live';
  });

  function badge(p) {
    if (!p.available) return { label: 'DISABLED', color: '#4a5568' };
    if (p.status === 'live') return { label: 'LIVE', color: '#10b981' };
    if (p.status === 'sample') return { label: 'SAMPLE', color: '#f59e0b' };
    return { label: p.status.toUpperCase(), color: '#4a5568' };
  }

  function disabledReason(p) {
    if (p.available) return null;
    if (p.status === 'stub') return 'Not implemented yet';
    if (p.requiresEnv && p.requiresEnv.length) return `Requires ${p.requiresEnv.join(', ')} — set it to enable`;
    return 'Unavailable';
  }

  return (
    <div style={{ background: '#0b0e16', border: '1px solid #1e2840', borderRadius: 12, padding: '16px 18px', marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <div style={{ width: 28, height: 28, borderRadius: 8, background: '#8b5cf618', border: '1px solid #8b5cf633', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: '#8b5cf6', fontFamily: 'IBM Plex Mono,monospace', fontWeight: 600 }}>db</div>
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#e2e8f0', fontFamily: 'Inter,sans-serif' }}>Market Data Sources</div>
          <div style={{ fontSize: 10, color: '#4a5568' }}>Where verified prices come from. Admin-only. Multiple sources are cross-checked.</div>
        </div>
      </div>

      {loading ? (
        <div style={{ fontSize: 11, color: '#4a5568', padding: '8px 0' }}>Loading sources…</div>
      ) : (
        <>
          {providers.map((p) => {
            const on = active.includes(p.id);
            const b = badge(p);
            const reason = disabledReason(p);
            const dim = !p.available;
            return (
              <button
                key={p.id}
                onClick={() => toggle(p)}
                disabled={dim}
                style={{ width: '100%', display: 'flex', alignItems: 'flex-start', gap: 10, padding: '11px 0', borderBottom: '1px solid #0f1420', background: 'transparent', border: 'none', borderBottomStyle: 'solid', cursor: dim ? 'not-allowed' : 'pointer', textAlign: 'left', opacity: dim ? 0.5 : 1 }}
              >
                <div style={{ width: 16, height: 16, marginTop: 1, borderRadius: 4, border: '1px solid ' + (on ? '#8b5cf6' : '#2a3550'), background: on ? '#8b5cf6' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  {on && <span style={{ fontSize: 10, color: '#0b0e16', fontWeight: 700 }}>✓</span>}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 12, fontWeight: on ? 600 : 400, color: on ? '#e2e8f0' : '#c8d4e8', fontFamily: 'Inter,sans-serif' }}>{p.label}</span>
                    <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: '.04em', color: b.color, background: b.color + '20', padding: '1px 5px', borderRadius: 3, fontFamily: 'IBM Plex Mono,monospace' }}>{b.label}</span>
                  </div>
                  <div style={{ fontSize: 10, color: '#4a5568', marginTop: 3 }}>{p.description}</div>
                  {reason && <div style={{ fontSize: 9, color: '#f59e0b', marginTop: 3, fontFamily: 'IBM Plex Mono,monospace' }}>{reason}</div>}
                </div>
              </button>
            );
          })}

          {nonLiveActive && (
            <div style={{ marginTop: 12, padding: '9px 11px', borderRadius: 8, background: '#f59e0b12', border: '1px solid #f59e0b33', fontSize: 10, color: '#f59e0b', fontFamily: 'Inter,sans-serif' }}>
              ⚠ A selected source is not live market data. Prices shown are for setup/testing only — not for real trading decisions.
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 14 }}>
            <button
              onClick={save}
              disabled={saving || active.length === 0}
              style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid #8b5cf6', background: active.length === 0 ? 'transparent' : '#8b5cf60e', color: active.length === 0 ? '#4a5568' : '#c4b5fd', fontSize: 11, fontWeight: 600, cursor: saving || active.length === 0 ? 'not-allowed' : 'pointer', fontFamily: 'Inter,sans-serif' }}
            >
              {saving ? 'Saving…' : 'Save sources'}
            </button>
            {active.length === 0 && <span style={{ fontSize: 10, color: '#4a5568' }}>Select at least one source.</span>}
            {msg && <span style={{ fontSize: 10, color: msg.kind === 'ok' ? '#10b981' : '#ef4444' }}>{msg.text}</span>}
          </div>
        </>
      )}
    </div>
  );
}

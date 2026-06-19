'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { dbGet, dbSet, dbRemove } from '@/lib/clientStorage';

// ============================================================================
// NEPSE Intelligence V2 — UI shell
//
// This is the SHELL ONLY. The full V1 UI will be pasted in by the maintainer.
// What is already wired up for you (do not remove):
//   - clientStorage (dbGet/dbSet/dbRemove) replaces V1 window.storage
//   - "Scan now" button       -> POST /api/cron/scan
//   - status polling          -> GET  /api/scan/status every 5s while running
//   - header live progress    -> "3/15 NABIL"
//   - failed-job retry         -> POST /api/scan/worker?symbol=X&force=true
//   - partial-scan amber banner
//   - exchange selector        -> NEPSE (active) | NYSE (coming Level 2)
//
// PORT V1 UI INTO THE MARKED REGIONS BELOW. The client-side scan loop from V1
// must NOT be re-added — scanning now happens server-side.
// ============================================================================

const POLL_MS = 5000;
const KEY_BRIEF = 'ni:brief';
const KEY_WATCHLIST = 'ni:wl';

export default function NepseApp() {
  const [exchange, setExchange] = useState('NEPSE');
  const [tab, setTab] = useState('today');

  const [status, setStatus] = useState(null); // /api/scan/status payload
  const [brief, setBrief] = useState(null);
  const [signals, setSignals] = useState([]); // latest scan's per-symbol signals
  const [watchlist, setWatchlist] = useState([]);
  const [activity, setActivity] = useState([]); // durable history (from /api/activity)
  const [scanStarting, setScanStarting] = useState(false);

  const pollRef = useRef(null);
  const lastSymbolRef = useRef(null);

  // Ephemeral, client-side feedback (retries, start failures). Durable scan
  // events come from /api/activity; these fill the gap until the next refresh.
  const log = useCallback((msg) => {
    setActivity((prev) =>
      [{ id: `local-${Date.now()}`, type: 'local', message: msg, created_at: new Date().toISOString() }, ...prev].slice(0, 100)
    );
  }, []);

  // --- data loaders --------------------------------------------------------
  const loadSignals = useCallback(async () => {
    try {
      const res = await fetch('/api/signals', { cache: 'no-store' });
      const data = await res.json();
      if (Array.isArray(data.signals)) setSignals(data.signals);
    } catch (err) {
      console.error('signals load failed:', err);
    }
  }, []);

  const loadActivity = useCallback(async () => {
    try {
      const res = await fetch('/api/activity?limit=100', { cache: 'no-store' });
      const data = await res.json();
      if (Array.isArray(data.events)) setActivity(data.events);
    } catch (err) {
      console.error('activity load failed:', err);
    }
  }, []);

  const loadWatchlist = useCallback(async () => {
    const wl = await dbGet(KEY_WATCHLIST);
    if (Array.isArray(wl)) setWatchlist(wl);
    else if (Array.isArray(wl?.symbols)) setWatchlist(wl.symbols);
  }, []);

  // --- initial load --------------------------------------------------------
  useEffect(() => {
    (async () => {
      const b = await dbGet(KEY_BRIEF);
      if (b) setBrief(b);
      await Promise.all([loadWatchlist(), loadSignals(), loadActivity()]);
    })();
  }, [loadWatchlist, loadSignals, loadActivity]);

  // --- status polling ------------------------------------------------------
  const pollStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/scan/status', { cache: 'no-store' });
      const data = await res.json();
      setStatus(data);

      // Stream durable activity in as the scan progresses.
      if (data.current_symbol && data.current_symbol !== lastSymbolRef.current) {
        lastSymbolRef.current = data.current_symbol;
        loadActivity();
      }

      // When the scan stops running, refresh outputs and stop polling.
      if (!data.running) {
        stopPolling();
        const b = await dbGet(KEY_BRIEF);
        if (b) setBrief(b);
        await Promise.all([loadSignals(), loadWatchlist(), loadActivity()]);
      }
    } catch (err) {
      console.error('status poll failed:', err);
    }
  }, [loadActivity, loadSignals, loadWatchlist]);

  const startPolling = useCallback(() => {
    if (pollRef.current) return;
    pollStatus();
    pollRef.current = setInterval(pollStatus, POLL_MS);
  }, [pollStatus]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // Resume polling on mount if a scan is already running server-side.
  useEffect(() => {
    (async () => {
      const res = await fetch('/api/scan/status', { cache: 'no-store' });
      const data = await res.json();
      setStatus(data);
      if (data.running) startPolling();
    })();
    return () => stopPolling();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- actions -------------------------------------------------------------
  const scanNow = useCallback(async () => {
    setScanStarting(true);
    try {
      const res = await fetch('/api/cron/scan', { method: 'POST' });
      const data = await res.json();
      if (data.skipped) {
        log('Scan already in progress');
      } else if (data.started) {
        log(`Scan started — ${data.total} stocks (${data.sentiment || 'NEUTRAL'})`);
      } else if (data.error) {
        log(`Scan error: ${data.error}`);
      }
      startPolling();
    } catch (err) {
      log(`Scan failed to start: ${err.message}`);
    } finally {
      setScanStarting(false);
    }
  }, [log, startPolling]);

  const retryStock = useCallback(
    async (symbol) => {
      log(`Retrying ${symbol}…`);
      await fetch(`/api/scan/worker?symbol=${encodeURIComponent(symbol)}&force=true`, {
        method: 'POST',
      });
      startPolling();
    },
    [log, startPolling]
  );

  const running = status?.running;
  const progressLabel = running
    ? `${status.completed ?? 0}/${status.total ?? 0}${status.current_symbol ? ` ${status.current_symbol}` : ''}`
    : null;
  const isPartial = status?.status === 'partial';
  const failedJobs = status?.failed_jobs || [];
  const skippedJobs = status?.skipped_jobs || [];

  // ------------------------------------------------------------------------
  return (
    <main style={S.page}>
      {/* ===== HEADER ===== */}
      <header style={S.header}>
        <div style={S.brandRow}>
          <h1 style={S.brand}>NEPSE Intelligence <span style={S.v2}>V2</span></h1>

          {/* Exchange selector: NEPSE active, NYSE coming in Level 2 */}
          <div style={S.exchanges}>
            <button
              onClick={() => setExchange('NEPSE')}
              style={{ ...S.exBtn, ...(exchange === 'NEPSE' ? S.exActive : {}) }}
            >
              NEPSE
            </button>
            <button
              disabled
              title="Coming in Level 2"
              style={{ ...S.exBtn, ...S.exDisabled }}
            >
              NYSE <span style={S.soon}>soon</span>
            </button>
          </div>
        </div>

        <div style={S.headerRight}>
          {running && (
            <span style={S.progress}>
              <span style={S.spinner} /> {progressLabel}
              {status?.stalled ? <span style={S.stalled}> (stalled)</span> : null}
            </span>
          )}
          <button onClick={scanNow} disabled={scanStarting || running} style={S.scanBtn}>
            {running ? 'Scanning…' : scanStarting ? 'Starting…' : 'Scan now'}
          </button>
        </div>

        {/* Schedule indicator — last run (relative) + next cron run (local time) */}
        {(status?.last_scan_at || status?.next_scheduled) && (
          <div style={S.schedule}>
            {status?.last_scan_at ? (
              <span title={new Date(status.last_scan_at).toLocaleString()}>
                Last scan {timeAgo(status.last_scan_at)}
              </span>
            ) : (
              <span>No scans yet</span>
            )}
            {status?.next_scheduled ? (
              <>
                <span style={S.scheduleDot}>·</span>
                <span title={`Next automated scan: ${new Date(status.next_scheduled).toLocaleString()} (Vercel cron, deployed app only)`}>
                  Next scan {new Date(status.next_scheduled).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </>
            ) : null}
          </div>
        )}
      </header>

      {/* ===== PARTIAL-SCAN AMBER BANNER (Today tab) ===== */}
      {isPartial && tab === 'today' && (
        <div style={S.amberBanner}>
          ⚠️ Partial scan —
          {failedJobs.length > 0 &&
            ` ${failedJobs.length} failed${skippedJobs.length ? ',' : '.'}`}
          {skippedJobs.length > 0 &&
            ` ${skippedJobs.length} skipped (AI quota).`}
          {' '}Review them on the Watchlist tab.
        </div>
      )}

      {/* ===== TABS ===== */}
      <nav style={S.tabs}>
        {['today', 'watchlist', 'activity'].map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{ ...S.tab, ...(tab === t ? S.tabActive : {}) }}
          >
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </nav>

      {/* ===== CONTENT ===== */}
      <section style={S.content}>
        {tab === 'today' && (
          <div>
            {/* ----------------------------------------------------------------
                PORT V1 "TODAY" UI HERE.
                Available data: `brief` (from KV ni:brief), `status`.
                ---------------------------------------------------------------- */}
            <Placeholder title="Today">
              {brief ? (
                <div>
                  <h3 style={S.h3}>{brief.headline}</h3>
                  <p style={S.muted}>{brief.summary}</p>
                  {brief.topPicks?.length ? (
                    <p>Top picks: <strong>{brief.topPicks.join(', ')}</strong></p>
                  ) : null}
                  {brief.risks ? <p style={S.muted}>Risks: {brief.risks}</p> : null}
                </div>
              ) : (
                <p style={S.muted}>No brief yet. Run a scan to generate one.</p>
              )}
            </Placeholder>

            {/* Per-symbol trade signals from the latest scan. */}
            <div style={{ marginTop: 16 }}>
              <div style={S.sectionTitle}>
                Signals {signals.length ? <span style={S.muted}>({signals.length})</span> : null}
              </div>
              {signals.length ? (
                <div style={S.cardGrid}>
                  {signals.map((s) => (
                    <SignalCard key={s.id} s={s} />
                  ))}
                </div>
              ) : (
                <p style={S.muted}>No signals yet. Run a scan to generate them.</p>
              )}
            </div>
          </div>
        )}

        {tab === 'watchlist' && (
          <div>
            {/* ----------------------------------------------------------------
                PORT V1 "WATCHLIST" UI HERE.
                Failed stocks render a red badge + retry button (wired below).
                Use dbSet(KEY_WATCHLIST, ...) to persist edits.
                ---------------------------------------------------------------- */}
            <Placeholder title="Watchlist">
              {(failedJobs.length > 0 || skippedJobs.length > 0) && (
                <div style={{ marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {failedJobs.map((j) => (
                    <div key={`f-${j.symbol}`} style={S.statusRow}>
                      <span style={S.failBadge}>FAILED</span>
                      <strong style={S.rowSymbol}>{j.symbol}</strong>
                      <span style={S.rowMsg} title={j.message}>
                        {j.message}
                        {j.attempt > 1 ? ` (after ${j.attempt} tries)` : ''}
                      </span>
                      <button style={S.retryBtn} onClick={() => retryStock(j.symbol)}>
                        Retry
                      </button>
                    </div>
                  ))}
                  {skippedJobs.map((j) => (
                    <div key={`s-${j.symbol}`} style={S.statusRow}>
                      <span style={S.skipBadge}>SKIPPED</span>
                      <strong style={S.rowSymbol}>{j.symbol}</strong>
                      <span style={S.rowMsg} title={j.message}>{j.message}</span>
                      <button style={S.retryBtn} onClick={() => retryStock(j.symbol)}>
                        Retry
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {watchlist.length ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {watchlist.map((s) => {
                    const sym = typeof s === 'string' ? s : s.symbol;
                    const last = typeof s === 'string' ? null : s.lastSignal;
                    const reason = typeof s === 'string' ? null : s.reason;
                    const actionable = last === 'BUY' || last === 'SELL';
                    return (
                      <div key={sym} style={S.wlRow}>
                        <strong style={S.rowSymbol}>{sym}</strong>
                        {last ? <SignalBadge signal={last} /> : null}
                        {actionable ? <span style={S.actionableTag}>ACTIONABLE</span> : null}
                        {reason ? <span style={S.rowMsg} title={reason}>{reason}</span> : null}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p style={S.muted}>Watchlist empty.</p>
              )}
            </Placeholder>
          </div>
        )}

        {tab === 'activity' && (
          <div>
            {/* ----------------------------------------------------------------
                Activity log — shows each stock as it completes.
                ---------------------------------------------------------------- */}
            <Placeholder title="Activity">
              {activity.length ? (
                <ul style={S.logList}>
                  {activity.map((a) => (
                    <li key={a.id} style={S.logItem}>
                      <span style={S.muted}>{new Date(a.created_at).toLocaleTimeString()}</span> — {a.message}
                    </li>
                  ))}
                </ul>
              ) : (
                <p style={S.muted}>No activity yet.</p>
              )}
            </Placeholder>
          </div>
        )}
      </section>
    </main>
  );
}

function Placeholder({ title, children }) {
  return (
    <div style={S.panel}>
      <div style={S.panelLabel}>{title} — V1 UI goes here</div>
      {children}
    </div>
  );
}

const SIGNAL_COLOR = {
  BUY: { bg: '#0f2e1c', fg: '#34d399', bd: '#1f7a4d' },
  SELL: { bg: '#3a1418', fg: '#f87171', bd: '#9b2c34' },
  HOLD: { bg: '#332710', fg: '#fbbf24', bd: '#8a6516' },
  WATCH: { bg: '#10243f', fg: '#60a5fa', bd: '#2b5da8' },
  NEUTRAL: { bg: '#22262e', fg: '#9aa3b2', bd: '#3a4151' },
  AVOID: { bg: '#22262e', fg: '#9aa3b2', bd: '#3a4151' },
};

function SignalBadge({ signal }) {
  const c = SIGNAL_COLOR[signal] || SIGNAL_COLOR.AVOID;
  return (
    <span style={{ ...S.sigBadge, background: c.bg, color: c.fg, border: `1px solid ${c.bd}` }}>
      {signal || '—'}
    </span>
  );
}

function SignalCard({ s }) {
  const c = SIGNAL_COLOR[s.signal] || SIGNAL_COLOR.AVOID;
  const fmt = (v) => (v == null || v === '' ? '—' : v);
  return (
    <div style={{ ...S.card, borderLeft: `3px solid ${c.bd}` }}>
      <div style={S.cardHead}>
        <strong style={S.cardSymbol}>{s.symbol}</strong>
        <SignalBadge signal={s.signal} />
        {s.confidence ? <span style={S.confTag}>{s.confidence}</span> : null}
        {s.sector ? <span style={S.sectorTag}>{s.sector}</span> : null}
        {s.outcome && s.outcome !== 'PENDING' ? (
          <span style={S.outcomeTag}>{s.outcome}</span>
        ) : null}
      </div>
      <div style={S.metrics}>
        <Metric label="Price" value={fmt(s.price)} />
        <Metric label="Target" value={fmt(s.target)} />
        <Metric label="Stop" value={fmt(s.sl)} />
        <Metric label="Hold" value={fmt(s.hold)} />
      </div>
      {s.entry ? <p style={S.cardLine}><span style={S.muted}>Entry:</span> {s.entry}</p> : null}
      {s.why ? <p style={S.cardLine}>{s.why}</p> : null}
      {s.risk ? <p style={{ ...S.cardLine, ...S.muted }}>Risk: {s.risk}</p> : null}
    </div>
  );
}

function Metric({ label, value }) {
  return (
    <div style={S.metric}>
      <span style={S.metricLabel}>{label}</span>
      <span style={S.metricValue}>{value}</span>
    </div>
  );
}

// Compact relative time, e.g. "just now", "4m ago", "3h ago", "2d ago".
function timeAgo(iso) {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

// Inline styles keep the shell self-contained until the V1 UI (with its own
// styling) is pasted in.
const S = {
  page: { maxWidth: 920, margin: '0 auto', padding: '20px 16px 64px' },
  header: { display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 16 },
  brandRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 },
  brand: { fontSize: 22, margin: 0, fontWeight: 700 },
  v2: { color: 'var(--accent)', fontWeight: 800 },
  exchanges: { display: 'flex', gap: 6 },
  exBtn: { padding: '6px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--panel)', color: 'var(--muted)', cursor: 'pointer', fontSize: 13 },
  exActive: { color: 'var(--text)', borderColor: 'var(--accent)', background: '#10203f' },
  exDisabled: { opacity: 0.5, cursor: 'not-allowed' },
  soon: { fontSize: 10, color: 'var(--amber)', marginLeft: 4 },
  headerRight: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 12 },
  schedule: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6, fontSize: 12, color: 'var(--muted)' },
  scheduleDot: { opacity: 0.6 },
  progress: { display: 'inline-flex', alignItems: 'center', gap: 8, color: 'var(--muted)', fontSize: 14 },
  spinner: { width: 10, height: 10, borderRadius: '50%', background: 'var(--accent)', display: 'inline-block' },
  stalled: { color: 'var(--amber)' },
  scanBtn: { padding: '8px 16px', borderRadius: 8, border: 'none', background: 'var(--accent)', color: '#fff', fontWeight: 600, cursor: 'pointer' },
  amberBanner: { background: '#3a2c10', border: '1px solid var(--amber)', color: 'var(--amber)', padding: '10px 14px', borderRadius: 8, marginBottom: 14, fontSize: 14 },
  tabs: { display: 'flex', gap: 4, borderBottom: '1px solid var(--border)', marginBottom: 16 },
  tab: { padding: '8px 14px', background: 'transparent', border: 'none', borderBottom: '2px solid transparent', color: 'var(--muted)', cursor: 'pointer', fontSize: 14 },
  tabActive: { color: 'var(--text)', borderBottomColor: 'var(--accent)' },
  content: {},
  panel: { background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 12, padding: 16 },
  panelLabel: { fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--muted)', marginBottom: 12 },
  h3: { margin: '0 0 6px' },
  muted: { color: 'var(--muted)' },
  list: { margin: 0, paddingLeft: 18 },
  logList: { listStyle: 'none', margin: 0, padding: 0 },
  logItem: { padding: '4px 0', borderBottom: '1px solid var(--border)', fontSize: 13 },
  statusRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 8 },
  failBadge: { flexShrink: 0, background: 'var(--red)', color: '#fff', fontSize: 10, fontWeight: 700, padding: '3px 7px', borderRadius: 4, letterSpacing: 0.3 },
  skipBadge: { flexShrink: 0, background: 'var(--amber)', color: '#1a1303', fontSize: 10, fontWeight: 700, padding: '3px 7px', borderRadius: 4, letterSpacing: 0.3 },
  rowSymbol: { flexShrink: 0 },
  rowMsg: { color: 'var(--muted)', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 },
  retryBtn: { flexShrink: 0, marginLeft: 'auto', padding: '4px 10px', borderRadius: 6, border: '1px solid var(--accent)', background: 'transparent', color: 'var(--accent)', cursor: 'pointer', fontSize: 12 },

  // Signals section + cards
  sectionTitle: { fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--muted)', margin: '0 0 10px' },
  cardGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 },
  card: { background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 12, padding: 14 },
  cardHead: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 },
  cardSymbol: { fontSize: 16 },
  sigBadge: { fontSize: 11, fontWeight: 800, padding: '2px 8px', borderRadius: 6, letterSpacing: 0.5 },
  confTag: { fontSize: 10, color: 'var(--muted)', border: '1px solid var(--border)', borderRadius: 4, padding: '2px 6px' },
  sectorTag: { fontSize: 10, color: 'var(--muted)', marginLeft: 'auto' },
  outcomeTag: { fontSize: 10, fontWeight: 700, color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4, padding: '2px 6px' },
  metrics: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 8 },
  metric: { display: 'flex', flexDirection: 'column', gap: 2 },
  metricLabel: { fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5 },
  metricValue: { fontSize: 14, fontWeight: 600 },
  cardLine: { margin: '4px 0', fontSize: 13, lineHeight: 1.4 },

  // Watchlist rows
  wlRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 8 },
  actionableTag: { fontSize: 10, fontWeight: 700, color: '#34d399', border: '1px solid #1f7a4d', background: '#0f2e1c', borderRadius: 4, padding: '2px 6px', letterSpacing: 0.3 },
};

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { dbGet } from '@/lib/clientStorage';
import * as store from '@/lib/userStore';
import AdminDataSources from '@/components/AdminDataSources';
import AdminChannels from '@/components/AdminChannels';
import AuthPanel from '@/components/AuthPanel';
import LoginWall from '@/components/LoginWall';
import Disclaimer from '@/components/Disclaimer';
import { useAuth } from '@/lib/useAuth';
import useBreakpoint from '@/hooks/useBreakpoint';
import { EXCHANGES, DEFAULT_EXCHANGE } from '@/lib/exchanges';

// ============================================================================
// NEPSE Intelligence V2 — full UI
//
// This is the V1 design (nepse_intelligence.jsx) ported onto the V2 server
// backend. What changed from V1:
//   - window.storage  -> global reads via dbGet (ni:brief/ni:mkt); per-user data
//     (watchlist/portfolio/settings) via @/lib/userStore (Phase 2 per-user routes)
//   - client runScan loop -> server scan: POST /api/cron/scan + poll /api/scan/status
//   - direct Anthropic callAI -> server routes: POST /api/chat, GET /api/stock
//   - signals come from GET /api/signals (latest scan), not client state
//   - market comes from /api/scan/status (scan.market), normalized to V1 shape
// Portfolio + trade log are the user's own bookkeeping (not agent output): Phase 2
// moves them to the per-user `portfolios` table (/api/portfolio), or localStorage in
// open/single-operator mode. Trade log is derived from the closed position rows.
// ============================================================================

const POLL_MS = 5000;

// -- charge engine (verbatim from V1) -----------------------------------------
function calcC(action, qty, price, buyPrice, holdDays) {
  var tv = qty * price;
  var broker = tv * 0.004; if (broker < 10) broker = 10;
  var sebon = tv * 0.000015; var dp = 25;
  var cgt = 0; var gpl = 0; var npl = 0;
  if (action === 'SELL' && buyPrice > 0) {
    gpl = (price - buyPrice) * qty;
    if (gpl > 0) cgt = gpl * (holdDays >= 365 ? 0.05 : 0.075);
  }
  var tot = broker + sebon + dp + cgt;
  var be = action === 'BUY' ? (tv + broker + sebon + dp) / qty : 0;
  var net = action === 'BUY' ? tv + tot : tv - tot;
  if (action === 'SELL' && buyPrice > 0) npl = gpl - tot;
  return { tv: tv, b: broker, s: sebon, d: dp, cgt: cgt, tot: tot, be: be, net: net, gpl: gpl, npl: npl };
}

// -- per-user table <-> UI shape (Phase 2) ------------------------------------
// portfolios rows store only the raw position; the money math (break-even, invested,
// charges, P&L) is recomputed here via the same charge engine, so nothing derived is
// persisted. NOTE: the schema has no free-text column, so buy `basis` is only present
// in local/open mode (kept in localStorage); over the API it comes back blank.
function posFromRow(row) {
  var qty = Number(row.qty); var price = Number(row.buy_price);
  var c = calcC('BUY', qty, price, 0, 0);
  return {
    id: row.id, date: row.opened_at, symbol: row.symbol, qty: qty, price: price,
    sl: row.stop_loss != null ? Number(row.stop_loss) : null,
    target: row.target != null ? Number(row.target) : null,
    be: c.be, net: c.net, tot: c.tot, basis: row.basis || '',
    status: String(row.status || 'open').toUpperCase(), exchange: row.exchange,
  };
}
// A closed position -> the SELL trade the "closed trades" list renders.
function tradeFromClosedRow(row) {
  var qty = Number(row.qty); var buy = Number(row.buy_price); var sp = Number(row.sell_price);
  var hd = row.opened_at && row.closed_at ? Math.floor((new Date(row.closed_at) - new Date(row.opened_at)) / 86400000) : 0;
  var c = calcC('SELL', qty, sp, buy, hd);
  return {
    id: 'S' + row.id, date: row.closed_at, symbol: row.symbol, action: 'SELL', qty: qty, price: sp,
    buyPrice: buy, holdDays: hd, npl: c.npl, gpl: c.gpl, cgt: c.cgt, tot: c.tot, net: c.net,
    status: 'CLOSED', matchId: row.id,
  };
}

// -- utils --------------------------------------------------------------------
function toRs(n) { return 'Rs ' + Math.round(Math.abs(n)).toLocaleString('en-IN'); }
function toRs2(n) { return 'Rs ' + Math.abs(n).toFixed(2); }
function signed(n) { return (n >= 0 ? '+' : '-') + toRs(n); }
function toPct(n) { if (n == null) return '-'; return (n >= 0 ? '+' : '') + Number(n).toFixed(2) + '%'; }
function timeAgo(d) {
  if (!d) return '';
  var s = Math.floor((Date.now() - new Date(d)) / 1000);
  if (s < 60) return s + 's'; if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h'; return Math.floor(s / 86400) + 'd';
}
function daysAgo(d) { return Math.floor((Date.now() - new Date(d)) / 86400000); }

// -- shape normalizers (V2 server -> V1 UI shapes) ----------------------------
// Server market uses changePct + gainers[{symbol,price,changePct}]; V1 UI reads
// change_pct + gainers[{symbol,pct,ltp}].
function normalizeMarket(m) {
  if (!m) return null;
  var mapMover = function (x) {
    return { symbol: x.symbol, pct: x.pct != null ? x.pct : x.changePct, ltp: x.ltp != null ? x.ltp : x.price };
  };
  return Object.assign({}, m, {
    change_pct: m.change_pct != null ? m.change_pct : m.changePct,
    gainers: (m.gainers || []).map(mapMover),
    losers: (m.losers || []).map(mapMover),
  });
}
// Server live_data uses changePct/high52/low52; V1 reads change_pct/week52_*.
function normalizeLive(l) {
  if (!l) return l;
  return Object.assign({}, l, {
    change_pct: l.change_pct != null ? l.change_pct : l.changePct,
    week52_high: l.week52_high != null ? l.week52_high : l.high52,
    week52_low: l.week52_low != null ? l.week52_low : l.low52,
  });
}
function normalizeSig(s) {
  return Object.assign({}, s, { live: s.live ? normalizeLive(s.live) : null });
}

// -- constants (from V1) ------------------------------------------------------
var SIG_COLORS = { BUY: '#10b981', SELL: '#ef4444', WATCH: '#f59e0b', AVOID: '#64748b', HOLD: '#f59e0b', NEUTRAL: '#64748b' };
var DEFAULT_SETTINGS = {
  discovery_on: true,
  discovery_depth: 8,
  autoadd_threshold: 'BUY',
  autoremove_on: true,
  autoremove_after: 3,
  sector_focus: { banks: true, hydro: true, microfinance: true, insurance: true, devbanks: true, finance: true },
};
// EXCHANGES is the shared registry (src/lib/exchanges.js) — the single source of
// truth for the exchange dimension across client + server. Do not fork it here.
var SECTORS = ['banks', 'hydro', 'microfinance', 'insurance', 'devbanks', 'finance'];
var SECTOR_LABELS = { banks: 'Commercial Banks', hydro: 'Hydropower', microfinance: 'Microfinance', insurance: 'Insurance', devbanks: 'Dev Banks', finance: 'Finance' };

// -- small presentational pieces ----------------------------------------------
function BuyChargePreview(props) {
  var q = parseFloat(props.qty); var p = props.price;
  if (!q || !p) return null;
  var ch = calcC('BUY', q, p, 0, 0);
  return (
    <div style={{ fontSize: 10, color: '#4a5568', marginBottom: 8, padding: '6px 10px', background: '#07090e', borderRadius: 6, border: '1px solid #1e2840', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
      <span>{'pay '}<span style={{ color: '#e2e8f0', fontWeight: 500 }}>{toRs(ch.net)}</span></span>
      <span>{'broker '}<span style={{ color: '#c8d4e8' }}>{toRs2(ch.b)}</span></span>
      <span>{'DP '}<span style={{ color: '#c8d4e8' }}>{'Rs25'}</span></span>
      <span>{'BE '}<span style={{ color: '#10b981', fontWeight: 500 }}>{'Rs' + ch.be.toFixed(2)}</span></span>
    </div>
  );
}

function card(leftColor, extra) {
  var base = { background: '#0b0e16', border: '1px solid #1e2840', borderLeft: '2px solid ' + (leftColor || '#1e2840'), borderRadius: 10, padding: '14px 16px', marginBottom: 10 };
  return extra ? Object.assign({}, base, extra) : base;
}
function btn(color, sm) {
  return { padding: sm ? '4px 10px' : '6px 14px', borderRadius: 7, border: '1px solid ' + (color || '#1e2840'), background: 'transparent', color: color || '#4a5568', fontSize: sm ? 10 : 11, cursor: 'pointer', fontFamily: 'IBM Plex Mono,monospace', letterSpacing: '.02em' };
}
function sbox(label, value, color) {
  return (
    <div style={{ background: '#07090e', borderRadius: 7, padding: '6px 10px', border: '1px solid #141824' }}>
      <div style={{ fontSize: 8, color: '#2a3550', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 12, fontWeight: 500, color: color || '#c8d4e8', fontFamily: 'IBM Plex Mono,monospace' }}>{value || '-'}</div>
    </div>
  );
}
function ghost(w) {
  return <div style={{ height: 10, background: '#1e2840', borderRadius: 4, width: (w || 70) + '%', animation: '_pulse 1.6s ease infinite', marginBottom: 8 }} />;
}
function SectionHeader(props) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: props.mb || 14 }}>
      <div style={{ width: 3, height: 16, background: props.color || '#3b82f6', borderRadius: 2 }} />
      <span style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0', fontFamily: 'Inter,sans-serif', letterSpacing: '-.01em' }}>{props.title}</span>
      {props.sub && <span style={{ fontSize: 10, color: '#4a5568', marginLeft: 2 }}>{props.sub}</span>}
    </div>
  );
}
function ToggleBtn(props) {
  var onStyle = { padding: '5px 18px', borderRadius: 20, border: '1px solid #10b981', fontSize: 11, cursor: 'pointer', fontFamily: 'IBM Plex Mono,monospace', minWidth: 52, background: '#10b981', color: '#fff' };
  var offStyle = { padding: '5px 18px', borderRadius: 20, border: '1px solid #1e2840', fontSize: 11, cursor: 'pointer', fontFamily: 'IBM Plex Mono,monospace', minWidth: 52, background: '#0b0e16', color: '#4a5568' };
  return <button onClick={props.onClick} style={props.on ? onStyle : offStyle}>{props.on ? 'ON' : 'OFF'}</button>;
}
function SegBtn(props) {
  return (
    <div style={{ display: 'flex', gap: 3, background: '#07090e', padding: 3, borderRadius: 8, border: '1px solid #1e2840' }}>
      {props.options.map(function (o) {
        var active = props.value === (o[0] != null ? o[0] : o);
        var aStyle = { padding: '4px 10px', borderRadius: 6, border: '1px solid #3b82f6', fontSize: 10, cursor: 'pointer', fontFamily: 'IBM Plex Mono,monospace', background: '#3b82f622', color: '#3b82f6' };
        var iStyle = { padding: '4px 10px', borderRadius: 6, border: '1px solid #1e2840', fontSize: 10, cursor: 'pointer', fontFamily: 'IBM Plex Mono,monospace', background: 'transparent', color: '#4a5568' };
        return <button key={o[0] != null ? o[0] : o} onClick={function () { props.onChange(o[0] != null ? o[0] : o); }} style={active ? aStyle : iStyle}>{o[1] != null ? o[1] : o}</button>;
      })}
    </div>
  );
}

// Track-record formatters: a 0–1 rate as a percent, and a signed percent return.
function fmtRate(frac) { return Math.round(Number(frac) * 100) + '%'; }
function fmtRet(pct) { const n = Number(pct); return (n >= 0 ? '+' : '') + (Math.round(n * 100) / 100) + '%'; }

export default function NepseApp() {
  const [tab, setTab] = useState('today');
  const [exchange, setExchange] = useState(DEFAULT_EXCHANGE);
  // Server-gated availability per exchange (ENABLE_NYSE etc.) — the browser never
  // reads server env; it asks /api/exchanges which market sources are live.
  const [exAvail, setExAvail] = useState({ NEPSE: true });
  const [showOnboard, setShowOnboard] = useState(false);
  const auth = useAuth(); // client view of admin state (server enforces the boundary)
  const bp = useBreakpoint(); // SSR-safe viewport class; drives structural (not just CSS) responsiveness
  const isMobile = bp.isMobile;

  // Server-backed data
  const [status, setStatus] = useState(null);
  const [signals, setSignals] = useState([]);
  const [market, setMarket] = useState(null);
  const [brief, setBrief] = useState(null);
  const [activity, setActivity] = useState([]);
  const [track, setTrack] = useState(null);
  const [scanStarting, setScanStarting] = useState(false);

  // Client-side bookkeeping
  const [portfolio, setPortfolio] = useState([]);
  const [tradeLog, setTradeLog] = useState([]);
  const [stockCache, setStockCache] = useState({});
  const [watchlist, setWatchlist] = useState([]);
  const [wlSources, setWlSources] = useState({}); // { SYMBOL: 'manual'|'discovered'|'holding' }
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);

  // Chat
  const [chat, setChat] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Overlay
  const [ovSym, setOvSym] = useState(null);
  const [ovData, setOvData] = useState(null);
  const [ovAnalysis, setOvAnalysis] = useState('');
  const [ovSig, setOvSig] = useState(null);
  const [ovLoading, setOvLoading] = useState(false);

  // Trade forms
  const [buyTarget, setBuyTarget] = useState(null);
  const [buyQty, setBuyQty] = useState('');
  const [buySL, setBuySL] = useState('');
  const [buyReason, setBuyReason] = useState('');
  const [sellTarget, setSellTarget] = useState(null);
  const [sellPrice, setSellPrice] = useState('');
  const [sellReason, setSellReason] = useState('');

  // UI misc
  const [wlInput, setWlInput] = useState('');
  const [toasts, setToasts] = useState([]);
  const [logs, setLogs] = useState([]); // ephemeral local notices
  const [showLog, setShowLog] = useState(false);
  const [logExpanded, setLogExpanded] = useState({});

  const pollRef = useRef(null);
  const lastSymbolRef = useRef(null);
  const sidebarEnd = useRef(null);

  // -- derived ----------------------------------------------------------------
  var openPos = portfolio.filter(function (p) { return p.status === 'OPEN'; });
  var closedSells = tradeLog.filter(function (t) { return t.action === 'SELL'; });
  var realisedPL = closedSells.reduce(function (s, t) { return s + (t.npl || 0); }, 0);
  var buySigCount = signals.filter(function (s) { return s.signal === 'BUY'; }).length;
  var noSLCount = openPos.filter(function (p) { return !p.sl && daysAgo(p.date) > 3; }).length;
  var alerts = openPos.reduce(function (arr, p) {
    var live = stockCache[p.symbol];
    var sigLive = signals.find(function (s) { return s.symbol === p.symbol && s.live; });
    var lp = live ? live.price : (sigLive && sigLive.live ? sigLive.live.price : null);
    if (!lp) return arr;
    if (p.sl && lp <= p.sl) arr.push({ symbol: p.symbol, type: 'SL_BREACH', price: lp, level: p.sl, msg: p.symbol + ' Rs' + lp + ' hit stop-loss Rs' + p.sl });
    if (p.target && lp >= p.target) arr.push({ symbol: p.symbol, type: 'TARGET_HIT', price: lp, level: p.target, msg: p.symbol + ' Rs' + lp + ' reached target Rs' + p.target });
    return arr;
  }, []);

  const running = !!(status && status.running);
  const scanSym = status && status.current_symbol;
  const scanPhase = status && status.phase;
  const failedJobs = (status && status.failed_jobs) || [];
  const skippedJobs = (status && status.skipped_jobs) || [];
  const isPartial = status && status.status === 'partial';

  // -- helpers ----------------------------------------------------------------
  const addLog = useCallback(function (msg, type) {
    setLogs(function (p) {
      return [{ ts: new Date().toISOString(), msg: msg, t: type || 'info' }].concat(p).slice(0, 60);
    });
  }, []);
  const showToast = useCallback(function (msg, type) {
    var id = Date.now() + Math.round(performance.now());
    setToasts(function (p) { return p.concat([{ id: id, msg: msg, t: type || 'ok' }]); });
    setTimeout(function () { setToasts(function (p) { return p.filter(function (x) { return x.id !== id; }); }); }, 3000);
  }, []);
  function openAsk(prefill) { setSidebarOpen(true); if (prefill) setChatInput(prefill); }

  // Persistence mode for the thin per-user layer (watchlist / portfolio / personal
  // settings). 'local' = open/single-operator mode (no Supabase auth); 'api' = signed
  // in (own rows via the identity-scoped routes); 'gated' = auth configured but signed
  // out (writes refused, friendly sign-in affordance shown instead). Signing in only
  // reads the user's own rows — it never triggers a scan or a market fetch.
  function currentMode() {
    if (!auth.configured) return 'local';
    return auth.signedIn ? 'api' : 'gated';
  }
  const gated = auth.configured && !auth.signedIn && !auth.loading; // show sign-in affordances

  // Global agent/discovery config — ADMIN-only write (server-enforced on
  // /api/admin/settings). Only reachable from admin-gated panels.
  function saveSettings(updated) { setSettings(updated); store.saveGlobalSettings(updated); }

  // Exchange is a personal VIEW preference: always device-local (so logged-out
  // visitors can switch markets to view) and additionally synced to the user's row
  // when signed in.
  function saveExchange(ex) {
    setExchange(ex);
    store.deviceSet('ni:exchange', ex);
    if (currentMode() === 'api') store.savePersonalSettings('api', { exchange: ex });
  }

  async function addToWatchlist(sym, source) {
    sym = (sym || '').toUpperCase().trim();
    if (!sym || sym.length < 2) return false;
    if (gated) { showToast('Sign in with Google to save', 'err'); return false; }
    if (watchlist.indexOf(sym) >= 0) return false;
    // optimistic
    setWatchlist(function (prev) { return prev.indexOf(sym) >= 0 ? prev : prev.concat([sym]); });
    setWlSources(function (m) { var u = Object.assign({}, m); u[sym] = source || 'manual'; return u; });
    try { await store.addWatchlist(currentMode(), exchange, sym, source || 'manual'); }
    catch (e) { showToast('Could not save watchlist', 'err'); }
    return true;
  }
  async function removeFromWatchlist(sym) {
    setWatchlist(function (prev) { return prev.filter(function (s) { return s !== sym; }); });
    setWlSources(function (m) { var u = Object.assign({}, m); delete u[sym]; return u; });
    try { await store.removeWatchlist(currentMode(), exchange, sym); }
    catch (e) { showToast('Could not update watchlist', 'err'); }
  }

  // Intercept the buy affordance when signed out: a soft prompt, never a dead button.
  function startBuy(id) {
    if (gated) { showToast('Sign in with Google to save positions', 'err'); setTab('settings'); return; }
    setBuyTarget(id);
  }

  // -- data loaders -----------------------------------------------------------
  // Signals are a VIEW over the shared per-exchange scan output — filtering by the
  // selected market is a read, never a scan trigger (CLAUDE.md guardrail).
  const loadSignals = useCallback(async () => {
    try {
      const res = await fetch('/api/signals?exchange=' + encodeURIComponent(exchange), { cache: 'no-store' });
      const data = await res.json();
      if (Array.isArray(data.signals)) setSignals(data.signals.map(normalizeSig));
    } catch (err) { console.error('signals load failed:', err); }
  }, [exchange]);

  const loadActivity = useCallback(async () => {
    try {
      const res = await fetch('/api/activity?limit=100', { cache: 'no-store' });
      const data = await res.json();
      if (Array.isArray(data.events)) setActivity(data.events);
    } catch (err) { console.error('activity load failed:', err); }
  }, []);

  const loadTrack = useCallback(async () => {
    try {
      const res = await fetch('/api/track-record', { cache: 'no-store' });
      const data = await res.json();
      if (data && data.overall) setTrack(data);
    } catch (err) { console.error('track-record load failed:', err); }
  }, []);

  // Reload the user's own positions (per-user table in 'api', localStorage in 'local',
  // empty when signed out). tradeLog is derived from the closed rows.
  const reloadPortfolio = useCallback(async () => {
    const mode = !auth.configured ? 'local' : (auth.signedIn ? 'api' : 'gated');
    if (mode === 'gated') { setPortfolio([]); setTradeLog([]); return; }
    try {
      const rows = await store.loadPortfolio(mode);
      setPortfolio(rows.map(posFromRow));
      setTradeLog(rows.filter(function (r) { return String(r.status).toLowerCase() === 'closed'; }).map(tradeFromClosedRow));
    } catch (err) { console.error('portfolio load failed:', err); }
  }, [auth.configured, auth.signedIn]);

  // -- status polling ---------------------------------------------------------
  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  const pollStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/scan/status', { cache: 'no-store' });
      const data = await res.json();
      setStatus(data);
      if (data.market) setMarket(normalizeMarket(data.market));

      if (data.current_symbol && data.current_symbol !== lastSymbolRef.current) {
        lastSymbolRef.current = data.current_symbol;
        loadActivity();
      }
      if (!data.running) {
        stopPolling();
        const b = await dbGet('ni:brief');
        if (b) setBrief(b);
        await Promise.all([loadSignals(), loadActivity()]);
      }
    } catch (err) { console.error('status poll failed:', err); }
  }, [loadActivity, loadSignals, stopPolling]);

  const startPolling = useCallback(() => {
    if (pollRef.current) return;
    pollStatus();
    pollRef.current = setInterval(pollStatus, POLL_MS);
  }, [pollStatus]);

  // -- initial load -----------------------------------------------------------
  useEffect(() => {
    (async () => {
      // GLOBAL / device-local reads only — NEVER per-user data here (that loads in a
      // separate auth-keyed effect, and never triggers a scan/fetch).
      //   ni:brief, ni:mkt   -> global, still on /api/storage
      //   ni:chat, ni:sc     -> device-local (was the leaky shared kv)
      //   global discovery cfg -> /api/admin/settings (open read)
      const [mkt, b, gs] = await Promise.all([dbGet('ni:mkt'), dbGet('ni:brief'), store.loadGlobalSettings()]);
      if (mkt) setMarket(normalizeMarket(mkt));
      if (b) setBrief(b);
      setChat(store.deviceGet('ni:chat', []) || []);
      setStockCache(store.deviceGet('ni:sc', {}) || {});
      var hasExchangePref = false;
      if (gs && Object.keys(gs).length) {
        setSettings(Object.assign({}, DEFAULT_SETTINGS, gs));
        // Legacy continuity: older global kv held the operator's exchange too.
        if (gs.exchange) { setExchange(gs.exchange); hasExchangePref = true; }
      }
      var savedEx = store.deviceGet('ni:exchange', null);
      if (savedEx) { setExchange(savedEx); hasExchangePref = true; }

      // Which markets are actually live (server-gated). NEPSE is always available.
      try {
        const exRes = await fetch('/api/exchanges', { cache: 'no-store' });
        const exData = await exRes.json();
        if (Array.isArray(exData.exchanges)) {
          const avail = {};
          exData.exchanges.forEach(function (e) { avail[e.id] = !!e.available; });
          setExAvail(avail);
        }
      } catch (e) { /* keep NEPSE-only default */ }

      // First run (no saved market preference): ask which market to trade.
      if (!hasExchangePref) setShowOnboard(true);

      await Promise.all([loadSignals(), loadActivity()]);
      // Resume polling if a scan is already running server-side.
      try {
        const res = await fetch('/api/scan/status', { cache: 'no-store' });
        const data = await res.json();
        setStatus(data);
        if (data.market) setMarket(normalizeMarket(data.market));
        if (data.running) startPolling();
      } catch (e) { /* ignore */ }
    })();
    return () => stopPolling();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (sidebarEnd.current) sidebarEnd.current.scrollIntoView({ behavior: 'smooth' });
  }, [chat, chatLoading]);

  // Switching market re-reads the shared per-exchange signals (a view change, not a
  // scan). Skip the very first render — the initial-load effect already fetched.
  const exFirstRef = useRef(true);
  useEffect(() => {
    if (exFirstRef.current) { exFirstRef.current = false; return; }
    loadSignals();
  }, [exchange, loadSignals]);

  // On sign-in (api mode), pull the user's saved exchange ONCE (identity read, no
  // scan). Kept separate from the exchange-change effect to avoid a save/reload race.
  useEffect(() => {
    if (auth.loading || !auth.configured || !auth.signedIn) return;
    let alive = true;
    store.loadPersonalSettings('api').then(function (prefs) {
      if (alive && prefs && prefs.exchange) setExchange(prefs.exchange);
    });
    return function () { alive = false; };
  }, [auth.loading, auth.configured, auth.signedIn]);

  // Load the user's OWN watchlist (per-exchange) + portfolio whenever the auth mode or
  // exchange changes. Signed out -> friendly-empty (no request, no 401 surfaced).
  useEffect(() => {
    if (auth.loading) return;
    const mode = !auth.configured ? 'local' : (auth.signedIn ? 'api' : 'gated');
    let alive = true;
    (async () => {
      if (mode === 'gated') {
        if (alive) { setWatchlist([]); setWlSources({}); setPortfolio([]); setTradeLog([]); }
        return;
      }
      try {
        const wl = await store.loadWatchlist(mode, exchange);
        if (!alive) return;
        setWatchlist(wl.symbols); setWlSources(wl.sources);
        const rows = await store.loadPortfolio(mode);
        if (!alive) return;
        setPortfolio(rows.map(posFromRow));
        setTradeLog(rows.filter(function (r) { return String(r.status).toLowerCase() === 'closed'; }).map(tradeFromClosedRow));
      } catch (err) { console.error('user data load failed:', err); }
    })();
    return function () { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.loading, auth.configured, auth.signedIn, exchange]);

  // Load the agent's real track record the first time the tab is opened.
  useEffect(() => {
    if (tab === 'track' && !track) loadTrack();
  }, [tab, track, loadTrack]);

  // -- actions ----------------------------------------------------------------
  const scanNow = useCallback(async () => {
    if (running || scanStarting) return;
    setScanStarting(true);
    addLog('scan requested', 'info');
    try {
      const res = await fetch('/api/cron/scan?exchange=' + encodeURIComponent(exchange), { method: 'POST' });
      const data = await res.json();
      if (data.skipped) addLog('scan already in progress', 'info');
      else if (data.started) addLog('scan started — ' + data.total + ' stocks (' + (data.sentiment || 'NEUTRAL') + ')', 'ok');
      else if (data.error) addLog('scan error: ' + data.error, 'err');
      startPolling();
    } catch (err) {
      addLog('scan failed to start: ' + err.message, 'err');
    } finally {
      setScanStarting(false);
    }
  }, [running, scanStarting, addLog, startPolling, exchange]);

  const retryStock = useCallback(async (symbol) => {
    addLog('retrying ' + symbol + '…', 'api');
    try {
      await fetch('/api/scan/worker?symbol=' + encodeURIComponent(symbol) + '&force=true', { method: 'POST' });
      startPolling();
    } catch (e) { addLog('retry failed: ' + e.message, 'err'); }
  }, [addLog, startPolling]);

  // -- stock overlay (server) -------------------------------------------------
  function openStock(sym) {
    setOvSym(sym); setOvData(null); setOvAnalysis(''); setOvSig(null); setOvLoading(true);
    fetch('/api/stock?symbol=' + encodeURIComponent(sym), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (res.data) {
          setOvData(res.data);
          var sc = {}; sc[sym] = res.data;
          setStockCache(function (prev) { var u = Object.assign({}, prev, sc); store.deviceSet('ni:sc', u); return u; });
        }
        if (res.analysis) setOvAnalysis(res.analysis);
        else if (res.budget === false) setOvAnalysis('AI budget reached for today — showing last stored data. Fresh analysis resumes after 00:00 UTC.');
        if (res.signal) {
          var sig = normalizeSig(res.signal);
          setOvSig(sig);
          setSignals(function (prev) {
            return [sig].concat(prev.filter(function (s) { return s.symbol !== sym; }));
          });
        }
      })
      .catch(function (e) { setOvAnalysis('Error: ' + e.message); })
      .then(function () { setOvLoading(false); });
  }

  // -- trades (per-user table via /api/portfolio, or device-local in open mode) -----
  async function logBuy(sig) {
    if (gated) { showToast('Sign in with Google to save positions', 'err'); return; }
    var q = parseFloat(buyQty), p = sig.price || 0;
    if (!q || !p || !buyReason) { showToast('Basis required', 'err'); return; }
    var row = {
      exchange: exchange, symbol: sig.symbol, qty: q, buy_price: p,
      stop_loss: parseFloat(buySL) || sig.sl || null, target: sig.target || null,
      basis: buyReason, // persisted only in local/open mode (schema has no column)
    };
    try {
      await store.openPosition(currentMode(), row);
      await reloadPortfolio();
      await addToWatchlist(sig.symbol, 'holding');
      setBuyTarget(null); setBuyQty(''); setBuySL(''); setBuyReason('');
      showToast('BUY ' + sig.symbol + ' Rs' + p); setTab('positions');
    } catch (e) { showToast('Could not save position', 'err'); }
  }

  async function logSell(pos) {
    if (gated) { showToast('Sign in with Google to save', 'err'); return; }
    var sp = parseFloat(sellPrice);
    if (!sp || !sellReason) { showToast('Price and reason required', 'err'); return; }
    var hd = daysAgo(pos.date), c = calcC('SELL', pos.qty, sp, pos.price, hd);
    try {
      await store.closePosition(currentMode(), pos.id, sp);
      await reloadPortfolio();
    } catch (e) { showToast('Could not close position', 'err'); return; }
    var outcome = c.npl >= 0 ? 'WIN' : 'LOSS';
    // Reflect the outcome on the local signal copy for immediate UX feedback
    // (server computes durable outcomes separately via its outcomes step).
    setSignals(function (prev) {
      return prev.map(function (s) {
        if (s.symbol === pos.symbol && (!s.outcome || s.outcome === 'PENDING')) {
          return Object.assign({}, s, { outcome: outcome, exit_price: sp, return_pct: ((sp - pos.price) / pos.price * 100).toFixed(2) });
        }
        return s;
      });
    });
    setSellTarget(null); setSellPrice(''); setSellReason('');
    showToast('SELL ' + pos.symbol + ' ' + signed(c.npl) + (outcome === 'WIN' ? ' WIN' : ' LOSS'), c.npl >= 0 ? 'ok' : 'err');
    setTab('positions');
  }

  // -- chat (server) ----------------------------------------------------------
  function sendChat(text) {
    var msg = (text || chatInput || '').trim();
    if (!msg || chatLoading) return;
    setChatInput('');
    var newChat = chat.concat([{ role: 'user', content: msg, ts: new Date().toISOString() }]);
    setChat(newChat); store.deviceSet('ni:chat', newChat); setChatLoading(true);
    var context = {
      portfolio: portfolio,
      signals: signals.slice(0, 12).map(function (s) { return { symbol: s.symbol, signal: s.signal, price: s.price }; }),
      watchlist: watchlist,
      market: market ? { index: market.index, change_pct: market.change_pct, sentiment: market.sentiment } : null,
    };
    fetch('/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: msg, context: context }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var reply = d.reply || (d.error ? 'Error: ' + d.error : 'No response.');
        var final = newChat.concat([{ role: 'assistant', content: reply, ts: new Date().toISOString() }]);
        setChat(final); store.deviceSet('ni:chat', final); setChatLoading(false);
      })
      .catch(function (e) {
        var final = newChat.concat([{ role: 'assistant', content: 'Error: ' + e.message, ts: new Date().toISOString() }]);
        setChat(final); store.deviceSet('ni:chat', final); setChatLoading(false);
      });
  }

  // -- tabs -------------------------------------------------------------------
  var TABS = [
    { k: 'today', label: 'Today' },
    { k: 'positions', label: 'Positions' + (noSLCount > 0 ? ' !' : '') },
    { k: 'signals', label: 'Signals' },
    { k: 'track', label: 'Track Record' },
    { k: 'watchlist', label: 'Watch ' + watchlist.length },
  ];

  var progressLabel = running ? (status.completed || 0) + '/' + (status.total || 0) + (scanSym ? ' ' + scanSym : '') : null;

  // Hard login wall (Option B): require sign-in before the app renders — ONLY when
  // both Google auth is configured AND NEXT_PUBLIC_REQUIRE_LOGIN=true. Dormant
  // otherwise, so the app stays open and nobody gets locked out before Google is
  // wired (or if you keep viewing open for the public track record).
  if (auth.configured && auth.requireLogin && !auth.loading && !auth.signedIn) {
    return <LoginWall onSignIn={auth.signIn} />;
  }

  // ---------------------------------------------------------------------------
  return (
    <div className="app-shell" style={{ background: '#07090e', minHeight: '100vh', display: 'flex', flexDirection: 'column', fontFamily: 'IBM Plex Mono,monospace', color: '#c8d4e8', fontSize: 12 }}>

      {/* toasts */}
      <div style={{ position: 'fixed', top: 10, left: '50%', transform: 'translateX(-50%)', zIndex: 400, display: 'flex', flexDirection: 'column', gap: 4, pointerEvents: 'none', alignItems: 'center' }}>
        {toasts.map(function (t) {
          var tc = t.t === 'err' ? '#ef4444' : t.t === 'info' ? '#3b82f6' : '#10b981';
          return <div key={t.id} style={{ padding: '6px 14px', borderRadius: 20, background: '#0d1018', border: '1px solid ' + tc + '44', color: tc, fontSize: 10, fontFamily: 'Inter,sans-serif', whiteSpace: 'nowrap' }}>{t.msg}</div>;
        })}
      </div>

      {/* ONBOARDING — first-run "which market do you trade?" step. Minimal +
          dismissible; sets the device-local exchange preference (ni:exchange). */}
      {showOnboard && (
        <div className="modal-overlay" style={{ zIndex: 500, background: '#04060bdd' }}>
          <div className="modal-panel" style={{ background: '#0b0e16', border: '1px solid #1e2840', borderRadius: 14, padding: '22px 24px', maxWidth: 460 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: '#e2e8f0', fontFamily: 'Inter,sans-serif', marginBottom: 4 }}>Which market do you trade?</div>
            <div style={{ fontSize: 11, color: '#4a5568', marginBottom: 16 }}>Pick your exchange — you can change it any time in Settings.</div>
            <div style={{ display: 'grid', gap: 8 }}>
              {Object.keys(EXCHANGES).map(function (exId) {
                var ex = EXCHANGES[exId]; var avail = !!exAvail[exId];
                return (
                  <button key={exId} disabled={!avail} onClick={function () { if (avail) { saveExchange(exId); setShowOnboard(false); } }} style={{ padding: '12px 14px', borderRadius: 8, border: '1px solid #1e2840', background: 'transparent', cursor: avail ? 'pointer' : 'not-allowed', opacity: avail ? 1 : 0.5, textAlign: 'left' }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#e2e8f0', fontFamily: 'Inter,sans-serif' }}>{ex.name} <span style={{ color: '#4a5568', fontWeight: 400 }}>{ex.currency}</span></div>
                    <div style={{ fontSize: 9, color: '#2a3550', fontFamily: 'IBM Plex Mono,monospace', marginTop: 3 }}>{avail ? ex.source + ' · ' + ex.hours : 'not enabled on this deployment'}</div>
                  </button>
                );
              })}
            </div>
            <button onClick={function () { saveExchange(exchange); setShowOnboard(false); }} style={{ marginTop: 14, fontSize: 10, color: '#4a5568', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'IBM Plex Mono,monospace' }}>skip — use {exchange}</button>
          </div>
        </div>
      )}

      {/* HEADER */}
      <div style={{ background: '#07090e', borderBottom: '1px solid #141824', padding: '0 16px', flexShrink: 0 }}>
        {/* top bar */}
        <div className="app-topbar" style={{ display: 'flex', alignItems: 'center', gap: 10, borderBottom: '1px solid #0f1420' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ width: 7, height: 7, borderRadius: '50%', background: running ? '#f59e0b' : '#10b981', animation: running ? '_dot 1s ease infinite' : 'none' }} />
            <span style={{ fontSize: 14, fontWeight: 600, color: '#e2e8f0', letterSpacing: '-.01em', fontFamily: 'Inter,sans-serif' }}>{exchange}</span>
            <span style={{ fontSize: 10, color: '#2a3550', fontFamily: 'Inter,sans-serif' }}>Intelligence</span>
          </div>
          {market ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 10px', background: '#0b0e16', border: '1px solid #1e2840', borderRadius: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#e2e8f0', fontFamily: 'IBM Plex Mono,monospace' }}>{market.index}</span>
              <span style={{ fontSize: 10, color: market.change_pct >= 0 ? '#10b981' : '#ef4444', fontFamily: 'IBM Plex Mono,monospace' }}>{toPct(market.change_pct)}</span>
              <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 3, background: market.sentiment === 'BULLISH' ? '#10b98122' : market.sentiment === 'BEARISH' ? '#ef444422' : '#f59e0b22', color: market.sentiment === 'BULLISH' ? '#10b981' : market.sentiment === 'BEARISH' ? '#ef4444' : '#f59e0b' }}>{market.sentiment}</span>
            </div>
          ) : (
            <div style={{ padding: '3px 10px', background: '#0b0e16', border: '1px solid #1e2840', borderRadius: 6 }}>
              <span style={{ fontSize: 9, color: '#4a5568' }}>{running ? 'scanning ' + (scanPhase || '') + (scanSym ? ' ' + scanSym : '') + '...' : signals.length + ' signals ready'}</span>
            </div>
          )}
          <div className="topbar-actions" style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            {running && <span style={{ fontSize: 10, color: '#f59e0b', fontFamily: 'IBM Plex Mono,monospace' }}>{progressLabel}{status.stalled ? ' (stalled)' : ''}</span>}
            {openPos.length > 0 && <span style={{ fontSize: 10, color: '#4a5568', fontFamily: 'Inter,sans-serif' }}>{openPos.length + ' open'}</span>}
            {realisedPL !== 0 && <span style={{ fontSize: 10, fontWeight: 500, color: realisedPL >= 0 ? '#10b981' : '#ef4444', fontFamily: 'IBM Plex Mono,monospace' }}>{signed(realisedPL)}</span>}
            <button onClick={scanNow} disabled={running || scanStarting} style={{ padding: '4px 12px', borderRadius: 5, border: '1px solid ' + (running ? '#1e2840' : '#3b82f6'), background: running ? 'transparent' : '#3b82f615', color: running ? '#4a5568' : '#3b82f6', fontSize: 10, cursor: running ? 'default' : 'pointer', fontFamily: 'IBM Plex Mono,monospace' }}>{running ? 'scanning…' : scanStarting ? 'starting…' : 'scan'}</button>
            <button onClick={function () { setShowLog(function (v) { return !v; }); }} style={{ padding: '3px 8px', borderRadius: 5, border: '1px solid #1e2840', background: showLog ? '#1e2840' : 'transparent', color: showLog ? '#e2e8f0' : '#4a5568', fontSize: 9, cursor: 'pointer', fontFamily: 'IBM Plex Mono,monospace', display: 'flex', alignItems: 'center', gap: 4 }}>{running && <span style={{ width: 4, height: 4, borderRadius: '50%', background: '#f59e0b', animation: '_dot 1s ease infinite', display: 'inline-block' }} />}{'activity'}</button>
            {/* Persistent, non-intrusive sign-in (only when Google auth is configured).
                Sign-in saves YOUR watchlist/positions; viewing is free either way. */}
            {auth.configured && !auth.loading && !auth.signedIn && (
              <button onClick={auth.signIn} title="Sign in to save your watchlist and positions" style={{ padding: '4px 12px', borderRadius: 5, border: '1px solid #3b82f6', background: '#3b82f615', color: '#3b82f6', fontSize: 10, cursor: 'pointer', fontFamily: 'Inter,sans-serif', fontWeight: 600 }}>Sign in</button>
            )}
            {auth.configured && auth.signedIn && auth.email && (
              <button onClick={function () { setTab('settings'); }} title={auth.email} style={{ width: 24, height: 24, borderRadius: '50%', border: '1px solid #3b82f633', background: '#3b82f618', color: '#3b82f6', fontSize: 11, cursor: 'pointer', fontFamily: 'IBM Plex Mono,monospace', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{auth.email[0].toUpperCase()}</button>
            )}
          </div>
        </div>
        {/* nav bar */}
        <div className="app-nav" style={{ display: 'flex', alignItems: 'center' }}>
          <div className="nav-tabs" style={{ display: 'flex', flex: 1, gap: 0 }}>
            {TABS.map(function (t) {
              var active = tab === t.k;
              return (
                <button key={t.k} onClick={function () { setTab(t.k); }} style={{ padding: '0 14px', height: 38, border: 'none', background: 'none', cursor: 'pointer', fontSize: 12, fontWeight: active ? 500 : 400, fontFamily: 'Inter,sans-serif', color: active ? '#e2e8f0' : '#4a5568', borderBottom: active ? '2px solid #3b82f6' : '2px solid transparent', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 5 }}>
                  {t.label}
                  {t.k === 'signals' && buySigCount > 0 && <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 10, background: '#10b98122', color: '#10b981', fontFamily: 'IBM Plex Mono,monospace' }}>{buySigCount}</span>}
                  {t.k === 'positions' && noSLCount > 0 && <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 10, background: '#ef444422', color: '#ef4444', fontFamily: 'IBM Plex Mono,monospace' }}>!</span>}
                </button>
              );
            })}
          </div>
          <div style={{ width: 1, height: 20, background: '#1e2840', margin: '0 6px' }} />
          <button onClick={function () { setTab('settings'); }} title="Settings" style={{ padding: '0 10px', height: 38, border: 'none', background: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', borderBottom: tab === 'settings' ? '2px solid #3b82f6' : '2px solid transparent' }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={tab === 'settings' ? '#e2e8f0' : '#4a5568'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
          <button onClick={function () { setSidebarOpen(function (v) { return !v; }); }} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '0 12px', height: 34, border: '1px solid ' + (sidebarOpen ? '#3b82f6' : '#1e2840'), borderRadius: 7, background: sidebarOpen ? '#3b82f610' : 'transparent', cursor: 'pointer', marginLeft: 4 }}>
            <span style={{ fontSize: 11, color: sidebarOpen ? '#3b82f6' : '#4a5568', fontFamily: 'Inter,sans-serif', fontWeight: 500 }}>Ask</span>
            <span style={{ fontSize: 10, color: sidebarOpen ? '#3b82f6' : '#2a3550' }}>{sidebarOpen ? 'x' : ''}</span>
          </button>
        </div>
        {/* schedule indicator */}
        {(status && (status.last_scan_at || status.next_scheduled)) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0', fontSize: 9, color: '#2a3550', fontFamily: 'IBM Plex Mono,monospace' }}>
            {status.last_scan_at ? <span title={new Date(status.last_scan_at).toLocaleString()}>last scan {timeAgo(status.last_scan_at)} ago</span> : <span>no scans yet</span>}
            {status.next_scheduled && <><span>·</span><span title={new Date(status.next_scheduled).toLocaleString()}>next {new Date(status.next_scheduled).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></>}
          </div>
        )}
      </div>

      {/* DISCLAIMER — persistent, on every surface (guardrail #2 + sample-data flag) */}
      <Disclaimer exchange={exchange} />

      {/* ACTIVITY PANEL */}
      {showLog && (
        <div style={{ background: '#060810', borderBottom: '1px solid #141824', maxHeight: 320, overflowY: 'auto', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 16px', borderBottom: '1px solid #0f1420', position: 'sticky', top: 0, background: '#060810', zIndex: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ width: 5, height: 5, borderRadius: '50%', background: running ? '#f59e0b' : '#2a3550', animation: running ? '_dot 1s ease infinite' : 'none' }} />
              <span style={{ fontSize: 10, fontWeight: 500, color: '#e2e8f0', fontFamily: 'Inter,sans-serif' }}>Agent Activity</span>
              <span style={{ fontSize: 9, color: '#2a3550', fontFamily: 'IBM Plex Mono,monospace' }}>{activity.length + logs.length + ' entries'}</span>
            </div>
            <button onClick={loadActivity} style={{ fontSize: 9, color: '#2a3550', background: 'none', border: '1px solid #1e2840', borderRadius: 3, padding: '2px 7px', cursor: 'pointer', fontFamily: 'IBM Plex Mono,monospace' }}>refresh</button>
          </div>
          {(activity.length + logs.length) === 0 && <div style={{ fontSize: 10, color: '#2a3550', padding: '12px 16px', fontFamily: 'IBM Plex Mono,monospace' }}>no activity yet _ run a scan to populate this</div>}
          {/* local ephemeral notices first */}
          {logs.map(function (l, i) {
            var lc = l.t === 'ok' ? '#10b981' : l.t === 'err' ? '#ef4444' : l.t === 'api' ? '#3b82f6' : '#8899b4';
            return (
              <div key={'local-' + i} style={{ display: 'flex', gap: 8, padding: '5px 16px', alignItems: 'flex-start', borderTop: '1px solid #0a0c14' }}>
                <span style={{ color: '#2a3550', flexShrink: 0, fontSize: 9, marginTop: 1 }}>{new Date(l.ts).toLocaleTimeString([], { hour12: false })}</span>
                <span style={{ fontSize: 10, color: lc, flex: 1, lineHeight: 1.4 }}>{l.msg}</span>
              </div>
            );
          })}
          {/* durable server events */}
          {activity.map(function (a, i) {
            var msg = a.message || a.type || '';
            var lc = /fail|error|skip/i.test(msg) ? '#ef4444' : a.type === 'signal' ? '#f59e0b' : /complete|started|done/i.test(msg) ? '#10b981' : '#8899b4';
            var hasDetail = a.data && Object.keys(a.data).length > 0;
            var isExpanded = logExpanded[i];
            return (
              <div key={a.id || 'ev-' + i} style={{ borderTop: '1px solid #0a0c14' }}>
                <div onClick={function () { if (hasDetail) setLogExpanded(function (prev) { var u = Object.assign({}, prev); u[i] = !u[i]; return u; }); }} style={{ display: 'flex', gap: 8, padding: '5px 16px', alignItems: 'flex-start', cursor: hasDetail ? 'pointer' : 'default', background: isExpanded ? '#0b0e16' : 'transparent' }}>
                  <span style={{ color: '#2a3550', flexShrink: 0, fontSize: 9, marginTop: 1 }}>{a.created_at ? new Date(a.created_at).toLocaleTimeString([], { hour12: false }) : ''}</span>
                  <span style={{ fontSize: 10, color: lc, flex: 1, lineHeight: 1.4 }}>{msg}</span>
                  {hasDetail && <span style={{ fontSize: 8, color: '#2a3550', flexShrink: 0, marginTop: 1 }}>{isExpanded ? '^' : 'v'}</span>}
                </div>
                {isExpanded && hasDetail && (
                  <div style={{ padding: '8px 16px 8px 38px', background: '#0b0e16', borderTop: '1px solid #0f1420' }}>
                    <pre style={{ fontSize: 9, color: '#8899b4', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'IBM Plex Mono,monospace', margin: 0 }}>{JSON.stringify(a.data, null, 2)}</pre>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* partial-scan banner */}
      {isPartial && (failedJobs.length > 0 || skippedJobs.length > 0) && (
        <div style={{ background: '#3a2c10', borderBottom: '1px solid #f59e0b55', color: '#f59e0b', padding: '8px 16px', fontSize: 11, fontFamily: 'Inter,sans-serif' }}>
          {'⚠ Partial scan — '}
          {failedJobs.length > 0 && failedJobs.length + ' failed' + (skippedJobs.length ? ', ' : '. ')}
          {skippedJobs.length > 0 && skippedJobs.length + ' skipped (AI quota). '}
          Retry from the Watchlist tab.
        </div>
      )}

      {/* MAIN LAYOUT */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

        {/* main content */}
        <div className="app-content" style={{ flex: 1, overflowY: 'auto' }}>

          {/* TODAY */}
          {tab === 'today' && (
            <div>
              {alerts.length > 0 && (
                <div style={{ marginBottom: 10 }}>
                  {alerts.map(function (a, i) {
                    var isTarget = a.type === 'TARGET_HIT';
                    return (
                      <div key={i} style={{ background: isTarget ? '#10b98115' : '#ef444415', border: '1px solid ' + (isTarget ? '#10b981' : '#ef4444'), borderRadius: 8, padding: '10px 14px', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 10 }}>
                        <div style={{ width: 6, height: 6, borderRadius: '50%', background: isTarget ? '#10b981' : '#ef4444', animation: '_dot 1s ease infinite' }} />
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 12, fontWeight: 600, color: isTarget ? '#10b981' : '#ef4444', fontFamily: 'Inter,sans-serif' }}>{isTarget ? 'Target hit' : 'Stop-loss breached'}</div>
                          <div style={{ fontSize: 11, color: '#c8d4e8', marginTop: 1 }}>{a.msg}</div>
                        </div>
                        <button onClick={function () { var pos = portfolio.find(function (p) { return p.symbol === a.symbol && p.status === 'OPEN'; }); if (pos) { setSellTarget(pos.id); setSellPrice(String(a.price)); } setTab('positions'); }} style={{ padding: '4px 10px', borderRadius: 5, border: '1px solid ' + (isTarget ? '#10b981' : '#ef4444'), background: 'transparent', color: isTarget ? '#10b981' : '#ef4444', fontSize: 10, cursor: 'pointer', fontFamily: 'IBM Plex Mono,monospace' }}>{isTarget ? 'take profit' : 'exit now'}</button>
                      </div>
                    );
                  })}
                </div>
              )}
              {brief ? (
                <div style={card(brief.mood === 'POSITIVE' ? '#10b981' : brief.mood === 'CAUTIOUS' ? '#f59e0b' : '#1c2333')}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: '#e2e8f0', marginBottom: 6, lineHeight: 1.4, fontFamily: 'IBM Plex Sans,sans-serif' }}>{brief.headline}</div>
                  {(brief.market_note || brief.summary) && <div style={{ fontSize: 11, color: '#4a5568', marginBottom: 3, fontFamily: 'IBM Plex Sans,sans-serif', lineHeight: 1.6 }}>{brief.market_note || brief.summary}</div>}
                  {brief.portfolio_flag && <div style={{ fontSize: 11, color: '#f59e0b', marginBottom: 3 }}>! {brief.portfolio_flag}</div>}
                  {Array.isArray(brief.topPicks) && brief.topPicks.length > 0 && <div style={{ fontSize: 11, color: '#10b981', marginBottom: 3 }}>top picks: {brief.topPicks.join(', ')}</div>}
                  {brief.top_action && <div style={{ fontSize: 11, color: '#3b82f6' }}>-&gt; {brief.top_action}</div>}
                  {brief.risks && <div style={{ fontSize: 10, color: '#f59e0b', marginTop: 4, fontFamily: 'IBM Plex Sans,sans-serif' }}>risk: {brief.risks}</div>}
                </div>
              ) : running ? (
                <div style={card()}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                    <div style={{ width: 5, height: 5, borderRadius: '50%', background: '#f59e0b', animation: '_dot 1s ease infinite' }} />
                    <span style={{ fontSize: 10, color: '#4a5568' }}>{scanPhase === 'market' ? 'fetching NEPSE market...' : scanSym ? 'scanning ' + scanSym : 'scan in progress...'}</span>
                  </div>
                  {ghost(55)}{ghost(75)}{ghost(40)}
                </div>
              ) : (
                <div style={card()}>
                  <div style={{ fontSize: 11, color: '#4a5568', marginBottom: 8 }}>No brief yet.</div>
                  <button onClick={scanNow} style={btn('#3b82f6')}>run scan now</button>
                </div>
              )}

              {/* discovered-today banner */}
              {signals.filter(function (s) { return s.source === 'discovered'; }).length > 0 && (
                <div style={{ background: '#0d1018', border: '1px solid #10b98133', borderRadius: 8, padding: '10px 14px', marginBottom: 8 }}>
                  <div style={{ fontSize: 9, color: '#10b981', letterSpacing: '.08em', marginBottom: 6 }}>AUTO-DISCOVERED TODAY</div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {signals.filter(function (s) { return s.source === 'discovered'; }).map(function (s) {
                      var sc = SIG_COLORS[s.signal] || '#4a5568';
                      return (
                        <div key={s.symbol} onClick={function () { openStock(s.symbol); }} style={{ background: '#080a0f', border: '1px solid ' + sc + '44', borderRadius: 5, padding: '5px 10px', cursor: 'pointer' }}>
                          <span style={{ fontSize: 11, fontWeight: 600, color: '#e2e8f0' }}>{s.symbol}</span>
                          <span style={{ fontSize: 9, color: sc, marginLeft: 6 }}>{s.signal}</span>
                          {s.live && <span style={{ fontSize: 9, color: '#4a5568', marginLeft: 4 }}>{'Rs' + s.live.price}</span>}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* market movers */}
              {market && (market.gainers || []).length > 0 && (
                <div className="grid-stack-sm" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                  <div style={{ background: '#0d1018', border: '1px solid #1c2333', borderRadius: 8, padding: '10px 12px' }}>
                    <div style={{ fontSize: 9, color: '#10b981', letterSpacing: '.08em', marginBottom: 6 }}>GAINERS</div>
                    {(market.gainers || []).slice(0, 4).map(function (g, i) {
                      return <div key={i} onClick={function () { openStock(g.symbol); }} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', borderTop: '1px solid #1c2333', cursor: 'pointer' }}>
                        <span style={{ color: '#e2e8f0', fontSize: 11, fontWeight: 500 }}>{g.symbol}</span>
                        <span style={{ fontSize: 10, color: '#10b981' }}>{'+' + (g.pct || 0).toFixed(1) + '%'}</span>
                      </div>;
                    })}
                  </div>
                  <div style={{ background: '#0d1018', border: '1px solid #1c2333', borderRadius: 8, padding: '10px 12px' }}>
                    <div style={{ fontSize: 9, color: '#ef4444', letterSpacing: '.08em', marginBottom: 6 }}>LOSERS</div>
                    {(market.losers || []).slice(0, 4).map(function (g, i) {
                      return <div key={i} onClick={function () { openStock(g.symbol); }} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', borderTop: '1px solid #1c2333', cursor: 'pointer' }}>
                        <span style={{ color: '#e2e8f0', fontSize: 11, fontWeight: 500 }}>{g.symbol}</span>
                        <span style={{ fontSize: 10, color: '#ef4444' }}>{(g.pct || 0).toFixed(1) + '%'}</span>
                      </div>;
                    })}
                  </div>
                </div>
              )}

              {/* top buy signals */}
              {signals.filter(function (s) { return s.signal === 'BUY'; }).slice(0, 3).map(function (s) {
                var sc = SIG_COLORS[s.signal];
                return (
                  <div key={s.id} style={card(sc)}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0' }}>{s.symbol}</span>
                      <span style={{ fontSize: 9, fontWeight: 700, color: sc, background: sc + '20', padding: '1px 6px', borderRadius: 3 }}>{s.signal}</span>
                      <span style={{ fontSize: 9, color: s.confidence === 'HIGH' ? '#10b981' : s.confidence === 'MEDIUM' ? '#f59e0b' : '#4a5568' }}>{s.confidence}</span>
                      {s.live && <span style={{ fontSize: 8, color: '#10b981', background: '#10b98118', padding: '1px 5px', borderRadius: 2 }}>{'Rs' + s.live.price}</span>}
                      {s.source === 'discovered' && <span style={{ fontSize: 8, color: '#a78bfa', background: '#a78bfa18', padding: '1px 5px', borderRadius: 2 }}>discovered</span>}
                    </div>
                    <div style={{ fontSize: 11, color: '#8899b4', lineHeight: 1.7, marginBottom: 8, padding: '7px 10px', background: '#080a0f', borderRadius: 4, fontFamily: 'IBM Plex Sans,sans-serif' }}>{s.why}</div>
                    <div className="grid-2-sm" style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 5, marginBottom: 8 }}>
                      {sbox('entry', s.entry)}{sbox('stop loss', s.sl ? 'Rs ' + s.sl : '-', '#ef4444')}{sbox('target', s.target ? 'Rs ' + s.target : '-', '#10b981')}
                    </div>
                    {s.action && <div style={{ fontSize: 11, color: '#3b82f6', marginBottom: 8, fontFamily: 'IBM Plex Sans,sans-serif' }}>-&gt; {s.action}</div>}
                    {buyTarget === s.id ? (
                      <BuyForm s={s} buyQty={buyQty} setBuyQty={setBuyQty} buySL={buySL} setBuySL={setBuySL} buyReason={buyReason} setBuyReason={setBuyReason} onConfirm={function () { logBuy(s); }} onCancel={function () { setBuyTarget(null); setBuyQty(''); setBuySL(''); setBuyReason(''); }} />
                    ) : (
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button onClick={function () { startBuy(s.id); }} style={btn('#10b981')}>buy</button>
                        <button onClick={function () { openStock(s.symbol); }} style={btn('#3b82f6')}>full view</button>
                        <button onClick={function () { openAsk('Signal ' + s.symbol + ' ' + s.signal + ' Rs' + s.price + '. ' + (s.why || '') + ' Should I act?'); }} style={btn()}>ask</button>
                      </div>
                    )}
                  </div>
                );
              })}
              {signals.length === 0 && !running && (
                <div style={{ textAlign: 'center', padding: '40px 20px', color: '#4a5568' }}>
                  <div style={{ fontSize: 11, marginBottom: 10 }}>no signals yet — the agent scans on schedule, or run one now</div>
                  <button onClick={scanNow} style={btn('#3b82f6')}>scan now</button>
                </div>
              )}
            </div>
          )}

          {/* POSITIONS */}
          {tab === 'positions' && (
            <div>
              {openPos.length > 0 && (
                <div className="grid-2-sm" style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8, marginBottom: 12 }}>
                  {[['open', '' + openPos.length, null], ['deployed', toRs(openPos.reduce(function (s, p) { return s + p.net; }, 0)), null], ['realised', signed(realisedPL), realisedPL >= 0 ? '#10b981' : '#ef4444'], ['win %', closedSells.length ? Math.round(closedSells.filter(function (t) { return (t.npl || 0) > 0; }).length / closedSells.length * 100) + '%' : '-', '#3b82f6']].map(function (item) {
                    return <div key={item[0]} style={{ background: '#0d1018', border: '1px solid #1c2333', borderRadius: 6, padding: '8px 10px' }}><div style={{ fontSize: 9, color: '#4a5568', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 3 }}>{item[0]}</div><div style={{ fontSize: 16, fontWeight: 600, color: item[2] || '#e2e8f0' }}>{item[1]}</div></div>;
                  })}
                </div>
              )}
              {gated
                ? <SignInPrompt title="Sign in to track your positions" sub="Log your buys and sells to see invested amount, break-even and live P&L. Your positions are private to your account." onSignIn={auth.signIn} />
                : (openPos.length === 0 && closedSells.length === 0 && <div style={{ textAlign: 'center', padding: '50px 20px', color: '#4a5568', fontSize: 11 }}>no open positions</div>)}
              {openPos.map(function (p) {
                var live = stockCache[p.symbol];
                var sigLive = signals.find(function (s) { return s.symbol === p.symbol && s.live; });
                var lp = live ? live.price : (sigLive && sigLive.live ? sigLive.live.price : null);
                var unr = lp ? (lp - p.price) * p.qty : null; var noSL = !p.sl;
                var sig = signals.find(function (s) { return s.symbol === p.symbol; });
                var sigC = sig ? (SIG_COLORS[sig.signal] || '#4a5568') : null;
                return (
                  <div key={p.id} style={card(noSL && daysAgo(p.date) > 3 ? '#ef4444' : '#10b981')}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0' }}>{p.symbol}</span>
                      <span style={{ fontSize: 10, color: '#4a5568' }}>{p.qty + 'u @ Rs' + p.price}</span>
                      {sig && sigC && <span style={{ fontSize: 9, fontWeight: 700, color: sigC, background: sigC + '20', padding: '1px 5px', borderRadius: 3 }}>{sig.signal}</span>}
                      {lp && <span style={{ fontSize: 10, color: '#e2e8f0' }}>{'live Rs' + lp}</span>}
                      {unr !== null && <span style={{ fontSize: 10, color: unr >= 0 ? '#10b981' : '#ef4444' }}>{(unr >= 0 ? '+' : '') + toRs(unr)}</span>}
                      <span style={{ marginLeft: 'auto', fontSize: 9, color: '#4a5568' }}>{'day ' + daysAgo(p.date)}</span>
                    </div>
                    <div className="grid-2-sm" style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 5, marginBottom: 8 }}>
                      {sbox('invested', toRs(p.net))}{sbox('break-even', p.be ? 'Rs ' + p.be.toFixed(0) : '-')}{sbox('stop loss', p.sl ? 'Rs ' + p.sl : 'NOT SET', noSL ? '#ef4444' : null)}{sbox('target', p.target ? 'Rs ' + p.target : '-', p.target ? '#10b981' : null)}
                    </div>
                    {p.basis && <div style={{ fontSize: 10, color: '#1c2333', fontStyle: 'italic', marginBottom: 6 }}>{'"' + p.basis + '"'}</div>}
                    {noSL && <div style={{ fontSize: 10, color: '#ef4444', marginBottom: 6 }}>no stop-loss set</div>}
                    {sellTarget === p.id ? (
                      <div style={{ background: '#080a0f', borderRadius: 6, padding: 10, border: '1px solid #1c2333' }}>
                        <div className="grid-stack-sm" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                          <div><div style={{ fontSize: 9, color: '#4a5568', marginBottom: 3 }}>sell price <span style={{ color: '#ef4444' }}>*</span></div><input value={sellPrice} onChange={function (e) { setSellPrice(e.target.value); }} type="number" placeholder={lp ? String(lp) : 'current'} /></div>
                          <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
                            {sellPrice && <div style={{ fontSize: 10, color: '#4a5568' }}>net: <span style={{ color: calcC('SELL', p.qty, parseFloat(sellPrice), p.price, daysAgo(p.date)).npl >= 0 ? '#10b981' : '#ef4444', fontWeight: 600 }}>{signed(calcC('SELL', p.qty, parseFloat(sellPrice), p.price, daysAgo(p.date)).npl)}</span></div>}
                          </div>
                        </div>
                        <div style={{ marginBottom: 8 }}><div style={{ fontSize: 9, color: '#4a5568', marginBottom: 3 }}>why selling? <span style={{ color: '#ef4444' }}>required</span></div><input value={sellReason} onChange={function (e) { setSellReason(e.target.value); }} placeholder="target hit / stop-loss / thesis changed" /></div>
                        {sellPrice && (
                          <div style={{ fontSize: 10, color: '#4a5568', marginBottom: 8, padding: '6px 8px', background: '#0d1018', borderRadius: 4 }}>
                            {'gross ' + signed(calcC('SELL', p.qty, parseFloat(sellPrice), p.price, daysAgo(p.date)).gpl) + ' charges ' + toRs2(calcC('SELL', p.qty, parseFloat(sellPrice), p.price, daysAgo(p.date)).tot) + ' net '}
                            <span style={{ color: calcC('SELL', p.qty, parseFloat(sellPrice), p.price, daysAgo(p.date)).npl >= 0 ? '#10b981' : '#ef4444', fontWeight: 600 }}>{signed(calcC('SELL', p.qty, parseFloat(sellPrice), p.price, daysAgo(p.date)).npl)}</span>
                          </div>
                        )}
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button onClick={function () { logSell(p); }} style={{ flex: 1, padding: '7px', borderRadius: 6, border: '1px solid #ef4444', background: 'transparent', color: '#ef4444', fontSize: 11, cursor: 'pointer', fontFamily: 'IBM Plex Mono,monospace' }}>confirm sell</button>
                          <button onClick={function () { setSellTarget(null); setSellPrice(''); setSellReason(''); }} style={btn()}>cancel</button>
                        </div>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button onClick={function () { setSellTarget(p.id); setSellPrice(lp ? String(lp) : ''); }} style={btn('#ef4444')}>sell</button>
                        <button onClick={function () { openStock(p.symbol); }} style={btn('#3b82f6')}>view</button>
                        <button onClick={function () { openAsk('Review ' + p.symbol + ' ' + p.qty + 'u@Rs' + p.price + ' ' + daysAgo(p.date) + 'd BE Rs' + (p.be ? p.be.toFixed(2) : '?') + (lp ? ' live Rs' + lp : '') + '. Hold or exit?'); }} style={btn()}>ask</button>
                      </div>
                    )}
                  </div>
                );
              })}
              {closedSells.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 9, color: '#4a5568', letterSpacing: '.08em', marginBottom: 8 }}>CLOSED TRADES</div>
                  {closedSells.map(function (t) {
                    return <div key={t.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '7px 10px', background: '#0d1018', border: '1px solid #1c2333', borderLeft: '2px solid ' + (t.npl >= 0 ? '#10b981' : '#ef4444'), borderRadius: 6, marginBottom: 5 }}>
                      <div><span style={{ fontSize: 12, fontWeight: 500, color: '#e2e8f0' }}>{t.symbol}</span><div style={{ fontSize: 9, color: '#4a5568' }}>{t.qty + 'u Rs' + t.price + ' ' + t.holdDays + 'd'}</div></div>
                      <div style={{ marginLeft: 'auto', textAlign: 'right' }}><div style={{ fontSize: 12, fontWeight: 600, color: t.npl >= 0 ? '#10b981' : '#ef4444' }}>{signed(t.npl)}</div><div style={{ fontSize: 9, color: '#4a5568' }}>{'charges ' + toRs2(t.tot)}</div></div>
                    </div>;
                  })}
                </div>
              )}
            </div>
          )}

          {/* SIGNALS */}
          {tab === 'signals' && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <div style={{ fontSize: 10, color: '#4a5568' }}>{signals.length + ' signals - ' + signals.filter(function (s) { return s.source === 'discovered'; }).length + ' discovered'}</div>
                <button onClick={scanNow} disabled={running || scanStarting} style={btn('#3b82f6')}>{running ? 'scanning...' : 'fresh scan'}</button>
              </div>
              {signals.length === 0 && <div style={{ textAlign: 'center', padding: '50px 20px', color: '#4a5568', fontSize: 11 }}>no signals yet<br /><br /><button onClick={scanNow} style={btn('#3b82f6')}>scan now</button></div>}
              {signals.map(function (s) {
                var sc = SIG_COLORS[s.signal] || '#4a5568'; var d = s.live;
                var isHeld = openPos.find(function (p) { return p.symbol === s.symbol; });
                return (
                  <div key={s.id} style={card(sc)}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0' }}>{s.symbol}</span>
                      <span style={{ fontSize: 9, fontWeight: 700, color: sc, background: sc + '20', padding: '1px 6px', borderRadius: 3 }}>{s.signal}</span>
                      <span style={{ fontSize: 9, color: s.confidence === 'HIGH' ? '#10b981' : s.confidence === 'MEDIUM' ? '#f59e0b' : '#4a5568' }}>{s.confidence}</span>
                      {d && <span style={{ fontSize: 8, color: '#10b981', background: '#10b98118', padding: '1px 5px', borderRadius: 2 }}>{'Rs' + d.price}</span>}
                      {s.source === 'discovered' && <span style={{ fontSize: 8, color: '#a78bfa', background: '#a78bfa18', padding: '1px 5px', borderRadius: 2 }}>discovered</span>}
                      {isHeld && <span style={{ fontSize: 9, color: '#8b5cf6', background: '#8b5cf622', padding: '1px 5px', borderRadius: 3 }}>held</span>}
                      {s.outcome && s.outcome !== 'PENDING' && <span style={{ fontSize: 9, color: s.outcome === 'WIN' ? '#10b981' : '#ef4444', background: (s.outcome === 'WIN' ? '#10b981' : '#ef4444') + '22', padding: '1px 5px', borderRadius: 3 }}>{s.outcome}</span>}
                      <span style={{ fontSize: 9, color: '#1c2333', marginLeft: 'auto' }}>{timeAgo(s.at)}</span>
                    </div>
                    {d && (
                      <div style={{ display: 'flex', gap: 10, padding: '5px 8px', background: '#080a0f', borderRadius: 4, marginBottom: 6, flexWrap: 'wrap' }}>
                        <span style={{ color: '#e2e8f0', fontWeight: 600 }}>{'Rs ' + d.price}</span>
                        {d.change_pct != null && <span style={{ fontSize: 10, color: d.change_pct >= 0 ? '#10b981' : '#ef4444' }}>{toPct(d.change_pct)}</span>}
                        {(d.pe != null || d.eps != null) && <span style={{ fontSize: 9, color: '#4a5568' }}>{(d.eps != null ? 'EPS ' + d.eps + ' ' : '') + (d.pe != null ? 'PE ' + d.pe : '')}</span>}
                      </div>
                    )}
                    <div style={{ fontSize: 11, color: '#8899b4', lineHeight: 1.7, marginBottom: 8, padding: '7px 10px', background: '#080a0f', borderRadius: 4, fontFamily: 'IBM Plex Sans,sans-serif' }}>{s.why}</div>
                    <div className="grid-2-sm" style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 5, marginBottom: 8 }}>
                      {sbox('entry', s.entry)}{sbox('stop loss', s.sl ? 'Rs ' + s.sl : '-', '#ef4444')}{sbox('target', s.target ? 'Rs ' + s.target : '-', '#10b981')}{sbox('hold', s.hold)}
                    </div>
                    {s.risk && <div style={{ fontSize: 10, color: '#f59e0b', marginBottom: 4, fontFamily: 'IBM Plex Sans,sans-serif' }}>{'risk: ' + s.risk}</div>}
                    {s.action && <div style={{ fontSize: 11, color: '#3b82f6', marginBottom: 8, fontFamily: 'IBM Plex Sans,sans-serif' }}>-&gt; {s.action}</div>}
                    {buyTarget === s.id ? (
                      <BuyForm s={s} buyQty={buyQty} setBuyQty={setBuyQty} buySL={buySL} setBuySL={setBuySL} buyReason={buyReason} setBuyReason={setBuyReason} onConfirm={function () { logBuy(s); }} onCancel={function () { setBuyTarget(null); setBuyQty(''); setBuySL(''); setBuyReason(''); }} />
                    ) : (
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {(s.signal === 'BUY' || s.signal === 'WATCH') && <button onClick={function () { startBuy(s.id); }} style={btn('#10b981')}>buy</button>}
                        {s.signal === 'SELL' && isHeld && <button onClick={function () { setSellTarget(isHeld.id); setSellPrice(s.price ? String(s.price) : ''); setTab('positions'); }} style={btn('#ef4444')}>sell</button>}
                        <button onClick={function () { openStock(s.symbol); }} style={btn('#3b82f6')}>full view</button>
                        <button onClick={function () { openAsk('Signal ' + s.symbol + ' ' + s.signal + ' Rs' + s.price + '. ' + (s.why || '') + ' Should I act?'); }} style={btn()}>ask</button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* TRACK RECORD */}
          {tab === 'track' && (
            <div className="fadeup">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0', fontFamily: 'Inter,sans-serif' }}>Track Record</div>
                  <div style={{ fontSize: 10, color: '#4a5568' }}>The agent&apos;s real, verified WIN/LOSS history — losses included. Past performance ≠ future results.</div>
                </div>
                <button onClick={loadTrack} style={{ fontSize: 9, color: '#2a3550', background: 'none', border: '1px solid #1e2840', borderRadius: 3, padding: '3px 8px', cursor: 'pointer', fontFamily: 'IBM Plex Mono,monospace' }}>refresh</button>
              </div>

              {!track ? (
                <div style={{ fontSize: 11, color: '#4a5568', padding: '16px 0' }}>Loading…</div>
              ) : track.overall.trades === 0 ? (
                <div style={{ background: '#0b0e16', border: '1px solid #1e2840', borderRadius: 12, padding: '20px 18px', textAlign: 'center' }}>
                  <div style={{ fontSize: 12, color: '#c8d4e8', marginBottom: 6 }}>No resolved outcomes yet.</div>
                  <div style={{ fontSize: 10, color: '#4a5568' }}>As BUY/SELL signals hit their target or stop-loss, the real record builds here.{track.pending ? ' ' + track.pending + ' pending.' : ''}</div>
                </div>
              ) : (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(88px, 1fr))', gap: 8, marginBottom: 12 }}>
                    {[
                      { l: 'win rate', v: fmtRate(track.overall.winRate), c: '#3b82f6' },
                      { l: 'conservative', v: fmtRate(track.overall.confidence), c: '#8b5cf6' },
                      { l: 'avg return', v: fmtRet(track.overall.avgReturn), c: track.overall.avgReturn >= 0 ? '#10b981' : '#ef4444' },
                      { l: 'record', v: track.overall.wins + 'W / ' + track.overall.losses + 'L', c: '#e2e8f0' },
                      { l: 'pending', v: String(track.pending), c: '#4a5568' },
                    ].map(function (x) {
                      return (
                        <div key={x.l} style={{ background: '#0b0e16', border: '1px solid #1e2840', borderRadius: 10, padding: '10px 12px' }}>
                          <div style={{ fontSize: 16, fontWeight: 600, color: x.c, fontFamily: 'IBM Plex Mono,monospace' }}>{x.v}</div>
                          <div style={{ fontSize: 9, color: '#4a5568', marginTop: 2, fontFamily: 'Inter,sans-serif' }}>{x.l}</div>
                        </div>
                      );
                    })}
                  </div>

                  <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                    {['BUY', 'SELL'].map(function (d) {
                      var s = track.byDirection[d];
                      return (
                        <div key={d} style={{ flex: 1, background: '#0b0e16', border: '1px solid #1e2840', borderRadius: 10, padding: '10px 12px' }}>
                          <div style={{ fontSize: 10, fontWeight: 600, color: d === 'BUY' ? '#10b981' : '#ef4444', fontFamily: 'IBM Plex Mono,monospace', marginBottom: 4 }}>{d}</div>
                          <div style={{ fontSize: 10, color: '#8899b4' }}>{s.trades ? (fmtRate(s.winRate) + ' win · ' + s.wins + 'W/' + s.losses + 'L · avg ' + fmtRet(s.avgReturn)) : 'no trades yet'}</div>
                        </div>
                      );
                    })}
                  </div>

                  {track.bySector.length > 0 && (
                    <div style={{ background: '#0b0e16', border: '1px solid #1e2840', borderRadius: 10, padding: '10px 12px', marginBottom: 12 }}>
                      <div style={{ fontSize: 10, fontWeight: 600, color: '#c8d4e8', marginBottom: 8, fontFamily: 'Inter,sans-serif' }}>By sector (confidence-ranked)</div>
                      {track.bySector.map(function (s) {
                        return (
                          <div key={s.sector} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid #0f1420' }}>
                            <span style={{ fontSize: 10, color: '#8899b4', fontFamily: 'Inter,sans-serif' }}>{s.sector}</span>
                            <span style={{ fontSize: 10, color: '#4a5568', fontFamily: 'IBM Plex Mono,monospace' }}>{fmtRate(s.winRate)} · {s.wins + 'W/' + s.losses + 'L'} · {fmtRet(s.avgReturn)}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  <div style={{ fontSize: 10, fontWeight: 600, color: '#c8d4e8', margin: '4px 0 8px', fontFamily: 'Inter,sans-serif' }}>Recent outcomes</div>
                  {track.recent.map(function (r, i) {
                    var win = r.outcome === 'WIN';
                    return (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 0', borderBottom: '1px solid #0f1420' }}>
                        <span style={{ fontSize: 9, fontWeight: 700, color: win ? '#10b981' : '#ef4444', background: (win ? '#10b981' : '#ef4444') + '22', padding: '1px 5px', borderRadius: 3, fontFamily: 'IBM Plex Mono,monospace', width: 34, textAlign: 'center' }}>{r.outcome}</span>
                        <span style={{ fontSize: 11, fontWeight: 600, color: '#e2e8f0', fontFamily: 'Inter,sans-serif', minWidth: 56 }}>{r.symbol}</span>
                        <span style={{ fontSize: 9, color: '#4a5568', fontFamily: 'IBM Plex Mono,monospace' }}>{r.signal}</span>
                        <span style={{ fontSize: 9, color: '#4a5568', fontFamily: 'IBM Plex Mono,monospace' }}>{(r.entry != null ? 'Rs' + r.entry : '-') + '→' + (r.exit != null ? 'Rs' + r.exit : '-')}</span>
                        <span style={{ marginLeft: 'auto', fontSize: 10, fontWeight: 600, color: (r.returnPct || 0) >= 0 ? '#10b981' : '#ef4444', fontFamily: 'IBM Plex Mono,monospace' }}>{r.returnPct != null ? fmtRet(r.returnPct) : '-'}</span>
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          )}

          {/* WATCHLIST */}
          {tab === 'watchlist' && (
            <div>
              <div style={{ fontSize: 11, color: '#e2e8f0', fontWeight: 600, marginBottom: 4 }}>Your watchlist</div>
              <div style={{ fontSize: 11, color: '#4a5568', marginBottom: 12, lineHeight: 1.7 }}>{'Agent scans all ' + watchlist.length + ' stocks + ' + settings.discovery_depth + ' auto-discovered per run. Edits here are picked up by the next server scan.'}</div>

              {/* failed / skipped jobs with retry */}
              {(failedJobs.length > 0 || skippedJobs.length > 0) && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
                  {failedJobs.map(function (j) {
                    return (
                      <div key={'f-' + j.symbol} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', background: '#0d1018', border: '1px solid #ef444433', borderRadius: 8 }}>
                        <span style={{ flexShrink: 0, background: '#ef4444', color: '#fff', fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4 }}>FAILED</span>
                        <strong style={{ flexShrink: 0, color: '#e2e8f0' }}>{j.symbol}</strong>
                        <span style={{ color: '#4a5568', fontSize: 11, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={j.message}>{j.message}{j.attempt > 1 ? ' (after ' + j.attempt + ' tries)' : ''}</span>
                        <button onClick={function () { retryStock(j.symbol); }} style={btn('#3b82f6', true)}>retry</button>
                      </div>
                    );
                  })}
                  {skippedJobs.map(function (j) {
                    return (
                      <div key={'s-' + j.symbol} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', background: '#0d1018', border: '1px solid #f59e0b33', borderRadius: 8 }}>
                        <span style={{ flexShrink: 0, background: '#f59e0b', color: '#1a1303', fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4 }}>SKIPPED</span>
                        <strong style={{ flexShrink: 0, color: '#e2e8f0' }}>{j.symbol}</strong>
                        <span style={{ color: '#4a5568', fontSize: 11, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={j.message}>{j.message}</span>
                        <button onClick={function () { retryStock(j.symbol); }} style={btn('#3b82f6', true)}>retry</button>
                      </div>
                    );
                  })}
                </div>
              )}

              {gated ? (
                <SignInPrompt title="Sign in to build your watchlist" sub="Track the symbols you care about — the agent scans your watchlist every run. Viewing signals and the track record stays free." onSignIn={auth.signIn} />
              ) : (
              <>
              <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                <input value={wlInput} onChange={function (e) { setWlInput(e.target.value.toUpperCase()); }} onKeyDown={function (e) { if (e.key === 'Enter') { addToWatchlist(wlInput, 'manual'); setWlInput(''); } }} placeholder="add symbol e.g. SANIMA, CHCL..." style={{ flex: 1 }} />
                <button onClick={function () { addToWatchlist(wlInput, 'manual'); setWlInput(''); }} style={{ padding: '8px 14px', borderRadius: 6, border: '1px solid #10b981', background: 'transparent', color: '#10b981', fontSize: 11, cursor: 'pointer', fontFamily: 'IBM Plex Mono,monospace', flexShrink: 0 }}>add</button>
              </div>
              {watchlist.length === 0 ? (
                <div style={{ fontSize: 11, color: '#4a5568', padding: '20px 0' }}>Watchlist empty. Add symbols above, or let the agent auto-promote discovered movers.</div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(150px,1fr))', gap: 6, marginBottom: 16 }}>
                  {watchlist.map(function (sym) {
                    var sig = signals.find(function (s) { return s.symbol === sym; });
                    var sc = sig ? (SIG_COLORS[sig.signal] || '#4a5568') : '#1c2333';
                    var src = wlSources[sym] || 'manual';
                    var srcColor = src === 'discovered' ? '#a78bfa' : src === 'holding' ? '#8b5cf6' : '#4a5568';
                    var lp = sig && sig.live ? sig.live.price : null;
                    return (
                      <div key={sym} style={{ background: '#0d1018', border: '1px solid ' + sc + '55', borderRadius: 6, padding: '8px 10px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 }}>
                          <span style={{ fontSize: 12, fontWeight: 600, color: '#e2e8f0', cursor: 'pointer' }} onClick={function () { openStock(sym); }}>{sym}</span>
                          <button onClick={function () { removeFromWatchlist(sym); }} style={{ fontSize: 9, color: '#4a5568', background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px' }}>x</button>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 3 }}>
                          <span style={{ fontSize: 8, color: srcColor }}>{src}</span>
                        </div>
                        {sig ? (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                            <span style={{ fontSize: 9, fontWeight: 700, color: sc, background: sc + '20', padding: '1px 5px', borderRadius: 2 }}>{sig.signal}</span>
                            {lp && <span style={{ fontSize: 9, color: '#4a5568' }}>{'Rs' + lp}</span>}
                          </div>
                        ) : <span style={{ fontSize: 9, color: '#4a5568' }}>{running && scanSym === sym ? 'scanning...' : 'pending'}</span>}
                      </div>
                    );
                  })}
                </div>
              )}
              </>
              )}
            </div>
          )}

          {/* SETTINGS */}
          {tab === 'settings' && (
            <div className="fadeup">
              <SectionHeader title="Agent Settings" sub="configure how the agent scans and discovers" />

              {/* Exchange */}
              <div style={{ background: '#0b0e16', border: '1px solid #1e2840', borderRadius: 12, padding: '16px 18px', marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
                  <div style={{ width: 28, height: 28, borderRadius: 8, background: '#3b82f618', border: '1px solid #3b82f633', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: '#3b82f6', fontFamily: 'IBM Plex Mono,monospace', fontWeight: 600 }}>ex</div>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#e2e8f0', fontFamily: 'Inter,sans-serif' }}>Stock Exchange</div>
                    <div style={{ fontSize: 10, color: '#4a5568' }}>Which market are you trading</div>
                  </div>
                </div>
                <div className="grid-stack-sm" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  {Object.keys(EXCHANGES).map(function (exId) {
                    var ex = EXCHANGES[exId]; var active = exchange === exId;
                    // Availability is server-gated (e.g. NYSE behind ENABLE_NYSE);
                    // an unavailable market is shown disabled with the reason.
                    var disabled = !exAvail[exId];
                    return (
                      <button key={exId} onClick={function () { if (!disabled) saveExchange(exId); }} disabled={disabled} style={{ padding: '12px 14px', borderRadius: 8, border: '1px solid ' + (active ? '#3b82f6' : '#1e2840'), background: active ? '#3b82f60e' : 'transparent', cursor: disabled ? 'not-allowed' : 'pointer', textAlign: 'left', opacity: disabled ? 0.6 : 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                          <div style={{ width: 8, height: 8, borderRadius: '50%', background: active ? '#3b82f6' : '#2a3550' }} />
                          <span style={{ fontSize: 12, fontWeight: active ? 600 : 400, color: active ? '#e2e8f0' : '#4a5568', fontFamily: 'Inter,sans-serif' }}>{ex.name}</span>
                        </div>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', paddingLeft: 16 }}>
                          <span style={{ fontSize: 9, color: active ? '#3b82f6' : '#2a3550', background: active ? '#3b82f615' : '#0f1420', padding: '2px 6px', borderRadius: 3, fontFamily: 'IBM Plex Mono,monospace' }}>{ex.currency}</span>
                          <span style={{ fontSize: 9, color: '#2a3550', fontFamily: 'IBM Plex Mono,monospace' }}>{ex.hours}</span>
                          <span style={{ fontSize: 9, color: '#2a3550', fontFamily: 'IBM Plex Mono,monospace' }}>{ex.source}</span>
                        </div>
                        {disabled && <div style={{ marginTop: 6, paddingLeft: 16, fontSize: 9, color: '#f59e0b', fontFamily: 'Inter,sans-serif' }}>not enabled on this deployment</div>}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Account / admin sign-in (only when Google auth is configured) */}
              <AuthPanel auth={auth} />

              {/* Admin-only config surfaces — hidden for non-admins; the server
                  still enforces the boundary on the actual mutations. */}
              {auth.isAdmin && (
                <>
                  {/* Data Sources */}
                  <AdminDataSources />

                  {/* Notifications */}
                  <AdminChannels />
                </>
              )}

              {/* Agent/discovery config — shapes the ONE global scan, so ADMIN-only
                  (hidden for regular users; server-enforced on /api/admin/settings).
                  A regular user's Settings = Exchange + Account above. */}
              {auth.isAdmin && (
              <>
              {/* Discovery */}
              <div style={{ background: '#0b0e16', border: '1px solid #1e2840', borderRadius: 12, padding: '16px 18px', marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
                  <div style={{ width: 28, height: 28, borderRadius: 8, background: '#10b98118', border: '1px solid #10b98133', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14 }}>@</div>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#e2e8f0', fontFamily: 'Inter,sans-serif' }}>Auto-Discovery</div>
                    <div style={{ fontSize: 10, color: '#4a5568' }}>Scans NEPSE market movers, finds best signals</div>
                  </div>
                  <div style={{ marginLeft: 'auto' }}>
                    <ToggleBtn on={settings.discovery_on} onClick={function () { saveSettings(Object.assign({}, settings, { discovery_on: !settings.discovery_on })); }} />
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 0', borderBottom: '1px solid #0f1420' }}>
                  <div>
                    <div style={{ fontSize: 11, color: '#c8d4e8', fontFamily: 'Inter,sans-serif' }}>Discovery depth</div>
                    <div style={{ fontSize: 10, color: '#4a5568', marginTop: 2 }}>Stocks to deep-scan from market movers each run</div>
                  </div>
                  <SegBtn value={settings.discovery_depth} options={[5, 8, 12]} onChange={function (n) { saveSettings(Object.assign({}, settings, { discovery_depth: n })); }} />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 0' }}>
                  <div>
                    <div style={{ fontSize: 11, color: '#c8d4e8', fontFamily: 'Inter,sans-serif' }}>Auto-add threshold</div>
                    <div style={{ fontSize: 10, color: '#4a5568', marginTop: 2 }}>Which signal strength triggers auto-add to watchlist</div>
                  </div>
                  <SegBtn value={settings.autoadd_threshold} options={[['BUY', 'BUY only'], ['BUY_WATCH', 'BUY + WATCH']]} onChange={function (v) { saveSettings(Object.assign({}, settings, { autoadd_threshold: v })); }} />
                </div>
              </div>

              {/* Auto-remove */}
              <div style={{ background: '#0b0e16', border: '1px solid #1e2840', borderRadius: 12, padding: '16px 18px', marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
                  <div style={{ width: 28, height: 28, borderRadius: 8, background: '#ef444418', border: '1px solid #ef444433', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14 }}>-</div>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#e2e8f0', fontFamily: 'Inter,sans-serif' }}>Auto-Remove</div>
                    <div style={{ fontSize: 10, color: '#4a5568' }}>Removes stale stocks from watchlist automatically</div>
                  </div>
                  <div style={{ marginLeft: 'auto' }}>
                    <ToggleBtn on={settings.autoremove_on} onClick={function () { saveSettings(Object.assign({}, settings, { autoremove_on: !settings.autoremove_on })); }} />
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 0' }}>
                  <div>
                    <div style={{ fontSize: 11, color: '#c8d4e8', fontFamily: 'Inter,sans-serif' }}>Remove after N stale scans</div>
                    <div style={{ fontSize: 10, color: '#4a5568', marginTop: 2 }}>Consecutive NEUTRAL or AVOID before stock is dropped</div>
                  </div>
                  <SegBtn value={settings.autoremove_after} options={[2, 3, 5]} onChange={function (n) { saveSettings(Object.assign({}, settings, { autoremove_after: n })); }} />
                </div>
              </div>

              {/* Sector focus */}
              <div style={{ background: '#0b0e16', border: '1px solid #1e2840', borderRadius: 12, padding: '16px 18px', marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <div style={{ width: 28, height: 28, borderRadius: 8, background: '#a78bfa18', border: '1px solid #a78bfa33', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14 }}>#</div>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#e2e8f0', fontFamily: 'Inter,sans-serif' }}>Sector Focus</div>
                    <div style={{ fontSize: 10, color: '#4a5568' }}>Discovery prioritises enabled sectors. All on = no bias.</div>
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(148px,1fr))', gap: 8, marginTop: 12 }}>
                  {SECTORS.map(function (s) {
                    var on = settings.sector_focus[s];
                    return (
                      <button key={s} onClick={function () { var sf = Object.assign({}, settings.sector_focus); sf[s] = !sf[s]; saveSettings(Object.assign({}, settings, { sector_focus: sf })); }} style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid ' + (on ? '#3b82f655' : '#1e2840'), background: on ? '#3b82f60e' : 'transparent', color: on ? '#3b82f6' : '#4a5568', cursor: 'pointer', textAlign: 'left' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                          <div style={{ width: 6, height: 6, borderRadius: '50%', background: on ? '#3b82f6' : '#2a3550' }} />
                          <span style={{ fontSize: 11, fontWeight: on ? 600 : 400, fontFamily: 'Inter,sans-serif' }}>{SECTOR_LABELS[s]}</span>
                        </div>
                        <div style={{ fontSize: 9, color: on ? '#3b82f688' : '#2a3550', marginLeft: 12 }}>{on ? 'included in discovery' : 'excluded'}</div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Scan profile summary */}
              <div style={{ background: 'linear-gradient(135deg,#0b0e16 0%,#0d1220 100%)', border: '1px solid #1e2840', borderRadius: 12, padding: '16px 18px' }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#e2e8f0', fontFamily: 'Inter,sans-serif', marginBottom: 12 }}>Current scan profile</div>
                <div className="grid-2-sm" style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8, marginBottom: 14 }}>
                  {[['Watchlist stocks', watchlist.length, '#c8d4e8'], ['+ Discovered', settings.discovery_depth, '#a78bfa'], ['Total scanned', watchlist.length + settings.discovery_depth, '#10b981']].map(function (item) {
                    return (
                      <div key={item[0]} style={{ background: '#07090e', borderRadius: 8, padding: '10px 12px', border: '1px solid #141824' }}>
                        <div style={{ fontSize: 18, fontWeight: 700, color: item[2], fontFamily: 'IBM Plex Mono,monospace', marginBottom: 3 }}>{item[1]}</div>
                        <div style={{ fontSize: 9, color: '#4a5568' }}>{item[0]}</div>
                      </div>
                    );
                  })}
                </div>
                <div style={{ background: '#07090e', borderRadius: 8, padding: '10px 14px', border: '1px solid #141824', fontSize: 10, color: '#4a5568', lineHeight: 1.9 }}>
                  Scans now run server-side (cron + manual). The agent fetches the market, discovers movers, scans each stock, then writes a brief — crash-safe and within the daily AI budget.
                </div>
              </div>
              </>
              )}
            </div>
          )}
        </div>

        {/* ASK SIDEBAR */}
        {sidebarOpen && (
          <div style={isMobile
            ? { position: 'fixed', inset: 0, zIndex: 300, display: 'flex', flexDirection: 'column', background: '#07090e', paddingBottom: 'env(safe-area-inset-bottom)' }
            : { width: 300, borderLeft: '1px solid #141824', display: 'flex', flexDirection: 'column', background: '#07090e', flexShrink: 0 }}>
            <div style={{ padding: '12px 14px', borderBottom: '1px solid #141824', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <div style={{ width: 5, height: 5, borderRadius: '50%', background: '#3b82f6' }} />
                <span style={{ fontSize: 12, fontWeight: 500, color: '#e2e8f0', fontFamily: 'Inter,sans-serif' }}>Ask agent</span>
              </div>
              <button onClick={function () { setSidebarOpen(false); }} style={{ padding: '2px 8px', borderRadius: 5, border: '1px solid #1e2840', background: 'transparent', color: '#4a5568', fontSize: 10, cursor: 'pointer', fontFamily: 'Inter,sans-serif' }}>close</button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '10px 12px' }}>
              {chat.length === 0 && (
                <div>
                  <div style={{ fontSize: 10, color: '#4a5568', marginBottom: 10, lineHeight: 1.6, fontFamily: 'Inter,sans-serif' }}>Ask anything about your portfolio or the market. I fetch live data when needed.</div>
                  {['NABIL current price?', 'Which positions at risk?', 'Should I act on GBIME?', 'What sectors look strong?'].map(function (q) {
                    return <button key={q} onClick={function () { sendChat(q); }} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '7px 10px', marginBottom: 4, background: '#0b0e16', border: '1px solid #1e2840', borderRadius: 6, color: '#4a5568', fontSize: 10, cursor: 'pointer', fontFamily: 'IBM Plex Mono,monospace', lineHeight: 1.4 }}>{q}</button>;
                  })}
                </div>
              )}
              {chat.map(function (m, i) {
                var isU = m.role === 'user';
                return (
                  <div key={i} style={{ marginBottom: 8, display: 'flex', flexDirection: 'column', alignItems: isU ? 'flex-end' : 'flex-start' }}>
                    <div style={{ maxWidth: '92%', padding: '8px 10px', borderRadius: isU ? '8px 8px 2px 8px' : '2px 8px 8px 8px', background: isU ? '#152515' : '#0b0e16', border: '1px solid ' + (isU ? '#10b98122' : '#1e2840'), fontSize: 11, lineHeight: 1.6, color: isU ? '#6ee7b7' : '#8899b4', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'Inter,sans-serif' }}>
                      {m.content}
                    </div>
                    <div style={{ fontSize: 9, color: '#1e2840', marginTop: 2, fontFamily: 'IBM Plex Mono,monospace' }}>{timeAgo(m.ts)}</div>
                  </div>
                );
              })}
              {chatLoading && (
                <div style={{ display: 'flex', gap: 4, padding: '8px 10px', background: '#0b0e16', border: '1px solid #1e2840', borderRadius: '2px 8px 8px 8px', width: 'fit-content', alignItems: 'center' }}>
                  <div style={{ width: 4, height: 4, borderRadius: '50%', background: '#3b82f6', animation: '_pulse 1.2s ease 0s infinite' }} />
                  <div style={{ width: 4, height: 4, borderRadius: '50%', background: '#3b82f6', animation: '_pulse 1.2s ease .2s infinite' }} />
                  <div style={{ width: 4, height: 4, borderRadius: '50%', background: '#3b82f6', animation: '_pulse 1.2s ease .4s infinite' }} />
                </div>
              )}
              <div ref={sidebarEnd} />
            </div>
            <div style={{ padding: '10px 12px', borderTop: '1px solid #141824', flexShrink: 0 }}>
              <div style={{ display: 'flex', gap: 6 }}>
                <input value={chatInput} onChange={function (e) { setChatInput(e.target.value); }} onKeyDown={function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(''); } }} placeholder="ask anything..." style={{ flex: 1, fontSize: 11, padding: '7px 10px', borderRadius: 7, minHeight: 36 }} />
                <button onClick={function () { sendChat(''); }} disabled={chatLoading || !chatInput.trim()} style={{ width: 34, height: 34, borderRadius: 7, border: 'none', background: chatInput.trim() ? '#3b82f6' : '#1e2840', color: chatInput.trim() ? '#fff' : '#2a3550', fontSize: 13, flexShrink: 0, cursor: 'pointer' }}>{'up'}</button>
              </div>
            </div>
          </div>
        )}

      </div>{/* end main layout */}

      {/* STOCK OVERLAY */}
      {ovSym && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(8,10,15,.95)', zIndex: 200, overflowY: 'auto', padding: 16 }}>
          <div style={{ maxWidth: 680, margin: '0 auto' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
              <span style={{ fontSize: 18, fontWeight: 600, color: '#e2e8f0' }}>{ovSym}</span>
              {ovSig && <span style={{ fontSize: 10, fontWeight: 700, color: SIG_COLORS[ovSig.signal] || '#4a5568', background: (SIG_COLORS[ovSig.signal] || '#4a5568') + '20', padding: '2px 8px', borderRadius: 3 }}>{ovSig.signal}</span>}
              {ovLoading && <span style={{ fontSize: 10, color: '#4a5568' }}>loading...</span>}
              <button onClick={function () { setOvSym(null); }} style={{ marginLeft: 'auto', padding: '5px 12px', borderRadius: 5, border: '1px solid #1c2333', background: 'none', color: '#4a5568', fontSize: 11, cursor: 'pointer', fontFamily: 'IBM Plex Mono,monospace' }}>close</button>
            </div>
            {ovData && ovData.price && (
              <div style={card('#10b981')}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 10, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 22, fontWeight: 600, color: '#e2e8f0' }}>{'Rs ' + ovData.price}</span>
                  <span style={{ fontSize: 12, color: ovData.change_pct >= 0 ? '#10b981' : '#ef4444' }}>{toPct(ovData.change_pct)}</span>
                  <span style={{ fontSize: 8, color: '#10b981', background: '#10b98118', padding: '1px 5px', borderRadius: 2, marginLeft: 'auto' }}>LIVE - merolagani.com</span>
                </div>
                <div className="metrics-tight" style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 5, marginBottom: 10 }}>
                  {[['52w H', 'Rs ' + ovData.week52_high], ['52w L', 'Rs ' + ovData.week52_low], ['120d', 'Rs ' + ovData.avg120], ['EPS', '' + ovData.eps], ['P/E', '' + ovData.pe], ['BV', 'Rs ' + ovData.bv], ['PBV', '' + ovData.pbv], ['Div', ovData.div_pct + '%'], ['Yield', ovData.yield + '%'], ['Vol', '' + ovData.volume]].map(function (item) { return <div key={item[0]} style={{ background: '#080a0f', borderRadius: 4, padding: '4px 7px' }}><div style={{ fontSize: 8, color: '#1c2333', marginBottom: 2 }}>{item[0]}</div><div style={{ fontSize: 11, fontWeight: 500, color: '#c8d4e8' }}>{item[1] || '-'}</div></div>; })}
                </div>
                {ovData.week52_low && ovData.week52_high && (function () {
                  var pos = Math.min(100, Math.max(0, ((ovData.price - ovData.week52_low) / (ovData.week52_high - ovData.week52_low)) * 100));
                  var bc = pos > 75 ? '#f59e0b' : pos < 25 ? '#3b82f6' : '#10b981';
                  return <div><div style={{ fontSize: 9, color: '#4a5568', marginBottom: 3 }}>{'52-week range - ' + Math.round(pos) + '% of range'}</div><div style={{ height: 4, background: '#1c2333', borderRadius: 2, overflow: 'hidden' }}><div style={{ height: '100%', width: '' + pos + '%', background: bc, borderRadius: 2 }} /></div><div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 8, color: '#1c2333', marginTop: 2 }}><span>{'Rs ' + ovData.week52_low}</span><span>{'Rs ' + ovData.week52_high}</span></div></div>;
                })()}
                {ovData.news && ovData.news.length > 0 && <div style={{ marginTop: 8 }}>{ovData.news.slice(0, 3).map(function (n, i) { return <div key={i} style={{ fontSize: 10, color: '#4a5568', padding: '3px 0', borderTop: i > 0 ? '1px solid #1c2333' : 'none', lineHeight: 1.5, fontFamily: 'IBM Plex Sans,sans-serif' }}>{n}</div>; })}</div>}
              </div>
            )}
            {!ovData && ovLoading && <div style={card()}>{ghost()}{ghost()}{ghost()}</div>}
            {ovAnalysis ? <div style={{ background: '#0d1018', border: '1px solid #1c2333', borderRadius: 8, padding: '12px 14px', marginBottom: 10, lineHeight: 1.8, fontSize: 12, color: '#8899b4', whiteSpace: 'pre-wrap', fontFamily: 'IBM Plex Sans,sans-serif' }}>{ovAnalysis}</div> : ovLoading && <div style={card()}>{ghost()}{ghost()}{ghost()}{ghost()}</div>}
            {ovSig && (
              <div style={card(SIG_COLORS[ovSig.signal] || '#4a5568')}>
                <div className="metrics-tight" style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 5, marginBottom: 8 }}>
                  {sbox('signal', ovSig.signal, SIG_COLORS[ovSig.signal])}{sbox('conf', ovSig.confidence, ovSig.confidence === 'HIGH' ? '#10b981' : ovSig.confidence === 'MEDIUM' ? '#f59e0b' : '#4a5568')}{sbox('entry', ovSig.entry || '-')}{sbox('stop loss', ovSig.sl ? 'Rs ' + ovSig.sl : '-', '#ef4444')}{sbox('target', ovSig.target ? 'Rs ' + ovSig.target : '-', '#10b981')}
                </div>
                {ovSig.why && <div style={{ fontSize: 11, color: '#8899b4', lineHeight: 1.7, marginBottom: 8, padding: '7px 10px', background: '#080a0f', borderRadius: 4, fontFamily: 'IBM Plex Sans,sans-serif' }}>{ovSig.why}</div>}
                {ovSig.signal === 'BUY' && <button onClick={function () { if (gated) { showToast('Sign in with Google to save positions', 'err'); setOvSym(null); setTab('settings'); return; } setOvSym(null); setBuyTarget(ovSig.id); setBuyQty(''); setBuySL(ovSig.sl ? String(ovSig.sl) : ''); setBuyReason(ovSig.why || ''); setTab('signals'); }} style={btn('#10b981')}>{'log buy for ' + ovSym}</button>}
              </div>
            )}
            {watchlist.indexOf(ovSym) < 0 && <button onClick={function () { addToWatchlist(ovSym, 'manual'); showToast(ovSym + ' added to watchlist'); }} style={{ marginTop: 8, padding: '5px 12px', borderRadius: 7, border: '1px solid #a78bfa', background: 'transparent', color: '#a78bfa', fontSize: 11, cursor: 'pointer', fontFamily: 'IBM Plex Mono,monospace' }}>{'+ add ' + ovSym + ' to watchlist'}</button>}
          </div>
        </div>
      )}
    </div>
  );
}

// Logged-out affordance for the per-user tabs (watchlist / positions). Friendly CTA,
// never an error or a blank — viewing is free; sign-in is to SAVE your own data.
function SignInPrompt(props) {
  return (
    <div style={{ background: '#0b0e16', border: '1px solid #1e2840', borderRadius: 12, padding: '28px 20px', textAlign: 'center', marginTop: 8 }}>
      <div style={{ fontSize: 13, color: '#e2e8f0', fontFamily: 'Inter,sans-serif', fontWeight: 600, marginBottom: 5 }}>{props.title}</div>
      <div style={{ fontSize: 11, color: '#4a5568', marginBottom: 16, lineHeight: 1.6, maxWidth: 320, marginLeft: 'auto', marginRight: 'auto' }}>{props.sub}</div>
      <button onClick={props.onSignIn} style={{ fontSize: 12, fontWeight: 600, color: '#e2e8f0', background: '#3b82f615', border: '1px solid #3b82f6', borderRadius: 8, padding: '9px 18px', cursor: 'pointer', fontFamily: 'Inter,sans-serif' }}>Sign in with Google to save</button>
    </div>
  );
}

// Shared buy form (used in Today + Signals tabs).
function BuyForm(props) {
  var s = props.s;
  return (
    <div style={{ background: '#080a0f', borderRadius: 6, padding: 10, border: '1px solid #1c2333' }}>
      <div className="grid-stack-sm" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
        <div><div style={{ fontSize: 9, color: '#4a5568', marginBottom: 3 }}>quantity</div><input value={props.buyQty} onChange={function (e) { props.setBuyQty(e.target.value); }} type="number" placeholder="units" /></div>
        <div><div style={{ fontSize: 9, color: '#4a5568', marginBottom: 3 }}>stop loss</div><input value={props.buySL} onChange={function (e) { props.setBuySL(e.target.value); }} type="number" placeholder={s.sl ? 'Rs ' + s.sl : ''} /></div>
      </div>
      <div style={{ marginBottom: 8 }}><div style={{ fontSize: 9, color: '#4a5568', marginBottom: 3 }}>why? <span style={{ color: '#ef4444' }}>required</span></div><input value={props.buyReason} onChange={function (e) { props.setBuyReason(e.target.value); }} placeholder="your reason" /></div>
      {props.buyQty && s.price && <BuyChargePreview qty={props.buyQty} price={s.price} />}
      <div style={{ display: 'flex', gap: 6 }}>
        <button onClick={props.onConfirm} style={{ flex: 1, padding: '7px', borderRadius: 6, border: '1px solid #10b981', background: 'transparent', color: '#10b981', fontSize: 11, cursor: 'pointer', fontFamily: 'IBM Plex Mono,monospace' }}>confirm buy</button>
        <button onClick={props.onCancel} style={btn()}>cancel</button>
      </div>
    </div>
  );
}

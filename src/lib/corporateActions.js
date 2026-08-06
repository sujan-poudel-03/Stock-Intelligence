// Deterministic, LLM-FREE corporate-action awareness (bonus/rights/split/dividend).
//
// WHY THIS EXISTS (TIER-1 #1): on a NEPSE ex-date a price drops MECHANICALLY (a 20%
// bonus knocks ~16.7% off; a cash dividend knocks the per-share amount off). Without
// this, the spot-price outcome resolver records a FALSE LOSS, and the plausibility
// guard (marketData.sanityCheck, NEPSE ceiling ~12%) REJECTS the legit post-ex quote.
// Both corrupt outcomes → weights → knowledge → the public track record.
//
// GROUND-TRUTH RULE (CLAUDE.md guardrail #1): ex-dates + ratios are ground truth,
// NEVER LLM-sourced — a wrong ex-date is direct financial harm. Everything here is a
// deterministic scrape/parse. It FAILS CLOSED: no clean data → we do NOT adjust and
// do NOT record a wrong LOSS; the resolver leaves the signal PENDING (and eventually
// VOIDs it), rather than resolving on a corrupted comparison.
//
// SOURCE STRUCTURE (real, inspected 2026-08): merolagani's announcement LIST/SUMMARY
// pages (AnnouncementList.aspx / AnnouncementSummary.aspx?actType=…) are FREE-TEXT
// prose — no structured symbol/book-closure/ratio columns. The structured fields live
// on the per-announcement DETAIL page (AnnouncementDetail.aspx?id=N), which carries a
// clean label→value table:
//     Symbol            → <input value="NORVIC" id="StockSymbol"/> + CompanyDetail link
//     Bookclose Date    → "2026/08/16 AD (2083/4/31 BS)"
//     % Cash Dividend   → "22.11"
//     % Bonus Share     → "20"
//     Right Share Ratio → "10:1"  (base:new)
// So parseAnnouncements() parses a DETAIL page (not the list); the crawl enumerates
// detail ids from the list pages first. (DEVIATION from the task's "parse the list
// pages" wording — see the senior-engineer report. The list pages don't carry the
// structured data.) merolagani populates these fields INCONSISTENTLY (many recent
// notices leave them blank); a blank field simply yields no CA → fail-closed PENDING,
// never a false loss.
//
// BOOK-CLOSURE ↔ EX-DATE CAVEAT: merolagani publishes the BOOK-CLOSURE date, not
// always an explicit ex-date. On NEPSE the mechanical price drop happens on/around
// the ex-date, which sits at or a trading day before book closure (exact timing
// depends on settlement). To avoid off-by-one FALSE resolutions we never key on a
// single day — we derive a conservative ex-WINDOW band around book closure
// (deriveExWindow) and treat any signal whose life overlaps that band as CA-affected.
//
// Same best-effort, never-throw discipline as merolaganiFundamentals.js /
// marketProviders.fetchMerolagani: a layout change degrades to "no CA data", it never
// breaks a scan or an outcome loop.
//
// ToS: like the price scraper, commercial scraping of merolagani is pending the P3-1
// legal review; this is the interim source.

import { normalizeExchange, DEFAULT_EXCHANGE } from './exchanges.js';

// NEPSE shares have a Rs 100 par value; a cash-dividend % is quoted on par, so a
// 22.11% cash dividend = Rs 22.11 per share deducted on the ex-date.
const PAR_VALUE = 100;

// Conservative ex-window band around the book-closure date (calendar days). Wider
// than a single day precisely because book-closure ≠ ex-date (see caveat above) — the
// cost of a slightly-too-wide window is only "suppress a bit early/late" (safe:
// PENDING), whereas a too-narrow window risks the false LOSS we are preventing.
export const EX_WINDOW_BEFORE_DAYS = 2;
export const EX_WINDOW_AFTER_DAYS = 3;

// Announcement types we crawl on merolagani (AnnouncementSummary.aspx?actType=…).
const ANNOUNCEMENT_ACT_TYPES = ['Bonus', 'Rights', 'Dividend'];
// Cap the per-refresh detail-page crawl so this best-effort side-channel can never
// blow the function budget. It runs in the brief's background block; if the crawl
// grows it can graduate to its own chained worker (see brief route note).
const MAX_DETAIL_FETCHES = 40;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

// ---------------------------------------------------------------------------
// PARSING (pure, never throws)
// ---------------------------------------------------------------------------

// parseAnnouncements(html): parse ONE merolagani AnnouncementDetail page into 0..N
// corporate-action objects. A single announcement can carry BOTH a cash dividend AND
// a bonus → two objects (distinct action_type), matching the DB unique key. PURE;
// returns [] on any failure or when no symbol/action is present.
export function parseAnnouncements(html) {
  try {
    if (!html || typeof html !== 'string') return [];

    const symbol = extractSymbol(html);
    if (!symbol) return [];

    const bookClosure = parseAdDate(labelValue(html, 'Bookclose Date'));
    const source = 'merolagani';
    const out = [];

    const bonus = toNum(labelValue(html, '% Bonus Share'));
    if (bonus != null && bonus > 0) {
      out.push({
        symbol,
        action_type: 'BONUS',
        bonus_pct: bonus,
        book_closure_date: bookClosure,
        source,
      });
    }

    const cashDiv = toNum(labelValue(html, '% Cash Dividend'));
    if (cashDiv != null && cashDiv > 0) {
      out.push({
        symbol,
        action_type: 'CASH_DIV',
        dividend_pct: cashDiv,
        book_closure_date: bookClosure,
        source,
      });
    }

    const ratio = normalizeRatio(labelValue(html, 'Right Share Ratio'));
    if (ratio) {
      out.push({
        symbol,
        action_type: 'RIGHTS',
        rights_ratio: ratio,
        book_closure_date: bookClosure,
        source,
      });
    }

    return out;
  } catch {
    return [];
  }
}

// parseAnnouncementIds(listHtml): pull the AnnouncementDetail ids out of a LIST or
// SUMMARY page (they carry only headlines + detail links). Pure; deduped; [] on junk.
export function parseAnnouncementIds(listHtml) {
  try {
    if (!listHtml || typeof listHtml !== 'string') return [];
    const ids = new Set();
    const re = /AnnouncementDetail\.aspx\?id=(\d+)/gi;
    let m;
    while ((m = re.exec(listHtml)) !== null) ids.add(m[1]);
    return [...ids];
  } catch {
    return [];
  }
}

// extractSymbol(html): the ticker from the detail page's hidden input or the company
// link. Both orderings tolerated. Pure.
function extractSymbol(html) {
  const a = html.match(/id=["']StockSymbol["'][^>]*value=["']([A-Z0-9]+)["']/i);
  if (a) return a[1].toUpperCase();
  const b = html.match(/value=["']([A-Z0-9]+)["'][^>]*id=["']StockSymbol["']/i);
  if (b) return b[1].toUpperCase();
  const c = html.match(/CompanyDetail\.aspx\?symbol=([A-Z0-9]+)/i);
  return c ? c[1].toUpperCase() : null;
}

// labelValue(html, label): the <td> value following a "<strong>LABEL</strong></td><td>…</td>"
// row in the detail table. Value may be on the same line or wrapped. Pure; null if absent.
function labelValue(html, label) {
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${esc}<\\/strong>\\s*<\\/td>\\s*<td>\\s*([^<]*?)\\s*<\\/td>`, 'i');
  const m = html.match(re);
  if (!m) return null;
  const v = m[1].replace(/\s+/g, ' ').trim();
  return v || null;
}

// parseAdDate("2026/08/16 AD (2083/4/31 BS)") → "2026-08-16" (the Gregorian/AD date).
// Pure; null when no AD date is present. We deliberately IGNORE the Bikram-Sambat date.
function parseAdDate(s) {
  if (!s || typeof s !== 'string') return null;
  const m = s.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})\s*AD/i);
  if (!m) return null;
  const [, y, mo, d] = m;
  const iso = `${y}-${pad2(mo)}-${pad2(d)}`;
  // Validate it's a real calendar date before trusting it.
  const t = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(t) ? iso : null;
}

// normalizeRatio("10:1") → "10:1" (only accept a clean base:new form). Pure; null otherwise.
function normalizeRatio(s) {
  if (!s || typeof s !== 'string') return null;
  const m = s.match(/(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)/);
  return m ? `${m[1]}:${m[2]}` : null;
}

// ---------------------------------------------------------------------------
// MONEY-CRITICAL MATH (pure, unit-tested)
// ---------------------------------------------------------------------------

// computeAdjustment(action): the multiplicative factor + additive per-share deduction
// that map a PRE-ex price to its POST-ex equivalent, so adjusted = price*factor - deduction.
// PURE. Returns { factor, deduction } | null. null means "known CA but uncomputable"
// → the caller SUPPRESSES (never resolves a LOSS) rather than guessing.
export function computeAdjustment(action) {
  try {
    if (!action || typeof action !== 'object') return null;
    const type = String(action.action_type || '').toUpperCase();

    if (type === 'BONUS' || type === 'STOCK_DIV') {
      const pct = toNum(action.bonus_pct);
      if (pct == null || pct <= -100) return null;
      // N new shares per 100 held → each old share is worth 1/(1+pct/100) post-ex.
      return { factor: 1 / (1 + pct / 100), deduction: 0 };
    }

    if (type === 'SPLIT') {
      const ratio = toNum(action.split_ratio ?? action.ratio);
      if (ratio == null || ratio <= 0) return null;
      return { factor: 1 / ratio, deduction: 0 };
    }

    if (type === 'RIGHTS') {
      // Theoretical ex-rights price = (mkt*base + rights_price*new)/(base+new). This
      // needs BOTH the rights_price (subscription price) AND a market reference — the
      // factor is price-relative, unlike bonus/split. merolagani almost never publishes
      // rights_price, so in practice this returns null → suppress/void (fail-closed).
      const rp = toNum(action.rights_price);
      const mkt = toNum(action.mkt ?? action.price);
      const parts = parseRatio(action.rights_ratio);
      if (rp == null || mkt == null || mkt <= 0 || !parts) return null;
      const { base, extra } = parts;
      const ex = (mkt * base + rp * extra) / (base + extra);
      if (!Number.isFinite(ex) || ex <= 0) return null;
      return { factor: ex / mkt, deduction: 0 };
    }

    if (type === 'CASH_DIV') {
      const pct = toNum(action.dividend_pct);
      if (pct == null || pct <= 0) return null;
      // % on Rs 100 par → per-share cash amount deducted on the ex-date.
      return { factor: 1, deduction: (pct * PAR_VALUE) / 100 };
    }

    return null;
  } catch {
    return null;
  }
}

// applyAdjustment({ target, sl, price }, { factor, deduction }): map each level to its
// post-ex equivalent. PURE. Null/non-finite levels pass through unchanged.
export function applyAdjustment(levels, adj) {
  const factor = Number.isFinite(Number(adj?.factor)) ? Number(adj.factor) : 1;
  const deduction = Number.isFinite(Number(adj?.deduction)) ? Number(adj.deduction) : 0;
  const one = (v) => {
    const n = toNum(v);
    return n == null ? (v == null ? null : v) : n * factor - deduction;
  };
  return {
    target: one(levels?.target),
    sl: one(levels?.sl),
    price: one(levels?.price),
  };
}

// deriveExWindow(action): map a CA's book-closure (or explicit ex-date) to a
// conservative [ex_start, ex_end] ISO-date band. PURE. Returns null when there is no
// dateable anchor (→ the CA can't be windowed and never suppresses a resolution).
export function deriveExWindow(action) {
  const anchor = action?.ex_date || action?.book_closure_date;
  if (!anchor) return null;
  const base = Date.parse(`${String(anchor).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(base)) return null;
  const DAY = 86400000;
  return {
    ex_start: toIsoDate(base - EX_WINDOW_BEFORE_DAYS * DAY),
    ex_end: toIsoDate(base + EX_WINDOW_AFTER_DAYS * DAY),
  };
}

// getActiveAdjustment(supabase, symbol, exchange, sinceISO, asOfISO): cumulative
// adjustment from every stored CA whose ex-window overlaps the interval (since, asOf].
// Multiplicative factors compound; deductions sum (per the strategy). computable=false
// when ANY in-window CA has a null factor (e.g. a rights issue with no price) → the
// caller SUPPRESSES. Best-effort: NEVER throws; a read failure returns the NEUTRAL
// identity so a storage blip degrades to "no adjustment", exactly like today.
export async function getActiveAdjustment(supabase, symbol, exchange, sinceISO, asOfISO) {
  const neutral = { factor: 1, deduction: 0, computable: true, actions: [] };
  try {
    if (!supabase || !symbol) return neutral;
    const ex = normalizeExchange(exchange);
    const { data, error } = await supabase
      .from('corporate_actions')
      .select('symbol, exchange, action_type, factor, deduction, ex_date, book_closure_date')
      .eq('symbol', String(symbol).toUpperCase())
      .eq('exchange', ex);
    if (error || !Array.isArray(data)) return neutral;

    const sinceT = toTime(sinceISO);
    const asOfT = toTime(asOfISO) ?? Date.now();

    let factor = 1;
    let deduction = 0;
    let computable = true;
    const actions = [];

    for (const row of data) {
      const win = deriveExWindow(row);
      if (!win) continue; // undateable CA can't be windowed → cannot cause a false loss
      const startT = toTime(win.ex_start);
      const endT = toTime(win.ex_end);
      if (startT == null || endT == null) continue;
      // Overlap of [ex_start, ex_end] with (since, asOf]: window must start on/before
      // asOf and end on/after since. (sinceT null = "no lower bound".)
      const overlaps = startT <= asOfT && (sinceT == null || endT >= sinceT);
      if (!overlaps) continue;

      actions.push({
        action_type: row.action_type,
        book_closure_date: row.book_closure_date,
        ex_date: row.ex_date,
      });
      const f = toNum(row.factor);
      const d = toNum(row.deduction);
      if (f == null) {
        computable = false; // known CA, no trustworthy factor → suppress
      } else {
        factor *= f;
      }
      if (d != null) deduction += d;
    }

    return { factor, deduction, computable, actions };
  } catch {
    return neutral;
  }
}

// ---------------------------------------------------------------------------
// NETWORK / PERSISTENCE (best-effort, never throws)
// ---------------------------------------------------------------------------

// fetchCorporateActions(): crawl merolagani's announcement summary pages for detail
// ids, then fetch + parse each detail page into corporate-action objects. Best-effort,
// mirrors fetchMerolagani — any network/layout failure returns [] (never throws).
export async function fetchCorporateActions() {
  try {
    const ids = new Set();
    for (const actType of ANNOUNCEMENT_ACT_TYPES) {
      try {
        const res = await fetch(
          `https://merolagani.com/AnnouncementSummary.aspx?actType=${encodeURIComponent(actType)}`,
          { headers: { 'User-Agent': UA }, cache: 'no-store' }
        );
        if (!res.ok) continue;
        const html = await res.text();
        for (const id of parseAnnouncementIds(html)) ids.add(id);
      } catch {
        /* one summary page failing must not abort the crawl */
      }
    }

    const list = [...ids].slice(0, MAX_DETAIL_FETCHES);
    const actions = [];
    for (const id of list) {
      try {
        const res = await fetch(`https://merolagani.com/AnnouncementDetail.aspx?id=${encodeURIComponent(id)}`, {
          headers: { 'User-Agent': UA },
          cache: 'no-store',
        });
        if (!res.ok) continue;
        const html = await res.text();
        for (const a of parseAnnouncements(html)) actions.push(a);
      } catch {
        /* one detail page failing must not abort the crawl */
      }
    }
    return actions;
  } catch {
    return [];
  }
}

// refreshCorporateActions(supabase): fetch → parse → compute → upsert into the global
// corporate_actions table (service client — RLS write path). Best-effort; NEVER throws
// into the scan/outcome flow. Recomputes factor/deduction from data every run (no
// applied-flag), so re-running is idempotent on the (symbol, exchange, action_type,
// book_closure_date) key.
export async function refreshCorporateActions(supabase) {
  try {
    if (!supabase) return { upserted: 0 };
    const actions = await fetchCorporateActions();
    if (!actions.length) return { upserted: 0 };

    const nowIso = new Date().toISOString();
    let upserted = 0;
    for (const a of actions) {
      try {
        if (!a.book_closure_date) continue; // undateable → can't window → skip persisting
        const adj = computeAdjustment(a);
        const row = {
          symbol: a.symbol,
          exchange: normalizeExchange(a.exchange || DEFAULT_EXCHANGE),
          action_type: a.action_type,
          bonus_pct: a.bonus_pct ?? null,
          dividend_pct: a.dividend_pct ?? null,
          rights_ratio: a.rights_ratio ?? null,
          rights_price: a.rights_price ?? null,
          factor: adj ? adj.factor : null, // null factor = uncomputable → suppress downstream
          deduction: adj ? adj.deduction : null,
          ex_date: a.ex_date ?? null,
          book_closure_date: a.book_closure_date,
          source: a.source || 'merolagani',
          raw: a,
          updated_at: nowIso,
        };
        const { error } = await supabase
          .from('corporate_actions')
          .upsert(row, { onConflict: 'symbol,exchange,action_type,book_closure_date' });
        if (!error) upserted += 1;
      } catch {
        /* one row failing must not abort the refresh */
      }
    }
    return { upserted };
  } catch {
    return { upserted: 0 };
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function parseRatio(s) {
  if (!s || typeof s !== 'string') return null;
  const m = s.match(/(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const base = Number(m[1]);
  const extra = Number(m[2]);
  if (!Number.isFinite(base) || !Number.isFinite(extra) || base + extra <= 0) return null;
  return { base, extra };
}
function toNum(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}
function toTime(v) {
  if (!v) return null;
  const s = String(v);
  const t = Date.parse(s.length <= 10 ? `${s}T00:00:00Z` : s);
  return Number.isFinite(t) ? t : null;
}
function toIsoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}
function pad2(v) {
  return String(v).padStart(2, '0');
}

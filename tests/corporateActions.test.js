import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  parseAnnouncements,
  parseAnnouncementIds,
  computeAdjustment,
  applyAdjustment,
  deriveExWindow,
  getActiveAdjustment,
  EX_WINDOW_BEFORE_DAYS,
  EX_WINDOW_AFTER_DAYS,
} from '../src/lib/corporateActions.js';

// Real merolagani AnnouncementDetail tables, saved 2026-08 (tests/fixtures/). See the
// header of src/lib/corporateActions.js for the inspected page structure + the
// list-vs-detail deviation note.
const fx = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const NORVIC = fx('merolagani-announcement-bonus-cashdiv-NORVIC.html'); // bonus 20% + cash div 22.11%, BC 2026/08/16
const NIBLSF = fx('merolagani-announcement-bookclose-only-NIBLSF.html'); // BC 2023/07/27 only, no structured ratio
const TTL = fx('merolagani-announcement-rights-TTL.html'); // rights ratio 10:1, no BC
const MPFL = fx('merolagani-announcement-empty-MPFL.html'); // declaration notice, all structured fields blank

describe('parseAnnouncements (real merolagani detail pages)', () => {
  it('extracts BOTH a bonus and a cash dividend from one AGM announcement', () => {
    const actions = parseAnnouncements(NORVIC);
    const bonus = actions.find((a) => a.action_type === 'BONUS');
    const cash = actions.find((a) => a.action_type === 'CASH_DIV');
    expect(bonus).toBeTruthy();
    expect(bonus.symbol).toBe('NORVIC');
    expect(bonus.bonus_pct).toBe(20);
    expect(bonus.book_closure_date).toBe('2026-08-16');
    expect(cash).toBeTruthy();
    expect(cash.dividend_pct).toBe(22.11);
    expect(cash.book_closure_date).toBe('2026-08-16');
  });

  it('extracts a rights ratio (base:new)', () => {
    const actions = parseAnnouncements(TTL);
    const rights = actions.find((a) => a.action_type === 'RIGHTS');
    expect(rights).toBeTruthy();
    expect(rights.symbol).toBe('TTL');
    expect(rights.rights_ratio).toBe('10:1');
  });

  it('yields NO actions when the structured ratio fields are blank (book-closure only)', () => {
    // NIBLSF carries a book-closure date but no structured %/ratio → nothing actionable.
    expect(parseAnnouncements(NIBLSF)).toEqual([]);
  });

  it('yields NO actions for a bare declaration notice (all fields blank)', () => {
    expect(parseAnnouncements(MPFL)).toEqual([]);
  });

  it('returns [] on garbage/empty input, never throws', () => {
    expect(parseAnnouncements('')).toEqual([]);
    expect(parseAnnouncements(null)).toEqual([]);
    expect(parseAnnouncements(undefined)).toEqual([]);
    expect(parseAnnouncements(12345)).toEqual([]);
    expect(parseAnnouncements('<html><body>no table here</body></html>')).toEqual([]);
  });
});

describe('parseAnnouncementIds', () => {
  it('pulls deduped detail ids out of list/summary HTML', () => {
    const html =
      '<a href="/AnnouncementDetail.aspx?id=66646&ntf=true">x</a>' +
      '<a href="/AnnouncementDetail.aspx?id=66646">x</a>' +
      '<a href="/AnnouncementDetail.aspx?id=49468">y</a>';
    expect(parseAnnouncementIds(html).sort()).toEqual(['49468', '66646']);
  });

  it('returns [] on junk', () => {
    expect(parseAnnouncementIds(null)).toEqual([]);
    expect(parseAnnouncementIds('nothing')).toEqual([]);
  });
});

describe('computeAdjustment (money-critical)', () => {
  it('BONUS 100% halves the price (factor 0.5)', () => {
    expect(computeAdjustment({ action_type: 'BONUS', bonus_pct: 100 })).toEqual({
      factor: 0.5,
      deduction: 0,
    });
  });

  it('BONUS 20% → factor 1/1.2', () => {
    const adj = computeAdjustment({ action_type: 'BONUS', bonus_pct: 20 });
    expect(adj.factor).toBeCloseTo(0.8333333, 6);
    expect(adj.deduction).toBe(0);
  });

  it('STOCK_DIV uses the same bonus math', () => {
    expect(computeAdjustment({ action_type: 'STOCK_DIV', bonus_pct: 100 }).factor).toBe(0.5);
  });

  it('SPLIT factor = 1/ratio', () => {
    expect(computeAdjustment({ action_type: 'SPLIT', split_ratio: 2 })).toEqual({
      factor: 0.5,
      deduction: 0,
    });
  });

  it('RIGHTS WITH a rights_price + market ref → theoretical ex factor', () => {
    // ratio 1:1 (base 1, new 1), mkt 200, rights_price 100 → ex = (200+100)/2 = 150 → 0.75.
    const adj = computeAdjustment({
      action_type: 'RIGHTS',
      rights_ratio: '1:1',
      rights_price: 100,
      mkt: 200,
    });
    expect(adj.factor).toBeCloseTo(0.75, 6);
    expect(adj.deduction).toBe(0);
  });

  it('RIGHTS WITHOUT a rights_price → null (uncomputable → suppress)', () => {
    expect(computeAdjustment({ action_type: 'RIGHTS', rights_ratio: '10:1' })).toBeNull();
    // even with a market ref, no rights_price = null
    expect(computeAdjustment({ action_type: 'RIGHTS', rights_ratio: '10:1', mkt: 500 })).toBeNull();
  });

  it('CASH_DIV → per-share deduction on Rs 100 par (factor 1)', () => {
    expect(computeAdjustment({ action_type: 'CASH_DIV', dividend_pct: 22.11 })).toEqual({
      factor: 1,
      deduction: 22.11,
    });
  });

  it('returns null on junk / unknown type / missing data', () => {
    expect(computeAdjustment(null)).toBeNull();
    expect(computeAdjustment({ action_type: 'MYSTERY' })).toBeNull();
    expect(computeAdjustment({ action_type: 'BONUS' })).toBeNull(); // no pct
    expect(computeAdjustment({ action_type: 'CASH_DIV', dividend_pct: 0 })).toBeNull();
  });
});

describe('applyAdjustment', () => {
  it('applies v*factor - deduction to each level', () => {
    const out = applyAdjustment({ target: 240, sl: 180, price: 200 }, { factor: 0.5, deduction: 0 });
    expect(out).toEqual({ target: 120, sl: 90, price: 100 });
  });

  it('combines a factor and a deduction (bonus + cash dividend)', () => {
    // 20% bonus (0.8333) + Rs 22.11 cash dividend on a 240 target.
    const out = applyAdjustment({ target: 240, sl: null, price: 200 }, { factor: 1 / 1.2, deduction: 22.11 });
    expect(out.target).toBeCloseTo(240 / 1.2 - 22.11, 6);
    expect(out.sl).toBeNull();
    expect(out.price).toBeCloseTo(200 / 1.2 - 22.11, 6);
  });

  it('defaults to identity (factor 1, deduction 0) on missing adj', () => {
    expect(applyAdjustment({ target: 100, sl: 90, price: 95 }, undefined)).toEqual({
      target: 100,
      sl: 90,
      price: 95,
    });
  });

  it('passes null levels through unchanged', () => {
    expect(applyAdjustment({ target: null, sl: null, price: null }, { factor: 0.5 })).toEqual({
      target: null,
      sl: null,
      price: null,
    });
  });
});

describe('deriveExWindow (book-closure ↔ ex-date band)', () => {
  it('bands the book-closure date by the configured before/after days', () => {
    const win = deriveExWindow({ book_closure_date: '2026-08-16' });
    expect(win).toEqual({ ex_start: '2026-08-14', ex_end: '2026-08-19' });
    expect(EX_WINDOW_BEFORE_DAYS).toBe(2);
    expect(EX_WINDOW_AFTER_DAYS).toBe(3);
  });

  it('handles month/year boundaries without off-by-one', () => {
    // 2026-03-01 minus 2 days crosses into February (2026 is not a leap year).
    expect(deriveExWindow({ book_closure_date: '2026-03-01' })).toEqual({
      ex_start: '2026-02-27',
      ex_end: '2026-03-04',
    });
  });

  it('prefers an explicit ex_date over book_closure_date', () => {
    const win = deriveExWindow({ ex_date: '2026-01-10', book_closure_date: '2026-02-20' });
    expect(win.ex_start).toBe('2026-01-08');
    expect(win.ex_end).toBe('2026-01-13');
  });

  it('returns null when there is no dateable anchor', () => {
    expect(deriveExWindow({})).toBeNull();
    expect(deriveExWindow({ book_closure_date: null })).toBeNull();
  });
});

// Minimal thenable Supabase stub: from().select().eq().eq() resolves { data, error }.
function makeSupabase(rows, error = null) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    then: (resolve) => resolve({ data: rows, error }),
  };
  return { from: () => builder };
}

describe('getActiveAdjustment (window overlap + computable propagation)', () => {
  const signalCreated = '2026-08-10T00:00:00Z';
  const now = '2026-08-17T00:00:00Z';

  it('includes an in-window CA and compounds factor + deduction', async () => {
    const sb = makeSupabase([
      { symbol: 'NORVIC', exchange: 'NEPSE', action_type: 'BONUS', factor: 1 / 1.2, deduction: 0, book_closure_date: '2026-08-16', ex_date: null },
      { symbol: 'NORVIC', exchange: 'NEPSE', action_type: 'CASH_DIV', factor: 1, deduction: 22.11, book_closure_date: '2026-08-16', ex_date: null },
    ]);
    const adj = await getActiveAdjustment(sb, 'NORVIC', 'NEPSE', signalCreated, now);
    expect(adj.computable).toBe(true);
    expect(adj.factor).toBeCloseTo(1 / 1.2, 6);
    expect(adj.deduction).toBeCloseTo(22.11, 6);
    expect(adj.actions).toHaveLength(2);
  });

  it('propagates computable=false when any in-window CA has a null factor', async () => {
    const sb = makeSupabase([
      { symbol: 'TTL', exchange: 'NEPSE', action_type: 'RIGHTS', factor: null, deduction: null, book_closure_date: '2026-08-15', ex_date: null },
    ]);
    const adj = await getActiveAdjustment(sb, 'TTL', 'NEPSE', signalCreated, now);
    expect(adj.computable).toBe(false);
    expect(adj.actions).toHaveLength(1);
  });

  it('excludes a CA whose ex-window does not overlap the signal life', async () => {
    const sb = makeSupabase([
      { symbol: 'NORVIC', exchange: 'NEPSE', action_type: 'BONUS', factor: 0.8, deduction: 0, book_closure_date: '2026-12-01', ex_date: null },
    ]);
    const adj = await getActiveAdjustment(sb, 'NORVIC', 'NEPSE', signalCreated, now);
    expect(adj).toEqual({ factor: 1, deduction: 0, computable: true, actions: [] });
  });

  it('returns the neutral identity on a read error, never throws', async () => {
    const sb = makeSupabase(null, { message: 'boom' });
    const adj = await getActiveAdjustment(sb, 'X', 'NEPSE', signalCreated, now);
    expect(adj).toEqual({ factor: 1, deduction: 0, computable: true, actions: [] });
  });

  it('returns the neutral identity when there is no client/symbol', async () => {
    expect(await getActiveAdjustment(null, 'X', 'NEPSE', signalCreated, now)).toEqual({
      factor: 1,
      deduction: 0,
      computable: true,
      actions: [],
    });
  });
});

import { describe, it, expect } from 'vitest';
import { computeSignalAlertEvents, formatUserAlert } from '../src/lib/alertDelivery.js';

// Helpers to build the pure-function inputs concisely.
const U = 'user-1';
const both = { thresholds: { onBuy: true, onSell: true } }; // wants BUY + SELL alerts

function run({ signals, watch = { [U]: ['NABIL'] }, prefs = { [U]: both }, cursors = {} }) {
  const watchByUser = new Map(Object.entries(watch).map(([u, syms]) => [u, new Set(syms)]));
  const prefsByUser = new Map(Object.entries(prefs));
  const cursorByKey = new Map(Object.entries(cursors));
  return computeSignalAlertEvents({ signals, watchByUser, prefsByUser, cursorByKey, exchange: 'NEPSE' });
}

// A cursor row keyed exactly as the module keys it: `${user}::${EXCHANGE}::${SYMBOL}`.
function curKey(sym = 'NABIL', user = U) {
  return `${user}::NEPSE::${sym}`;
}

describe('computeSignalAlertEvents — REFINEMENT: absent cursor seeds silently', () => {
  it('no prior cursor -> seeds the cursor, emits NO event (BUY)', () => {
    const { events, cursorUpserts } = run({
      signals: [{ id: 's1', scan_id: 'scan1', symbol: 'NABIL', signal: 'BUY' }],
      cursors: {}, // absent
    });
    expect(events).toEqual([]); // the crux: first observation is silent
    expect(cursorUpserts).toHaveLength(1);
    expect(cursorUpserts[0]).toMatchObject({
      user_id: U,
      exchange: 'NEPSE',
      symbol: 'NABIL',
      last_direction: 'BUY',
      last_signal_id: 's1',
      last_scan_id: 'scan1',
      sent_at: null,
    });
  });

  it('no prior cursor -> seeds silently for HOLD/AVOID too', () => {
    const hold = run({ signals: [{ id: 'h1', scan_id: 'sc', symbol: 'NABIL', signal: 'HOLD' }] });
    expect(hold.events).toEqual([]);
    expect(hold.cursorUpserts[0].last_direction).toBe('HOLD');
    const avoid = run({ signals: [{ id: 'a1', scan_id: 'sc', symbol: 'NABIL', signal: 'AVOID' }] });
    expect(avoid.events).toEqual([]);
    expect(avoid.cursorUpserts[0].last_direction).toBe('AVOID');
  });
});

describe('computeSignalAlertEvents — prior cursor cases', () => {
  it('standing BUY (cursor last_direction=BUY) -> no event, cursor advances', () => {
    const { events, cursorUpserts } = run({
      signals: [{ id: 's2', scan_id: 'scan2', symbol: 'NABIL', signal: 'BUY' }],
      cursors: { [curKey()]: { last_direction: 'BUY', last_signal_id: 's1', last_scan_id: 'scan1', sent_at: null } },
    });
    expect(events).toEqual([]);
    expect(cursorUpserts).toHaveLength(1);
    expect(cursorUpserts[0].last_signal_id).toBe('s2'); // advanced
    expect(cursorUpserts[0].last_scan_id).toBe('scan2');
  });

  it('same signal_id as cursor -> skip entirely (idempotent re-run)', () => {
    const { events, cursorUpserts } = run({
      signals: [{ id: 's1', scan_id: 'scan1', symbol: 'NABIL', signal: 'BUY' }],
      cursors: { [curKey()]: { last_direction: 'BUY', last_signal_id: 's1', last_scan_id: 'scan1', sent_at: null } },
    });
    expect(events).toEqual([]);
    expect(cursorUpserts).toEqual([]); // nothing written — pure no-op
  });

  it('flip HOLD -> BUY with onBuy -> event + cursor advances', () => {
    const { events, cursorUpserts } = run({
      signals: [{ id: 's3', scan_id: 'scan3', symbol: 'NABIL', signal: 'BUY' }],
      cursors: { [curKey()]: { last_direction: 'HOLD', last_signal_id: 's2', last_scan_id: 'scan2', sent_at: null } },
    });
    expect(events).toEqual([{ user_id: U, symbol: 'NABIL', direction: 'BUY', signal_id: 's3' }]);
    expect(cursorUpserts).toHaveLength(1);
    expect(cursorUpserts[0].last_direction).toBe('BUY');
  });

  it('flip -> BUY with onBuy:false -> no event, cursor advances', () => {
    const { events, cursorUpserts } = run({
      signals: [{ id: 's3', scan_id: 'scan3', symbol: 'NABIL', signal: 'BUY' }],
      prefs: { [U]: { thresholds: { onBuy: false, onSell: true } } },
      cursors: { [curKey()]: { last_direction: 'HOLD', last_signal_id: 's2', last_scan_id: 'scan2', sent_at: null } },
    });
    expect(events).toEqual([]);
    expect(cursorUpserts).toHaveLength(1);
    expect(cursorUpserts[0].last_direction).toBe('BUY');
  });

  it('flip BUY -> SELL with onSell -> event', () => {
    const { events } = run({
      signals: [{ id: 's4', scan_id: 'scan4', symbol: 'NABIL', signal: 'SELL' }],
      cursors: { [curKey()]: { last_direction: 'BUY', last_signal_id: 's3', last_scan_id: 'scan3', sent_at: null } },
    });
    expect(events).toEqual([{ user_id: U, symbol: 'NABIL', direction: 'SELL', signal_id: 's4' }]);
  });

  it('flip -> HOLD/AVOID -> cursor advances, no event', () => {
    const toHold = run({
      signals: [{ id: 's5', scan_id: 'scan5', symbol: 'NABIL', signal: 'HOLD' }],
      cursors: { [curKey()]: { last_direction: 'BUY', last_signal_id: 's4', last_scan_id: 'scan4', sent_at: null } },
    });
    expect(toHold.events).toEqual([]);
    expect(toHold.cursorUpserts[0].last_direction).toBe('HOLD');

    const toAvoid = run({
      signals: [{ id: 's6', scan_id: 'scan6', symbol: 'NABIL', signal: 'AVOID' }],
      cursors: { [curKey()]: { last_direction: 'SELL', last_signal_id: 's4', last_scan_id: 'scan4', sent_at: null } },
    });
    expect(toAvoid.events).toEqual([]);
    expect(toAvoid.cursorUpserts[0].last_direction).toBe('AVOID');
  });

  it('carries the prior sent_at forward on an advancing cursor', () => {
    const { cursorUpserts } = run({
      signals: [{ id: 's2', scan_id: 'scan2', symbol: 'NABIL', signal: 'BUY' }],
      cursors: { [curKey()]: { last_direction: 'BUY', last_signal_id: 's1', last_scan_id: 'scan1', sent_at: '2026-08-01T00:00:00Z' } },
    });
    expect(cursorUpserts[0].sent_at).toBe('2026-08-01T00:00:00Z');
  });
});

describe('computeSignalAlertEvents — watchlist scoping', () => {
  it('symbol not on the user watchlist -> ignored (no event, no cursor)', () => {
    const { events, cursorUpserts } = run({
      signals: [{ id: 'x1', scan_id: 'scan1', symbol: 'UPPER', signal: 'BUY' }],
      watch: { [U]: ['NABIL'] }, // watches NABIL, not UPPER
      cursors: {},
    });
    expect(events).toEqual([]);
    expect(cursorUpserts).toEqual([]);
  });
});

describe('formatUserAlert', () => {
  it('includes the disclaimer line and every flipped symbol', () => {
    const events = [
      { user_id: U, symbol: 'NABIL', direction: 'BUY', signal_id: 's1' },
      { user_id: U, symbol: 'UPPER', direction: 'SELL', signal_id: 's2' },
    ];
    const { subject, text } = formatUserAlert('me@example.com', events, 'NEPSE');
    expect(subject).toContain('2 signal changes');
    expect(text).toContain('NABIL: now BUY');
    expect(text).toContain('UPPER: now SELL');
    expect(text).toContain('Educational, not financial advice');
    expect(text).toContain('past performance ≠ future results');
  });

  it('singularizes the subject for a single change', () => {
    const { subject } = formatUserAlert('me@example.com', [{ symbol: 'NABIL', direction: 'BUY' }], 'NEPSE');
    expect(subject).toContain('1 signal change');
    expect(subject).not.toContain('changes');
  });
});

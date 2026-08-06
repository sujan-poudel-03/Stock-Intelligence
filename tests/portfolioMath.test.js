import { describe, it, expect } from 'vitest';
import { buildSummary } from '../src/lib/portfolioMath.js';

// TIER-2 server-side portfolio math is money-critical (it feeds the copilot's
// "how am I doing / am I over-concentrated?" answers). Charge/CGT arithmetic itself is
// covered in charges.test.js (positionPnl); here we test AGGREGATION, concentration, the
// priceUnavailable path, the 'Unknown' sector bucket, and status-case normalization.

const NOW = Date.parse('2025-03-01T00:00:00Z');
// Open positions opened ~2 weeks before NOW → short-term (7.5%) hypothetical CGT.
const OPENED = '2025-02-15T00:00:00Z';

describe('buildSummary — totals aggregation', () => {
  it('sums cost basis, current value, and unrealized net over OPEN positions', () => {
    const positions = [
      { id: 1, symbol: 'AAA', status: 'open', qty: 100, buy_price: 100, opened_at: OPENED },
      { id: 2, symbol: 'BBB', status: 'open', qty: 50, buy_price: 200, opened_at: OPENED },
    ];
    const priceMap = { AAA: { price: 120 }, BBB: { price: 180 } };
    const sectorMap = { AAA: 'Banking', BBB: 'Hydro' };

    const s = buildSummary(positions, priceMap, sectorMap, { now: NOW });
    expect(s.totals.openCount).toBe(2);
    expect(s.totals.costBasis).toBeCloseTo(20000, 6); // 100*100 + 50*200
    expect(s.totals.currentValue).toBeCloseTo(21000, 6); // 100*120 + 50*180
    // AAA nets +1867.5 pre-tax; BBB (a loser) nets -1121.25 → sum 746.25.
    expect(s.totals.unrealizedNet).toBeCloseTo(746.25, 6);
    // Unrealized is pre-tax; after-CGT is lower (only the winner is taxed).
    expect(s.totals.unrealizedNetAfterTax).toBeLessThan(s.totals.unrealizedNet);
    expect(s.totals.realizedNet).toBe(0);
  });

  it('realized (closed) P&L uses the actual hold-days CGT rate and is excluded from current value', () => {
    const positions = [
      {
        id: 1, symbol: 'AAA', status: 'closed', qty: 100, buy_price: 100, sell_price: 120,
        opened_at: '2025-01-01T00:00:00Z', closed_at: '2025-02-01T00:00:00Z', // 31 days → short-term
      },
    ];
    const s = buildSummary(positions, {}, { AAA: 'Banking' }, { now: NOW });
    const row = s.positions[0];
    expect(row.status).toBe('closed');
    expect(row.realized).toBe(true);
    expect(row.cgtRate).toBe(0.075);
    // netPnl is net of charges AND CGT (1867.5 - 7.5%).
    expect(row.netPnl).toBeCloseTo(1867.5 - 1867.5 * 0.075, 6);
    expect(s.totals.realizedNet).toBeCloseTo(1867.5 - 1867.5 * 0.075, 6);
    // Closed positions are not held → they must not weigh in current value / concentration.
    expect(row.currentValue).toBe(0);
    expect(s.totals.currentValue).toBe(0);
    expect(s.totals.openCount).toBe(0);
  });

  it('long-term closed hold (>=365 days) taxes at 5%', () => {
    const positions = [
      {
        id: 1, symbol: 'AAA', status: 'closed', qty: 100, buy_price: 100, sell_price: 120,
        opened_at: '2024-01-01T00:00:00Z', closed_at: '2025-02-01T00:00:00Z', // ~397 days
      },
    ];
    const row = buildSummary(positions, {}, {}, { now: NOW }).positions[0];
    expect(row.cgtRate).toBe(0.05);
  });

  it('a closed row missing closed_at defaults to short-term and is flagged', () => {
    const positions = [
      {
        id: 1, symbol: 'AAA', status: 'closed', qty: 100, buy_price: 100, sell_price: 120,
        opened_at: '2024-01-01T00:00:00Z', closed_at: null,
      },
    ];
    const row = buildSummary(positions, {}, {}, { now: NOW }).positions[0];
    expect(row.closedAtMissing).toBe(true);
    expect(row.cgtRate).toBe(0.075); // can't prove a long-term hold → short-term
  });
});

describe('buildSummary — concentration', () => {
  it('flags a sector above the threshold as overConcentrated', () => {
    const positions = [
      { id: 1, symbol: 'AAA', status: 'open', qty: 100, buy_price: 100, opened_at: OPENED },
      { id: 2, symbol: 'CCC', status: 'open', qty: 100, buy_price: 30, opened_at: OPENED },
    ];
    const priceMap = { AAA: { price: 120 }, CCC: { price: 30 } };
    const sectorMap = { AAA: 'Banking', CCC: 'Hydro' };
    // Banking = 12000, Hydro = 3000, total 15000 → Banking 80% > 40%.
    const s = buildSummary(positions, priceMap, sectorMap, { now: NOW });
    const banking = s.concentration.bySector.find((x) => x.key === 'Banking');
    expect(banking.pct).toBeCloseTo(80, 6);
    expect(banking.overConcentrated).toBe(true);
    expect(s.concentration.overConcentrated).toBe(true);
    // bySector is sorted by value desc.
    expect(s.concentration.bySector[0].key).toBe('Banking');
  });

  it('respects a custom concentrationPct threshold', () => {
    const positions = [
      { id: 1, symbol: 'AAA', status: 'open', qty: 100, buy_price: 100, opened_at: OPENED },
      { id: 2, symbol: 'BBB', status: 'open', qty: 100, buy_price: 100, opened_at: OPENED },
    ];
    const priceMap = { AAA: { price: 100 }, BBB: { price: 100 } };
    const sectorMap = { AAA: 'Banking', BBB: 'Hydro' }; // 50/50
    // At 40% both are over; at 60% neither is.
    expect(buildSummary(positions, priceMap, sectorMap, { now: NOW }).concentration.overConcentrated).toBe(true);
    expect(buildSummary(positions, priceMap, sectorMap, { now: NOW, concentrationPct: 60 }).concentration.overConcentrated).toBe(false);
  });
});

describe('buildSummary — priceUnavailable + Unknown sector', () => {
  it('a holding with no price contributes cost basis only (concentration + no phantom P&L)', () => {
    const positions = [
      { id: 1, symbol: 'AAA', status: 'open', qty: 100, buy_price: 120, opened_at: OPENED }, // priced
      { id: 2, symbol: 'DDD', status: 'open', qty: 100, buy_price: 50, opened_at: OPENED }, // no price
    ];
    const priceMap = { AAA: { price: 120 } };
    const sectorMap = { AAA: 'Banking', DDD: 'Hydro' };
    const s = buildSummary(positions, priceMap, sectorMap, { now: NOW });
    const ddd = s.positions.find((r) => r.symbol === 'DDD');
    expect(ddd.priceUnavailable).toBe(true);
    expect(ddd.currentValue).toBeCloseTo(5000, 6); // cost basis stands in (100*50)
    expect(ddd.costBasis).toBeCloseTo(5000, 6);
    expect(ddd.netPnl).toBe(0); // no phantom loss without a mark
    // It still participates in concentration via its cost basis.
    const hydro = s.concentration.bySector.find((x) => x.key === 'Hydro');
    expect(hydro.value).toBeCloseTo(5000, 6);
    expect(s.totals.priceUnavailableCount).toBe(1);
  });

  it("buckets a symbol with no sector as 'Unknown'", () => {
    const positions = [
      { id: 1, symbol: 'ZZZ', status: 'open', qty: 10, buy_price: 100, opened_at: OPENED },
    ];
    const s = buildSummary(positions, { ZZZ: { price: 110 } }, {}, { now: NOW });
    expect(s.positions[0].sector).toBe('Unknown');
    expect(s.concentration.bySector[0].key).toBe('Unknown');
  });
});

describe('buildSummary — edges', () => {
  it('empty portfolio → zeroed totals and empty concentration', () => {
    const s = buildSummary([], {}, {});
    expect(s.positions).toEqual([]);
    expect(s.totals.costBasis).toBe(0);
    expect(s.totals.currentValue).toBe(0);
    expect(s.totals.unrealizedNet).toBe(0);
    expect(s.totals.realizedNet).toBe(0);
    expect(s.concentration.bySector).toEqual([]);
    expect(s.concentration.bySymbol).toEqual([]);
    expect(s.concentration.overConcentrated).toBe(false);
  });

  it('normalizes status case (uppercase OPEN/CLOSED from any caller)', () => {
    const positions = [
      { id: 1, symbol: 'AAA', status: 'OPEN', qty: 100, buy_price: 100, opened_at: OPENED },
      {
        id: 2, symbol: 'BBB', status: 'CLOSED', qty: 100, buy_price: 100, sell_price: 120,
        opened_at: '2025-01-01T00:00:00Z', closed_at: '2025-02-01T00:00:00Z',
      },
    ];
    const s = buildSummary(positions, { AAA: { price: 110 } }, {}, { now: NOW });
    expect(s.totals.openCount).toBe(1);
    expect(s.totals.closedCount).toBe(1);
    expect(s.positions.find((r) => r.symbol === 'AAA').status).toBe('open');
    expect(s.positions.find((r) => r.symbol === 'BBB').status).toBe('closed');
  });
});

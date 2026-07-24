import { describe, it, expect } from 'vitest';
import { runBacktest, aggregate, smaStrategy } from '../src/lib/backtest.js';

const bars = (prices) => prices.map((price, i) => ({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, price }));

// A one-shot strategy: enter BUY only on the first bar, with given sl/target.
const buyOnce = (sl, target) => (history) =>
  history.length === 1 ? { signal: 'BUY', sl, target } : null;

describe('runBacktest — outcome resolution', () => {
  it('records a WIN when price reaches the target', () => {
    const { trades } = runBacktest(bars([100, 102, 104, 108, 110]), buyOnce(95, 108));
    expect(trades).toHaveLength(1);
    expect(trades[0].outcome).toBe('WIN');
    expect(trades[0].returnPct).toBe(8); // (108-100)/100
  });

  it('records a LOSS when price hits the stop', () => {
    const { trades } = runBacktest(bars([100, 99, 97, 95, 90]), buyOnce(95, 130));
    expect(trades[0].outcome).toBe('LOSS');
    expect(trades[0].returnPct).toBe(-5); // (95-100)/100
  });

  it('leaves a trade OPEN when neither target nor stop is hit in the window', () => {
    const { trades } = runBacktest(bars([100, 101, 100, 101]), buyOnce(90, 130));
    expect(trades[0].outcome).toBe('OPEN');
  });
});

describe('runBacktest — NO look-ahead guarantee', () => {
  it('only ever shows the strategy bars up to the current day', () => {
    const prices = [100, 101, 102, 103];
    const lastSeen = [];
    runBacktest(bars(prices), (history, ctx) => {
      // The most recent bar the strategy sees must be exactly today's bar…
      expect(history[history.length - 1].price).toBe(prices[ctx.index]);
      // …and it must never receive a future bar.
      expect(history).toHaveLength(ctx.index + 1);
      lastSeen.push(history.length);
      return null;
    });
    expect(lastSeen).toEqual([1, 2, 3, 4]);
  });
});

describe('aggregate — track-record metrics', () => {
  it('computes win rate, avg return, and max drawdown across trades', () => {
    // WIN +4 then LOSS -4: winRate 0.5, avgReturn 0, drawdown -4 (peak 4 -> 0)
    const strategy = (history) => {
      const i = history.length - 1;
      if (i === 0) return { signal: 'BUY', sl: 95, target: 104 };
      if (i === 2) return { signal: 'BUY', sl: 96, target: 110 };
      return null;
    };
    const { trades, metrics } = runBacktest(bars([100, 104, 100, 96]), strategy);
    expect(trades).toHaveLength(2);
    expect(metrics.wins).toBe(1);
    expect(metrics.losses).toBe(1);
    expect(metrics.winRate).toBe(0.5);
    expect(metrics.avgReturn).toBe(0);
    expect(metrics.maxDrawdownPct).toBe(-4);
    // Risk-adjusted view: flat mean → Sharpe 0; the -4 downside drags the
    // risk-adjusted return below the (zero) average return.
    expect(metrics.sharpe).toBe(0);
    expect(metrics.riskAdjustedReturn).toBe(-4);
  });

  it('is safe on an empty trade list', () => {
    expect(aggregate([])).toMatchObject({ trades: 0, wins: 0, losses: 0, winRate: 0, avgReturn: 0 });
  });
});

describe('smaStrategy (reference)', () => {
  it('does not signal before it has a full window', () => {
    expect(smaStrategy({ window: 5 })(bars([100, 101, 102]))).toBeNull();
  });

  it('goes long above the moving average with fixed stop/target', () => {
    const d = smaStrategy({ window: 3, stopPct: 0.05, targetPct: 0.08 })(bars([100, 100, 130]));
    expect(d.signal).toBe('BUY');
    expect(d.sl).toBeLessThan(130);
    expect(d.target).toBeGreaterThan(130);
  });
});

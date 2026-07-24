import { describe, it, expect } from 'vitest';
import { scoreShadow } from '../src/lib/shadow.js';

const sig = (signal, outcome, return_pct) => ({ signal, outcome, return_pct });

describe('scoreShadow (internal B scoreboard)', () => {
  it('scores only actionable, resolved calls', () => {
    const s = scoreShadow([
      sig('BUY', 'WIN', 8),
      sig('BUY', 'LOSS', -5),
      sig('SELL', 'WIN', 6),
      sig('HOLD', 'WIN', 3), // ignored — not actionable
      sig('BUY', 'PENDING', null), // ignored — not resolved
    ]);
    expect(s.trades).toBe(4); // 4 actionable (HOLD excluded); PENDING counts as a trade but not closed
    expect(s.closed).toBe(3);
    expect(s.wins).toBe(2);
    expect(s.losses).toBe(1);
    expect(s.winRate).toBe(0.67);
    expect(s.avgReturn).toBe(3); // (8 - 5 + 6) / 3
  });

  it('discounts a tiny sample via the Wilson confidence bound', () => {
    const s = scoreShadow([sig('BUY', 'WIN', 5), sig('BUY', 'WIN', 5)]);
    expect(s.winRate).toBe(1); // raw 100%
    expect(s.confidence).toBeLessThan(0.5); // but confidence stays low on n=2
  });

  it('splits performance by direction', () => {
    const s = scoreShadow([sig('BUY', 'WIN', 4), sig('SELL', 'LOSS', -3)]);
    expect(s.byDirection.BUY.wins).toBe(1);
    expect(s.byDirection.SELL.losses).toBe(1);
  });

  it('is safe on an empty set', () => {
    expect(scoreShadow([])).toMatchObject({ trades: 0, wins: 0, losses: 0, winRate: 0, confidence: 0 });
  });
});

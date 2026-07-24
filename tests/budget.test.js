import { describe, it, expect, afterEach } from 'vitest';
import { dailyBudget } from '../src/lib/budget.js';

// The daily budget ceiling must fail SAFE: an invalid or non-positive override
// falls back to the default rather than disabling the guard.
const original = process.env.LLM_DAILY_BUDGET;
afterEach(() => {
  if (original === undefined) delete process.env.LLM_DAILY_BUDGET;
  else process.env.LLM_DAILY_BUDGET = original;
});

describe('dailyBudget', () => {
  it('defaults to 200 when unset', () => {
    delete process.env.LLM_DAILY_BUDGET;
    expect(dailyBudget()).toBe(200);
  });

  it('honours a positive override', () => {
    process.env.LLM_DAILY_BUDGET = '50';
    expect(dailyBudget()).toBe(50);
  });

  it('ignores non-positive / invalid values (fails safe to default)', () => {
    process.env.LLM_DAILY_BUDGET = '0';
    expect(dailyBudget()).toBe(200);
    process.env.LLM_DAILY_BUDGET = '-10';
    expect(dailyBudget()).toBe(200);
    process.env.LLM_DAILY_BUDGET = 'abc';
    expect(dailyBudget()).toBe(200);
  });
});

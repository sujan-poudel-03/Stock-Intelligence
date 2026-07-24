import { defineConfig } from 'vitest/config';

// Unit tests cover the deterministic, money-critical and reliability-critical
// logic in src/lib (target math, LLM-output parsing, error humanization, budget
// ceiling, scan scheduling). Anything needing Supabase or a live LLM is out of
// scope here — those are exercised via `npm run build` + the dev full-chain run.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
  },
});

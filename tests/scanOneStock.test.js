import { describe, it, expect, vi } from 'vitest';

// Prove the P1-4 guarantee: the signal's price is the VERIFIED price, never the
// number the LLM returns. We mock the verified layer + LLM so the two disagree
// hard (verified 500 vs LLM 999999) and assert the verified one wins.
vi.mock('../src/lib/marketProviders.js', () => ({
  getVerifiedPrice: vi.fn(async () => ({
    verified: true,
    price: 500,
    asOf: Date.UTC(2026, 0, 5, 10, 0, 0),
    stale: false,
    sources: ['merolagani', 'sharesansar'],
  })),
}));
vi.mock('../src/lib/llm.js', () => ({
  callLLM: vi.fn(async () =>
    JSON.stringify({ price: 999999, signal: 'BUY', confidence: 'HIGH', sector: 'Hydropower', why: 'momentum' })
  ),
  parseJson: (t) => {
    try {
      return JSON.parse(t);
    } catch {
      return null;
    }
  },
}));
vi.mock('../src/lib/calibration.js', () => ({
  getWeightContext: async () => '',
  getOverviewContext: async () => '',
}));
vi.mock('../src/lib/knowledge.js', () => ({ getKnowledgeContext: async () => '' }));

const { scanOneStock } = await import('../src/lib/scan.js');
const { getVerifiedPrice } = await import('../src/lib/marketProviders.js');

describe('scanOneStock (verified price wins)', () => {
  it('uses the verified price and ignores the LLM-reported price', async () => {
    const sig = await scanOneStock('NABIL', {});
    expect(sig.price).toBe(500); // verified, NOT 999999
    expect(sig.sl).toBe(475); // 5% stop off the verified price
    expect(sig.target).toBe(540); // 8% target off the verified price
    expect(sig.signal).toBe('BUY'); // the LLM's classification is still honored
    expect(sig.source).toBe('merolagani+sharesansar'); // provenance from the verified sources
    expect(sig.live_data.sources).toEqual(['merolagani', 'sharesansar']);
  });

  it('throws no-data (retryable) when no price can be verified', async () => {
    getVerifiedPrice.mockResolvedValueOnce({ verified: false, reason: 'disagreement:3%', sources: ['a', 'b'] });
    await expect(scanOneStock('NABIL', {})).rejects.toThrow(/no data from source/);
  });
});

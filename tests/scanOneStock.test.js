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
    // TIER-2: ground-truth liquidity rides along; 42M turnover is well above the
    // Rs20-lakh threshold → illiquid:false.
    liquidity: { turnover: 42_000_000, volume: 75_852 },
  })),
  getLiquidityBoard: vi.fn(async () => ({})),
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
const { callLLM } = await import('../src/lib/llm.js');

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

  // TIER-2: liquidity is annotation-only (orthogonal to confidence) — the verified
  // turnover + illiquid flag surface in live_data without changing the signal/confidence.
  it('annotates live_data with the verified turnover + illiquid flag', async () => {
    const sig = await scanOneStock('NABIL', {});
    expect(sig.live_data.turnover).toBe(42_000_000);
    expect(sig.live_data.illiquid).toBe(false); // 42M ≥ Rs20-lakh threshold
    expect(sig.confidence).toBe('HIGH'); // liquidity did NOT touch confidence
  });

  it('flags illiquid=true for a thin name (turnover below threshold)', async () => {
    getVerifiedPrice.mockResolvedValueOnce({
      verified: true,
      price: 500,
      asOf: Date.UTC(2026, 0, 5, 10, 0, 0),
      stale: false,
      sources: ['merolagani', 'sharesansar'],
      liquidity: { turnover: 500_000, volume: 1000 }, // Rs5 lakh < Rs20 lakh
    });
    const sig = await scanOneStock('NABIL', {});
    expect(sig.live_data.turnover).toBe(500_000);
    expect(sig.live_data.illiquid).toBe(true);
  });

  it('marks illiquid=null (unknown) when the verified layer has no liquidity', async () => {
    getVerifiedPrice.mockResolvedValueOnce({
      verified: true,
      price: 500,
      asOf: Date.UTC(2026, 0, 5, 10, 0, 0),
      stale: false,
      sources: ['merolagani'],
      // no liquidity field at all
    });
    const sig = await scanOneStock('NABIL', {});
    expect(sig.live_data.turnover).toBeNull();
    expect(sig.live_data.illiquid).toBeNull();
  });

  // TIER-2: a SELL yields direction-correct auto-filled levels (target below, stop above).
  it('auto-fills direction-correct levels for a SELL signal', async () => {
    callLLM.mockResolvedValueOnce(
      JSON.stringify({ signal: 'SELL', confidence: 'MEDIUM', sector: 'Hydropower', why: 'breakdown' })
    );
    const sig = await scanOneStock('NABIL', {});
    expect(sig.signal).toBe('SELL');
    expect(sig.target).toBe(460); // round(500 * 0.92) — below entry
    expect(sig.sl).toBe(525); // round(500 * 1.05) — above entry
    expect(sig.target).toBeLessThan(sig.price);
    expect(sig.sl).toBeGreaterThan(sig.price);
  });
});

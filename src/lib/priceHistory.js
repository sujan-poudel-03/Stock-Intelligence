import { normalizeExchange, DEFAULT_EXCHANGE } from './exchanges.js';
import { priceHistoryReady } from './schemaFlags.js';

// recordPricePoint(supabase, { symbol, exchange, verified }): upserts TODAY's daily
// bar from an already-VERIFIED price read (never LLM-sourced — `verified` is the
// object getVerifiedPrice() returns). Best-effort + gated on the schema-flag probe,
// mirroring refreshCorporateActions(): never throws into the scan flow, and is a
// total no-op on an unmigrated DB (no price_history table yet).
//
// No "open" field — the verified layer's `range` metadata only ever carries a
// consistency-checked high/low for the day (src/lib/marketData.js pickRange), never
// an open, so this never fabricates one. One row per (symbol, exchange, date); a
// second scan the same day just refreshes that day's close/high/low/volume.
export async function recordPricePoint(supabase, { symbol, exchange, verified } = {}) {
  try {
    if (!supabase || !symbol || !verified || !verified.verified) return { recorded: false };
    if (!(await priceHistoryReady())) return { recorded: false };

    const price = Number(verified.price);
    if (!Number.isFinite(price) || price <= 0) return { recorded: false };

    const row = {
      symbol: String(symbol).toUpperCase(),
      exchange: normalizeExchange(exchange || DEFAULT_EXCHANGE),
      date: new Date().toISOString().slice(0, 10), // one bar per calendar day (UTC)
      close: price,
      high: verified.range && Number.isFinite(Number(verified.range.high)) ? Number(verified.range.high) : null,
      low: verified.range && Number.isFinite(Number(verified.range.low)) ? Number(verified.range.low) : null,
      volume: verified.liquidity && Number.isFinite(Number(verified.liquidity.volume)) ? Number(verified.liquidity.volume) : null,
      turnover: verified.liquidity && Number.isFinite(Number(verified.liquidity.turnover)) ? Number(verified.liquidity.turnover) : null,
      stale: !!verified.stale,
    };
    const { error } = await supabase
      .from('price_history')
      .upsert(row, { onConflict: 'symbol,exchange,date' });
    return { recorded: !error };
  } catch {
    return { recorded: false };
  }
}

// loadPriceHistory(supabase, { symbol, exchange, limit }): the last N daily bars,
// oldest first (chart-ready order). Public read (anon client, RLS public-SELECT).
// Returns [] on any miss (unmigrated DB, unknown symbol, read failure) — a chart
// component renders its own "not enough history yet" state for an empty array.
export async function loadPriceHistory(supabase, { symbol, exchange, limit = 180 } = {}) {
  try {
    if (!supabase || !symbol) return [];
    if (!(await priceHistoryReady())) return [];
    const { data, error } = await supabase
      .from('price_history')
      .select('date, close, high, low, volume, stale')
      .eq('symbol', String(symbol).toUpperCase())
      .eq('exchange', normalizeExchange(exchange || DEFAULT_EXCHANGE))
      .order('date', { ascending: false })
      .limit(limit);
    if (error || !Array.isArray(data)) return [];
    return data.reverse();
  } catch {
    return [];
  }
}

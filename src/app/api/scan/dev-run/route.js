import { getServiceSupabase } from '@/lib/supabase';
import { scanMarket, runDiscovery, scanOneStock, runBrief } from '@/lib/scan';
import { getWeightContext } from '@/lib/calibration';
import { checkOutcomes } from '@/lib/outcomes';
import { unionWatchlistSymbols } from '@/lib/watchlistUnion';
import { outcomeRealismColumnsReady } from '@/lib/schemaFlags';
import { effectiveMaxHoldDays } from '@/lib/outcomeResolution';
import { KV } from '@/lib/constants';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// GET /api/scan/dev-run  (development only)
// Drives the full scan chain synchronously and streams NDJSON progress.
export async function GET() {
  if (process.env.NODE_ENV === 'production') {
    return new Response(JSON.stringify({ error: 'forbidden in production' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  }

  const encoder = new TextEncoder();
  const startedMs = Date.now();

  const stream = new ReadableStream({
    async start(controller) {
      const emit = (obj) => controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'));
      // Dev-only full-chain harness (403 in production). It inlines the same scans/
      // signals/kv_store WRITES as the real cron chain, so it uses the service-role
      // client too — this is what exercises the service-client write path in the
      // local `curl /api/scan/dev-run` verification. Requires SUPABASE_SERVICE_ROLE_KEY
      // in .env.local. (Not in the architect's literal file list — see step-2 report.)
      const supabase = getServiceSupabase();

      let scanId = null;
      let failed = 0;
      let completed = 0;

      try {
        // Create a scan row for traceability.
        const { data: scanRow } = await supabase
          .from('scans')
          .insert({ status: 'running', phase: 'market', started_at: new Date().toISOString() })
          .select()
          .single();
        scanId = scanRow?.id;

        // 1. Market.
        const market = await scanMarket();
        emit({ step: 'market', index: market.index, sentiment: market.sentiment });
        await supabase.from('scans').update({ market, phase: 'discovery' }).eq('id', scanId);

        // 2. Discovery + watchlist.
        const watchlist = await loadWatchlist(supabase, 'NEPSE');
        const discovered = await runDiscovery(market, {});
        const symbols = [...new Set([...watchlist, ...discovered].map((s) => s.toUpperCase()))];
        emit({ step: 'discovery', symbols });
        await supabase.from('scans').update({ total: symbols.length, phase: 'stocks' }).eq('id', scanId);

        // 3. Stocks (sequential).
        const signals = [];
        for (const symbol of symbols) {
          try {
            const weightCtx = await getWeightContext(symbol, null);
            const signal = await scanOneStock(symbol, market, weightCtx);
            signals.push(signal);
            completed += 1;

            const row = {
              scan_id: scanId,
              symbol: signal.symbol,
              signal: signal.signal,
              confidence: signal.confidence,
              price: signal.price,
              entry: signal.entry,
              sl: signal.sl,
              target: signal.target,
              hold: signal.hold,
              why: signal.why,
              risk: signal.risk,
              action: signal.action,
              source: signal.source,
              sector: signal.sector,
              live_data: signal.live_data,
              outcome: 'PENDING',
              created_at: new Date().toISOString(),
            };
            // TIER-1 #3: stamp the time-stop horizon at insert (parity with the worker),
            // gated so an unmigrated DB inserts byte-for-byte as before.
            if (await outcomeRealismColumnsReady()) {
              row.max_hold_days = effectiveMaxHoldDays(signal.hold);
              row.peak_high = null;
              row.trough_low = null;
            }
            await supabase.from('signals').insert(row);

            emit({ step: 'stock', symbol: signal.symbol, signal: signal.signal, price: signal.price });
          } catch (err) {
            failed += 1;
            emit({ step: 'stock', symbol, error: err?.message || String(err) });
          }
          await supabase.from('scans').update({ completed, failed, current_symbol: symbol }).eq('id', scanId);
        }

        // 4. Brief.
        const brief = await runBrief(signals, market, []);
        emit({ step: 'brief', headline: brief.headline });
        await supabase
          .from('scans')
          .update({
            brief,
            signals,
            status: failed > 0 ? 'partial' : 'done',
            phase: 'complete',
            current_symbol: null,
            completed_at: new Date().toISOString(),
          })
          .eq('id', scanId);
        await supabase.from('kv_store').upsert(
          { key: KV.BRIEF, value: brief, updated_at: new Date().toISOString() },
          { onConflict: 'key' }
        );

        // 5. Outcome monitoring.
        try {
          await checkOutcomes();
        } catch (err) {
          console.error('dev-run checkOutcomes failed:', err?.message || err);
        }

        // 6. Done.
        emit({ step: 'done', total: completed, failed, duration_ms: Date.now() - startedMs });
      } catch (err) {
        emit({ step: 'error', error: err?.message || String(err) });
        if (scanId) {
          await supabase
            .from('scans')
            .update({ status: 'error', error: err?.message || String(err) })
            .eq('id', scanId);
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
    },
  });
}

async function loadWatchlist(supabase, exchange = 'NEPSE') {
  // Phase 2 step 4: union of every user's watchlist for this exchange (matches the
  // real cron path). Fails safe to discovery-only if the table is unavailable.
  try {
    const { data, error } = await supabase
      .from('watchlists')
      .select('symbol')
      .eq('exchange', exchange);
    if (error) throw error;
    return unionWatchlistSymbols(data || []);
  } catch (err) {
    console.warn('[dev-run] watchlist union unavailable, scanning discovery only:', err?.message || err);
    return [];
  }
}

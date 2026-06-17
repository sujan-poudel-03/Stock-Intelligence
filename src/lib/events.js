import { getSupabase } from './supabase.js';

// Durable activity log. Every notable pipeline step (scan started, stock scanned,
// signal generated, symbol promoted, outcome resolved) is written to the `events`
// table so history survives page refreshes and serverless invocations — unlike the
// client-side React buffer, which is ephemeral.
//
// Best-effort by design: logging must NEVER break the scan. A failed insert is
// swallowed (same philosophy as budget.js) so a storage blip can't stall the run.

// logEvent(supabase?, { type, symbol, message, data, scanId })
// `supabase` is optional — pass an existing client to avoid re-creating it inside
// a hot loop; omit it and one is resolved lazily.
export async function logEvent(supabaseOrEvent, maybeEvent) {
  let supabase = supabaseOrEvent;
  let event = maybeEvent;
  if (maybeEvent === undefined) {
    // Called as logEvent({ ... }) — resolve a client ourselves.
    event = supabaseOrEvent;
    supabase = null;
  }

  const { type, symbol = null, message = null, data = null, scanId = null } = event || {};
  if (!type) return;

  try {
    const client = supabase || getSupabase();
    await client.from('events').insert({
      scan_id: scanId,
      type,
      symbol,
      message,
      data,
      created_at: new Date().toISOString(),
    });
  } catch {
    /* best-effort: activity logging must never throw into the pipeline */
  }
}

// Fetch the most recent events, newest first.
export async function recentEvents(limit = 100) {
  const supabase = getSupabase();
  const { data } = await supabase
    .from('events')
    .select('id, scan_id, type, symbol, message, data, created_at')
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(Number(limit) || 100, 1), 500));
  return data || [];
}

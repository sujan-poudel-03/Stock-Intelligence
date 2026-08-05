#!/usr/bin/env node
// Phase 2 STEP 6 — SCAFFOLD ONLY. DO NOT RUN in this step (left intentionally
// un-wired). One-off backfill that copies the LEGACY global kv_store watchlist /
// portfolio (the single-operator, pre-multi-tenant data) into the per-user tables
// for ONE account.
//
// Why it can't run yet: the target user_id only exists AFTER the operator signs in
// with Google at least once (Supabase creates the auth.users row on first login).
// So the sequence is: operator signs in -> look up their user_id (or pass --email)
// -> run this once -> verify -> delete the legacy kv rows.
//
// Usage (later, once ready):
//   node scripts/migrate-global-to-user.mjs --email you@example.com [--exchange NEPSE] [--commit]
//   node scripts/migrate-global-to-user.mjs --user-id <uuid> [--commit]
//
// Without --commit it DRY-RUNS (prints what it would insert, writes nothing).
// Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in the environment.
//
// TODO(step 6): implement + test against a scratch project, then run once for the
// operator account and remove the legacy kv keys (ni:wl, ni:p, ni:tl).

import { createClient } from '@supabase/supabase-js';

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, arr) => {
    if (!a.startsWith('--')) return [];
    const key = a.slice(2);
    const next = arr[i + 1];
    return [[key, next && !next.startsWith('--') ? next : true]];
  })
);

function fail(msg) {
  console.error('ERROR:', msg);
  process.exit(1);
}

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) fail('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');

  const exchange = (args.exchange || 'NEPSE').toString().toUpperCase();
  const commit = !!args.commit;
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  // 1. Resolve the target user_id.
  let userId = args['user-id'];
  if (!userId && args.email) {
    // NOTE(step 6): resolve auth.users by email via the admin API, e.g.
    //   const { data } = await supabase.auth.admin.listUsers();
    //   userId = data.users.find(u => u.email === args.email)?.id;
    fail('email -> user_id resolution not implemented yet (scaffold). Pass --user-id <uuid>.');
  }
  if (!userId) fail('Provide --user-id <uuid> (or --email once resolution is implemented).');

  // 2. Read the legacy GLOBAL kv rows.
  const readKv = async (k) => {
    const { data } = await supabase.from('kv_store').select('value').eq('key', k).maybeSingle();
    return data?.value ?? null;
  };
  const legacyWatchlist = await readKv('ni:wl'); // string[] | { symbols: [] }
  const legacyPortfolio = await readKv('ni:p'); // client trade objects

  const wlSymbols = Array.isArray(legacyWatchlist)
    ? legacyWatchlist
    : Array.isArray(legacyWatchlist?.symbols)
      ? legacyWatchlist.symbols
      : [];

  const watchlistRows = wlSymbols
    .map((s) => (typeof s === 'string' ? s : s?.symbol))
    .filter(Boolean)
    .map((symbol) => ({ user_id: userId, exchange, symbol: String(symbol).toUpperCase(), reason: 'migrated' }));

  const portfolioRows = (Array.isArray(legacyPortfolio) ? legacyPortfolio : []).map((p) => ({
    user_id: userId,
    exchange,
    symbol: String(p.symbol || '').toUpperCase(),
    qty: p.qty ?? null,
    buy_price: p.price ?? null,
    stop_loss: p.sl ?? null,
    target: p.target ?? null,
    status: (p.status || 'open').toLowerCase(),
  }));

  console.log(`[migrate] user=${userId} exchange=${exchange} commit=${commit}`);
  console.log(`[migrate] watchlist rows: ${watchlistRows.length}`);
  console.log(`[migrate] portfolio rows: ${portfolioRows.length}`);

  if (!commit) {
    console.log('[migrate] DRY RUN — nothing written. Re-run with --commit to apply.');
    console.log(JSON.stringify({ watchlistRows, portfolioRows }, null, 2));
    return;
  }

  // 3. Write (idempotent for watchlists via the composite PK).
  if (watchlistRows.length) {
    const { error } = await supabase.from('watchlists').upsert(watchlistRows, { onConflict: 'user_id,exchange,symbol' });
    if (error) fail('watchlists upsert: ' + error.message);
  }
  if (portfolioRows.length) {
    const { error } = await supabase.from('portfolios').insert(portfolioRows);
    if (error) fail('portfolios insert: ' + error.message);
  }
  console.log('[migrate] done. Verify, then remove legacy kv keys (ni:wl, ni:p, ni:tl).');
}

main().catch((e) => fail(e?.message || e));

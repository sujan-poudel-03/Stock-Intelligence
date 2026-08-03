import { NextResponse } from 'next/server';

// Wrap a route handler so configuration / database problems return a tidy JSON
// error with a fix hint instead of leaking a raw 500 stack trace.
//
//   export const GET = withGuard(async (request) => { ... });
//
// The wrapped handler is called with the same arguments Next passes in
// (request, context).
export function withGuard(handler) {
  return async (...args) => {
    try {
      return await handler(...args);
    } catch (err) {
      return mapError(err);
    }
  };
}

// Edge/CDN cache header for GLOBAL, non-personalized read endpoints. Because market
// data is shared across all users (one scan serves everyone), the same response can
// be cached at Vercel's edge for `sMaxAge` seconds and served to every user without
// re-running the function or re-reading the DB — cost scales with scans, not loads.
// `stale-while-revalidate` serves the slightly-stale copy while one request refreshes
// it in the background, so no user ever waits on a cold recompute.
//
// ONLY for endpoints with no per-user/auth-specific output. When Phase 2 adds
// per-user filtering, personalized responses must NOT use this (they'd leak/cross
// cache between users) — revisit at that point.
export function edgeCache(sMaxAge, swr = sMaxAge * 2) {
  return { 'Cache-Control': `public, s-maxage=${sMaxAge}, stale-while-revalidate=${swr}` };
}

function mapError(err) {
  // Missing Supabase env vars (tagged in src/lib/supabase.js).
  if (err?.code === 'ENV_MISSING') {
    return NextResponse.json(
      {
        error: 'Database not configured',
        hint: 'Set SUPABASE_URL and SUPABASE_ANON_KEY in .env.local, then restart the server.',
      },
      { status: 503 }
    );
  }

  // PostgREST: table missing from the schema cache -> schema not applied.
  if (err?.code === 'PGRST205' || /schema cache/i.test(err?.message || '')) {
    return NextResponse.json(
      {
        error: 'Database schema not applied',
        hint: 'Run supabase/schema.sql in the Supabase SQL Editor.',
      },
      { status: 503 }
    );
  }

  console.error('Unhandled route error:', err?.message || err);
  return NextResponse.json(
    { error: 'Internal error', detail: err?.message || String(err) },
    { status: 500 }
  );
}

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

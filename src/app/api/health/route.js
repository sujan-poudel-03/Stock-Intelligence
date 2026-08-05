import { NextResponse } from 'next/server';
import { getSupabase, getServiceSupabase } from '@/lib/supabase';
import { EXPECTED_TABLES } from '@/lib/constants';
import { pingLLM } from '@/lib/llmPing';
import { remaining, dailyBudget } from '@/lib/budget';

export const dynamic = 'force-dynamic';

// Probe that the service-role key actually authenticates: a wrong/truncated key
// still builds a client but fails the query. Returns true (works), false (set but
// failing), or null (not set). Kept out of GET to keep its complexity down.
async function probeServiceRole() {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
  try {
    const svc = getServiceSupabase();
    const { error } = await svc.from('scans').select('id', { head: true, count: 'exact' }).limit(1);
    return !error;
  } catch {
    return false;
  }
}

// GET /api/health -> structured readiness report (env, db, schema).
// 200 when ok, 503 otherwise. Safe to call on Vercel where there is no local
// prestart check.
export async function GET() {
  const provider = (process.env.LLM_PROVIDER || 'gemini').toLowerCase();
  const llmKeyVar =
    provider === 'claude' || provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'GEMINI_API_KEY';

  const env = {
    supabase: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY),
    llm_key: Boolean(process.env[llmKeyVar]),
    // Phase 2: presence-only flag (never the value) so we can confirm the cron's
    // RLS-bypass write key is set before turning RLS on. Not yet required for
    // readiness — informational until the multi-tenant write path lands.
    service_role: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
  };

  const db = { reachable: false, tables_present: [], tables_missing: [] };

  if (env.supabase) {
    let supabase;
    try {
      supabase = getSupabase();
    } catch {
      supabase = null;
    }

    if (supabase) {
      for (const table of EXPECTED_TABLES) {
        const { error } = await supabase
          .from(table)
          .select('*', { count: 'exact', head: true })
          .limit(1);

        if (!error) {
          db.reachable = true;
          db.tables_present.push(table);
        } else if (error.code === 'PGRST205' || /schema cache/i.test(error.message || '')) {
          db.reachable = true; // reached PostgREST; table just doesn't exist
          db.tables_missing.push(table);
        } else {
          // Network / auth failure — leave reachable as-is and record the table
          // as missing so it shows up as not-ready.
          db.tables_missing.push(table);
        }
      }
    }
  }

  // Phase 2: validate the service-role key actually AUTHENTICATES against the DB
  // (env.service_role only proves the var is set; this proves it works).
  env.service_role_ok = await probeServiceRole();

  // Live provider ping — confirms the key authenticates and the API responds.
  const ping = await pingLLM({
    provider,
    geminiKey: process.env.GEMINI_API_KEY,
    anthropicKey: process.env.ANTHROPIC_API_KEY,
    timeoutMs: 6000,
  });
  const llm = {
    reachable: ping.ok,
    status: ping.status,
    detail: ping.detail,
    ...(ping.auth ? { auth_error: true } : {}),
  };

  const ok =
    env.supabase &&
    env.llm_key &&
    db.reachable &&
    db.tables_missing.length === 0 &&
    llm.reachable;

  // Daily call budget (informational — does not affect readiness).
  const budget = { daily: dailyBudget(), remaining: await remaining() };

  return NextResponse.json(
    {
      ok,
      provider,
      env,
      db,
      llm,
      budget,
      timestamp: new Date().toISOString(),
    },
    { status: ok ? 200 : 503 }
  );
}

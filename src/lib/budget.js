import { getSupabase } from './supabase.js';

// Daily LLM call budget — fits the scan inside a free-tier quota by spending a
// known number of requests per day and SKIPPING (never crashing) once spent.
//
// Usage is tracked in kv_store so it survives across serverless invocations —
// the scan worker self-chains across separate HTTP requests, so an in-memory
// counter would not persist. Tune the ceiling with the LLM_DAILY_BUDGET env var.

const USAGE_KEY = 'ni:llm_usage';
// gemini-2.5-flash free tier is ~250 requests/DAY (RPD); the per-MINUTE limit
// (~10–15 RPM) is the real constraint during a burst scan and is handled by the
// rate-limit backoff in llm.js — NOT by this daily ceiling. 100 leaves comfortable
// daily headroom for several scans + outcome checks. Tune with LLM_DAILY_BUDGET.
const DEFAULT_BUDGET = 100;

export function dailyBudget() {
  const n = Number(process.env.LLM_DAILY_BUDGET);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_BUDGET;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10); // UTC day; resets at 00:00 UTC
}

async function read(supabase) {
  const { data } = await supabase
    .from('kv_store')
    .select('value')
    .eq('key', USAGE_KEY)
    .maybeSingle();
  const v = data?.value;
  if (!v || v.date !== todayKey()) return { date: todayKey(), used: 0 };
  return { date: v.date, used: Number(v.used) || 0 };
}

async function write(supabase, used) {
  await supabase.from('kv_store').upsert(
    { key: USAGE_KEY, value: { date: todayKey(), used }, updated_at: new Date().toISOString() },
    { onConflict: 'key' }
  );
}

// Calls left today. Fails OPEN (returns the full budget) if kv is unreachable,
// so a storage blip never blocks the pipeline — callLLM still catches any 429.
export async function remaining() {
  try {
    const supabase = getSupabase();
    const { used } = await read(supabase);
    return Math.max(0, dailyBudget() - used);
  } catch {
    return dailyBudget();
  }
}

// Record n consumed calls (best-effort).
export async function spend(n = 1) {
  try {
    const supabase = getSupabase();
    const { used } = await read(supabase);
    await write(supabase, used + n);
  } catch {
    /* best-effort: budget tracking must never throw */
  }
}

// Mark the day's budget fully spent — called when the provider returns a real
// quota error so the rest of the scan skips instead of hammering the API.
export async function exhaust() {
  try {
    const supabase = getSupabase();
    await write(supabase, dailyBudget());
  } catch {
    /* best-effort */
  }
}

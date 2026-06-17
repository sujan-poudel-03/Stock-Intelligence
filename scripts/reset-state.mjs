// One-off maintenance: clear stuck scans + reset today's LLM budget.
// Run: node scripts/reset-state.mjs
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

// Minimal .env.local loader (no dotenv dependency).
for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});

// 1. Clear any scans stuck in pending/running so the 30-min guard won't block.
const { data: stuck } = await supabase
  .from('scans')
  .update({ status: 'error', error: 'manually cleared (stalled)', completed_at: new Date().toISOString() })
  .in('status', ['pending', 'running'])
  .select('id');
console.log(`cleared ${stuck?.length || 0} stuck scan(s)`);

// 2. Reset today's LLM usage to 0.
const today = new Date().toISOString().slice(0, 10);
await supabase.from('kv_store').upsert(
  { key: 'ni:llm_usage', value: { date: today, used: 0 }, updated_at: new Date().toISOString() },
  { onConflict: 'key' }
);
console.log(`reset ni:llm_usage for ${today} -> used: 0`);

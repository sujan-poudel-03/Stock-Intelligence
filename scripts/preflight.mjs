#!/usr/bin/env node
// Startup / doctor preflight check.
//
//   node scripts/preflight.mjs --mode=startup   (runs before npm dev/start)
//   node scripts/preflight.mjs --mode=doctor    (verbose, `npm run doctor`)
//
// startup: missing required env is FATAL (exit 1, blocks the server). Missing
//          tables only warn (best-effort, short timeout, never blocks).
// doctor:  verbose env + Supabase reachability + per-table report; exit 0.
//
// Dependency-free. Loads .env then .env.local (shell env wins over both).

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Inlined copy of src/lib/llmPing.js (kept here so this script stays a
// dependency-free standalone module — keep the two in sync). Hits the
// provider's "list models" endpoint: confirms the key authenticates and the
// API responds, with no generation / token cost.
async function pingLLM({ provider = 'gemini', geminiKey, anthropicKey, timeoutMs = 5000 } = {}) {
  const isClaude = provider === 'claude' || provider === 'anthropic';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (isClaude) {
      if (!anthropicKey) return { ok: false, status: 'NO_KEY', detail: 'ANTHROPIC_API_KEY missing' };
      const res = await fetch('https://api.anthropic.com/v1/models?limit=1', {
        headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
        signal: controller.signal,
      });
      return classifyPing(res);
    }
    if (!geminiKey) return { ok: false, status: 'NO_KEY', detail: 'GEMINI_API_KEY missing' };
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(geminiKey)}&pageSize=1`,
      { signal: controller.signal }
    );
    return classifyPing(res);
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    return {
      ok: false,
      status: aborted ? 'TIMEOUT' : 'NETWORK',
      detail: aborted ? `no response within ${timeoutMs}ms` : err?.message || 'network error',
    };
  } finally {
    clearTimeout(timer);
  }
}

function classifyPing(res) {
  if (res.ok) return { ok: true, status: res.status, detail: 'responding' };
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    return { ok: false, status: res.status, auth: true, detail: 'invalid or unauthorized key' };
  }
  return { ok: false, status: res.status, detail: `HTTP ${res.status}` };
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Keep in sync with EXPECTED_TABLES in src/lib/constants.js.
const EXPECTED_TABLES = [
  'kv_store',
  'signals',
  'scans',
  'scan_jobs',
  'weights',
  'outcomes',
  'alerts',
  'events',
  'knowledge',
  'corporate_actions', // TIER-1 #1 global corporate-action awareness (bonus/rights/div ex-dates)
  'system_watchlist', // GLOBAL curated/seed watchlist that seeds the scan union (public-read/service-write)
  // Phase 2 per-user tables (thin per-user layer; RLS added in a later step).
  'watchlists',
  'user_settings',
  'portfolios',
  'alert_prefs',
  'subscriptions', // tier/entitlement extension point (free by default)
  // TIER-2 per-user alert DELIVERY ledgers (email notifications). Owner-read,
  // service-write; gated behind schema-flag probes until migrated.
  'alert_deliveries',
  'outcome_deliveries',
  // Beginner flagship (§4.1) — SIMULATED paper-trading account. Per-user, owner-only
  // RLS; WRITE-ISOLATED from the scan chain; gated behind paperTradingReady() until migrated.
  'paper_accounts',
  'paper_positions',
];

// --- tiny output helpers ----------------------------------------------------
const useColor = !process.env.NO_COLOR && process.stdout.isTTY;
const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const ok = (s) => console.log(`${c('32', '✓')} ${s}`);
const bad = (s) => console.log(`${c('31', '✗')} ${s}`);
const warn = (s) => console.log(`${c('33', '⚠')} ${s}`);
const info = (s) => console.log(`  ${c('90', s)}`);
const head = (s) => console.log(`\n${c('1', s)}`);

// --- env loading ------------------------------------------------------------
function parseEnvFile(name) {
  const path = resolve(ROOT, name);
  if (!existsSync(path)) return {};
  const out = {};
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

// Next.js precedence: .env.local overrides .env; real shell env overrides both.
const fileEnv = { ...parseEnvFile('.env'), ...parseEnvFile('.env.local') };
const env = (key) => process.env[key] ?? fileEnv[key] ?? '';

// --- arg parsing ------------------------------------------------------------
const modeArg = process.argv.find((a) => a.startsWith('--mode='));
const mode = modeArg ? modeArg.split('=')[1] : 'doctor';
const isStartup = mode === 'startup';

// --- env checks -------------------------------------------------------------
const provider = (env('LLM_PROVIDER') || 'gemini').toLowerCase();
const llmKeyVar =
  provider === 'claude' || provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'GEMINI_API_KEY';

const required = [
  ['SUPABASE_URL', env('SUPABASE_URL')],
  ['SUPABASE_ANON_KEY', env('SUPABASE_ANON_KEY')],
  [llmKeyVar, env(llmKeyVar)],
];

const missing = required.filter(([, v]) => !v).map(([k]) => k);

head('NEPSE Intelligence — preflight');
info(`mode: ${mode} · provider: ${provider}`);

head('Environment');
for (const [key, val] of required) {
  if (val) ok(`${key} set`);
  else bad(`${key} missing`);
}

if (missing.length) {
  console.log('');
  bad(`Missing required env: ${missing.join(', ')}`);
  info('Set them in .env.local, then restart.');
  if (isStartup) {
    console.log('');
    bad('Refusing to start — fix the env above.');
    process.exit(1);
  }
}

// --- schema check (network) -------------------------------------------------
async function checkTables(timeoutMs) {
  const url = env('SUPABASE_URL');
  const key = env('SUPABASE_ANON_KEY');
  if (!url || !key) return null;

  const present = [];
  const missingTables = [];
  let reachable = false;

  for (const table of EXPECTED_TABLES) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${url}/rest/v1/${table}?select=*&limit=1`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
        signal: controller.signal,
      });
      reachable = true;
      if (res.ok) {
        present.push(table);
      } else {
        const body = await res.json().catch(() => ({}));
        if (body.code === 'PGRST205' || /schema cache/i.test(body.message || '')) {
          missingTables.push(table);
        } else {
          missingTables.push(table); // auth/other — treat as not-ready
        }
      }
    } catch {
      // network error / timeout — abort the whole check (best-effort)
      clearTimeout(timer);
      return { reachable, present, missingTables, aborted: true };
    } finally {
      clearTimeout(timer);
    }
  }
  return { reachable, present, missingTables, aborted: false };
}

// Probe whether a column exists by asking PostgREST to select it. 200 -> present;
// a 400 (undefined column / schema cache) -> absent; network error -> unknown.
async function checkColumn(table, column, timeoutMs) {
  const url = env('SUPABASE_URL');
  const key = env('SUPABASE_ANON_KEY');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/rest/v1/${table}?select=${column}&limit=1`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    if (res.ok) return { exists: true };
    return { exists: false };
  } catch {
    return { exists: null };
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  let fatal = false;

  // --- Supabase / schema ---
  if (env('SUPABASE_URL') && env('SUPABASE_ANON_KEY')) {
    head('Database');
    const result = await checkTables(isStartup ? 3000 : 8000);

    if (!result || result.aborted) {
      warn('Could not reach Supabase (network/timeout) — skipped schema check.');
    } else {
      if (result.reachable) ok('Supabase reachable, key authenticated');
      if (result.present.length) ok(`Tables present: ${result.present.join(', ')}`);
      if (result.missingTables.length) {
        bad(`Tables missing: ${result.missingTables.join(', ')}`);
        info('Run supabase/schema.sql in the Supabase SQL Editor to create them.');
        if (isStartup) fatal = true; // missing schema is a hard dependency failure
      } else if (result.present.length === EXPECTED_TABLES.length) {
        ok('All expected tables exist.');
      }

      // Doctor-only: report whether the optional time-decay migration is applied.
      if (!isStartup && result.present.includes('weights')) {
        const dec = await checkColumn('weights', 'dwins', isStartup ? 3000 : 8000);
        if (dec.exists === true) {
          ok('Time-decay migration applied (weights.dwins present).');
        } else if (dec.exists === false) {
          warn('Time-decay migration not applied (optional).');
          info('Apply supabase/migrations/20260724120000_weights_decay.sql in the SQL Editor — calibration works without it; decay activates once applied.');
        }
      }
    }
  }

  // --- LLM provider live ping ---
  head(`LLM (${provider})`);
  const llmKey = env(llmKeyVar);
  if (!llmKey) {
    bad(`${llmKeyVar} missing — cannot reach ${provider}.`);
  } else {
    const r = await pingLLM({
      provider,
      geminiKey: env('GEMINI_API_KEY'),
      anthropicKey: env('ANTHROPIC_API_KEY'),
      timeoutMs: isStartup ? 5000 : 8000,
    });
    if (r.ok) {
      ok(`${provider} responding (HTTP ${r.status})`);
    } else if (r.auth) {
      bad(`${provider} rejected the key (${r.detail}).`);
      info(`Check ${llmKeyVar} in .env.local.`);
      fatal = true; // invalid key is a hard failure
    } else {
      warn(`${provider} not responding (${r.status}: ${r.detail}) — skipped.`);
    }
  }

  // --- summary ---
  console.log('');
  if (missing.length) {
    bad('Not ready: required env missing.');
    process.exit(isStartup ? 1 : 0);
  }
  if (fatal) {
    bad('Not ready: required dependency unavailable (see ✗ above).');
    process.exit(isStartup ? 1 : 0);
  }
  ok('Preflight complete.');
  process.exit(0);
})();

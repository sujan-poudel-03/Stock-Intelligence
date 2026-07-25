#!/usr/bin/env node
// npm run deploy — apply pending Supabase migrations using the DB password already
// in your env. Uses `supabase db push --db-url`, which connects straight to Postgres
// and BYPASSES the management API (that 403s when the CLI account lacks project-admin
// rights). Reads .env then .env.local (real shell env wins over both).
//
//   SUPABASE_URL          -> project ref (host)
//   SUPABASE_DB_PASSWORD  -> the DB password (Project Settings -> Database)
//   SUPABASE_DB_URL       -> optional: a full connection string, used verbatim
//                            (set this to the Dashboard's Session-pooler URI if the
//                             direct db.<ref>.supabase.co host can't be reached).

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

// Merge .env then .env.local, but never let an EMPTY value override a real one —
// so a blank placeholder in one file can't mask a value set in the other.
function mergeNonEmpty(...sources) {
  const out = {};
  for (const src of sources) {
    for (const [k, v] of Object.entries(src)) {
      if (v != null && v !== '') out[k] = v;
    }
  }
  return out;
}
const fileEnv = mergeNonEmpty(parseEnvFile('.env'), parseEnvFile('.env.local'));
const env = (k) => {
  const shell = process.env[k];
  return shell != null && shell !== '' ? shell : (fileEnv[k] ?? '');
};

function fail(msg, hint) {
  console.error(`\n✗ ${msg}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(1);
}

// Build the connection URL: explicit SUPABASE_DB_URL wins; otherwise derive it from
// SUPABASE_URL (project ref) + SUPABASE_DB_PASSWORD (URL-encoded).
let dbUrl = env('SUPABASE_DB_URL');
if (!dbUrl) {
  const url = env('SUPABASE_URL');
  const password = env('SUPABASE_DB_PASSWORD');
  if (!url) fail('SUPABASE_URL not set', 'Add it to .env.local.');
  if (!password) {
    fail(
      'SUPABASE_DB_PASSWORD not set',
      'Set it in .env (Project Settings → Database → Database password), or set SUPABASE_DB_URL to a full connection string.'
    );
  }
  const m = url.match(/https?:\/\/([^.]+)\.supabase\.co/i);
  if (!m) fail(`Could not parse a project ref from SUPABASE_URL: ${url}`);
  dbUrl = `postgresql://postgres:${encodeURIComponent(password)}@db.${m[1]}.supabase.co:5432/postgres`;
}

const masked = dbUrl.replace(/(:\/\/[^:]+:)[^@]*(@)/, '$1****$2');
console.log(`\nApplying migrations → ${masked}\n`);

// Pass the URL through an env var so its special characters never hit shell parsing
// (cmd.exe %-expansion / bash quoting). The shell only expands the env-var reference.
const urlRef = process.platform === 'win32' ? '%SUPABASE_DEPLOY_URL%' : '"$SUPABASE_DEPLOY_URL"';
const res = spawnSync(`npx supabase db push --db-url ${urlRef}`, {
  env: { ...process.env, SUPABASE_DEPLOY_URL: dbUrl },
  input: 'y\n',
  stdio: ['pipe', 'inherit', 'inherit'],
  shell: true,
});

if (res.status === 0) {
  console.log('\n✓ Migrations applied. Verify with: npm run doctor');
  process.exit(0);
}

console.error('\n✗ Migration push failed (see output above). Common causes:');
console.error('  • "password authentication failed" → SUPABASE_DB_PASSWORD is wrong. Reset it at');
console.error('    Project Settings → Database → Reset database password, update .env, re-run.');
console.error('  • host unreachable (IPv6) → set SUPABASE_DB_URL to the Session-pooler URI from the Dashboard.');
process.exit(res.status || 1);

import { getSupabase } from './supabase.js';

// Qualitative knowledge base. The statistical `weights` table answers "how often
// has this kind of trade worked"; this answers "what have we actually learned".
// Per-symbol and per-sector notes accrue from resolved outcomes (deterministically
// — no LLM spend), and are injected back into the signal prompt via
// getKnowledgeContext(), so the agent reads its own track record of lessons when
// generating the next signal. Learned concepts/KPIs (kind 'concept'/'kpi') are
// populated later by Phase 3 external discovery.

const MAX_RECORDS = 8; // keep the most recent N outcome lines per note
const MAX_CONTENT = 1200; // hard cap on stored note length (chars)

function symbolKey(symbol) {
  return `SYMBOL_NOTE:${String(symbol).toUpperCase()}`;
}
function sectorKey(sector) {
  return `SECTOR_NOTE:${slug(sector)}`;
}

// Append one resolved-outcome record to a note, newest first, capped.
async function appendNote(supabase, { kind, key, line }) {
  if (!key || !line) return;

  const { data: existing } = await supabase
    .from('knowledge')
    .select('content, version')
    .eq('key', key)
    .maybeSingle();

  const prevLines = existing?.content ? existing.content.split('\n').filter(Boolean) : [];
  const nextLines = [line, ...prevLines].slice(0, MAX_RECORDS);
  let content = nextLines.join('\n');
  if (content.length > MAX_CONTENT) content = content.slice(0, MAX_CONTENT);

  await supabase.from('knowledge').upsert(
    {
      kind,
      key,
      content,
      source: 'outcomes',
      version: (existing?.version || 0) + 1,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'key' }
  );
}

/**
 * recordOutcomeKnowledge(supabase, sig, outcome, exitPrice, returnPct)
 * Turns one resolved signal into a durable, human-readable lesson line stored on
 * the symbol and sector notes. Best-effort: never throws into the outcome loop.
 */
export async function recordOutcomeKnowledge(supabase, sig, outcome, exitPrice, returnPct) {
  try {
    const date = new Date().toISOString().slice(0, 10);
    const ret = Number.isFinite(returnPct) ? `${returnPct >= 0 ? '+' : ''}${returnPct.toFixed(1)}%` : 'n/a';
    const why = sig.why ? ` — thesis: ${sig.why}` : '';
    const risk = outcome === 'LOSS' && sig.risk ? ` (flagged risk: ${sig.risk})` : '';
    const line = `[${date}] ${sig.signal} entry≈${sig.price ?? '?'} → ${outcome} ${ret} at ${exitPrice}${why}${risk}`;

    if (sig.symbol) {
      await appendNote(supabase, { kind: 'symbol_note', key: symbolKey(sig.symbol), line });
    }
    if (sig.sector) {
      const secLine = `[${date}] ${sig.symbol} ${sig.signal} → ${outcome} ${ret}`;
      await appendNote(supabase, { kind: 'sector_note', key: sectorKey(sig.sector), line: secLine });
    }
  } catch {
    /* best-effort: knowledge accrual must never break outcome resolution */
  }
}

/**
 * getKnowledgeContext(symbol, sector)
 * Returns a short string of accumulated lessons for prompt injection, e.g.:
 *   "NABIL history:\n[2026-06-10] BUY entry≈510 → WIN +6.2% at 542 ...\nHydropower notes: ..."
 * Returns '' when nothing has been learned yet.
 */
export async function getKnowledgeContext(symbol, sector) {
  const supabase = getSupabase();

  const wanted = [];
  if (symbol) wanted.push(symbolKey(symbol));
  if (sector) wanted.push(sectorKey(sector));
  if (!wanted.length) return '';

  const { data } = await supabase.from('knowledge').select('key, content').in('key', wanted);
  if (!data || !data.length) return '';

  const byKey = Object.fromEntries(data.map((k) => [k.key, k.content]));
  const parts = [];

  if (symbol && byKey[symbolKey(symbol)]) {
    parts.push(`${String(symbol).toUpperCase()} history:\n${byKey[symbolKey(symbol)]}`);
  }
  if (sector && byKey[sectorKey(sector)]) {
    parts.push(`${sector} sector notes:\n${byKey[sectorKey(sector)]}`);
  }

  return parts.join('\n\n');
}

function slug(s) {
  return String(s).trim().toLowerCase().replace(/\s+/g, '_');
}

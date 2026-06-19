import { geminiComplete, getGeminiModel } from './providers/gemini.js';
import { claudeComplete, getClaudeModel } from './providers/claude.js';
import { remaining, spend, exhaust } from './budget.js';

// LLM provider adapter. The rest of the app calls callLLM() and never depends
// on a specific vendor. Two ways to choose the model:
//   NEPSE_MODEL=<model>  single knob — sets the model AND infers the provider
//                        (e.g. claude-sonnet-4-6 -> claude, gemini-1.5-flash -> gemini)
//   LLM_PROVIDER=gemini|claude  + GEMINI_MODEL — used when NEPSE_MODEL is unset
// NEPSE_MODEL wins when set, so flipping a single var switches everything (handy
// for testing on Anthropic credits or a higher-quota Gemini model).

function modelIsClaude(m) {
  return /claude|anthropic|sonnet|opus|haiku/i.test(m || '');
}
function modelIsGemini(m) {
  return /gemini|gemma/i.test(m || '');
}

export function getProvider() {
  const m = process.env.NEPSE_MODEL || '';
  let want = null;
  if (modelIsClaude(m)) want = 'claude';
  else if (modelIsGemini(m)) want = 'gemini';
  if (!want) want = (process.env.LLM_PROVIDER || 'gemini').toLowerCase();
  if (want === 'anthropic') want = 'claude';

  // Graceful fallback: never select a provider we have no API key for, so a stale
  // NEPSE_MODEL can't silently break every call (the wrong-key footgun).
  if (want === 'claude' && !process.env.ANTHROPIC_API_KEY && process.env.GEMINI_API_KEY) {
    return 'gemini';
  }
  if (want === 'gemini' && !process.env.GEMINI_API_KEY && process.env.ANTHROPIC_API_KEY) {
    return 'claude';
  }
  return want;
}

export function getModel() {
  const provider = getProvider();
  const m = process.env.NEPSE_MODEL;
  // Honor NEPSE_MODEL only when it matches the resolved provider; otherwise the
  // provider's own default (so a claude model string never gets sent to Gemini).
  if (m && ((provider === 'claude' && modelIsClaude(m)) || (provider === 'gemini' && modelIsGemini(m)))) {
    return m;
  }
  return provider === 'claude' ? getClaudeModel() : getGeminiModel();
}

/**
 * callLLM(prompt, options) -> text string
 * options: { system, webSearch, webFetch, maxTokens, maxContinue, model }
 *
 * webSearch/webFetch map to the provider's grounding/web tools:
 *   - gemini: Google Search grounding
 *   - claude: web_search / web_fetch server tools
 */
export async function callLLM(prompt, options = {}) {
  const provider = getProvider();
  // Resolve the model once so NEPSE_MODEL drives whichever provider is selected.
  options = { ...options, model: options.model || getModel() };

  // Budget guard: skip cleanly when the daily quota is spent. Returning '' is
  // safe — every call site tolerates empty text (parseJson -> null -> defaults),
  // so the scan degrades to a partial result instead of crashing.
  if ((await remaining()) <= 0) {
    console.warn('[llm] daily budget exhausted — skipping call');
    return '';
  }

  // Retry loop. `spend(1)` only runs on a SUCCESSFUL complete(), so rejected
  // attempts never consume budget. Rate limits (per-minute) and transient
  // overloads are retried with backoff; only a true daily-quota error stops the
  // day via exhaust().
  const MAX_RETRIES = 3;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const text = await complete(provider, prompt, options);
      await spend(1);
      return text;
    } catch (err) {
      const kind = classifyError(err);

      // Daily quota (RPD / "PerDay" exhausted): stop spending for the rest of
      // the day. This is the ONLY path that calls exhaust().
      if (kind === 'quota') {
        await exhaust();
        console.warn('[llm] daily quota exhausted — skipping remaining calls today');
        return '';
      }

      // Per-minute rate limit or transient overload (429 RPM / 503): back off
      // and retry. Do NOT exhaust the day — these clear on their own.
      if ((kind === 'rate' || kind === 'transient') && attempt < MAX_RETRIES) {
        const fallback = kind === 'rate' ? 6000 : 4000;
        const waitMs = Math.min(retryDelayMs(err) ?? fallback * (attempt + 1), 30000);
        console.warn(
          `[llm] ${kind} error (attempt ${attempt + 1}/${MAX_RETRIES}) — retrying in ${waitMs}ms:`,
          err?.message || err
        );
        await sleep(waitMs);
        continue;
      }

      // Retries exhausted, or a non-retryable error (network, bad request,
      // parse): never crash the scan — skip this call.
      console.warn('[llm] call failed — skipping:', err?.message || err);
      return '';
    }
  }
}

async function complete(provider, prompt, options) {
  if (provider === 'claude' || provider === 'anthropic') {
    return claudeComplete(prompt, options);
  }
  return geminiComplete(prompt, options);
}

// Coarse error classification from status code or message text (SDKs vary).
//   'quota'     -> daily/RPD limit truly exhausted; stop for the day.
//   'rate'      -> per-minute (RPM/TPM) limit; transient, retry with backoff.
//   'transient' -> 5xx overload; retry with backoff.
//   'other'     -> non-retryable (network, bad request, parse).
// A 429 is the ambiguous case: free-tier Gemini returns it for BOTH per-minute
// limits and daily exhaustion. We only treat it as a daily 'quota' when the
// message clearly says so (per-day / RPD / daily) OR carries no retry hint;
// otherwise it's a recoverable per-minute 'rate' limit.
function classifyError(err) {
  const msg = (err?.message || String(err || '')).toLowerCase();
  const status = err?.status ?? err?.code;

  if (status === 503 || status === 500 || /unavailable|overloaded|high demand/.test(msg)) {
    return 'transient';
  }

  const isTooMany = status === 429 || /resource_exhausted|too many requests|rate limit/.test(msg);
  if (isTooMany) {
    const saysDaily = /per ?day|perday|\brpd\b|daily|per-day|requests per day/.test(msg);
    const saysPerMinute = /per ?minute|perminute|\brpm\b|\btpm\b|per-minute|requests per minute/.test(msg);
    const hasRetryHint = retryDelayMs(err) != null;
    // Daily only when explicitly stated, or when it's a bare quota error with no
    // per-minute signal and no short retry hint to wait on.
    if (saysDaily) return 'quota';
    if (saysPerMinute || hasRetryHint) return 'rate';
    return /quota/.test(msg) ? 'quota' : 'rate';
  }

  return 'other';
}

// Pull a retry hint (seconds) out of a provider error -> milliseconds, or null.
// Matches both the RetryInfo JSON field and the human "Please retry in Ns" prose.
function retryDelayMs(err) {
  const msg = err?.message || String(err || '');
  const m =
    msg.match(/retrydelay["']?\s*:\s*["']?(\d+(?:\.\d+)?)\s*s/i) ||
    msg.match(/retry in (\d+(?:\.\d+)?)\s*s/i);
  return m ? Math.ceil(parseFloat(m[1]) * 1000) : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Parse a JSON object/array out of an LLM text response, tolerating code fences
// and surrounding prose. Returns null if nothing parseable is found.
export function parseJson(text) {
  if (!text) return null;

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;

  try {
    return JSON.parse(candidate.trim());
  } catch {
    const span = candidate.match(/[{[][\s\S]*[}\]]/);
    if (!span) return null;
    try {
      return JSON.parse(span[0]);
    } catch {
      return null;
    }
  }
}

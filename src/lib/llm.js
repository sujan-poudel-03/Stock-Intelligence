import { geminiComplete, getGeminiModel } from './providers/gemini.js';
import { claudeComplete, getClaudeModel } from './providers/claude.js';
import { remaining, spend, exhaust } from './budget.js';

// LLM provider adapter. The rest of the app calls callLLM() and never depends
// on a specific vendor. Switch providers with the LLM_PROVIDER env var:
//   LLM_PROVIDER=gemini  (default, used for the initial build)
//   LLM_PROVIDER=claude  (switch once the Claude path is ready)

export function getProvider() {
  return (process.env.LLM_PROVIDER || 'gemini').toLowerCase();
}

export function getModel() {
  return getProvider() === 'claude' || getProvider() === 'anthropic'
    ? getClaudeModel()
    : getGeminiModel();
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

  // Budget guard: skip cleanly when the daily quota is spent. Returning '' is
  // safe — every call site tolerates empty text (parseJson -> null -> defaults),
  // so the scan degrades to a partial result instead of crashing.
  if ((await remaining()) <= 0) {
    console.warn('[llm] daily budget exhausted — skipping call');
    return '';
  }

  try {
    const text = await complete(provider, prompt, options);
    await spend(1);
    return text;
  } catch (err) {
    const kind = classifyError(err);

    // Transient overload (503 / UNAVAILABLE): one bounded retry, honouring the
    // provider's RetryInfo delay when present.
    if (kind === 'transient') {
      const waitMs = Math.min(retryDelayMs(err) ?? 4000, 15000);
      console.warn(`[llm] transient error — retrying in ${waitMs}ms:`, err?.message || err);
      await sleep(waitMs);
      try {
        const text = await complete(provider, prompt, options);
        await spend(1);
        return text;
      } catch (err2) {
        if (classifyError(err2) === 'quota') await exhaust();
        console.warn('[llm] retry failed — skipping:', err2?.message || err2);
        return '';
      }
    }

    // Quota (429 / RESOURCE_EXHAUSTED): stop spending for the rest of the day.
    if (kind === 'quota') {
      await exhaust();
      console.warn('[llm] quota exhausted — skipping remaining calls today');
      return '';
    }

    // Anything else (network, bad request, parse): never crash the scan.
    console.warn('[llm] call failed — skipping:', err?.message || err);
    return '';
  }
}

async function complete(provider, prompt, options) {
  if (provider === 'claude' || provider === 'anthropic') {
    return claudeComplete(prompt, options);
  }
  return geminiComplete(prompt, options);
}

// Coarse error classification from status code or message text (SDKs vary).
function classifyError(err) {
  const msg = (err?.message || String(err || '')).toLowerCase();
  const status = err?.status ?? err?.code;
  if (status === 429 || /resource_exhausted|quota|too many requests/.test(msg)) return 'quota';
  if (status === 503 || status === 500 || /unavailable|overloaded|high demand/.test(msg)) {
    return 'transient';
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

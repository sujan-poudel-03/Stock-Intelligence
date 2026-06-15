import { geminiComplete, getGeminiModel } from './providers/gemini.js';
import { claudeComplete, getClaudeModel } from './providers/claude.js';

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
  if (provider === 'claude' || provider === 'anthropic') {
    return claudeComplete(prompt, options);
  }
  return geminiComplete(prompt, options);
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

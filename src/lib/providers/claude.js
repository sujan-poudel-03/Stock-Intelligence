import Anthropic from '@anthropic-ai/sdk';

// Claude provider. Mirrors the Gemini provider's interface so it can be swapped
// in by setting LLM_PROVIDER=claude. Handles the server-tool pause_turn loop.

let _client = null;
function getClient() {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY env var');
  _client = new Anthropic({ apiKey });
  return _client;
}

export function getClaudeModel() {
  return process.env.NEPSE_MODEL || 'claude-sonnet-4-6';
}

const WEB_SEARCH_TOOL = { type: 'web_search_20260209', name: 'web_search' };
const WEB_FETCH_TOOL = { type: 'web_fetch_20260209', name: 'web_fetch' };

/**
 * claudeComplete(prompt, options) -> text string
 * options: { system, webSearch, webFetch, maxTokens, maxContinue, model }
 */
export async function claudeComplete(prompt, options = {}) {
  const {
    system,
    webSearch = false,
    webFetch = false,
    maxTokens = 4096,
    maxContinue = 6,
    model = getClaudeModel(),
  } = options;

  const client = getClient();

  const tools = [];
  if (webSearch) tools.push(WEB_SEARCH_TOOL);
  if (webFetch) tools.push(WEB_FETCH_TOOL);

  const messages = [{ role: 'user', content: prompt }];
  const baseParams = { model, max_tokens: maxTokens, messages };
  if (system) baseParams.system = system;
  if (tools.length) baseParams.tools = tools;

  let response = await client.messages.create(baseParams);

  // Resume while the API pauses mid server-tool run.
  let continuations = 0;
  while (response.stop_reason === 'pause_turn' && continuations < maxContinue) {
    messages.push({ role: 'assistant', content: response.content });
    response = await client.messages.create({ ...baseParams, messages });
    continuations += 1;
  }

  return extractText(response);
}

function extractText(response) {
  if (!response?.content) return '';
  return response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();
}

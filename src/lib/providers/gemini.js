import { GoogleGenAI } from '@google/genai';

// Gemini provider. Uses Google Search grounding as the equivalent of Claude's
// web_search / web_fetch server tools — grounding runs server-side and the SDK
// returns the final grounded text directly (no pause/continue loop needed).

let _client = null;
function getClient() {
  if (_client) return _client;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Missing GEMINI_API_KEY env var');
  _client = new GoogleGenAI({ apiKey });
  return _client;
}

export function getGeminiModel() {
  return process.env.GEMINI_MODEL || 'gemini-2.5-flash';
}

/**
 * geminiComplete(prompt, options) -> text string
 * options: { system, webSearch, webFetch, maxTokens, model }
 * webSearch/webFetch both enable the Google Search grounding tool.
 */
export async function geminiComplete(prompt, options = {}) {
  const {
    system,
    webSearch = false,
    webFetch = false,
    maxTokens = 4096,
    model = getGeminiModel(),
  } = options;

  const ai = getClient();

  const config = { maxOutputTokens: maxTokens };
  if (system) config.systemInstruction = system;
  if (webSearch || webFetch) config.tools = [{ googleSearch: {} }];

  const response = await ai.models.generateContent({
    model,
    contents: prompt,
    config,
  });

  return (response.text || '').trim();
}
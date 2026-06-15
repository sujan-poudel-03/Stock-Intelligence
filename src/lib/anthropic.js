// Deprecated: use src/lib/llm.js instead.
// Kept as a thin shim so any lingering imports keep working. callClaude is now
// an alias for the provider-agnostic callLLM (provider chosen via LLM_PROVIDER).
import { callLLM, parseJson, getModel } from './llm.js';

export const callClaude = callLLM;
export { callLLM, parseJson, getModel };

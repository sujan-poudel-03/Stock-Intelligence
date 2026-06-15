// Live LLM provider reachability check. Hits the provider's lightweight
// "list models" endpoint to confirm the key authenticates and the API responds
// — no generation, so no token cost. Pure ESM (fetch only) so it can be imported
// by both the Next health route (@/) and the standalone preflight script.
//
// pingLLM({ provider, geminiKey, anthropicKey, timeoutMs }) ->
//   { ok, status, auth, detail }
//     ok    - true if the API responded with success
//     status- 'NO_KEY' | 'TIMEOUT' | 'NETWORK' | <http status number>
//     auth  - true when the failure is an authentication/invalid-key error
//     detail- short human description

export async function pingLLM({
  provider = 'gemini',
  geminiKey,
  anthropicKey,
  timeoutMs = 5000,
} = {}) {
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
      return classify(res);
    }

    if (!geminiKey) return { ok: false, status: 'NO_KEY', detail: 'GEMINI_API_KEY missing' };
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(geminiKey)}&pageSize=1`,
      { signal: controller.signal }
    );
    return classify(res);
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

function classify(res) {
  if (res.ok) return { ok: true, status: res.status, detail: 'responding' };
  // 400 (Gemini invalid key), 401, 403 -> bad/unauthorized key.
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    return { ok: false, status: res.status, auth: true, detail: 'invalid or unauthorized key' };
  }
  return { ok: false, status: res.status, detail: `HTTP ${res.status}` };
}

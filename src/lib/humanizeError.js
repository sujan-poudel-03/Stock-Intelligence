// Turns a raw provider/worker error string into a short, human-readable line for
// the UI. Provider errors (e.g. Gemini's 429) arrive as large JSON blobs; we
// never want to dump those at the user. Returns { kind, message } where kind is
// one of 'quota' | 'busy' | 'budget' | 'auth' | 'network' | 'unknown' — the UI
// uses kind for badge colour and whether a Retry is worthwhile.
export function humanizeError(raw) {
  const text = String(raw || '').trim();
  if (!text) return { kind: 'unknown', message: 'Unknown error' };

  const lower = text.toLowerCase();

  // Our own budget guard (worker marks jobs 'skipped' with this message).
  if (lower.includes('daily llm budget') || lower.includes('daily ai budget')) {
    return { kind: 'budget', message: 'Skipped — daily AI budget reached' };
  }

  // Gemini free-tier daily quota (429 / RESOURCE_EXHAUSTED).
  if (
    lower.includes('resource_exhausted') ||
    lower.includes('exceeded your current quota') ||
    /"code"\s*:\s*429/.test(text) ||
    lower.includes('rate-limit')
  ) {
    const retry = retrySeconds(text);
    const when = retry ? ` Retry in ~${formatDuration(retry)}.` : '';
    return { kind: 'quota', message: `Daily AI quota reached (free tier).${when}` };
  }

  // Transient upstream overload (503 / UNAVAILABLE / 500).
  if (
    lower.includes('unavailable') ||
    lower.includes('overloaded') ||
    /"code"\s*:\s*50[03]/.test(text)
  ) {
    return { kind: 'busy', message: 'AI service busy — temporary. Try again.' };
  }

  // Auth / key problems.
  if (
    lower.includes('api key') ||
    lower.includes('permission_denied') ||
    lower.includes('unauthenticated') ||
    /"code"\s*:\s*40[13]/.test(text)
  ) {
    return { kind: 'auth', message: 'AI key rejected — check API key.' };
  }

  // Network / timeout.
  if (lower.includes('timeout') || lower.includes('econn') || lower.includes('fetch failed')) {
    return { kind: 'network', message: 'Network error reaching AI service.' };
  }

  // Fall back to a clipped first line so the UI never shows a raw blob.
  return { kind: 'unknown', message: firstLine(text, 120) };
}

function retrySeconds(text) {
  const m =
    text.match(/retry in\s+(\d+(?:\.\d+)?)\s*s/i) ||
    text.match(/"retrydelay"\s*:\s*"?(\d+(?:\.\d+)?)\s*s/i);
  return m ? Math.round(Number(m[1])) : null;
}

function formatDuration(sec) {
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  return min < 60 ? `${min}m` : `${Math.round(min / 60)}h`;
}

function firstLine(text, max) {
  // Strip JSON noise to a readable sentence if we can find a "message" field.
  const m = text.match(/"message"\s*:\s*"([^"]+)"/);
  const base = (m ? m[1] : text).replace(/\s+/g, ' ').trim();
  return base.length > max ? `${base.slice(0, max - 1)}…` : base;
}
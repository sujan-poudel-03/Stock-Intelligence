// Turns a raw provider/worker error string into a short, human-readable line for
// the UI. Provider errors (e.g. Gemini's 429) arrive as large JSON blobs; we
// never want to dump those at the user. Returns { kind, message } where kind is
// one of 'quota' | 'busy' | 'budget' | 'auth' | 'network' | 'price' | 'unknown' —
// the UI uses kind for badge colour and whether a Retry is worthwhile.
export function humanizeError(raw) {
  const text = String(raw || '').trim();
  if (!text) return { kind: 'unknown', message: 'Unknown error' };

  const lower = text.toLowerCase();

  // Our own budget guard (worker marks jobs 'skipped' with this message).
  if (lower.includes('daily llm budget') || lower.includes('daily ai budget')) {
    return { kind: 'budget', message: 'Skipped — daily AI budget reached' };
  }

  // Verified-price layer rejection (src/lib/scan.js scanOneStock — see
  // src/lib/marketData.js reconcile() for the reason vocabulary). This is the
  // "why did the data fetch fail" answer admin actually needs, not a generic
  // "unknown error": surfaces WHICH sources were tried and WHY the quote(s)
  // they returned were rejected (disagreed, implausible move, none sane, etc).
  const priceFail = text.match(/^no data from source: (\S+) \[([^\]]+)\](?:\s*\(tried: ([^)]*)\))?(?:\s*\{([^}]*)\})?/i);
  if (priceFail) {
    const [, sym, reason, tried, detail] = priceFail;
    const reasonText = describePriceRejection(reason, detail);
    const triedText = tried ? ` (tried: ${tried})` : ' (no source responded)';
    return { kind: 'price', message: `${sym}: price verification failed — ${reasonText}${triedText}` };
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

// describePriceRejection(reason, detail) -> a plain-English reason for a
// verified-price rejection. `reason` is reconcile()'s top-level vocabulary
// (src/lib/marketData.js); `detail` (only present for 'no-sane-quote') is the
// serialized per-source sanity-check breakdown, e.g. "merolagani:non-positive-price".
function describePriceRejection(reason, detail) {
  if (reason === 'no-providers') return 'no price source is configured/active for this exchange';
  if (reason === 'single-source') return 'only one source responded and two are required';
  if (reason === 'stale') return 'the only available quote is too old to trust';
  if (reason.startsWith('disagreement:')) {
    return `sources disagreed by ${reason.slice('disagreement:'.length)} (over the allowed tolerance)`;
  }
  if (reason === 'no-sane-quote') {
    if (!detail) return 'no source returned a quote that passed the sanity check';
    const parts = detail.split(',').map((d) => {
      const [source, ...rest] = d.split(':');
      const why = rest.join(':');
      if (why === 'non-positive-price') return `${source} returned a zero/negative price`;
      if (why === 'no-price') return `${source} returned no price at all`;
      if (why.startsWith('implausible-move:')) return `${source}'s quote moved ${why.slice('implausible-move:'.length)} vs previous close (implausible)`;
      return `${source}: ${why}`;
    });
    return parts.join('; ');
  }
  return reason;
}

function firstLine(text, max) {
  // Strip JSON noise to a readable sentence if we can find a "message" field.
  const m = text.match(/"message"\s*:\s*"([^"]+)"/);
  const base = (m ? m[1] : text).replace(/\s+/g, ' ').trim();
  return base.length > max ? `${base.slice(0, max - 1)}…` : base;
}
// Per-user alert preferences shape (pure + deterministic, so it's unit-testable).
//
// A user chooses which delivery channels ping THEM and which signal directions
// trigger an alert. Both are stored as jsonb columns on the owner-only `alert_prefs`
// table; this normalizer pins them to a KNOWN, boolean-coerced shape so a client
// can't stuff arbitrary keys into the jsonb, and so a read always returns a full,
// defined object the UI can bind to.

export const ALERT_CHANNELS = ['email', 'telegram'];
export const ALERT_THRESHOLDS = ['onBuy', 'onSell'];

function pickBooleans(obj, keys) {
  const src = obj && typeof obj === 'object' ? obj : {};
  const out = {};
  for (const k of keys) out[k] = Boolean(src[k]);
  return out;
}

// normalizeAlertPrefs(body) -> { channels: {email,telegram}, thresholds: {onBuy,onSell} }
// Always returns every known key as a boolean, whatever the input.
export function normalizeAlertPrefs(body = {}) {
  return {
    channels: pickBooleans(body?.channels, ALERT_CHANNELS),
    thresholds: pickBooleans(body?.thresholds, ALERT_THRESHOLDS),
  };
}

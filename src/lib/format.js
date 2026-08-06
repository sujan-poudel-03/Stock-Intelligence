// Pure UI formatters + predicates, extracted here so they are importable and
// unit-tested (the JSX in NepseApp/AuthPanel itself is not unit-tested). Keep these
// side-effect-free and defensive — every one gets fed live/unverified data.

// Mask an email for display: keep the first character of the local part, replace the
// rest with a short bullet run, keep the full domain. Malformed / non-string input is
// returned unchanged (or '' for non-strings) so a display never throws.
//   maskEmail('alice@example.com') -> 'a•••@example.com'
//   maskEmail('a@x.com')           -> 'a•••@x.com'
export function maskEmail(email) {
  if (typeof email !== 'string') return '';
  const at = email.indexOf('@');
  if (at < 1) return email; // no '@' or empty local part — nothing to mask
  return email[0] + '•••' + email.slice(at);
}

// "as of HH:MM" from a millisecond epoch (a verified quote's `asOf`). Returns '' when
// the input is missing/unparseable so the caller can render nothing gracefully. Uses
// the browser's local time, matching the rest of the UI's toLocaleTimeString usage.
export function asOfLabel(asOf) {
  if (asOf == null) return '';
  const d = new Date(asOf);
  if (!Number.isFinite(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return 'as of ' + hh + ':' + mm;
}

// Alert-channel setup warning predicate: true only when the user ENABLED a channel
// that the server cannot actually deliver on (its required env is not configured).
// `configured === false` on purpose — an unknown/undefined state (channels not yet
// fetched) must NOT warn.
export function channelNeedsSetup(enabled, configured) {
  return !!enabled && configured === false;
}

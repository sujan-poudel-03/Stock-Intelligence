// Scan schedule helpers. The actual triggers are Vercel crons in vercel.json;
// this mirrors them so the UI can show the next/last run time.
//
// KEEP IN SYNC with vercel.json `crons[].schedule` (same convention as
// EXPECTED_TABLES <-> scripts/preflight.mjs). Vercel crons run in UTC.
//
// NEPSE trades Sun–Thu, 11:00–15:00 NPT (UTC+5:45). Tiered cadence, in UTC:
//   45 3 * * 0-4        -> 09:30 NPT  full pre-open scan
//   15,45 5-8 * * 0-4   -> 11:00–14:30 NPT every 30 min, light intraday scans
//   45 9 * * 0-4        -> 15:30 NPT  full post-close scan (signals + outcomes)
export const SCAN_CRONS = ['45 3 * * 0-4', '15,45 5-8 * * 0-4', '45 9 * * 0-4'];

// nextScanRunIso(fromMs): ISO timestamp of the soonest scheduled run strictly
// after `fromMs` across all SCAN_CRONS. Returns null if none can be parsed (the UI
// then hides "Next scan"). Supports `minute hour * * dow` where minute/hour/dow may
// be "*", a list "a,b", a range "a-b", or a step "*/n"; day-of-month and month must
// be "*" (all our schedules are daily, weekday-filtered).
export function nextScanRunIso(fromMs = Date.now()) {
  const candidates = SCAN_CRONS.map((c) => nextRunForCron(c, fromMs)).filter(Boolean);
  if (!candidates.length) return null;
  return candidates.sort()[0]; // ISO strings sort chronologically
}

function nextRunForCron(cron, fromMs) {
  const parts = String(cron).trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const [min, hour, dom, mon, dow] = parts;
  if (dom !== '*' || mon !== '*') return null;

  const minutes = parseField(min, 0, 59);
  const hours = parseField(hour, 0, 23);
  const days = parseDow(dow);
  if (!minutes || !hours || !days) return null;

  const sortedH = [...hours].sort((a, b) => a - b);
  const sortedM = [...minutes].sort((a, b) => a - b);
  const from = new Date(fromMs);
  const y = from.getUTCFullYear();
  const mo = from.getUTCMonth();
  const d = from.getUTCDate();

  for (let off = 0; off < 8; off += 1) {
    const day = new Date(Date.UTC(y, mo, d + off));
    if (!days.has(day.getUTCDay())) continue;
    for (const h of sortedH) {
      for (const m of sortedM) {
        const cand = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h, m, 0, 0);
        if (cand > fromMs) return new Date(cand).toISOString();
      }
    }
  }
  return null;
}

// Parse a numeric cron field into a Set of allowed values in [min,max].
// Supports "*", "a", "a-b", "a,b,c", "*/n", "a-b/n" (and comma combinations).
function parseField(field, min, max) {
  const out = new Set();
  for (const token of String(field).split(',')) {
    const [rangePart, stepPart] = token.split('/');
    const step = stepPart ? Number(stepPart) : 1;
    if (!Number.isInteger(step) || step < 1) return null;

    let lo;
    let hi;
    if (rangePart === '*') {
      lo = min;
      hi = max;
    } else {
      const range = rangePart.match(/^(\d+)-(\d+)$/);
      if (range) {
        lo = Number(range[1]);
        hi = Number(range[2]);
      } else if (/^\d+$/.test(rangePart)) {
        lo = hi = Number(rangePart);
      } else {
        return null;
      }
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out.size ? out : null;
}

// Day-of-week field -> Set of days (0=Sun … 6=Sat). Cron allows 7 as Sunday too.
function parseDow(field) {
  if (field === '*') return new Set([0, 1, 2, 3, 4, 5, 6]);
  const out = new Set();
  for (const token of field.split(',')) {
    const range = token.match(/^(\d)-(\d)$/);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      if (a > b) return null;
      for (let v = a; v <= b; v += 1) out.add(v % 7);
    } else if (/^\d$/.test(token)) {
      out.add(Number(token) % 7);
    } else {
      return null;
    }
  }
  return out.size ? out : null;
}

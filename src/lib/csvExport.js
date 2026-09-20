// CSV export — closes the "no portable trade history" gap from the trader/
// product review (traders reconcile against their broker and need records for
// their own tax filing; right now the only record was on-screen). Pure builder
// (RFC 4180 escaping) + a browser-only download trigger.

// toCsv(rows, columns): columns = [{ label, key? , value?(row) }]. Exactly one of
// key/value per column — value(row) wins when both are given. Every field is
// escaped per RFC 4180 (wrapped in quotes when it contains a comma, quote, or
// newline; inner quotes doubled). Never throws on odd input — a bad row/column
// just stringifies to '' rather than crashing an export.
export function toCsv(rows, columns) {
  const cols = Array.isArray(columns) ? columns : [];
  const list = Array.isArray(rows) ? rows : [];
  const escape = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const header = cols.map((c) => escape(c.label)).join(',');
  const lines = list.map((r) =>
    cols
      .map((c) => {
        try {
          return escape(typeof c.value === 'function' ? c.value(r) : r?.[c.key]);
        } catch {
          return '';
        }
      })
      .join(',')
  );
  return [header, ...lines].join('\r\n');
}

// downloadCsv(filename, csvText): triggers a browser file download via a Blob +
// temporary <a download>. No-op on the server (SSR-safe) or if the DOM is
// unavailable — never throws into a click handler.
export function downloadCsv(filename, csvText) {
  try {
    if (typeof document === 'undefined') return;
    const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch {
    /* best-effort — a failed download click must never crash the caller */
  }
}

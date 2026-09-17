import { describe, it, expect } from 'vitest';
import { toCsv } from '../src/lib/csvExport.js';

describe('toCsv', () => {
  it('builds a header row from column labels', () => {
    const csv = toCsv([], [{ label: 'Symbol', key: 'symbol' }, { label: 'Qty', key: 'qty' }]);
    expect(csv).toBe('Symbol,Qty');
  });

  it('reads values by key', () => {
    const csv = toCsv([{ symbol: 'NABIL', qty: 10 }], [{ label: 'Symbol', key: 'symbol' }, { label: 'Qty', key: 'qty' }]);
    expect(csv).toBe('Symbol,Qty\r\nNABIL,10');
  });

  it('prefers a value(row) function over key when both are given', () => {
    const csv = toCsv([{ qty: 10 }], [{ label: 'Doubled', key: 'qty', value: (r) => r.qty * 2 }]);
    expect(csv).toBe('Doubled\r\n20');
  });

  it('escapes a field containing a comma', () => {
    const csv = toCsv([{ note: 'target hit, sold' }], [{ label: 'Note', key: 'note' }]);
    expect(csv).toBe('Note\r\n"target hit, sold"');
  });

  it('escapes a field containing a double quote by doubling it', () => {
    const csv = toCsv([{ note: 'he said "sell"' }], [{ label: 'Note', key: 'note' }]);
    expect(csv).toBe('Note\r\n"he said ""sell"""');
  });

  it('escapes a field containing a newline', () => {
    const csv = toCsv([{ note: 'line1\nline2' }], [{ label: 'Note', key: 'note' }]);
    expect(csv).toBe('Note\r\n"line1\nline2"');
  });

  it('renders null/undefined values as an empty field', () => {
    const csv = toCsv([{ a: null, b: undefined }], [{ label: 'A', key: 'a' }, { label: 'B', key: 'b' }]);
    expect(csv).toBe('A,B\r\n,');
  });

  it('never throws when a value(row) accessor itself throws', () => {
    const csv = toCsv([{}], [{ label: 'Bad', value: () => { throw new Error('boom'); } }]);
    expect(csv).toBe('Bad\r\n');
  });

  it('handles multiple rows in order', () => {
    const csv = toCsv(
      [{ symbol: 'A' }, { symbol: 'B' }],
      [{ label: 'Symbol', key: 'symbol' }]
    );
    expect(csv).toBe('Symbol\r\nA\r\nB');
  });

  it('tolerates non-array rows/columns without throwing', () => {
    expect(toCsv(null, null)).toBe('');
    expect(toCsv(undefined, [{ label: 'X', key: 'x' }])).toBe('X');
  });
});

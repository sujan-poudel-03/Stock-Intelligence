import { describe, it, expect } from 'vitest';
import { normalizeAlertPrefs, ALERT_CHANNELS, ALERT_THRESHOLDS } from '../src/lib/alertPrefs.js';

describe('normalizeAlertPrefs (per-user alert prefs)', () => {
  it('returns every known key as a boolean, defaulting to false', () => {
    expect(normalizeAlertPrefs()).toEqual({
      channels: { email: false, telegram: false },
      thresholds: { onBuy: false, onSell: false },
    });
    expect(normalizeAlertPrefs({})).toEqual({
      channels: { email: false, telegram: false },
      thresholds: { onBuy: false, onSell: false },
    });
  });

  it('coerces truthy/falsy inputs to strict booleans', () => {
    const out = normalizeAlertPrefs({
      channels: { email: 1, telegram: 0 },
      thresholds: { onBuy: 'yes', onSell: null },
    });
    expect(out).toEqual({
      channels: { email: true, telegram: false },
      thresholds: { onBuy: true, onSell: false },
    });
  });

  it('drops unknown keys — the client cannot stuff arbitrary jsonb fields', () => {
    const out = normalizeAlertPrefs({
      channels: { email: true, sms: true, __proto__: true },
      thresholds: { onBuy: true, onHold: true },
    });
    expect(out.channels).toEqual({ email: true, telegram: false });
    expect(out.thresholds).toEqual({ onBuy: true, onSell: false });
    expect(Object.keys(out.channels)).toEqual(ALERT_CHANNELS);
    expect(Object.keys(out.thresholds)).toEqual(ALERT_THRESHOLDS);
  });

  it('tolerates non-object channel/threshold blobs', () => {
    expect(normalizeAlertPrefs({ channels: null, thresholds: 'x' })).toEqual({
      channels: { email: false, telegram: false },
      thresholds: { onBuy: false, onSell: false },
    });
  });
});

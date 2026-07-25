import { describe, it, expect } from 'vitest';
import { listChannels, configuredChannels, formatScanDigest } from '../src/lib/notify.js';

describe('notification channels (config-gated)', () => {
  it('marks a channel configured only when all its env is present', () => {
    const list = listChannels({ RESEND_API_KEY: 'x' });
    const byId = Object.fromEntries(list.map((c) => [c.id, c]));
    expect(byId.email.configured).toBe(true);
    expect(byId.telegram.configured).toBe(false); // needs both token + chat id
  });

  it('telegram needs BOTH token and chat id', () => {
    expect(listChannels({ TELEGRAM_BOT_TOKEN: 't' }).find((c) => c.id === 'telegram').configured).toBe(false);
    const both = { TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '1' };
    expect(listChannels(both).find((c) => c.id === 'telegram').configured).toBe(true);
  });

  it('configuredChannels returns only channels with their env set', () => {
    expect(configuredChannels({}).map((c) => c.id)).toEqual([]);
    expect(configuredChannels({ RESEND_API_KEY: 'x', TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '1' }).map((c) => c.id))
      .toEqual(['email', 'telegram']);
  });

  it('does not leak send functions to metadata', () => {
    expect(listChannels({}).every((c) => c.send === undefined)).toBe(true);
  });
});

describe('formatScanDigest', () => {
  it('flags a healthy scan and includes top picks + not-advice line', () => {
    const d = formatScanDigest({
      status: 'done',
      brief: { headline: 'NEPSE up', summary: 'Broad strength.', topPicks: ['NABIL', 'UPPER'] },
      signals: 5,
      actionable: 2,
    });
    expect(d.title).toContain('✅');
    expect(d.text).toContain('Top picks: NABIL, UPPER');
    expect(d.text).toContain('5 signals · 2 actionable');
    expect(d.text).toContain('not financial advice');
  });

  it('flags a partial scan and reports failures (the health alert)', () => {
    const d = formatScanDigest({ status: 'partial', brief: {}, signals: 3, actionable: 1, failed: 2, skipped: 1 });
    expect(d.title).toContain('PARTIAL');
    expect(d.text).toContain('2 failed, 1 skipped');
  });
});

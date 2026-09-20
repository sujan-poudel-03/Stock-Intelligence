import { describe, it, expect } from 'vitest';
import { listChannels, configuredChannels, formatScanDigest, deliverPush } from '../src/lib/notify.js';

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

  it('push is reported but never part of the operator-digest fan-out', () => {
    const env = { VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv' };
    const push = listChannels(env).find((c) => c.id === 'push');
    expect(push.configured).toBe(true);
    // configuredChannels() drives notify()'s operator digest — push has no
    // operator subscription to send to, so it must never appear here.
    expect(configuredChannels(env).map((c) => c.id)).not.toContain('push');
  });

  it('push needs BOTH VAPID keys to be reported configured', () => {
    expect(listChannels({ VAPID_PUBLIC_KEY: 'pub' }).find((c) => c.id === 'push').configured).toBe(false);
  });
});

describe('deliverPush (config-gated, per-subscription)', () => {
  it('returns false without sending when VAPID keys are unset', async () => {
    const subscription = { endpoint: 'https://push.example/x', keys: { p256dh: 'a', auth: 'b' } };
    await expect(deliverPush({ subscription, title: 't', text: 'x' }, {})).resolves.toBe(false);
  });

  it('returns false for a malformed subscription even when VAPID is configured', async () => {
    const env = { VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv' };
    await expect(deliverPush({ subscription: null, title: 't', text: 'x' }, env)).resolves.toBe(false);
    await expect(deliverPush({ subscription: { endpoint: 'e' }, title: 't', text: 'x' }, env)).resolves.toBe(false);
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

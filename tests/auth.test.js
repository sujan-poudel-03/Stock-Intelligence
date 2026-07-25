import { describe, it, expect, afterEach } from 'vitest';
import { adminEmails, isAdminEmail, adminGateEnabled, resolveAdmin } from '../src/lib/auth.js';

const fakeReq = (auth) => ({ headers: { get: (k) => (String(k).toLowerCase() === 'authorization' ? auth || null : null) } });

describe('admin allowlist', () => {
  it('parses a comma-separated, case/space-insensitive allowlist', () => {
    const env = { ADMIN_EMAILS: ' Owner@Example.com , admin@nepa.com ' };
    expect(adminEmails(env)).toEqual(['owner@example.com', 'admin@nepa.com']);
  });

  it('matches an admin email regardless of case/whitespace', () => {
    const env = { ADMIN_EMAILS: 'owner@example.com' };
    expect(isAdminEmail(' OWNER@example.com ', env)).toBe(true);
    expect(isAdminEmail('someone@else.com', env)).toBe(false);
    expect(isAdminEmail('', env)).toBe(false);
  });

  it('gate is OPEN (disabled) when no allowlist is configured', () => {
    expect(adminGateEnabled({})).toBe(false);
    expect(adminGateEnabled({ ADMIN_EMAILS: '' })).toBe(false);
  });

  it('gate ENFORCES once an allowlist is set', () => {
    expect(adminGateEnabled({ ADMIN_EMAILS: 'owner@example.com' })).toBe(true);
  });
});

describe('resolveAdmin (client role check)', () => {
  const saved = process.env.ADMIN_EMAILS;
  afterEach(() => {
    if (saved === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = saved;
  });

  it('open mode: everyone reads as admin when no allowlist is set', async () => {
    delete process.env.ADMIN_EMAILS;
    expect(await resolveAdmin(fakeReq())).toEqual({ gateEnabled: false, isAdmin: true, email: null });
  });

  it('enforced + no token: not admin', async () => {
    process.env.ADMIN_EMAILS = 'owner@nepa.com';
    expect(await resolveAdmin(fakeReq())).toEqual({ gateEnabled: true, isAdmin: false, email: null });
  });
});

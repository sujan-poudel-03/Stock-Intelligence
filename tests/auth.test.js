import { describe, it, expect } from 'vitest';
import { adminEmails, isAdminEmail, adminGateEnabled } from '../src/lib/auth.js';

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

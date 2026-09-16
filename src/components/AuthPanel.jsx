'use client';

import { maskEmail } from '@/lib/format';
import { color, radius, spacing, font, text } from '@/design-system/tokens';
import Pill from '@/design-system/components/Pill';

// Account panel (Settings). Shows Google sign-in / the signed-in identity + role.
// Rendered only when auth is configured; in open mode there's no auth infra so it
// stays hidden and the app behaves as single-operator.
export default function AuthPanel({ auth }) {
  if (!auth || !auth.configured) return null;

  const card = { background: color.surface, border: '1px solid ' + color.border, borderRadius: radius.lg, padding: '14px 16px', marginBottom: spacing.md };

  if (auth.email) {
    const roleColor = auth.isAdmin ? color.positive : color.textFaint;
    return (
      <div style={{ ...card, display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ width: 28, height: 28, borderRadius: '50%', background: color.info + '18', border: '1px solid ' + color.info + '33', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: text.base, color: color.info, fontFamily: font.mono }}>
          {auth.email[0].toUpperCase()}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div title={maskEmail(auth.email)} style={{ fontSize: text.body, color: color.textPrimary, fontFamily: font.ui, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{maskEmail(auth.email)}</div>
          <Pill tone={roleColor}>{auth.isAdmin ? 'ADMIN' : 'USER'}</Pill>
        </div>
        <button onClick={auth.signOut} style={{ fontSize: text.small, color: color.textFaint, background: 'none', border: '1px solid ' + color.border, borderRadius: radius.md, padding: '5px 10px', cursor: 'pointer', fontFamily: font.ui }}>Sign out</button>
      </div>
    );
  }

  return (
    <div style={{ ...card, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
      <div style={{ fontSize: text.small, color: color.textFaint, fontFamily: font.ui }}>
        {auth.gateEnabled ? 'Admin features require sign-in.' : 'Sign in to identify yourself.'}
      </div>
      <button onClick={auth.signIn} style={{ fontSize: text.base, fontWeight: 600, color: color.textPrimary, background: color.info + '15', border: '1px solid ' + color.info, borderRadius: radius.lg, padding: '7px 14px', cursor: 'pointer', fontFamily: font.ui }}>Sign in with Google</button>
    </div>
  );
}

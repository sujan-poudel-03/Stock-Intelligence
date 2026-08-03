'use client';

// Account panel (Settings). Shows Google sign-in / the signed-in identity + role.
// Rendered only when auth is configured; in open mode there's no auth infra so it
// stays hidden and the app behaves as single-operator.
export default function AuthPanel({ auth }) {
  if (!auth || !auth.configured) return null;

  const card = { background: '#0b0e16', border: '1px solid #1e2840', borderRadius: 12, padding: '14px 16px', marginBottom: 12 };

  if (auth.email) {
    return (
      <div style={{ ...card, display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ width: 28, height: 28, borderRadius: '50%', background: '#3b82f618', border: '1px solid #3b82f633', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: '#3b82f6', fontFamily: 'IBM Plex Mono,monospace' }}>
          {auth.email[0].toUpperCase()}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11, color: '#e2e8f0', fontFamily: 'Inter,sans-serif', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{auth.email}</div>
          <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: '.04em', color: auth.isAdmin ? '#10b981' : '#4a5568', background: (auth.isAdmin ? '#10b981' : '#4a5568') + '20', padding: '1px 5px', borderRadius: 3, fontFamily: 'IBM Plex Mono,monospace' }}>{auth.isAdmin ? 'ADMIN' : 'USER'}</span>
        </div>
        <button onClick={auth.signOut} style={{ fontSize: 10, color: '#4a5568', background: 'none', border: '1px solid #1e2840', borderRadius: 6, padding: '5px 10px', cursor: 'pointer', fontFamily: 'Inter,sans-serif' }}>Sign out</button>
      </div>
    );
  }

  return (
    <div style={{ ...card, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
      <div style={{ fontSize: 10, color: '#4a5568', fontFamily: 'Inter,sans-serif' }}>
        {auth.gateEnabled ? 'Admin features require sign-in.' : 'Sign in to identify yourself.'}
      </div>
      <button onClick={auth.signIn} style={{ fontSize: 11, fontWeight: 600, color: '#e2e8f0', background: '#3b82f615', border: '1px solid #3b82f6', borderRadius: 8, padding: '7px 14px', cursor: 'pointer', fontFamily: 'Inter,sans-serif' }}>Sign in with Google</button>
    </div>
  );
}

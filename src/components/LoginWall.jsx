'use client';

// Full-screen hard login gate (Option B). Rendered by NepseApp ONLY when Google
// auth is configured AND the visitor isn't signed in — so nobody sees the app
// until they authenticate. When auth isn't configured it's never shown (the app
// stays open), so enabling this can't lock everyone out before Google is wired.
export default function LoginWall({ onSignIn }) {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#07090e', padding: 20 }}>
      <div style={{ maxWidth: 340, width: '100%', textAlign: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 10 }}>
          <div style={{ width: 9, height: 9, borderRadius: '50%', background: '#10b981' }} />
          <span style={{ fontSize: 18, fontWeight: 600, color: '#e2e8f0', letterSpacing: '-.01em', fontFamily: 'Inter,sans-serif' }}>NEPSE</span>
          <span style={{ fontSize: 12, color: '#2a3550', fontFamily: 'Inter,sans-serif' }}>Intelligence</span>
        </div>
        <div style={{ fontSize: 12, color: '#4a5568', marginBottom: 26, fontFamily: 'Inter,sans-serif' }}>Sign in to continue</div>
        <button
          onClick={onSignIn}
          style={{ width: '100%', padding: '11px 16px', borderRadius: 10, border: '1px solid #3b82f6', background: '#3b82f615', color: '#e2e8f0', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'Inter,sans-serif' }}
        >
          Sign in with Google
        </button>
        <div style={{ fontSize: 9, color: '#2a3550', marginTop: 22, lineHeight: 1.6, fontFamily: 'Inter,sans-serif' }}>
          Educational research, not financial advice.<br />Past performance ≠ future results.
        </div>
      </div>
    </div>
  );
}

'use client';

import { useEffect, useState, useCallback } from 'react';
import { authConfigured, requireLogin, getAccessToken, signInWithGoogle, signOut, onAuthChange } from '@/lib/authClient';

// useAuth(): the client's view of admin state. Asks the server (/api/admin/me) "am I
// an admin?" using the current session token — the ADMIN_EMAILS list stays
// server-side. In open mode the server reports isAdmin=true, so the single operator
// keeps full access. UI only; the security boundary is server-side requireAdmin.
export function useAuth() {
  const [email, setEmail] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [gateEnabled, setGateEnabled] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const token = await getAccessToken();
      setSignedIn(!!token);
      const res = await fetch('/api/admin/me', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        cache: 'no-store',
      });
      const d = await res.json();
      setIsAdmin(!!d.isAdmin);
      setGateEnabled(!!d.gateEnabled);
      setEmail(d.email || null);
    } catch {
      /* leave prior state */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const off = onAuthChange(refresh);
    return off;
  }, [refresh]);

  return { configured: authConfigured, requireLogin, email, isAdmin, gateEnabled, signedIn, loading, signIn: signInWithGoogle, signOut, refresh };
}

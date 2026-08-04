/* Auth session state for the whole app.

   Boot order matters: we restore tokens from SecureStore before rendering any
   route, so a returning user never sees the login screen flash before landing
   on the dashboard. `loading` covers that window. */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  api,
  auth,
  account,
  loadStoredTokens,
  setOnSessionLost,
  type User,
} from './api';
import { DEFAULT_FX, type Fx } from './format';

type SessionState = {
  user: User | null;
  /** The account's display currency; USD/rate-1 until an account is set
      otherwise. Loaded alongside the user so prices never render in the wrong
      currency for a frame. */
  fx: Fx;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refreshUser: () => Promise<void>;
};

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [fx, setFx] = useState<Fx>(DEFAULT_FX);
  const [loading, setLoading] = useState(true);

  const loadFx = useCallback(async () => {
    try {
      const f = await api.get('/user/fx');
      setFx({
        currency: f.currency || 'USD',
        rate: Number(f.rate) || 1,
        symbol: f.symbol || '$',
      });
    } catch {
      setFx(DEFAULT_FX); // display in USD rather than block the screen
    }
  }, []);

  useEffect(() => {
    // A rejected refresh token means the session can't be recovered — drop the
    // user object so the router sends them to /login.
    setOnSessionLost(() => setUser(null));
    return () => setOnSessionLost(null);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        if (await loadStoredTokens()) {
          // Any authenticated call proves the stored pair still works; this one
          // also gives us the fresh user record (pricing, hidePrices, balance).
          const data = await account.detail();
          setUser(data.user ?? data);
          await loadFx();
        }
      } catch {
        // Invalid/expired session — api.ts has already cleared the tokens.
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const data = await auth.login(email, password);
      await auth.saveTokens(data.accessToken, data.refreshToken);
      setUser(data.user);
      await loadFx();
    },
    [loadFx]
  );

  const signOut = useCallback(async () => {
    await auth.logout();
    setUser(null);
    setFx(DEFAULT_FX);
  }, []);

  const refreshUser = useCallback(async () => {
    const data = await account.detail();
    setUser(data.user ?? data);
  }, []);

  const value = useMemo(
    () => ({ user, fx, loading, signIn, signOut, refreshUser }),
    [user, fx, loading, signIn, signOut, refreshUser]
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>');
  return ctx;
}

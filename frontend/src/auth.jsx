import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { api, getToken, setToken, setUnauthorizedHandler } from './api';

/**
 * AuthProvider — the single source of truth for "who is signed in and
 * what venues do they staff".
 *
 * On boot it re-validates any stored token against /auth/me rather
 * than trusting a cached user object: the token may have expired, or
 * the account's venue memberships may have changed since last visit
 * (a manager can revoke access at any time, and the UI must reflect
 * that on the next load rather than showing a console that 404s).
 */
const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [memberships, setMemberships] = useState([]);
  const [loading, setLoading] = useState(true);

  const signOut = useCallback(() => {
    setToken(null);
    setUser(null);
    setMemberships([]);
  }, []);

  // Any 401 from any request drops the session, so an expired token
  // can't leave the app stuck on a screen that silently fails.
  useEffect(() => {
    setUnauthorizedHandler(() => signOut());
    return () => setUnauthorizedHandler(null);
  }, [signOut]);

  const refresh = useCallback(async () => {
    if (!getToken()) {
      setUser(null);
      setMemberships([]);
      setLoading(false);
      return;
    }
    try {
      const { user: fresh, memberships: fresherMemberships } = await api.me();
      setUser(fresh);
      setMemberships(fresherMemberships);
    } catch {
      // Includes the 401 path, which signOut already handled.
      setUser(null);
      setMemberships([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const adopt = useCallback(async ({ token, user: newUser }) => {
    setToken(token);
    setUser(newUser);
    // Memberships aren't in the register/login response — a brand new
    // account has none, and an existing one needs the current list.
    try {
      const { memberships: m } = await api.me();
      setMemberships(m);
    } catch {
      setMemberships([]);
    }
  }, []);

  const value = {
    user,
    memberships,
    loading,
    isStaffSomewhere: memberships.length > 0,
    signIn: async (email, password) => adopt(await api.login(email, password)),
    register: async (payload) => adopt(await api.register(payload)),
    signOut,
    refresh,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

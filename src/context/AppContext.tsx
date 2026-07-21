import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import * as api from '../lib/api';
import * as googleAuth from '../lib/google';
import type { ThemeId, User } from '../lib/types';

interface AppContextValue {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string, accountType?: 'standard' | 'trainer') => Promise<void>;
  loginWithGoogle: () => Promise<void>;
  logout: () => Promise<void>;
  deleteAccount: () => Promise<void>;
  refresh: () => Promise<void>;
  patchUser: (patch: Partial<User>) => Promise<void>;
  /** Activate the $4.99/mo subscription (placeholder payment). */
  subscribe: () => Promise<void>;
  cancelSubscription: () => Promise<void>;
  setTheme: (theme: ThemeId) => Promise<void>;
}

const AppContext = createContext<AppContextValue | null>(null);

function applyTheme(theme: ThemeId) {
  document.documentElement.setAttribute('data-theme', theme);
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const bootstrapped = useRef(false);

  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;
    (async () => {
      const u = (await api.getSessionUser()) ?? (await api.createGuest());
      setUser(u);
      applyTheme(u.theme);
      setLoading(false);
    })();
  }, []);

  const claimGuestInto = useCallback(async (prev: User | null, next: User) => {
    if (prev?.isGuest && prev.id !== next.id) {
      await api.migrateGuest(prev.id, next.id);
    }
    const fresh = (await api.getSessionUser()) ?? next;
    setUser(fresh);
    applyTheme(fresh.theme);
  }, []);

  const refresh = useCallback(async () => {
    const u = await api.getSessionUser();
    setUser(u);
    if (u) applyTheme(u.theme);
  }, []);

  const login = useCallback(
    async (email: string, password: string) => {
      const prev = await api.getSessionUser();
      const u = await api.login(email, password);
      await claimGuestInto(prev, u);
    },
    [claimGuestInto],
  );

  const register = useCallback(
    async (name: string, email: string, password: string, accountType: 'standard' | 'trainer' = 'standard') => {
      const prev = await api.getSessionUser();
      const u = await api.register(name, email, password, accountType);
      await claimGuestInto(prev, u);
    },
    [claimGuestInto],
  );

  const loginWithGoogle = useCallback(async () => {
    const identity = await googleAuth.requestGoogleIdentity();
    const prev = await api.getSessionUser();
    const u = await api.socialLogin({ email: identity.email, name: identity.name });
    await claimGuestInto(prev, u);
  }, [claimGuestInto]);

  const logout = useCallback(async () => {
    await api.logout();
    const g = await api.createGuest();
    setUser(g);
    applyTheme(g.theme);
  }, []);

  const deleteAccount = useCallback(async () => {
    if (!user) return;
    await api.deleteAccount(user.id);
    const g = await api.createGuest();
    setUser(g);
    applyTheme(g.theme);
  }, [user]);

  const patchUser = useCallback(
    async (patch: Partial<User>) => {
      if (!user) return;
      const updated = await api.updateUser({ ...user, ...patch });
      setUser(updated);
      if (patch.theme) applyTheme(updated.theme);
    },
    [user],
  );

  const subscribe = useCallback(async () => {
    if (!user) return;
    const updated = await api.subscribe(user.id);
    setUser(updated);
  }, [user]);

  const cancelSubscription = useCallback(async () => {
    if (!user) return;
    const updated = await api.cancelSubscription(user.id);
    setUser(updated);
  }, [user]);

  const setTheme = useCallback(
    async (theme: ThemeId) => {
      await patchUser({ theme });
    },
    [patchUser],
  );

  const value = useMemo(
    () => ({ user, loading, login, register, loginWithGoogle, logout, deleteAccount, refresh, patchUser, subscribe, cancelSubscription, setTheme }),
    [user, loading, login, register, loginWithGoogle, logout, deleteAccount, refresh, patchUser, subscribe, cancelSubscription, setTheme],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}

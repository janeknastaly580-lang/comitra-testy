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
import { clearAllDrafts } from '../lib/draft';
import * as googleAuth from '../lib/google';
import { clearInbox, listInbox, markRead, registerDevice, syncInbox, type PushMessage } from '../lib/push';
import type { ThemeId, User } from '../lib/types';

/**
 * How often the app checks for messages while it is open.
 *
 * There is no push service to be woken by, so this poll IS the delivery. Two
 * minutes is a compromise: often enough that a friend's answer feels immediate,
 * rare enough to cost a phone almost nothing. Every open also syncs once, which
 * is what actually catches anything that arrived while the app was closed.
 */
const INBOX_POLL_MS = 120_000;

interface AppContextValue {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (
    name: string,
    email: string,
    password: string,
    accountType?: 'standard' | 'trainer',
    /** The receipt `api.verifyEmailCode` returned for the emailed code. */
    ticket?: string,
  ) => Promise<void>;
  loginWithGoogle: () => Promise<void>;
  logout: () => Promise<void>;
  deleteAccount: () => Promise<void>;
  refresh: () => Promise<void>;
  patchUser: (patch: Partial<User>) => Promise<void>;
  /** Messages waiting for this account (see `src/lib/push.ts`), newest first. */
  inbox: PushMessage[];
  /** Mark one message read, here and on the server. */
  readMessage: (id: string) => Promise<void>;
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
  const [inbox, setInbox] = useState<PushMessage[]>(() => listInbox());
  const bootstrapped = useRef(false);

  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;
    (async () => {
      // Ask the SERVER who this device is signed in as, and take on that
      // account's data. This is what makes opening the app on a new phone show
      // everything the person already has, instead of an empty start.
      const u = (await api.bootstrapSession()) ?? (await api.createGuest());
      setUser(u);
      applyTheme(u.theme);
      setLoading(false);
    })();
  }, []);

  /**
   * Say "this account has the app here", then pull anything waiting for it.
   *
   * Guests are skipped: a guest is device-local, so nobody can address a message
   * to one, and registering a device for it would only tell the store about an
   * account that will never be a recipient.
   */
  useEffect(() => {
    if (!user || user.isGuest) {
      setInbox([]);
      return;
    }
    const id = user.id;
    let stopped = false;

    const tick = async () => {
      await registerDevice(id);
      const messages = await syncInbox(id);
      // A friend's yes/no is machinery, not news: apply it to this account's
      // consents (which may start a goal that was waiting on them) and clear it,
      // so it never sits in the list as something to read.
      const consumed = api.absorbConsentAnswers(id, messages);
      for (const messageId of consumed) await markRead(messageId, id);
      if (!stopped) setInbox(listInbox());
    };

    void tick();
    const timer = setInterval(() => void tick(), INBOX_POLL_MS);
    // Coming back to the app is the moment something is most likely waiting.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [user]);

  const readMessage = useCallback(
    async (id: string) => {
      if (!user) return;
      await markRead(id, user.id);
      setInbox(listInbox());
    },
    [user],
  );

  // The session can be revoked while the app is open — a password reset done
  // elsewhere, or the account deleted from another device. Fall back to a guest
  // rather than leaving a signed-in shell whose edits go nowhere.
  useEffect(
    () =>
      api.onSignedOut(() => {
        void (async () => {
          const g = await api.createGuest();
          setUser(g);
          applyTheme(g.theme);
        })();
      }),
    [],
  );

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
    async (
      name: string,
      email: string,
      password: string,
      accountType: 'standard' | 'trainer' = 'standard',
      ticket?: string,
    ) => {
      const prev = await api.getSessionUser();
      const u = await api.register(name, email, password, accountType, ticket);
      await claimGuestInto(prev, u);
    },
    [claimGuestInto],
  );

  const loginWithGoogle = useCallback(async () => {
    const identity = await googleAuth.requestGoogleIdentity();
    const prev = await api.getSessionUser();
    const u = await api.socialLogin({
      email: identity.email,
      name: identity.name,
      accessToken: identity.accessToken,
    });
    await claimGuestInto(prev, u);
  }, [claimGuestInto]);

  const logout = useCallback(async () => {
    await api.logout();
    // The pulled messages belong to the account that is leaving, not to the
    // device: whoever signs in next must not find them sitting there. Half-typed
    // forms go for the same reason (src/lib/draft.ts).
    clearInbox();
    clearAllDrafts();
    setInbox([]);
    const g = await api.createGuest();
    setUser(g);
    applyTheme(g.theme);
  }, []);

  const deleteAccount = useCallback(async () => {
    if (!user) return;
    await api.deleteAccount(user.id);
    clearAllDrafts();
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
    () => ({ user, loading, login, register, loginWithGoogle, logout, deleteAccount, refresh, patchUser, subscribe, cancelSubscription, setTheme, inbox, readMessage }),
    [user, loading, login, register, loginWithGoogle, logout, deleteAccount, refresh, patchUser, subscribe, cancelSubscription, setTheme, inbox, readMessage],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}

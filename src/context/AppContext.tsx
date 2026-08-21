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
import { chatPreview, listThreads, type ChatThread } from '../lib/chat';
import { clearAllDrafts } from '../lib/draft';
import { forgetPush, initPush, onPushWake } from '../lib/fcm';
import { postNotification } from '../lib/localNotify';
import * as googleAuth from '../lib/google';
import { clearInbox, listInbox, markRead, registerDevice, syncInbox, type PushMessage } from '../lib/push';
import type { ThemeId, User } from '../lib/types';

/**
 * How often the app checks for messages while it is open.
 *
 * Now the floor rather than the delivery: a real push wakes the app the moment
 * something is sent (`src/lib/fcm.ts`), and this catches whatever a push could
 * not — a refused notification permission, a phone with no Play Services, a
 * dropped message. Two minutes is the compromise it always was: often enough
 * that a friend's answer feels immediate, rare enough to cost a phone almost
 * nothing. Every open still syncs once.
 */
const INBOX_POLL_MS = 120_000;

/**
 * How often the conversation list is re-read while the app is open.
 *
 * Much faster than the inbox above, and on its own timer for a reason: this one
 * is what puts the badge on the Chats tab and raises the banner for a message
 * that just arrived. Two minutes was too slow to be called delivery — a friend's
 * reply is the thing people wait on — and it is a single call that returns one
 * row per conversation, so running it often costs very little. The conversation
 * that is actually open polls faster still, in `src/views/Chat.tsx`.
 */
const CHAT_POLL_MS = 15_000;

/** The slowest the same poll goes once the page says it is in the background. */
const CHAT_BACKGROUND_POLL_MS = 60_000;

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
  /** Conversations with unread messages, newest first (see `src/lib/chat.ts`). */
  chatThreads: ChatThread[];
  /** Re-read the conversation list now (after opening or answering one). */
  refreshChat: () => Promise<void>;
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
  const [chatThreads, setChatThreads] = useState<ChatThread[]>([]);
  // Ids already announced, so the same message is not notified twice while the
  // app polls. Kept in a ref: it must survive a render without causing one.
  const notified = useRef<Set<string>>(new Set());
  const bootstrapped = useRef(false);
  /**
   * The two polls, exposed so an arriving push can run them immediately.
   *
   * Refs rather than state because a push must reach whatever the CURRENT
   * effects are, without re-subscribing the FCM listener every time a timer
   * is rebuilt — and because nothing renders differently for holding them.
   */
  const pullInbox = useRef<(() => void) | null>(null);
  const pullChat = useRef<(() => void) | null>(null);

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
      // Be findable, and agree with the server about who follows whom. Both are
      // on the same timer as the inbox because both are how somebody ELSE's
      // action reaches this device (see `src/lib/social.ts`).
      await api.publishMyProfile(user);
      await api.syncSocialGraph(id);
      const messages = await syncInbox(id);
      // A friend's yes/no is machinery, not news: apply it to this account's
      // consents (which may start a goal that was waiting on them) and clear it,
      // so it never sits in the list as something to read.
      const consumed = api.absorbConsentAnswers(id, messages);
      for (const messageId of consumed) await markRead(messageId, id);
      if (!stopped) setInbox(listInbox());
    };

    void tick();
    // File this handset's FCM token against the account that just signed in, so
    // the backend can wake it while the app is closed. Everything below still
    // works exactly as before if this fails — see src/lib/fcm.ts.
    void initPush(id);
    pullInbox.current = () => void tick();
    const timer = setInterval(() => void tick(), INBOX_POLL_MS);
    // Coming back to the app is the moment something is most likely waiting.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      pullInbox.current = null;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [user]);

  /**
   * Pull the conversation list, on its own fast timer.
   *
   * A conversation is pulled as a list of THREADS, not of messages: the badge
   * only needs counts, and the screen showing a conversation fetches that
   * conversation itself. Separate from the inbox poll above because it has to
   * run several times a minute to be worth calling delivery, and because it is
   * one cheap call — none of the device registration or graph syncing the other
   * timer does needs to happen this often.
   */
  useEffect(() => {
    if (!user || user.isGuest) {
      setChatThreads([]);
      return;
    }
    const id = user.id;
    let stopped = false;
    let lastRun = 0;

    // A page that claims to be hidden gets the slow interval, never silence:
    // some WebViews report themselves hidden while somebody is reading them, and
    // a badge that stops counting is worse than a poll that costs a little.
    const tick = async (force: boolean) => {
      if (stopped) return;
      if (!force && document.hidden && Date.now() - lastRun < CHAT_BACKGROUND_POLL_MS) return;
      lastRun = Date.now();
      const threads = await listThreads();
      if (stopped) return;
      setChatThreads(threads);
      for (const thread of threads) {
        if (thread.unread === 0 || thread.lastFromUserId === id) continue;
        // One banner per newest-message-per-thread. The list itself is the
        // record; this is only the nudge, and it must not repeat.
        const key = `${thread.userId}:${thread.lastAt}`;
        if (notified.current.has(key)) continue;
        notified.current.add(key);
        void postNotification({
          // Keyed by CONVERSATION, not by message, and deliberately the same tag
          // the backend pushes under (`chat:<id>` in supabase/functions/api/
          // chat.ts). A banner already on screen for this friend is replaced,
          // whether the app or Firebase put it there — `key` above is what stops
          // the same message being announced twice, and it is a different job.
          id: `chat:${thread.userId}`,
          title: 'Pactista',
          body: chatPreview({ kind: thread.lastKind, body: thread.lastBody, payload: {} }),
        });
      }
    };

    void tick(true);
    pullChat.current = () => void tick(true);
    const timer = setInterval(() => void tick(false), CHAT_POLL_MS);
    // Reopening the app, or coming back onto a network, is when a message is
    // most likely already waiting — ask straight away rather than on the beat.
    const onWake = () => void tick(true);
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);
    window.addEventListener('online', onWake);
    return () => {
      stopped = true;
      pullChat.current = null;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
      window.removeEventListener('online', onWake);
    };
  }, [user]);

  /**
   * A push that lands while the app is running turns into a pull, not a banner.
   *
   * The OS shows nothing for a notification that arrives in the foreground, so
   * something has to. Letting the two polls above do it — rather than posting
   * from the push itself — means the banner is raised by the code that already
   * de-duplicates them by message id, and the screens are up to date by the time
   * anybody taps it. Registered once, and reads the refs so it always reaches
   * the current effects.
   */
  useEffect(() => {
    onPushWake(() => {
      pullInbox.current?.();
      pullChat.current?.();
    });
    return () => onPushWake(null);
  }, []);

  const readMessage = useCallback(
    async (id: string) => {
      if (!user) return;
      await markRead(id, user.id);
      setInbox(listInbox());
    },
    [user],
  );

  const refreshChat = useCallback(async () => {
    if (!user || user.isGuest) return;
    setChatThreads(await listThreads());
  }, [user]);

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
    // Before `api.logout()`, never after: the backend takes the account from the
    // session token, so once that is gone there is nothing left to say whose
    // notifications should stop arriving on this phone.
    await forgetPush();
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
    () => ({ user, loading, login, register, loginWithGoogle, logout, deleteAccount, refresh, patchUser, subscribe, cancelSubscription, setTheme, inbox, readMessage, chatThreads, refreshChat }),
    [user, loading, login, register, loginWithGoogle, logout, deleteAccount, refresh, patchUser, subscribe, cancelSubscription, setTheme, inbox, readMessage, chatThreads, refreshChat],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}

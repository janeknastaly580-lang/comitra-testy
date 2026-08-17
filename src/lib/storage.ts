/**
 * LocalStorage, used as a LOCAL CACHE of the signed-in account's data.
 *
 * It used to be the database, which is why an account only existed on the device
 * that created it. The database is now Postgres (see `src/lib/cloud.ts` and
 * supabase/comitra_accounts.sql); this file is the copy the app reads and writes
 * synchronously so every screen stays instant and keeps working offline.
 *
 * Everything still funnels through here, and that is what makes the sync
 * possible: `write` is the single choke point where "something changed" is
 * observable, so `cloud.ts` can subscribe once instead of every call site having
 * to remember to push.
 */

const PREFIX = 'fineline:';

/**
 * Keys left behind by features that no longer exist.
 *
 * They have to be deleted HERE rather than just dropped from `KEYS`, because
 * `keys()` enumerates LocalStorage itself — so a retired key on somebody's phone
 * would keep being folded into every snapshot and pushed back to the server for
 * ever, as dead weight in the account document nothing can ever read again.
 *
 * Runs once at import, before anything has had a chance to read or sync, and
 * bypasses `remove()` on purpose: this is not a change to the account's data,
 * and reporting it would schedule a push before the engine has even started.
 */
const RETIRED_KEYS = [
  // Team challenges (relay / tug of war), removed 2026-08-17.
  'teamChallenges',
];

try {
  for (const key of RETIRED_KEYS) localStorage.removeItem(PREFIX + key);
} catch {
  // No LocalStorage at all (SSR, a locked-down WebView). Nothing to clean.
}

/**
 * The sync engine's hook into every local write. One listener, set once at
 * startup — this is deliberately not a general event bus.
 */
let onChange: ((key: string) => void) | null = null;

/**
 * Depth counter, not a boolean: `suppress` nests (adopting a document writes
 * many keys, and some of those paths write again). A boolean would be cleared by
 * the first inner call and let the rest of an adopt look like user edits.
 */
let suppressed = 0;

/** Register the sync engine. Passing null detaches it (used on sign-out). */
export function watch(fn: ((key: string) => void) | null): void {
  onChange = fn;
}

/**
 * Run `fn` without reporting its writes as changes.
 *
 * Used when applying a document that CAME from the server: those writes are not
 * news to it, and reporting them would push straight back what was just pulled —
 * an endless round trip between two devices.
 */
export function suppress<T>(fn: () => T): T {
  suppressed++;
  try {
    return fn();
  } finally {
    suppressed--;
  }
}

function changed(key: string): void {
  if (suppressed > 0 || !onChange) return;
  try {
    onChange(key);
  } catch (err) {
    // Syncing is never allowed to break the write that triggered it.
    console.warn('[storage] sync listener failed:', err);
  }
}

export function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw == null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function write<T>(key: string, value: T): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch (err) {
    // A full quota (common on low-storage Android WebViews) must never crash the
    // app: degrade gracefully instead of throwing out of a render/event handler.
    console.warn(`[storage] Could not persist "${key}":`, err);
  }
  changed(key);
}

export function remove(key: string): void {
  localStorage.removeItem(PREFIX + key);
  changed(key);
}

/** Every stored key, without the prefix. Used to build a full snapshot. */
export function keys(): string[] {
  const out: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith(PREFIX)) out.push(k.slice(PREFIX.length));
  }
  return out;
}

export function uid(prefix = 'id'): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-4)}`;
}

/** RFC4122 UUID where available, with a safe fallback for old WebViews. */
export function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Stable per-device/per-browser identifier. Generated once on first launch and
 * persisted in LocalStorage. Incognito windows and other browsers get a *different*
 * id (separate storage), which is exactly what the anti-cheat device-isolation
 * check relies on: the goal creator cannot referee their own challenge.
 */
export function getDeviceId(): string {
  let id = read<string | null>(KEYS.deviceId, null);
  if (!id) {
    id = uuid();
    write(KEYS.deviceId, id);
  }
  return id;
}

export const KEYS = {
  users: 'users',
  goals: 'goals',
  leagues: 'leagues',
  /** Id of the user this device is currently acting as (account OR guest). */
  session: 'session',
  /**
   * Bearer token for the server session. This is the ONE thing that makes the
   * app remember an account across restarts; it is device-local by nature and
   * therefore never part of the synced document.
   */
  sessionToken: 'sessionToken',
  /** Revision of the account document this device last agreed with the server on. */
  stateRevision: 'stateRevision',
  deviceId: 'deviceId',
  features: 'features',
  featuresSeeded: 'features:seeded',
  testers: 'testers',
  // Social-commitment model
  recipientConsents: 'recipientConsents',
  notifications: 'notifications',
  auditLogs: 'auditLogs',
  legalAcceptances: 'legalAcceptances',
  abuseReports: 'abuseReports',
  // Trainer ↔ client
  trainerClients: 'trainerClients',
  // Judge acceptance codes + ratings
  judgeCredentials: 'judgeCredentials',
  judgeRatings: 'judgeRatings',
  // Notification outbox (recipient/judge messages)
  outbox: 'outbox',
  // Invited judges (friends who registered as possible judges) + invite tokens
  invitedJudges: 'invitedJudges',
  judgeInvites: 'judgeInvites',
  // Goals that come back every week on chosen days, with their day-by-day record
  renewingGoals: 'renewingGoals',
  // "Why did it fail / what next" answers owed after a missed goal
  goalReflections: 'goalReflections',
  /**
   * Messages pulled from the shared inbox (see `src/lib/push.ts`). A cache, not
   * a record: the server holds the authoritative copy until it is read, so this
   * key can be cleared at any time without losing anything.
   */
  pushInbox: 'pushInbox',
} as const;

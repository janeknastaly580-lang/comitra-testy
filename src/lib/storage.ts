/**
 * Thin LocalStorage wrapper used as the MVP "database".
 * All persistence funnels through here so swapping to a real backend later
 * only means re-implementing src/lib/api.ts, not touching the UI.
 */

const PREFIX = 'fineline:';

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
    // app — degrade gracefully instead of throwing out of a render/event handler.
    console.warn(`[storage] Could not persist "${key}":`, err);
  }
}

export function remove(key: string): void {
  localStorage.removeItem(PREFIX + key);
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
 * check relies on — the goal creator cannot referee their own challenge.
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
  session: 'session',
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
} as const;

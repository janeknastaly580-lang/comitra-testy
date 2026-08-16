/**
 * In-app push: how Comitra reaches a recipient now that there is no SMS.
 *
 * A recipient is no longer a phone number typed into a form — it is a FRIEND
 * (someone the user follows who follows them back), so every message can be
 * addressed to an account. That buys three things a text never had: nothing
 * personal is stored (no numbers, no addresses — only user ids), a message can
 * carry a link the app opens itself, and the app can tell whether it was
 * actually received.
 *
 * ── What "delivered" honestly means ───────────────────────────────────────
 * There is no push service behind this (no Firebase project, no server key), so
 * nothing can wake a phone that has Comitra closed — and the person may not even
 * have the app any more. That is not hidden:
 *
 *   • every message is stored in the shared inbox and stays there until read, so
 *     an uninstall DELAYS a message rather than losing it;
 *   • the sender's screen reports what really happened — `sent` when the person
 *     has had the app open recently, `no_device` when they have not, which is
 *     what "they probably uninstalled it" looks like from the outside;
 *   • when the app is open (or is opened later) the message arrives and, on
 *     Android, becomes a real system notification via `localNotify.ts`.
 *
 * See `supabase/comitra_push.sql` for the two tables and their locked-down RPCs.
 */
import { Capacitor } from '@capacitor/core';
import { postNotification } from './localNotify';
import { getDeviceId, KEYS, read, write } from './storage';
import {
  remotePushMarkRead,
  remotePushPull,
  remotePushReachable,
  remotePushSend,
  remoteTouchPushDevice,
  supabaseEnabled,
  type RemotePushRow,
} from './supabase';

/**
 * How long after someone's last app open they are still counted as reachable.
 *
 * Generous on purpose. The cost of being wrong in one direction is a sender told
 * "they may not get this" about a friend who simply had a quiet fortnight; in
 * the other, it is Comitra claiming a message was delivered to an app that was
 * deleted a month ago. Fourteen days is long enough that a normal user never
 * trips it, short enough that a deleted app is noticed within a fortnight.
 */
export const REACHABLE_DAYS = 14;

/**
 * The kinds of message an account can be sent.
 *
 * `recipient_consent_answer` is the only one that travels back UP, from the
 * friend to the person who asked. It has to: a consent record lives in the
 * OWNER's data, so the friend's yes or no is useless until it reaches them.
 * It is machinery rather than news, so the inbox never shows it — the owner's
 * app applies it and drops it (see `absorbConsentAnswers` in api.ts).
 */
export type PushKind = 'recipient_consent_request' | 'recipient_consent_answer' | 'goal_not_completed';

/** What a message carries. Never a goal's title or description. */
export interface PushPayload {
  /** Display name of the person the message is about. */
  ownerName?: string;
  /** The goal's per-owner number — the only thing anyone outside sees. */
  goalNumber?: number;
  /** The tone the owner picked for the failure notice. */
  tone?: string;
  /** Consent-request only: the token the accept screen is opened with. */
  consentToken?: string;
  /** Consent request/answer: which consent record this is about. */
  consentId?: string;
  /** Consent answer only: whether the friend agreed. */
  accepted?: boolean;
  /** The already-composed sentence, so the app shows exactly what was sent. */
  body?: string;
}

/** One message as the receiving app holds it. */
export interface PushMessage {
  id: string;
  kind: PushKind;
  fromUserId: string | null;
  payload: PushPayload;
  createdAt: string;
  readAt?: string;
}

/**
 * Whether a message could reach this person.
 *
 *  • `sent`      — queued, and they have had the app open recently.
 *  • `no_device` — queued, but nobody has opened the app on this account for a
 *    while. It is kept, and delivered if they come back.
 *  • `failed`    — the shared store could not be reached at all.
 */
export type PushOutcome = 'sent' | 'no_device' | 'failed';

function platform(): string {
  return Capacitor.isNativePlatform() ? Capacitor.getPlatform() : 'web';
}

/* ─────────────────────────────────────────────────────── device registry ── */

/**
 * Say "this account has the app, here, now".
 *
 * Called on every cold start and login. Best-effort: failing to record a device
 * only makes this user look less reachable to a friend, never breaks anything.
 */
export async function registerDevice(userId: string): Promise<void> {
  if (!supabaseEnabled() || !userId) return;
  await remoteTouchPushDevice(userId, getDeviceId(), platform());
}

/**
 * Could a message reach this person?
 *
 * `true` when they have opened the app inside the window. Note the fallback:
 * when the question cannot be asked (offline, SQL not installed) this answers
 * `true`, because "we could not check" must not be reported to a sender as
 * "your friend has deleted the app".
 */
export async function isReachable(userId: string): Promise<boolean> {
  if (!supabaseEnabled() || !userId) return false;
  const answer = await remotePushReachable(userId, REACHABLE_DAYS);
  return answer ?? true;
}

/* ──────────────────────────────────────────────────────────────── sending ── */

/**
 * Queue one message for an account.
 *
 * `id` must be stable for one logical message (the notification-log id), which
 * is what makes re-running a dispatch safe: the insert is a no-op the second
 * time, so nobody is notified twice.
 */
export async function sendPush(input: {
  id: string;
  toUserId: string;
  fromUserId: string | null;
  kind: PushKind;
  payload: PushPayload;
}): Promise<PushOutcome> {
  if (!supabaseEnabled() || !input.toUserId) return 'failed';
  const ok = await remotePushSend({
    id: input.id,
    toUserId: input.toUserId,
    fromUserId: input.fromUserId,
    kind: input.kind,
    payload: input.payload as Record<string, unknown>,
  });
  if (!ok) return 'failed';
  return (await isReachable(input.toUserId)) ? 'sent' : 'no_device';
}

/* ────────────────────────────────────────────────────────────── receiving ── */

/** Messages this device has already pulled, so they survive being offline. */
function saveCache(list: PushMessage[]): void {
  // Newest first, and capped: this is a notifications list, not an archive.
  write(KEYS.pushInbox, list.slice(0, 50));
}

function toMessage(row: RemotePushRow): PushMessage {
  return {
    id: row.id,
    kind: (row.kind as PushKind) ?? 'goal_not_completed',
    fromUserId: row.from_user_id,
    payload: row.payload ?? {},
    createdAt: row.created_at,
    readAt: row.read_at ?? undefined,
  };
}

/** Whether a message is for a person to read, or only for the app to act on. */
export function isVisible(message: PushMessage): boolean {
  return message.kind !== 'recipient_consent_answer';
}

/** The one-line banner a message becomes. */
export function pushTitle(kind: PushKind): string {
  return kind === 'recipient_consent_request' ? 'Comitra · a friend asked you something' : 'Comitra';
}

/** The sentence shown for a message, whoever composed it. */
export function pushBody(message: PushMessage): string {
  const { ownerName, goalNumber, body } = message.payload;
  if (body) return body;
  const who = ownerName?.trim() || 'A friend';
  if (message.kind === 'recipient_consent_request') {
    return `${who} wants to be able to tell you how one of their goals ended.`;
  }
  return goalNumber
    ? `${who} did not complete goal no. ${goalNumber}.`
    : `${who} did not complete a goal.`;
}

/**
 * Pull everything waiting for this account, notify about what is new, and return
 * the current list.
 *
 * Called on app open and on a slow timer while it is open. Safe to call often:
 * the server only ever returns unread rows, and each one is notified once.
 */
export async function syncInbox(userId: string): Promise<PushMessage[]> {
  if (!supabaseEnabled() || !userId) return listInbox();
  const rows = await remotePushPull(userId);
  if (rows.length === 0) return listInbox();

  const known = new Set(listInbox().map((m) => m.id));
  const fresh = rows.map(toMessage);
  const merged = [...fresh, ...listInbox().filter((m) => !fresh.some((f) => f.id === m.id))]
    .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
  saveCache(merged);

  for (const message of fresh) {
    if (known.has(message.id) || !isVisible(message)) continue;
    // Fire and forget: a banner is a nicety, the list above is the record.
    void postNotification({ id: message.id, title: pushTitle(message.kind), body: pushBody(message) });
  }
  return listInbox();
}

/** What this device holds, newest first. */
export function listInbox(): PushMessage[] {
  return read<PushMessage[]>(KEYS.pushInbox, []).sort(
    (a, b) => +new Date(b.createdAt) - +new Date(a.createdAt),
  );
}

/** Unread count, for the badge. */
export function unreadCount(): number {
  return listInbox().filter((m) => !m.readAt).length;
}

/** Mark one message read, here and on the server (so it stops coming back). */
export async function markRead(id: string, userId: string): Promise<void> {
  const list = listInbox();
  const message = list.find((m) => m.id === id);
  if (message && !message.readAt) {
    message.readAt = new Date().toISOString();
    saveCache(list);
  }
  if (supabaseEnabled() && userId) await remotePushMarkRead(id, userId);
}

/** Forget everything cached on this device (used when signing out). */
export function clearInbox(): void {
  write(KEYS.pushInbox, []);
}

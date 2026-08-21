/**
 * The phone's half of real push.
 *
 * WHAT CHANGED. Pactista used to have no push service at all: a message sat in
 * the shared inbox until its recipient happened to open the app, which then
 * posted a system notification itself (`localNotify.ts`). That is still the
 * floor — every message is stored and shown whether or not any of this works —
 * but it meant nothing ever reached a friend who was not already looking at
 * Pactista. This registers the device with Firebase Cloud Messaging and hands the
 * resulting token to the backend, which is what lets `supabase/functions/api/
 * fcm.ts` wake this phone while the app is shut.
 *
 * ── What a token is, and why it is filed per ACCOUNT ──────────────────────
 * FCM issues one token per app INSTALLATION, not per person. Two people who
 * share a handset therefore share a token, and the backend must always know
 * which of them it currently belongs to — otherwise the second person's lock
 * screen shows the first person's notifications. So the token is re-filed on
 * every sign-in, and cleared on sign-out (`forgetPush`), before the session that
 * authorises the call is thrown away.
 *
 * ── Nothing here is load-bearing ──────────────────────────────────────────
 * Every path swallows its failure into a warning. No Firebase project, a refused
 * notification permission, a Play-Services-less phone, no network: all of them
 * leave the app exactly as it was before FCM existed, polling on open. A missing
 * doorbell must never break the post.
 *
 * On the web this is a no-op — a browser needs a service worker and a VAPID key,
 * which is a different mechanism, and the app it delivers to is a tab that is
 * either open (and already polling) or closed.
 */
import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import { getDeviceId } from './storage';
import { remoteForgetPushToken, remoteRegisterPushToken } from './supabase';

/** Attached once per app run — the plugin's listeners are global, not per call. */
let listenersWired = false;

/** The last token FCM issued this installation. */
let currentToken = '';

/** Which account that token is currently filed under, if any. */
let filedFor = '';

/** The account `initPush` was last called for; what an async token is filed to. */
let accountId = '';

/**
 * What to do when a push arrives while the app is running.
 *
 * Set by AppContext to the same sync a timer would have run. Deliberately NOT a
 * notification: in the foreground the app posts its own banner from the message
 * it pulls, with an id that de-duplicates it — going straight to the OS here
 * would show a second copy of everything.
 */
let wake: (() => void) | null = null;

/** True only where a registration token can exist at all. */
export function pushSupported(): boolean {
  return Capacitor.isNativePlatform();
}

/** Tell this module how to refresh the app when a push lands. */
export function onPushWake(handler: (() => void) | null): void {
  wake = handler;
}

/** File a token against an account. Idempotent; silent on failure. */
async function fileToken(userId: string, token: string): Promise<void> {
  if (!userId || !token) return;
  if (filedFor === userId && currentToken === token) return;
  const ok = await remoteRegisterPushToken(token, getDeviceId(), Capacitor.getPlatform());
  if (ok) {
    currentToken = token;
    filedFor = userId;
  }
}

async function wireListeners(): Promise<void> {
  if (listenersWired) return;
  listenersWired = true;

  await PushNotifications.addListener('registration', (token) => {
    // Fires on first registration and again whenever Firebase rotates the
    // token, which it does on its own schedule — that second case is the whole
    // reason this is a listener rather than a return value.
    void fileToken(accountId, token.value);
  });

  await PushNotifications.addListener('registrationError', (err) => {
    // Overwhelmingly one thing: an APK built without google-services.json. The
    // app keeps working; it just cannot be woken. See PUSH_SETUP.md.
    console.warn('[fcm] could not register for push:', err?.error ?? err);
  });

  // The app is open, so the OS shows nothing. Pull instead: the message becomes
  // a banner through the normal path, and the screens update at the same time.
  await PushNotifications.addListener('pushNotificationReceived', () => wake?.());

  // Opened FROM a notification — the moment something is certainly waiting.
  await PushNotifications.addListener('pushNotificationActionPerformed', () => wake?.());
}

/**
 * Ask for the notification permission, once.
 *
 * Android 13+ requires it and refusing it is a normal answer, not an error: the
 * inbox still fills, the app still shows what arrived, and nothing here retries
 * or nags. Below 13 this resolves as already granted.
 */
async function ensurePermission(): Promise<boolean> {
  const current = await PushNotifications.checkPermissions();
  if (current.receive === 'granted') return true;
  if (current.receive === 'denied') return false;
  const asked = await PushNotifications.requestPermissions();
  return asked.receive === 'granted';
}

/**
 * Register this device for push, as `userId`.
 *
 * Called on every cold start and every sign-in — not just the first — because
 * the account a token belongs to is exactly what changes on a sign-in, and
 * because a token that failed to reach the backend last time gets another go.
 */
export async function initPush(userId: string): Promise<void> {
  if (!pushSupported() || !userId) return;
  accountId = userId;
  try {
    await wireListeners();
    if (!(await ensurePermission())) return;
    // A token already in hand is filed straight away: `register()` will fire
    // the listener again with the same value, but only after a round trip, and
    // a sign-in should not leave a window where pushes go to the previous
    // account.
    if (currentToken) await fileToken(userId, currentToken);
    await PushNotifications.register();
  } catch (err) {
    console.warn('[fcm] push registration failed:', (err as Error)?.message ?? err);
  }
}

/**
 * Stop this device receiving the leaving account's notifications.
 *
 * MUST be called while their session is still valid — the backend takes the
 * account from the session token, so doing this after logging out is a no-op
 * that leaves the token filed. See the ordering in AppContext's `logout`.
 */
export async function forgetPush(): Promise<void> {
  if (!pushSupported()) return;
  filedFor = '';
  accountId = '';
  try {
    await remoteForgetPushToken(getDeviceId());
  } catch (err) {
    console.warn('[fcm] could not unfile this device:', (err as Error)?.message ?? err);
  }
}

/**
 * System notifications, posted by the app itself.
 *
 * WHAT THIS IS AND IS NOT. This is the banner the app raises ITSELF, for a
 * message it has just pulled. It is not the push: waking a closed app is FCM's
 * job (`src/lib/fcm.ts`), and the two do not overlap — Android shows nothing for
 * a push that arrives in the foreground, and a push that arrives in the
 * background is drawn by the OS without this file being involved. What is left
 * for this to cover is everything push cannot reach: a deployment with no
 * Firebase project, a phone without Play Services, a refused notification
 * permission, and every message found by the poll rather than announced.
 *
 * The message itself is never lost in any of those cases: it lives in the shared
 * inbox until it is read.
 *
 * On the web this is a no-op that logs; nothing above it needs to care.
 *
 * ── Native contract (Android) ─────────────────────────────────────────────
 * Plugin `ComitraNotify`:
 *   notify({ id, title, body })  → posts a notification in the app's channel
 *   isSupported()                → { supported }
 * See android/app/src/main/java/com/pactista/app/notify/ComitraNotifyPlugin.java.
 * Android 13+ needs the POST_NOTIFICATIONS runtime permission; the plugin asks
 * for it the first time and simply does nothing if it is refused — a refused
 * notification must never break the sync that triggered it.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';

export interface NotifyPlugin {
  notify(options: { id: string; title: string; body: string }): Promise<{ posted?: boolean }>;
  isSupported(): Promise<{ supported: boolean }>;
}

const Native = registerPlugin<NotifyPlugin>('ComitraNotify');

/** True only where a real system notification can be posted. */
export function notificationsSupported(): boolean {
  return Capacitor.isNativePlatform();
}

/**
 * Post one notification. Best-effort by design: the caller has already stored
 * the message, so a failure here costs a banner, never the message.
 */
export async function postNotification(input: { id: string; title: string; body: string }): Promise<boolean> {
  if (!notificationsSupported()) {
    console.info('[notify] (web) would post:', input.title, '—', input.body);
    return false;
  }
  try {
    const res = await Native.notify(input);
    return res?.posted !== false;
  } catch (err) {
    console.warn('[notify] could not post:', (err as Error)?.message ?? err);
    return false;
  }
}

/**
 * System notifications, posted by the app itself.
 *
 * WHAT THIS IS AND IS NOT. Comitra has no push service (no Firebase project, no
 * server key), so nothing can wake a phone that has the app closed. What this
 * does is post a real Android notification the moment the app learns about a
 * message — which, with `src/lib/push.ts` polling on every open and while the
 * app is in the foreground, is how a recipient actually finds out. The message
 * itself is never lost either way: it lives in the shared inbox until it is read.
 *
 * On the web this is a no-op that logs; nothing above it needs to care.
 *
 * ── Native contract (Android) ─────────────────────────────────────────────
 * Plugin `ComitraNotify`:
 *   notify({ id, title, body })  → posts a notification in the app's channel
 *   isSupported()                → { supported }
 * See android/app/src/main/java/com/fineline/app/notify/ComitraNotifyPlugin.java.
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

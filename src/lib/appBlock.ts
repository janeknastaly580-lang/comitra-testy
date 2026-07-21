/**
 * App-blocking penalty bridge.
 *
 * When a solo (judge-less) goal is missed, the chosen app is blocked for a set
 * time. On the web this is a safe no-op (we only log what *would* happen). On
 * Android the JS calls a Capacitor plugin named `ComitraAppBlock` that a native
 * module must implement — so once this app is ported to Android and the plugin
 * is added, blocking works for real without changing any of the app logic.
 *
 * ── Native contract (Android) ─────────────────────────────────────────────
 * Register a plugin `ComitraAppBlock` implementing:
 *   scheduleBlock({ goalId, packageName, appLabel, untilEpochMs })
 *   cancelBlock({ goalId })
 *   isSupported() -> { supported }
 * A typical implementation uses an AccessibilityService (or UsageStats +
 * a full-screen overlay Activity): while `now < untilEpochMs`, whenever the
 * foreground package equals `packageName`, send the user Home / show a
 * "blocked until <time>" overlay. Persist scheduled blocks (e.g. Room/prefs)
 * so they survive reboots, and require the one-time Accessibility/UsageAccess
 * permission the first time a block is scheduled.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';

export interface AppBlockPlugin {
  scheduleBlock(options: { goalId: string; packageName: string; appLabel: string; untilEpochMs: number }): Promise<void>;
  cancelBlock(options: { goalId: string }): Promise<void>;
  isSupported(): Promise<{ supported: boolean }>;
}

const Native = registerPlugin<AppBlockPlugin>('ComitraAppBlock');

/** True on a native platform where a real block can be enforced. */
export function isAppBlockSupported(): boolean {
  return Capacitor.isNativePlatform();
}

/** Start (or refresh) a block on `packageName` until `untilEpochMs`. */
export async function scheduleAppBlock(
  goalId: string,
  packageName: string,
  appLabel: string,
  untilEpochMs: number,
): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    // Web/dev: nothing to block — record intent for debugging only.
    console.info(`[appBlock] would block ${appLabel} (${packageName}) until ${new Date(untilEpochMs).toISOString()}`);
    return;
  }
  try {
    await Native.scheduleBlock({ goalId, packageName, appLabel, untilEpochMs });
  } catch (err) {
    console.warn('[appBlock] scheduleBlock failed', err);
  }
}

/** Cancel any pending block for a goal (e.g. if it is completed/cancelled). */
export async function cancelAppBlock(goalId: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    await Native.cancelBlock({ goalId });
  } catch (err) {
    console.warn('[appBlock] cancelBlock failed', err);
  }
}

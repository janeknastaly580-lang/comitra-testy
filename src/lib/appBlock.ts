/**
 * App-blocking bridge.
 *
 * Two different blocks ride on this one API:
 *  1. **Penalty** — a missed goal blocks the chosen app for a set time.
 *  2. **Commitment** — the user blocks an app for as long as a goal is running
 *     (until it is completed, cancelled, or its deadline passes).
 * They are independent, so one goal can have both at once. Each is keyed by its
 * own id (`penaltyBlockId` / `commitmentBlockId`) — the native side treats
 * `goalId` as an opaque handle, so nothing more is needed to keep them apart.
 *
 * On the web this is a safe no-op (we only log what *would* happen). On Android
 * the JS calls a Capacitor plugin named `ComitraAppBlock` that a native module
 * must implement — so once the plugin is added, blocking works for real without
 * changing any of the app logic above it.
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
 *
 * `untilEpochMs` is a HARD stop the native side must honour on its own: it is
 * what guarantees a block can never outlive the goal it belongs to, even if the
 * app is uninstalled or never gets to call `cancelBlock`.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';

export interface AppBlockPlugin {
  scheduleBlock(options: { goalId: string; packageName: string; appLabel: string; untilEpochMs: number }): Promise<void>;
  cancelBlock(options: { goalId: string }): Promise<void>;
  isSupported(): Promise<{ supported: boolean }>;
}

const Native = registerPlugin<AppBlockPlugin>('ComitraAppBlock');

/** Handle for the after-the-fact penalty block of a goal. */
export const penaltyBlockId = (goalId: string): string => goalId;

/** Handle for the block a user keeps on while the goal is still running. */
export const commitmentBlockId = (goalId: string): string => `${goalId}#commitment`;

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

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
  scheduleBlock(options: { goalId: string; packageName: string; appLabel: string; untilEpochMs: number }): Promise<{ enforced?: boolean }>;
  cancelBlock(options: { goalId: string }): Promise<void>;
  isSupported(): Promise<{ supported: boolean }>;
  /** Whether blocks are actually enforced (the accessibility service is on). */
  getStatus(): Promise<{ supported: boolean; permissionGranted: boolean; activeBlocks: boolean }>;
  /** Open the system Accessibility screen — the permission can't be granted from code. */
  openSettings(): Promise<void>;
}

export interface AppBlockStatus {
  /** A real block can be enforced on this platform at all (i.e. native). */
  supported: boolean;
  /** The user has switched the blocking service on in Android Settings. */
  permissionGranted: boolean;
  /** At least one block is currently stored and unexpired. */
  activeBlocks: boolean;
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

/**
 * Whether blocking is actually in force. A block is stored even when the
 * permission is missing — the goal is real either way — so the UI has to ask
 * this and tell the user, rather than let them believe an app is blocked when
 * nothing is stopping them opening it.
 */
export async function getAppBlockStatus(): Promise<AppBlockStatus> {
  if (!Capacitor.isNativePlatform()) {
    return { supported: false, permissionGranted: false, activeBlocks: false };
  }
  try {
    return await Native.getStatus();
  } catch (err) {
    console.warn('[appBlock] getStatus failed', err);
    return { supported: true, permissionGranted: false, activeBlocks: false };
  }
}

/**
 * Send the user to Android's Accessibility settings to switch blocking on.
 * Android deliberately refuses to grant this from code — which is also what
 * makes a block hard to shrug off once it is running.
 */
export async function openAppBlockSettings(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    await Native.openSettings();
  } catch (err) {
    console.warn('[appBlock] openSettings failed', err);
  }
}

/**
 * Keeping the signed-in account's data in step with the server.
 *
 * THE MODEL: the app reads and writes LocalStorage synchronously, exactly as it
 * always did, so every screen stays instant and nothing breaks on a train. That
 * copy is a cache. The account's real data is one JSON document in Postgres,
 * pulled when the app starts and pushed shortly after anything changes. Log in
 * on a second device and the same document arrives there — which is the whole
 * point, and what "your data lives on this device" used to prevent.
 *
 * WHY A DOCUMENT rather than a table per thing: the domain logic in api.ts is
 * ~3,600 lines of synchronous reads and writes over arrays. Turning that into
 * per-entity SQL would be a rewrite of everything, with a bug budget to match.
 * Storing the same arrays server-side keeps one source of truth per account and
 * changes no logic at all. The parts that genuinely need to be shared BETWEEN
 * accounts — a goal a judge must open, a friend registering as a judge — already
 * have their own tables and are untouched by this.
 *
 * WHY A REVISION: two devices editing the same account must not silently
 * overwrite one another. Every push says which revision it started from; the
 * server refuses a stale one and hands back the current document, which is then
 * merged (below) and pushed again.
 */

import {
  remotePullState,
  remotePushState,
  sessionToken,
  isSessionExpired,
  type RemoteState,
} from './account';
import { backendEnabled } from './backend';
import { KEYS, keys as allKeys, read, remove, suppress, watch, write } from './storage';

/**
 * The keys that belong to the account and travel with it.
 *
 * Everything except the three that are device-local by nature: which session
 * this browser holds, which user it is acting as, and the device id the
 * anti-cheat check relies on being DIFFERENT per device.
 */
const DEVICE_LOCAL: string[] = [KEYS.session, KEYS.sessionToken, KEYS.stateRevision, KEYS.deviceId];

function isSynced(key: string): boolean {
  return !DEVICE_LOCAL.includes(key);
}

type Doc = Record<string, unknown>;

/* ──────────────────────────────────────────────────────────────── snapshot ── */

/** Everything this device holds for the account, as one document. */
export function snapshot(): Doc {
  const doc: Doc = {};
  for (const key of allKeys()) {
    if (!isSynced(key)) continue;
    const value = read<unknown>(key, undefined);
    if (value !== undefined) doc[key] = value;
  }
  return doc;
}

/**
 * Make LocalStorage look exactly like `doc`.
 *
 * Keys absent from the document are REMOVED, not left behind: this runs when
 * switching accounts, and the previous account's goals must not linger under
 * the new one. Writes are suppressed so adopting what the server just sent is
 * not mistaken for a local edit and pushed straight back.
 */
export function adopt(doc: Doc, revision: number): void {
  suppress(() => {
    for (const key of allKeys()) {
      if (isSynced(key) && !(key in doc)) remove(key);
    }
    for (const [key, value] of Object.entries(doc)) {
      if (isSynced(key)) write(key, value);
    }
    write(KEYS.stateRevision, revision);
  });
  known = revision;
}

/* ─────────────────────────────────────────────────────────────────── merge ── */

/** Timestamps a row might carry, newest wins. */
const STAMPS = ['updatedAt', 'decisionAt', 'completedAt', 'failedAt', 'acceptedAt', 'createdAt'];

function stampOf(row: Doc): number {
  let best = 0;
  for (const field of STAMPS) {
    const value = row[field];
    if (typeof value !== 'string') continue;
    const t = Date.parse(value);
    if (Number.isFinite(t) && t > best) best = t;
  }
  return best;
}

/** An array of `{ id, … }` records — the shape almost every key here holds. */
function isRowArray(value: unknown): value is Doc[] {
  return (
    Array.isArray(value) &&
    value.every((row) => !!row && typeof row === 'object' && !Array.isArray(row) && typeof (row as Doc).id === 'string')
  );
}

function mergeRows(local: Doc[], remote: Doc[]): Doc[] {
  const remoteById = new Map(remote.map((row) => [row.id as string, row]));
  const out: Doc[] = [];
  const taken = new Set<string>();

  // Local order first: the lists the app builds are ordered meaningfully
  // (newest goal first, newest outbox entry first) and a merge should not
  // reshuffle what the person is looking at.
  for (const row of local) {
    const id = row.id as string;
    taken.add(id);
    const other = remoteById.get(id);
    out.push(other && stampOf(other) > stampOf(row) ? other : row);
  }
  for (const row of remote) {
    if (!taken.has(row.id as string)) out.push(row);
  }
  return out;
}

/**
 * Fold two versions of the document together, preferring whichever side edited
 * a given record more recently.
 *
 * KNOWN LIMIT: a record deleted here while the other device edited it comes
 * back. That only happens when both devices wrote between the same two pushes —
 * the ordinary path is a clean push that carries deletions as normal — and
 * resurrecting a goal is a far better failure than losing one.
 */
export function mergeDocs(local: Doc, remote: Doc): Doc {
  const out: Doc = {};
  for (const key of new Set([...Object.keys(remote), ...Object.keys(local)])) {
    const l = local[key];
    const r = remote[key];
    if (isRowArray(l) && isRowArray(r)) out[key] = mergeRows(l, r);
    else if (l === undefined) out[key] = r;
    else out[key] = l; // scalars and settings: this device's value wins
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────── engine ── */

/** The revision this device last agreed with the server on. */
let known = 0;
/** True while there are local changes the server has not accepted yet. */
let pending = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<void> | null = null;
let running = false;
/** Consecutive failed pushes, for the retry backoff. */
let failures = 0;

/** How long to wait after a change before pushing, so a burst becomes one push. */
const DEBOUNCE_MS = 1200;
/** How often to look for another device's changes while the app is open. */
const POLL_MS = 60_000;

/** Called when the server rejects this device's session. Set by api.ts. */
let onSignedOut: (() => void) | null = null;

export function onSessionLost(fn: (() => void) | null): void {
  onSignedOut = fn;
}

function schedule(delay = DEBOUNCE_MS): void {
  if (!running) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void push();
  }, delay);
}

/**
 * Begin syncing this account, starting from the document the server just sent.
 * Safe to call again (switching accounts) — the previous account's state is
 * replaced wholesale.
 */
export function start(state: RemoteState): void {
  adopt(state.data, state.revision);
  pending = false;
  failures = 0;
  running = true;
  watch((key) => {
    if (!isSynced(key)) return;
    pending = true;
    schedule();
  });
  listen();
}

/**
 * Stop syncing (sign-out, or a build with no backend).
 *
 * Any pending change is pushed first, so the last thing someone did before
 * signing out is not the one thing that never reached the server. Pass
 * `{ push: false }` when the account is being deleted — there is nothing to save
 * it to, and the attempt would only race the delete.
 */
export async function stop({ push: pushFirst = true }: { push?: boolean } = {}): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (running && pending && pushFirst) await push();
  running = false;
  watch(null);
  known = 0;
  pending = false;
}

/** Wait for any in-flight or scheduled push to finish. Never throws. */
export async function flush(): Promise<void> {
  if (!running) return;
  if (timer) {
    clearTimeout(timer);
    timer = null;
    await push();
  }
  await inFlight;
}

async function push(): Promise<void> {
  if (!running || !sessionToken()) return;
  if (inFlight) {
    // A push is already going out; whatever changed since will go with the next
    // one, which the pending flag guarantees gets scheduled.
    schedule();
    return;
  }

  const task = (async () => {
    try {
      let doc = snapshot();
      let base = known;
      let result = await remotePushState(doc, base);

      if (!result.ok && result.data) {
        // Another device wrote first. Fold its document into ours and push the
        // result on top of the revision it reported.
        doc = mergeDocs(doc, result.data);
        adopt(doc, result.revision);
        base = result.revision;
        result = await remotePushState(doc, base);
      }

      if (result.ok) {
        known = result.revision;
        suppress(() => write(KEYS.stateRevision, known));
        pending = false;
        failures = 0;
      } else {
        // Lost twice in a row: rare, and the next scheduled attempt starts from
        // a fresh snapshot, so just try again rather than looping here.
        failures++;
        schedule(Math.min(30_000, 2000 * failures));
      }
    } catch (err) {
      if (isSessionExpired(err)) {
        running = false;
        watch(null);
        onSignedOut?.();
        return;
      }
      // Offline or the server is unhappy. The change stays pending and the
      // snapshot is rebuilt on the retry, so nothing is lost by waiting.
      failures++;
      console.warn('[cloud] could not save to the server, will retry:', err);
      schedule(Math.min(60_000, 3000 * failures));
    }
  })().finally(() => {
    inFlight = null;
  });

  inFlight = task;
  await task;
}

/**
 * Fetch the account's document and take on anything newer.
 *
 * With no local changes waiting, the server's copy is adopted wholesale — which
 * is what carries a DELETION made on another device. With local changes waiting,
 * the two are merged and the result pushed.
 */
export async function pull(): Promise<void> {
  if (!running || !sessionToken()) return;
  try {
    const remote = await remotePullState();
    if (remote.revision === known) return;

    if (!pending) {
      adopt(remote.data, remote.revision);
      return;
    }
    const merged = mergeDocs(snapshot(), remote.data);
    adopt(merged, remote.revision);
    schedule(0);
  } catch (err) {
    if (isSessionExpired(err)) {
      running = false;
      watch(null);
      onSignedOut?.();
      return;
    }
    console.warn('[cloud] could not check for changes:', err);
  }
}

/* ─────────────────────────────────────────────────── when to look for news ── */

let listening = false;

/**
 * Pull when the app is likely to be stale: on coming back to the tab or app, on
 * regaining a connection, and on a slow timer while it is actually on screen.
 * Nothing polls in the background — a phone with Comitra buried behind other
 * apps should not be making requests.
 */
function listen(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;

  const wake = () => {
    if (document.visibilityState === 'visible') void pull();
  };

  document.addEventListener('visibilitychange', wake);
  window.addEventListener('focus', wake);
  window.addEventListener('online', () => {
    if (pending) schedule(0);
    wake();
  });
  // A last chance to save when the app is being closed or backgrounded. Not
  // guaranteed to complete, which is why the debounce is short.
  window.addEventListener('pagehide', () => {
    if (pending) void push();
  });

  setInterval(() => {
    if (document.visibilityState === 'visible') void pull();
  }, POLL_MS);
}

/** Whether the app is currently backed by a server account. */
export function isSyncing(): boolean {
  return running && backendEnabled();
}

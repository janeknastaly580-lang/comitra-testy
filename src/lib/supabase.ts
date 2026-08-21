/**
 * Minimal Supabase client (raw fetch, no SDK, so nothing extra to bundle or
 * build for the Android WebView).
 *
 * This is the ONE shared store the app has: it is where an owner's phone and
 * their judge's phone meet. Everything else still lives in per-device
 * LocalStorage, so every call here is best-effort — callers must keep working,
 * local-only, when the backend is not configured or cannot be reached.
 *
 * EVERY ROUTE NOW NEEDS A SESSION. There used to be a second, anonymous path:
 * a judge opened a link, had no account, and the link itself was the credential.
 * Judges are app friends with accounts now and there are no judge links at all,
 * so the anonymous door is closed (the SQL grants were revoked to match) and
 * both sides of a goal are authorised by who they are signed in as.
 */

import { KEYS, read } from './storage';

const RAW_URL = import.meta.env.VITE_SUPABASE_URL?.trim();
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();

/**
 * The Edge Function's base URL. Every call in this file goes through it.
 *
 * Nothing reaches PostgREST directly any more. The direct path existed for
 * people without accounts (a judge holding a link) and was authorised by ids
 * passed as arguments — but friends know each other's ids by design, which made
 * an address into a credential. Now the backend takes the caller from the
 * session token, which is the one thing nobody can hold on someone else's
 * behalf.
 */
const API_BASE = import.meta.env.VITE_API_BASE?.trim().replace(/\/+$/, '') ?? '';

/** This device's session token, or null when nobody is signed in. */
export function sessionTokenOrNull(): string | null {
  return read<string | null>(KEYS.sessionToken, null);
}

/** Normalise `https://x.supabase.co[/rest/v1[/]]` → `https://x.supabase.co/rest/v1`. */
function restBase(): string | null {
  if (!RAW_URL) return null;
  const trimmed = RAW_URL.replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
  return `${trimmed}/rest/v1`;
}

/** Whether a Supabase URL + anon key are configured at all. */
export function supabaseEnabled(): boolean {
  // Never touch the network from the test suite, keep vitest hermetic and
  // deterministic even though .env is loaded during tests.
  if (import.meta.env.MODE === 'test') return false;
  return !!restBase() && !!ANON_KEY;
}

export type SyncErrorKind =
  | 'not-configured'
  | 'setup'
  | 'offline'
  | 'unknown'
  /** The emailed code the person typed was wrong or has expired. */
  | 'invalid-code'
  /** Too many code requests/attempts too fast (server rate limit). */
  | 'rate-limited'
  /** The email address itself isn't one we could send to. */
  | 'bad-email';

export class SyncError extends Error {
  readonly kind: SyncErrorKind;
  /** Raw server text, kept for logs: never shown verbatim to a user. */
  readonly detail?: string;
  constructor(kind: SyncErrorKind, message: string, detail?: string) {
    super(message);
    this.name = 'SyncError';
    this.kind = kind;
    this.detail = detail;
  }
}

/** Map a failed PostgREST response onto a `SyncError` with human wording. */
function classify(status: number, body: string): SyncError {
  // 42501 = insufficient_privilege → RLS refused the write. This is BY FAR the
  // most common setup mistake: the table exists (often created by hand in the
  // Table Editor, which enables RLS and adds no policies) but the insert/update
  // policies are missing, so every registration bounces.
  if (body.includes('42501') || body.includes('row-level security')) {
    return new SyncError(
      'setup',
      "Pactista's server isn't finished setting up, so your registration couldn't be saved. " +
        'This is nothing you did wrong. Tell the person who sent you this link, and try again after they fix it.',
      `RLS policy missing (42501). Run supabase/comitra_invited_judges.sql. ${body}`,
    );
  }
  // Missing table (PGRST205) or missing function (PGRST202).
  if (status === 404 || body.includes('PGRST205') || body.includes('PGRST202') || body.includes('Could not find the table')) {
    return new SyncError(
      'setup',
      "Pactista's server isn't set up for judges yet, so your registration couldn't be saved. " +
        'Tell the person who sent you this link, and try again after they fix it.',
      `Table or function missing (${status}). Run supabase/comitra_invited_judges.sql. ${body}`,
    );
  }
  if (status === 401 || status === 403) {
    return new SyncError(
      'setup',
      "Pactista's server refused to save your registration. Tell the person who sent you this link.",
      `Rejected (${status}). ${body}`,
    );
  }
  return new SyncError(
    'unknown',
    "We couldn't save your registration on the server. Check your connection and try again.",
    `HTTP ${status}. ${body}`,
  );
}

function headers(extra?: Record<string, string>): Record<string, string> {
  return {
    apikey: ANON_KEY as string,
    Authorization: `Bearer ${ANON_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

/** fetch with a short timeout so a dead network never hangs a submit/open. */
async function timedFetch(url: string, init: RequestInit, ms = 8000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/**
 * Health of the shared store, as far as it can be told without writing data.
 *
 * `unreachable` and `no-server` are both "the request never got an answer", told
 * apart by whether the device itself is online: a phone in a tunnel is a
 * different problem from a `VITE_SUPABASE_URL` that no longer resolves (a
 * deleted or renamed Supabase project), and only the second one is the owner's
 * to fix.
 */
export type SyncHealth = 'off' | 'ok' | 'setup' | 'unreachable' | 'no-server';

/**
 * Ask the server whether a friend would actually be able to register, before the
 * inviter sends anyone a link.
 *
 * A missing write policy is invisible to a read, it only surfaces when someone
 * tries to save, on THEIR phone, where the inviter never sees it. So the check
 * goes through `comitra_sync_status`, which reports whether the insert/update
 * policies exist. An older install won't have that function at all, which is
 * itself the answer: setup is incomplete.
 */
export async function remoteSyncHealth(): Promise<SyncHealth> {
  const base = restBase();
  if (!supabaseEnabled() || !base || !ANON_KEY) return 'off';
  try {
    const res = await timedFetch(
      `${base}/rpc/comitra_sync_status`,
      { method: 'POST', headers: headers(), body: '{}' },
      6000,
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return classify(res.status, text).kind === 'setup' ? 'setup' : 'unreachable';
    }
    // PostgREST returns a table-returning function as an array of rows.
    const rows = (await res.json()) as { has_insert?: boolean; has_update?: boolean }[];
    const row = Array.isArray(rows) ? rows[0] : undefined;
    return row?.has_insert && row?.has_update ? 'ok' : 'setup';
  } catch {
    // fetch rejects the same way for "no network" and "that host doesn't exist",
    // so the browser's own connectivity flag is what separates them. Online +
    // no answer = the configured project address is dead, which no amount of
    // retrying from this phone will fix.
    return navigator.onLine ? 'no-server' : 'unreachable';
  }
}

/**
 * POST one of the session-gated backend routes, quietly.
 *
 * Quiet on purpose, exactly like `rpcQuiet` was: every caller here is a
 * best-effort sync with a LocalStorage fallback, so a failure has to be an
 * answer ("we could not ask") rather than an exception that reaches a screen.
 * No session means not signed in — a guest has no account for any of this to be
 * about, so the honest answer is the same "could not ask".
 */
async function backendQuiet<T>(path: string, payload: unknown): Promise<{ ok: boolean; data: T | null }> {
  const token = sessionTokenOrNull();
  if (!API_BASE || !ANON_KEY || !token) return { ok: false, data: null };
  try {
    const res = await timedFetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: headers({ 'x-comitra-session': token }),
      body: JSON.stringify(payload ?? {}),
    });
    if (!res.ok) {
      console.warn(`[backend] ${path} -> HTTP ${res.status}`, await res.text().catch(() => ''));
      return { ok: false, data: null };
    }
    const text = await res.text();
    return { ok: true, data: (text ? JSON.parse(text) : null) as T };
  } catch {
    return { ok: false, data: null };
  }
}

/**
 * The same call, but LOUD: for the paths where silence would be a lie.
 *
 * Publishing a goal and recording a decision are things a person is told
 * happened, so "we could not reach the server" has to arrive as an error the
 * screen can show, not as a `null` that looks like "there was nothing there".
 * The server's own wording is used when it sent one — it writes those for a
 * person and leaves out anything sensitive.
 */
async function backendOrThrow<T>(path: string, payload: unknown, offlineMessage: string): Promise<T | null> {
  const token = sessionTokenOrNull();
  if (!API_BASE || !ANON_KEY) throw new SyncError('not-configured', 'Sync is not configured.');
  if (!token) throw new SyncError('not-configured', 'You need to be signed in for this.');
  let res: Response;
  try {
    res = await timedFetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: headers({ 'x-comitra-session': token }),
      body: JSON.stringify(payload ?? {}),
    });
  } catch {
    throw new SyncError('offline', offlineMessage);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let message: string;
    try {
      message = String((JSON.parse(text) as { error?: string }).error ?? '');
    } catch {
      message = '';
    }
    console.error(`[backend] ${path} -> HTTP ${res.status}`, text);
    throw new SyncError(res.status === 400 ? 'unknown' : classify(res.status, text).kind, message || offlineMessage, text);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

/* ──────────────────────────────────────────── Goals (owner + judge) ── */

/**
 * A goal as it exists outside its owner's device.
 *
 * `data` is the ALLOW-LISTED projection built by `src/lib/goalShare.ts` — the
 * goal's title and details are not in it and never reach this file. What is
 * here is what a judge must see to do their job: which numbered goal, whose, by
 * when, and the judge's own state.
 *
 * Access is by IDENTITY. A row can be written only by its owner, read only by
 * its owner or the judge named on it, and listed by that judge. The old model
 * had to be capability-based — a judge with no account could present nothing but
 * a token — and paid for it: holding the token let you rewrite the whole
 * projection, deadline included, and no "list my goals" call could exist at all
 * because a leaked link would have become a dump of everything someone was
 * working on.
 */
export interface RemoteGoalRow {
  data: unknown;
  updated_at: string;
}

/** Publish (insert or update) one goal's shared projection. Throws on failure. */
export async function remotePutGoal(input: {
  id: string;
  judgeUserId?: string;
  data: unknown;
}): Promise<void> {
  await backendOrThrow('/api/goals/put', {
    id: input.id,
    judgeUserId: input.judgeUserId ?? null,
    data: input.data,
  }, "We couldn't reach the server, so your judge may not see this yet.");
}

/**
 * Fetch one goal. Returns null when there is no such row FOR THIS ACCOUNT —
 * which covers both "no such goal" and "not yours to read", deliberately
 * indistinguishable — and throws only when the server could not be asked.
 */
export async function remoteGetGoal(id: string): Promise<RemoteGoalRow | null> {
  const data = await backendOrThrow<{ goal?: RemoteGoalRow | null }>(
    '/api/goals/get',
    { id },
    "We couldn't reach the server.",
  );
  return data?.goal ?? null;
}

/** Every goal this account is the judge of. */
export async function remoteListJudgingGoals(): Promise<{ id: string; data: unknown; updated_at: string }[]> {
  const { data } = await backendQuiet<{ goals?: { id: string; data: unknown; updated_at: string }[] }>(
    '/api/goals/judging',
    {},
  );
  return Array.isArray(data?.goals) ? data.goals : [];
}

/** What a judge is allowed to do to a goal. The server builds the patch. */
export type JudgeAction = 'accept' | 'decline' | 'completed' | 'not_completed' | 'cancel';

/**
 * Record a judge's action. The whole point is that this sends an ACTION, not a
 * goal: the new row is built server-side from the stored one, so a judge writes
 * their verdict and cannot touch anything else on it.
 */
export async function remoteJudgeAct(
  id: string,
  action: JudgeAction,
  comment?: string,
): Promise<RemoteGoalRow | null> {
  const data = await backendOrThrow<{ goal?: RemoteGoalRow | null }>(
    '/api/goals/judge-act',
    { id, action, comment: comment ?? null },
    "We couldn't reach the server, so your decision wasn't recorded. Try again.",
  );
  return data?.goal ?? null;
}

/* ─────────────────────────────────────────────────────── In-app push ──── */

/**
 * A message addressed to an ACCOUNT rather than to a phone number.
 *
 * This is what replaced the Twilio path: recipients are now people the user
 * follows and who follow back, so Pactista can reach them through their own app
 * instead of through a mobile network. `payload` is the same content the text
 * carried — who, which numbered goal, which tone — and never a goal's title.
 */
export interface RemotePushRow {
  id: string;
  to_user_id: string;
  from_user_id: string | null;
  kind: string;
  payload: Record<string, unknown>;
  created_at: string;
  delivered_at: string | null;
  read_at: string | null;
}

/**
 * Record that this account has the app open on this device, right now.
 *
 * The timestamp is the whole point: it is what later answers "is this person
 * still reachable, or did they uninstall the app?" — see `remotePushReachable`.
 *
 * No user id: the device is registered against whoever is signed in here, which
 * is the only account this phone can honestly speak for.
 */
export async function remoteTouchPushDevice(deviceId: string, platform: string): Promise<void> {
  await backendQuiet('/api/push/touch', { deviceId, platform });
}

/**
 * File this installation's FCM registration token against the signed-in account.
 *
 * Separate from `touch` because the two have nothing in common but a table.
 * Touching is a heartbeat that runs on every open; a token arrives once per
 * install and then only when Firebase rotates it, and it is the thing that
 * actually lets the backend wake this phone.
 *
 * No user id: the token is filed against whoever this session belongs to, which
 * is the only account this handset can honestly speak for. Returns whether it
 * was accepted, so `fcm.ts` knows to try again rather than believing it is
 * registered when it is not.
 */
export async function remoteRegisterPushToken(
  token: string,
  deviceId: string,
  platform: string,
): Promise<boolean> {
  const { ok } = await backendQuiet<{ ok?: boolean }>('/api/push/token', { token, deviceId, platform });
  return ok;
}

/**
 * Stop this device receiving notifications for the account signing out.
 *
 * Called BEFORE the session is dropped, because the session is what says which
 * account to unfile — see `forgetPush` in fcm.ts. The token itself stays valid
 * on the device; it is simply no longer pointed at this person.
 */
export async function remoteForgetPushToken(deviceId: string): Promise<void> {
  await backendQuiet('/api/push/forget', { deviceId });
}

/**
 * Has this person opened the app on any device within `days`?
 *
 * The one call that still names somebody else, because the question genuinely is
 * about them — the sender is deciding whether to promise a delivery. It answers
 * one boolean and nothing else, and it still needs a session to ask.
 *
 * `null` means the question could not be asked (offline, signed out) — which
 * callers must NOT read as "no". Losing the network is not evidence that
 * somebody uninstalled the app.
 */
export async function remotePushReachable(userId: string, days: number): Promise<boolean | null> {
  const { ok, data } = await backendQuiet<{ reachable?: boolean }>('/api/push/reachable', { userId, days });
  return ok && typeof data?.reachable === 'boolean' ? data.reachable : null;
}

/**
 * Queue one message for an account. Idempotent on `id`.
 *
 * The sender is not passed: the backend stamps the message with the session's
 * account. A client-chosen `from` would make "your friend nudged you" forgeable
 * by anyone.
 */
export async function remotePushSend(row: {
  id: string;
  toUserId: string;
  kind: string;
  payload: Record<string, unknown>;
}): Promise<boolean> {
  const { ok } = await backendQuiet<{ ok?: boolean }>('/api/push/send', {
    id: row.id,
    toUserId: row.toUserId,
    kind: row.kind,
    payload: row.payload,
  });
  return ok;
}

/** Everything unread for this account. Marks each row delivered on the way out. */
export async function remotePushPull(): Promise<RemotePushRow[]> {
  const { data } = await backendQuiet<{ messages?: RemotePushRow[] }>('/api/push/pull', {});
  return Array.isArray(data?.messages) ? data.messages : [];
}

export async function remotePushMarkRead(id: string): Promise<void> {
  await backendQuiet('/api/push/read', { id });
}

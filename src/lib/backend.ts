/**
 * The one place that knows how to reach Pactista's backend.
 *
 * `src/lib/email.ts` grew its own copy of this while the backend only did
 * verification codes; now that accounts and every byte of user data go through
 * the same function, the transport is shared. Nothing in
 * here is specific to a feature: base URL, the platform key, a timeout, and the
 * session header.
 */

import { SyncError, type SyncErrorKind } from './supabase';

/** Base URL of the backend, e.g. `https://<project>.supabase.co/functions/v1`. */
export const API_BASE = import.meta.env.VITE_API_BASE?.trim().replace(/\/+$/, '') ?? '';

/**
 * Supabase puts a JWT gate in front of every Edge Function, so the backend is
 * reached with the project's PUBLISHABLE key. It authorises nothing on its own —
 * every table behind these routes is locked to it — it only satisfies the
 * platform gate, which keeps unauthenticated scanning off the function.
 */
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim() ?? '';

/**
 * The header the app's own session token rides in.
 *
 * NOT `Authorization`: that one is already taken by the platform key above, and
 * two different bearer tokens cannot share a header.
 */
export const SESSION_HEADER = 'x-comitra-session';

/**
 * Whether a backend is configured at all.
 *
 * False means the app has to run in its old device-local mode: accounts still
 * work, but only on the device that made them. Also false inside vitest, which
 * keeps the suite hermetic.
 */
export function backendEnabled(): boolean {
  if (import.meta.env.MODE === 'test') return false;
  return API_BASE.length > 0;
}

/** The failure shape every route uses. */
interface Failure {
  error?: string;
  code?: string;
}

/** Map the backend's error `code` onto the app's existing SyncError kinds. */
function kindFor(code: string | undefined): SyncErrorKind {
  switch (code) {
    case 'email_not_configured':
    case 'setup':
      return 'setup';
    case 'bad-email':
      return 'bad-email';
    case 'rate-limited':
      return 'rate-limited';
    case 'invalid-code':
    case 'invalid-token':
      return 'invalid-code';
    default:
      return 'unknown';
  }
}

/** fetch with a timeout, so a dead network never hangs a form. */
export async function timedFetch(path: string, init: RequestInit, ms = 12000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(`${API_BASE}${path}`, {
      ...init,
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(ANON_KEY ? { Authorization: `Bearer ${ANON_KEY}`, apikey: ANON_KEY } : {}),
        ...(init.headers ?? {}),
      },
    });
  } finally {
    clearTimeout(t);
  }
}

/**
 * A backend failure, carrying the server's own `code` so callers can branch on
 * the specific ones they care about ("that email is taken", "log in again")
 * without matching on message text.
 */
export class BackendError extends SyncError {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number, message: string, detail?: string) {
    super(kindFor(code), message, detail);
    this.name = 'BackendError';
    this.code = code;
    this.status = status;
  }
}

async function request<T>(
  path: string,
  init: RequestInit,
  phase: string,
  timeoutMs?: number,
): Promise<T> {
  let res: Response;
  try {
    res = await timedFetch(path, init, timeoutMs);
  } catch {
    throw new SyncError('offline', "We couldn't reach the server. Check your connection and try again.");
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as Failure;
    const err = new BackendError(
      data.code ?? 'unknown',
      res.status,
      // The server writes these for a person and leaves out anything sensitive.
      data.error || 'Something went wrong. Please try again in a moment.',
      `${phase} HTTP ${res.status} (${data.code ?? 'no code'})`,
    );
    console.error('[backend]', err.detail);
    throw err;
  }
  return (await res.json().catch(() => ({}))) as T;
}

export function apiPost<T>(
  path: string,
  payload: unknown,
  phase: string,
  opts: { session?: string | null; timeoutMs?: number } = {},
): Promise<T> {
  return request<T>(
    path,
    {
      method: 'POST',
      body: JSON.stringify(payload ?? {}),
      headers: opts.session ? { [SESSION_HEADER]: opts.session } : {},
    },
    phase,
    opts.timeoutMs,
  );
}

export function apiGet<T>(
  path: string,
  phase: string,
  opts: { session?: string | null; timeoutMs?: number } = {},
): Promise<T> {
  return request<T>(
    path,
    { method: 'GET', headers: opts.session ? { [SESSION_HEADER]: opts.session } : {} },
    phase,
    opts.timeoutMs,
  );
}

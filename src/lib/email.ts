/**
 * Client for the app's own email API (`server/src/routes/email.js`).
 *
 * Everything Amazon SES lives on that backend. This file knows one URL and
 * nothing else: no AWS key, no region, no sender identity, no message bodies.
 * Nothing here would be worth extracting from the web bundle or from the
 * Android APK, which is the whole reason the integration is server-side — an
 * AWS key in a mobile app is a domain-wide phishing licence.
 *
 * Codes are never generated, stored or seen by this file either: the backend
 * keeps only a hash of them, and reports just "pending" or "approved".
 */

import { SyncError, type SyncErrorKind } from './supabase';

/** Base URL of the backend, e.g. `https://api.comitra.app`. Empty = email off. */
const API_BASE = import.meta.env.VITE_API_BASE?.trim().replace(/\/+$/, '') ?? '';

/** Whether a backend is configured at all (and we are not inside vitest). */
function apiEnabled(): boolean {
  // Keep the test suite hermetic: never touch the network from vitest.
  if (import.meta.env.MODE === 'test') return false;
  return API_BASE.length > 0;
}

/** The shape every email endpoint uses for a failure. */
interface ApiError {
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
      return 'invalid-code';
    default:
      return 'unknown';
  }
}

/** Wording used when the server sent no message of its own. */
const FALLBACK: Partial<Record<SyncErrorKind, string>> & { unknown: string } = {
  'setup': "Email verification isn't finished being set up yet. This is nothing you did wrong — try again in a little while.",
  'bad-email': "That email address doesn't look right. Check it and try again.",
  'rate-limited': 'Too many attempts. Wait about a minute, then request a new code.',
  'invalid-code': "That code isn't right, or it has expired. Check the email and try again, or resend a new code.",
  'not-configured': 'Email verification is not configured.',
  'offline': "We couldn't reach the server. Check your connection and try again.",
  'unknown': 'Something went wrong verifying your email. Please try again in a moment.',
};

function fallbackFor(kind: SyncErrorKind): string {
  return FALLBACK[kind] ?? FALLBACK.unknown;
}

/**
 * Supabase puts a JWT gate in front of every Edge Function, so the backend is
 * reached with the project's PUBLISHABLE key. It is the same key the browser
 * already ships for the shared store, and it authorises nothing on its own —
 * the tables behind these routes are locked to it. Sending it only satisfies
 * the platform gate, which keeps unauthenticated scanning off the function.
 */
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim() ?? '';

function authHeaders(): Record<string, string> {
  return ANON_KEY ? { Authorization: `Bearer ${ANON_KEY}`, apikey: ANON_KEY } : {};
}

/** fetch with a timeout, so a dead network never hangs the sign-up form. */
async function timedFetch(path: string, init: RequestInit, ms = 12000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(`${API_BASE}${path}`, {
      ...init,
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(init.headers ?? {}) },
    });
  } finally {
    clearTimeout(t);
  }
}

/** POST JSON and turn a non-2xx into a `SyncError` the sign-up form can act on. */
async function post<T>(path: string, payload: unknown, phase: string): Promise<T> {
  let res: Response;
  try {
    res = await timedFetch(path, { method: 'POST', body: JSON.stringify(payload) });
  } catch {
    throw new SyncError('offline', fallbackFor('offline'));
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as ApiError;
    const kind = kindFor(data.code);
    // The server already wrote these for a person, and deliberately leaves out
    // the address, the code and anything about the AWS account.
    const err = new SyncError(kind, data.error || fallbackFor(kind), `${phase} HTTP ${res.status} (${data.code ?? 'no code'})`);
    console.error('[email]', err.detail);
    throw err;
  }
  return (await res.json().catch(() => ({}))) as T;
}

/**
 * What the sign-up form should do about the code step.
 *
 * Three outcomes, not a boolean, because "we chose not to verify" and "we
 * cannot verify right now" must lead to opposite behaviour:
 *
 *   • `required`    — SES answered and is configured. Send a code and make the
 *     person type it. This is the normal path.
 *   • `disabled`    — verification is deliberately switched off for this build
 *     (`VITE_EMAIL_VERIFY=off`, or vitest). Create the account without a code.
 *   • `unavailable` — the backend is unreachable, or it has no SES settings.
 *     Sign-up must STOP: creating the account anyway would hand out an
 *     unverified account, which is exactly what the code step exists to prevent.
 *
 * The old boolean collapsed the last two together and silently created
 * unverified accounts whenever the backend was down.
 */
export type EmailVerifyMode = 'required' | 'disabled' | 'unavailable';

export async function emailVerificationMode(): Promise<EmailVerifyMode> {
  // Keep the test suite hermetic: never touch the network from vitest.
  if (import.meta.env.MODE === 'test') return 'disabled';
  if (!API_BASE) return 'unavailable';
  try {
    const res = await timedFetch('/api/email/status', { method: 'GET' }, 6000);
    if (!res.ok) return 'unavailable';
    const data = (await res.json()) as { configured?: boolean };
    return data?.configured === true ? 'required' : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

/**
 * Ask the backend to email a one-time code to this address. The code is
 * generated there and never travels to this device.
 */
export async function sendEmailOtp(email: string): Promise<void> {
  if (!apiEnabled()) throw new SyncError('not-configured', fallbackFor('not-configured'));
  await post('/api/email/verify/start', { email }, 'verify-start');
}

/**
 * Check the code the person typed. Resolves only when the backend approves it,
 * so a success genuinely proves they can open that mailbox; throws
 * `SyncError('invalid-code')` when it is wrong or expired.
 */
export async function verifyEmailOtp(email: string, code: string): Promise<void> {
  if (!apiEnabled()) throw new SyncError('not-configured', fallbackFor('not-configured'));
  await post('/api/email/verify/check', { email, code }, 'verify-check');
}

/**
 * Client for the app's own email API (`/api/email/*` on the backend).
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

import { API_BASE, backendEnabled as apiEnabled, timedFetch } from './backend';
import { SyncError, type SyncErrorKind } from './supabase';

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
    // A dead reset link and a dead code are the same kind of problem to the
    // person holding one, and the server already words each precisely.
    case 'invalid-code':
    case 'invalid-token':
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
 * What a code is being asked to prove.
 *
 *  • `signup` — this address belongs to the person creating an account.
 *  • `judge`  — this address belongs to the friend accepting a judge invite.
 *
 * The email is the same either way (same template, same six digits); the purpose
 * only keeps the two codes from being the same code. Without it, a judge invite
 * accepted on an address that is also mid-sign-up would retire the sign-up code,
 * and the person typing it would be told, truthfully but bafflingly, that no
 * code is waiting for them.
 */
export type OtpPurpose = 'signup' | 'judge';

/**
 * Ask the backend to email a one-time code to this address. The code is
 * generated there and never travels to this device.
 */
export async function sendEmailOtp(email: string, purpose: OtpPurpose = 'signup'): Promise<void> {
  if (!apiEnabled()) throw new SyncError('not-configured', fallbackFor('not-configured'));
  await post('/api/email/verify/start', { email, purpose }, 'verify-start');
}

/**
 * Check the code the person typed. Resolves only when the backend approves it,
 * so a success genuinely proves they can open that mailbox; throws
 * `SyncError('invalid-code')` when it is wrong or expired.
 *
 * Returns the backend's RECEIPT for that check. Sign-up hands it back when it
 * creates the account, which is how the server knows a code really was typed —
 * without it, the browser's own "yes, they verified" would be enough to open a
 * permanent account on somebody else's address.
 */
export async function verifyEmailOtp(
  email: string,
  code: string,
  purpose: OtpPurpose = 'signup',
): Promise<string | undefined> {
  if (!apiEnabled()) throw new SyncError('not-configured', fallbackFor('not-configured'));
  const data = await post<{ ticket?: string }>('/api/email/verify/check', { email, code, purpose }, 'verify-check');
  return data?.ticket;
}

/**
 * Ask the backend to email a password-reset link.
 *
 * Resolves the same way whether or not an account exists, so this cannot be used
 * to find out who is registered, and the UI must not pretend it knows either.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  if (!apiEnabled()) throw new SyncError('not-configured', fallbackFor('not-configured'));
  await post('/api/email/reset/start', { email }, 'reset-start');
}

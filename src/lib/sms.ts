/**
 * Client for the app's own SMS API (`server/src/routes/sms.js`).
 *
 * Everything Twilio lives on that backend. This file knows one URL and nothing
 * else: no Account SID, no API key, no Messaging Service SID, no message
 * templates. Nothing here would be worth extracting from the web bundle or from
 * the Android APK, which is the whole reason the integration is server-side.
 *
 * Codes are never generated, stored or seen by this file either — the backend
 * keeps only a hash of them, and reports just "pending" or "approved".
 */

import { SyncError, type SyncErrorKind } from './supabase';

/** Base URL of the backend, e.g. `https://api.comitra.app`. Empty = SMS off. */
const API_BASE = import.meta.env.VITE_API_BASE?.trim().replace(/\/+$/, '') ?? '';

/** Whether a backend is configured at all (and we are not inside vitest). */
function apiEnabled(): boolean {
  // Keep the test suite hermetic: never touch the network from vitest.
  if (import.meta.env.MODE === 'test') return false;
  return API_BASE.length > 0;
}

/** The shape every SMS endpoint uses for a failure. */
interface ApiError {
  error?: string;
  code?: string;
}

/** Map the backend's error `code` onto the app's existing SyncError kinds. */
function kindFor(code: string | undefined): SyncErrorKind {
  switch (code) {
    case 'sms_not_configured':
    case 'setup':
      return 'setup';
    case 'bad-phone':
    case 'undeliverable':
      return 'bad-phone';
    case 'rate-limited':
      return 'rate-limited';
    case 'invalid-code':
      return 'invalid-code';
    default:
      return 'unknown';
  }
}

/** Wording used when the server sent no message of its own. */
const FALLBACK: Record<SyncErrorKind, string> = {
  'setup': "Text-message verification isn't finished being set up yet. This is nothing you did wrong. Tell the person who sent you this link, and try again once they've turned it on.",
  'bad-phone': "That phone number doesn't look right. Check the country and number, then try again.",
  'bad-email': "That email address doesn't look right. Check it and try again.",
  'rate-limited': 'Too many attempts. Wait about a minute, then request a new code.',
  'invalid-code': "That code isn't right, or it has expired. Check the text and try again, or resend a new code.",
  'not-configured': 'Phone verification is not configured.',
  'offline': "We couldn't reach the server. Check your connection and try again.",
  'unknown': 'Something went wrong verifying your phone. Please try again in a moment.',
};

/**
 * Supabase puts a JWT gate in front of every Edge Function, so the backend is
 * reached with the project's PUBLISHABLE key — the same one the browser already
 * ships. It authorises nothing on its own: the tables behind these routes are
 * locked to it, and sending it only satisfies the platform gate.
 */
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim() ?? '';

function authHeaders(): Record<string, string> {
  return ANON_KEY ? { Authorization: `Bearer ${ANON_KEY}`, apikey: ANON_KEY } : {};
}

/** fetch with a timeout, so a dead network never hangs the invite form. */
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

/** POST JSON and turn a non-2xx into a `SyncError` the invite page can act on. */
async function post<T>(path: string, payload: unknown, phase: string): Promise<T> {
  let res: Response;
  try {
    res = await timedFetch(path, { method: 'POST', body: JSON.stringify(payload) });
  } catch {
    throw new SyncError('offline', FALLBACK.offline);
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as ApiError;
    const kind = kindFor(data.code);
    // The server already wrote these for a person, and deliberately leaves out
    // the number, the code and anything about the Twilio account.
    const err = new SyncError(kind, data.error || FALLBACK[kind], `${phase} HTTP ${res.status} (${data.code ?? 'no code'})`);
    console.error('[sms]', err.detail);
    throw err;
  }
  return (await res.json().catch(() => ({}))) as T;
}

/* ────────────────────────────────────────────── phone verification (OTP) ── */

/**
 * Whether this deployment can text a verification code, i.e. whether the
 * backend has Twilio credentials. Best-effort: any failure reports `false`, so
 * sign-up and the judge-invite flow simply proceed without an SMS step, exactly
 * as they did before Twilio was set up. Nothing breaks while the values are
 * still blank.
 */
export async function smsVerificationAvailable(): Promise<boolean> {
  if (!apiEnabled()) return false;
  try {
    const res = await timedFetch('/api/sms/status', { method: 'GET' }, 6000);
    if (!res.ok) return false;
    const data = (await res.json()) as { configured?: boolean };
    return data?.configured === true;
  } catch {
    return false;
  }
}

/**
 * Ask the backend to text a one-time code to this number (E.164). The code is
 * generated there and never travels to this device.
 */
export async function sendPhoneOtp(phone: string): Promise<void> {
  if (!apiEnabled()) throw new SyncError('not-configured', FALLBACK['not-configured']);
  await post('/api/sms/verify/start', { phone }, 'verify-start');
}

/**
 * Check the code the person typed. Resolves only when the backend approves it,
 * so a success genuinely proves they hold the number; throws
 * `SyncError('invalid-code')` when it is wrong or expired.
 */
export async function verifyPhoneOtp(phone: string, code: string): Promise<void> {
  if (!apiEnabled()) throw new SyncError('not-configured', FALLBACK['not-configured']);
  await post('/api/sms/verify/check', { phone, code }, 'verify-check');
}

/* ─────────────────────────────────────────────── transactional messages ── */

/** Templates the backend is willing to render. The text lives there, not here. */
export type SmsTemplate =
  | 'judge_review_request'
  | 'goal_not_completed'
  | 'judge_invite'
  | 'recipient_invite';

export interface SmsSendInput {
  /** Destination in E.164 (`+48…`). */
  to: string;
  template: SmsTemplate;
  /** Values the template fills in: ownerName, goalNumber, tone, link. Never free text. */
  params?: Record<string, string | number | undefined>;
  /**
   * Stable id for this logical message — the outbox entry id. Sending twice
   * with the same key is a no-op, so a retry can never text someone twice.
   */
  idempotencyKey: string;
}

/**
 * Send one transactional text. Best-effort by design: the app's outbox is the
 * record of what should be delivered, and a failure here must never break the
 * flow that triggered it (marking a goal, dispatching a failure notice).
 *
 * @returns true when the backend accepted it.
 */
export async function sendTransactionalSms(input: SmsSendInput): Promise<boolean> {
  if (!apiEnabled()) return false;
  try {
    await post('/api/sms/send', input, 'send');
    return true;
  } catch (err) {
    console.warn('[sms] transactional send skipped:', (err as SyncError).detail ?? (err as Error).message);
    return false;
  }
}

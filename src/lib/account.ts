/**
 * The account API: sign-up, log-in, sessions, and the account's data document.
 *
 * This is the file that makes a Comitra account a real account. Before it, an
 * account was a row in one browser's LocalStorage — logging in somewhere else
 * could not work, because there was nothing anywhere else to log in TO. Now the
 * account lives in Postgres behind the `api` Edge Function, and this module is
 * the only thing in the app that talks to it.
 *
 * What this file does NOT do: hold a password for longer than the request that
 * carries it, or store anything but the session token. The token is the whole
 * of "stay logged in", and it is the only credential on the device.
 */

import { apiGet, apiPost, backendEnabled, BackendError } from './backend';
import { KEYS, read, remove, suppress, write } from './storage';
import { SyncError } from './supabase';

/** The account as the server describes it. The profile lives in the document. */
export interface RemoteAccount {
  id: string;
  email: string;
  name: string;
  accountType: 'standard' | 'trainer';
  emailVerifiedAt: string | null;
}

export interface RemoteState {
  data: Record<string, unknown>;
  revision: number;
}

export interface AuthResult {
  account: RemoteAccount;
  state: RemoteState;
}

/* ─────────────────────────────────────────────────────────── session token ── */

/**
 * The session token, kept out of the synced document on purpose: it identifies
 * THIS device's session, so copying it into another device's storage would be
 * handing over the account.
 */
export function sessionToken(): string | null {
  return read<string | null>(KEYS.sessionToken, null);
}

function setSessionToken(token: string | null): void {
  // Suppressed: the token is device-local, so writing it is not a change to the
  // account's data and must not schedule a push.
  suppress(() => {
    if (token) write(KEYS.sessionToken, token);
    else remove(KEYS.sessionToken);
  });
}

export function signedInRemotely(): boolean {
  return backendEnabled() && !!sessionToken();
}

/* ────────────────────────────────────────────────────────────────── errors ── */

/** True when the server said this session is no longer valid. */
export function isSessionExpired(err: unknown): boolean {
  return err instanceof BackendError && (err.code === 'session-expired' || err.status === 401);
}

/** True when the address is already registered. */
export function isEmailTaken(err: unknown): boolean {
  return err instanceof BackendError && err.code === 'email-taken';
}

function requireBackend(): void {
  if (!backendEnabled()) {
    throw new SyncError(
      'not-configured',
      "Comitra can't reach its server, so accounts aren't available in this build.",
    );
  }
}

function shape(user: unknown, state: unknown): AuthResult {
  const u = (user ?? {}) as Partial<RemoteAccount>;
  const s = (state ?? {}) as Partial<RemoteState>;
  return {
    account: {
      id: String(u.id ?? ''),
      email: String(u.email ?? ''),
      name: String(u.name ?? ''),
      accountType: u.accountType === 'trainer' ? 'trainer' : 'standard',
      emailVerifiedAt: u.emailVerifiedAt ?? null,
    },
    state: {
      data: (s.data as Record<string, unknown>) ?? {},
      revision: Number(s.revision ?? 0),
    },
  };
}

/* ─────────────────────────────────────────────────────────────────── auth ── */

/** Is this address free to register? Asked before a code is emailed. */
export async function remoteEmailAvailable(email: string): Promise<boolean> {
  requireBackend();
  const res = await apiPost<{ available?: boolean }>('/api/auth/available', { email }, 'auth-available');
  return res.available === true;
}

/**
 * Create the account. `ticket` is the receipt the verify-code step handed back;
 * the server insists on one whenever email verification is switched on, so a
 * tampered client cannot register an address it does not own.
 */
export async function remoteRegister(input: {
  name: string;
  email: string;
  password: string;
  accountType: 'standard' | 'trainer';
  ticket?: string;
}): Promise<AuthResult> {
  requireBackend();
  const res = await apiPost<{ token?: string; user?: unknown; state?: unknown }>(
    '/api/auth/register',
    input,
    'auth-register',
  );
  if (!res.token) throw new SyncError('unknown', 'We could not finish creating your account. Please try again.');
  setSessionToken(res.token);
  return shape(res.user, res.state);
}

export async function remoteLogin(email: string, password: string): Promise<AuthResult> {
  requireBackend();
  const res = await apiPost<{ token?: string; user?: unknown; state?: unknown }>(
    '/api/auth/login',
    { email, password },
    'auth-login',
  );
  if (!res.token) throw new SyncError('unknown', 'We could not sign you in. Please try again.');
  setSessionToken(res.token);
  return shape(res.user, res.state);
}

export async function remoteSocialLogin(profile: { email: string; name: string }): Promise<AuthResult> {
  requireBackend();
  const res = await apiPost<{ token?: string; user?: unknown; state?: unknown }>(
    '/api/auth/social',
    profile,
    'auth-social',
  );
  if (!res.token) throw new SyncError('unknown', 'We could not sign you in. Please try again.');
  setSessionToken(res.token);
  return shape(res.user, res.state);
}

/**
 * Who is this device signed in as? The cold-start call.
 *
 * Returns null both for "no token" and "the token is no longer good", and clears
 * a dead token on the way out so the next start does not retry it. Network
 * trouble is reported by throwing, which the caller treats as "assume the
 * session is still fine and work offline" — signing someone out because their
 * train went into a tunnel would be far worse than showing them stale data.
 */
export async function remoteSession(): Promise<AuthResult | null> {
  if (!backendEnabled()) return null;
  const token = sessionToken();
  if (!token) return null;
  try {
    const res = await apiGet<{ user?: unknown; state?: unknown }>('/api/auth/session', 'auth-session', {
      session: token,
      timeoutMs: 8000,
    });
    if (!res.user) {
      setSessionToken(null);
      return null;
    }
    return shape(res.user, res.state);
  } catch (err) {
    if (isSessionExpired(err)) {
      setSessionToken(null);
      return null;
    }
    throw err;
  }
}

/** Drop the session on the server, and always locally. */
export async function remoteLogout(): Promise<void> {
  const token = sessionToken();
  setSessionToken(null);
  if (!token || !backendEnabled()) return;
  try {
    await apiPost('/api/auth/logout', {}, 'auth-logout', { session: token });
  } catch {
    // Already signed out here, which is what the person asked for. A server-side
    // session that outlives it expires on its own.
  }
}

export async function remoteDeleteAccount(): Promise<void> {
  const token = sessionToken();
  if (!token || !backendEnabled()) return;
  try {
    await apiPost('/api/auth/delete', {}, 'auth-delete', { session: token });
  } finally {
    setSessionToken(null);
  }
}

/** Keep the account row's display name in step with the profile screen. */
export async function remoteRename(name: string): Promise<void> {
  const token = sessionToken();
  if (!token || !backendEnabled()) return;
  try {
    await apiPost('/api/auth/rename', { name }, 'auth-rename', { session: token });
  } catch (err) {
    // Cosmetic on the server side; the name people see comes from the document.
    console.warn('[account] could not update the stored name:', err);
  }
}

/**
 * Spend a password-reset link and set the new password, in one call. Succeeding
 * signs this device in — the person just proved they own the mailbox.
 */
export async function remoteApplyPasswordReset(token: string, password: string): Promise<AuthResult> {
  requireBackend();
  const res = await apiPost<{ token?: string; user?: unknown; state?: unknown }>(
    '/api/email/reset/apply',
    { token, password },
    'reset-apply',
  );
  if (!res.token) throw new SyncError('unknown', 'We could not set your new password. Ask for a fresh link.');
  setSessionToken(res.token);
  return shape(res.user, res.state);
}

/* ────────────────────────────────────────────────────── the state document ── */

export async function remotePullState(): Promise<RemoteState> {
  const token = sessionToken();
  if (!token) throw new SyncError('not-configured', 'Not signed in.');
  const res = await apiPost<{ data?: unknown; revision?: number }>('/api/state/pull', {}, 'state-pull', {
    session: token,
  });
  return { data: (res.data as Record<string, unknown>) ?? {}, revision: Number(res.revision ?? 0) };
}

/**
 * Push the document.
 *
 * `ok: false` is NOT a failure — it means another device wrote first, and the
 * current document comes back with it so the caller can merge and try again.
 */
export async function remotePushState(
  data: Record<string, unknown>,
  revision: number,
): Promise<{ ok: boolean; revision: number; data: Record<string, unknown> | null }> {
  const token = sessionToken();
  if (!token) throw new SyncError('not-configured', 'Not signed in.');
  const res = await apiPost<{ ok?: boolean; revision?: number; data?: unknown }>(
    '/api/state/push',
    { data, revision },
    'state-push',
    { session: token, timeoutMs: 20000 },
  );
  return {
    ok: res.ok === true,
    revision: Number(res.revision ?? revision),
    data: (res.data as Record<string, unknown>) ?? null,
  };
}

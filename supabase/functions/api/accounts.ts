/**
 * Accounts, sessions, and the per-account state document.
 *
 * This is the file that turned Pactista from "your data is on this phone" into a
 * real account. Everything an account IS now lives in Postgres (see
 * supabase/comitra_accounts.sql), so signing in on a second device reaches the
 * same account and the same goals rather than an empty one.
 *
 * The three secrets involved, and why none of them is stored in a usable form:
 *
 *   • **The password** is never stored. What is stored is a PBKDF2-HMAC-SHA256
 *     verifier with a per-account 16-byte salt, so identical passwords produce
 *     different rows and a stolen table is an offline grind rather than a list
 *     of logins. Comparison is constant-time.
 *   • **The session token** is 32 bytes of CSPRNG output and is stored only as
 *     its keyed HMAC — the same treatment the one-time codes next door get. A
 *     dump of `comitra_sessions` cannot be replayed into anyone's account.
 *   • **The sign-up ticket** proving an address was verified is likewise a
 *     random token stored by hash, single-use, and short-lived.
 *
 * PBKDF2 rather than Argon2/scrypt because `crypto.subtle` implements it
 * natively in the Deno runtime — a pure-JS Argon2 would be both slower for us
 * and no slower for an attacker with a GPU. The iteration count is written into
 * every stored hash, so it can be raised later without invalidating a single
 * existing account.
 */

import { normalizeEmail } from './address.ts';
import { ApiError } from './errors.ts';
import { hashKey } from './otp.ts';
import { consumeReset, putReset, rpc } from './state.ts';

/* ──────────────────────────────────────────────────────────────── passwords ── */

/**
 * Tuned against the Edge Function's CPU budget: a login has to finish well
 * inside it while still costing an attacker real time per guess. Raising this
 * is safe at any point — old hashes carry their own count and keep verifying.
 */
const PBKDF2_ITERATIONS = 250_000;
const SALT_BYTES = 16;
const KEY_BITS = 256;

/** Sign-up and login both refuse anything shorter; the UI says so too. */
export const MIN_PASSWORD_LENGTH = 8;
/** A cap only so a megabyte of "password" cannot be used to burn CPU. */
const MAX_PASSWORD_LENGTH = 200;

const encoder = new TextEncoder();

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(value: string): Uint8Array {
  const bin = atob(value);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    key,
    KEY_BITS,
  );
  return new Uint8Array(bits);
}

/** `pbkdf2$<iterations>$<salt b64>$<derived b64>` — self-describing on purpose. */
export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(salt);
  const derived = await derive(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(derived)}`;
}

/** Length-safe, branch-free comparison: a timing signal here leaks the hash. */
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations) || iterations < 1000 || iterations > 5_000_000) return false;
  try {
    const derived = await derive(password, fromBase64(parts[2]), iterations);
    return equalBytes(derived, fromBase64(parts[3]));
  } catch {
    return false;
  }
}

/** Shape check before anything expensive. Wording matches the sign-up form. */
export function requirePassword(raw: unknown): string {
  const value = typeof raw === 'string' ? raw : '';
  if (value.length < MIN_PASSWORD_LENGTH || value.length > MAX_PASSWORD_LENGTH) {
    throw new ApiError(
      'bad-password',
      `Your password needs to be at least ${MIN_PASSWORD_LENGTH} characters.`,
      400,
      'password failed length check',
    );
  }
  return value;
}

export function requireEmail(raw: unknown): string {
  const value = normalizeEmail(raw);
  if (!value) {
    throw new ApiError('bad-email', "That email address doesn't look right. Check it and try again.", 400, 'address failed validation');
  }
  return value;
}

/* ───────────────────────────────────────────────────────── sign-up tickets ── */

/**
 * How long the proof of "this person just read a code at this address" is good
 * for. Long enough to choose a password and a display name, short enough that a
 * ticket left in a closed tab is worthless.
 */
const TICKET_TTL_MS = 20 * 60_000;

/**
 * Tickets and password-reset links share one table, told apart two ways: their
 * hashes are computed under different scopes (so neither can be presented as the
 * other), and the address is stored with a `signup:` marker (so asking for a
 * password reset does not retire a pending sign-up, or the reverse).
 */
const TICKET_PREFIX = 'signup:';

/** Issue the proof that an address was just verified. */
export async function issueSignupTicket(email: string): Promise<string> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const ticket = toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await putReset(await hashKey('signup', ticket), TICKET_PREFIX + email, TICKET_TTL_MS);
  return ticket;
}

/**
 * Spend a ticket and confirm it was issued for this exact address.
 *
 * Without this, `register` would be taking the browser's word for "the code was
 * correct" — which would let anyone create a real, permanent account on someone
 * else's address and squat it.
 */
export async function spendSignupTicket(ticket: unknown, email: string): Promise<void> {
  const value = typeof ticket === 'string' ? ticket.trim() : '';
  if (!value || value.length > 200 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ApiError('verification-required', 'Confirm your email address again, then create the account.', 400, 'signup ticket failed shape check');
  }
  const { outcome, email: stored } = await consumeReset(await hashKey('signup', value));
  if (outcome !== 'ok' || stored !== TICKET_PREFIX + email) {
    throw new ApiError(
      'verification-required',
      'That confirmation has expired. Ask for a new code and try again.',
      400,
      `signup ticket ${outcome}${outcome === 'ok' ? ' for a different address' : ''}`,
    );
  }
}

/* ──────────────────────────────────────────────────────────────── sessions ── */

/**
 * How long a device stays signed in, refreshed on every request that carries
 * the token. An app opened even once a quarter never asks for a password again;
 * one abandoned on a lost phone stops working.
 */
export const SESSION_TTL_MS = 90 * 24 * 3600_000;

export function newSessionToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * The header the app sends its session token in.
 *
 * NOT `Authorization`: Supabase's own gate already owns that header (it carries
 * the project's publishable key, which is what lets the request reach this
 * function at all). Two different bearer tokens cannot share one header.
 */
export const SESSION_HEADER = 'x-comitra-session';

export function sessionTokenFrom(req: Request): string | null {
  const raw = req.headers.get(SESSION_HEADER)?.trim() ?? '';
  if (!raw || raw.length > 200 || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  return raw;
}

export interface Account {
  id: string;
  email: string;
  name: string;
  accountType: string;
  emailVerifiedAt: string | null;
}

export async function createSession(userId: string): Promise<string> {
  const token = newSessionToken();
  await rpc<null>('comitra_session_create', {
    p_token_hash: await hashKey('session', token),
    p_user_id: userId,
    p_ttl_ms: SESSION_TTL_MS,
  });
  return token;
}

export async function dropSession(token: string): Promise<void> {
  await rpc<null>('comitra_session_drop', { p_token_hash: await hashKey('session', token) });
}

/** Resolve a token to its account, or null. Also slides the expiry forward. */
export async function accountForToken(token: string): Promise<Account | null> {
  const rows = await rpc<Array<{
    user_id: string; email: string; name: string; account_type: string; email_verified_at: string | null;
  }>>('comitra_session_touch', {
    p_token_hash: await hashKey('session', token),
    p_ttl_ms: SESSION_TTL_MS,
  });
  const row = rows?.[0];
  if (!row) return null;
  return {
    id: row.user_id,
    email: row.email,
    name: row.name,
    accountType: row.account_type,
    emailVerifiedAt: row.email_verified_at,
  };
}

/**
 * The account behind this request, or a 401 the app knows to treat as "signed
 * out" rather than as an error worth showing.
 */
export async function requireAccount(req: Request): Promise<Account> {
  const token = sessionTokenFrom(req);
  const account = token ? await accountForToken(token) : null;
  if (!account) {
    throw new ApiError('session-expired', 'Please log in again.', 401, 'missing or unknown session token');
  }
  return account;
}

/* ──────────────────────────────────────────────────────────────── accounts ── */

export async function emailAvailable(emailKey: string): Promise<boolean> {
  const rows = await rpc<Array<{ available: boolean }>>('comitra_account_available', { p_email_key: emailKey });
  return rows?.[0]?.available ?? false;
}

export async function createAccount(input: {
  email: string;
  name: string;
  passwordHash: string | null;
  accountType: string;
  provider: string;
  emailVerified: boolean;
}): Promise<string> {
  const rows = await rpc<Array<{ id: string | null; taken: boolean }>>('comitra_account_create', {
    p_email: input.email,
    p_email_key: input.email,
    p_name: input.name,
    p_password_hash: input.passwordHash,
    p_account_type: input.accountType,
    p_provider: input.provider,
    p_email_verified: input.emailVerified,
  });
  const row = rows?.[0];
  if (!row || row.taken || !row.id) {
    throw new ApiError('email-taken', 'An account with this email already exists.', 409, 'email_key already present');
  }
  return row.id;
}

export interface StoredAccount extends Account {
  passwordHash: string | null;
  provider: string;
}

export async function accountByEmail(emailKey: string): Promise<StoredAccount | null> {
  const rows = await rpc<Array<{
    id: string; email: string; name: string; password_hash: string | null;
    account_type: string; provider: string; email_verified_at: string | null;
  }>>('comitra_account_by_email', { p_email_key: emailKey });
  const row = rows?.[0];
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    accountType: row.account_type,
    emailVerifiedAt: row.email_verified_at,
    passwordHash: row.password_hash,
    provider: row.provider,
  };
}

export async function upsertSocialAccount(input: {
  email: string;
  name: string;
  provider: string;
}): Promise<{ id: string; created: boolean }> {
  const rows = await rpc<Array<{ id: string; created: boolean }>>('comitra_account_upsert_social', {
    p_email: input.email,
    p_email_key: input.email,
    p_name: input.name,
    p_provider: input.provider,
  });
  const row = rows?.[0];
  if (!row?.id) throw new ApiError('unknown', 'We could not sign you in. Please try again.', 502, 'upsert_social returned no id');
  return { id: row.id, created: row.created };
}

/** Returns the account id whose password was changed, or null if none matched. */
export async function setAccountPassword(emailKey: string, hash: string): Promise<string | null> {
  const rows = await rpc<Array<{ id: string }>>('comitra_account_set_password', {
    p_email_key: emailKey,
    p_hash: hash,
  });
  return rows?.[0]?.id ?? null;
}

export function renameAccount(id: string, name: string): Promise<null> {
  return rpc<null>('comitra_account_rename', { p_id: id, p_name: name });
}

export function deleteAccount(id: string): Promise<null> {
  return rpc<null>('comitra_account_delete', { p_id: id });
}

/* ─────────────────────────────────────────────────────── state document ──── */

export async function getState(userId: string): Promise<{ data: unknown; revision: number }> {
  const rows = await rpc<Array<{ data: unknown; revision: number }>>('comitra_state_get', { p_user_id: userId });
  const row = rows?.[0];
  return { data: row?.data ?? {}, revision: row?.revision ?? 0 };
}

/**
 * Write the document if the caller is still up to date.
 *
 * A refusal is not an error: it comes back with the current document so the
 * device that lost the race can fold its own changes into it and push again.
 */
export async function putState(
  userId: string,
  data: unknown,
  baseRevision: number,
): Promise<{ ok: boolean; revision: number; data: unknown }> {
  const rows = await rpc<Array<{ ok: boolean; revision: number; data: unknown }>>('comitra_state_put', {
    p_user_id: userId,
    p_data: data,
    p_base_revision: baseRevision,
  });
  const row = rows?.[0];
  if (!row) throw new ApiError('unknown', 'We could not save your data. Please try again.', 502, 'state_put returned no row');
  return { ok: row.ok, revision: row.revision, data: row.data ?? null };
}

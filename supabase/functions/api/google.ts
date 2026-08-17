/**
 * Proving that a "Continue with Google" really came from Google.
 *
 * WHY THIS FILE EXISTS. `/api/auth/social` used to believe the browser. It took
 * an `email` out of the request body, looked the account up by it, and issued a
 * session — so anyone who could reach the endpoint could post
 * `{"email":"someone@else.com"}` and be handed that person's account, with no
 * password and no code. The publishable key that reaches the endpoint ships
 * inside the APK, so "anyone" meant anyone. That was the single worst hole in
 * the backend, and it is what this file closes.
 *
 * HOW. The app already holds a Google OAuth access token (src/lib/google.ts asks
 * for one through Google Identity Services). It now sends that token instead of
 * an address, and the address is read from GOOGLE's answer — never from the
 * request. A caller who does not hold a live Google token gets 401, and one who
 * does can only ever sign in as the account that token belongs to.
 *
 * The audience check is the second half. A token proves someone signed into
 * Google, but not that they did it HERE: a malicious app the same person once
 * used could replay its own token against this endpoint. `aud` names the client
 * id the token was minted for, so requiring it to be ours makes a token from
 * anywhere else useless. It is enforced whenever GOOGLE_CLIENT_ID is set, and
 * its absence is logged loudly rather than silently skipped.
 */

import { normalizeEmail } from './address.ts';
import { GOOGLE_CLIENT_ID } from './config.ts';
import { ApiError } from './errors.ts';

/** One call answers both questions: who is this, and was it minted for us. */
const TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';
/** Fallback for a token whose scopes leave the address out of tokeninfo. */
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

/** Google is a third party on the request path; it must not hang a sign-in. */
const TIMEOUT_MS = 6000;

export interface GoogleIdentity {
  email: string;
  name: string;
}

/**
 * One wording for every failure. Which check failed (bad shape, dead token,
 * wrong audience, unverified address) is a detail for the log — telling the
 * caller would help someone probing the endpoint and helps nobody else.
 */
function unverified(detail: string): ApiError {
  return new ApiError(
    'google-unverified',
    "We couldn't confirm that Google sign-in. Please try again.",
    401,
    detail,
  );
}

async function fetchJson(url: string, init?: RequestInit): Promise<Record<string, unknown> | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Google returns this as the string "true" from one endpoint and a boolean from the other. */
function isTrue(value: unknown): boolean {
  return value === true || value === 'true';
}

/**
 * Turn a Google access token into the address Google says it belongs to, or
 * throw. The returned address is the ONLY one the caller may sign in as.
 */
export async function verifyGoogleAccessToken(raw: unknown): Promise<GoogleIdentity> {
  const token = typeof raw === 'string' ? raw.trim() : '';
  // Shape check before a round trip: a token is opaque, but it is always a
  // bounded run of URL-safe characters, and rejecting junk here keeps a flood of
  // nonsense from turning into a flood of requests to Google.
  if (!token || token.length < 20 || token.length > 4096 || !/^[A-Za-z0-9._~+/=-]+$/.test(token)) {
    throw unverified('google token failed shape check');
  }

  const info = await fetchJson(`${TOKENINFO_URL}?access_token=${encodeURIComponent(token)}`);
  if (!info) throw unverified('tokeninfo rejected the token or could not be reached');

  const aud = typeof info.aud === 'string' ? info.aud : '';
  if (GOOGLE_CLIENT_ID) {
    if (aud !== GOOGLE_CLIENT_ID) {
      throw unverified(`token audience ${aud || '(none)'} is not this app`);
    }
  } else {
    // Not fatal — the token is still genuine and still names its own owner, so
    // impersonation is already impossible. But without this the endpoint accepts
    // a token minted for a DIFFERENT application, which is a door left ajar.
    console.error('[google] GOOGLE_CLIENT_ID is not set — cannot check which app this token was issued to.');
  }

  let email = normalizeEmail(info.email);
  let verified = isTrue(info.email_verified);

  if (!email) {
    const profile = await fetchJson(USERINFO_URL, { headers: { Authorization: `Bearer ${token}` } });
    if (!profile) throw unverified('token carried no address and userinfo could not be read');
    email = normalizeEmail(profile.email);
    verified = isTrue(profile.email_verified);
  }

  if (!email) throw unverified('google returned no usable address');
  // An unverified Google address is one somebody typed, not one they proved they
  // own — signing it in would put the hole straight back.
  if (!verified) throw unverified('google reports the address as unverified');

  const rawName = typeof info.name === 'string' ? info.name : '';
  return { email, name: rawName.trim().slice(0, 80) };
}

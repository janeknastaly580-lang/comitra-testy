/**
 * Password-reset links.
 *
 * A reset link is a capability, not a password: holding it proves only that
 * someone can open that mailbox, and that is exactly the claim a reset is
 * supposed to check. So it is treated like the one-time codes next door —
 *
 *   • the token is 256 bits of CSPRNG output, not six digits, because unlike a
 *     code it is never typed by hand and never rate-limited by an attempt
 *     counter — guessing has to be made impossible rather than merely slow;
 *   • only its keyed HMAC is stored, so a dump of the table cannot be turned
 *     back into working links;
 *   • single use and hard expiry, enforced in one SQL transaction;
 *   • asking for a new link retires the previous one.
 */

import { APP_URL } from './config.ts';
import { ApiError } from './errors.ts';
import { hashKey } from './otp.ts';
import { consumeReset, putReset } from './state.ts';

/**
 * How long a reset link works. Longer than a sign-up code (7 minutes) on
 * purpose: a code is typed straight back into a form that is already open,
 * while a link means leaving the app, finding the mail, and choosing a new
 * password — often on a different screen.
 */
export const RESET_TTL_MS = 30 * 60_000;

/** URL-safe token. 32 bytes is far beyond anything guessable. */
function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Issue a link for an address.
 *
 * Deliberately says nothing about whether an account exists. A link is minted
 * for any valid address and simply finds nothing to reset when there is no
 * account, so the "forgot password" form cannot be used to discover who is
 * registered.
 */
export async function issueResetLink(email: string): Promise<{ link: string; token: string }> {
  if (!APP_URL) {
    throw new ApiError(
      'setup',
      "We can't send a reset link right now. Please try again later.",
      503,
      'APP_URL and CLIENT_ORIGIN are both unset, so no reset link can be built',
    );
  }
  const token = generateToken();
  await putReset(await hashKey('reset', token), email, RESET_TTL_MS);
  // Hash routing: the app is served as a single page, so the path lives after #.
  return { link: `${APP_URL}/#/reset-password?token=${encodeURIComponent(token)}`, token };
}

/**
 * Spend a token and hand back the address it was issued for, so the app can
 * find the matching local account.
 */
export async function redeemResetToken(token: unknown): Promise<string> {
  const value = typeof token === 'string' ? token.trim() : '';
  // Cheap shape check first: a malformed token must not cost a round trip.
  if (!value || value.length > 200 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ApiError('invalid-token', 'That reset link is not valid. Ask for a new one.', 400, 'token failed shape check');
  }

  const { outcome, email } = await consumeReset(await hashKey('reset', value));

  if (outcome === 'ok' && email) return email;
  if (outcome === 'expired') {
    throw new ApiError('invalid-token', 'That reset link has expired. Ask for a new one.', 400, 'reset token expired');
  }
  throw new ApiError(
    'invalid-token',
    'That reset link has already been used, or a newer one was sent. Ask for a new link.',
    400,
    'reset token not found',
  );
}

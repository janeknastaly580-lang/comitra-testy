/**
 * One-time passcodes for the two things an email code proves: that a new account
 * owns its address, and that a friend accepting a judge invite owns theirs.
 *
 * The secret lifecycle is the one server/src/email/verify.js established, and it
 * survives the move to Postgres unchanged:
 *
 *   • **The plaintext code is never stored.** It exists as a local variable long
 *     enough to be put in the message; only its HMAC-SHA256 digest is kept.
 *   • **Keyed hashing, not a bare digest.** Six digits is a million candidates,
 *     which a plain SHA-256 table walks through instantly. The digest is keyed
 *     with a pepper that lives in a function secret — never in the database, so
 *     a dump of the table is not enough to brute-force a code.
 *   • **The destination is not a key either** — rows are filed under a keyed
 *     hash of the address, so the table holds none.
 *   • **A code is bound to its PURPOSE.** Sign-up and judge-invite codes for the
 *     same address are separate rows, so accepting an invite never consumes the
 *     code someone is halfway through typing into the sign-up form (and a code
 *     issued for one can never be presented for the other).
 *   • **Single use, capped attempts, hard expiry**, all enforced in SQL so two
 *     concurrent guesses cannot each get a fresh five.
 */

import { OTP_PEPPER } from './config.ts';
import { ApiError } from './errors.ts';
import { checkOtp, dropOtp, putOtp, type OtpOutcome } from './state.ts';

/**
 * How long a code stays valid, from the moment it is generated. The row is keyed
 * by a hash of (purpose, address), so a code is bound to exactly one address in
 * exactly one flow and cannot be presented for another.
 */
export const EMAIL_CODE_TTL_MS = 7 * 60_000;

/**
 * What a code is being asked to prove. `signup` keeps the scoping it has always
 * had, so codes already in someone's inbox still verify across a deploy.
 */
export type CodePurpose = 'signup' | 'judge';

/** The value a code is bound to: the address, tagged with its purpose. */
function scopeFor(purpose: CodePurpose, destination: string): string {
  return purpose === 'signup' ? destination : `${purpose}:${destination}`;
}
/** Wrong guesses allowed before the code is destroyed. */
export const MAX_ATTEMPTS = 5;
/** Digits in a code. The app's input is sized for exactly this. */
export const CODE_DIGITS = 6;

const encoder = new TextEncoder();

function pepperOrThrow(): string {
  if (!OTP_PEPPER) {
    throw new ApiError(
      'setup',
      "We couldn't send the code because verification isn't finished being set up on our side. Please try again later.",
      503,
      'COMITRA_OTP_PEPPER is not set on this function',
    );
  }
  return OTP_PEPPER;
}

/**
 * Keyed hash of any value, scoped so the same input in two roles never collides.
 *
 * Everything the database is asked to remember about a person goes through here
 * first: the address or number a code belongs to, and the IP behind a rate
 * bucket. The tables therefore hold no addresses, no numbers and no IPs.
 */
export async function hashKey(scope: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(pepperOrThrow()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`${scope}:${value}`));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The row key for a destination — never the address itself. */
export function destinationKey(purpose: CodePurpose, destination: string): Promise<string> {
  return hashKey('email', scopeFor(purpose, destination));
}

/** The digest stored for a code, bound to its destination so it cannot be moved. */
export function codeDigest(destination: string, code: string): Promise<string> {
  return hashKey('code', `${destination}:${code}`);
}

/**
 * A cryptographically random six-digit code.
 *
 * Rejection sampling rather than a plain modulo: `% 1e6` over a 32-bit draw is
 * very slightly biased toward low codes, and matching Node's `randomInt`
 * guarantee costs one loop that almost never runs twice.
 */
export function generateCode(): string {
  const max = 10 ** CODE_DIGITS;
  const limit = Math.floor(0xffffffff / max) * max;
  const buf = new Uint32Array(1);
  let draw: number;
  do {
    crypto.getRandomValues(buf);
    draw = buf[0];
  } while (draw >= limit);
  return String(draw % max).padStart(CODE_DIGITS, '0');
}

/** Whether a typed code even has the right shape, before touching the store. */
export function looksLikeCode(raw: unknown): raw is string {
  return typeof raw === 'string' && new RegExp(`^\\d{${CODE_DIGITS}}$`).test(raw.trim());
}

/**
 * Issue a code for a destination and hand back the plaintext for the message.
 * Any earlier code for the same destination is retired: two live codes would
 * double the guesses on offer.
 */
export async function issueCode(
  purpose: CodePurpose,
  destination: string,
  ttlMs: number,
): Promise<{ code: string; key: string }> {
  const code = generateCode();
  const key = await destinationKey(purpose, destination);
  await putOtp('email', key, await codeDigest(scopeFor(purpose, destination), code), ttlMs, MAX_ATTEMPTS);
  return { code, key };
}

/** Forget a code whose message never went out. */
export async function abandonCode(key: string): Promise<void> {
  await dropOtp('email', key);
}

/**
 * Verify a typed code, turning the SQL outcome into the error the frontend
 * already knows how to word.
 */
export async function verifyCode(
  purpose: CodePurpose,
  destination: string,
  typed: string,
): Promise<void> {
  const key = await destinationKey(purpose, destination);
  const digest = await codeDigest(scopeFor(purpose, destination), typed);
  const { outcome, attemptsLeft } = await checkOtp('email', key, digest);

  if (outcome === 'approved') return;

  const target = 'address';
  // 'none' and 'expired' are DIFFERENT things and must not share wording. A
  // missing row usually means the code was already used, or retired by a newer
  // one — telling that person "expired" sends them off to wait for a clock that
  // is not running.
  const failures: Record<Exclude<OtpOutcome, 'approved'>, ApiError> = {
    none: new ApiError(
      'invalid-code',
      `No code is waiting for this ${target}. It was probably already used, or replaced by a newer one — ask for a new code.`,
      400,
      'no pending code',
    ),
    expired: new ApiError(
      'invalid-code',
      'That code has expired. Ask for a new one.',
      400,
      'code expired',
    ),
    burnt: new ApiError(
      'rate-limited',
      'Too many wrong codes. Request a new code and try again.',
      429,
      `otp attempts exhausted after ${MAX_ATTEMPTS}`,
    ),
    wrong: new ApiError(
      'invalid-code',
      `That code isn't right. ${attemptsLeft} ${attemptsLeft === 1 ? 'try' : 'tries'} left, or ask for a new code.`,
      400,
      'wrong code',
    ),
  };

  throw failures[outcome];
}

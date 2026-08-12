import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

import { SmsError } from './client.js';
import { sendSmsBody } from './messaging.js';
import { maskPhone, normalizeE164 } from './phone.js';
import { LIMITS, takeSlot } from './throttle.js';
import { verificationCodeMessage } from './templates.js';

/**
 * One-time passcodes over SMS.
 *
 * The code is issued and checked here, and texted through the same Messaging
 * Service as every other message — there is no Twilio Verify Service in the
 * picture, so `.env` needs no `VA…` SID.
 *
 * What that costs us is that the secret lifecycle is now this file's job, so it
 * is written to the same rules Verify follows:
 *
 *   • **The plaintext code is never stored.** It exists as a local variable for
 *     the length of one `startVerification` call, long enough to be put in the
 *     text, and only its HMAC-SHA256 digest is kept. A heap dump, a crash log or
 *     a `console.log(store)` yields nothing that can be replayed.
 *   • **Keyed hashing, not a bare digest.** Six digits is a million candidates,
 *     which a plain SHA-256 rainbow table walks through instantly. The digest is
 *     keyed with a pepper generated at boot and held only in memory, so a stolen
 *     copy of the store cannot be brute-forced without it.
 *   • **The phone number is not a key either** — entries are filed under a
 *     keyed hash of the number, for the same reason.
 *   • **Seven minutes, five attempts.** An expired or exhausted entry is deleted,
 *     not just refused, so a code can never be checked twice after it dies.
 *   • **Single use.** A correct code deletes its entry, so it cannot be replayed
 *     even inside the seven minutes.
 *
 * In-memory on purpose, matching throttle.js: this backend is a single process.
 * A restart therefore invalidates every pending code — the person asks for a new
 * one, which is the same experience as a code expiring.
 */

/**
 * How long a code stays valid, counted from the moment it is generated. The
 * entry is filed under a keyed hash of the E.164 number, so a code is bound to
 * exactly one phone and cannot be presented for another.
 *
 * Mirrored in templates.js and in src/components/CodeVerify.tsx — change all
 * three together.
 */
export const CODE_TTL_MS = 7 * 60_000;
/** Wrong guesses allowed before the code is destroyed and a new one is needed. */
export const MAX_ATTEMPTS = 5;
/** Digits in a code. The UI's input is sized for exactly this. */
const CODE_DIGITS = 6;

/**
 * Pepper for both the entry keys and the code digests. Regenerated on every
 * boot and never written anywhere: it exists so that possessing the store is not
 * enough to recover a code.
 */
const PEPPER = randomBytes(32);

function digest(scope, value) {
  return createHmac('sha256', PEPPER).update(`${scope}:${value}`).digest();
}

/** keyed phone hash -> { hash: Buffer, expiresAt: number, attemptsLeft: number } */
const pending = new Map();

/** Drop expired codes so the map cannot grow without bound. */
function sweep(now) {
  for (const [key, entry] of pending) {
    if (entry.expiresAt <= now) pending.delete(key);
  }
}

let lastSweep = 0;
function maybeSweep(now) {
  if (now - lastSweep > 60_000) {
    lastSweep = now;
    sweep(now);
  }
}

/** A cryptographically random code, zero-padded, e.g. `049182`. */
function generateCode() {
  return String(randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, '0');
}

/** Forget every pending code. Tests only. */
export function resetVerificationsForTests() {
  pending.clear();
  lastSweep = 0;
}

/**
 * Text a verification code to a phone number.
 *
 * @param {{phone: string}} input  `phone` in any human format; normalised here.
 * @returns {Promise<{to: string, masked: string, status: string}>}
 * @throws {SmsError} with a `code` the API layer turns into an HTTP status.
 */
export async function startVerification({ phone }) {
  const to = normalizeE164(phone);
  if (!to) {
    throw new SmsError(
      'bad-phone',
      "That phone number doesn't look right. Include the country code, then try again.",
      400,
      'phone failed E.164 validation before any Twilio call',
    );
  }

  // Local gate first: a rejected resend must not cost a Twilio request, and the
  // cooldown is what stops one number being used to spray texts at someone.
  const slot = takeSlot(
    'otp-send',
    to,
    { max: LIMITS.otpSendsPerHour, windowMs: 3600_000, cooldownMs: LIMITS.otpResendCooldownMs },
    Date.now(),
  );
  if (!slot.allowed) {
    throw new SmsError(
      'rate-limited',
      slot.reason === 'cooldown'
        ? `A code was just sent. Wait ${slot.retryAfterSec}s before asking for another.`
        : 'Too many codes requested for this number. Try again later.',
      429,
      `local otp-send ${slot.reason}`,
    );
  }

  const now = Date.now();
  maybeSweep(now);

  const code = generateCode();
  const key = digest('phone', to).toString('hex');
  // Replaces any earlier code for this number: asking for a new one must retire
  // the old one, or two live codes would double the guesses on offer.
  pending.set(key, {
    hash: digest('code', `${to}:${code}`),
    expiresAt: now + CODE_TTL_MS,
    attemptsLeft: MAX_ATTEMPTS,
  });

  try {
    await sendSmsBody({ to, body: verificationCodeMessage(code) });
  } catch (err) {
    // The text never went out, so leaving a live code behind would strand the
    // person on a code they were never shown.
    pending.delete(key);
    throw err;
  }

  // The code is not in the return value, and nothing about it is logged.
  return { to, masked: maskPhone(to), status: 'pending' };
}

/**
 * Check a code the person typed.
 *
 * @returns {Promise<{approved: true}>}
 * @throws {SmsError} `invalid-code` when it is wrong, expired or used up.
 */
export async function checkVerification({ phone, code }) {
  const to = normalizeE164(phone);
  if (!to) {
    throw new SmsError('bad-phone', "That phone number doesn't look right.", 400, 'phone failed E.164 validation');
  }
  const typed = typeof code === 'string' ? code.trim() : '';
  if (!new RegExp(`^\\d{${CODE_DIGITS}}$`).test(typed)) {
    throw new SmsError(
      'invalid-code',
      `That code isn't right. It's the ${CODE_DIGITS} digits from the text message.`,
      400,
      'code failed shape check',
    );
  }

  const now = Date.now();
  maybeSweep(now);

  const key = digest('phone', to).toString('hex');
  const entry = pending.get(key);
  if (!entry || entry.expiresAt <= now) {
    pending.delete(key);
    throw new SmsError(
      'invalid-code',
      "That code has expired, or no code was requested for this number. Ask for a new one.",
      400,
      entry ? 'code expired' : 'no pending code for this number',
    );
  }

  const candidate = digest('code', `${to}:${typed}`);
  // Both digests are 32 bytes, so the length check timingSafeEqual demands is
  // structurally satisfied and the compare itself cannot leak by position.
  if (timingSafeEqual(candidate, entry.hash)) {
    // Single use: consumed the moment it is accepted.
    pending.delete(key);
    return { approved: true };
  }

  entry.attemptsLeft -= 1;
  if (entry.attemptsLeft <= 0) {
    // Burnt: destroy it rather than leave a guessable code alive.
    pending.delete(key);
    throw new SmsError(
      'rate-limited',
      `Too many wrong codes. Request a new code and try again.`,
      429,
      `otp attempts exhausted after ${MAX_ATTEMPTS}`,
    );
  }

  throw new SmsError(
    'invalid-code',
    `That code isn't right. ${entry.attemptsLeft} ${entry.attemptsLeft === 1 ? 'try' : 'tries'} left, or ask for a new code.`,
    400,
    'wrong code',
  );
}

import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

import { EmailError } from './client.js';
import { emailConfig } from './config.js';
import { normalizeEmail, maskEmail } from './address.js';
import { sendEmail } from './send.js';
import { verificationCodeEmail } from './templates.js';
import { LIMITS, takeSlot } from './throttle.js';

/**
 * One-time passcodes over email — the sign-up flow's proof that the address
 * someone typed is one they can actually open.
 *
 * The secret lifecycle is the one the SMS flow used before it was removed, for the same
 * reasons:
 *
 *   • **The plaintext code is never stored.** It lives as a local variable for
 *     the length of one `startEmailVerification` call, long enough to be put in
 *     the message, and only its HMAC-SHA256 digest is kept.
 *   • **Keyed hashing, not a bare digest.** Six digits is a million candidates,
 *     which a plain SHA-256 table walks through instantly. The digest is keyed
 *     with a pepper generated at boot and held only in memory.
 *   • **The address is not a key either** — entries are filed under a keyed
 *     hash of it, so a heap dump holds no email addresses.
 *   • **Seven minutes, five attempts.** An expired or exhausted entry is deleted,
 *     not just refused, so a code can never be checked after it dies.
 *   • **Single use.** A correct code deletes its entry, so it cannot be replayed
 *     inside the seven minutes.
 *
 * The per-address cooldown and hourly quota come from the same throttle store
 * the SMS side uses, under their own bucket names, so codes to one address are
 * capped no matter how many IPs ask for them.
 *
 * In-memory on purpose: this backend is a single process. A restart invalidates
 * every pending code, which for the person is the same as a code expiring.
 */

/**
 * How long a code stays valid, counted from the moment it is generated.
 * Mirrored in the email copy (templates.js) and in the app's copy
 * (src/components/CodeVerify.tsx) — change all three together.
 */
export const CODE_TTL_MS = 7 * 60_000;
/** Wrong guesses allowed before the code is destroyed and a new one is needed. */
export const MAX_ATTEMPTS = 5;
/** Digits in a code. The UI's input is sized for exactly this. */
const CODE_DIGITS = 6;

/**
 * Pepper for both the entry keys and the code digests. Regenerated on every
 * boot and never written anywhere: possessing the store is not enough to
 * recover a code.
 */
const PEPPER = randomBytes(32);

function digest(scope, value) {
  return createHmac('sha256', PEPPER).update(`${scope}:${value}`).digest();
}

/** keyed address hash -> { hash: Buffer, expiresAt: number, attemptsLeft: number } */
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
export function resetEmailVerificationsForTests() {
  pending.clear();
  lastSweep = 0;
}

/**
 * Email a verification code to an address.
 *
 * @param {{email: string}} input  `email` in any case; normalised here.
 * @returns {Promise<{to: string, masked: string, status: string}>}
 * @throws {EmailError} with a `code` the API layer turns into an HTTP status.
 */
export async function startEmailVerification({ email }) {
  const to = normalizeEmail(email);
  if (!to) {
    throw new EmailError(
      'bad-email',
      "That email address doesn't look right. Check it and try again.",
      400,
      'address failed validation before any SES call',
    );
  }

  // Local gate first: a rejected resend must not cost an SES request, and the
  // cooldown is what stops one address being used to mail-bomb someone.
  const slot = takeSlot(
    'email-otp-send',
    to,
    { max: LIMITS.otpSendsPerHour, windowMs: 3600_000, cooldownMs: LIMITS.otpResendCooldownMs },
    Date.now(),
  );
  if (!slot.allowed) {
    throw new EmailError(
      'rate-limited',
      slot.reason === 'cooldown'
        ? `A code was just sent. Wait ${slot.retryAfterSec}s before asking for another.`
        : 'Too many codes requested for this address. Try again later.',
      429,
      `local email-otp-send ${slot.reason}`,
    );
  }

  const now = Date.now();
  maybeSweep(now);

  const code = generateCode();
  const key = digest('email', to).toString('hex');
  // Replaces any earlier code for this address: asking for a new one must
  // retire the old one, or two live codes would double the guesses on offer.
  pending.set(key, {
    hash: digest('code', `${to}:${code}`),
    expiresAt: now + CODE_TTL_MS,
    attemptsLeft: MAX_ATTEMPTS,
  });

  try {
    if (emailConfig.templateName) {
      // The email itself lives in SES. The ONLY thing handed to the template is
      // the six digits — no name, no address, nothing about the goal — which is
      // why a single-variable template is all this ever needs.
      await sendEmail({
        to,
        templateName: emailConfig.templateName,
        templateData: { [emailConfig.templateVar]: code },
      });
    } else {
      const { subject, text, html } = verificationCodeEmail(code);
      await sendEmail({ to, subject, text, html });
    }
  } catch (err) {
    // The email never went out, so leaving a live code behind would strand the
    // person on a code they were never shown.
    pending.delete(key);
    throw err;
  }

  // The code is not in the return value, and nothing about it is logged.
  return { to, masked: maskEmail(to), status: 'pending' };
}

/**
 * Check a code the person typed.
 *
 * @returns {Promise<{approved: true}>}
 * @throws {EmailError} `invalid-code` when it is wrong, expired or used up.
 */
export async function checkEmailVerification({ email, code }) {
  const to = normalizeEmail(email);
  if (!to) {
    throw new EmailError('bad-email', "That email address doesn't look right.", 400, 'address failed validation');
  }
  const typed = typeof code === 'string' ? code.trim() : '';
  if (!new RegExp(`^\\d{${CODE_DIGITS}}$`).test(typed)) {
    throw new EmailError(
      'invalid-code',
      `That code isn't right. It's the ${CODE_DIGITS} digits from the email.`,
      400,
      'code failed shape check',
    );
  }

  const now = Date.now();
  maybeSweep(now);

  const key = digest('email', to).toString('hex');
  const entry = pending.get(key);
  // "Nothing here" and "it died of old age" are different things, and saying
  // "expired" for both sends someone who just used their code off to wait.
  if (!entry) {
    throw new EmailError(
      'invalid-code',
      'No code is waiting for this address. It was probably already used, or replaced by a newer one — ask for a new code.',
      400,
      'no pending code for this address',
    );
  }
  if (entry.expiresAt <= now) {
    pending.delete(key);
    throw new EmailError('invalid-code', 'That code has expired. Ask for a new one.', 400, 'code expired');
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
    throw new EmailError(
      'rate-limited',
      'Too many wrong codes. Request a new code and try again.',
      429,
      `email otp attempts exhausted after ${MAX_ATTEMPTS}`,
    );
  }

  throw new EmailError(
    'invalid-code',
    `That code isn't right. ${entry.attemptsLeft} ${entry.attemptsLeft === 1 ? 'try' : 'tries'} left, or ask for a new code.`,
    400,
    'wrong code',
  );
}

/**
 * Email and phone handling — the port of server/src/email/address.js and
 * server/src/twilio/phone.js, kept byte-for-byte compatible in behaviour so a
 * value that worked against the Express backend still works here.
 *
 * Nothing in this file logs. `maskEmail` / `maskPhone` exist precisely so the
 * rest of the function never has a reason to put a full address or number in a
 * log line.
 */

/**
 * Deliberately loose. A regex cannot decide whether an address exists, and a
 * strict one rejects real addresses; the point is only to catch input that could
 * never be one before it costs an SES call.
 */
const EMAIL = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]{2,}$/;

/** RFC 5321 caps a path at 256 octets. */
const MAX_EMAIL_LENGTH = 254;

/** E.164: `+`, a non-zero country code digit, then 7–14 more digits. */
const E164 = /^\+[1-9]\d{7,14}$/;

/** Trim + lower-case, or `null` when it could not be an address. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  if (!value || value.length > MAX_EMAIL_LENGTH) return null;
  return EMAIL.test(value) ? value : null;
}

/**
 * Normalise user input to E.164, or return `null` when it cannot be one.
 *
 * Accepts the shapes people actually type — spaces, dashes, brackets, dots, a
 * leading `00` — but never *guesses* a country: a number with no `+` and no `00`
 * is rejected, because assuming a default country is how texts end up at the
 * wrong person's phone.
 */
export function normalizeE164(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let value = raw.trim().replace(/[\s().\-‐-―]/g, '');
  if (value.startsWith('00')) value = `+${value.slice(2)}`;
  if (!value.startsWith('+')) return null;
  value = `+${value.slice(1).replace(/\D/g, '')}`;
  return E164.test(value) ? value : null;
}

/** `a•••@example.com` — enough to spot your own typo'd domain, not a mailing list. */
export function maskEmail(value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const at = normalized.lastIndexOf('@');
  if (at < 1) return '<redacted>';
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  return `${local[0]}${'•'.repeat(Math.max(3, local.length - 1))}@${domain}`;
}

/** `+48•••••••00` — enough to correlate a support report, not a phone number. */
export function maskPhone(value: unknown): string {
  if (typeof value !== 'string' || value.length < 5) return '<redacted>';
  const digits = value.replace(/\D/g, '');
  if (digits.length < 5) return '<redacted>';
  const head = value.startsWith('+') ? `+${digits.slice(0, 2)}` : digits.slice(0, 2);
  const tail = digits.slice(-2);
  return `${head}${'•'.repeat(Math.max(3, digits.length - 4))}${tail}`;
}

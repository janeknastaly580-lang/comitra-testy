/**
 * Email address handling, the counterpart of twilio/phone.js.
 *
 * Two jobs, and they must not be confused:
 *   • `normalizeEmail` produces the address a message is SENT to. It only
 *     trims and lower-cases, because the local part of an address is
 *     case-sensitive per RFC 5321 in theory and gmail-style dot/plus tricks are
 *     provider-specific — rewriting them would deliver to a different mailbox.
 *   • `verificationKey` produces the string the OTP store is keyed by. Here the
 *     rules can be stricter (they never touch delivery), which is what stops
 *     "Me@x.com" and "me@x.com" being two separate pending codes.
 *
 * Nothing in this file logs; `maskEmail` exists so the rest of the server never
 * has a reason to put a full address in a log line.
 */

/**
 * Deliberately loose. A regex cannot decide whether an address exists, and a
 * strict one rejects real addresses; the point is only to catch input that
 * could never be one before it costs an SES call.
 */
const EMAIL = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]{2,}$/;

/** Longest address accepted (RFC 5321 caps a path at 256 octets). */
const MAX_LENGTH = 254;

/** Trim + lower-case, or `null` when it could not be an address. */
export function normalizeEmail(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  if (!value || value.length > MAX_LENGTH) return null;
  return EMAIL.test(value) ? value : null;
}

/** Whether a string is an acceptable address. */
export function isEmail(value) {
  return normalizeEmail(value) !== null;
}

/** The key a pending code is filed under; see the note at the top of the file. */
export function verificationKey(value) {
  return normalizeEmail(value);
}

/**
 * An address safe to write to a log or return in an error: first character of
 * the local part and the domain, e.g. `a•••@example.com`. Enough to correlate a
 * support report and to let someone spot their own typo'd domain, not enough to
 * be a mailing list.
 */
export function maskEmail(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const at = normalized.lastIndexOf('@');
  if (at < 1) return '<redacted>';
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  return `${local[0]}${'•'.repeat(Math.max(3, local.length - 1))}@${domain}`;
}

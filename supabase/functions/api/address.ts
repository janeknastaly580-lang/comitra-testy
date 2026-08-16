/**
 * Email handling — the port of server/src/email/address.js, kept byte-for-byte
 * compatible in behaviour so a value that worked against the Express backend
 * still works here.
 *
 * Nothing in this file logs. `maskEmail` exists precisely so the rest of the
 * function never has a reason to put a full address in a log line.
 */

/**
 * Deliberately loose. A regex cannot decide whether an address exists, and a
 * strict one rejects real addresses; the point is only to catch input that could
 * never be one before it costs an SES call.
 */
const EMAIL = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]{2,}$/;

/** RFC 5321 caps a path at 256 octets. */
const MAX_EMAIL_LENGTH = 254;

/** Trim + lower-case, or `null` when it could not be an address. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  if (!value || value.length > MAX_EMAIL_LENGTH) return null;
  return EMAIL.test(value) ? value : null;
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

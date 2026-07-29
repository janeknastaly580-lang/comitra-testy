/**
 * E.164 phone handling.
 *
 * Twilio requires E.164 (`+`, country calling code, subscriber number, max 15
 * digits total). Rejecting a bad number here — rather than letting Twilio do it
 * — keeps a typo from costing an API call and turning into a generic 60200.
 *
 * Nothing in this file logs; `maskPhone` exists precisely so that the rest of
 * the server never has a reason to put a full number in a log line.
 */

/** E.164: `+`, a non-zero country code digit, then 7–14 more digits. */
const E164 = /^\+[1-9]\d{7,14}$/;

/**
 * Normalise user input to E.164, or return `null` when it cannot be one.
 *
 * Accepts the shapes people actually type — spaces, dashes, brackets, dots, a
 * leading `00` international prefix — but never *guesses* a country: a number
 * with no `+` and no `00` is rejected, because assuming a default country is
 * how texts end up at the wrong person's phone.
 */
export function normalizeE164(raw) {
  if (typeof raw !== 'string') return null;
  let value = raw.trim().replace(/[\s().\-‐-―]/g, '');
  if (value.startsWith('00')) value = `+${value.slice(2)}`;
  if (!value.startsWith('+')) return null;
  // Strip anything that is not a digit after the leading '+'.
  value = `+${value.slice(1).replace(/\D/g, '')}`;
  return E164.test(value) ? value : null;
}

/** Whether a string is already a valid E.164 number. */
export function isE164(value) {
  return typeof value === 'string' && E164.test(value);
}

/**
 * A number safe to write to a log or return in an error: country code and the
 * last two digits only, e.g. `+48•••••••00`. Enough to correlate a support
 * report, not enough to be a phone number.
 */
export function maskPhone(value) {
  if (typeof value !== 'string' || value.length < 5) return '<redacted>';
  const digits = value.replace(/\D/g, '');
  if (digits.length < 5) return '<redacted>';
  const head = value.startsWith('+') ? `+${digits.slice(0, 2)}` : digits.slice(0, 2);
  const tail = digits.slice(-2);
  return `${head}${'•'.repeat(Math.max(3, digits.length - 4))}${tail}`;
}

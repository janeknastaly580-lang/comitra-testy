import { getTwilioClient, mapTwilioError, SmsError } from './client.js';
import { twilioConfig } from './config.js';
import { maskPhone, normalizeE164 } from './phone.js';
import {
  clearCheckAttempts,
  countCheckAttempt,
  LIMITS,
  takeSlot,
} from './throttle.js';

/**
 * One-time passcodes over SMS, via Twilio Verify.
 *
 * Verify — not a home-made code — owns the whole secret lifecycle: it generates
 * the digits, stores them hashed, expires them after 10 minutes, counts check
 * attempts, and deletes the verification the moment it is approved. The code
 * therefore never exists in this process, so it cannot be logged, dumped or
 * leaked from here. That is the point of using Verify over Messaging for OTP.
 */

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

  try {
    const verification = await getTwilioClient()
      .verify.v2.services(twilioConfig.verifyServiceSid)
      .verifications.create({ to, channel: 'sms' });

    // `verification.status` is 'pending'; the code itself is never returned by
    // the API, and nothing about this object is logged.
    return { to, masked: maskPhone(to), status: verification.status };
  } catch (err) {
    throw mapTwilioError(err, 'verify-start');
  }
}

/**
 * Check a code the person typed.
 *
 * A wrong code is counted locally as well as by Twilio, so a number being
 * brute-forced stops generating API calls after a handful of guesses.
 *
 * @returns {Promise<{approved: true}>}
 * @throws {SmsError} `invalid-code` when it is wrong, expired or used up.
 */
export async function checkVerification({ phone, code }) {
  const to = normalizeE164(phone);
  if (!to) {
    throw new SmsError('bad-phone', "That phone number doesn't look right.", 400, 'phone failed E.164 validation');
  }
  // Verify accepts 4–10 characters; this app always issues 6 digits.
  if (typeof code !== 'string' || !/^\d{4,10}$/.test(code.trim())) {
    throw new SmsError('invalid-code', "That code isn't right. It's the 6 digits from the text message.", 400, 'code failed shape check');
  }

  if (!countCheckAttempt(to)) {
    throw new SmsError(
      'rate-limited',
      'Too many wrong codes for this number. Request a new code and try again.',
      429,
      'local otp-check attempts exhausted',
    );
  }

  let status;
  try {
    const check = await getTwilioClient()
      .verify.v2.services(twilioConfig.verifyServiceSid)
      .verificationChecks.create({ to, code: code.trim() });
    status = check.status;
  } catch (err) {
    throw mapTwilioError(err, 'verify-check');
  }

  if (status !== 'approved') {
    // 'pending' = wrong digits; 'expired'/'canceled'/'max_attempts_reached' =
    // start over. All of them mean the same thing to the person typing.
    throw new SmsError(
      'invalid-code',
      "That code isn't right, or it has expired. Check the text and try again, or ask for a new code.",
      400,
      `verification status ${status}`,
    );
  }

  clearCheckAttempts(to);
  return { approved: true };
}

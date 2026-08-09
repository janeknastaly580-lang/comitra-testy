import twilio from 'twilio';
import { twilioConfig } from './config.js';

/**
 * The single Twilio REST client for the whole process, plus the mapping from
 * Twilio's errors onto something safe to hand back to a browser.
 *
 * Authentication uses the API Key SID + Secret with the Account SID passed
 * separately — Twilio's recommended server credential. The Auth Token is not
 * used here; it belongs to webhook signature checking only, and is optional.
 */

let client = null;

/** True when the process holds real Twilio credentials. */
export function isConfigured() {
  return twilioConfig.configured === true;
}

/** Thrown when an SMS route is hit before anyone filled in the Twilio values. */
export class SmsNotConfiguredError extends Error {
  constructor() {
    super('SMS is not configured on this server.');
    this.name = 'SmsNotConfiguredError';
    this.code = 'sms_not_configured';
    this.httpStatus = 503;
  }
}

/**
 * A failure that already carries a message written for the person on the phone.
 * `code` is the machine-readable kind the frontend maps onto its own wording.
 */
export class SmsError extends Error {
  constructor(code, message, httpStatus = 502, detail) {
    super(message);
    this.name = 'SmsError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.detail = detail;
  }
}

/** Lazily build the client so an unconfigured server still boots and serves. */
export function getTwilioClient() {
  if (client) return client;
  if (!isConfigured()) throw new SmsNotConfiguredError();
  client = twilio(twilioConfig.apiKeySid, twilioConfig.apiKeySecret, {
    accountSid: twilioConfig.accountSid,
    // Retry once on Twilio's own 429/5xx before surfacing a failure.
    autoRetry: true,
    maxRetries: 1,
  });
  return client;
}

/**
 * Swap in a stand-in client. Tests only — it lets the messaging and OTP modules
 * be exercised without a network call or a real credential. Pass `null` to
 * restore the real, lazily-built one.
 */
export function setTwilioClientForTests(fake) {
  client = fake;
}

/**
 * Translate a Twilio REST exception into an `SmsError`.
 *
 * Twilio's own text is deliberately NOT forwarded to the client: it leaks
 * account structure and sometimes the full number. It goes to `detail`, which
 * only the server-side logger sees.
 *
 * Codes: https://www.twilio.com/docs/api/errors
 */
export function mapTwilioError(err, phase) {
  const code = Number(err?.code);
  const status = Number(err?.status);
  const detail = `twilio ${phase} failed (status ${status || '?'}, code ${code || '?'})`;

  switch (code) {
    case 21211: // Invalid 'To' phone number.
      return new SmsError('bad-phone', "That phone number doesn't look right. Check the country and number, then try again.", 400, detail);

    case 20429: // Too many requests.
      return new SmsError('rate-limited', 'Too many attempts. Wait about a minute, then try again.', 429, detail);

    case 21614: // 'To' is not a valid mobile number (e.g. a landline).
      return new SmsError('bad-phone', "That number can't receive text messages. Use a mobile number.", 400, detail);

    case 21608: // Trial account: unverified recipient.
    case 21610: // Recipient replied STOP.
    case 21612: // Not reachable from this sender.
      return new SmsError('undeliverable', "We can't text that number. Try a different one.", 400, detail);

    case 20404: // Resource not found — in practice a wrong Messaging Service SID.
    case 20003: // Authenticate — bad API key/secret, or the key lacks permission.
    case 20005: // Account not active.
      return new SmsError('setup', 'Text messaging is not finished being set up on the server.', 503, detail);

    default:
      break;
  }

  if (status === 429) {
    return new SmsError('rate-limited', 'Too many attempts. Wait about a minute, then try again.', 429, detail);
  }
  if (status === 401 || status === 403) {
    return new SmsError('setup', 'Text messaging is not finished being set up on the server.', 503, detail);
  }
  if (status >= 400 && status < 500) {
    return new SmsError('bad-request', "We couldn't send that message. Check the number and try again.", 400, detail);
  }
  return new SmsError('unavailable', "The text couldn't be sent right now. Please try again in a moment.", 502, detail);
}

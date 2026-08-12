/**
 * Sending texts through a Twilio Messaging Service.
 *
 * A Messaging Service — rather than a bare `from` number — is what gives the
 * account its sender pool, per-country sender selection and opt-out handling, so
 * no phone number is hardcoded anywhere in this repo.
 *
 * The REST API is called directly rather than through the `twilio` npm package:
 * it is one form-encoded POST with Basic auth, and the SDK is a large dependency
 * to load into a cold isolate for that.
 */

import { twilioConfig } from './config.ts';
import { ApiError } from './errors.ts';

/**
 * Map a Twilio failure onto something safe to hand a browser. Twilio's own text
 * leaks account structure and sometimes the full number, so it goes to `detail`.
 *
 * Codes: https://www.twilio.com/docs/api/errors
 */
function mapTwilioError(code: number, status: number, message: string): ApiError {
  const detail = `twilio message-send failed (status ${status || '?'}, code ${code || '?'}): ${message}`;

  switch (code) {
    case 21211: // Invalid 'To' phone number.
      return new ApiError('bad-phone', "That phone number doesn't look right. Check the country and number, then try again.", 400, detail);
    case 21614: // Not a valid mobile number (e.g. a landline).
      return new ApiError('bad-phone', "That number can't receive text messages. Use a mobile number.", 400, detail);
    case 21608: // Trial account: unverified recipient.
    case 21610: // Recipient replied STOP.
    case 21612: // Not reachable from this sender.
      return new ApiError('undeliverable', "We can't text that number. Try a different one.", 400, detail);
    case 20429:
      return new ApiError('rate-limited', 'Too many attempts. Wait about a minute, then try again.', 429, detail);
    case 20404: // In practice a wrong Messaging Service SID.
    case 20003: // Bad API key/secret, or the key lacks permission.
    case 20005: // Account not active.
      return new ApiError('setup', 'Text messaging is not finished being set up on the server.', 503, detail);
  }

  if (status === 429) return new ApiError('rate-limited', 'Too many attempts. Wait about a minute, then try again.', 429, detail);
  if (status === 401 || status === 403) return new ApiError('setup', 'Text messaging is not finished being set up on the server.', 503, detail);
  if (status >= 400 && status < 500) {
    return new ApiError('bad-request', "We couldn't send that message. Check the number and try again.", 400, detail);
  }
  return new ApiError('unavailable', "The text couldn't be sent right now. Please try again in a moment.", 502, detail);
}

/**
 * Put one text on the wire. The lowest level: no throttling, no de-duplication,
 * and the body is taken as given — every caller must have composed it from a
 * template in templates.ts first, because this is what a caller would have to
 * reach to send arbitrary text.
 *
 * @param to must already be E.164.
 */
export async function sendSmsBody({ to, body }: { to: string; body: string }): Promise<{ sid: string | null; status: string }> {
  if (!twilioConfig.configured) {
    throw new ApiError('sms_not_configured', 'SMS is not configured on this server.', 503);
  }

  const form = new URLSearchParams({
    To: to,
    MessagingServiceSid: twilioConfig.messagingServiceSid!,
    Body: body,
  });
  // Delivery reports come back to our webhook only when a URL is configured.
  if (twilioConfig.statusCallbackUrl) form.set('StatusCallback', twilioConfig.statusCallbackUrl);

  // API Key SID + Secret is Twilio's recommended server credential; the Account
  // SID only says which account the key acts on.
  const auth = btoa(`${twilioConfig.apiKeySid}:${twilioConfig.apiKeySecret}`);

  let res: Response;
  try {
    res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${twilioConfig.accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
      },
    );
  } catch (err) {
    throw new ApiError(
      'unavailable',
      "The text couldn't be sent right now. Please try again in a moment.",
      502,
      `twilio fetch failed: ${(err as Error).message}`,
    );
  }

  const raw = await res.text();
  let parsed: { sid?: string; status?: string; code?: number; message?: string } = {};
  try {
    parsed = JSON.parse(raw);
  } catch { /* a non-JSON body is itself the detail */ }

  if (!res.ok) throw mapTwilioError(Number(parsed.code), res.status, parsed.message ?? raw.slice(0, 200));

  return { sid: parsed.sid ?? null, status: parsed.status ?? 'queued' };
}

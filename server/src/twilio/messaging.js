import { getTwilioClient, mapTwilioError, SmsError } from './client.js';
import { twilioConfig } from './config.js';
import { maskPhone, normalizeE164 } from './phone.js';
import { claimSend, LIMITS, previousSend, releaseSend, rememberSend, takeSlot } from './throttle.js';
import { renderTemplate } from './templates.js';

/**
 * Ordinary transactional texts (judge asked to decide, goal not completed,
 * invite links) through a Twilio Messaging Service.
 *
 * A Messaging Service — rather than a bare `from` number — is what gives the
 * account its sender pool, per-country sender selection, opt-out handling and
 * the shared delivery-status callback. The sender is therefore configured in
 * the Twilio Console, and no phone number is hardcoded anywhere in this repo.
 */

/**
 * Send one templated SMS.
 *
 * @param {object} input
 * @param {string} input.to             Destination, any format; normalised to E.164.
 * @param {string} input.template       A key of TEMPLATES; the body is built server-side.
 * @param {object} [input.params]       Template parameters (names, goal number, link).
 * @param {string} input.idempotencyKey Stable id for this logical message. Sending
 *   twice with the same key never puts a second text on the phone.
 * @returns {Promise<{sid: string, status: string, duplicate: boolean, to: string}>}
 */
export async function sendTemplatedSms({ to, template, params, idempotencyKey }) {
  const phone = normalizeE164(to);
  if (!phone) {
    throw new SmsError('bad-phone', "That phone number doesn't look right.", 400, 'recipient failed E.164 validation');
  }
  if (typeof idempotencyKey !== 'string' || idempotencyKey.trim().length < 8 || idempotencyKey.length > 128) {
    throw new SmsError('bad-request', 'Missing message id.', 400, 'idempotencyKey missing or wrong length');
  }
  const key = idempotencyKey.trim();

  const body = renderTemplate(template, params);
  if (!body) {
    throw new SmsError('bad-request', "We couldn't build that message.", 400, `unknown or unrenderable template "${template}"`);
  }

  // Already sent (or in flight) under this key: report the earlier outcome
  // rather than texting the person a second time.
  const earlier = previousSend(key);
  if (earlier) {
    return { ...earlier, duplicate: true, to: phone };
  }

  const slot = takeSlot('sms-send', phone, { max: LIMITS.smsPerHourPerNumber, windowMs: 3600_000 });
  if (!slot.allowed) {
    throw new SmsError('rate-limited', 'Too many messages to that number. Try again later.', 429, `local sms-send ${slot.reason}`);
  }

  // Claim before the network call so two simultaneous requests cannot both send.
  if (!claimSend(key)) {
    return { sid: null, status: 'duplicate', duplicate: true, to: phone };
  }

  try {
    const message = await getTwilioClient().messages.create({
      to: phone,
      messagingServiceSid: twilioConfig.messagingServiceSid,
      body,
      // Delivery reports come back to our signed webhook when a URL is set.
      ...(twilioConfig.statusCallbackUrl ? { statusCallback: twilioConfig.statusCallbackUrl } : {}),
    });
    const result = { sid: message.sid, status: message.status };
    rememberSend(key, result);
    return { ...result, duplicate: false, to: phone };
  } catch (err) {
    // A failed attempt must not burn the key — the caller is allowed to retry.
    releaseSend(key);
    throw mapTwilioError(err, 'message-send');
  }
}

/** Log line for a send, with the number masked. Never includes the body. */
export function describeSend({ to, template, sid, status, duplicate }) {
  return {
    to: maskPhone(to),
    template,
    sid: sid ?? null,
    status,
    duplicate: !!duplicate,
  };
}

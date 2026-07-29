import express from 'express';

import { maskPhone } from '../twilio/phone.js';
import { requireTwilioSignature } from '../twilio/webhook.js';

/**
 * Twilio's delivery-status callback.
 *
 * Server-to-server, so it sits outside the CSRF and session layers — trust is
 * established cryptographically instead, by `requireTwilioSignature`. Twilio
 * posts `application/x-www-form-urlencoded`, and the body must be parsed before
 * the signature can be checked (the parameters are part of what was signed).
 */

/** Statuses worth a warning: the person did not get the text. */
const FAILED = new Set(['failed', 'undelivered']);

export function createTwilioWebhookRouter() {
  const router = express.Router();

  router.post(
    '/status-callback',
    express.urlencoded({ extended: false, limit: '16kb' }),
    requireTwilioSignature,
    (req, res) => {
      const { MessageSid, MessageStatus, To, ErrorCode } = req.body ?? {};

      // Masked destination, no body, no code — this line ends up in a log file.
      const entry = {
        sid: MessageSid,
        status: MessageStatus,
        to: To ? maskPhone(To) : undefined,
        ...(ErrorCode ? { errorCode: ErrorCode } : {}),
      };
      if (FAILED.has(MessageStatus)) {
        console.warn('[twilio:status]', entry);
      } else {
        console.info('[twilio:status]', entry);
      }

      // 204 with no TwiML: Twilio needs an ack, not a reply message.
      res.status(204).end();
    },
  );

  return router;
}

import express from 'express';
import rateLimit from 'express-rate-limit';
import { body, validationResult } from 'express-validator';

import { isConfigured, SmsError, SmsNotConfiguredError } from '../twilio/client.js';
import { describeSend, sendTemplatedSms } from '../twilio/messaging.js';
import { maskPhone } from '../twilio/phone.js';
import { TEMPLATE_IDS } from '../twilio/templates.js';
import { checkVerification, startVerification } from '../twilio/verify.js';

/**
 * The SMS API. Everything Twilio lives behind these routes: no key, service SID
 * or template ever reaches the browser or the Android bundle.
 *
 * These endpoints are deliberately cookie-less and unauthenticated — the person
 * confirming a phone number while signing up, or while accepting a judge
 * invite, has no account yet, so there is no session to require. What protects
 * them instead:
 *   • CORS, so only the app's own origin may call them from a browser;
 *   • a tight per-IP rate limit on each route (below);
 *   • a per-NUMBER cooldown and quota in twilio/throttle.js, which is what
 *     actually stops one number being used to text-bomb someone;
 *   • server-owned message bodies — a caller picks a template id, never text.
 * CSRF protection is not applicable: no cookie is read, so a forged
 * cross-site request gains an attacker nothing they could not do with curl.
 */

/**
 * Codes: strict, because each one can put a text on someone's phone. Kept a
 * little loose all the same — mobile carriers put many real users behind one
 * NAT address, so the per-NUMBER cooldown in twilio/throttle.js is the limit
 * that matters, and this one only blunts a flood from a single source.
 */
const verifyLimiter = rateLimit({
  windowMs: 10 * 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a few minutes and try again.', code: 'rate-limited' },
});

const sendLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many messages. Please slow down.', code: 'rate-limited' },
});

function handleValidation(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    // Only field names are echoed — `details` would contain the phone number.
    return res.status(400).json({
      error: 'Invalid input.',
      code: 'bad-request',
      fields: [...new Set(errors.array().map((e) => e.path))],
    });
  }
  next();
}

/** Refuse early, and in a way the frontend can distinguish from a failure. */
function requireSmsConfigured(_req, res, next) {
  if (!isConfigured()) {
    return res.status(503).json({
      error: 'Text messaging is not set up on this server yet.',
      code: 'sms_not_configured',
    });
  }
  next();
}

/**
 * Turn a thrown error into a response. `SmsError.message` is already written
 * for a person; `detail` is server-side only and is logged, never sent.
 */
function fail(res, err, route) {
  if (err instanceof SmsNotConfiguredError) {
    return res.status(503).json({ error: err.message, code: err.code });
  }
  if (err instanceof SmsError) {
    if (err.detail) console.warn(`[sms:${route}]`, err.code, '-', err.detail);
    return res.status(err.httpStatus).json({ error: err.message, code: err.code });
  }
  // Unexpected: log the message only (a Twilio exception can carry the number).
  console.error(`[sms:${route}] unexpected error:`, err?.message ?? err);
  return res.status(500).json({ error: 'Something went wrong. Please try again.', code: 'unknown' });
}

export function createSmsRouter() {
  const router = express.Router();
  router.use(express.json({ limit: '8kb' }));

  /**
   * Is SMS live on this deployment? Public, and free of anything sensitive: one
   * boolean, no SIDs. The app uses it to decide whether to show the
   * phone-verification step at all.
   */
  router.get('/status', (_req, res) => {
    res.json({ configured: isConfigured() });
  });

  /** Text a one-time code to a phone number. */
  router.post(
    '/verify/start',
    verifyLimiter,
    requireSmsConfigured,
    body('phone').isString().trim().isLength({ min: 6, max: 20 }),
    handleValidation,
    async (req, res) => {
      try {
        const { masked } = await startVerification({ phone: req.body.phone });
        console.info('[sms:verify-start] code requested for', masked);
        // The code is not in this response, and never leaves the text message.
        return res.json({ status: 'pending', to: masked });
      } catch (err) {
        return fail(res, err, 'verify-start');
      }
    },
  );

  /** Check a code the person typed. */
  router.post(
    '/verify/check',
    verifyLimiter,
    requireSmsConfigured,
    body('phone').isString().trim().isLength({ min: 6, max: 20 }),
    body('code').isString().trim().isLength({ min: 4, max: 10 }),
    handleValidation,
    async (req, res) => {
      try {
        await checkVerification({ phone: req.body.phone, code: req.body.code });
        console.info('[sms:verify-check] approved for', maskPhone(req.body.phone));
        return res.json({ approved: true });
      } catch (err) {
        return fail(res, err, 'verify-check');
      }
    },
  );

  /**
   * Send a transactional text.
   *
   * The caller chooses a TEMPLATE and supplies parameters; the body is composed
   * on this server. `idempotencyKey` must be stable for one logical message
   * (the outbox entry id), which is what makes a retry safe.
   */
  router.post(
    '/send',
    sendLimiter,
    requireSmsConfigured,
    body('to').isString().trim().isLength({ min: 6, max: 20 }),
    body('template').isString().trim().isIn(TEMPLATE_IDS),
    body('idempotencyKey').isString().trim().isLength({ min: 8, max: 128 }),
    body('params').optional().isObject(),
    handleValidation,
    async (req, res) => {
      try {
        const result = await sendTemplatedSms({
          to: req.body.to,
          template: req.body.template,
          params: req.body.params ?? {},
          idempotencyKey: req.body.idempotencyKey,
        });
        console.info('[sms:send]', describeSend({ ...result, template: req.body.template }));
        return res.json({ status: result.status, duplicate: result.duplicate });
      } catch (err) {
        return fail(res, err, 'send');
      }
    },
  );

  return router;
}

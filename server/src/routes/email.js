import express from 'express';
import rateLimit from 'express-rate-limit';
import { body, validationResult } from 'express-validator';

import { isEmailConfigured, EmailError, EmailNotConfiguredError } from '../email/client.js';
import { maskEmail } from '../email/address.js';
import { checkEmailVerification, startEmailVerification } from '../email/verify.js';

/**
 * The email API: the sign-up verification code, and nothing else.
 *
 * Deliberately cookie-less and unauthenticated — someone creating an account
 * has no session yet, so there is nothing to require. What protects the routes
 * instead:
 *   • CORS, so only the app's own origin may call them from a browser;
 *   • a tight per-IP rate limit on each route (below);
 *   • a per-ADDRESS cooldown and hourly quota in email/verify.js, which is what
 *     actually stops one address being mail-bombed from many IPs;
 *   • server-owned content — there is no way to pass a subject or a body, so
 *     this can never become an open relay sending from a verified domain.
 * CSRF protection is not applicable: no cookie is read, so a forged cross-site
 * request gains an attacker nothing they could not do with curl.
 */

/**
 * Strict, because each request can put mail in someone's inbox. Kept a little
 * loose all the same — a university or an office puts many real users behind
 * one address — so the per-ADDRESS cooldown is the limit that matters and this
 * one only blunts a flood from a single source.
 */
const verifyLimiter = rateLimit({
  windowMs: 10 * 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a few minutes and try again.', code: 'rate-limited' },
});

function handleValidation(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    // Only field names are echoed — `details` would contain the address.
    return res.status(400).json({
      error: 'Invalid input.',
      code: 'bad-request',
      fields: [...new Set(errors.array().map((e) => e.path))],
    });
  }
  next();
}

/** Refuse early, and in a way the frontend can distinguish from a failure. */
function requireEmailConfigured(_req, res, next) {
  if (!isEmailConfigured()) {
    return res.status(503).json({
      error: 'Email verification is not set up on this server yet.',
      code: 'email_not_configured',
    });
  }
  next();
}

/**
 * Turn a thrown error into a response. `EmailError.message` is already written
 * for a person; `detail` is server-side only and is logged, never sent.
 */
function fail(res, err, route) {
  if (err instanceof EmailNotConfiguredError) {
    return res.status(503).json({ error: err.message, code: err.code });
  }
  if (err instanceof EmailError) {
    if (err.detail) console.warn(`[email:${route}]`, err.code, '-', err.detail);
    return res.status(err.httpStatus).json({ error: err.message, code: err.code });
  }
  // Unexpected: log the message only (an AWS exception can carry the address).
  console.error(`[email:${route}] unexpected error:`, err?.message ?? err);
  return res.status(500).json({ error: 'Something went wrong. Please try again.', code: 'unknown' });
}

export function createEmailRouter() {
  const router = express.Router();
  router.use(express.json({ limit: '8kb' }));

  /**
   * Is email verification live on this deployment? Public, and free of anything
   * sensitive: one boolean, no region, no identity. The app uses it to decide
   * whether sign-up shows the code step at all.
   */
  router.get('/status', (_req, res) => {
    res.json({ configured: isEmailConfigured() });
  });

  /** Email a one-time code to an address. */
  router.post(
    '/verify/start',
    verifyLimiter,
    requireEmailConfigured,
    body('email').isString().trim().isLength({ min: 5, max: 254 }),
    handleValidation,
    async (req, res) => {
      try {
        const { masked } = await startEmailVerification({ email: req.body.email });
        console.info('[email:verify-start] code requested for', masked);
        // The code is not in this response, and never leaves the email.
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
    requireEmailConfigured,
    body('email').isString().trim().isLength({ min: 5, max: 254 }),
    body('code').isString().trim().isLength({ min: 4, max: 10 }),
    handleValidation,
    async (req, res) => {
      try {
        await checkEmailVerification({ email: req.body.email, code: req.body.code });
        console.info('[email:verify-check] approved for', maskEmail(req.body.email));
        return res.json({ approved: true });
      } catch (err) {
        return fail(res, err, 'verify-check');
      }
    },
  );

  return router;
}

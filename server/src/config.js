import './env.js';
import { twilioConfig } from './twilio/config.js';

/**
 * Centralized, validated configuration.
 * Credentials are read ONLY from environment variables (never hardcoded).
 * The process refuses to boot if a required secret is missing, so we never
 * accidentally run with placeholder keys.
 */
function required(name) {
  const value = process.env[name];
  if (!value || value.startsWith('PASTE_') || value.startsWith('replace_with')) {
    throw new Error(
      `Missing/placeholder env var "${name}". Set it in server/.env (see .env.example).`,
    );
  }
  return value;
}

const PAYPAL_ENV = process.env.PAYPAL_ENV === 'live' ? 'live' : 'sandbox';

/** True when a value is absent or still one of the .env.example placeholders. */
function isBlank(name) {
  const value = process.env[name];
  return !value || value.startsWith('PASTE_') || value.startsWith('replace_with');
}

/**
 * PayPal, on the same all-or-nothing terms as Twilio and Amazon SES:
 *
 *   • all three set   → payments are live;
 *   • none set        → payments are OFF. `/api/paypal/*` answers 503 and the
 *     server boots. This is what lets a deployment run sign-up emails or SMS
 *     without having a PayPal app at all — they are unrelated features, and
 *     requiring a payment credential to send a verification email would be an
 *     absurd coupling;
 *   • partially set   → refuse to boot, naming what is missing. A half-wired
 *     payment integration must fail loudly, not at someone's checkout.
 */
const PAYPAL_KEYS = ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_WEBHOOK_ID'];
const paypalPresent = PAYPAL_KEYS.filter((name) => !isBlank(name));

if (paypalPresent.length > 0 && paypalPresent.length < PAYPAL_KEYS.length) {
  const missing = PAYPAL_KEYS.filter((name) => isBlank(name));
  throw new Error(
    `PayPal is half-configured, so checkout would fail at run time. Set these in server/.env: ${missing.join(', ')}. ` +
      'Or clear every PAYPAL_* value to run with payments switched off.',
  );
}

const paypalConfigured = paypalPresent.length === PAYPAL_KEYS.length;

export const config = {
  port: Number(process.env.PORT) || 4000,
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
  secureCookies: process.env.SECURE_COOKIES === 'true',

  csrfSecret: required('CSRF_SECRET'),
  cookieSecret: required('COOKIE_SECRET'),

  paypal: {
    configured: paypalConfigured,
    env: PAYPAL_ENV,
    clientId: paypalConfigured ? process.env.PAYPAL_CLIENT_ID : null,
    clientSecret: paypalConfigured ? process.env.PAYPAL_CLIENT_SECRET : null,
    webhookId: paypalConfigured ? process.env.PAYPAL_WEBHOOK_ID : null,
    apiBase:
      PAYPAL_ENV === 'live'
        ? 'https://api-m.paypal.com'
        : 'https://api-m.sandbox.paypal.com',
  },

  /**
   * Twilio (SMS codes + transactional texts). Validated in ./twilio/config.js:
   * all values or none — a half-filled Twilio block refuses to boot, an empty
   * one simply leaves SMS switched off.
   */
  twilio: twilioConfig,
};

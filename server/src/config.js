import 'dotenv/config';

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

export const config = {
  port: Number(process.env.PORT) || 4000,
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
  secureCookies: process.env.SECURE_COOKIES === 'true',

  csrfSecret: required('CSRF_SECRET'),
  cookieSecret: required('COOKIE_SECRET'),

  paypal: {
    env: PAYPAL_ENV,
    clientId: required('PAYPAL_CLIENT_ID'),
    clientSecret: required('PAYPAL_CLIENT_SECRET'),
    webhookId: required('PAYPAL_WEBHOOK_ID'),
    apiBase:
      PAYPAL_ENV === 'live'
        ? 'https://api-m.paypal.com'
        : 'https://api-m.sandbox.paypal.com',
  },
};

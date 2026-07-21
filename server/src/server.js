import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { doubleCsrf } from 'csrf-csrf';
import { body, param, validationResult } from 'express-validator';

import { config } from './config.js';
import { ordersRepo } from './db.js';
import { requireAuth, devLogin } from './middleware/auth.js';
import {
  createPaypalOrder,
  capturePaypalOrder,
  verifyWebhookSignature,
  extractCapture,
} from './paypal.js';

const app = express();
app.set('trust proxy', 1);

/* ---------------------------------------------------------- Core hardening */
// Helmet sets secure HTTP headers (XSS protection, no-sniff, frameguard, HSTS…).
app.use(helmet());
// Strict CORS allowlist — only our own frontend may call the API, with cookies.
app.use(
  cors({
    origin: config.clientOrigin,
    credentials: true,
    methods: ['GET', 'POST'],
  }),
);
app.use(cookieParser(config.cookieSecret));

// Global rate limit blunts brute-force / abuse on every endpoint.
app.use(
  rateLimit({
    windowMs: 60_000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

/* -------------------------------------------------------------- Webhook ---
 * Registered BEFORE express.json so we keep the exact raw bytes PayPal signed.
 * Webhooks are server-to-server, so they are CSRF-exempt and auth-exempt;
 * trust is established cryptographically via signature verification instead.
 */
app.post('/api/paypal/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const ok = await verifyWebhookSignature({ headers: req.headers, rawBody: req.body });
    if (!ok) {
      // Reject spoofed / replayed notifications.
      return res.status(400).json({ error: 'Invalid webhook signature.' });
    }

    const event = JSON.parse(req.body.toString('utf8'));
    if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
      const cap = event.resource;
      const internalOrderId = cap?.custom_id; // we set this to orders.id on create
      const captureId = cap?.id;
      const value = cap?.amount?.value;
      const currency = cap?.amount?.currency_code;

      const order = internalOrderId ? ordersRepo.getById(internalOrderId) : null;
      if (order && captureId) {
        const expected = (order.amount_cents / 100).toFixed(2);
        // Only fulfil if the captured amount/currency matches OUR stored price.
        if (order.currency === currency && expected === value) {
          ordersRepo.markPaidOnce(order.id, captureId); // idempotent: fulfils once
        }
      }
    }
    // Always 200 quickly so PayPal doesn't keep retrying a handled event.
    res.json({ received: true });
  } catch {
    // Never leak internals; PayPal will retry on 5xx.
    res.status(500).json({ error: 'Webhook processing error.' });
  }
});

/* ------------------------------------------------------ JSON + CSRF layer */
// Body size cap mitigates large-payload DoS.
app.use(express.json({ limit: '16kb' }));

const { generateToken, doubleCsrfProtection } = doubleCsrf({
  getSecret: () => config.csrfSecret,
  cookieName: config.secureCookies ? '__Host-fl.x-csrf' : 'fl.x-csrf',
  cookieOptions: {
    sameSite: 'strict',
    secure: config.secureCookies,
    httpOnly: true,
  },
  size: 64,
  getTokenFromRequest: (req) => req.headers['x-csrf-token'],
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Frontend fetches this first; returns a CSRF token tied to a signed cookie.
app.get('/api/csrf-token', (req, res) => {
  res.json({ csrfToken: generateToken(req, res) });
});

// DEV ONLY: get a session cookie in sandbox so you can test end-to-end.
app.post('/api/dev-login', express.json(), devLogin);

/* ------------------------------------------------------------ Validation */
function handleValidation(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Invalid input.', details: errors.array() });
  }
  next();
}

/* ============================================================ CREATE ORDER
 * Trust boundary: the client sends ONLY a productId. Price + currency come from
 * the database. CSRF + auth required.
 */
app.post(
  '/api/orders',
  doubleCsrfProtection,
  requireAuth,
  body('productId').isString().trim().isLength({ min: 1, max: 64 }),
  handleValidation,
  async (req, res) => {
    try {
      const product = ordersRepo.getProduct(req.body.productId);
      if (!product) {
        return res.status(404).json({ error: 'Product not found.' });
      }

      // 1) Persist a pending order with the SERVER price (never the client's).
      const order = ordersRepo.createPendingOrder({ userId: req.userId, product });

      // 2) Create the matching PayPal order using that trusted amount.
      const ppOrder = await createPaypalOrder({
        amountCents: order.amount_cents,
        currency: order.currency,
        internalOrderId: order.id,
      });

      ordersRepo.attachPaypalOrderId(order.id, ppOrder.id);

      // Return our internal id + the PayPal order id the SDK needs. No prices echoed back.
      return res.status(201).json({ orderId: order.id, paypalOrderId: ppOrder.id });
    } catch (err) {
      console.error('[create-order]', err.message);
      // If anything failed after creating the row, it simply stays "pending" and is
      // never fulfilled — the customer is not charged and loses nothing.
      return res.status(502).json({ error: 'Could not start payment. Please try again.' });
    }
  },
);

/* =========================================================== CAPTURE ORDER
 * Defends against: tampering (re-checks amount), replay/double-spend (idempotent
 * pending->paid transition), spoofed success (re-fetches real status from PayPal).
 */
app.post(
  '/api/orders/:orderId/capture',
  doubleCsrfProtection,
  requireAuth,
  param('orderId').isUUID(),
  handleValidation,
  async (req, res) => {
    const order = ordersRepo.getForUser(req.params.orderId, req.userId);
    if (!order) {
      return res.status(404).json({ error: 'Order not found.' });
    }

    // Idempotency short-circuit: already fulfilled -> succeed without re-capturing.
    if (order.status === 'paid') {
      return res.json({ status: 'paid', orderId: order.id });
    }
    if (order.status !== 'pending' || !order.paypal_order_id) {
      return res.status(409).json({ error: 'Order is not capturable.' });
    }

    try {
      const result = await capturePaypalOrder(order.paypal_order_id);
      const capture = extractCapture(result);

      // Verify the payment is real, completed, and matches OUR price exactly.
      const expectedValue = (order.amount_cents / 100).toFixed(2);
      const valid =
        capture &&
        capture.status === 'COMPLETED' &&
        capture.currency === order.currency &&
        capture.value === expectedValue &&
        capture.customId === order.id;

      if (!valid) {
        ordersRepo.markFailed(order.id);
        return res.status(400).json({ error: 'Payment verification failed.' });
      }

      // Flip pending -> paid EXACTLY ONCE. If a webhook/another request already did
      // it, markPaidOnce returns false and we still respond success (idempotent).
      const firstTime = ordersRepo.markPaidOnce(order.id, capture.captureId);
      if (firstTime) {
        // fulfilOrder(order)  // <- grant Premium / credit deposit here, runs once.
      }

      return res.json({ status: 'paid', orderId: order.id });
    } catch (err) {
      console.error('[capture-order]', err.message);
      // Transaction interrupted: order stays "pending". The webhook (or a retry of
      // this endpoint) will reconcile it later — money and session are preserved.
      return res.status(502).json({ error: 'Payment is being verified. Please retry shortly.' });
    }
  },
);

/* --------------------------------------------------------- Error handler */
// Catch-all so stack traces are never leaked to clients (CSRF errors, etc.).
app.use((err, _req, res, _next) => {
  if (err?.code === 'EBADCSRFTOKEN' || err?.message?.includes('csrf')) {
    return res.status(403).json({ error: 'Invalid CSRF token.' });
  }
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'Internal server error.' });
});

app.listen(config.port, () => {
  console.log(`FineLine payments API on http://localhost:${config.port} [${config.paypal.env}]`);
});

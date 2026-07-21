import { config } from './config.js';

/**
 * Thin, dependency-free PayPal REST client (Orders v2 + Webhook verification).
 * Uses the server-side Client Credentials grant — the secret never leaves here.
 */

const { apiBase, clientId, clientSecret, webhookId } = config.paypal;

// Simple in-memory access-token cache to avoid re-authenticating on every call.
let tokenCache = { value: null, expiresAt: 0 };

async function getAccessToken() {
  if (tokenCache.value && Date.now() < tokenCache.expiresAt) {
    return tokenCache.value;
  }
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await fetch(`${apiBase}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) {
    throw new Error(`PayPal auth failed (${res.status})`);
  }
  const data = await res.json();
  // Refresh 60s before real expiry for safety.
  tokenCache = {
    value: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };
  return tokenCache.value;
}

/**
 * Create a PayPal order. The amount is the SERVER-TRUSTED value derived from the
 * database (cents) — the caller must never pass a client-supplied price.
 */
export async function createPaypalOrder({ amountCents, currency, internalOrderId }) {
  const token = await getAccessToken();
  const value = (amountCents / 100).toFixed(2);

  const res = await fetch(`${apiBase}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      // Idempotency at the PayPal layer: retrying with the same key won't double-create.
      'PayPal-Request-Id': internalOrderId,
    },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [
        {
          // Our own id, echoed back on capture/webhook so we can reconcile.
          custom_id: internalOrderId,
          amount: { currency_code: currency, value },
        },
      ],
      application_context: {
        shipping_preference: 'NO_SHIPPING',
        user_action: 'PAY_NOW',
      },
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`PayPal create-order failed: ${data?.message || res.status}`);
  }
  return data; // contains { id, status: 'CREATED', ... }
}

/**
 * Capture an approved order. Returns the parsed PayPal response so the backend
 * can re-verify status + amount before trusting it.
 */
export async function capturePaypalOrder(paypalOrderId) {
  const token = await getAccessToken();
  const res = await fetch(`${apiBase}/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': `capture-${paypalOrderId}`,
    },
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`PayPal capture failed: ${data?.message || res.status}`);
  }
  return data;
}

/**
 * Verify a webhook actually came from PayPal (defends against spoofed/replayed
 * status notifications). PayPal recomputes the signature on their side.
 */
export async function verifyWebhookSignature({ headers, rawBody }) {
  const token = await getAccessToken();
  const res = await fetch(`${apiBase}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      auth_algo: headers['paypal-auth-algo'],
      cert_url: headers['paypal-cert-url'],
      transmission_id: headers['paypal-transmission-id'],
      transmission_sig: headers['paypal-transmission-sig'],
      transmission_time: headers['paypal-transmission-time'],
      webhook_id: webhookId,
      // webhook_event must be the exact bytes PayPal sent.
      webhook_event: JSON.parse(rawBody.toString('utf8')),
    }),
  });
  if (!res.ok) return false;
  const data = await res.json();
  return data.verification_status === 'SUCCESS';
}

/** Pull the completed capture out of a capture/webhook payload. */
export function extractCapture(orderData) {
  const pu = orderData?.purchase_units?.[0];
  const cap = pu?.payments?.captures?.[0];
  if (!cap) return null;
  return {
    captureId: cap.id,
    status: cap.status, // expect 'COMPLETED'
    currency: cap.amount?.currency_code,
    value: cap.amount?.value, // string like "79.99"
    customId: cap.custom_id || pu?.custom_id,
  };
}

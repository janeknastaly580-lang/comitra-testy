# FineLine — Secure PayPal Integration (Node.js + React)

A production-grade PayPal integration using the **PayPal Orders v2 REST API** on the
backend and the **PayPal JavaScript SDK** (`@paypal/react-paypal-js`) on the frontend.

---

## 1. Architecture

```
┌──────────────────────────┐         ┌──────────────────────────────┐         ┌─────────────┐
│  React frontend          │         │  Node.js / Express backend   │         │   PayPal    │
│  PayPalCheckout.tsx       │        │  server/                     │         │   REST API  │
│                          │         │                              │         │             │
│  sends ONLY productId ───┼────────▶│ 1. GET  /api/csrf-token      │         │             │
│  + CSRF token + cookie    │        │ 2. POST /api/orders          │         │             │
│                          │         │    • price from DB (cents)   │────────▶│ Create Order│
│                          │         │    • create pending row      │◀────────│  (id)       │
│  PayPalButtons.createOrder◀────────┼─ returns paypalOrderId       │         │             │
│  (buyer approves in popup)│        │                              │         │             │
│  onApprove ──────────────┼────────▶│ 3. POST /api/orders/:id/     │────────▶│Capture Order│
│                          │         │      capture                 │◀────────│ (COMPLETED) │
│                          │         │    • verify status+amount    │         │             │
│  "Payment complete ✓" ◀──┼─────────┤    • pending→paid ONCE       │         │             │
└──────────────────────────┘         │                              │         │             │
                                     │ 4. POST /api/paypal/webhook  │◀────────│  Webhook    │
                                     │    • verify signature        │         │  (async)    │
                                     │    • reconcile pending→paid   │        │             │
                                     └──────────────────────────────┘         └─────────────┘
```

**Why two confirmation paths (capture + webhook)?** The synchronous *Capture Order*
gives the buyer instant feedback. The *Webhook* is the safety net: if the browser
closes after the money moves but before our capture response lands, PayPal still
notifies the server and the order is reconciled. Both paths flip the order to `paid`
**idempotently**, so fulfilment happens exactly once.

### Files

| File | Responsibility |
| --- | --- |
| `server/src/config.js` | Loads & validates env (refuses to boot on placeholder keys) |
| `server/src/db.js` | SQLite schema + parameterized queries (prices, orders, idempotency) |
| `server/src/paypal.js` | OAuth token, Create/Capture order, webhook signature verify |
| `server/src/middleware/auth.js` | Auth gate (pluggable stub → your real session/JWT) |
| `server/src/server.js` | Express app: security middleware + the 3 endpoints + webhook |
| `src/components/PayPalCheckout.tsx` | React button talking only to our backend |
| `server/.env.example` | Where the PayPal **Client ID + Secret** go (point 7) |
| `.env.example` (root) | Frontend public Client ID only |

---

## 2. Security — how each threat is neutralized

| Threat | Mitigation (where) |
| --- | --- |
| **Client-side amount tampering** | Frontend sends only `productId`. Price + currency are read from the DB (`ordersRepo.getProduct`) and used to build the PayPal order. On capture, the returned amount is re-compared to the DB value (`expectedValue === capture.value`). A tampered amount is rejected. |
| **Replay / spoofed status** | Webhooks are verified with PayPal's `verify-webhook-signature` API (`paypal.js`). Capture status is fetched server-side from PayPal (`capturePaypalOrder`), never trusted from the client. Unsigned/forged notifications return 400. |
| **Double-spend / no state validation** | `orders.status` transitions `pending → paid` via `markPaidOnce`, a single SQL `UPDATE … WHERE status='pending'` that reports `changes`. The second attempt (retry, webhook race) returns `false` → fulfilment runs once. `paypal_capture_id` has a `UNIQUE` constraint as a second guard. |
| **Hardcoded credentials** | All secrets come from `process.env` via `dotenv`. `config.js` throws if a key is missing or still a placeholder. `.env` is git-ignored. The frontend only ever sees the **public** Client ID. |
| **SQL Injection** | Every query is a `better-sqlite3` **prepared statement with bound parameters** — no string concatenation of user input. |
| **XSS** | API is JSON-only; `helmet` sets `X-Content-Type-Options`, CSP-friendly headers. React escapes all rendered values by default. No `dangerouslySetInnerHTML`. |
| **CSRF** | `csrf-csrf` double-submit cookie. State-changing routes (`/api/orders`, `/capture`) require a matching `x-csrf-token` header + signed cookie. Webhook is intentionally CSRF-exempt (server-to-server, secured by signature instead). |
| **Abuse / brute force** | `express-rate-limit` (60 req/min/IP) + strict CORS allowlist (`CLIENT_ORIGIN` only) + 16 KB JSON body cap. |
| **Interrupted transaction** | Everything is wrapped in `try/catch`. If create fails, the row stays `pending` and the buyer is never charged. If capture is interrupted, the order stays `pending` and the **webhook reconciles it later** — no lost money, no lost session. Errors return generic messages (no stack-trace leakage). |

---

## 3. Payment flow (step by step)

1. **`GET /api/csrf-token`** — frontend fetches a CSRF token (sets a signed cookie).
2. **`POST /api/orders { productId }`** — backend looks up the price in the DB,
   inserts a `pending` order, calls PayPal *Create Order* with the trusted amount,
   stores `paypal_order_id`, returns `{ orderId, paypalOrderId }`.
3. Buyer approves in the PayPal popup (handled by the SDK).
4. **`POST /api/orders/:orderId/capture`** — backend calls PayPal *Capture Order*,
   verifies `status === 'COMPLETED'` and that amount/currency/`custom_id` match the DB,
   then flips `pending → paid` exactly once and fulfils (grant Premium / credit deposit).
5. **`POST /api/paypal/webhook`** (async, from PayPal) — verifies the signature and
   reconciles the order in case step 4 never completed client-side.

---

## 4. Running it locally

```bash
# ── Backend ──
cd server
cp .env.example .env          # then paste your keys (see point 7)
npm install
npm run dev                   # http://localhost:4000  [sandbox]

# ── Frontend ──
cd ..
cp .env.example .env          # paste the PUBLIC client id + VITE_API_BASE
npm install
npm run dev                   # http://localhost:5173
```

**Test end-to-end in sandbox:**

```bash
# Get a dev session cookie (sandbox only) and a CSRF token:
curl -c cookies.txt -X POST http://localhost:4000/api/dev-login \
  -H "Content-Type: application/json" -d '{"userId":"demo-user"}'
```

Then render `<PayPalCheckout productId="premium-yearly" />` somewhere in the app
(e.g. inside the Premium view) and pay with a PayPal **sandbox buyer** account from
your developer dashboard.

> Wire it into the app by importing it in `src/views/Premium.tsx`:
> ```tsx
> import PayPalCheckout from '../components/PayPalCheckout';
> // …inside the component, near the "Activate Premium" button:
> <PayPalCheckout productId="premium-yearly" onPaid={() => setPremium(true)} />
> ```

---

## 5. Webhook setup

1. Developer Dashboard → your App → **Webhooks** → *Add Webhook*.
2. URL: `https://YOUR_DOMAIN/api/paypal/webhook` (must be public HTTPS; use ngrok
   while developing: `ngrok http 4000`).
3. Subscribe to **`PAYMENT.CAPTURE.COMPLETED`** (add `PAYMENT.CAPTURE.DENIED` if you
   want to mark failures too).
4. Copy the generated **Webhook ID** into `PAYPAL_WEBHOOK_ID` in `server/.env`.

---

## 6. Production deployment checklist

- [ ] `PAYPAL_ENV=live` and paste the **Live** Client ID + Secret.
- [ ] Serve over **HTTPS**; set `SECURE_COOKIES=true` (enables `Secure` + `__Host-` cookies).
- [ ] Set `CLIENT_ORIGIN` to your real frontend domain (no trailing slash).
- [ ] Put the backend behind a reverse proxy (Nginx) and keep `app.set('trust proxy', 1)`.
- [ ] Replace the `requireAuth` stub in `middleware/auth.js` with your real auth.
- [ ] Replace SQLite with your production DB (Postgres/MySQL) — keep **parameterized
      queries** and the `UNIQUE(paypal_capture_id)` + `WHERE status='pending'` idempotency.
- [ ] Rotate `CSRF_SECRET` / `COOKIE_SECRET` to long random values; store them in your
      secret manager, never in git.
- [ ] Implement the `fulfilOrder()` hook (grant Premium / credit the deposit) inside the
      `if (firstTime)` block in `server.js`.

---

## 7. ⭐ Where to paste your PayPal API keys (do this!)

Put your credentials **only** in **`server/.env`** (copied from `server/.env.example`).
This file lives on the server, is git-ignored, and is **never** sent to the browser:

```ini
# server/.env
PAYPAL_ENV=sandbox
PAYPAL_CLIENT_ID=AY...your_client_id...
PAYPAL_CLIENT_SECRET=EJ...your_SECRET_key...      # ⚠️ backend ONLY — never in frontend
PAYPAL_WEBHOOK_ID=8SR...your_webhook_id...
```

The **public Client ID** (and nothing else) also goes in the **frontend `.env`**:

```ini
# .env  (project root, used by Vite)
VITE_PAYPAL_CLIENT_ID=AY...same_public_client_id...
VITE_API_BASE=http://localhost:4000
```

**Rules:**
- The **Secret Key** goes in `server/.env` and **nowhere else**. Never in any `VITE_*`
  variable, React file, or git commit — Vite inlines `VITE_*` vars into the public bundle.
- Get both keys from <https://developer.paypal.com/dashboard/applications> → your App →
  *API credentials* (Sandbox tab for testing, Live tab for production).
- If a secret ever lands in git history, **revoke and regenerate it** in the dashboard.
```

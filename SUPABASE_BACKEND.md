# The backend, as a Supabase Edge Function

Comitra's backend used to be an Express server in `server/`, which had to be
running somewhere for sign-up codes to work. It now runs as a single Edge
Function called **`api`**, on the free plan, always on.

`server/` is untouched and still works — set `VITE_API_BASE=http://localhost:4000`
to go back to it at any time.

---

## Why one function called `api`

Supabase routes `/functions/v1/<name>/…` and passes the whole path through, so a
function named `api` sees exactly the paths the Express server served:

| The app calls | Supabase URL | The function sees |
|---|---|---|
| `/api/email/verify/start` | `…/functions/v1/api/email/verify/start` | `/api/email/verify/start` |

That is why `src/lib/email.ts` needed no route changes. Only `VITE_API_BASE`
moved.

---

## The one thing that had to change: state

The Express backend kept pending codes and rate-limit buckets in `new Map()`,
with a pepper from `randomBytes(32)` at boot. That is correct for one process
and **wrong for Edge Functions**, which run as many short-lived isolates:

- a Map written by isolate A is invisible to isolate B, and
- each isolate would derive a *different* pepper, so a code issued by one could
  never be verified by another.

The failure mode is nasty — verification would work in testing and fail for a
random fraction of real users. So the state moved to Postgres:

| Table | Replaces |
|---|---|
| `comitra_otp` | the `pending` Map in `email/verify.js` |
| `comitra_rate` | the `buckets` Map in `email/throttle.js` |

All three have RLS on with **no policies and no grants**, so the anon key in the
browser cannot read a code hash even though it reaches the same database. Only
the function touches them, with the service-role key.

The security properties are unchanged: the plaintext code is never stored, only
an HMAC digest; rows are keyed by an HMAC of the address or number, so the
tables hold no addresses, no phone numbers and no IPs; codes are single-use with
a hard expiry and five attempts, all enforced inside one SQL transaction so
concurrent guesses cannot each get a fresh five.

---

## Secrets you must set

These cannot be set through the MCP connector — do it in the dashboard under
**Edge Functions → Secrets**, or with the CLI:

```bash
supabase secrets set --project-ref utoqyuysxkkekefshfvp COMITRA_OTP_PEPPER=<64 hex chars>
```

| Secret | Required | Value |
|---|---|---|
| `COMITRA_OTP_PEPPER` | **yes** | 64 random hex chars. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Changing it invalidates every code in flight — harmless, people just ask for a new one. |
| `SES_REGION` | for email | `eu-north-1` |
| `SES_FROM_EMAIL` | for email | `comitraapp@gmail.com` |
| `SES_FROM_NAME` | no | `Comitra` |
| `SES_TEMPLATE_NAME` | no | `comitra-verification-template` |
| `SES_TEMPLATE_VAR` | no | the `{{placeholder}}` in that template. Defaults to `code`. |
| `AWS_ACCESS_KEY_ID` | for email | your IAM key |
| `AWS_SECRET_ACCESS_KEY` | for email | your IAM secret |
| `CLIENT_ORIGIN` | recommended | Comma-separated allowed origins, e.g. `https://comitra.vercel.app,http://localhost:5173`. Unlike the Express version this accepts a list, so preview deployments are no longer blocked by CORS. |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically — do
not set them, the platform rejects secrets with a `SUPABASE_` prefix.

**No AWS credential belongs in a `VITE_` variable.** Vite inlines
those into the browser bundle and the Android APK.

---

## Auth

The function is deployed with `verify_jwt: true`, so every request needs the
project's publishable (anon) key. `src/lib/backend.ts` sends it automatically
from `VITE_SUPABASE_ANON_KEY`.

That key authorises nothing by itself — the tables are locked to it — it just
keeps unauthenticated scanners off the function. The real protections are the
per-IP rate limits, the per-destination cooldown and quota, and the fact that no
route accepts a subject or a message body.

---

## Verifying a deployment

```bash
curl -s -H "apikey: $ANON" -H "Authorization: Bearer $ANON" https://utoqyuysxkkekefshfvp.supabase.co/functions/v1/api/email/status
```

`{"configured":true}` means the SES secrets are in place. `false` means they are
missing or half-filled — the reason is in the function logs, never in the
response.

To test sending without emailing a real person, use AWS's mailbox simulator:
`success@simulator.amazonses.com`. It works inside the SES sandbox, needs no
verification, and is delivered to nobody.

---

## What did NOT move

`server/` still holds the PayPal integration (orders, capture, webhook) and its
SQLite database. It was not ported: payments are switched off, the app moved
away from a money model, and porting a disabled payment flow to a new runtime
would be speculative work. If payments come back, the orders table has to become
Postgres tables first — Edge Functions have no local disk.


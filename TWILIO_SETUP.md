# Twilio SMS setup

Everything in the app is written and tested. What is left is the part only you
can do, because it needs an account and a payment method: create the Twilio
resources and paste seven values into `.env`.

**No code changes are needed afterwards.** Until the values are filled in, the
app behaves exactly as it does today — judges register without a code step and
no text is ever attempted.

---

## What the app does with Twilio

| Feature | Twilio product | Where |
|---|---|---|
| 6-digit code when a judge accepts an invite | **Verify v2** | `server/src/twilio/verify.js` |
| "your judge needs to decide", "X did not complete their goal", invite links | **Programmable Messaging** via a **Messaging Service** | `server/src/twilio/messaging.js` |
| Delivery receipts | status callback webhook, signature-checked | `server/src/routes/twilioWebhook.js` |

Two things worth knowing:

- **The code never exists in this app.** Twilio Verify generates it, stores it
  hashed, expires it after 10 minutes and checks it. The server only ever sees
  `pending` or `approved`.
- **No Twilio credential reaches the browser or the APK.** The web app calls
  *our* backend (`VITE_API_BASE`), and the backend calls Twilio.

---

## Step 1 — Create the account

1. Sign up at <https://www.twilio.com/try-twilio> and verify your own phone.
2. You land on the **Console** at <https://console.twilio.com>.

> **Trial accounts** can only text numbers you have verified in Twilio, and add
> a trial prefix to every message. That is fine for testing. To text anyone,
> upgrade the account (add funds). Budget a few cents per SMS, plus a small
> per-verification fee for Verify.

---

## Step 2 — Account SID and Auth Token

**Console home → Account Info** (bottom of the dashboard page).

| Copy this | Into |
|---|---|
| **Account SID** (starts with `AC`) | `TWILIO_ACCOUNT_SID` |
| **Auth Token** (click *Show*) | `TWILIO_AUTH_TOKEN` |

The Auth Token is used for **one** thing here: recomputing the
`X-Twilio-Signature` on incoming webhooks. It never authenticates an outgoing
request — that is what the API key below is for.

---

## Step 3 — Create an API Key

**Console → Account (top-right menu) → API keys & tokens → Create API key.**

- Give it a name, e.g. `comitra-backend`.
- Region: leave the default (`us1`) unless you deliberately use another.
- Key type: **Standard**.
- Click **Create**.

| Copy this | Into |
|---|---|
| **SID** (starts with `SK`) | `TWILIO_API_KEY_SID` |
| **Secret** | `TWILIO_API_KEY_SECRET` |

> ⚠️ **The secret is shown once.** Copy it into `.env` before leaving the page.
> If you lose it, delete the key and create a new one — it cannot be re-read.

Why an API key rather than the Auth Token: a key can be revoked on its own
without rotating the account's master credential.

---

## Step 4 — Create a Verify Service (for the codes)

**Console → Explore Products → Verify → Services → Create new** (direct link:
<https://console.twilio.com/us1/develop/verify/services>).

1. **Friendly name**: this is the name that appears **inside the text message**
   the person receives, so use something they will recognise — `Comitra`.
2. Enable the **SMS** channel (it is on by default). You do not need Email,
   Voice or WhatsApp.
3. Code length: **6** (the app's UI expects 6 digits).
4. Save.

| Copy this | Into |
|---|---|
| **Service SID** (starts with `VA`) | `TWILIO_VERIFY_SERVICE_SID` |

Verify supplies its own sender numbers — you do **not** need to buy a phone
number for this step.

---

## Step 5 — Create a Messaging Service (for ordinary texts)

This one *does* need a sender.

1. **Console → Phone Numbers → Manage → Buy a number.** Pick a number with the
   **SMS** capability that can reach your users' countries.
   (Alternatives: a toll-free number, or an alphanumeric sender ID where your
   country allows it — note that alphanumeric senders cannot receive replies.)
2. **Console → Messaging → Services → Create Messaging Service**
   (<https://console.twilio.com/us1/develop/sms/services>).
   - **Name**: `Comitra`.
   - **Use case**: *Notify my users*.
3. Step 2 of the wizard, **Sender Pool** → **Add Senders** → *Phone Number* →
   tick the number you bought → **Add phone numbers**.
   A Messaging Service with an empty sender pool cannot send anything, so do not
   skip this.
4. Finish the wizard (Integration and Compliance can keep their defaults for
   now; see Step 6 for the callback).

| Copy this | Into |
|---|---|
| **Messaging Service SID** (starts with `MG`) | `TWILIO_MESSAGING_SERVICE_SID` |

---

## Step 6 — Delivery receipts (optional)

Skip this if your backend is not reachable from the internet yet — everything
else works without it.

1. Decide the public URL of your backend and append the webhook path:
   `https://your-backend.example.com/api/twilio/status-callback`
2. Put it in `TWILIO_STATUS_CALLBACK_URL`. The app passes it on every message,
   so this alone is enough.
3. Optionally also set it in the Console, which covers messages sent outside the
   app: **Messaging → Services → your service → Integration → Delivery Status
   Callback**.

The endpoint verifies `X-Twilio-Signature` on every request and answers **403**
to anything unsigned, so it is safe to expose. If you set the value in the
Console, use the **exact same URL string** — the signature is computed over it.

---

## Step 7 — Fill in `.env`

Open `.env` in the project root and paste the seven values:

```env
TWILIO_ACCOUNT_SID=
TWILIO_API_KEY_SID=
TWILIO_API_KEY_SECRET=
TWILIO_AUTH_TOKEN=
TWILIO_VERIFY_SERVICE_SID=
TWILIO_MESSAGING_SERVICE_SID=
TWILIO_STATUS_CALLBACK_URL=
```

Rules the server enforces:

- **All six** (the callback URL is optional) **or none.** A half-filled block
  makes the server refuse to boot and tell you exactly which name is missing —
  better than discovering it when someone is waiting for a code.
- Blank counts as "not set", so an empty line never shadows a real value.
- `.env` is in `.gitignore`. Never commit it.

When you deploy, set the same variables in your host's environment (Render /
Railway / Fly / systemd). Your local `.env` is not uploaded.

Also make sure the frontend knows where the backend is:

```env
VITE_API_BASE=https://your-backend.example.com
```

---

## Step 8 — Check it

```bash
npm run sms:status
```

It reports which values are present locally, then asks the running backend
whether it agrees. Nothing secret is printed.

Then start the backend:

```bash
cd server && npm start
```

It prints `SMS: Twilio configured (Verify + Messaging Service).` on boot.

End-to-end: open a judge invite link on a **different device/account** than the
inviter, enter a real phone number, and tap **Send verification code**.

---

## When something goes wrong

| What you see | What it means |
|---|---|
| App says *"Text-message verification isn't finished being set up yet"* | The backend has no Twilio credentials. Check the variables where the **server** runs, not just locally. |
| Server won't boot, "Twilio is half-configured" | One of the six values is empty or pasted into the wrong line. The message names it. |
| *"That number can't receive text messages"* | Landline, or a number type your sender cannot reach. |
| No text arrives, but the app reports success | Twilio accepted it and delivery failed later. **Console → Monitor → Logs → Messaging** shows the reason. Usual causes: trial account texting an unverified number, no credit, or a country your sender is not approved for. |
| *"Too many attempts"* | The per-number cooldown (60s between codes) or the hourly cap. Real, deliberate, and it applies per number. |

Twilio's own error codes are searchable at
<https://www.twilio.com/docs/api/errors> — the server logs the numeric code
(never the phone number or the OTP) so you can look it up.

---

## What is deliberately *not* here

- **No fallback SMS provider.** If Twilio fails, the app says so; it does not
  quietly reroute your users' phone numbers through someone else.
- **No sample/fake SIDs anywhere in the code.** The only SIDs in the repo are in
  test files, clearly fake, and never used at run time.
- **No Twilio credential in the client.** Search the built bundle for `AC`/`SK`
  prefixes if you want to confirm it.

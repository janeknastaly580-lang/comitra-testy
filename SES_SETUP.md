# Amazon SES setup (sign-up email codes)

Everything in the app is written and tested. What is left is the part only you
can do, because it needs an AWS account and your domain: verify the domain in
SES and paste **two** values into `.env`.

**No code changes are needed afterwards.** Until the values are filled in, the
app behaves exactly as it does today — sign-up creates the account straight
away, skips the code step, and no email is ever attempted.

---

## What the app does with SES

| Feature | Where |
|---|---|
| 6-digit code emailed when someone creates an account | `server/src/email/verify.js` |
| The email itself (subject, text + HTML body) | `server/src/email/templates.js`, or a SES-hosted template — Step 5B |
| The only two endpoints the app calls | `POST /api/email/verify/start`, `POST /api/email/verify/check` |

Four things worth knowing:

- **Sign-up no longer asks for a phone number.** The address someone types is
  the address the code goes to, and `emailVerifiedAt` is recorded on the account
  only when they type that code back. SMS is still used for the *judge* invite
  flow — that is Twilio, and unrelated (see `TWILIO_SETUP.md`).
- **The plaintext code is never stored.** `server/src/email/verify.js` generates
  it, emails it, and keeps only a keyed HMAC-SHA256 digest. It is valid for
  **7 minutes** from the moment it is generated, allows **5 attempts**, and is
  destroyed the moment it is used,
  expires, or runs out of attempts.
- **No AWS credential reaches the browser or the APK.** The web app calls *our*
  backend (`VITE_API_BASE`), and the backend calls SES. An AWS key shipped in a
  mobile app would be a licence to send phishing from your domain.
- **No route accepts a subject or a body.** The content is owned by the server,
  so the endpoint cannot be turned into an open relay sending mail signed by
  your SPF/DKIM.

---

## Step 1 — Pick a region and verify your domain

SES is **regional**: an identity verified in `eu-central-1` does not exist in
`us-east-1`. Pick the region closest to your users and stay in it.

1. AWS Console → **Amazon SES** → check the region selector, top right.
2. **Identities → Create identity → Domain**, enter your domain (e.g.
   `comitra.app`).
3. Leave **Easy DKIM** on (RSA_2048). Turn on **Publish DNS records to Route 53**
   if your domain is there — otherwise SES shows you three `CNAME` records to
   add at your DNS provider by hand.
4. Add them, then wait. Verification is usually minutes, occasionally a few
   hours. The identity flips to **Verified**.

> Verifying the *domain* (not a single address) is what lets you send from
> `no-reply@yourdomain`, and it is what makes DKIM sign the mail — without it
> most of your codes land in spam.

**Also recommended, same page:** set a **custom MAIL FROM domain** (e.g.
`mail.yourdomain`) and add the SPF record it asks for. It aligns SPF with your
domain, which is what DMARC checks.

---

## Step 2 — Get out of the sandbox

A brand-new SES account is in the **sandbox**: it can only send to addresses you
have verified yourself, which means nobody can actually sign up.

**SES → Account dashboard → Request production access.** You fill in a short
form (use case, how you handle bounces). Approval usually takes under 24 hours.

Describe the real use: *transactional one-time verification codes sent only to
the address a user just typed at sign-up; no marketing; no purchased lists.*

While you wait, add your own address under **Identities → Create identity →
Email address** so you can test the whole flow end to end.

---

## Step 3 — The sender address

Nothing to create in AWS — any address on the verified domain works. Pick one:

```
no-reply@yourdomain
```

Make sure something *watches* the mailbox or that it bounces cleanly. Silently
discarding replies is fine; a sender that hard-bounces is not.

---

## Step 4 — Credentials

Two ways. Pick one.

### A. IAM role (recommended, no long-lived key)

If the backend runs on AWS — EC2, ECS, App Runner, Lambda — attach a role with
this policy and set **no** AWS keys in `.env`. The SDK finds the credentials on
its own.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "ses:SendEmail", "Resource": "*" }
  ]
}
```

### B. IAM user access key

If the backend runs anywhere else: **IAM → Users → Create user** (no console
access) → attach the same policy inline → **Security credentials → Create
access key → Application running outside AWS**.

Copy both halves into `.env`. The secret is shown once.

> Do **not** use the SES SMTP credentials — those are for the SMTP interface.
> This integration uses the SES v2 API, which wants an ordinary AWS key.

---

## Step 5 — Fill in `.env`

In the **root** `.env` (the same file the Twilio values live in):

```env
# Required — the two that switch email verification on.
SES_REGION=eu-central-1
SES_FROM_EMAIL=no-reply@yourdomain

# Optional.
SES_FROM_NAME=Comitra
SES_REPLY_TO=
SES_CONFIGURATION_SET=

# Optional — a SES-hosted template for the code email. See Step 5B.
SES_TEMPLATE_NAME=
SES_TEMPLATE_VAR=code

# Only for Step 4B. Leave both empty when using an IAM role.
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
```

And make sure the frontend knows where the backend is:

```env
VITE_API_BASE=http://localhost:4000
```

Rules the server enforces at boot:

- **Both or neither.** `SES_REGION` + `SES_FROM_EMAIL` together switch the
  feature on. Fill in one and the server refuses to start, naming what is
  missing — a half-configured mailer would fail at the worst moment.
- **Both or neither, again.** `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`
  must be set together, or both left empty.
- `SES_FROM_EMAIL` must be a bare address. Display names go in `SES_FROM_NAME`.

---

## Step 5B — Using your own SES template (optional)

By default the email is built in `server/src/email/templates.js` and sent inline.
Set `SES_TEMPLATE_NAME` and it switches to a template **stored in SES** instead:
the subject and both bodies come from AWS, and the server sends only the six
digits. Editing the wording then needs no code change and no redeploy.

The template must take **exactly one variable — the code**. Nothing else is ever
passed to it: not the person's name, not their address, not anything about a
goal. That is deliberate, and it is what keeps the code email impossible to turn
into a channel for anything else.

```env
SES_TEMPLATE_NAME=comitra-verification-template
SES_TEMPLATE_VAR=code
```

`SES_TEMPLATE_VAR` is the bare word between `{{` and `}}` in your template. If
the template's HTML says `{{code}}`, leave it as `code`.

> **Get this name right.** SES does not fail on an unknown variable — it renders
> the template with an **empty box** where the code should be and reports a
> successful send. To the person signing up that looks exactly like "the code
> never arrived", and nothing in the server log will say otherwise. Open the
> template in the SES console and copy the placeholder name character for
> character.

The code is still generated, hashed and checked by this server exactly as
before — see `server/src/email/verify.js`. SES only renders it. Sending a
template uses the same `ses:SendEmail` permission as an inline send, so no IAM
change is needed.

---

## Step 6 — Install and run

The SDK is already in `server/package.json`; a plain install picks it up.

```bash
cd server && npm install && npm start
```

On boot the server prints one line telling you which state it is in:

```
Email: Amazon SES configured (sign-up verification codes).
Email: OFF — no SES_* values in .env, so /api/email/* answers 503. See SES_SETUP.md.
```

Check it directly:

```bash
curl http://localhost:4000/api/email/status
```

`{"configured":true}` means the app will show the code step at sign-up.

---

## Step 7 — Test the flow

1. Start the frontend (`npm run dev`) and open **Create account**.
2. Fill in a name, your own email, a password, tick both boxes.
3. **Create account** → the screen becomes *Confirm your email*.
4. The code arrives within seconds. Type it in → the account is created with
   `emailVerifiedAt` set.

Server-side you will see, with the address masked:

```
[email:verify-start] code requested for p•••@yourdomain
[email:verify-check] approved for p•••@yourdomain
```

---

## Turning it off

Clear `SES_REGION` and `SES_FROM_EMAIL`. Sign-up goes back to creating the
account immediately, with the address recorded but unverified. You can also
leave SES configured and set `VITE_EMAIL_VERIFY=off` in the frontend to skip the
step without touching the backend.

---

## Troubleshooting

| What you see | What it means |
|---|---|
| Server won't boot, "Amazon SES is half-configured" | One of a required pair is empty. The message names it. |
| Sign-up never shows the code step | `VITE_API_BASE` is empty or wrong, or `/api/email/status` says `configured:false`. Check the boot line. |
| `[email:verify-start] setup - ses send-email failed (MessageRejected…)` | The From address is not verified **in that region**, or the account is still in the sandbox and the recipient is not verified. |
| `…(NotFoundException…)` | `SES_CONFIGURATION_SET` or `SES_TEMPLATE_NAME` names something that does not exist **in this region**. |
| The email arrives but the code box is **empty** | `SES_TEMPLATE_VAR` does not match the `{{placeholder}}` in the template. SES reports this send as successful, so only the email itself shows it. |
| "We can't email you a confirmation code right now" on sign-up | Deliberate: the backend is unreachable or `/api/email/status` says `configured:false`, so no account is created. Check the boot line and `VITE_API_BASE`. |
| `…(AccessDeniedException, status 403)` | The IAM role or key is missing `ses:SendEmail`. |
| `@aws-sdk/client-sesv2 is not installed` in the log | Run `npm install` in `server/`. |
| Codes arrive in spam | Domain verified but DKIM not published, or no custom MAIL FROM / SPF. Redo the DNS records in Step 1. |
| "A code was just sent. Wait 47s" | The per-address cooldown (60s, 5 codes/hour). Working as intended. |

---

## Cost

SES is about **$0.10 per 1,000 emails**. A verification code per sign-up is
noise at any realistic volume. Bounces and complaints are what matter: keep the
bounce rate under 5% (SES pauses sending above 10%), which for a code that only
ever goes to a freshly-typed address means occasionally checking the SES
**Reputation** dashboard.

# SMS phone verification for judges — finishing the setup

The app now asks a judge to **confirm their phone number with a 6-digit SMS code**
when they accept an invite. All the app code is done. There is **one thing only you
can do** (it needs an account + a payment method, which I can't create for you):
connect Supabase to an SMS provider so real text messages can be sent.

Until you do that, the app keeps working exactly as before — no SMS step is shown.
The moment you finish the steps below, the SMS step **turns itself on automatically**
(no code change, no redeploy needed).

---

## How it works (so you know what you're paying for)

- When a judge accepts an invite (`/invite/...` page), after they enter their name,
  phone and judge password, they tap **"Send verification code."**
- Supabase generates a random 6-digit code, texts it to that number through your SMS
  provider, and stores/expires/rate-limits it server-side.
- The judge types the code back in. Only if it matches does the registration finish.
- The secret code and the provider password never touch the browser — Supabase does
  all of it. (This rides on Supabase's built-in **Phone Auth**, so there's no extra
  server for me to deploy and nothing new for you to run in the SQL editor.)

---

## What you must do — step by step

### 1. Get an SMS provider account

Supabase can send the SMS through **Twilio**, **MessageBird**, **Vonage**, or
**Textlocal**. Twilio is the most common; the steps below use it, but any of them work.

1. Go to <https://www.twilio.com/try-twilio> and create an account (this is the part I
   can't do for you — it needs your email and, to send real texts, a card).
2. In the Twilio console, buy/verify a phone number that can send SMS (or create a
   **Messaging Service** — recommended, it gives you a "Messaging Service SID").
3. From the Twilio dashboard, copy these three values:
   - **Account SID**
   - **Auth Token**
   - the **Messaging Service SID** (starts with `MG…`) — or the phone number you bought.

> 💡 Twilio gives new accounts trial credit. On a **trial** account you can only text
> numbers you've verified in Twilio, and messages have a trial prefix. That's fine for
> testing; to text anyone, upgrade the Twilio account (add funds). Rough cost: a few
> US cents per SMS.

### 2. Turn on Phone auth in Supabase

1. Open your project: <https://supabase.com/dashboard/project/utoqyuysxkkekefshfvp>
2. Left sidebar → **Authentication** → **Sign In / Providers** (or **Providers**).
3. Find **Phone** and enable it.
4. Under **SMS provider**, choose **Twilio** and paste:
   - Account SID → *Twilio Account SID*
   - Auth Token → *Twilio Auth Token*
   - Messaging Service SID (or your Twilio phone number) → *Twilio Message Service SID*
5. Make sure **"Enable phone confirmations"** / phone sign-ups is **on** (Supabase needs
   to be allowed to create a login for a new number in order to text it a code).
6. (Optional) Set the **OTP expiry** (e.g. 600 seconds) and keep the code length at 6.
7. **Save.**

### 3. (Optional) customise the text message

In the same area there's an **SMS message template**. The default is fine. If you want
your app name in it, use something like:

```
Your Comitra verification code is {{ .Code }}
```

### 4. Test it

1. Open a judge invite link on a **different device/account** than the inviter (same
   rule as before).
2. Fill in name + your **real** phone number + a judge password, tick consent, tap
   **"Send verification code."**
3. You should get a text within a few seconds. Type the code → the judge is registered.

If something's wrong you'll see a clear message on the page:
- *"Text-message verification isn't finished being set up yet"* → Phone auth or the
  provider isn't fully configured (re-check step 2). This is what shows right now,
  before you've done the setup.
- *"That code isn't right, or it has expired"* → wrong/old code; use **Resend code**.
- *"Too many attempts"* → provider/Supabase rate limit; wait a minute.

---

## Turning it on / off manually (optional)

By default the app **auto-detects** whether Phone auth is on and shows the SMS step only
when it is. You can override that with an environment variable
(`.env` locally, and in **Vercel → Project → Settings → Environment Variables**):

| `VITE_SMS_VERIFY` | Behaviour                                                        |
|-------------------|------------------------------------------------------------------|
| *(unset)* / `auto`| Show the SMS step only when Supabase Phone auth is detected as on |
| `on`              | Always require the SMS step (use only after setup is done)        |
| `off`             | Never require it (register judges without SMS, like before)       |

You normally don't need to set this — leave it on `auto`.

> Remember: on Vercel the variable **must** keep the `VITE_` prefix, or Vite won't expose
> it to the app (same gotcha as `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`).

---

## Summary

- **You do:** make a Twilio (or MessageBird/Vonage/Textlocal) account → paste its keys
  into Supabase **Authentication → Providers → Phone** → enable phone sign-ups → Save.
- **The app does:** everything else, and it switches the SMS step on by itself once the
  above is live. No SQL, no redeploy required.

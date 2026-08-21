# Push notification setup (Firebase Cloud Messaging)

Everything in the app is written. What is left is the part only you can do,
because it needs a Google account: create a Firebase project, drop one file into
`android/app/`, and paste three secrets into Supabase.

**Until you do, nothing is broken.** With `FCM_*` unset the app behaves exactly
as it did before push existed — a message is stored against the recipient's
account and shown the next time they open Pactista. Push is the doorbell; the
inbox has always been the post, and still is.

---

## What the app does with FCM

| Piece | Where |
|---|---|
| Asks for the token, files it against the signed-in account | `src/lib/fcm.ts` |
| Stores it, one row per device | `comitra_push_devices.fcm_token` |
| Mints the OAuth token and calls FCM v1 | `supabase/functions/api/fcm.ts` |
| The two places a notification is sent from | `pushSend` in `supabase/functions/api/index.ts`, `chatSend` in `chat.ts` |
| The Android channel it lands in | `comitra_goals`, created in `MainActivity` |

Five things worth knowing before you start:

- **The service-account key is a real secret.** It can push a notification to
  every user of the project. It lives in Edge Function secrets and never gets a
  `VITE_` prefix — that would compile it into the APK for anyone to unzip.
- **`google-services.json` is not a secret.** It ships inside every copy of the
  APK by design. Committing it is fine; losing it just means downloading it
  again.
- **A registration token is per installation, not per person.** Two people
  sharing a phone share a token, so the app re-files it on every sign-in and
  clears it on sign-out. That is what stops one person's notifications appearing
  on a phone they handed back.
- **Notification text is written by the server**, never by the sending app: a
  name from the directory, a goal *number*, and a fixed sentence. No goal title,
  no goal description, and never the text somebody typed into a chat — a lock
  screen is read by whoever is holding the phone.
- **Refusing the notification permission is a normal outcome.** Nothing retries
  and nothing nags; the message is still in the app.

---

## Step 1 — Create the Firebase project

1. Go to <https://console.firebase.google.com> and **Add project**. Any name.
   Google Analytics is not needed.
2. Inside the project: **Add app → Android**.
3. **Android package name** must be exactly:

   ```
   com.pactista.app
   ```

   This has to match `applicationId` in `android/app/build.gradle`. A mismatch
   is the most common reason a token is issued and no notification ever arrives.
4. Nickname and the debug signing certificate (SHA-1) can be left blank —
   neither is used by messaging.

## Step 2 — Drop `google-services.json` into the app

Download the file Firebase offers at the end of Step 1 and save it as:

```
android/app/google-services.json
```

Nothing else to change. `android/app/build.gradle` already looks for that exact
path and applies the Google Services plugin when it finds it; when it does not,
it logs `google-services.json not found` and carries on.

## Step 3 — Generate the service-account key

In the Firebase console: **⚙ Project settings → Service accounts → Generate new
private key**. A `.json` file downloads. Keep it out of the repo.

You need three values out of it:

| In the JSON | Becomes |
|---|---|
| `project_id` | `FCM_PROJECT_ID` |
| `client_email` | `FCM_CLIENT_EMAIL` |
| `private_key` | `FCM_PRIVATE_KEY` |

Copy `private_key` **whole**, including the `-----BEGIN PRIVATE KEY-----` and
`-----END PRIVATE KEY-----` lines. The `\n` sequences inside it are correct —
leave them exactly as they are. A key whose line breaks were "cleaned up" is the
single most common cause of a setup that looks right and never sends anything.

## Step 4 — Give the secrets to the backend

Either in the dashboard (**Edge Functions → Secrets**), or:

```bash
supabase secrets set FCM_PROJECT_ID="your-project-id" FCM_CLIENT_EMAIL="firebase-adminsdk-xxxxx@your-project-id.iam.gserviceaccount.com" FCM_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n"
```

All three or none: half a credential reports itself as a problem in the function
log and leaves push switched off, rather than failing at the worst moment.

## Step 5 — Run the migration

Dashboard → **SQL Editor → New query**, paste all of
[`supabase/comitra_fcm_tokens.sql`](supabase/comitra_fcm_tokens.sql), **Run**.

It adds the token column and four functions, all granted to the service role
only. The query at the bottom prints them back; expect four rows whose `acl`
mentions `service_role` and nothing else. Safe to re-run.

## Step 6 — Deploy the function

The CLI on this machine is **not** logged in — `supabase projects list` answers
`Access token not provided` — so authenticate first. It opens a browser:

```bash
supabase login
```

Then:

```bash
supabase functions deploy api
```

If that still refuses, the dashboard route works without the CLI: **Edge
Functions → api → Code**, paste the changed files, deploy. The files this
feature touched are `fcm.ts` (new), `config.ts`, `chat.ts` and `index.ts`.

## Step 7 — Rebuild the app

The token code and `google-services.json` only exist inside a freshly built APK.

```bash
npm run android:apk
```

The APK lands in `android/app/build/outputs/apk/debug/`. For Play, build a
signed release bundle instead.

---

## Checking it worked

**Is the backend configured?** Open this in a browser — it needs no session and
names no secret:

```
https://<your-project>.supabase.co/functions/v1/api/push/status
```

`{"configured":true}` means all three secrets arrived and parsed. `false` means
they did not, and the function log says which.

**Is the phone registered?** Install the rebuilt APK, sign in, accept the
notification permission. Then in the SQL editor:

```sql
select user_id, platform, last_seen_at, token_updated_at,
       fcm_token is not null as has_token
from   public.comitra_push_devices
order  by last_seen_at desc
limit  10;
```

`has_token = true` for your account means the round trip works.

**Does it actually ring?** Easiest real test: sign in as a second account on
another device (or a friend), make the two follow each other, **close Pactista
completely on the first phone**, and send it a chat message from the second. The
notification should arrive within a couple of seconds.

---

## When it does not work

| What you see | Almost always |
|---|---|
| `registrationError` in logcat | The APK was built without `google-services.json`, or before Step 2. Rebuild. |
| `has_token` stays false | The app was never signed in (a guest has no account to file against), or the notification permission was refused. |
| `/api/push/status` says false | A secret is missing or blank. The function log names it. |
| Log: `could not sign with FCM_PRIVATE_KEY` | The PEM lost its line breaks, or only part of it was pasted. |
| Log: `token endpoint refused: 400 invalid_grant` | The key was revoked or the service account deleted. Generate a new one. |
| Notification arrives but is silent/greyed | The channel was muted by the user in Android settings — Pactista cannot override that, by design. |
| Everything works in the foreground only | The phone is force-stopping the app, or battery optimisation is aggressive. Android side, not Pactista's. |

Function logs: dashboard → **Edge Functions → api → Logs**. Everything this
feature logs is prefixed `[fcm]`.

---

## Google Play

Push itself needs nothing extra in the Play Console — no declaration, no review
question. Two things to remember when you fill the listing in:

- **Data safety**: the app now stores a device identifier (the FCM registration
  token) for app functionality. It is not shared with third parties beyond
  Google's own delivery service, and it is deleted when the user signs out.
- **`POST_NOTIFICATIONS`** is already declared in the manifest and needs no
  special justification.

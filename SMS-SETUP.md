# SMS setup → see [TWILIO_SETUP.md](TWILIO_SETUP.md)

This file used to describe wiring SMS through **Supabase Phone Auth**, with the
browser calling Supabase's `/auth/v1/otp` directly and Supabase holding the
Twilio credentials.

That is no longer how it works. SMS now runs through the app's own backend
(`server/`) and the official Twilio SDK, with a single **Messaging Service** as
the sender for everything:

- **verification codes** — issued, hashed and checked by
  `server/src/twilio/verify.js` (5 minutes, 5 attempts); no Twilio Verify
  Service is involved, so `.env` needs no `VA…` SID,
- **the ordinary texts** — judge review requests, "X failed their goal #N",
  invite links,
- the delivery-status webhook verifies `X-Twilio-Signature` on every request
  (optional; needs `TWILIO_AUTH_TOKEN`).

Nothing to configure in Supabase for this any more; leave Phone auth off. The
Supabase project is still used for the shared judge store
(`supabase/comitra_invited_judges.sql`), which is unrelated.

**The steps you need are in [TWILIO_SETUP.md](TWILIO_SETUP.md).**

To check where things stand at any time:

```bash
npm run sms:status
```

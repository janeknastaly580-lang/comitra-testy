# SMS setup → see [TWILIO_SETUP.md](TWILIO_SETUP.md)

This file used to describe wiring SMS through **Supabase Phone Auth**, with the
browser calling Supabase's `/auth/v1/otp` directly and Supabase holding the
Twilio credentials.

That is no longer how it works. SMS now runs through the app's own backend
(`server/`) and the official Twilio SDK:

- **Twilio Verify** issues and checks the 6-digit codes,
- **Twilio Programmable Messaging** (via a **Messaging Service**) sends the
  ordinary texts — judge review requests, "X did not complete their goal",
  invite links,
- the delivery-status webhook verifies `X-Twilio-Signature` on every request.

Nothing to configure in Supabase for this any more; leave Phone auth off. The
Supabase project is still used for the shared judge store
(`supabase/comitra_invited_judges.sql`), which is unrelated.

**The steps you need are in [TWILIO_SETUP.md](TWILIO_SETUP.md).**

To check where things stand at any time:

```bash
npm run sms:status
```

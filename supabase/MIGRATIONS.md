# Pactista · database migrations

The `.sql` files next to this one are the ORIGINAL, hand-run setup scripts. They
are kept for the record and for reading, but several are marked superseded: the
live definitions have since been replaced by migrations applied through the
Supabase migration history, which is the authoritative source.

Run `supabase migration list` (or read Database → Migrations in the dashboard)
for the full, ordered set. What follows is what each one was for.

| Migration | What it did |
| --- | --- |
| `comitra_harden_public_rpcs` | Added argument validation, size caps and rate limits to the RPCs the app could reach with the publishable key. |
| `comitra_close_push_and_judge_list_to_anon` | Moved the inbox and judge list behind the `api` Edge Function, so the caller is taken from a session token instead of from a user id in the arguments. |
| `comitra_chat` | `comitra_chat_messages` + its RPCs. The in-app conversation that replaced every judge link, with the 300-character and 20-typed-messages-a-day caps enforced inside the insert. |
| `comitra_goals_by_identity` | `comitra_goals.judge_user_id`, plus `comitra_goal_put` / `comitra_goal_get` / `comitra_goal_list_judging`. A shared goal is now gated on **who you are signed in as** rather than on a token from a link, and the old token-authorised functions were revoked from `anon`. |
| `comitra_goal_judge_act` | The only write a judge may make: a narrow, server-built patch carrying their acceptance or their verdict. Every precondition is checked in the same statement that writes. |
| `comitra_fcm_tokens` | `comitra_push_devices.fcm_token`, plus `comitra_push_set_token` / `comitra_push_forget_device` / `comitra_push_tokens_for` / `comitra_push_drop_token`. What turned the inbox into real push: the backend can now wake a closed app instead of waiting for it to be opened. All four are service-role only — a registration token is a capability to notify that handset. |
| `comitra_social_graph` | `comitra_directory` + `comitra_follows`. Friends became real people two devices can both see, which is what makes "pick a judge from your friends" possible at all. |

## Things worth knowing before touching any of this

- **Nothing is reachable with the publishable key any more** except three
  read-only `*_status()` probes. Every other function is granted to the service
  role and called from the `api` Edge Function, which resolves the acting
  account from the session token.
- **`comitra_invited_judges.sql` is retired.** Judges are app friends now; there
  is nobody to invite by email. The table and its function still exist so old
  rows are explainable, and `comitra_register_invited_judge` has had its `anon`
  grant revoked.
- **The two caps in `comitra_chat_send` are the real ones.** The numbers in
  `src/lib/chat.ts` and `supabase/functions/api/chat.ts` exist to word the
  message a person sees; the gate is the SQL, under an advisory lock on the
  thread, so two devices sending at once cannot both slip past it.

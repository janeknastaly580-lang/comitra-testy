-- ─────────────────────────────────────────────────────────────────────────────
-- Pactista · real push  (migration `comitra_fcm_tokens` — safe to re-run)
--
-- Dashboard → SQL Editor → New query → paste ALL of this → Run.
--
-- WHAT THIS CHANGES. Until now `comitra_push_devices` answered exactly one
-- question — "has this account opened the app lately?" — which is enough to tell
-- a sender the truth but cannot wake anybody's phone. A message therefore waited
-- in the inbox until its recipient happened to open Pactista. This adds the one
-- thing that was missing: the FCM registration token of each device, so the `api`
-- Edge Function can hand a notification to Google and have it delivered while
-- the app is closed.
--
-- The inbox does NOT go away and is still the record. A push is a doorbell: it
-- may be dropped by the network, refused by the user, or aimed at a phone that
-- has been wiped. Everything above this still works if every push fails.
--
-- WHO MAY CALL THESE. Nobody but the service role, i.e. the Edge Function. A
-- registration token is a capability: whoever holds one can post a notification
-- to that phone. Handing that to the publishable key — which ships inside the
-- APK — would let anyone who unzipped it notify any user.
--
-- PRIVACY: a token identifies an app INSTALLATION, not a person. It is never
-- returned to any client, including the device it came from.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. The column ───────────────────────────────────────────────────────────
alter table public.comitra_push_devices
  add column if not exists fcm_token        text,
  add column if not exists token_updated_at timestamptz;

-- Only rows that can actually be pushed to are ever scanned.
create index if not exists comitra_push_devices_token_idx
  on public.comitra_push_devices (user_id)
  where fcm_token is not null;

-- ── 2. Register a token ─────────────────────────────────────────────────────
-- Called whenever FCM issues or rotates one, which it does on its own schedule
-- as well as on install and on restore-to-a-new-phone.
--
-- THE FIRST `update` IS THE POINT. A device id is per PHONE, not per account, so when
-- one person logs out and another logs in on the same handset the old row keeps
-- its token — and would keep receiving the first person's notifications on the
-- second person's lock screen. Any row anywhere holding this token is therefore
-- cleared before the new one is written: a token belongs to exactly one account
-- at a time, whoever used it yesterday.
create or replace function public.comitra_push_set_token(
  p_user_id   text,
  p_device_id text,
  p_platform  text,
  p_token     text
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_token is null or length(btrim(p_token)) < 20 or length(p_token) > 4096 then
    raise exception 'comitra: fcm token is not a plausible token';
  end if;

  update public.comitra_push_devices
     set fcm_token = null, token_updated_at = now()
   where fcm_token = p_token
     and not (user_id = p_user_id and device_id = p_device_id);

  insert into public.comitra_push_devices (user_id, device_id, platform, last_seen_at, fcm_token, token_updated_at)
  values (p_user_id, p_device_id, coalesce(nullif(p_platform, ''), 'web'), now(), btrim(p_token), now())
  on conflict (user_id, device_id) do update
    set platform         = excluded.platform,
        last_seen_at     = now(),
        fcm_token        = excluded.fcm_token,
        token_updated_at = now();
end;
$$;

-- ── 3. Read the tokens for one account ──────────────────────────────────────
-- Bounded twice over: by how long ago the app was last opened (a token from a
-- phone nobody has touched in months is almost certainly dead) and by a hard
-- row cap, so one account with a long device history cannot turn a single
-- message into an unbounded fan-out.
create or replace function public.comitra_push_tokens_for(
  p_user_id text,
  p_days    int
) returns setof text
language sql
stable
security definer
set search_path = public
as $$
  select fcm_token
  from   public.comitra_push_devices
  where  user_id = p_user_id
  and    fcm_token is not null
  and    last_seen_at > now() - make_interval(days => greatest(coalesce(p_days, 60), 1))
  order  by last_seen_at desc
  limit  10;
$$;

-- ── 3b. Forget this device, on sign-out ─────────────────────────────────────
-- The other half of the shared-handset problem. Section 2 handles "somebody
-- else signed in here"; this handles "nobody did" — a person logs out and hands
-- the phone back, and their notifications must stop arriving on it even though
-- no new account has claimed the token.
--
-- The row itself stays: `last_seen_at` is what tells a sender whether this
-- person still has the app anywhere, and signing out of one device is not
-- evidence about the others.
create or replace function public.comitra_push_forget_device(
  p_user_id   text,
  p_device_id text
) returns void
language sql
volatile
security definer
set search_path = public
as $$
  update public.comitra_push_devices
     set fcm_token = null, token_updated_at = now()
   where user_id = p_user_id and device_id = p_device_id;
$$;

-- ── 4. Forget a dead token ──────────────────────────────────────────────────
-- FCM answers UNREGISTERED when an app has been uninstalled or its token
-- replaced. Dropping it on that answer is what stops the same doomed send being
-- retried forever — and it is also what makes an uninstall visible here.
create or replace function public.comitra_push_drop_token(p_token text)
returns void
language sql
volatile
security definer
set search_path = public
as $$
  update public.comitra_push_devices
     set fcm_token = null, token_updated_at = now()
   where fcm_token = p_token;
$$;

-- ── 5. Grants — service role only ───────────────────────────────────────────
-- Postgres grants EXECUTE to public by default, so the revoke is not optional.
revoke execute on function public.comitra_push_set_token(text,text,text,text) from public, anon, authenticated;
revoke execute on function public.comitra_push_forget_device(text,text)       from public, anon, authenticated;
revoke execute on function public.comitra_push_tokens_for(text,int)           from public, anon, authenticated;
revoke execute on function public.comitra_push_drop_token(text)               from public, anon, authenticated;

grant execute on function public.comitra_push_set_token(text,text,text,text) to service_role;
grant execute on function public.comitra_push_forget_device(text,text)       to service_role;
grant execute on function public.comitra_push_tokens_for(text,int)           to service_role;
grant execute on function public.comitra_push_drop_token(text)               to service_role;

-- ── 6. Verification ─────────────────────────────────────────────────────────
-- Expect four rows, each with `service_role` and nothing else in `acl`.
select p.proname,
       coalesce(array_to_string(p.proacl, ' '), '(default)') as acl
from   pg_proc p join pg_namespace n on n.oid = p.pronamespace
where  n.nspname = 'public'
and    p.proname in ('comitra_push_set_token', 'comitra_push_forget_device',
                     'comitra_push_tokens_for', 'comitra_push_drop_token')
order  by p.proname;

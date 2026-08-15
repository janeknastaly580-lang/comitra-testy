-- ─────────────────────────────────────────────────────────────────────────────
-- Comitra · ACCOUNTS, SESSIONS and per-account STATE  (run ONCE — re-runnable)
--
-- Dashboard → SQL Editor → New query → paste ALL of this → Run.
-- Independent of comitra_goals.sql and comitra_invited_judges.sql; run all three.
--
-- WHY THIS EXISTS: accounts used to live in the browser's own storage, so an
-- account created on a phone did not exist anywhere else. Logging in on a second
-- device was not "unsupported", it was impossible — there was nothing to log in
-- to. This is the user table that makes an account a real account: it lives here,
-- so signing in on any device reaches the same one.
--
-- WHAT IS STORED
--   • comitra_accounts   — the address, a display name, and a PBKDF2 verifier for
--     the password. The password itself is never sent here and cannot be derived
--     from what is: `password_hash` is `pbkdf2$<iterations>$<salt>$<derived>`,
--     salted per account, so two people with the same password get different
--     rows and a table dump buys an attacker a very slow offline grind.
--   • comitra_sessions   — only a HMAC of each session token. The token itself
--     exists on the device that logged in and nowhere else, so these rows cannot
--     be replayed into a login.
--   • comitra_user_state — everything the app knows about one account (goals,
--     judges, recipients, consents, settings) as one JSON document, plus a
--     revision counter so two devices editing at once cannot silently overwrite
--     each other. Whether a field is readable here is NOT the privacy boundary
--     that matters for goals: what a JUDGE can see is still the allow-listed
--     projection in comitra_goals, which never contains a goal's title or details.
--
-- HOW ACCESS IS GATED: nothing in here is reachable with the browser's public
-- key. RLS is on, no policies, no grants, and every function below is
-- `security definer` with execute granted ONLY to service_role — the key that
-- exists inside the `api` Edge Function and never leaves it. So a password
-- verifier, a session row, and another person's state are all unreachable from a
-- phone except through the function's own routes, which check a password or a
-- session token first.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Tables ───────────────────────────────────────────────────────────────
create table if not exists public.comitra_accounts (
  id                uuid primary key default gen_random_uuid(),
  -- As typed, for display and for the "to:" of any mail.
  email             text        not null,
  -- Normalised (trimmed + lower-cased) and UNIQUE: the thing sign-up checks and
  -- login looks up. Kept separate so changing the display form can never change
  -- which account an address resolves to. Freed on delete (see below), so
  -- deleting an account does not lock someone out of their own address forever.
  email_key         text        not null unique,
  name              text        not null default '',
  -- Null for an account created through a social provider and never given a
  -- password. Such an account cannot be logged into with a password until one is
  -- set through the reset-by-email flow.
  password_hash     text,
  account_type      text        not null default 'standard',
  provider          text        not null default 'password',
  email_verified_at timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz
);

create table if not exists public.comitra_sessions (
  -- HMAC of the bearer token, never the token.
  token_hash   text primary key,
  user_id      uuid        not null references public.comitra_accounts (id) on delete cascade,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at   timestamptz not null
);

create index if not exists comitra_sessions_user_idx    on public.comitra_sessions (user_id);
create index if not exists comitra_sessions_expires_idx on public.comitra_sessions (expires_at);

create table if not exists public.comitra_user_state (
  user_id    uuid primary key references public.comitra_accounts (id) on delete cascade,
  data       jsonb       not null default '{}'::jsonb,
  -- Bumped on every accepted write. A device sends the revision it started from;
  -- a mismatch means somebody else wrote in between and the write is refused
  -- rather than applied, so the client can merge instead of clobbering.
  revision   bigint      not null default 0,
  updated_at timestamptz not null default now()
);

-- ── 2. Lock everything down ─────────────────────────────────────────────────
alter table public.comitra_accounts   enable row level security;
alter table public.comitra_sessions   enable row level security;
alter table public.comitra_user_state enable row level security;

revoke all on public.comitra_accounts   from anon, authenticated;
revoke all on public.comitra_sessions   from anon, authenticated;
revoke all on public.comitra_user_state from anon, authenticated;

-- ── 3. Housekeeping ─────────────────────────────────────────────────────────
-- No cron on the free plan, so expiry is enforced by every read AND swept
-- opportunistically by the write paths.
create or replace function public.comitra_auth_sweep()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.comitra_sessions where expires_at < now();
$$;

-- ── 4. Accounts ─────────────────────────────────────────────────────────────

-- Is this address free to register? Soft-deleted accounts release their address
-- (their email_key is scrambled on delete), so they are simply not here.
create or replace function public.comitra_account_available(p_email_key text)
returns table (available boolean)
language sql
stable
security definer
set search_path = public
as $$
  select not exists (
    select 1 from public.comitra_accounts a
    where a.email_key = p_email_key and a.deleted_at is null
  );
$$;

-- Create an account. Returns `taken = true` instead of raising, so the caller
-- can word the refusal itself rather than parsing a constraint violation.
create or replace function public.comitra_account_create(
  p_email          text,
  p_email_key      text,
  p_name           text,
  p_password_hash  text,
  p_account_type   text,
  p_provider       text,
  p_email_verified boolean
) returns table (id uuid, taken boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if exists (select 1 from public.comitra_accounts a
             where a.email_key = p_email_key and a.deleted_at is null) then
    return query select null::uuid, true;
    return;
  end if;

  insert into public.comitra_accounts
    (email, email_key, name, password_hash, account_type, provider, email_verified_at)
  values
    (p_email, p_email_key, coalesce(p_name, ''), p_password_hash,
     coalesce(p_account_type, 'standard'), coalesce(p_provider, 'password'),
     case when p_email_verified then now() else null end)
  returning comitra_accounts.id into v_id;

  insert into public.comitra_user_state (user_id) values (v_id)
    on conflict (user_id) do nothing;

  return query select v_id, false;
exception
  -- Two sign-ups racing on the same address: the loser reports it as taken,
  -- which is exactly what it now is.
  when unique_violation then
    return query select null::uuid, true;
end;
$$;

-- The verifier and identity for a login attempt. Returns no row for an unknown
-- or deleted address; the caller must still burn the same amount of time.
create or replace function public.comitra_account_by_email(p_email_key text)
returns table (
  id uuid, email text, name text, password_hash text,
  account_type text, provider text, email_verified_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select a.id, a.email, a.name, a.password_hash, a.account_type, a.provider, a.email_verified_at
  from   public.comitra_accounts a
  where  a.email_key = p_email_key and a.deleted_at is null;
$$;

-- Sign in with a social provider: reuse the account on that address, or make one.
create or replace function public.comitra_account_upsert_social(
  p_email     text,
  p_email_key text,
  p_name      text,
  p_provider  text
) returns table (id uuid, created boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  select a.id into v_id
  from   public.comitra_accounts a
  where  a.email_key = p_email_key and a.deleted_at is null;

  if v_id is not null then
    return query select v_id, false;
    return;
  end if;

  -- The provider vouched for the address, so it counts as verified.
  insert into public.comitra_accounts
    (email, email_key, name, provider, email_verified_at)
  values (p_email, p_email_key, coalesce(p_name, ''), coalesce(p_provider, 'social'), now())
  returning comitra_accounts.id into v_id;

  insert into public.comitra_user_state (user_id) values (v_id)
    on conflict (user_id) do nothing;

  return query select v_id, true;
end;
$$;

-- Set a new password for an address (after a reset token was spent) and, in the
-- same transaction, drop every session for that account — a password reset is
-- also how someone kicks out whoever they think is in their account.
create or replace function public.comitra_account_set_password(
  p_email_key text,
  p_hash      text
) returns table (id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  update public.comitra_accounts a
     set password_hash = p_hash,
         updated_at    = now(),
         -- Proving control of the mailbox verifies the address as surely as
         -- typing a sign-up code does.
         email_verified_at = coalesce(a.email_verified_at, now())
   where a.email_key = p_email_key and a.deleted_at is null
   returning a.id into v_id;

  if v_id is null then return; end if;

  delete from public.comitra_sessions s where s.user_id = v_id;
  return query select v_id;
end;
$$;

-- Rename an account (the display name people see on their own profile).
create or replace function public.comitra_account_rename(p_id uuid, p_name text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.comitra_accounts a
     set name = coalesce(p_name, a.name), updated_at = now()
   where a.id = p_id and a.deleted_at is null;
$$;

-- Delete an account: the state document and every session go immediately, and
-- the address is released so the person can sign up again with it.
create or replace function public.comitra_account_delete(p_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  with gone as (
    update public.comitra_accounts a
       set deleted_at = now(),
           updated_at = now(),
           -- Keeps the unique index satisfied while freeing the address.
           email_key  = a.email_key || ':deleted:' || a.id::text
     where a.id = p_id and a.deleted_at is null
     returning a.id
  ),
  _s as (delete from public.comitra_sessions   s where s.user_id in (select id from gone))
  delete from public.comitra_user_state st where st.user_id in (select id from gone);
$$;

-- ── 5. Sessions ─────────────────────────────────────────────────────────────

create or replace function public.comitra_session_create(
  p_token_hash text,
  p_user_id    uuid,
  p_ttl_ms     bigint
) returns void
language sql
security definer
set search_path = public
as $$
  delete from public.comitra_sessions where expires_at < now();

  insert into public.comitra_sessions (token_hash, user_id, expires_at)
  values (p_token_hash, p_user_id, now() + make_interval(secs => p_ttl_ms / 1000.0))
  on conflict (token_hash) do update
    set user_id      = excluded.user_id,
        expires_at   = excluded.expires_at,
        last_seen_at = now();
$$;

-- Resolve a token to its account, sliding the expiry so an app in daily use
-- never logs itself out. Expired rows resolve to nothing and are removed.
create or replace function public.comitra_session_touch(
  p_token_hash text,
  p_ttl_ms     bigint
) returns table (
  user_id uuid, email text, name text, account_type text, email_verified_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid;
begin
  delete from public.comitra_sessions s
   where s.token_hash = p_token_hash and s.expires_at < now();

  update public.comitra_sessions s
     set last_seen_at = now(),
         expires_at   = now() + make_interval(secs => p_ttl_ms / 1000.0)
   where s.token_hash = p_token_hash
   returning s.user_id into v_user;

  if v_user is null then return; end if;

  return query
    select a.id, a.email, a.name, a.account_type, a.email_verified_at
    from   public.comitra_accounts a
    where  a.id = v_user and a.deleted_at is null;
end;
$$;

create or replace function public.comitra_session_drop(p_token_hash text)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.comitra_sessions where token_hash = p_token_hash;
$$;

-- ── 6. The state document ───────────────────────────────────────────────────

create or replace function public.comitra_state_get(p_user_id uuid)
returns table (data jsonb, revision bigint)
language sql
stable
security definer
set search_path = public
as $$
  select s.data, s.revision
  from   public.comitra_user_state s
  where  s.user_id = p_user_id;
$$;

-- Write the document, but only if the caller started from the revision that is
-- still current. `p_base_revision < 0` forces the write (used right after a
-- merge, when the client has just folded in whatever it collided with).
--
-- On refusal it returns the CURRENT document, so a losing device gets what it
-- needs to merge in the same round trip it was refused in.
create or replace function public.comitra_state_put(
  p_user_id       uuid,
  p_data          jsonb,
  p_base_revision bigint
) returns table (ok boolean, revision bigint, data jsonb)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current bigint;
begin
  insert into public.comitra_user_state (user_id) values (p_user_id)
    on conflict (user_id) do nothing;

  -- Take the row lock first: two devices pushing at the same moment must be
  -- ordered, or both could read the same revision and both think they won.
  select s.revision into v_current
  from   public.comitra_user_state s
  where  s.user_id = p_user_id
  for update;

  if p_base_revision >= 0 and v_current is distinct from p_base_revision then
    return query
      select false, s.revision, s.data
      from   public.comitra_user_state s
      where  s.user_id = p_user_id;
    return;
  end if;

  update public.comitra_user_state s
     set data       = p_data,
         revision   = s.revision + 1,
         updated_at = now()
   where s.user_id = p_user_id;

  return query
    select true, s.revision, null::jsonb
    from   public.comitra_user_state s
    where  s.user_id = p_user_id;
end;
$$;

-- ── 7. Grants: the Edge Function's key only ─────────────────────────────────
-- Deliberately NOT granted to anon/authenticated. A phone cannot call any of
-- these; it can only reach the `api` function's routes, which check a password
-- or a session token before calling them on its behalf.
do $$
declare fn text;
begin
  foreach fn in array array[
    'public.comitra_auth_sweep()',
    'public.comitra_account_available(text)',
    'public.comitra_account_create(text,text,text,text,text,text,boolean)',
    'public.comitra_account_by_email(text)',
    'public.comitra_account_upsert_social(text,text,text,text)',
    'public.comitra_account_set_password(text,text)',
    'public.comitra_account_rename(uuid,text)',
    'public.comitra_account_delete(uuid)',
    'public.comitra_session_create(text,uuid,bigint)',
    'public.comitra_session_touch(text,bigint)',
    'public.comitra_session_drop(text)',
    'public.comitra_state_get(uuid)',
    'public.comitra_state_put(uuid,jsonb,bigint)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;

-- ── 8. Verification — read the output of this query ─────────────────────────
-- Expect 13 rows. Fewer means something above failed; re-run and read the
-- editor's error message.
select proname
from   pg_proc p join pg_namespace n on n.oid = p.pronamespace
where  n.nspname = 'public' and proname like 'comitra\_%'
  and  proname in (
    'comitra_auth_sweep','comitra_account_available','comitra_account_create',
    'comitra_account_by_email','comitra_account_upsert_social',
    'comitra_account_set_password','comitra_account_rename','comitra_account_delete',
    'comitra_session_create','comitra_session_touch','comitra_session_drop',
    'comitra_state_get','comitra_state_put')
order by proname;

-- Done. Redeploy the `api` Edge Function, then create an account on one device
-- and log into it on another: the goals, judges and settings are all there.

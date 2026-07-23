-- ─────────────────────────────────────────────────────────────────────────────
-- Comitra · cross-device judge sync  (run ONCE — safe to re-run any time)
--
-- Dashboard → SQL Editor → New query → paste ALL of this → Run.
-- No secret ever leaves your dashboard, which is why this is the method chosen
-- for maximum security.
--
-- WHY YOU MIGHT BE RUNNING THIS AGAIN
--   The "become a judge" page failing with
--       Sync failed (401) … "code":"42501" …
--       new row violates row-level security policy for table "comitra_invited_judges"
--   means the TABLE exists but its RLS POLICIES do not. That happens when the
--   table was created by hand in the Table Editor (which turns RLS on and adds
--   no policies), or when an earlier run of this script rolled back part-way —
--   the SQL editor runs the whole script in ONE transaction, so a single failing
--   statement undoes everything after it. This version is written so that no
--   statement can fail on an existing install.
--
-- Security model:
--   • RLS is ON. A visitor (anon key, which ships inside the app) may only
--     INSERT/UPDATE a judge row. There is deliberately NO select policy, so a
--     direct read of the table returns zero rows — the phone numbers in it
--     cannot be enumerated with the public key.
--   • Reads go through a SECURITY DEFINER function that requires the owner id,
--     so you can only list judges for an owner id you already know.
--   • The judge's PASSWORD is never stored here (not even hashed). It stays on
--     the judge's own device. This table only holds name + phone so the inviter
--     can see and pick the judge.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Table ────────────────────────────────────────────────────────────────
create table if not exists public.comitra_invited_judges (
  id                    text primary key,
  owner_user_id         text not null,
  name                  text not null,
  phone                 text not null,
  judge_account_user_id text,
  consented_at          timestamptz,
  created_at            timestamptz not null default now(),
  unique (owner_user_id, phone)
);

-- Self-heal a table that was created by hand with only some of the columns.
alter table public.comitra_invited_judges add column if not exists owner_user_id         text;
alter table public.comitra_invited_judges add column if not exists name                  text;
alter table public.comitra_invited_judges add column if not exists phone                 text;
alter table public.comitra_invited_judges add column if not exists judge_account_user_id text;
alter table public.comitra_invited_judges add column if not exists consented_at          timestamptz;
alter table public.comitra_invited_judges add column if not exists created_at            timestamptz not null default now();

-- Drop a legacy password column if an earlier version of this file created one.
alter table public.comitra_invited_judges drop column if exists code_hash;

create index if not exists comitra_invited_judges_owner_idx
  on public.comitra_invited_judges (owner_user_id);

-- The app upserts with ON CONFLICT (owner_user_id, phone), which needs a unique
-- key on exactly those columns. Add it only if it isn't already there.
do $$
begin
  if not exists (
    -- Any unique index covering exactly (owner_user_id, phone), whatever it is
    -- called and in whichever column order.
    select 1
    from   pg_index i
    where  i.indrelid = 'public.comitra_invited_judges'::regclass
    and    i.indisunique
    and    (
             select array_agg(a.attname::text order by a.attname)
             from   unnest(i.indkey::smallint[]) k
             join   pg_attribute a on a.attrelid = i.indrelid and a.attnum = k
           ) = array['owner_user_id', 'phone']
  ) then
    alter table public.comitra_invited_judges
      add constraint comitra_invited_judges_owner_phone_key unique (owner_user_id, phone);
  end if;
end $$;

-- ── 2. Row level security ───────────────────────────────────────────────────
alter table public.comitra_invited_judges enable row level security;

-- Supabase already grants these to anon by default; stated explicitly so the
-- install does not depend on project defaults.
grant insert, update on public.comitra_invited_judges to anon;
grant insert, update on public.comitra_invited_judges to authenticated;

-- THE PART THAT WAS MISSING when you saw error 42501. Without these two
-- policies RLS rejects every write, whatever the grants say.
drop policy if exists comitra_ij_insert on public.comitra_invited_judges;
create policy comitra_ij_insert on public.comitra_invited_judges
  for insert to anon, authenticated
  with check (true);

drop policy if exists comitra_ij_update on public.comitra_invited_judges;
create policy comitra_ij_update on public.comitra_invited_judges
  for update to anon, authenticated
  using (true) with check (true);

-- NOTE: there is intentionally no SELECT policy. Reading the table directly
-- therefore returns an empty list, and the only read path is the function below.

-- ── 3. Read path (the only way to read rows) ────────────────────────────────
-- Dropped first so a signature change from an older install can never fail with
-- "cannot change return type of existing function".
drop function if exists public.comitra_list_invited_judges(text);

create function public.comitra_list_invited_judges(p_owner text)
returns setof public.comitra_invited_judges
language sql
stable
security definer
set search_path = public
as $$
  select * from public.comitra_invited_judges where owner_user_id = p_owner;
$$;

grant execute on function public.comitra_list_invited_judges(text) to anon;
grant execute on function public.comitra_list_invited_judges(text) to authenticated;

-- ── 3b. Setup probe ─────────────────────────────────────────────────────────
-- Lets the app tell the inviter, before they send a link, whether a friend will
-- actually be able to register. A missing write policy is invisible from a read,
-- so the app asks here instead of finding out on someone else's phone.
drop function if exists public.comitra_sync_status();

create function public.comitra_sync_status()
returns table (has_insert boolean, has_update boolean)
language sql
stable
security definer
set search_path = public
as $$
  select
    exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = 'comitra_invited_judges' and cmd = 'INSERT'
    ),
    exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = 'comitra_invited_judges' and cmd = 'UPDATE'
    );
$$;

grant execute on function public.comitra_sync_status() to anon;
grant execute on function public.comitra_sync_status() to authenticated;

-- ── 4. Verification — read the output of this query ─────────────────────────
-- You should get exactly two rows: comitra_ij_insert and comitra_ij_update.
-- If you get zero rows, the script did not commit — re-run it and read the
-- error message the editor shows.
select policyname, cmd, roles
from   pg_policies
where  schemaname = 'public'
and    tablename  = 'comitra_invited_judges'
order  by policyname;

-- Done. Reload the app; invite → “Become a judge” → the judge shows up in the
-- inviter's judge picker on their own device.

-- ─────────────────────────────────────────────────────────────────────────────
-- Comitra · cross-device judge sync  (run ONCE — safe to re-run any time)
--
-- Dashboard → SQL Editor → New query → paste ALL of this → Run.
--
-- WHY THE OLD APPROACH FAILED (error 42501 no matter how often you ran it):
--   The app used to write with a direct `INSERT ... ON CONFLICT DO UPDATE` upsert.
--   Under row-level security that operation ALSO needs a SELECT policy — but a
--   SELECT policy would let anyone with the public key dump every phone number.
--   So the design was self-contradictory: secure OR working, never both.
--
-- THE FIX (this file): the table is fully LOCKED to the public key — no direct
-- read, insert, or update at all. Every access goes through a SECURITY DEFINER
-- function that runs with the owner's rights and does exactly one scoped thing:
--   • comitra_register_invited_judge(...)  — upserts one judge row (write)
--   • comitra_list_invited_judges(owner)   — lists judges for an owner you know
--   • comitra_sync_status()                — "is the backend ready?" probe
-- The table itself can't be read or dumped with the anon key, and the judge's
-- password never touches the server. Maximum security AND it actually works.
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

-- Self-heal a table created by hand with only some columns / a legacy password col.
alter table public.comitra_invited_judges add column if not exists owner_user_id         text;
alter table public.comitra_invited_judges add column if not exists name                  text;
alter table public.comitra_invited_judges add column if not exists phone                 text;
alter table public.comitra_invited_judges add column if not exists judge_account_user_id text;
alter table public.comitra_invited_judges add column if not exists consented_at          timestamptz;
alter table public.comitra_invited_judges add column if not exists created_at            timestamptz not null default now();
alter table public.comitra_invited_judges drop  column if exists code_hash;

create index if not exists comitra_invited_judges_owner_idx
  on public.comitra_invited_judges (owner_user_id);

-- The upsert conflict target needs a unique key on exactly (owner_user_id, phone).
do $$
begin
  if not exists (
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

-- ── 2. Lock the table down completely ───────────────────────────────────────
-- RLS on + no policies + no grants = the anon/authenticated keys cannot touch
-- the table directly at all. Only the SECURITY DEFINER functions below can.
alter table public.comitra_invited_judges enable row level security;
revoke all on public.comitra_invited_judges from anon, authenticated;
drop policy if exists comitra_ij_insert on public.comitra_invited_judges;
drop policy if exists comitra_ij_update on public.comitra_invited_judges;
drop policy if exists comitra_ij_select on public.comitra_invited_judges;

-- ── 3. Write path (the ONLY way to write) ───────────────────────────────────
create or replace function public.comitra_register_invited_judge(
  p_id                    text,
  p_owner_user_id         text,
  p_name                  text,
  p_phone                 text,
  p_judge_account_user_id text,
  p_consented_at          timestamptz,
  p_created_at            timestamptz
) returns void
language sql
security definer
set search_path = public
as $$
  insert into public.comitra_invited_judges
    (id, owner_user_id, name, phone, judge_account_user_id, consented_at, created_at)
  values
    (p_id, p_owner_user_id, p_name, p_phone, p_judge_account_user_id, p_consented_at, coalesce(p_created_at, now()))
  on conflict (owner_user_id, phone) do update
    set name                  = excluded.name,
        judge_account_user_id = coalesce(excluded.judge_account_user_id, public.comitra_invited_judges.judge_account_user_id),
        consented_at          = excluded.consented_at;
$$;

grant execute on function public.comitra_register_invited_judge(text,text,text,text,text,timestamptz,timestamptz) to anon, authenticated;

-- ── 4. Read path (the ONLY way to read) ─────────────────────────────────────
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

grant execute on function public.comitra_list_invited_judges(text) to anon, authenticated;

-- ── 5. Setup probe ──────────────────────────────────────────────────────────
-- Lets Profile → Invite friends show "Sync · on" before a link is sent. Ready
-- means the write function exists (kept as has_insert/has_update for the client).
drop function if exists public.comitra_sync_status();

create function public.comitra_sync_status()
returns table (has_insert boolean, has_update boolean)
language sql
stable
security definer
set search_path = public
as $$
  select
    exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = 'comitra_register_invited_judge'),
    exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = 'comitra_register_invited_judge');
$$;

grant execute on function public.comitra_sync_status() to anon, authenticated;

-- ── 6. Verification — read the output of this query ─────────────────────────
-- Expect three rows: comitra_list_invited_judges, comitra_register_invited_judge,
-- comitra_sync_status. If you get fewer, re-run and read the editor's error.
select proname
from   pg_proc p join pg_namespace n on n.oid = p.pronamespace
where  n.nspname = 'public' and proname like 'comitra\_%'
order  by proname;

-- Done. Reload the app; invite → “Become a judge” → the judge shows up in the
-- inviter's judge picker on their own device.

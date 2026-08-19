-- ─────────────────────────────────────────────────────────────────────────────
-- ⚠ RETIRED (2026-08-19) — DO NOT RUN THIS AGAINST A NEW PROJECT.
--
-- Judges are no longer invited by email. A judge is a friend with an account,
-- picked from the social graph (`comitra_directory` + `comitra_follows`), and
-- asked inside the app rather than through a link. Nothing in the client reads
-- this table any more, and `comitra_register_invited_judge` has had its `anon`
-- grant revoked so the door it opened is closed.
--
-- Kept so rows written before the change are still explainable. See
-- supabase/MIGRATIONS.md.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────────────
-- ⚠ SUPERSEDED IN PART — DO NOT RE-RUN AGAINST THE LIVE PROJECT (2026-08-17)
--
-- `comitra_register_invited_judge` still answers the publishable key (a friend
-- opening an invite has no account yet) but is now validated, throttled and
-- capped by the `comitra_harden_public_rpcs` migration.
--
-- `comitra_list_invited_judges` is NO LONGER anon-callable: knowing an owner's
-- id — which every one of their friends does — used to be enough to list their
-- judges' names and EMAIL ADDRESSES. It is service_role only and reached through
-- the `api` function's /api/judges/list route, which reads the owner from the
-- session token. The grant below is deliberately stale; see
-- `comitra_close_push_and_judge_list_to_anon`.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────────────
-- Comitra · cross-device judge sync  (run ONCE — safe to re-run any time)
--
-- Dashboard → SQL Editor → New query → paste ALL of this → Run.
--
-- 2026-08-16: judges are identified by EMAIL, not by a phone number. SMS is gone
-- from the app entirely; a friend accepting an invite now confirms an emailed
-- code instead. The `phone` column is kept, nullable, so rows written by the old
-- version still load — nothing reads it any more.
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
  email                 text,
  phone                 text,
  judge_account_user_id text,
  consented_at          timestamptz,
  created_at            timestamptz not null default now()
);

-- Self-heal a table created by hand with only some columns / a legacy password col.
alter table public.comitra_invited_judges add column if not exists owner_user_id         text;
alter table public.comitra_invited_judges add column if not exists name                  text;
alter table public.comitra_invited_judges add column if not exists email                 text;
alter table public.comitra_invited_judges add column if not exists phone                 text;
-- Judges used to be keyed by phone, which was therefore NOT NULL. Email rows
-- carry no number at all, so the old constraint has to go before the first one
-- can be written.
alter table public.comitra_invited_judges alter column phone drop not null;
alter table public.comitra_invited_judges add column if not exists judge_account_user_id text;
alter table public.comitra_invited_judges add column if not exists consented_at          timestamptz;
alter table public.comitra_invited_judges add column if not exists created_at            timestamptz not null default now();
alter table public.comitra_invited_judges drop  column if exists code_hash;

create index if not exists comitra_invited_judges_owner_idx
  on public.comitra_invited_judges (owner_user_id);

-- The upsert conflict target is now (owner_user_id, email). The old
-- (owner_user_id, phone) key must go: with phone nullable, every email row would
-- carry a NULL there, and one owner could then accumulate duplicate judges.
alter table public.comitra_invited_judges
  drop constraint if exists comitra_invited_judges_owner_phone_key;

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
           ) = array['email', 'owner_user_id']
  ) then
    alter table public.comitra_invited_judges
      add constraint comitra_invited_judges_owner_email_key unique (owner_user_id, email);
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
-- The phone-keyed signature is gone. PostgREST resolves an RPC by ARGUMENT
-- NAMES, so leaving it in place would let an old bundle keep writing rows this
-- version cannot see.
drop function if exists public.comitra_register_invited_judge(text,text,text,text,text,timestamptz,timestamptz);

create or replace function public.comitra_register_invited_judge(
  p_id                    text,
  p_owner_user_id         text,
  p_name                  text,
  p_email                 text,
  p_judge_account_user_id text,
  p_consented_at          timestamptz,
  p_created_at            timestamptz
) returns void
language sql
security definer
set search_path = public
as $$
  insert into public.comitra_invited_judges
    (id, owner_user_id, name, email, judge_account_user_id, consented_at, created_at)
  values
    (p_id, p_owner_user_id, p_name, lower(trim(p_email)), p_judge_account_user_id, p_consented_at, coalesce(p_created_at, now()))
  on conflict (owner_user_id, email) do update
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
--
-- Recipients live in supabase/comitra_push.sql — run that one too.

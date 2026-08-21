-- ─────────────────────────────────────────────────────────────────────────────
-- ⚠ SUPERSEDED — DO NOT RE-RUN AGAINST THE LIVE PROJECT (2026-08-17)
--
-- Both functions still answer the publishable key, and must: a judge opening a
-- link has no account, so the link IS the credential. But the live bodies were
-- replaced by the `comitra_harden_public_rpcs` migration, which added what was
-- missing here — argument validation, a 3 MB ceiling on `data`, a per-IP and
-- per-owner rate limit on creating rows, and a 200-goal cap per owner. Without
-- those, the key inside the APK is an unmetered write endpoint into a 500 MB
-- database. Re-running the statements below would restore the unlimited version.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────────────
-- Pactista · cross-device GOALS  (run ONCE — safe to re-run any time)
--
-- Dashboard → SQL Editor → New query → paste ALL of this → Run.
-- Run `comitra_invited_judges.sql` too; they are independent.
--
-- WHY THIS EXISTS: a goal is created on its owner's phone and kept in that
-- phone's storage. Their judge opens the link on a DIFFERENT phone, where that
-- goal has never existed — which is why the judge link used to say "this goal
-- couldn't be found on this device". This table is the one place both phones
-- can meet.
--
-- WHAT IS ACTUALLY STORED: `data` is an allow-listed projection built by
-- src/lib/goalShare.ts. The goal's TITLE and DETAILS are not in it and never
-- leave the owner's device — not to the judge, not to this table. A judge is
-- asked about "goal #4", which is the whole point of the product. Recipients'
-- names and phone numbers are likewise never uploaded.
--
-- HOW ACCESS IS GATED: by capability, not by identity. Reads need the goal id
-- AND a token that only exists inside the link the owner chose to send; writes
-- additionally have to match the judge token already on the row. There is on
-- purpose NO "list this owner's goals" function: user ids travel inside invite
-- links, and such a call would turn one leaked link into a list of everything
-- that person is working on.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Table ────────────────────────────────────────────────────────────────
create table if not exists public.comitra_goals (
  id            text primary key,
  owner_user_id text        not null,
  -- Capability tokens from the judge link. Not secrets in the crypto sense:
  -- random uuids that only the owner and whoever they sent the link to have.
  judge_token   text        not null,
  share_token   text,
  data          jsonb       not null,
  updated_at    timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

-- Self-heal a table created by hand with only some columns.
alter table public.comitra_goals add column if not exists owner_user_id text;
alter table public.comitra_goals add column if not exists judge_token   text;
alter table public.comitra_goals add column if not exists share_token   text;
alter table public.comitra_goals add column if not exists data          jsonb;
alter table public.comitra_goals add column if not exists updated_at    timestamptz not null default now();
alter table public.comitra_goals add column if not exists created_at    timestamptz not null default now();

create index if not exists comitra_goals_owner_idx on public.comitra_goals (owner_user_id);

-- ── 2. Lock the table down completely ───────────────────────────────────────
-- RLS on + no policies + no grants = the public key cannot read, insert or
-- update this table directly. Only the functions below can, and each one does
-- exactly one scoped thing.
alter table public.comitra_goals enable row level security;
revoke all on public.comitra_goals from anon, authenticated;

-- ── 3. Write path (the ONLY way to write) ───────────────────────────────────
-- First write creates the row and fixes its owner + judge token. Later writes
-- must present the SAME judge token and owner, so holding a link lets you update
-- that one goal and nothing else. A mismatch updates zero rows: silent on
-- purpose, since the caller is not entitled to know the row is there.
create or replace function public.comitra_put_goal(
  p_id            text,
  p_owner_user_id text,
  p_judge_token   text,
  p_share_token   text,
  p_data          jsonb
) returns void
language sql
security definer
set search_path = public
as $$
  insert into public.comitra_goals (id, owner_user_id, judge_token, share_token, data)
  values (p_id, p_owner_user_id, p_judge_token, p_share_token, p_data)
  on conflict (id) do update
    set data        = excluded.data,
        share_token = coalesce(excluded.share_token, public.comitra_goals.share_token),
        updated_at  = now()
    where public.comitra_goals.judge_token   = p_judge_token
      and public.comitra_goals.owner_user_id = p_owner_user_id;
$$;

grant execute on function public.comitra_put_goal(text,text,text,text,jsonb) to anon, authenticated;

-- ── 4. Read path (the ONLY way to read) ─────────────────────────────────────
-- Needs the id AND a token from the link. Ids are uuids, so nothing here can be
-- enumerated or listed.
drop function if exists public.comitra_get_goal(text, text);

create function public.comitra_get_goal(p_id text, p_token text)
returns table (data jsonb, updated_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select g.data, g.updated_at
  from   public.comitra_goals g
  where  g.id = p_id
  and    (g.judge_token = p_token or g.share_token = p_token);
$$;

grant execute on function public.comitra_get_goal(text, text) to anon, authenticated;

-- ── 5. Setup probe ──────────────────────────────────────────────────────────
drop function if exists public.comitra_goals_status();

create function public.comitra_goals_status()
returns table (ready boolean)
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'comitra_put_goal'
  );
$$;

grant execute on function public.comitra_goals_status() to anon, authenticated;

-- ── 6. Verification — read the output of this query ─────────────────────────
-- Expect exactly three rows: comitra_get_goal, comitra_goals_status,
-- comitra_put_goal. Fewer means something above failed; re-run and read the
-- editor's error message.
select proname
from   pg_proc p join pg_namespace n on n.oid = p.pronamespace
where  n.nspname = 'public' and proname in ('comitra_put_goal', 'comitra_get_goal', 'comitra_goals_status')
order  by proname;

-- Done. Reload the app, set a goal with a judge, and open its judge link on
-- another phone: the goal opens there, and the decision comes back.

-- ─────────────────────────────────────────────────────────────────────────────
-- Comitra · in-app push  (run ONCE — safe to re-run any time)
--
-- Dashboard → SQL Editor → New query → paste ALL of this → Run.
--
-- WHAT THIS REPLACES: recipients used to be texted through Twilio. They are now
-- people the user already follows (and who follow back), so a message can be
-- delivered to their ACCOUNT instead of to a phone number. Nothing here holds a
-- phone number or an email address — only user ids the app already knows.
--
-- TWO TABLES:
--   • comitra_push_devices — which devices an account has opened the app on, and
--     when. This is what answers "do they even still have the app?", so the
--     sender is told the truth instead of a message quietly going nowhere.
--   • comitra_push_inbox   — the messages themselves. A row survives an
--     uninstall: it is delivered whenever that person next opens the app, and
--     the sender's own screen says so meanwhile.
--
-- Same security shape as the rest of the project: RLS on, no policies, no
-- grants, every access through a scoped SECURITY DEFINER function. The tables
-- cannot be read or dumped with the publishable key.
--
-- PRIVACY: `payload` carries the sender's name, a goal NUMBER and a tone. It
-- must never carry a goal's title or description — same rule as everywhere else.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Tables ───────────────────────────────────────────────────────────────
create table if not exists public.comitra_push_devices (
  user_id      text        not null,
  device_id    text        not null,
  platform     text        not null default 'web',
  last_seen_at timestamptz not null default now(),
  primary key (user_id, device_id)
);

create index if not exists comitra_push_devices_user_idx
  on public.comitra_push_devices (user_id, last_seen_at desc);

create table if not exists public.comitra_push_inbox (
  id           text primary key,
  to_user_id   text        not null,
  from_user_id text,
  kind         text        not null,
  payload      jsonb       not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  -- Set the first time the recipient's app actually pulled it.
  delivered_at timestamptz,
  read_at      timestamptz
);

create index if not exists comitra_push_inbox_to_idx
  on public.comitra_push_inbox (to_user_id, created_at desc);

-- ── 2. Lock both tables down completely ─────────────────────────────────────
alter table public.comitra_push_devices enable row level security;
alter table public.comitra_push_inbox   enable row level security;
revoke all on public.comitra_push_devices from anon, authenticated;
revoke all on public.comitra_push_inbox   from anon, authenticated;

-- ── 3. Device registry ──────────────────────────────────────────────────────
-- Called on every app open. `platform` is 'android' | 'ios' | 'web'.
create or replace function public.comitra_push_touch_device(
  p_user_id   text,
  p_device_id text,
  p_platform  text
) returns void
language sql
security definer
set search_path = public
as $$
  insert into public.comitra_push_devices (user_id, device_id, platform, last_seen_at)
  values (p_user_id, p_device_id, coalesce(nullif(p_platform, ''), 'web'), now())
  on conflict (user_id, device_id) do update
    set platform     = excluded.platform,
        last_seen_at = now();
$$;

grant execute on function public.comitra_push_touch_device(text,text,text) to anon, authenticated;

-- Has this person opened the app on any device inside the window? The sender
-- asks BEFORE promising a delivery, so "they no longer have the app" can be
-- shown as what it is instead of as a message that was sent.
create or replace function public.comitra_push_reachable(
  p_user_id text,
  p_days    int
) returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from   public.comitra_push_devices
    where  user_id = p_user_id
    and    last_seen_at > now() - make_interval(days => greatest(coalesce(p_days, 30), 1))
  );
$$;

grant execute on function public.comitra_push_reachable(text,int) to anon, authenticated;

-- ── 4. Send ─────────────────────────────────────────────────────────────────
-- Idempotent on the caller's id: re-running a dispatch cannot double-notify.
create or replace function public.comitra_push_send(
  p_id           text,
  p_to_user_id   text,
  p_from_user_id text,
  p_kind         text,
  p_payload      jsonb
) returns void
language sql
security definer
set search_path = public
as $$
  insert into public.comitra_push_inbox (id, to_user_id, from_user_id, kind, payload)
  values (p_id, p_to_user_id, p_from_user_id, p_kind, coalesce(p_payload, '{}'::jsonb))
  on conflict (id) do nothing;
$$;

grant execute on function public.comitra_push_send(text,text,text,text,jsonb) to anon, authenticated;

-- ── 5. Pull ─────────────────────────────────────────────────────────────────
-- Everything still unread for one account, newest first, stamping delivery on
-- the way out. Capped so a long absence cannot return an unbounded page.
create or replace function public.comitra_push_pull(p_user_id text)
returns setof public.comitra_push_inbox
language sql
volatile
security definer
set search_path = public
as $$
  with picked as (
    select id
    from   public.comitra_push_inbox
    where  to_user_id = p_user_id
    and    read_at is null
    order  by created_at desc
    limit  50
  )
  update public.comitra_push_inbox i
     set delivered_at = coalesce(i.delivered_at, now())
    from picked
   where i.id = picked.id
  returning i.*;
$$;

grant execute on function public.comitra_push_pull(text) to anon, authenticated;

create or replace function public.comitra_push_mark_read(p_id text, p_user_id text)
returns void
language sql
volatile
security definer
set search_path = public
as $$
  update public.comitra_push_inbox
     set read_at = coalesce(read_at, now())
   where id = p_id and to_user_id = p_user_id;
$$;

grant execute on function public.comitra_push_mark_read(text,text) to anon, authenticated;

-- ── 6. Setup probe ──────────────────────────────────────────────────────────
create or replace function public.comitra_push_status()
returns table (ready boolean)
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'comitra_push_send'
  );
$$;

grant execute on function public.comitra_push_status() to anon, authenticated;

-- ── 7. Verification — expect five comitra_push_* rows ───────────────────────
select proname
from   pg_proc p join pg_namespace n on n.oid = p.pronamespace
where  n.nspname = 'public' and proname like 'comitra\_push\_%'
order  by proname;

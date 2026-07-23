-- ─────────────────────────────────────────────────────────────────────────────
-- Comitra · cross-device judge sync  (run ONCE)
--
-- Dashboard → SQL Editor → New query → paste all of this → Run.
-- No secret ever leaves your dashboard, which is why this is the method chosen
-- for maximum security. Safe to re-run (idempotent).
--
-- Security model:
--   • RLS is ON. A visitor (anon key, which ships in the app) may only INSERT/
--     UPDATE their own judge row — they CANNOT read the table directly.
--   • Reads go through a SECURITY DEFINER function that requires the owner id, so
--     nobody can dump every phone number; you can only list judges for an owner
--     id you already know.
--   • The judge's PASSWORD is never stored here (not even hashed). It stays on the
--     judge's own device. This table only holds name + phone so the inviter can
--     see and pick the judge.
-- ─────────────────────────────────────────────────────────────────────────────

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

-- Drop a legacy password column if an earlier version of this file created it.
alter table public.comitra_invited_judges drop column if exists code_hash;

create index if not exists comitra_invited_judges_owner_idx
  on public.comitra_invited_judges (owner_user_id);

-- Self-heal: the upsert (INSERT ... ON CONFLICT (owner_user_id, phone)) needs a
-- unique key on those columns. If the table was created without it (e.g. via the
-- Table Editor UI), add it now.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.comitra_invited_judges'::regclass and contype = 'u'
  ) then
    alter table public.comitra_invited_judges
      add constraint comitra_invited_judges_owner_phone_key unique (owner_user_id, phone);
  end if;
end $$;

alter table public.comitra_invited_judges enable row level security;

-- A judge (anonymous visitor) may register / update their own row via the invite
-- page. No SELECT grant → the table itself can't be read with the anon key.
grant insert, update on public.comitra_invited_judges to anon;

drop policy if exists comitra_ij_insert on public.comitra_invited_judges;
create policy comitra_ij_insert on public.comitra_invited_judges
  for insert to anon with check (true);

drop policy if exists comitra_ij_update on public.comitra_invited_judges;
create policy comitra_ij_update on public.comitra_invited_judges
  for update to anon using (true) with check (true);

-- Read path: the ONLY way to read rows. Requires the owner id.
create or replace function public.comitra_list_invited_judges(p_owner text)
returns setof public.comitra_invited_judges
language sql
stable
security definer
set search_path = public
as $$
  select * from public.comitra_invited_judges where owner_user_id = p_owner;
$$;

grant execute on function public.comitra_list_invited_judges(text) to anon;

-- Done. Reload the app; invite → become-a-judge → picker now works across devices.

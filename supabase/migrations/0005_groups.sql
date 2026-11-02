create table if not exists public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  visibility text not null default 'private' check (visibility in ('public', 'private')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.group_memberships (
  group_id uuid not null references public.groups(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  is_group_admin boolean not null default false,
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

alter table public.side_bets add column if not exists group_id uuid references public.groups(id) on delete set null;

create index if not exists group_memberships_user_id_idx on public.group_memberships(user_id);
create index if not exists group_memberships_status_idx on public.group_memberships(status);
create index if not exists side_bets_group_id_idx on public.side_bets(group_id);

alter table public.groups enable row level security;
alter table public.group_memberships enable row level security;

drop policy if exists "Authenticated users can read groups" on public.groups;
create policy "Authenticated users can read groups"
on public.groups
for select
to authenticated
using (true);

drop policy if exists "Authenticated users can read group memberships" on public.group_memberships;
create policy "Authenticated users can read group memberships"
on public.group_memberships
for select
to authenticated
using (true);

drop trigger if exists groups_touch_updated_at on public.groups;
create trigger groups_touch_updated_at
before update on public.groups
for each row execute function public.touch_updated_at();

drop trigger if exists group_memberships_touch_updated_at on public.group_memberships;
create trigger group_memberships_touch_updated_at
before update on public.group_memberships
for each row execute function public.touch_updated_at();

insert into public.groups (name, visibility)
values ('Station Alpha', 'private')
on conflict (name) do update set visibility = excluded.visibility;

update public.side_bets
set group_id = (select id from public.groups where name = 'Station Alpha')
where group_id is null;

insert into public.group_memberships (group_id, user_id, status, is_group_admin, reviewed_at)
select station_alpha.id, profiles.id, 'approved', exists(select 1 from public.admin_users where admin_users.user_id = profiles.id), now()
from public.profiles
cross join (select id from public.groups where name = 'Station Alpha') station_alpha
on conflict (group_id, user_id) do nothing;

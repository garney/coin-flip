create table if not exists public.credit_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  amount_credits numeric(12, 2) not null check (amount_credits > 0),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  request_reason text not null,
  admin_note text,
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists credit_requests_user_id_idx on public.credit_requests(user_id);
create index if not exists credit_requests_status_idx on public.credit_requests(status);
create index if not exists credit_requests_created_at_idx on public.credit_requests(created_at desc);

alter table public.credit_requests enable row level security;

create or replace function public.is_admin(check_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.admin_users
    where user_id = check_user_id
  );
$$;

drop policy if exists "Users can read own credit requests" on public.credit_requests;
create policy "Users can read own credit requests"
on public.credit_requests
for select
using (auth.uid() = user_id);

drop policy if exists "Users can create own credit requests" on public.credit_requests;
create policy "Users can create own credit requests"
on public.credit_requests
for insert
with check (auth.uid() = user_id);

drop policy if exists "Admins can manage credit requests" on public.credit_requests;
create policy "Admins can manage credit requests"
on public.credit_requests
for all
using (public.is_admin(auth.uid()))
with check (public.is_admin(auth.uid()));

drop trigger if exists credit_requests_touch_updated_at on public.credit_requests;
create trigger credit_requests_touch_updated_at
before update on public.credit_requests
for each row execute function public.touch_updated_at();

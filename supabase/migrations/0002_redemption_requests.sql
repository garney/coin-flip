create table public.redemption_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  amount_credits numeric(12, 2) not null check (amount_credits > 0),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  claim_details text not null,
  admin_note text,
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index redemption_requests_user_id_created_at_idx
  on public.redemption_requests(user_id, created_at desc);

create index redemption_requests_status_created_at_idx
  on public.redemption_requests(status, created_at desc);

alter table public.redemption_requests enable row level security;

create policy "users can read their own redemption requests"
  on public.redemption_requests for select to authenticated using (auth.uid() = user_id);

create trigger redemption_requests_touch_updated_at
  before update on public.redemption_requests
  for each row execute function public.touch_updated_at();

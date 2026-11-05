create table if not exists public.blackjack_tables (
  id uuid primary key,
  group_id uuid not null references public.groups(id) on delete cascade,
  state jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.blackjack_tables enable row level security;

revoke all on table public.blackjack_tables from anon, authenticated;

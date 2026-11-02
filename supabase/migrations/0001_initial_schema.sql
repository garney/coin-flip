create extension if not exists "pgcrypto";

create type public.side_bet_status as enum ('draft', 'open', 'locked', 'settled', 'cancelled');
create type public.credit_transaction_kind as enum ('deposit', 'withdrawal', 'adjustment', 'buy_in', 'payout', 'fee');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  email text,
  avatar_url text,
  credits_balance numeric(12, 2) not null default 0 check (credits_balance >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.admin_users (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.side_bets (
  id uuid primary key default gen_random_uuid(),
  manager_id uuid not null references public.profiles(id) on delete restrict,
  title text not null,
  description text not null,
  source_url text,
  buy_in_credits numeric(12, 2) not null check (buy_in_credits > 0),
  house_fee_percent numeric(5, 2) not null default 0 check (house_fee_percent >= 0 and house_fee_percent <= 100),
  status public.side_bet_status not null default 'open',
  starts_at timestamptz not null,
  closes_at timestamptz not null,
  settles_at timestamptz,
  options jsonb not null default '[]'::jsonb,
  winning_option_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint side_bets_closes_after_starts check (closes_at > starts_at)
);

create table public.bet_entries (
  id uuid primary key default gen_random_uuid(),
  side_bet_id uuid not null references public.side_bets(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  option_id text not null,
  stake_credits numeric(12, 2) not null check (stake_credits > 0),
  created_at timestamptz not null default now(),
  unique (side_bet_id, user_id)
);

create table public.credit_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  amount_credits numeric(12, 2) not null,
  kind public.credit_transaction_kind not null,
  description text not null,
  side_bet_id uuid references public.side_bets(id) on delete set null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index side_bets_status_idx on public.side_bets(status);
create index side_bets_closes_at_idx on public.side_bets(closes_at);
create index bet_entries_side_bet_id_idx on public.bet_entries(side_bet_id);
create index credit_transactions_user_id_created_at_idx on public.credit_transactions(user_id, created_at desc);

alter table public.profiles enable row level security;
alter table public.admin_users enable row level security;
alter table public.side_bets enable row level security;
alter table public.bet_entries enable row level security;
alter table public.credit_transactions enable row level security;

create policy "profiles are readable by authenticated users"
  on public.profiles for select to authenticated using (true);

create policy "users can update their own profile"
  on public.profiles for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);

create policy "side bets are readable by authenticated users"
  on public.side_bets for select to authenticated using (true);

create policy "entries are readable by authenticated users"
  on public.bet_entries for select to authenticated using (true);

create policy "users can read their own transactions"
  on public.credit_transactions for select to authenticated using (auth.uid() = user_id);

create or replace function public.touch_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.touch_updated_at();

create trigger side_bets_touch_updated_at
  before update on public.side_bets
  for each row execute function public.touch_updated_at();

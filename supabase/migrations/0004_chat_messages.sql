create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  room text not null default 'general' check (room in ('general', 'side_bet')),
  side_bet_id uuid references public.side_bets(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  body text not null check (char_length(trim(body)) > 0 and char_length(body) <= 1000),
  created_at timestamptz not null default now(),
  constraint chat_messages_side_bet_room_check
    check ((room = 'general' and side_bet_id is null) or (room = 'side_bet' and side_bet_id is not null))
);

create index if not exists chat_messages_general_idx on public.chat_messages(created_at desc) where room = 'general';
create index if not exists chat_messages_side_bet_idx on public.chat_messages(side_bet_id, created_at desc) where room = 'side_bet';
create index if not exists chat_messages_user_id_idx on public.chat_messages(user_id);

alter table public.chat_messages enable row level security;

drop policy if exists "Authenticated users can read chat messages" on public.chat_messages;
create policy "Authenticated users can read chat messages"
on public.chat_messages
for select
to authenticated
using (true);

drop policy if exists "Users can create own chat messages" on public.chat_messages;
create policy "Users can create own chat messages"
on public.chat_messages
for insert
to authenticated
with check (auth.uid() = user_id);

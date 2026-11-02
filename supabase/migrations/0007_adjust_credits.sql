create or replace function public.adjust_credits(p_user_id uuid, p_delta numeric)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  next_balance numeric;
begin
  update public.profiles
  set credits_balance = credits_balance + p_delta
  where id = p_user_id
    and credits_balance + p_delta >= 0
  returning credits_balance into next_balance;

  if next_balance is null then
    raise exception 'Not enough credits';
  end if;

  return next_balance;
end;
$$;

revoke all on function public.adjust_credits(uuid, numeric) from public;
grant execute on function public.adjust_credits(uuid, numeric) to service_role;

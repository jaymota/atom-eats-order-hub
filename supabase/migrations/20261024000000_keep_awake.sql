-- A one-row "heartbeat" table. A GitHub Actions job calls ping() every 3 days,
-- which writes to the database so the free Supabase project never goes to sleep.
create table if not exists public.heartbeat (
  id int primary key default 1 check (id = 1),
  last_ping timestamptz not null default now()
);

alter table public.heartbeat enable row level security;
-- No policies: nobody can read or write the table directly.

create or replace function public.ping()
returns timestamptz
language sql
security definer
set search_path = public
as $$
  insert into public.heartbeat (id, last_ping) values (1, now())
  on conflict (id) do update set last_ping = excluded.last_ping
  returning last_ping;
$$;

revoke all on function public.ping() from public;
grant execute on function public.ping() to anon, authenticated;

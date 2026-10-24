-- Lets admins see whose login is locked after wrong PINs (without seeing anything else about PINs).
create or replace function public.locked_people()
returns table (person_id uuid, locked_until timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select s.person_id, s.locked_until
  from public.pin_security s
  where public.is_admin() and s.locked_until > now();
$$;

revoke all on function public.locked_people() from public, anon;
grant execute on function public.locked_people() to authenticated;

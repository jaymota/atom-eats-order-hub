-- Easy Ecom Sync: remember when an order went into a downloaded upload file, so the next file leaves it out
-- until someone either ticks ✓ Uploaded or puts it back (the upload may have failed).
alter table public.orders add column if not exists ee_file_at timestamptz;

create or replace function public.mark_ee_file(p_ids uuid[], p_undo boolean default false)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
begin
  if not public.my_role_in(array['ops', 'accounts']) then raise exception 'Only ops, accounts and admins can do this.'; end if;
  update public.orders set ee_file_at = case when p_undo then null else now() end
  where id = any (p_ids) and ee_uploaded_at is null;
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function public.mark_ee_file(uuid[], boolean) from public, anon;
grant execute on function public.mark_ee_file(uuid[], boolean) to authenticated;

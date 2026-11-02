-- Manager: one level below admin (the accounts and marketing logins). Sees everything and does all
-- the order, product and customer work, but can't manage the team or PINs (the team function only
-- lets admins in) and can't merge customers.
alter table public.people drop constraint people_role_check;
alter table public.people add constraint people_role_check check (role in ('super_admin', 'admin', 'manager', 'accounts', 'ops', 'sales'));

-- "Admin work": everything except the team and merging.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.my_role() in ('super_admin', 'admin', 'manager'), false);
$$;

-- Real admins only.
create or replace function public.is_full_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.my_role() in ('super_admin', 'admin'), false);
$$;
revoke all on function public.is_full_admin() from public, anon;
grant execute on function public.is_full_admin() to authenticated;

-- Every stage step (plan, invoice, dispatch, hold, undo).
create or replace function public.my_role_in(p_roles text[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.my_role() = any (p_roles || array['super_admin', 'admin', 'manager']), false);
$$;
revoke all on function public.my_role_in(text[]) from public, anon;

create or replace function public.set_tally_name(p_sku text, p_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := nullif(trim(p_name), '');
begin
  if coalesce(public.my_role(), '') not in ('super_admin', 'admin', 'manager', 'accounts') then
    raise exception 'Only admins and accounts can change Tally names.';
  end if;
  update public.products
    set tally_name = v_name, tally_status = case when v_name is null then 'none' else 'confirmed' end, updated_at = now()
    where sku = p_sku;
  if not found then raise exception 'Product % not found.', p_sku; end if;
  if v_name is not null then
    insert into public.product_aliases (sku, alias, alias_norm, kind, status, source, created_by)
    values (p_sku, v_name, public.norm(v_name), 'tally', 'confirmed', 'confirmed in the Hub', auth.uid())
    on conflict (alias_norm, kind, coalesce(customer_id, '00000000-0000-0000-0000-000000000000'::uuid))
    do update set sku = excluded.sku, status = 'confirmed';
  end if;
  perform public.log_activity('tally_name_set',
    public.my_name() || ' set the Tally name of ' || p_sku || ' to “' || coalesce(v_name, 'none') || '”', 'product', p_sku);
end;
$$;


-- Merging deletes a customer: real admins only. The old function stays as the worker.
alter function public.merge_customers(uuid, uuid) rename to merge_customers_core;
revoke all on function public.merge_customers_core(uuid, uuid) from public, anon, authenticated;

create or replace function public.merge_customers(p_keep uuid, p_drop uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_full_admin() then raise exception 'Only admins can merge customers.'; end if;
  perform public.merge_customers_core(p_keep, p_drop);
end;
$$;
revoke all on function public.merge_customers(uuid, uuid) from public, anon;
grant execute on function public.merge_customers(uuid, uuid) to authenticated;

-- The two shared logins move down to manager.
update public.people set role = 'manager' where username in ('accounts', 'marketing') and role = 'admin';

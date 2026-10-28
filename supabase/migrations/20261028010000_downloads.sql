-- Phase 5: downloads for Easy Ecom, and "uploaded to Easy Ecom" marking so nothing goes up twice.

-- Easy Ecom's own customer code (Masters → Customer Master), needed by its wholesale bulk upload.
alter table public.customers add column ee_customer_code text;
alter table public.orders add column ee_uploaded_by uuid references public.people (id) on delete set null;

create or replace function public.set_ee_customer_code(p_customer uuid, p_code text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.customers;
  v text := nullif(trim(p_code), '');
begin
  if not public.my_role_in(array['ops', 'accounts']) then raise exception 'Only ops, accounts and admins can change this.'; end if;
  select * into c from public.customers where id = p_customer for update;
  if not found then raise exception 'Customer not found.'; end if;
  if v is not null and exists (select 1 from public.customers where lower(ee_customer_code) = lower(v) and id <> p_customer and merged_into is null) then
    raise exception 'Another customer already has the Easy Ecom code %.', v;
  end if;
  update public.customers set ee_customer_code = v, in_easy_ecom = in_easy_ecom or v is not null, updated_at = now() where id = p_customer;
  perform public.log_activity('customer_updated', public.my_name() || ' set the Easy Ecom code of ' || c.name || ' to ' || coalesce(v, '(none)'), 'customer', p_customer::text);
end;
$$;

-- Mark orders as uploaded to Easy Ecom (or undo). Their customers now exist in Easy Ecom too.
create or replace function public.mark_ee_uploaded(p_ids uuid[], p_undo boolean default false)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  o public.orders;
  n int := 0;
begin
  if not public.my_role_in(array['ops', 'accounts']) then raise exception 'Only ops, accounts and admins can do this.'; end if;
  for o in select * from public.orders where id = any (p_ids) for update loop
    if p_undo then
      if o.ee_uploaded_at is null then continue; end if;
      update public.orders set ee_uploaded_at = null, ee_uploaded_by = null, updated_at = now() where id = o.id;
      perform public.log_activity('order_ee_undo', public.my_name() || ' marked ' || o.order_no || ' as not uploaded to Easy Ecom', 'order', o.id::text);
    else
      if o.ee_uploaded_at is not null then continue; end if;
      if o.stage = 'cancelled' then raise exception '% is cancelled.', o.order_no; end if;
      update public.orders set ee_uploaded_at = now(), ee_uploaded_by = auth.uid(), updated_at = now() where id = o.id;
      if o.customer_id is not null then update public.customers set in_easy_ecom = true where id = o.customer_id; end if;
      perform public.log_activity('order_ee_uploaded', public.my_name() || ' uploaded ' || o.order_no || ' to Easy Ecom', 'order', o.id::text);
    end if;
    n := n + 1;
  end loop;
  return n;
end;
$$;

revoke all on function public.set_ee_customer_code(uuid, text), public.mark_ee_uploaded(uuid[], boolean) from public, anon;
grant execute on function public.set_ee_customer_code(uuid, text), public.mark_ee_uploaded(uuid[], boolean) to authenticated;

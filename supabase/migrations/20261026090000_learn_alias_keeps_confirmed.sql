-- The order form never repoints a nickname an admin has confirmed; it only adds new ones
-- or updates unconfirmed ones. (Changing a confirmed nickname is done on the Products page.)
create or replace function public.learn_alias(p_sku text, p_alias text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.me_ok() then raise exception 'Please log in again.'; end if;
  if public.norm(p_alias) = '' or length(public.norm(p_alias)) > 80 then return; end if;
  if not exists (select 1 from public.products where sku = p_sku) then return; end if;
  insert into public.product_aliases (sku, alias, alias_norm, kind, status, source, created_by)
  values (p_sku, trim(p_alias), public.norm(p_alias), 'nickname', 'confirmed', 'learned from an order', auth.uid())
  on conflict (alias_norm, kind, coalesce(customer_id, '00000000-0000-0000-0000-000000000000'::uuid))
  do update set
    sku = case when product_aliases.status = 'confirmed' then product_aliases.sku else excluded.sku end,
    status = 'confirmed',
    times_seen = product_aliases.times_seen + case when product_aliases.status <> 'confirmed' or product_aliases.sku = excluded.sku then 1 else 0 end;
end;
$$;

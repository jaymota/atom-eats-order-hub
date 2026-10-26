-- Tally stock item names (from the Tally stock summary), so accounts can pick the exact
-- Tally name for a product instead of typing it.
create table public.tally_items (
  name text primary key
);
alter table public.tally_items enable row level security;
create policy tally_items_read on public.tally_items for select to authenticated using (public.me_ok());
revoke all on public.tally_items from anon;
revoke insert, update, delete, truncate on public.tally_items from authenticated;

-- save_product can now also fix the pack size shown next to a product.
create or replace function public.save_product(p_sku text, p jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  old public.products;
begin
  if not public.is_admin() then raise exception 'Only admins can change products.'; end if;
  select * into old from public.products where sku = p_sku;
  if not found then raise exception 'Product % not found.', p_sku; end if;
  if p ? 'replaced_by' and nullif(trim(p ->> 'replaced_by'), '') is not null
     and not exists (select 1 from public.products where sku = trim(p ->> 'replaced_by')) then
    raise exception 'There is no Easy Ecom SKU called %.', trim(p ->> 'replaced_by');
  end if;
  update public.products set
    is_offline = coalesce((p ->> 'is_offline')::boolean, is_offline),
    is_retail = coalesce((p ->> 'is_retail')::boolean, is_retail),
    size = case when p ? 'size' then nullif(trim(p ->> 'size'), '') else size end,
    hsn = case when p ? 'hsn' then nullif(trim(p ->> 'hsn'), '') else hsn end,
    ean = case when p ? 'ean' then nullif(regexp_replace(p ->> 'ean', '\D', '', 'g'), '') else ean end,
    replaced_by = case when p ? 'replaced_by' then nullif(trim(p ->> 'replaced_by'), '') else replaced_by end,
    notes = case when p ? 'notes' then nullif(trim(p ->> 'notes'), '') else notes end,
    updated_at = now()
  where sku = p_sku;
  if p ? 'ean' and nullif(regexp_replace(p ->> 'ean', '\D', '', 'g'), '') is not null then
    insert into public.product_aliases (sku, alias, alias_norm, kind, status, source, created_by)
    values (p_sku, regexp_replace(p ->> 'ean', '\D', '', 'g'), regexp_replace(p ->> 'ean', '\D', '', 'g'), 'ean', 'confirmed', 'added in the Hub', auth.uid())
    on conflict (alias_norm, kind, coalesce(customer_id, '00000000-0000-0000-0000-000000000000'::uuid)) do update set sku = excluded.sku;
  end if;
  perform public.log_activity('product_updated', public.my_name() || ' changed product ' || p_sku || ' (' || old.name || ')', 'product', p_sku, p);
end;
$$;

-- Adding custom products, fixing MRP / size / GST, and the atomeats.com price check.

create sequence public.custom_sku_seq;

-- What atomeats.com currently sells each product for (checked several times a day).
alter table public.products
  add column site_mrp numeric(10, 2),
  add column site_sku text,
  add column site_checked_at timestamptz;

-- Add a product that isn't in the list (a custom item, a hamper, a new product).
-- Anyone in the team can, so an order is never stuck. If it has no Easy Ecom SKU yet the
-- Hub makes a temporary one (CUSTOM-0001) and flags it: it must be created in Easy Ecom
-- before the evening upload.
create or replace function public.add_product(p jsonb)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sku text := nullif(trim(p ->> 'sku'), '');
  v_name text := nullif(trim(p ->> 'name'), '');
  v_ee boolean := v_sku is not null;
begin
  if not public.me_ok() then raise exception 'Please log in again.'; end if;
  if v_name is null then raise exception 'Please give the product a name.'; end if;
  if nullif(p ->> 'mrp', '') is null then raise exception 'Please give the MRP.'; end if;
  if v_sku is not null and exists (select 1 from public.products where lower(sku) = lower(v_sku)) then
    raise exception 'There is already a product with the SKU %.', v_sku;
  end if;
  if v_sku is null then v_sku := 'CUSTOM-' || lpad(nextval('public.custom_sku_seq')::text, 4, '0'); end if;
  insert into public.products (sku, name, size, mrp, gst_rate, hsn, tally_name, tally_status, ee_type, is_offline, in_easy_ecom, notes)
  values (v_sku, v_name, nullif(trim(p ->> 'size'), ''), (p ->> 'mrp')::numeric, coalesce(nullif(p ->> 'gst_rate', '')::numeric, 5),
          nullif(trim(p ->> 'hsn'), ''), nullif(trim(p ->> 'tally_name'), ''),
          case when nullif(trim(p ->> 'tally_name'), '') is null then 'none' else 'confirmed' end,
          'Custom', true, v_ee, nullif(trim(p ->> 'notes'), ''));
  insert into public.product_aliases (sku, alias, alias_norm, kind, status, source, created_by)
  values (v_sku, v_name, public.norm(v_name), 'ee_name', 'confirmed', 'added in the Hub', auth.uid())
  on conflict do nothing;
  perform public.log_activity('product_added', public.my_name() || ' added the product ' || v_name || ' (' || v_sku || ')'
    || case when v_ee then '' else ' — not in Easy Ecom yet' end, 'product', v_sku);
  return v_sku;
end;
$$;

-- Admins can now also fix the name, MRP, GST rate and Easy Ecom status.
create or replace function public.save_product(p_sku text, p jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  old public.products;
  said text[] := '{}';
begin
  if not public.is_admin() then raise exception 'Only admins can change products.'; end if;
  select * into old from public.products where sku = p_sku;
  if not found then raise exception 'Product % not found.', p_sku; end if;
  if p ? 'replaced_by' and nullif(trim(p ->> 'replaced_by'), '') is not null
     and not exists (select 1 from public.products where sku = trim(p ->> 'replaced_by')) then
    raise exception 'There is no Easy Ecom SKU called %.', trim(p ->> 'replaced_by');
  end if;
  if p ? 'mrp' and nullif(p ->> 'mrp', '')::numeric is distinct from old.mrp then
    said := said || ('MRP ₹' || coalesce(old.mrp::text, '—') || ' → ₹' || (p ->> 'mrp'));
  end if;
  if p ? 'size' and nullif(trim(p ->> 'size'), '') is distinct from old.size then
    said := said || ('size ' || coalesce(old.size, '—') || ' → ' || coalesce(nullif(trim(p ->> 'size'), ''), '—'));
  end if;
  if p ? 'name' and nullif(trim(p ->> 'name'), '') is distinct from old.name then said := said || ('name → ' || trim(p ->> 'name')); end if;
  if p ? 'gst_rate' and nullif(p ->> 'gst_rate', '')::numeric is distinct from old.gst_rate then said := said || ('GST → ' || (p ->> 'gst_rate') || '%'); end if;
  update public.products set
    name = coalesce(nullif(trim(p ->> 'name'), ''), name),
    mrp = case when p ? 'mrp' then nullif(p ->> 'mrp', '')::numeric else mrp end,
    gst_rate = coalesce(nullif(p ->> 'gst_rate', '')::numeric, gst_rate),
    in_easy_ecom = coalesce((p ->> 'in_easy_ecom')::boolean, in_easy_ecom),
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
  perform public.log_activity('product_updated', public.my_name() || ' changed ' || p_sku || ' (' || old.name || ')'
    || case when array_length(said, 1) > 0 then ': ' || array_to_string(said, ', ') else '' end, 'product', p_sku, p);
end;
$$;

-- Use the atomeats.com price as the MRP (one product, or all that differ). Admins.
create or replace function public.accept_site_prices(p_skus text[])
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  n int := 0;
begin
  if not public.is_admin() then raise exception 'Only admins can change prices.'; end if;
  for r in select sku, name, mrp, site_mrp from public.products
           where sku = any (p_skus) and site_mrp is not null and site_mrp is distinct from mrp loop
    update public.products set mrp = r.site_mrp, updated_at = now() where sku = r.sku;
    perform public.log_activity('product_updated',
      public.my_name() || ' took the atomeats.com price for ' || r.sku || ' (' || r.name || '): MRP ₹' || coalesce(r.mrp::text, '—') || ' → ₹' || r.site_mrp,
      'product', r.sku);
    n := n + 1;
  end loop;
  return n;
end;
$$;

revoke all on function public.add_product(jsonb), public.accept_site_prices(text[]) from public, anon;
grant execute on function public.add_product(jsonb), public.accept_site_prices(text[]) to authenticated;

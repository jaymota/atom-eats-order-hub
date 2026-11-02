-- End-of-day Easy Ecom set-up, in order: new customers → new products (and combos) → orders.
-- New products need a cost, weight and size for Easy Ecom's product template; combos also need what
-- is inside them (combo_items). Easy Ecom gives new customers their codes, which come back from its
-- Customer Master export.

alter table public.products
  add column cost numeric(10, 2),
  add column length_cm numeric(8, 2),
  add column height_cm numeric(8, 2),
  add column width_cm numeric(8, 2),
  add column ee_product_done boolean not null default false; -- a combo's own SKU is in Easy Ecom, its contents not yet

-- A temporary CUSTOM-… SKU gets its real Easy Ecom SKU: everything that points at it follows.
alter table public.order_lines drop constraint order_lines_sku_fkey,
  add constraint order_lines_sku_fkey foreign key (sku) references public.products (sku) on update cascade;
alter table public.combo_items drop constraint combo_items_combo_sku_fkey,
  add constraint combo_items_combo_sku_fkey foreign key (combo_sku) references public.products (sku) on delete cascade on update cascade;
alter table public.combo_items drop constraint combo_items_component_sku_fkey,
  add constraint combo_items_component_sku_fkey foreign key (component_sku) references public.products (sku) on update cascade;
alter table public.product_aliases drop constraint product_aliases_sku_fkey,
  add constraint product_aliases_sku_fkey foreign key (sku) references public.products (sku) on delete cascade on update cascade;
alter table public.products drop constraint products_replaced_by_fkey,
  add constraint products_replaced_by_fkey foreign key (replaced_by) references public.products (sku) on update cascade;

-- The website sync used to mark new website combos as already in Easy Ecom. Only this one was added that way.
update public.products set in_easy_ecom = false where sku = 'VPTPPP03' and site_combo;

-- Details a new product needs before it can go in Easy Ecom's product file.
-- p = { sku?, cost, weight_g, length_cm, height_cm, width_cm, parts?: [{ sku, qty }] }
create or replace function public.save_new_product(p_sku text, p jsonb)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v public.products;
  v_sku text := p_sku;
  v_new text := nullif(upper(trim(p ->> 'sku')), '');
  part jsonb;
begin
  if not public.my_role_in(array['ops', 'accounts']) then raise exception 'Only ops, accounts and admins can do this.'; end if;
  select * into v from public.products where sku = p_sku for update;
  if not found then raise exception 'Product % not found.', p_sku; end if;
  if v.in_easy_ecom then raise exception '% is already in Easy Ecom.', p_sku; end if;

  if v_new is not null and v_new <> p_sku then
    if p_sku not like 'CUSTOM-%' then raise exception 'Only a temporary CUSTOM SKU can be changed.'; end if;
    if v_new like 'CUSTOM-%' then raise exception 'Please type the SKU it will have in Easy Ecom.'; end if;
    if exists (select 1 from public.products where lower(sku) = lower(v_new)) then raise exception 'There is already a product with the SKU %.', v_new; end if;
    update public.products set sku = v_new where sku = p_sku;
    v_sku := v_new;
    perform public.log_activity('product_updated', public.my_name() || ' gave ' || v.name || ' its Easy Ecom SKU ' || v_new || ' (was ' || p_sku || ')', 'product', v_new);
  end if;

  update public.products set
    cost = nullif(p ->> 'cost', '')::numeric,
    weight_g = coalesce(nullif(p ->> 'weight_g', '')::numeric, weight_g),
    length_cm = nullif(p ->> 'length_cm', '')::numeric,
    height_cm = nullif(p ->> 'height_cm', '')::numeric,
    width_cm = nullif(p ->> 'width_cm', '')::numeric,
    updated_at = now()
  where sku = v_sku;

  if p ? 'parts' then
    delete from public.combo_items where combo_sku = v_sku;
    for part in select * from jsonb_array_elements(coalesce(p -> 'parts', '[]')) loop
      if (part ->> 'sku') = v_sku then raise exception 'A combo can’t contain itself.'; end if;
      insert into public.combo_items (combo_sku, component_sku, qty)
      values (v_sku, part ->> 'sku', greatest(1, coalesce((part ->> 'qty')::int, 1)))
      on conflict (combo_sku, component_sku) do update set qty = excluded.qty;
    end loop;
  end if;
  return v_sku;
end;
$$;

-- After an upload in Easy Ecom. p_step 'products': plain products are done, combos have their own SKU;
-- p_step 'combos': the combo contents are in too, so the combos are done.
create or replace function public.mark_in_easy_ecom(p_skus text[], p_step text)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
begin
  if not public.my_role_in(array['ops', 'accounts']) then raise exception 'Only ops, accounts and admins can do this.'; end if;
  if p_step = 'products' then
    update public.products set
      in_easy_ecom = not exists (select 1 from public.combo_items c where c.combo_sku = products.sku),
      ee_product_done = true, updated_at = now()
    where sku = any (p_skus) and not in_easy_ecom;
  elsif p_step = 'combos' then
    update public.products set in_easy_ecom = true, updated_at = now() where sku = any (p_skus) and ee_product_done and not in_easy_ecom;
  else
    raise exception 'Unknown step.';
  end if;
  get diagnostics n = row_count;
  perform public.log_activity('product_updated', public.my_name() || ' created ' || n || ' product' || case when n = 1 then '' else 's' end ||
    case when p_step = 'combos' then ' (combo contents)' else '' end || ' in Easy Ecom: ' || array_to_string(p_skus, ', '), 'product', null);
  return n;
end;
$$;

-- Easy Ecom's Customer Master export, read in the browser: [{ code, name, gstin }].
-- A Hub customer without a code gets one when exactly one customer on each side has the same name,
-- or the same GSTIN and the same first word. Returns how many were linked.
create or replace function public.link_ee_customer_codes(p_rows jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  r jsonb;
  c uuid;
  n int := 0;
  v_k text;
  v_g text;
begin
  if not public.my_role_in(array['ops', 'accounts']) then raise exception 'Only ops, accounts and admins can do this.'; end if;
  create temp table ee_in (code text, k text, gstin text, first text) on commit drop;
  insert into ee_in
    select distinct on (x ->> 'code') x ->> 'code', replace(public.norm(regexp_replace(lower(x ->> 'name'), '\m(pvt|private|ltd|limited|llp)\M', '', 'g')), ' ', ''),
      nullif(upper(trim(x ->> 'gstin')), ''), split_part(public.norm(x ->> 'name'), ' ', 1)
    from jsonb_array_elements(coalesce(p_rows, '[]')) x where nullif(trim(x ->> 'code'), '') is not null;
  -- Codes already in the Hub are left alone.
  delete from ee_in where code in (select ee_customer_code from public.customers where ee_customer_code is not null);

  for r in select to_jsonb(e) from ee_in e loop
    v_k := r ->> 'k'; v_g := r ->> 'gstin';
    c := null;
    if (select count(*) from ee_in where ee_in.k = v_k) = 1 then
      select case when count(*) = 1 then min(id::text)::uuid end into c from public.customers
        where active and merged_into is null and ee_customer_code is null
          and replace(public.norm(regexp_replace(lower(name), '\m(pvt|private|ltd|limited|llp)\M', '', 'g')), ' ', '') = v_k;
    end if;
    if c is null and v_g is not null and (select count(*) from ee_in where ee_in.gstin = v_g) = 1 then
      select case when count(*) = 1 then min(id::text)::uuid end into c from public.customers
        where active and merged_into is null and ee_customer_code is null and upper(gstin) = v_g and split_part(public.norm(name), ' ', 1) = r ->> 'first';
    end if;
    if c is not null then
      update public.customers set ee_customer_code = r ->> 'code', in_easy_ecom = true, updated_at = now() where id = c;
      n := n + 1;
    end if;
  end loop;
  if n > 0 then perform public.log_activity('customer_updated', public.my_name() || ' linked ' || n || ' customer' || case when n = 1 then '' else 's' end || ' to their Easy Ecom code from the Customer Master', 'customer', null); end if;
  return n;
end;
$$;

revoke all on function public.save_new_product(text, jsonb), public.mark_in_easy_ecom(text[], text), public.link_ee_customer_codes(jsonb) from public, anon;
grant execute on function public.save_new_product(text, jsonb), public.mark_in_easy_ecom(text[], text), public.link_ee_customer_codes(jsonb) to authenticated;

-- Sales orders: Vinay's GT form sends just the party and the products. They wait in "To confirm"
-- until ops (Tejashree, Zeeshan) add the rest and confirm; then they are normal New orders.
-- Also: "shared with" is no longer needed on invoices, and the FBA SKUs are removed.

alter table public.orders drop constraint if exists orders_stage_check;
alter table public.orders add constraint orders_stage_check
  check (stage in ('sales_order', 'new', 'planned', 'invoiced', 'dispatched', 'delivered', 'on_hold', 'cancelled'));

create or replace function public.save_order(p_id uuid, p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid := p_id;
  o public.orders;
  l jsonb;
  pr public.products;
  n int := 0;
  v_rate numeric;
  v_margin numeric;
  v_basis text;
  v_total numeric := 0;
  v_dup text;
  is_new boolean := p_id is null;
  t text := nullif(trim(p ->> 'po_number'), '');
  v_generated boolean := false;
  v_sales boolean := coalesce((p ->> 'sales_order')::boolean, false);
  v_confirm boolean := coalesce((p ->> 'confirm')::boolean, false);
begin
  if not public.me_ok() then raise exception 'Please log in again.'; end if;
  if nullif(trim(p ->> 'channel'), '') is null then raise exception 'Please choose the channel.'; end if;
  if nullif(trim(p ->> 'customer_name'), '') is null then raise exception 'Please choose or add the customer.'; end if;
  -- Chain POs (Blinkit, Foodstories, …) never carry a phone number, so it's only required for other orders.
  if not is_new then
    select * into o from public.orders where id = v_id;
    if found and o.stage = 'sales_order' then v_sales := not v_confirm; end if;
  end if;
  -- Sales orders (Vinay's GT form) need only the party and the products; the team adds the rest.
  if nullif(trim(p ->> 'phone'), '') is null and coalesce(p ->> 'source', '') not in ('po_file', 'email') and not v_sales and not v_confirm then
    raise exception 'Please add the customer’s phone number.';
  end if;
  if jsonb_array_length(coalesce(p -> 'lines', '[]')) = 0 then raise exception 'Please add at least one product.'; end if;

  if not is_new then
    select * into o from public.orders where id = v_id;
    if not found then raise exception 'Order not found.'; end if;
    if v_confirm and o.stage = 'sales_order' and not public.my_role_in(array['ops']) then
      raise exception 'Only ops and admins can confirm sales orders.';
    end if;
    if o.stage not in ('new', 'on_hold', 'sales_order') and not public.is_admin() then
      raise exception 'This order has moved on (%). Only an admin can change it now.', o.stage;
    end if;
  end if;

  -- Same customer + same PO number = the same order.
  if t is not null and nullif(p ->> 'customer_id', '') is not null then
    select order_no into v_dup from public.orders
      where customer_id = (p ->> 'customer_id')::uuid and po_number = t and stage <> 'cancelled' and id is distinct from v_id
        and coalesce(split_from, id) is distinct from coalesce((select coalesce(x.split_from, x.id) from public.orders x where x.id = v_id), v_id)
      limit 1;
    if v_dup is not null then
      raise exception 'This customer already has an order with PO number % (%). Open that order instead.', t, v_dup;
    end if;
  end if;

  if is_new then
    insert into public.orders (stage, channel, customer_name, created_by, salesperson_id, source, source_text)
    values (case when v_sales then 'sales_order' else 'new' end, trim(p ->> 'channel'), trim(p ->> 'customer_name'), auth.uid(),
            coalesce(nullif(p ->> 'salesperson_id', '')::uuid, auth.uid()),
            coalesce(nullif(p ->> 'source', ''), 'blank'), nullif(p ->> 'source_text', ''))
    returning id into v_id;
  end if;

  -- No PO from the party: the Hub gives the order its own PO number (kept if the order is edited later).
  if t is null then
    select case when po_generated then po_number end into t from public.orders where id = v_id;
    if t is null then t := 'AE-PO-' || lpad(nextval('public.po_no_seq')::text, 5, '0'); end if;
    v_generated := true;
  end if;

  update public.orders set
    po_generated = v_generated,
    channel = trim(p ->> 'channel'),
    order_date = coalesce(nullif(p ->> 'order_date', '')::date, order_date),
    salesperson_id = coalesce(nullif(p ->> 'salesperson_id', '')::uuid, salesperson_id),
    customer_id = nullif(p ->> 'customer_id', '')::uuid,
    customer_name = trim(p ->> 'customer_name'),
    contact_name = nullif(trim(p ->> 'contact_name'), ''),
    phone = nullif(trim(p ->> 'phone'), ''),
    email = nullif(lower(trim(p ->> 'email')), ''),
    gst_status = nullif(p ->> 'gst_status', ''),
    gstin = nullif(upper(trim(p ->> 'gstin')), ''),
    fssai = nullif(trim(p ->> 'fssai'), ''),
    billing_address = nullif(trim(p ->> 'billing_address'), ''),
    billing_city = nullif(trim(p ->> 'billing_city'), ''),
    billing_state = nullif(trim(p ->> 'billing_state'), ''),
    billing_pin = nullif(regexp_replace(coalesce(p ->> 'billing_pin', ''), '\D', '', 'g'), ''),
    payment_terms = coalesce(nullif(p ->> 'payment_terms', ''), 'credit'),
    margin_pct = nullif(p ->> 'margin_pct', '')::numeric,
    same_as_billing = coalesce((p ->> 'same_as_billing')::boolean, false),
    address_id = nullif(p ->> 'address_id', '')::uuid,
    delivery_name = nullif(trim(p ->> 'delivery_name'), ''),
    delivery_address = nullif(trim(p ->> 'delivery_address'), ''),
    delivery_city = nullif(trim(p ->> 'delivery_city'), ''),
    delivery_state = nullif(trim(p ->> 'delivery_state'), ''),
    delivery_pin = nullif(regexp_replace(coalesce(p ->> 'delivery_pin', ''), '\D', '', 'g'), ''),
    delivery_gstin = nullif(upper(trim(p ->> 'delivery_gstin')), ''),
    delivery_contact = nullif(trim(p ->> 'delivery_contact'), ''),
    delivery_phone = nullif(trim(p ->> 'delivery_phone'), ''),
    po_number = t,
    po_date = coalesce(nullif(p ->> 'po_date', '')::date, nullif(p ->> 'order_date', '')::date, order_date),
    needed_by = nullif(p ->> 'needed_by', '')::date,
    payment_type = coalesce(nullif(p ->> 'payment_type', ''), 'Credit'),
    courier_pref = coalesce(nullif(p ->> 'courier_pref', ''), 'DTDC'),
    notes = nullif(trim(p ->> 'notes'), ''),
    shipping_charge = coalesce(nullif(p ->> 'shipping_charge', '')::numeric, 0),
    updated_at = now()
  where id = v_id;

  delete from public.order_lines where order_id = v_id;
  for l in select * from jsonb_array_elements(p -> 'lines') loop
    select * into pr from public.products where sku = l ->> 'sku';
    if not found then raise exception 'There is no Easy Ecom SKU called %.', l ->> 'sku'; end if;
    if coalesce((l ->> 'qty')::int, 0) <= 0 then raise exception 'Please give a quantity for %.', pr.name; end if;
    n := n + 1;
    v_basis := nullif(l ->> 'price_basis', '');
    v_margin := nullif(l ->> 'margin_pct', '')::numeric;
    v_rate := case
      when v_basis = 'foc' then 0
      when v_basis = 'mrp_minus_margin' and v_margin is not null and pr.mrp is not null then round(pr.mrp * (1 - v_margin / 100), 2)
      else nullif(l ->> 'rate', '')::numeric
    end;
    insert into public.order_lines (order_id, line_no, sku, qty, price_basis, margin_pct, rate, value,
      product_name, mrp, gst_rate, hsn, ean, tally_name, typed_as)
    values (v_id, n, pr.sku, (l ->> 'qty')::int, v_basis, v_margin, v_rate, coalesce(v_rate, 0) * (l ->> 'qty')::int,
      pr.name || coalesce(' · ' || pr.size, ''), pr.mrp, pr.gst_rate, pr.hsn, pr.ean, pr.tally_name, nullif(trim(l ->> 'typed_as'), ''));
    v_total := v_total + coalesce(v_rate, 0) * (l ->> 'qty')::int;
  end loop;

  select * into o from public.orders where id = v_id;
  update public.orders set estimate_value = v_total + coalesce(o.shipping_charge, 0), missing = public.order_missing(o) where id = v_id;

  if not is_new and v_confirm and o.stage = 'sales_order' then
    update public.orders set stage = 'new', updated_at = now() where id = v_id;
    perform public.log_activity('order_confirmed', public.my_name() || ' completed sales order ' || o.order_no || ' — it is now a New order', 'order', v_id::text);
  elsif is_new and v_sales then
    perform public.log_activity('order_created', public.my_name() || ' sent sales order ' || o.order_no || ' for ' || o.customer_name,
      'order', v_id::text, jsonb_build_object('lines', n, 'value', v_total, 'source', o.source));
  elsif is_new then
    perform public.log_activity('order_created', public.my_name() || ' entered order ' || o.order_no || ' for ' || o.customer_name,
      'order', v_id::text, jsonb_build_object('lines', n, 'value', v_total, 'source', o.source));
  else
    perform public.log_activity('order_updated', public.my_name() || ' changed order ' || o.order_no, 'order', v_id::text);
  end if;
  return v_id;
end;
$$;

-- Invoices: "shared with" is gone from the screens; the column stays for old invoices.
create or replace function public.record_invoices(p jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  r jsonb;
  o public.orders;
  v_no text;
  v_dup text;
  n int := 0;
begin
  if not public.my_role_in(array['accounts']) then raise exception 'Only accounts and admins can record invoices.'; end if;
  for r in select * from jsonb_array_elements(coalesce(p, '[]')) loop
    select * into o from public.orders where id = (r ->> 'id')::uuid for update;
    if not found then raise exception 'Order not found.'; end if;
    if o.stage not in ('planned', 'invoiced') then raise exception '% is not planned for dispatch yet.', o.order_no; end if;
    v_no := upper(regexp_replace(trim(coalesce(r ->> 'invoice_no', '')), '\s+', '', 'g'));
    if v_no = '' then raise exception '%: invoice number?', o.order_no; end if;
    if nullif(r ->> 'invoice_date', '') is null then raise exception '%: invoice date?', o.order_no; end if;
    if coalesce(nullif(r ->> 'invoice_value', '')::numeric, 0) <= 0 then raise exception '%: invoice value?', o.order_no; end if;
    select order_no into v_dup from public.orders where upper(invoice_no) = v_no and id <> o.id and stage <> 'cancelled' limit 1;
    if v_dup is not null then raise exception 'Invoice % is already on %.', v_no, v_dup; end if;
    update public.orders set stage = 'invoiced', invoice_no = v_no, invoice_date = (r ->> 'invoice_date')::date,
      invoice_value = (r ->> 'invoice_value')::numeric, shared_with = nullif(r ->> 'shared_with', '')::uuid,
      invoiced_at = coalesce(invoiced_at, now()), invoiced_by = auth.uid(), updated_at = now()
    where id = o.id;
    perform public.log_activity('order_invoiced', public.my_name() || ' recorded invoice ' || v_no || ' (₹' || (r ->> 'invoice_value') || ') on '
      || o.order_no, 'order', o.id::text);
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- FBA SKUs are Amazon's own stock (linked in Easy Ecom), never offline orders.
delete from public.product_aliases where sku in (select sku from public.products where sku ~* '-\s*FBA$');
delete from public.combo_items where combo_sku in (select sku from public.products where sku ~* '-\s*FBA$') or component_sku in (select sku from public.products where sku ~* '-\s*FBA$');
update public.products set replaced_by = null where replaced_by in (select sku from public.products where sku ~* '-\s*FBA$');
delete from public.products where sku ~* '-\s*FBA$' and not exists (select 1 from public.order_lines l where l.sku = products.sku);

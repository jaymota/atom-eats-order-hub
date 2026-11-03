-- "FOC only" role (the marketing login): places FOC orders and nothing else. Like sales, it sees only
-- the orders it entered and its own activity, never the To confirm inbox; save_order keeps it to FOC at ₹0.
alter table public.people drop constraint people_role_check;
alter table public.people add constraint people_role_check check (role in ('super_admin', 'admin', 'manager', 'accounts', 'ops', 'sales', 'marketing'));

drop policy if exists orders_read on public.orders;
create policy orders_read on public.orders for select to authenticated
  using (public.me_ok() and (public.my_role() not in ('sales', 'marketing') or created_by = auth.uid() or salesperson_id = auth.uid()));
drop policy if exists activity_read on public.activity;
create policy activity_read on public.activity for select to authenticated
  using (public.me_ok() and (public.my_role() not in ('sales', 'marketing') or person_id = auth.uid()));
drop policy if exists inbox_emails_read on public.inbox_emails;
create policy inbox_emails_read on public.inbox_emails for select to authenticated
  using (public.me_ok() and public.my_role() not in ('sales', 'accounts', 'marketing'));
drop policy if exists inbox_files_read on public.inbox_files;
create policy inbox_files_read on public.inbox_files for select to authenticated
  using (public.me_ok() and public.my_role() not in ('sales', 'accounts', 'marketing'));
drop policy if exists inbox_senders_read on public.inbox_senders;
create policy inbox_senders_read on public.inbox_senders for select to authenticated
  using (public.me_ok() and public.my_role() not in ('sales', 'accounts', 'marketing'));

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
  if public.my_role() = 'marketing' and coalesce(p ->> 'channel', '') <> 'FOC' then raise exception 'This login can only place FOC orders.'; end if;
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
    -- Ops may also fix a planned order: it goes back to New to be planned again (below).
    if o.stage not in ('new', 'on_hold', 'sales_order') and not public.is_admin() and not (o.stage = 'planned' and public.my_role_in(array['ops'])) then
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
    po_expiry = nullif(p ->> 'po_expiry', '')::date,
    po_revised = coalesce((p ->> 'po_revised')::boolean, false),
    needed_by = nullif(p ->> 'needed_by', '')::date,
    payment_type = coalesce(nullif(p ->> 'payment_type', ''), 'Credit'),
    courier_pref = coalesce(nullif(p ->> 'courier_pref', ''), 'DTDC'),
    notes = nullif(trim(p ->> 'notes'), ''),
    shipping_charge = coalesce(nullif(p ->> 'shipping_charge', '')::numeric, 0),
    packaging_charge = coalesce(nullif(p ->> 'packaging_charge', '')::numeric, 0),
    updated_at = now()
  where id = v_id;

  delete from public.order_lines where order_id = v_id;
  for l in select * from jsonb_array_elements(p -> 'lines') loop
    select * into pr from public.products where sku = l ->> 'sku';
    if not found then raise exception 'There is no Easy Ecom SKU called %.', l ->> 'sku'; end if;
    if coalesce((l ->> 'qty')::int, 0) <= 0 then raise exception 'Please give a quantity for %.', pr.name; end if;
    n := n + 1;
    v_basis := case when p ->> 'channel' = 'FOC' and public.my_role() = 'marketing' then 'foc' else nullif(l ->> 'price_basis', '') end;
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
  update public.orders set estimate_value = v_total + coalesce(o.shipping_charge, 0) + coalesce(o.packaging_charge, 0), missing = public.order_missing(o) where id = v_id;

  if not is_new and v_confirm and o.stage = 'sales_order' then
    update public.orders set stage = 'new', updated_at = now() where id = v_id;
    perform public.log_activity('order_confirmed', public.my_name() || ' completed sales order ' || o.order_no || ' — it is now a New order', 'order', v_id::text);
  elsif is_new and v_sales then
    perform public.log_activity('order_created', public.my_name() || ' sent sales order ' || o.order_no || ' for ' || o.customer_name,
      'order', v_id::text, jsonb_build_object('lines', n, 'value', v_total, 'source', o.source));
  elsif is_new then
    perform public.log_activity('order_created', public.my_name() || ' entered order ' || o.order_no || ' for ' || o.customer_name,
      'order', v_id::text, jsonb_build_object('lines', n, 'value', v_total, 'source', o.source));
  elsif o.stage = 'planned' and not public.is_admin() then
    update public.orders set stage = 'new', planned_at = null, planned_by = null, updated_at = now() where id = v_id;
    perform public.log_activity('order_updated', public.my_name() || ' changed planned order ' || o.order_no || ' — back to New to plan again', 'order', v_id::text);
  else
    perform public.log_activity('order_updated', public.my_name() || ' changed order ' || o.order_no, 'order', v_id::text);
  end if;
  return v_id;
end;
$$;

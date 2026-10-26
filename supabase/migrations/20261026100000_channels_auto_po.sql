-- Your six channels, and Hub-made PO numbers when the party doesn't send one.
--
-- Channels: Modern Retail (Food Square, Foodstories), General Trade (field sales),
-- Quick Commerce (Blinkit, Swiggy Instamart), B2B (bulk and other WhatsApp orders), Gifting, FOC.

update public.customers set default_channel = case default_channel
  when 'Blinkit' then 'Quick Commerce'
  when 'Foodstories' then 'Modern Retail'
  when 'Food Square' then 'Modern Retail'
  when 'Other retail chains / corporates' then 'Modern Retail'
  when 'Retail (field sales)' then 'General Trade'
  when 'Custom' then 'B2B'
  when 'FOC samples' then 'FOC'
  else default_channel end
where default_channel is not null;

update public.orders set channel = case channel
  when 'Blinkit' then 'Quick Commerce'
  when 'Foodstories' then 'Modern Retail'
  when 'Food Square' then 'Modern Retail'
  when 'Other retail chains / corporates' then 'Modern Retail'
  when 'Retail (field sales)' then 'General Trade'
  when 'Custom' then 'B2B'
  when 'FOC samples' then 'FOC'
  else channel end;

create sequence public.po_no_seq;
alter table public.orders add column po_generated boolean not null default false;

create or replace function public.order_missing(o public.orders)
returns text[]
language plpgsql
stable
set search_path = public
as $$
declare
  m text[] := '{}';
begin
  if o.gst_status is null then m := array_append(m, 'GST status'); end if;
  if o.gst_status = 'registered' and coalesce(o.gstin, '') = '' then m := array_append(m, 'GSTIN'); end if;
  if coalesce(o.billing_address, '') = '' then m := array_append(m, 'billing address'); end if;
  if coalesce(o.billing_state, '') = '' then m := array_append(m, 'billing state'); end if;
  if coalesce(o.billing_pin, '') = '' then m := array_append(m, 'billing PIN'); end if;
  if coalesce(o.payment_terms, '') = '' then m := array_append(m, 'payment terms'); end if;
  if coalesce(o.delivery_address, '') = '' then m := array_append(m, 'delivery address'); end if;
  if coalesce(o.delivery_state, '') = '' then m := array_append(m, 'delivery state'); end if;
  if coalesce(o.delivery_pin, '') = '' then m := array_append(m, 'delivery PIN'); end if;
  if o.payment_type is null then m := array_append(m, 'payment type'); end if;
  if exists (select 1 from public.order_lines l where l.order_id = o.id and (l.price_basis is null or l.rate is null)) then
    m := array_append(m, 'price for every product');
  end if;
  return m;
end;
$$;


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
begin
  if not public.me_ok() then raise exception 'Please log in again.'; end if;
  if nullif(trim(p ->> 'channel'), '') is null then raise exception 'Please choose the channel.'; end if;
  if nullif(trim(p ->> 'customer_name'), '') is null then raise exception 'Please choose or add the customer.'; end if;
  if nullif(trim(p ->> 'phone'), '') is null then raise exception 'Please add the customer’s phone number.'; end if;
  if jsonb_array_length(coalesce(p -> 'lines', '[]')) = 0 then raise exception 'Please add at least one product.'; end if;

  if not is_new then
    select * into o from public.orders where id = v_id;
    if not found then raise exception 'Order not found.'; end if;
    if o.stage not in ('new', 'on_hold') and not public.is_admin() then
      raise exception 'This order has moved on (%). Only an admin can change it now.', o.stage;
    end if;
  end if;

  -- Same customer + same PO number = the same order.
  if t is not null and nullif(p ->> 'customer_id', '') is not null then
    select order_no into v_dup from public.orders
      where customer_id = (p ->> 'customer_id')::uuid and po_number = t and stage <> 'cancelled' and id is distinct from v_id
      limit 1;
    if v_dup is not null then
      raise exception 'This customer already has an order with PO number % (%). Open that order instead.', t, v_dup;
    end if;
  end if;

  if is_new then
    insert into public.orders (channel, customer_name, created_by, salesperson_id, source, source_text)
    values (trim(p ->> 'channel'), trim(p ->> 'customer_name'), auth.uid(),
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
    payment_terms = nullif(p ->> 'payment_terms', ''),
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
    payment_type = nullif(p ->> 'payment_type', ''),
    courier_pref = nullif(p ->> 'courier_pref', ''),
    notes = nullif(trim(p ->> 'notes'), ''),
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
  update public.orders set estimate_value = v_total, missing = public.order_missing(o) where id = v_id;

  if is_new then
    perform public.log_activity('order_created', public.my_name() || ' entered order ' || o.order_no || ' for ' || o.customer_name,
      'order', v_id::text, jsonb_build_object('lines', n, 'value', v_total, 'source', o.source));
  else
    perform public.log_activity('order_updated', public.my_name() || ' changed order ' || o.order_no, 'order', v_id::text);
  end if;
  return v_id;
end;
$$;


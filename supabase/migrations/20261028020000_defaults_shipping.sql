-- Fewer clicks: payment Credit, terms credit and courier DTDC unless someone picks otherwise.
-- Shipping charges on an order, so accounts knows to add them to the invoice.

alter table public.orders add column shipping_charge numeric(10, 2) not null default 0 check (shipping_charge >= 0);
alter table public.orders alter column payment_type set default 'Credit';
alter table public.orders alter column payment_terms set default 'credit';
alter table public.orders alter column courier_pref set default 'DTDC';

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
        and coalesce(split_from, id) is distinct from coalesce((select coalesce(x.split_from, x.id) from public.orders x where x.id = v_id), v_id)
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

  if is_new then
    perform public.log_activity('order_created', public.my_name() || ' entered order ' || o.order_no || ' for ' || o.customer_name,
      'order', v_id::text, jsonb_build_object('lines', n, 'value', v_total, 'source', o.source));
  else
    perform public.log_activity('order_updated', public.my_name() || ' changed order ' || o.order_no, 'order', v_id::text);
  end if;
  return v_id;
end;
$$;

-- When an order is split, the shipping stays with the part that goes first.
create or replace function public.split_order(p_order uuid, p_send jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  o public.orders;
  l public.order_lines;
  v_send int;
  v_new uuid := gen_random_uuid();
  v_no text;
  v_n int := 0;
  v_left int := 0;
begin
  if not public.my_role_in(array['ops']) then raise exception 'Only ops and admins can split orders.'; end if;
  select * into o from public.orders where id = p_order for update;
  if not found then raise exception 'Order not found.'; end if;
  if o.stage not in ('new', 'planned', 'on_hold') then raise exception 'Split before the invoice is made.'; end if;
  -- Every part points at the first order, so the numbers run ORD-00007-2, ORD-00007-3, …
  select count(*) + 2 into v_n from public.orders where split_from = coalesce(o.split_from, o.id);
  v_no := coalesce((select order_no from public.orders where id = o.split_from), o.order_no) || '-' || v_n;
  for l in select * from public.order_lines where order_id = p_order loop
    v_send := coalesce((select (x ->> 'qty')::int from jsonb_array_elements(p_send) x where (x ->> 'line_id')::uuid = l.id), l.qty);
    if v_send < 0 or v_send > l.qty then raise exception 'Wrong quantity for %.', l.product_name; end if;
    v_left := v_left + (l.qty - v_send);
  end loop;
  if v_left = 0 then raise exception 'Nothing is left over — no split needed.'; end if;
  if not exists (select 1 from public.order_lines ol where ol.order_id = p_order
                 and coalesce((select (x ->> 'qty')::int from jsonb_array_elements(p_send) x where (x ->> 'line_id')::uuid = ol.id), ol.qty) > 0) then
    raise exception 'Nothing would go now.';
  end if;

  insert into public.orders select (jsonb_populate_record(o, jsonb_build_object(
    'id', v_new, 'order_no', v_no, 'stage', 'new', 'split_from', coalesce(o.split_from, o.id), 'planned_at', null, 'planned_by', null,
    'po_generated', o.po_generated, 'created_by', auth.uid(), 'created_at', now(), 'updated_at', now(),
    'source', 'split', 'held_from', null, 'hold_reason', null, 'shipping_charge', 0))).*;

  for l in select * from public.order_lines where order_id = p_order loop
    v_send := coalesce((select (x ->> 'qty')::int from jsonb_array_elements(p_send) x where (x ->> 'line_id')::uuid = l.id), l.qty);
    if v_send < l.qty then
      insert into public.order_lines select (jsonb_populate_record(l, jsonb_build_object(
        'id', gen_random_uuid(), 'order_id', v_new, 'qty', l.qty - v_send, 'value', round(coalesce(l.rate, 0) * (l.qty - v_send), 2)))).*;
      if v_send = 0 then delete from public.order_lines where id = l.id;
      else update public.order_lines set qty = v_send, value = round(coalesce(rate, 0) * v_send, 2) where id = l.id;
      end if;
    end if;
  end loop;

  update public.orders x set estimate_value = coalesce((select sum(value) from public.order_lines where order_id = x.id), 0) + x.shipping_charge, updated_at = now()
  where x.id in (p_order, v_new);
  perform public.log_activity('order_split', public.my_name() || ' split ' || o.order_no || ': the rest is now ' || v_no, 'order', p_order::text);
  perform public.log_activity('order_split', public.my_name() || ' made ' || v_no || ' from what was left of ' || o.order_no, 'order', v_new::text);
  return v_new;
end;
$$;


-- Orders not yet planned: fill the new defaults where nobody chose anything, and recount what's missing.
update public.orders set payment_type = coalesce(payment_type, 'Credit'), payment_terms = coalesce(payment_terms, 'credit'), courier_pref = coalesce(courier_pref, 'DTDC')
where stage in ('new', 'on_hold') and (payment_type is null or payment_terms is null or courier_pref is null);
update public.orders o set missing = public.order_missing(o) where stage in ('new', 'on_hold');

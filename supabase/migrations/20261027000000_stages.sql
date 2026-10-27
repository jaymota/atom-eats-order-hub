-- Phase 4: moving orders through the stages.
--   New → Planned for dispatch (ops) → Invoice shared (accounts) → Dispatched (ops) → Delivered (ops)
-- plus On hold (goes back to where it was) and Cancelled. Partial dispatch splits an order in two.

alter table public.orders
  add column planned_at timestamptz,
  add column planned_by uuid references public.people (id) on delete set null,
  add column invoiced_at timestamptz,
  add column invoiced_by uuid references public.people (id) on delete set null,
  add column dispatched_at timestamptz,
  add column dispatched_by uuid references public.people (id) on delete set null,
  add column held_from text,
  add column split_from uuid references public.orders (id) on delete set null;
create index on public.orders (invoice_no);
create index on public.orders (tracking_no);

-- Who gets a copy of every hand-off email (Siddhesh).
alter table public.people add column copy_on_handoffs boolean not null default false;
update public.people set copy_on_handoffs = true where username = 'siddhesh';

create or replace function public.my_role_in(p_roles text[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.my_role() = any (p_roles || array['super_admin', 'admin']), false);
$$;
revoke all on function public.my_role_in(text[]) from public, anon;

-- ---------- Plan dispatch (ops): many orders at once ----------
create or replace function public.plan_orders(p_ids uuid[])
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  o public.orders;
  m text[];
  blocked text[] := '{}';
  n int := 0;
begin
  if not public.my_role_in(array['ops']) then raise exception 'Only ops and admins can plan dispatch.'; end if;
  for o in select * from public.orders where id = any (p_ids) for update loop
    if o.stage <> 'new' then blocked := blocked || (o.order_no || ' is already ' || o.stage); continue; end if;
    m := public.order_missing(o);
    if array_length(m, 1) > 0 then blocked := blocked || (o.order_no || ' needs ' || array_to_string(m, ', ')); end if;
  end loop;
  if array_length(blocked, 1) > 0 then raise exception 'Not planned. %.', array_to_string(blocked, '; '); end if;
  for o in select * from public.orders where id = any (p_ids) loop
    update public.orders set stage = 'planned', planned_at = now(), planned_by = auth.uid(), missing = '{}', updated_at = now() where id = o.id;
    perform public.log_activity('order_planned', public.my_name() || ' planned ' || o.order_no || ' for dispatch and sent it to accounts', 'order', o.id::text);
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- Back one step (a mistake): Planned → New, or Invoice shared → Planned (clears the invoice).
create or replace function public.undo_stage(p_order uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  o public.orders;
begin
  select * into o from public.orders where id = p_order for update;
  if not found then raise exception 'Order not found.'; end if;
  if o.stage = 'planned' and public.my_role_in(array['ops']) then
    update public.orders set stage = 'new', planned_at = null, planned_by = null, updated_at = now() where id = p_order;
    perform public.log_activity('order_unplanned', public.my_name() || ' took ' || o.order_no || ' back to New', 'order', p_order::text);
  elsif o.stage = 'invoiced' and public.my_role_in(array['accounts']) then
    update public.orders set stage = 'planned', invoice_no = null, invoice_date = null, invoice_value = null, shared_with = null,
      invoiced_at = null, invoiced_by = null, updated_at = now() where id = p_order;
    perform public.log_activity('order_uninvoiced', public.my_name() || ' removed invoice ' || o.invoice_no || ' from ' || o.order_no, 'order', p_order::text);
  elsif o.stage = 'dispatched' and public.is_admin() then
    update public.orders set stage = 'invoiced', dispatch_date = null, courier = null, tracking_no = null, boxes = null, dispatch_note = null,
      dispatched_at = null, dispatched_by = null, updated_at = now() where id = p_order;
    perform public.log_activity('order_undispatched', public.my_name() || ' took ' || o.order_no || ' back to Invoice shared', 'order', p_order::text);
  else
    raise exception 'You can’t undo this step.';
  end if;
end;
$$;

-- ---------- Invoice shared (accounts): one or many rows ----------
-- p: [{id, invoice_no, invoice_date, invoice_value, shared_with}]
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
    if nullif(r ->> 'shared_with', '') is null then raise exception '%: shared with?', o.order_no; end if;
    select order_no into v_dup from public.orders where upper(invoice_no) = v_no and id <> o.id and stage <> 'cancelled' limit 1;
    if v_dup is not null then raise exception 'Invoice % is already on %.', v_no, v_dup; end if;
    update public.orders set stage = 'invoiced', invoice_no = v_no, invoice_date = (r ->> 'invoice_date')::date,
      invoice_value = (r ->> 'invoice_value')::numeric, shared_with = (r ->> 'shared_with')::uuid,
      invoiced_at = coalesce(invoiced_at, now()), invoiced_by = auth.uid(), updated_at = now()
    where id = o.id;
    perform public.log_activity('order_invoiced', public.my_name() || ' recorded invoice ' || v_no || ' (₹' || (r ->> 'invoice_value') || ') on '
      || o.order_no || ', shared with ' || coalesce((select name from public.people where id = (r ->> 'shared_with')::uuid), '?'), 'order', o.id::text);
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- ---------- Dispatched (ops): one or many rows. The invoice must come first. ----------
-- p: [{id, dispatch_date, courier, tracking_no, boxes, dispatch_note}]
create or replace function public.mark_dispatched(p jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  r jsonb;
  o public.orders;
  v_courier text;
  v_track text;
  n int := 0;
begin
  if not public.my_role_in(array['ops']) then raise exception 'Only ops and admins can mark orders dispatched.'; end if;
  for r in select * from jsonb_array_elements(coalesce(p, '[]')) loop
    select * into o from public.orders where id = (r ->> 'id')::uuid for update;
    if not found then raise exception 'Order not found.'; end if;
    if o.stage <> 'invoiced' then raise exception '% has no invoice yet.', o.order_no; end if;
    v_courier := nullif(trim(r ->> 'courier'), '');
    v_track := nullif(trim(r ->> 'tracking_no'), '');
    if nullif(r ->> 'dispatch_date', '') is null then raise exception '%: dispatch date?', o.order_no; end if;
    if v_courier is null then raise exception '%: courier?', o.order_no; end if;
    if v_courier = 'DTDC' and v_track is null then raise exception '%: DTDC docket number?', o.order_no; end if;
    update public.orders set stage = 'dispatched', dispatch_date = (r ->> 'dispatch_date')::date, courier = v_courier, tracking_no = v_track,
      boxes = nullif(r ->> 'boxes', '')::int, dispatch_note = nullif(trim(r ->> 'dispatch_note'), ''),
      dispatched_at = now(), dispatched_by = auth.uid(), updated_at = now()
    where id = o.id;
    perform public.log_activity('order_dispatched', public.my_name() || ' dispatched ' || o.order_no || ' by ' || v_courier
      || coalesce(' · ' || v_track, ''), 'order', o.id::text);
    n := n + 1;
  end loop;
  return n;
end;
$$;

create or replace function public.mark_delivered(p_ids uuid[])
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  o public.orders;
  n int := 0;
begin
  if not public.my_role_in(array['ops']) then raise exception 'Only ops and admins can mark orders delivered.'; end if;
  for o in select * from public.orders where id = any (p_ids) and stage = 'dispatched' loop
    update public.orders set stage = 'delivered', delivered_at = now(), updated_at = now() where id = o.id;
    perform public.log_activity('order_delivered', public.my_name() || ' marked ' || o.order_no || ' delivered', 'order', o.id::text);
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- ---------- Partial dispatch: what goes now stays on this order, the rest becomes a new order ----------
-- p_send: [{line_id, qty}] = how many of each line go now. Returns the new order's id.
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
  if not exists (select 1 from public.order_lines l where l.order_id = p_order
                 and coalesce((select (x ->> 'qty')::int from jsonb_array_elements(p_send) x where (x ->> 'line_id')::uuid = l.id), l.qty) > 0) then
    raise exception 'Nothing would go now.';
  end if;

  insert into public.orders select (jsonb_populate_record(o, jsonb_build_object(
    'id', v_new, 'order_no', v_no, 'stage', 'new', 'split_from', coalesce(o.split_from, o.id), 'planned_at', null, 'planned_by', null,
    'po_generated', o.po_generated, 'created_by', auth.uid(), 'created_at', now(), 'updated_at', now(),
    'source', 'split', 'held_from', null, 'hold_reason', null))).*;

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

  update public.orders x set estimate_value = coalesce((select sum(value) from public.order_lines where order_id = x.id), 0), updated_at = now()
  where x.id in (p_order, v_new);
  perform public.log_activity('order_split', public.my_name() || ' split ' || o.order_no || ': the rest is now ' || v_no, 'order', p_order::text);
  perform public.log_activity('order_split', public.my_name() || ' made ' || v_no || ' from what was left of ' || o.order_no, 'order', v_new::text);
  return v_new;
end;
$$;

-- ---------- On hold goes back to the stage it came from ----------
create or replace function public.set_order_hold(p_order uuid, p_action text, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  o public.orders;
begin
  if not public.my_role_in(array['ops']) then raise exception 'Only ops and admins can put orders on hold or cancel them.'; end if;
  select * into o from public.orders where id = p_order for update;
  if not found then raise exception 'Order not found.'; end if;
  if p_action in ('hold', 'cancel') and nullif(trim(p_reason), '') is null then raise exception 'Please give a reason.'; end if;
  if p_action = 'hold' then
    if o.stage in ('on_hold', 'cancelled', 'dispatched', 'delivered') then raise exception 'This order can’t go on hold now.'; end if;
    update public.orders set stage = 'on_hold', held_from = o.stage, hold_reason = trim(p_reason), updated_at = now() where id = p_order;
    perform public.log_activity('order_on_hold', public.my_name() || ' put ' || o.order_no || ' on hold: ' || trim(p_reason), 'order', p_order::text);
  elsif p_action = 'cancel' then
    if o.stage in ('cancelled', 'dispatched', 'delivered') then raise exception 'This order can’t be cancelled now.'; end if;
    update public.orders set stage = 'cancelled', cancel_reason = trim(p_reason), updated_at = now() where id = p_order;
    perform public.log_activity('order_cancelled', public.my_name() || ' cancelled ' || o.order_no || ': ' || trim(p_reason), 'order', p_order::text);
  elsif p_action = 'resume' then
    if o.stage <> 'on_hold' then raise exception 'This order is not on hold.'; end if;
    update public.orders set stage = coalesce(o.held_from, 'new'), held_from = null, hold_reason = null, updated_at = now() where id = p_order;
    perform public.log_activity('order_resumed', public.my_name() || ' took ' || o.order_no || ' off hold', 'order', p_order::text);
  else
    raise exception 'Unknown action.';
  end if;
end;
$$;

-- Parts of a split order share the PO number, so they don't count as repeats.
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

-- Files can now be invoice PDFs, tracking slips, delivery proofs.
alter table public.order_files drop constraint if exists order_files_kind_check;
alter table public.order_files add constraint order_files_kind_check
  check (kind in ('message', 'screenshot', 'po', 'invoice', 'tracking', 'grn', 'delivery', 'other'));

revoke all on function public.plan_orders(uuid[]), public.undo_stage(uuid), public.record_invoices(jsonb),
  public.mark_dispatched(jsonb), public.mark_delivered(uuid[]), public.split_order(uuid, jsonb) from public, anon;
grant execute on function public.plan_orders(uuid[]), public.undo_stage(uuid), public.record_invoices(jsonb),
  public.mark_dispatched(jsonb), public.mark_delivered(uuid[]), public.split_order(uuid, jsonb), public.my_role_in(text[]) to authenticated;

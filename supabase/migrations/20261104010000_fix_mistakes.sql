-- Fixing mistakes without going backwards through the steps. Every fix is written to the order's Timeline.
--  * fix_invoice: accounts change the invoice number, date or value on an invoiced / dispatched / delivered order.
--  * remove_order_file: the person who added a file (or an admin; accounts for invoice PDFs) removes it, then the stored copy.
--  * set_order_hold 'uncancel': an admin brings back an order cancelled by mistake.
--  * undo_stage: Delivered → Dispatched.
--  * edit_order_note / delete_order_note: your own notes (admins: any).
--  * save_order: ops may change a planned order; it goes back to New to be planned again.

create or replace function public.fix_invoice(p jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  o public.orders;
  v_no text := upper(regexp_replace(trim(coalesce(p ->> 'invoice_no', '')), '\s+', '', 'g'));
  v_dup text;
  said text[] := '{}';
begin
  if not public.my_role_in(array['accounts']) then raise exception 'Only accounts and admins can change invoices.'; end if;
  select * into o from public.orders where id = (p ->> 'id')::uuid for update;
  if not found then raise exception 'Order not found.'; end if;
  if o.stage not in ('invoiced', 'dispatched', 'delivered') or o.invoice_no is null then raise exception '% has no invoice yet.', o.order_no; end if;
  if v_no = '' then raise exception 'Invoice number?'; end if;
  if nullif(p ->> 'invoice_date', '') is null then raise exception 'Invoice date?'; end if;
  if coalesce(nullif(p ->> 'invoice_value', '')::numeric, 0) <= 0 then raise exception 'Invoice value?'; end if;
  select order_no into v_dup from public.orders where upper(invoice_no) = v_no and id <> o.id and stage <> 'cancelled' limit 1;
  if v_dup is not null then raise exception 'Invoice % is already on %.', v_no, v_dup; end if;
  if v_no <> o.invoice_no then said := said || (o.invoice_no || ' → ' || v_no); end if;
  if (p ->> 'invoice_date')::date is distinct from o.invoice_date then said := said || ('date ' || (p ->> 'invoice_date')); end if;
  if (p ->> 'invoice_value')::numeric is distinct from o.invoice_value then said := said || ('₹' || (p ->> 'invoice_value')); end if;
  update public.orders set invoice_no = v_no, invoice_date = (p ->> 'invoice_date')::date, invoice_value = (p ->> 'invoice_value')::numeric,
    updated_at = now()
  where id = o.id;
  if array_length(said, 1) > 0 then
    perform public.log_activity('order_invoice_fixed', public.my_name() || ' changed the invoice on ' || o.order_no || ': ' || array_to_string(said, ', '), 'order', o.id::text);
  end if;
end;
$$;
revoke all on function public.fix_invoice(jsonb) from public, anon;
grant execute on function public.fix_invoice(jsonb) to authenticated;

create or replace function public.remove_order_file(p_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  f public.order_files;
  v_no text;
begin
  if not public.me_ok() then raise exception 'Please log in again.'; end if;
  select * into f from public.order_files where id = p_id for update;
  if not found then raise exception 'File not found.'; end if;
  -- Accounts may also replace any invoice PDF.
  if f.uploaded_by is distinct from auth.uid() and not public.is_admin() and not (f.kind = 'invoice' and public.my_role_in(array['accounts'])) then raise exception 'Only the person who added this file, or an admin, can remove it.'; end if;
  delete from public.order_files where id = p_id;
  select order_no into v_no from public.orders where id = f.order_id;
  perform public.log_activity('order_file_removed', public.my_name() || ' removed ' || f.kind || ' file ' || coalesce(f.name, '') || ' from ' || v_no, 'order', f.order_id::text);
  return f.path;
end;
$$;
revoke all on function public.remove_order_file(uuid) from public, anon;
grant execute on function public.remove_order_file(uuid) to authenticated;

-- A stored file may be deleted only once its order_files row is gone (that is, after remove_order_file).
create or replace function public.order_file_gone(p_path text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select not exists (select 1 from public.order_files where path = p_path);
$$;
revoke all on function public.order_file_gone(text) from public, anon;
grant execute on function public.order_file_gone(text) to authenticated;
drop policy if exists order_files_bucket_remove on storage.objects;
create policy order_files_bucket_remove on storage.objects for delete to authenticated
  using (bucket_id = 'order-files' and public.me_ok() and public.order_file_gone(name));

create or replace function public.set_order_hold(p_order uuid, p_action text, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  o public.orders;
  v_dup text;
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
  elsif p_action = 'uncancel' then
    -- Back to Invoice shared if it had an invoice, else to New to be planned again.
    if not public.is_admin() then raise exception 'Only an admin can bring back a cancelled order.'; end if;
    if o.stage <> 'cancelled' then raise exception 'This order is not cancelled.'; end if;
    if o.invoice_no is not null then
      select order_no into v_dup from public.orders where upper(invoice_no) = upper(o.invoice_no) and id <> o.id and stage <> 'cancelled' limit 1;
      if v_dup is not null then raise exception 'Invoice % is now on %.', o.invoice_no, v_dup; end if;
    end if;
    if o.customer_id is not null and o.po_number is not null and not o.po_generated then
      select order_no into v_dup from public.orders where customer_id = o.customer_id and po_number = o.po_number and stage <> 'cancelled' and id <> o.id
        and coalesce(split_from, id) is distinct from coalesce(o.split_from, o.id) limit 1;
      if v_dup is not null then raise exception 'PO % is now on %.', o.po_number, v_dup; end if;
    end if;
    update public.orders set stage = case when o.invoice_no is not null then 'invoiced' else 'new' end,
      planned_at = case when o.invoice_no is not null then planned_at end, planned_by = case when o.invoice_no is not null then planned_by end,
      held_from = null, hold_reason = null, cancel_reason = null, updated_at = now()
    where id = p_order;
    perform public.log_activity('order_uncancelled', public.my_name() || ' brought back cancelled order ' || o.order_no, 'order', p_order::text);
  else
    raise exception 'Unknown action.';
  end if;
end;
$$;

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
  elsif o.stage = 'invoiced' and o.channel = 'FOC' and o.invoice_no is null and public.my_role_in(array['ops']) then
    -- FOC skipped invoicing, so one step back is New.
    update public.orders set stage = 'new', planned_at = null, planned_by = null, invoiced_at = null, updated_at = now() where id = p_order;
    perform public.log_activity('order_unplanned', public.my_name() || ' took FOC order ' || o.order_no || ' back to New', 'order', p_order::text);
  elsif o.stage = 'invoiced' and public.my_role_in(array['accounts']) then
    update public.orders set stage = 'planned', invoice_no = null, invoice_date = null, invoice_value = null, shared_with = null,
      invoiced_at = null, invoiced_by = null, updated_at = now() where id = p_order;
    perform public.log_activity('order_uninvoiced', public.my_name() || ' removed invoice ' || o.invoice_no || ' from ' || o.order_no, 'order', p_order::text);
  elsif o.stage = 'dispatched' and public.is_admin() then
    update public.orders set stage = 'invoiced', dispatch_date = null, courier = null, tracking_no = null, boxes = null, dispatch_note = null,
      dispatched_at = null, dispatched_by = null, updated_at = now() where id = p_order;
    perform public.log_activity('order_undispatched', public.my_name() || ' took ' || o.order_no || ' back to Invoice shared', 'order', p_order::text);
  elsif o.stage = 'delivered' and public.my_role_in(array['ops']) then
    update public.orders set stage = 'dispatched', delivered_at = null, updated_at = now() where id = p_order;
    perform public.log_activity('order_undelivered', public.my_name() || ' took ' || o.order_no || ' back to Dispatched', 'order', p_order::text);
  else
    raise exception 'You can’t undo this step.';
  end if;
end;
$$;

alter table public.order_notes add column if not exists edited_at timestamptz;

create or replace function public.edit_order_note(p_id uuid, p_body text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  n public.order_notes;
begin
  if not public.me_ok() then raise exception 'Please log in again.'; end if;
  if nullif(trim(p_body), '') is null then raise exception 'The note is empty.'; end if;
  select * into n from public.order_notes where id = p_id for update;
  if not found then raise exception 'Note not found.'; end if;
  if n.person_id is distinct from auth.uid() and not public.is_admin() then raise exception 'You can only change your own notes.'; end if;
  update public.order_notes set body = trim(p_body), edited_at = now() where id = p_id;
end;
$$;
revoke all on function public.edit_order_note(uuid, text) from public, anon;
grant execute on function public.edit_order_note(uuid, text) to authenticated;

create or replace function public.delete_order_note(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  n public.order_notes;
  v_no text;
begin
  if not public.me_ok() then raise exception 'Please log in again.'; end if;
  select * into n from public.order_notes where id = p_id for update;
  if not found then raise exception 'Note not found.'; end if;
  if n.person_id is distinct from auth.uid() and not public.is_admin() then raise exception 'You can only delete your own notes.'; end if;
  delete from public.order_notes where id = p_id;
  select order_no into v_no from public.orders where id = n.order_id;
  perform public.log_activity('order_note_deleted', public.my_name() || ' deleted a note on ' || v_no, 'order', n.order_id::text);
end;
$$;
revoke all on function public.delete_order_note(uuid) from public, anon;
grant execute on function public.delete_order_note(uuid) to authenticated;

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

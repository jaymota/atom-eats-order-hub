-- Phase 3: orders, their lines, files and notes.
--
-- An order keeps a copy of the customer's details as they were when the order was saved
-- (what the invoice and the Easy Ecom upload need), plus a link to the customer record.

create sequence public.order_no_seq;

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  order_no text not null unique default ('ORD-' || lpad(nextval('public.order_no_seq')::text, 5, '0')),
  stage text not null default 'new'
    check (stage in ('new', 'planned', 'invoiced', 'dispatched', 'delivered', 'on_hold', 'cancelled')),
  channel text not null,
  order_date date not null default (now() at time zone 'Asia/Kolkata')::date,
  received_at timestamptz not null default now(),   -- "late" counts 24 hours from here
  salesperson_id uuid references public.people (id) on delete set null,
  created_by uuid references public.people (id) on delete set null,

  -- customer (copy at the time of the order)
  customer_id uuid references public.customers (id),
  customer_name text not null,
  contact_name text,
  phone text,
  email text,
  gst_status text,
  gstin text,
  fssai text,
  billing_address text,
  billing_city text,
  billing_state text,
  billing_pin text,
  payment_terms text,
  margin_pct numeric(5, 2),

  -- delivery
  same_as_billing boolean not null default false,
  address_id uuid references public.customer_addresses (id) on delete set null,
  delivery_name text,
  delivery_address text,
  delivery_city text,
  delivery_state text,
  delivery_pin text,
  delivery_gstin text,
  delivery_contact text,
  delivery_phone text,

  -- order details
  po_number text,
  po_date date,
  needed_by date,
  payment_type text check (payment_type in ('Prepaid', 'Credit', 'COD', 'Cheque', 'FOC')),
  courier_pref text,
  notes text,

  source text not null default 'blank',     -- paste / screenshot / po_file / blank / email
  source_text text,                         -- the message exactly as pasted or read
  estimate_value numeric(12, 2) not null default 0,
  missing text[] not null default '{}',     -- ✱✱ details still needed before dispatch planning

  -- filled in Phase 4
  invoice_no text,
  invoice_date date,
  invoice_value numeric(12, 2),
  shared_with uuid references public.people (id) on delete set null,
  dispatch_date date,
  courier text,
  tracking_no text,
  boxes int,
  dispatch_note text,
  delivered_at timestamptz,
  ee_uploaded_at timestamptz,
  hold_reason text,
  cancel_reason text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.orders (stage);
create index on public.orders (received_at desc);
create index on public.orders (customer_id);
create index on public.orders (po_number);

create table public.order_lines (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  line_no int not null,
  sku text not null references public.products (sku),
  qty int not null check (qty > 0),
  price_basis text check (price_basis in ('mrp_minus_margin', 'po_rate', 'agreed_rate', 'foc')),
  margin_pct numeric(5, 2),
  rate numeric(12, 2),                     -- per unit, including GST
  value numeric(12, 2) not null default 0, -- rate × qty
  -- copies at the time of the order
  product_name text,
  mrp numeric(10, 2),
  gst_rate numeric(4, 2),
  hsn text,
  ean text,
  tally_name text,
  typed_as text                            -- what the message said, e.g. "dill pikle"
);
create index on public.order_lines (order_id);
create index on public.order_lines (sku);

create table public.order_files (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  path text not null,                      -- in the private "order-files" storage bucket
  kind text not null default 'message' check (kind in ('message', 'screenshot', 'po', 'invoice', 'tracking', 'grn', 'other')),
  name text,
  size_bytes int,
  uploaded_by uuid references public.people (id) on delete set null,
  created_at timestamptz not null default now()
);
create index on public.order_files (order_id);

create table public.order_notes (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  person_id uuid references public.people (id) on delete set null,
  body text not null check (length(trim(body)) > 0),
  created_at timestamptz not null default now()
);
create index on public.order_notes (order_id, created_at);

alter table public.orders enable row level security;
alter table public.order_lines enable row level security;
alter table public.order_files enable row level security;
alter table public.order_notes enable row level security;
create policy orders_read on public.orders for select to authenticated using (public.me_ok());
create policy order_lines_read on public.order_lines for select to authenticated using (public.me_ok());
create policy order_files_read on public.order_files for select to authenticated using (public.me_ok());
create policy order_notes_read on public.order_notes for select to authenticated using (public.me_ok());
revoke all on public.orders, public.order_lines, public.order_files, public.order_notes from anon;
revoke insert, update, delete, truncate on public.orders, public.order_lines, public.order_files, public.order_notes from authenticated;

-- ---------- Files: a private bucket only logged-in team members can read and add to ----------

insert into storage.buckets (id, name, public, file_size_limit)
values ('order-files', 'order-files', false, 10485760)
on conflict (id) do nothing;

create policy order_files_bucket_read on storage.objects for select to authenticated
  using (bucket_id = 'order-files' and public.me_ok());
create policy order_files_bucket_add on storage.objects for insert to authenticated
  with check (bucket_id = 'order-files' and public.me_ok());

-- ---------- What's still missing before an order can be planned for dispatch (✱✱) ----------

create or replace function public.order_missing(o public.orders)
returns text[]
language plpgsql
stable
set search_path = public
as $$
declare
  m text[] := '{}';
  po_channel boolean := o.channel in ('Blinkit', 'Foodstories', 'Food Square', 'Other retail chains / corporates');
begin
  if po_channel and coalesce(o.po_number, '') = '' then m := m || 'PO number'; end if;
  if po_channel and o.po_date is null then m := m || 'PO date'; end if;
  if o.gst_status is null then m := m || 'GST status'; end if;
  if o.gst_status = 'registered' and coalesce(o.gstin, '') = '' then m := m || 'GSTIN'; end if;
  if coalesce(o.billing_address, '') = '' then m := m || 'billing address'; end if;
  if coalesce(o.billing_state, '') = '' then m := m || 'billing state'; end if;
  if coalesce(o.billing_pin, '') = '' then m := m || 'billing PIN'; end if;
  if coalesce(o.payment_terms, '') = '' then m := m || 'payment terms'; end if;
  if coalesce(o.delivery_address, '') = '' then m := m || 'delivery address'; end if;
  if coalesce(o.delivery_state, '') = '' then m := m || 'delivery state'; end if;
  if coalesce(o.delivery_pin, '') = '' then m := m || 'delivery PIN'; end if;
  if o.payment_type is null then m := m || 'payment type'; end if;
  if exists (select 1 from public.order_lines l where l.order_id = o.id and (l.price_basis is null or l.rate is null)) then
    m := m || 'price for every product';
  end if;
  return m;
end;
$$;

-- ---------- Saving an order ----------

-- Creates or edits an order with its lines in one go. Returns the order id.
-- p: order fields + "lines": [{sku, qty, price_basis, margin_pct, rate, typed_as}]
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

  update public.orders set
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
    po_date = nullif(p ->> 'po_date', '')::date,
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

-- Records an uploaded file against an order (the file itself is uploaded straight to storage).
create or replace function public.add_order_file(p_order uuid, p_path text, p_kind text, p_name text, p_size int)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.me_ok() then raise exception 'Please log in again.'; end if;
  insert into public.order_files (order_id, path, kind, name, size_bytes, uploaded_by)
  values (p_order, p_path, coalesce(nullif(p_kind, ''), 'other'), p_name, p_size, auth.uid());
end;
$$;

create or replace function public.add_order_note(p_order uuid, p_body text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.me_ok() then raise exception 'Please log in again.'; end if;
  insert into public.order_notes (order_id, person_id, body) values (p_order, auth.uid(), trim(p_body));
end;
$$;

-- On hold / back to new / cancel. Ops and admins (Phase 4 adds the other stages).
create or replace function public.set_order_hold(p_order uuid, p_action text, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  o public.orders;
begin
  if coalesce(public.my_role(), '') not in ('super_admin', 'admin', 'ops') then
    raise exception 'Only ops and admins can put orders on hold or cancel them.';
  end if;
  select * into o from public.orders where id = p_order;
  if not found then raise exception 'Order not found.'; end if;
  if p_action in ('hold', 'cancel') and nullif(trim(p_reason), '') is null then raise exception 'Please give a reason.'; end if;
  if p_action = 'hold' then
    update public.orders set stage = 'on_hold', hold_reason = trim(p_reason), updated_at = now() where id = p_order;
    perform public.log_activity('order_on_hold', public.my_name() || ' put ' || o.order_no || ' on hold: ' || trim(p_reason), 'order', p_order::text);
  elsif p_action = 'cancel' then
    update public.orders set stage = 'cancelled', cancel_reason = trim(p_reason), updated_at = now() where id = p_order;
    perform public.log_activity('order_cancelled', public.my_name() || ' cancelled ' || o.order_no || ': ' || trim(p_reason), 'order', p_order::text);
  elsif p_action = 'resume' then
    update public.orders set stage = 'new', hold_reason = null, updated_at = now() where id = p_order;
    perform public.log_activity('order_resumed', public.my_name() || ' took ' || o.order_no || ' off hold', 'order', p_order::text);
  else
    raise exception 'Unknown action.';
  end if;
end;
$$;

-- The order form learns: "dill pikle" → PCDP01 is remembered for next time. Anyone in the team.
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
  do update set sku = excluded.sku, status = 'confirmed', times_seen = product_aliases.times_seen + 1;
end;
$$;

-- …and remembers that "Colaba outlet" or "BANDRA WOODSIDEINN" means a particular customer.
create or replace function public.learn_customer_alias(p_customer uuid, p_alias text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.me_ok() then raise exception 'Please log in again.'; end if;
  if public.norm(p_alias) = '' or length(public.norm(p_alias)) > 80 then return; end if;
  insert into public.customer_aliases (customer_id, alias, alias_norm) values (p_customer, trim(p_alias), public.norm(p_alias))
  on conflict do nothing;
end;
$$;

revoke all on function public.save_order(uuid, jsonb), public.add_order_file(uuid, text, text, text, int), public.add_order_note(uuid, text),
  public.set_order_hold(uuid, text, text), public.learn_alias(text, text), public.learn_customer_alias(uuid, text),
  public.order_missing(public.orders) from public, anon;
grant execute on function public.save_order(uuid, jsonb), public.add_order_file(uuid, text, text, text, int), public.add_order_note(uuid, text),
  public.set_order_hold(uuid, text, text), public.learn_alias(text, text), public.learn_customer_alias(uuid, text) to authenticated;

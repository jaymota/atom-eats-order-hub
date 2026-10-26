-- Phase 2: products (Easy Ecom SKUs are the master codes) and customers.
--
-- Easy Ecom is the mother ship: every order line must carry an SKU exactly as Easy Ecom
-- has it, because a bulk order import is uploaded there every evening. Every other name
-- for a product (Tally item, Shopify / Amazon code, barcode, nickname, a customer's own
-- item code) is only an alias that points to an Easy Ecom SKU.

-- ---------- Products ----------

create table public.products (
  sku text primary key,                 -- exactly as in Easy Ecom (without Easy Ecom's leading ` mark)
  name text not null,                   -- Easy Ecom product name
  mrp numeric(10, 2),
  weight_g int,
  ee_type text,                         -- Easy Ecom: Normal / Child / Combo
  gst_rate numeric(4, 2) not null default 5,
  hsn text,
  ean text,
  image_url text,
  tally_name text,                      -- Tally stock item name, shown to accounts on every order
  tally_status text not null default 'none' check (tally_status in ('none', 'suggested', 'confirmed')),
  is_offline boolean not null default false,  -- the SKU the team uses for offline orders
  replaced_by text references public.products (sku),  -- old SKU → the master SKU to use instead
  is_retail boolean not null default false,   -- one of the ~40 SKUs sold to retail stores
  in_easy_ecom boolean not null default true, -- present in the latest Easy Ecom product export
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.products (is_offline) where is_offline;

-- What goes inside a combo or gift box (used to split demand into packs for the stock screen).
create table public.combo_items (
  combo_sku text not null references public.products (sku) on delete cascade,
  component_sku text not null references public.products (sku),
  qty int not null check (qty > 0),
  primary key (combo_sku, component_sku)
);

-- Searchable other names for a product.
create table public.product_aliases (
  id bigint generated always as identity primary key,
  sku text not null references public.products (sku) on delete cascade,
  alias text not null,
  alias_norm text not null,             -- lower-case, tidied version used for matching
  kind text not null check (kind in ('ee_name', 'tally', 'shopify', 'amazon', 'old_sku', 'ean', 'customer_code', 'nickname', 'retail_form')),
  customer_id uuid,                     -- set for a customer's own item code (e.g. Blinkit item no.)
  status text not null default 'confirmed' check (status in ('suggested', 'confirmed', 'rejected')),
  source text,                          -- where it came from, e.g. "retail form (12 times)"
  times_seen int not null default 1,
  created_by uuid references public.people (id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index product_aliases_unique on public.product_aliases (alias_norm, kind, coalesce(customer_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index on public.product_aliases (sku);
create index on public.product_aliases (status) where status = 'suggested';

-- ---------- Customers ----------

create sequence public.customer_code_seq;

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  code text not null unique default ('AE-' || lpad(nextval('public.customer_code_seq')::text, 4, '0')),
  name text not null,
  default_channel text,                 -- e.g. Blinkit, Foodstories, Retail (field sales), B2B
  gst_status text check (gst_status in ('registered', 'unregistered')),
  gstin text,
  fssai text,
  contact_name text,
  phone text,
  email text,
  billing_address text,
  billing_city text,
  billing_state text,
  billing_pin text,
  payment_terms text,                   -- advance / credit / COD / FOC
  credit_days int,
  default_margin numeric(5, 2),
  tally_name text,
  in_easy_ecom boolean not null default false,  -- already in Easy Ecom's customer list
  in_tally boolean not null default false,
  source text,                          -- where the record first came from
  notes text,
  active boolean not null default true,
  merged_into uuid references public.customers (id),
  created_by uuid references public.people (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.customers (gstin);
create index on public.customers (phone);

-- Many delivery addresses per customer (Blinkit warehouses, Foodstories stores, …).
create table public.customer_addresses (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete cascade,
  label text,                           -- e.g. "Bhiwandi warehouse"
  name text,
  address text,
  city text,
  state text,
  pin text,
  gstin text,
  contact_name text,
  phone text,
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);
create index on public.customer_addresses (customer_id);

-- Other names a customer is known by ("Beautiful Matunga", "Zomato Bhiwandi").
create table public.customer_aliases (
  id bigint generated always as identity primary key,
  customer_id uuid not null references public.customers (id) on delete cascade,
  alias text not null,
  alias_norm text not null,
  created_at timestamptz not null default now(),
  unique (customer_id, alias_norm)
);
create index on public.customer_aliases (alias_norm);

-- Possible duplicate customers waiting for an admin to decide.
create table public.customer_duplicates (
  id bigint generated always as identity primary key,
  customer_a uuid not null references public.customers (id) on delete cascade,
  customer_b uuid not null references public.customers (id) on delete cascade,
  reason text not null,                 -- "same GSTIN", "very similar name", …
  score numeric(4, 3) not null default 0,
  status text not null default 'pending' check (status in ('pending', 'merged', 'kept_separate')),
  decided_by uuid references public.people (id) on delete set null,
  decided_at timestamptz,
  unique (customer_a, customer_b)
);

-- ---------- Row Level Security: everyone in the team reads; changes go through the functions below ----------

alter table public.products enable row level security;
alter table public.combo_items enable row level security;
alter table public.product_aliases enable row level security;
alter table public.customers enable row level security;
alter table public.customer_addresses enable row level security;
alter table public.customer_aliases enable row level security;
alter table public.customer_duplicates enable row level security;

create policy products_read on public.products for select to authenticated using (public.me_ok());
create policy combo_items_read on public.combo_items for select to authenticated using (public.me_ok());
create policy product_aliases_read on public.product_aliases for select to authenticated using (public.me_ok());
create policy customers_read on public.customers for select to authenticated using (public.me_ok());
create policy customer_addresses_read on public.customer_addresses for select to authenticated using (public.me_ok());
create policy customer_aliases_read on public.customer_aliases for select to authenticated using (public.me_ok());
create policy customer_duplicates_read on public.customer_duplicates for select to authenticated using (public.me_ok());

revoke all on public.products, public.combo_items, public.product_aliases, public.customers,
  public.customer_addresses, public.customer_aliases, public.customer_duplicates from anon;
revoke insert, update, delete, truncate on public.products, public.combo_items, public.product_aliases,
  public.customers, public.customer_addresses, public.customer_aliases, public.customer_duplicates from authenticated;

-- ---------- Helpers ----------

-- The same tidy-up the website uses for matching: lower case, letters/digits/spaces only.
create or replace function public.norm(t text)
returns text
language sql
immutable
as $$
  select trim(regexp_replace(regexp_replace(lower(coalesce(t, '')), '[^a-z0-9]+', ' ', 'g'), '\s+', ' ', 'g'));
$$;

create or replace function public.log_activity(p_kind text, p_summary text, p_type text, p_id text, p_detail jsonb default '{}')
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.activity (person_id, kind, summary, entity_type, entity_id, detail)
  values (auth.uid(), p_kind, p_summary, p_type, p_id, coalesce(p_detail, '{}'));
$$;
revoke all on function public.log_activity(text, text, text, text, jsonb) from public, anon, authenticated;

create or replace function public.my_name()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select name from public.people where id = auth.uid();
$$;
revoke all on function public.my_name() from public, anon;

-- ---------- Product changes (admins) ----------

-- Edit the Hub-only details of a product. Easy Ecom fields (SKU, name, MRP) come from the
-- Easy Ecom export and are not changed here.
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
  update public.products set
    is_offline = coalesce((p ->> 'is_offline')::boolean, is_offline),
    is_retail = coalesce((p ->> 'is_retail')::boolean, is_retail),
    hsn = case when p ? 'hsn' then nullif(trim(p ->> 'hsn'), '') else hsn end,
    ean = case when p ? 'ean' then nullif(regexp_replace(p ->> 'ean', '\D', '', 'g'), '') else ean end,
    replaced_by = case when p ? 'replaced_by' then nullif(trim(p ->> 'replaced_by'), '') else replaced_by end,
    notes = case when p ? 'notes' then nullif(trim(p ->> 'notes'), '') else notes end,
    updated_at = now()
  where sku = p_sku;
  perform public.log_activity('product_updated', public.my_name() || ' changed product ' || p_sku || ' (' || old.name || ')', 'product', p_sku, p);
end;
$$;

-- Set (and confirm) the Tally stock item name for a product. Admins and accounts.
create or replace function public.set_tally_name(p_sku text, p_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := nullif(trim(p_name), '');
begin
  if coalesce(public.my_role(), '') not in ('super_admin', 'admin', 'accounts') then
    raise exception 'Only admins and accounts can change Tally names.';
  end if;
  update public.products
    set tally_name = v_name, tally_status = case when v_name is null then 'none' else 'confirmed' end, updated_at = now()
    where sku = p_sku;
  if not found then raise exception 'Product % not found.', p_sku; end if;
  if v_name is not null then
    insert into public.product_aliases (sku, alias, alias_norm, kind, status, source, created_by)
    values (p_sku, v_name, public.norm(v_name), 'tally', 'confirmed', 'confirmed in the Hub', auth.uid())
    on conflict (alias_norm, kind, coalesce(customer_id, '00000000-0000-0000-0000-000000000000'::uuid))
    do update set sku = excluded.sku, status = 'confirmed';
  end if;
  perform public.log_activity('tally_name_set',
    public.my_name() || ' set the Tally name of ' || p_sku || ' to “' || coalesce(v_name, 'none') || '”', 'product', p_sku);
end;
$$;

-- Accept, reject or re-point a suggested alias (nickname). Admins.
create or replace function public.review_alias(p_id bigint, p_accept boolean, p_sku text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  a public.product_aliases;
begin
  if not public.is_admin() then raise exception 'Only admins can review nicknames.'; end if;
  select * into a from public.product_aliases where id = p_id;
  if not found then raise exception 'Nickname not found.'; end if;
  if p_accept then
    if p_sku is not null and not exists (select 1 from public.products where sku = p_sku) then
      raise exception 'Product % not found.', p_sku;
    end if;
    update public.product_aliases set status = 'confirmed', sku = coalesce(p_sku, sku) where id = p_id;
    perform public.log_activity('alias_confirmed',
      public.my_name() || ' confirmed “' || a.alias || '” means ' || coalesce(p_sku, a.sku), 'product', coalesce(p_sku, a.sku));
  else
    update public.product_aliases set status = 'rejected' where id = p_id;
    perform public.log_activity('alias_rejected', public.my_name() || ' rejected the nickname “' || a.alias || '”', 'product', a.sku);
  end if;
end;
$$;

-- Add a nickname or other name for a product by hand. Admins.
create or replace function public.add_alias(p_sku text, p_alias text, p_kind text default 'nickname')
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'Only admins can add nicknames.'; end if;
  if public.norm(p_alias) = '' then raise exception 'Please type a name.'; end if;
  insert into public.product_aliases (sku, alias, alias_norm, kind, status, source, created_by)
  values (p_sku, trim(p_alias), public.norm(p_alias), p_kind, 'confirmed', 'added in the Hub', auth.uid())
  on conflict (alias_norm, kind, coalesce(customer_id, '00000000-0000-0000-0000-000000000000'::uuid))
  do update set sku = excluded.sku, status = 'confirmed';
  perform public.log_activity('alias_added', public.my_name() || ' added “' || trim(p_alias) || '” as a name for ' || p_sku, 'product', p_sku);
end;
$$;

-- ---------- Customer changes ----------

-- Add or edit a customer. Anyone in the team can (orders need customers); returns the id.
create or replace function public.save_customer(p_id uuid, p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid := p_id;
  v_name text := nullif(trim(p ->> 'name'), '');
  v_gstin text := nullif(upper(regexp_replace(coalesce(p ->> 'gstin', ''), '\s', '', 'g')), '');
begin
  if not public.me_ok() then raise exception 'Please log in again.'; end if;
  if v_gstin is not null and v_gstin !~ '^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]Z[0-9A-Z]$' then
    raise exception 'The GSTIN % doesn’t look right (it should be 15 characters, like 27AAACZ8867B1Z0).', v_gstin;
  end if;
  if v_id is null then
    if v_name is null then raise exception 'Please enter the customer name.'; end if;
    insert into public.customers (name, created_by, source) values (v_name, auth.uid(), 'added in the Hub') returning id into v_id;
    perform public.log_activity('customer_added', public.my_name() || ' added customer ' || v_name, 'customer', v_id::text);
  else
    perform public.log_activity('customer_updated', public.my_name() || ' changed customer ' || coalesce(v_name, (select name from public.customers where id = v_id)), 'customer', v_id::text, p);
  end if;
  update public.customers set
    name = coalesce(v_name, name),
    default_channel = case when p ? 'default_channel' then nullif(trim(p ->> 'default_channel'), '') else default_channel end,
    gstin = case when p ? 'gstin' then v_gstin else gstin end,
    gst_status = case when p ? 'gst_status' then nullif(p ->> 'gst_status', '')
                      when p ? 'gstin' and v_gstin is not null then 'registered' else gst_status end,
    fssai = case when p ? 'fssai' then nullif(trim(p ->> 'fssai'), '') else fssai end,
    contact_name = case when p ? 'contact_name' then nullif(trim(p ->> 'contact_name'), '') else contact_name end,
    phone = case when p ? 'phone' then nullif(trim(p ->> 'phone'), '') else phone end,
    email = case when p ? 'email' then nullif(lower(trim(p ->> 'email')), '') else email end,
    billing_address = case when p ? 'billing_address' then nullif(trim(p ->> 'billing_address'), '') else billing_address end,
    billing_city = case when p ? 'billing_city' then nullif(trim(p ->> 'billing_city'), '') else billing_city end,
    billing_state = case when p ? 'billing_state' then nullif(trim(p ->> 'billing_state'), '') else billing_state end,
    billing_pin = case when p ? 'billing_pin' then nullif(regexp_replace(p ->> 'billing_pin', '\D', '', 'g'), '') else billing_pin end,
    payment_terms = case when p ? 'payment_terms' then nullif(p ->> 'payment_terms', '') else payment_terms end,
    credit_days = case when p ? 'credit_days' then nullif(p ->> 'credit_days', '')::int else credit_days end,
    default_margin = case when p ? 'default_margin' then nullif(p ->> 'default_margin', '')::numeric else default_margin end,
    tally_name = case when p ? 'tally_name' then nullif(trim(p ->> 'tally_name'), '') else tally_name end,
    notes = case when p ? 'notes' then nullif(trim(p ->> 'notes'), '') else notes end,
    updated_at = now()
  where id = v_id;
  return v_id;
end;
$$;

-- Add or edit one delivery address. Anyone in the team.
create or replace function public.save_address(p_id uuid, p_customer uuid, p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid := p_id;
begin
  if not public.me_ok() then raise exception 'Please log in again.'; end if;
  if v_id is null then
    insert into public.customer_addresses (customer_id) values (p_customer) returning id into v_id;
  end if;
  update public.customer_addresses set
    label = nullif(trim(p ->> 'label'), ''),
    name = nullif(trim(p ->> 'name'), ''),
    address = nullif(trim(p ->> 'address'), ''),
    city = nullif(trim(p ->> 'city'), ''),
    state = nullif(trim(p ->> 'state'), ''),
    pin = nullif(regexp_replace(coalesce(p ->> 'pin', ''), '\D', '', 'g'), ''),
    gstin = nullif(upper(trim(p ->> 'gstin')), ''),
    contact_name = nullif(trim(p ->> 'contact_name'), ''),
    phone = nullif(trim(p ->> 'phone'), '')
  where id = v_id;
  perform public.log_activity('address_saved',
    public.my_name() || ' saved a delivery address for ' || (select name from public.customers where id = p_customer), 'customer', p_customer::text);
  return v_id;
end;
$$;

create or replace function public.delete_address(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer uuid;
begin
  if not public.me_ok() then raise exception 'Please log in again.'; end if;
  delete from public.customer_addresses where id = p_id returning customer_id into v_customer;
  perform public.log_activity('address_deleted',
    public.my_name() || ' removed a delivery address from ' || (select name from public.customers where id = v_customer), 'customer', v_customer::text);
end;
$$;

-- Merge customer "drop" into "keep": addresses, nicknames and missing details move across,
-- then "drop" is switched off and points to "keep". Admins.
create or replace function public.merge_customers(p_keep uuid, p_drop uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  k public.customers;
  d public.customers;
begin
  if not public.is_admin() then raise exception 'Only admins can merge customers.'; end if;
  if p_keep = p_drop then raise exception 'Choose two different customers.'; end if;
  select * into k from public.customers where id = p_keep;
  select * into d from public.customers where id = p_drop;
  if k.id is null or d.id is null then raise exception 'Customer not found.'; end if;

  update public.customers set
    gstin = coalesce(gstin, d.gstin), gst_status = coalesce(gst_status, d.gst_status), fssai = coalesce(fssai, d.fssai),
    contact_name = coalesce(contact_name, d.contact_name), phone = coalesce(phone, d.phone), email = coalesce(email, d.email),
    billing_address = coalesce(billing_address, d.billing_address), billing_city = coalesce(billing_city, d.billing_city),
    billing_state = coalesce(billing_state, d.billing_state), billing_pin = coalesce(billing_pin, d.billing_pin),
    payment_terms = coalesce(payment_terms, d.payment_terms), credit_days = coalesce(credit_days, d.credit_days),
    default_margin = coalesce(default_margin, d.default_margin), tally_name = coalesce(tally_name, d.tally_name),
    default_channel = coalesce(default_channel, d.default_channel),
    in_easy_ecom = in_easy_ecom or d.in_easy_ecom, in_tally = in_tally or d.in_tally,
    notes = nullif(concat_ws(E'\n', notes, d.notes), ''), updated_at = now()
  where id = p_keep;

  update public.customer_addresses set customer_id = p_keep, is_default = false where customer_id = p_drop;
  insert into public.customer_aliases (customer_id, alias, alias_norm)
    select p_keep, d.name, public.norm(d.name) on conflict do nothing;
  insert into public.customer_aliases (customer_id, alias, alias_norm)
    select p_keep, alias, alias_norm from public.customer_aliases where customer_id = p_drop on conflict do nothing;
  delete from public.customer_aliases where customer_id = p_drop;
  update public.product_aliases set customer_id = p_keep where customer_id = p_drop;

  update public.customers set active = false, merged_into = p_keep, updated_at = now() where id = p_drop;
  update public.customer_duplicates set status = 'merged', decided_by = auth.uid(), decided_at = now()
    where (customer_a = p_keep and customer_b = p_drop) or (customer_a = p_drop and customer_b = p_keep);
  -- Other pending pairs that involved the merged-away customer now point at the kept one.
  delete from public.customer_duplicates
    where status = 'pending' and ((customer_a = p_drop and customer_b = p_keep) or (customer_a = p_keep and customer_b = p_drop));
  update public.customer_duplicates set customer_a = p_keep where status = 'pending' and customer_a = p_drop and customer_b <> p_keep
    and not exists (select 1 from public.customer_duplicates x where x.customer_a = p_keep and x.customer_b = customer_duplicates.customer_b);
  update public.customer_duplicates set customer_b = p_keep where status = 'pending' and customer_b = p_drop and customer_a <> p_keep
    and not exists (select 1 from public.customer_duplicates x where x.customer_b = p_keep and x.customer_a = customer_duplicates.customer_a);
  delete from public.customer_duplicates where status = 'pending' and (customer_a = p_drop or customer_b = p_drop);

  perform public.log_activity('customers_merged',
    public.my_name() || ' merged “' || d.name || '” into “' || k.name || '”', 'customer', p_keep::text,
    jsonb_build_object('merged_away', p_drop));
end;
$$;

create or replace function public.keep_separate(p_pair bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  a text; b text;
begin
  if not public.is_admin() then raise exception 'Only admins can decide on duplicates.'; end if;
  update public.customer_duplicates set status = 'kept_separate', decided_by = auth.uid(), decided_at = now() where id = p_pair;
  select ca.name, cb.name into a, b from public.customer_duplicates x
    join public.customers ca on ca.id = x.customer_a join public.customers cb on cb.id = x.customer_b where x.id = p_pair;
  perform public.log_activity('customers_kept_separate', public.my_name() || ' kept “' || a || '” and “' || b || '” as separate customers', 'customer', null);
end;
$$;

revoke all on function public.save_product(text, jsonb), public.set_tally_name(text, text), public.review_alias(bigint, boolean, text),
  public.add_alias(text, text, text), public.save_customer(uuid, jsonb), public.save_address(uuid, uuid, jsonb),
  public.delete_address(uuid), public.merge_customers(uuid, uuid), public.keep_separate(bigint) from public, anon;
grant execute on function public.save_product(text, jsonb), public.set_tally_name(text, text), public.review_alias(bigint, boolean, text),
  public.add_alias(text, text, text), public.save_customer(uuid, jsonb), public.save_address(uuid, uuid, jsonb),
  public.delete_address(uuid), public.merge_customers(uuid, uuid), public.keep_separate(bigint) to authenticated;

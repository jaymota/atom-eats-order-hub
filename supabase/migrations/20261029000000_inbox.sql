-- Phase 6: POs that arrive by email at sales@atomconsulting.in.
-- A small Google Apps Script inside that mailbox sends each new email with attachments to the
-- "inbox" Edge Function every 15 minutes. Nothing here can read the mailbox itself.

-- Who sends us POs (editable). match = part of the sender's address, e.g. "partnersbiz.com".
create table public.inbox_senders (
  id serial primary key,
  match text not null unique,
  source text not null,                -- blinkit / foodstories / foodsquare / other name
  active boolean not null default true
);
insert into public.inbox_senders (match, source) values
  ('ordering@partnersbiz.com', 'blinkit'),
  ('partnersbiz.com', 'blinkit'),
  ('com@foodstories.shop', 'foodstories'),
  ('foodstories.shop', 'foodstories'),
  ('landcraftretail.com', 'foodsquare');

create table public.inbox_emails (
  id uuid primary key default gen_random_uuid(),
  gmail_id text not null unique,       -- so the same email is never taken twice
  thread_id text,
  from_addr text not null,
  from_name text,
  subject text not null default '',
  received_at timestamptz not null,
  body_text text,
  source text,                         -- blinkit / foodstories / foodsquare / forwarded / null = unknown
  kind text not null default 'po' check (kind in ('po', 'revised', 'grn', 'other')),
  status text not null default 'new' check (status in ('new', 'done', 'ignored')),
  order_id uuid references public.orders (id) on delete set null,
  handled_by uuid references public.people (id) on delete set null,
  handled_at timestamptz,
  note text,
  created_at timestamptz not null default now()
);
create index on public.inbox_emails (status, received_at desc);

create table public.inbox_files (
  id uuid primary key default gen_random_uuid(),
  email_id uuid not null references public.inbox_emails (id) on delete cascade,
  path text not null,                  -- in the private "order-files" bucket, under inbox/
  name text not null,
  mime text,
  size_bytes int
);
create index on public.inbox_files (email_id);

alter table public.inbox_senders enable row level security;
alter table public.inbox_emails enable row level security;
alter table public.inbox_files enable row level security;
create policy inbox_senders_read on public.inbox_senders for select to authenticated using (public.me_ok());
create policy inbox_emails_read on public.inbox_emails for select to authenticated using (public.me_ok());
create policy inbox_files_read on public.inbox_files for select to authenticated using (public.me_ok());
revoke all on public.inbox_senders, public.inbox_emails, public.inbox_files from anon;
revoke insert, update, delete, truncate on public.inbox_senders, public.inbox_emails, public.inbox_files from authenticated;

-- An email PO became an order (or a GRN was attached to one): it leaves the "To confirm" list.
create or replace function public.inbox_done(p_email uuid, p_order uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  e public.inbox_emails;
  o public.orders;
  f public.inbox_files;
begin
  if not public.me_ok() then raise exception 'Please log in again.'; end if;
  select * into e from public.inbox_emails where id = p_email for update;
  if not found then raise exception 'Email not found.'; end if;
  select * into o from public.orders where id = p_order;
  if not found then raise exception 'Order not found.'; end if;
  update public.inbox_emails set status = 'done', order_id = p_order, handled_by = auth.uid(), handled_at = now() where id = p_email;
  -- A GRN's files go onto the order it belongs to.
  if e.kind = 'grn' then
    for f in select * from public.inbox_files where email_id = p_email loop
      insert into public.order_files (order_id, path, kind, name, size_bytes, uploaded_by) values (p_order, f.path, 'grn', f.name, f.size_bytes, auth.uid());
    end loop;
    perform public.log_activity('order_grn', public.my_name() || ' attached the GRN email “' || e.subject || '” to ' || o.order_no, 'order', p_order::text);
  else
    perform public.log_activity('order_from_email', o.order_no || ' came from the email “' || e.subject || '” (' || e.from_addr || ')', 'order', p_order::text);
  end if;
end;
$$;

create or replace function public.inbox_ignore(p_email uuid, p_note text default null, p_undo boolean default false)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.me_ok() then raise exception 'Please log in again.'; end if;
  update public.inbox_emails set status = case when p_undo then 'new' else 'ignored' end, note = nullif(trim(p_note), ''),
    handled_by = auth.uid(), handled_at = now()
  where id = p_email;
end;
$$;

-- Admins edit the known-sender list.
create or replace function public.save_inbox_sender(p_match text, p_source text, p_active boolean default true)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'Only admins can change this.'; end if;
  if nullif(trim(p_match), '') is null or nullif(trim(p_source), '') is null then raise exception 'Please give the sender and the name.'; end if;
  insert into public.inbox_senders (match, source, active) values (lower(trim(p_match)), lower(trim(p_source)), p_active)
  on conflict (match) do update set source = excluded.source, active = excluded.active;
end;
$$;

-- The buyer's own item code (Foodstories article code, Food Square item code, Blinkit item code),
-- remembered once someone confirms which product it is. Kept per customer when we know the customer.
create or replace function public.learn_item_code(p_sku text, p_code text, p_customer uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v text := trim(coalesce(p_code, ''));
begin
  if not public.me_ok() then raise exception 'Please log in again.'; end if;
  if length(v) < 4 or not exists (select 1 from public.products where sku = p_sku) then return; end if;
  insert into public.product_aliases (sku, alias, alias_norm, kind, status, source, customer_id, created_by)
  values (p_sku, v, lower(v), 'customer_code', 'confirmed', 'learned from a PO', p_customer, auth.uid())
  on conflict (alias_norm, kind, coalesce(customer_id, '00000000-0000-0000-0000-000000000000'::uuid)) do nothing;
end;
$$;

revoke all on function public.inbox_done(uuid, uuid), public.inbox_ignore(uuid, text, boolean), public.save_inbox_sender(text, text, boolean),
  public.learn_item_code(text, text, uuid) from public, anon;
grant execute on function public.inbox_done(uuid, uuid), public.inbox_ignore(uuid, text, boolean), public.save_inbox_sender(text, text, boolean),
  public.learn_item_code(text, text, uuid) to authenticated;

-- GRNs read from the GRN emails (Blinkit / Zomato Hyperpure "Consolidated-GRN-Report"): one row per PO,
-- so the team can see which POs were already received and never send the same PO again.
create table public.grns (
  po_number text primary key,
  source text,
  email_id uuid references public.inbox_emails (id) on delete set null,
  grn_on date not null,                 -- the day the GRN email came
  qty_po numeric not null default 0,
  qty_grn numeric not null default 0,
  amount numeric not null default 0,
  lines jsonb not null default '[]',    -- [{ item, upc, qty_po, qty_grn, amount }]
  first_seen timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.grns enable row level security;
create policy grns_read on public.grns for select to authenticated using (public.me_ok());
revoke all on public.grns from anon;
revoke insert, update, delete, truncate on public.grns from authenticated;

-- Called by the inbox function once it has read the GRN file(s) of an email.
-- p_pos = [{ po_number, qty_po, qty_grn, amount, lines }]. The GRN files go onto every order with
-- that PO number, and the email leaves "To confirm" by itself.
create or replace function public.record_grn(p_email uuid, p_pos jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  e public.inbox_emails;
  p jsonb;
  o public.orders;
  first_order uuid;
  n int := 0;
begin
  select * into e from public.inbox_emails where id = p_email;
  if not found then raise exception 'Email not found.'; end if;
  for p in select * from jsonb_array_elements(coalesce(p_pos, '[]')) loop
    -- The same PO comes again in later daily reports: the newest one wins.
    insert into public.grns (po_number, source, email_id, grn_on, qty_po, qty_grn, amount, lines)
    values (p ->> 'po_number', e.source, e.id, (e.received_at at time zone 'Asia/Kolkata')::date,
      coalesce((p ->> 'qty_po')::numeric, 0), coalesce((p ->> 'qty_grn')::numeric, 0), coalesce((p ->> 'amount')::numeric, 0), coalesce(p -> 'lines', '[]'))
    on conflict (po_number) do update set source = excluded.source, email_id = excluded.email_id, grn_on = excluded.grn_on,
      qty_po = excluded.qty_po, qty_grn = excluded.qty_grn, amount = excluded.amount, lines = excluded.lines, updated_at = now()
    where grns.grn_on <= excluded.grn_on;
    n := n + 1;

    for o in select * from public.orders where po_number = p ->> 'po_number' and stage <> 'cancelled' loop
      first_order := coalesce(first_order, o.id);
      insert into public.order_files (order_id, path, kind, name, size_bytes)
        select o.id, f.path, 'grn', f.name, f.size_bytes from public.inbox_files f
        where f.email_id = p_email and not exists (select 1 from public.order_files x where x.order_id = o.id and x.path = f.path);
      perform public.log_activity('order_grn', 'GRN for PO ' || (p ->> 'po_number') || ' came by email: ' ||
        trim(to_char(coalesce((p ->> 'qty_grn')::numeric, 0), 'FM999999990')) || ' of ' || trim(to_char(coalesce((p ->> 'qty_po')::numeric, 0), 'FM999999990')) || ' received', 'order', o.id::text);
    end loop;
  end loop;
  if n > 0 then
    update public.inbox_emails set status = 'done', order_id = coalesce(first_order, order_id), handled_at = now(),
      note = n || ' PO' || case when n = 1 then '' else 's' end || ' read from the GRN'
    where id = p_email;
  end if;
  return n;
end;
$$;
revoke all on function public.record_grn(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.record_grn(uuid, jsonb) to service_role;

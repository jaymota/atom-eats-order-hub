-- Narrower access for two shared logins:
--   Sales (Vinay): only enters orders. Sees only the orders they entered themselves.
--   Accounts: sees invoices and dispatch, never places orders.

-- Orders: sales sees only their own; everyone else sees all.
drop policy if exists orders_read on public.orders;
create policy orders_read on public.orders for select to authenticated
  using (public.me_ok() and (public.my_role() <> 'sales' or created_by = auth.uid() or salesperson_id = auth.uid()));

-- Lines, files and notes follow their order (the orders rule above applies inside these checks).
drop policy if exists order_lines_read on public.order_lines;
create policy order_lines_read on public.order_lines for select to authenticated
  using (public.me_ok() and exists (select 1 from public.orders o where o.id = order_id));
drop policy if exists order_files_read on public.order_files;
create policy order_files_read on public.order_files for select to authenticated
  using (public.me_ok() and exists (select 1 from public.orders o where o.id = order_id));
drop policy if exists order_notes_read on public.order_notes;
create policy order_notes_read on public.order_notes for select to authenticated
  using (public.me_ok() and exists (select 1 from public.orders o where o.id = order_id));

-- The activity log: sales only sees their own actions.
drop policy if exists activity_read on public.activity;
create policy activity_read on public.activity for select to authenticated
  using (public.me_ok() and (public.my_role() <> 'sales' or person_id = auth.uid()));

-- Emailed POs ("To confirm"): not for sales or accounts.
drop policy if exists inbox_emails_read on public.inbox_emails;
create policy inbox_emails_read on public.inbox_emails for select to authenticated
  using (public.me_ok() and public.my_role() not in ('sales', 'accounts'));
drop policy if exists inbox_files_read on public.inbox_files;
create policy inbox_files_read on public.inbox_files for select to authenticated
  using (public.me_ok() and public.my_role() not in ('sales', 'accounts'));
drop policy if exists inbox_senders_read on public.inbox_senders;
create policy inbox_senders_read on public.inbox_senders for select to authenticated
  using (public.me_ok() and public.my_role() not in ('sales', 'accounts'));

-- Accounts never places or changes orders (invoices and dispatch only).
create or replace function public.no_orders_for_accounts()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if public.my_role() = 'accounts' then raise exception 'The accounts login can’t place or change orders.'; end if;
  return coalesce(new, old); -- (a BEFORE DELETE trigger must hand back the old row)
end;
$$;
create trigger orders_not_by_accounts before insert on public.orders for each row execute function public.no_orders_for_accounts();
create trigger order_lines_not_by_accounts before insert or delete on public.order_lines for each row execute function public.no_orders_for_accounts();

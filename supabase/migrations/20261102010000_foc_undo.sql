-- Undo for FOC orders sent straight to Dispatch.
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
  else
    raise exception 'You can’t undo this step.';
  end if;
end;
$$;

-- Fix: a name clash inside split_order.
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

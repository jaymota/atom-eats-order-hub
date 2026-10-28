-- Tracking often comes later than the parcel leaves. So:
--  * "Dispatched" needs only the date and courier (the docket number can be added later)
--  * update_tracking lets ops add or fix courier, docket, boxes and note on a dispatched / delivered order.

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
    update public.orders set stage = 'dispatched', dispatch_date = (r ->> 'dispatch_date')::date, courier = v_courier, tracking_no = v_track,
      boxes = nullif(r ->> 'boxes', '')::int, dispatch_note = nullif(trim(r ->> 'dispatch_note'), ''),
      dispatched_at = now(), dispatched_by = auth.uid(), updated_at = now()
    where id = o.id;
    perform public.log_activity('order_dispatched', public.my_name() || ' dispatched ' || o.order_no || ' by ' || v_courier
      || coalesce(' · ' || v_track, ' (tracking to follow)'), 'order', o.id::text);
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- p: {id, courier, tracking_no, boxes, dispatch_note, dispatch_date} — only the keys given are changed.
create or replace function public.update_tracking(p jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  o public.orders;
  said text[] := '{}';
begin
  if not public.my_role_in(array['ops']) then raise exception 'Only ops and admins can change tracking.'; end if;
  select * into o from public.orders where id = (p ->> 'id')::uuid for update;
  if not found then raise exception 'Order not found.'; end if;
  if o.stage not in ('dispatched', 'delivered') then raise exception '% is not dispatched yet.', o.order_no; end if;
  if p ? 'courier' and nullif(trim(p ->> 'courier'), '') is null then raise exception 'Courier?'; end if;
  if p ? 'courier' and trim(p ->> 'courier') is distinct from o.courier then said := said || ('courier ' || trim(p ->> 'courier')); end if;
  if p ? 'tracking_no' and nullif(trim(p ->> 'tracking_no'), '') is distinct from o.tracking_no then
    said := said || ('tracking ' || coalesce(nullif(trim(p ->> 'tracking_no'), ''), 'removed'));
  end if;
  if p ? 'boxes' and nullif(p ->> 'boxes', '')::int is distinct from o.boxes then said := said || ('boxes ' || coalesce(nullif(p ->> 'boxes', ''), '—')); end if;
  if p ? 'dispatch_date' and nullif(p ->> 'dispatch_date', '')::date is distinct from o.dispatch_date then said := said || ('date ' || (p ->> 'dispatch_date')); end if;
  update public.orders set
    courier = case when p ? 'courier' then trim(p ->> 'courier') else courier end,
    tracking_no = case when p ? 'tracking_no' then nullif(trim(p ->> 'tracking_no'), '') else tracking_no end,
    boxes = case when p ? 'boxes' then nullif(p ->> 'boxes', '')::int else boxes end,
    dispatch_note = case when p ? 'dispatch_note' then nullif(trim(p ->> 'dispatch_note'), '') else dispatch_note end,
    dispatch_date = coalesce(nullif(p ->> 'dispatch_date', '')::date, dispatch_date),
    updated_at = now()
  where id = o.id;
  if array_length(said, 1) > 0 then
    perform public.log_activity('order_tracking', public.my_name() || ' updated dispatch of ' || o.order_no || ': ' || array_to_string(said, ', '), 'order', o.id::text);
  end if;
end;
$$;

revoke all on function public.update_tracking(jsonb) from public, anon;
grant execute on function public.update_tracking(jsonb) to authenticated;

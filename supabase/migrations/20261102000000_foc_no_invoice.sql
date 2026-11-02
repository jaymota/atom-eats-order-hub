-- FOC (free samples, mostly marketing): no GST / billing / payment details needed, and no invoice:
-- planning an FOC order sends it straight to Dispatch.

create or replace function public.order_missing(o public.orders)
returns text[]
language plpgsql
stable
set search_path = public
as $$
declare
  m text[] := '{}';
  foc boolean := o.channel = 'FOC'; -- free samples: no invoice, so no GST, billing or payment details needed
begin
  if not foc then
    if o.gst_status is null then m := array_append(m, 'GST status'); end if;
    if o.gst_status = 'registered' and coalesce(o.gstin, '') = '' then m := array_append(m, 'GSTIN'); end if;
    if coalesce(o.billing_address, '') = '' then m := array_append(m, 'billing address'); end if;
    if coalesce(o.billing_state, '') = '' then m := array_append(m, 'billing state'); end if;
    if coalesce(o.billing_pin, '') = '' then m := array_append(m, 'billing PIN'); end if;
    if coalesce(o.payment_terms, '') = '' then m := array_append(m, 'payment terms'); end if;
  end if;
  if coalesce(o.delivery_address, '') = '' then m := array_append(m, 'delivery address'); end if;
  if coalesce(o.delivery_state, '') = '' then m := array_append(m, 'delivery state'); end if;
  if coalesce(o.delivery_pin, '') = '' then m := array_append(m, 'delivery PIN'); end if;
  if o.payment_type is null and not foc then m := array_append(m, 'payment type'); end if;
  if exists (select 1 from public.order_lines l where l.order_id = o.id and (l.price_basis is null or l.rate is null)) then
    m := array_append(m, 'price for every product');
  end if;
  return m;
end;
$$;

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
    if o.channel = 'FOC' then
      -- Free samples get no invoice: straight to "ready to dispatch".
      update public.orders set stage = 'invoiced', planned_at = now(), planned_by = auth.uid(), invoiced_at = now(), missing = '{}', updated_at = now() where id = o.id;
      perform public.log_activity('order_planned', public.my_name() || ' planned FOC order ' || o.order_no || ' — no invoice needed, ready to dispatch', 'order', o.id::text);
    else
      update public.orders set stage = 'planned', planned_at = now(), planned_by = auth.uid(), missing = '{}', updated_at = now() where id = o.id;
      perform public.log_activity('order_planned', public.my_name() || ' planned ' || o.order_no || ' for dispatch and sent it to accounts', 'order', o.id::text);
    end if;
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- FOC orders still waiting: recount what's missing under the new rule.
update public.orders o set missing = public.order_missing(o) where stage in ('sales_order', 'new', 'on_hold');

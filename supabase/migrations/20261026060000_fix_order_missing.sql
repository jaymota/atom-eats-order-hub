-- Fix: add each missing item to the list as text ("m || 'x'" was read as a list).
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
  if po_channel and coalesce(o.po_number, '') = '' then m := array_append(m, 'PO number'); end if;
  if po_channel and o.po_date is null then m := array_append(m, 'PO date'); end if;
  if o.gst_status is null then m := array_append(m, 'GST status'); end if;
  if o.gst_status = 'registered' and coalesce(o.gstin, '') = '' then m := array_append(m, 'GSTIN'); end if;
  if coalesce(o.billing_address, '') = '' then m := array_append(m, 'billing address'); end if;
  if coalesce(o.billing_state, '') = '' then m := array_append(m, 'billing state'); end if;
  if coalesce(o.billing_pin, '') = '' then m := array_append(m, 'billing PIN'); end if;
  if coalesce(o.payment_terms, '') = '' then m := array_append(m, 'payment terms'); end if;
  if coalesce(o.delivery_address, '') = '' then m := array_append(m, 'delivery address'); end if;
  if coalesce(o.delivery_state, '') = '' then m := array_append(m, 'delivery state'); end if;
  if coalesce(o.delivery_pin, '') = '' then m := array_append(m, 'delivery PIN'); end if;
  if o.payment_type is null then m := array_append(m, 'payment type'); end if;
  if exists (select 1 from public.order_lines l where l.order_id = o.id and (l.price_basis is null or l.rate is null)) then
    m := array_append(m, 'price for every product');
  end if;
  return m;
end;
$$;


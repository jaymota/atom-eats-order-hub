-- When someone confirms which product a PO barcode is, remember it (anyone in the team).
create or replace function public.learn_ean(p_sku text, p_ean text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v text := regexp_replace(coalesce(p_ean, ''), '\D', '', 'g');
begin
  if not public.me_ok() then raise exception 'Please log in again.'; end if;
  if length(v) not between 8 and 14 or not exists (select 1 from public.products where sku = p_sku) then return; end if;
  insert into public.product_aliases (sku, alias, alias_norm, kind, status, source, created_by)
  values (p_sku, v, v, 'ean', 'confirmed', 'learned from a PO', auth.uid())
  on conflict (alias_norm, kind, coalesce(customer_id, '00000000-0000-0000-0000-000000000000'::uuid)) do nothing;
  update public.products set ean = v where sku = p_sku and ean is null;
end;
$$;
revoke all on function public.learn_ean(text, text) from public, anon;
grant execute on function public.learn_ean(text, text) to authenticated;

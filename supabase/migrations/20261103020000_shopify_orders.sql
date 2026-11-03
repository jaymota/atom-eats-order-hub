-- Shopify (atomeats.com) orders, copied in every 15 minutes by the shopify-sync function. View-only:
-- the Hub never changes them and never sends them to Easy Ecom (Shopify already does that).
create table public.shopify_orders (
  id bigint primary key,                 -- Shopify's order id
  name text not null,                    -- "#1234"
  ordered_at timestamptz not null,
  order_date date not null,              -- India date
  customer text,
  city text,
  total numeric not null default 0,
  paid text,                             -- Shopify's payment status, e.g. PAID, PENDING, REFUNDED
  shipped text,                          -- Shopify's fulfilment status, e.g. UNFULFILLED, FULFILLED
  cancelled boolean not null default false,
  sent_on date,                          -- India date of the first shipment
  lines jsonb not null default '[]',     -- [{ sku, title, qty, open }]  open = not shipped yet
  shopify_updated_at timestamptz not null,
  synced_at timestamptz not null default now()
);
create index shopify_orders_date on public.shopify_orders (order_date desc);
create index shopify_orders_updated on public.shopify_orders (shopify_updated_at desc);
alter table public.shopify_orders enable row level security;
create policy shopify_orders_read on public.shopify_orders for select to authenticated
  using (public.my_role() in ('super_admin', 'admin', 'manager', 'ops'));
revoke all on public.shopify_orders from anon;
revoke insert, update, delete, truncate on public.shopify_orders from authenticated;

-- Website link: atomeats.com combos and gift boxes become orderable in the Hub and keep their price
-- in step with the website (checked every 6 hours). Website single packs stay hidden: their offline
-- SKU twins are what the team orders.
alter table public.products
  add column on_website boolean not null default false,   -- live on atomeats.com at the last check
  add column site_combo boolean not null default false;   -- a combo / gift box / variety pack on the website

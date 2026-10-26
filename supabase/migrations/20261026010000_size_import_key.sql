-- Pack size shown next to every product (e.g. "30 g", "70 g jar"), because Easy Ecom names
-- like "Mini Pretzel Knots - Pack of 1" don't say which size it is.
alter table public.products add column size text;

-- Lets the one-time import be run again without creating the same customer twice.
alter table public.customers add column import_key text unique;

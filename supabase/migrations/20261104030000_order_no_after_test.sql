-- A test order used up ORD-00058 and was deleted: the next order takes the number after the last real one.
select setval('public.order_no_seq', (select coalesce(max(substring(order_no from 5)::int), 1) from public.orders where order_no ~ '^ORD-\d+$'));

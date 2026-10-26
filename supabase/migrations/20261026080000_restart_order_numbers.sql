-- Order numbers start from ORD-00001 after test orders were removed.
alter sequence public.order_no_seq restart with 1;

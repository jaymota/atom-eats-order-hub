-- Custom product codes start from CUSTOM-0001 after a test product was removed.
alter sequence public.custom_sku_seq restart with 1;

-- Tiny function the "Keep Supabase awake" action calls every 3 days.
create or replace function public.ping() returns text
language sql stable as $$ select 'pong'::text $$;

grant execute on function public.ping() to anon, authenticated;

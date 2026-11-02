-- Every 15 minutes, the database itself calls the Gmail Apps Script (its web-app address), so new
-- PO emails reach the Hub on time. Google's own timer doesn't run for that account, and GitHub's
-- free timer runs an hour or more late. The address and key live in the Vault (set by hand, never in code):
--   mail_check_url  = the script's /exec address
--   inbox_key       = the same key as the INBOX_KEY function secret
create extension if not exists pg_net;
create extension if not exists pg_cron;

create or replace function public.run_mail_check()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url text := (select decrypted_secret from vault.decrypted_secrets where name = 'mail_check_url');
  v_key text := (select decrypted_secret from vault.decrypted_secrets where name = 'inbox_key');
begin
  if v_url is null or v_key is null then return; end if;
  perform net.http_get(url := v_url || '?key=' || v_key, timeout_milliseconds := 120000);
end;
$$;
revoke all on function public.run_mail_check() from public, anon, authenticated;

select cron.schedule('check-po-mail', '*/15 * * * *', 'select public.run_mail_check()');

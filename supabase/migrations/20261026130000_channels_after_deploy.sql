-- Orders or customers saved with an old channel name while the new screens were being published.
update public.customers set default_channel = case default_channel
  when 'Blinkit' then 'Quick Commerce' when 'Foodstories' then 'Modern Retail' when 'Food Square' then 'Modern Retail'
  when 'Other retail chains / corporates' then 'Modern Retail' when 'Retail (field sales)' then 'General Trade'
  when 'Custom' then 'B2B' when 'FOC samples' then 'FOC' else default_channel end
where default_channel in ('Blinkit', 'Foodstories', 'Food Square', 'Other retail chains / corporates', 'Retail (field sales)', 'Custom', 'FOC samples');
update public.orders set channel = case channel
  when 'Blinkit' then 'Quick Commerce' when 'Foodstories' then 'Modern Retail' when 'Food Square' then 'Modern Retail'
  when 'Other retail chains / corporates' then 'Modern Retail' when 'Retail (field sales)' then 'General Trade'
  when 'Custom' then 'B2B' when 'FOC samples' then 'FOC' else channel end
where channel in ('Blinkit', 'Foodstories', 'Food Square', 'Other retail chains / corporates', 'Retail (field sales)', 'Custom', 'FOC samples');

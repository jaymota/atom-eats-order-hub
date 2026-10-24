-- If a login is ever deleted, keep the people they added (just forget who added them).
alter table public.people drop constraint people_created_by_fkey,
  add constraint people_created_by_fkey foreign key (created_by) references public.people (id) on delete set null;

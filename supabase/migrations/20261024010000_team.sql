-- Phase 1: the team, PIN login security, and the activity log.
--
-- Every person has a Supabase login user (with a made-up email nobody receives mail at)
-- and a row in `people`. PINs are checked only by the `auth` Edge Function; the
-- hash lives in `pin_security`, which no browser can read.

create table public.people (
  id uuid primary key references auth.users (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 80),
  username text not null unique check (username ~ '^[a-z][a-z0-9.]{1,30}$'),
  role text not null check (role in ('super_admin', 'admin', 'accounts', 'ops', 'sales')),
  email text,          -- for notifications and PIN resets; may be shared by two people
  phone text,
  active boolean not null default true,
  must_change_pin boolean not null default true,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references public.people (id)
);

-- PIN hashes and lock counters. Server only.
create table public.pin_security (
  person_id uuid primary key references public.people (id) on delete cascade,
  pin_hash text not null,
  pin_set_at timestamptz not null default now(),
  failed_count int not null default 0,
  lock_level int not null default 0,
  locked_until timestamptz
);

-- Wrong-PIN counters per internet address, so trying many names from one place gets locked too.
create table public.ip_limits (
  ip text primary key,
  fails int not null default 0,
  lock_level int not null default 0,
  locked_until timestamptz,
  updated_at timestamptz not null default now()
);

-- One-time emailed codes for "Forgot PIN".
create table public.auth_codes (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references public.people (id) on delete cascade,
  code_hash text not null,
  expires_at timestamptz not null,
  attempts int not null default 0,
  used_at timestamptz,
  ip text,
  created_at timestamptz not null default now()
);

-- Simple counters to stop anyone flooding the server.
create table public.rate_hits (
  id bigint generated always as identity primary key,
  bucket text not null,
  created_at timestamptz not null default now()
);
create index on public.rate_hits (bucket, created_at);

-- Logins, wrong PINs, locks. Admins can read it.
create table public.login_events (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  person_id uuid references public.people (id) on delete set null,
  username_tried text,
  kind text not null,
  ip text,
  user_agent text
);
create index on public.login_events (at desc);

-- Who did what, when. Orders will add their own entries here from Phase 3.
create table public.activity (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  person_id uuid references public.people (id) on delete set null,
  kind text not null,
  entity_type text,
  entity_id text,
  summary text not null,
  detail jsonb not null default '{}'
);
create index on public.activity (at desc);
create index on public.activity (entity_type, entity_id, at desc);

-- ---------- Who is allowed in ----------

-- True when the caller is an active team member who has set their own PIN,
-- and their login is less than 7 days old.
create or replace function public.me_ok()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.people p
    where p.id = auth.uid() and p.active and not p.must_change_pin
  )
  and exists (
    select 1 from auth.sessions s
    where s.id = nullif(auth.jwt() ->> 'session_id', '')::uuid
      and s.user_id = auth.uid()
      and s.created_at > now() - interval '7 days'
  );
$$;

create or replace function public.my_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case when public.me_ok() then (select role from public.people where id = auth.uid()) end;
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.my_role() in ('super_admin', 'admin'), false);
$$;

-- Ends every login session of one person (used when their PIN is reset or they are switched off).
create or replace function public.end_sessions(p_user uuid)
returns void
language sql
security definer
set search_path = public
as $$
  delete from auth.sessions where user_id = p_user;
$$;

revoke all on function public.me_ok(), public.my_role(), public.is_admin() from public;
grant execute on function public.me_ok(), public.my_role(), public.is_admin() to authenticated;
revoke all on function public.end_sessions(uuid) from public, anon, authenticated;

-- ---------- Row Level Security ----------

alter table public.people enable row level security;
alter table public.pin_security enable row level security;
alter table public.ip_limits enable row level security;
alter table public.auth_codes enable row level security;
alter table public.rate_hits enable row level security;
alter table public.login_events enable row level security;
alter table public.activity enable row level security;

-- Everyone in the team sees the team. People can always see their own row
-- (needed on the "choose your own PIN" screen). All changes go through the server.
create policy people_read on public.people for select to authenticated
  using (public.me_ok() or id = auth.uid());

create policy activity_read on public.activity for select to authenticated
  using (public.me_ok());

create policy login_events_read on public.login_events for select to authenticated
  using (public.is_admin());

-- pin_security, ip_limits, auth_codes, rate_hits: no policies, so no browser can touch them.

-- Belt and braces: the logged-out website key gets nothing at all.
revoke all on public.people, public.pin_security, public.ip_limits, public.auth_codes,
  public.rate_hits, public.login_events, public.activity from anon;
revoke insert, update, delete, truncate on public.people, public.activity, public.login_events from authenticated;
revoke all on public.pin_security, public.ip_limits, public.auth_codes, public.rate_hits from authenticated;

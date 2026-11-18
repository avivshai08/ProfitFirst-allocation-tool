-- ADDITIVE ONLY. Safe to run while the current (password) site is live:
--   * adds two empty columns to clients (user_id, login_email) — no existing value changes
--   * lets pass_hash be empty, so clients added after the switch need no password
--   * adds an admins table and helper functions the new site uses
-- The current site keeps working exactly as before: it never reads or writes the new
-- columns, and nothing here turns on access rules for existing tables.

-- Which Google account a client row belongs to (set on the client's first Google sign-in).
alter table public.clients add column if not exists user_id uuid unique references auth.users(id) on delete set null;
-- Email the client signs in with. Empty = use the existing contact email (clients.email).
alter table public.clients add column if not exists login_email text;

do $$ begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'clients' and column_name = 'pass_hash') then
    alter table public.clients alter column pass_hash drop not null;
  end if;
end $$;

-- Admins are identified by their Google email. Not reachable through the API at all.
create table if not exists public.pf_admins (email text primary key);
alter table public.pf_admins enable row level security;
revoke all on public.pf_admins from anon, authenticated;

-- The signed-in user's verified email (null when not signed in or not verified).
create or replace function public.pf_auth_email() returns text
language sql stable security definer set search_path = public, auth as $$
  select lower(u.email) from auth.users u
  where u.id = auth.uid() and u.email_confirmed_at is not null
$$;

create or replace function public.pf_is_admin() returns boolean
language sql stable security definer set search_path = public, auth as $$
  select exists (select 1 from public.pf_admins a where lower(a.email) = public.pf_auth_email())
$$;

-- Has an open subscription: not switched off and end date not passed.
create or replace function public.pf_client_active(c public.clients) returns boolean
language sql stable as $$
  select c.active is not false
     and (nullif(c.subscription_end::text, '') is null or nullif(c.subscription_end::text, '')::timestamptz > now())
$$;

-- Called by the site after Google sign-in. Links the Google account to the existing
-- client row whose login email (or, if empty, contact email) equals the verified Google
-- email. Writes only clients.user_id; no other data is touched.
-- Returns {status: linked | not_found | ambiguous, id}.
create or replace function public.pf_claim_client() returns json
language plpgsql security definer set search_path = public as $$
declare
  em text := public.pf_auth_email();
  found_id public.clients.id%type;
  n int;
begin
  if auth.uid() is null or em is null then
    return json_build_object('status', 'not_found');
  end if;
  select id into found_id from public.clients where user_id = auth.uid();
  if found_id is not null then
    return json_build_object('status', 'linked', 'id', found_id);
  end if;
  select count(*) into n from public.clients
  where user_id is null and lower(trim(coalesce(nullif(trim(login_email), ''), email))) = em;
  if n = 0 then
    return json_build_object('status', 'not_found');
  elsif n > 1 then
    return json_build_object('status', 'ambiguous');
  end if;
  update public.clients set user_id = auth.uid()
  where user_id is null and lower(trim(coalesce(nullif(trim(login_email), ''), email))) = em
  returning id into found_id;
  return json_build_object('status', 'linked', 'id', found_id);
end $$;

-- Used after the cutover (03): a client may not change their own subscription,
-- login email or Google link. Silently keeps the stored values instead of failing,
-- so a client's normal saves (which resend these fields) still go through.
create or replace function public.pf_protect_client_columns() returns trigger
language plpgsql as $$
begin
  if current_user in ('anon', 'authenticated') and not public.pf_is_admin() then
    new.user_id          := old.user_id;
    new.login_email      := old.login_email;
    new.active           := old.active;
    new.subscription_end := old.subscription_end;
    new.pass_hash        := old.pass_hash;
  end if;
  return new;
end $$;

revoke execute on function public.pf_claim_client() from anon, public;
grant execute on function public.pf_claim_client(), public.pf_is_admin() to authenticated;

-- Put your own Google email(s) here before running:
-- insert into public.pf_admins (email) values ('you@gmail.com') on conflict do nothing;

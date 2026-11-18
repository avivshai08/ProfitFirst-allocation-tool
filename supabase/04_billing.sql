-- ADDITIVE ONLY: online signup and SUMIT billing. Adds empty columns (defaults keep
-- every existing client exactly as now: not awaiting payment, managed by the admin)
-- and the signup function. Safe to run before or after the cutover (03); run after 02.

alter table public.clients add column if not exists signup_source text;               -- 'self' = signed up online; empty = added by the admin
alter table public.clients add column if not exists awaiting_payment boolean not null default false;
alter table public.clients add column if not exists phone text;
alter table public.clients add column if not exists sumit_customer_id text;           -- admin-added clients who pay by SUMIT standing order
alter table public.clients add column if not exists sumit_end_date timestamp without time zone;  -- end date the billing job set (it only changes its own)
alter table public.clients add column if not exists subscription_cancelled_at timestamp without time zone;
alter table public.clients add column if not exists terms_accepted_at timestamp without time zone;

-- A signup awaiting payment has no access yet.
create or replace function public.pf_client_active(c public.clients) returns boolean
language sql stable as $$
  select c.active is not false
     and c.awaiting_payment is not true
     and (nullif(c.subscription_end::text, '') is null or nullif(c.subscription_end::text, '')::timestamptz > now())
$$;

-- A client may not change their own subscription, billing or Google link fields.
create or replace function public.pf_protect_client_columns() returns trigger
language plpgsql as $$
begin
  if current_user in ('anon', 'authenticated') and not public.pf_is_admin() then
    new.user_id                   := old.user_id;
    new.login_email               := old.login_email;
    new.active                    := old.active;
    new.subscription_end          := old.subscription_end;
    new.pass_hash                 := old.pass_hash;
    new.signup_source             := old.signup_source;
    new.awaiting_payment          := old.awaiting_payment;
    new.sumit_customer_id         := old.sumit_customer_id;
    new.sumit_end_date            := old.sumit_end_date;
    new.subscription_cancelled_at := old.subscription_cancelled_at;
    new.terms_accepted_at         := old.terms_accepted_at;
  end if;
  return new;
end $$;

-- Online signup by a Google account that has no client profile. Creates the profile
-- switched off and awaiting payment; the billing function opens it once SUMIT confirms.
-- Calling it again while still awaiting payment only updates name and phone.
-- Returns {status: created | exists | invalid, id}.
create or replace function public.pf_start_signup(p_name text, p_phone text) returns json
language plpgsql security definer set search_path = public as $$
declare
  em text := public.pf_auth_email();
  ph text := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  nm text := trim(coalesce(p_name, ''));
  found_id public.clients.id%type;
  waiting boolean;
begin
  if auth.uid() is null or em is null then
    return json_build_object('status', 'invalid', 'error', 'not_signed_in');
  end if;
  if nm = '' or length(nm) > 100 then
    return json_build_object('status', 'invalid', 'error', 'name');
  end if;
  if ph !~ '^0\d{8,9}$' then
    return json_build_object('status', 'invalid', 'error', 'phone');
  end if;
  select id, awaiting_payment into found_id, waiting from public.clients where user_id = auth.uid();
  if found_id is not null then
    if waiting then
      update public.clients set name = nm, phone = ph where id = found_id;
      return json_build_object('status', 'created', 'id', found_id);
    end if;
    return json_build_object('status', 'exists', 'id', found_id);
  end if;
  -- An existing client with this email signs in (pf_claim_client), never signs up again.
  if exists (select 1 from public.clients
             where user_id is null and lower(trim(coalesce(nullif(trim(login_email), ''), email))) = em) then
    return json_build_object('status', 'exists');
  end if;
  insert into public.clients (name, phone, email, login_email, user_id, active, awaiting_payment,
                              signup_source, terms_accepted_at, accounts)
  values (nm, ph, em, em, auth.uid(), false, true, 'self', now(),
          '[{"id":"profit","name":"רווח","type":"pct","value":"5"},
            {"id":"owner","name":"שכר הנהלה","type":"pct","value":"50"},
            {"id":"tax","name":"רשויות","type":"pct","value":"15"},
            {"id":"op","name":"הוצאות תפעול","type":"auto","value":""}]'::jsonb)
  returning id into found_id;
  return json_build_object('status', 'created', 'id', found_id);
end $$;

revoke execute on function public.pf_start_signup(text, text) from anon, public;
grant execute on function public.pf_start_signup(text, text) to authenticated;

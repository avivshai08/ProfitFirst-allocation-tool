-- ADDITIVE ONLY (run after 04_billing.sql; before or after the cutover). Renewal, one free
-- month per person, and the phone check at signup:
--   * adds empty columns to clients (no existing value changes);
--   * adds pf_trial_used: a fingerprint (sha256) of the sign-in email and of the phone of everyone
--     who has been a client, so the free month is offered once per person. Only fingerprints are
--     kept, never the email or phone, so the record outlives the deletion after 60 days;
--   * fills it from the existing clients (only inserts into the new table);
--   * replaces pf_start_signup (same inputs; now also says whether the free month applies and
--     refuses a phone that already belongs to another profile) and pf_protect_client_columns
--     (also protects the new columns from the client).
-- Undo: drop the trigger pf_record_trial and table pf_trial_used, and run the two functions'
-- definitions from 04_billing.sql again. The new columns can stay (nothing reads them then).

-- Newest charge date seen in SUMIT (a later one means the client paid again).
alter table public.clients add column if not exists sumit_last_charge date;
-- The end date the "access ended" email was sent for (sent once).
alter table public.clients add column if not exists access_end_notice date;
-- When the admin was told a client due for deletion still has a live standing order.
alter table public.clients add column if not exists deletion_held_at timestamp without time zone;
-- Whether this signup was offered the free month (decides which payment page it continues to).
alter table public.clients add column if not exists trial_offered boolean;

create table if not exists public.pf_trial_used (
  fingerprint text primary key,
  used_at timestamp with time zone not null default now()
);
alter table public.pf_trial_used enable row level security;
revoke all on public.pf_trial_used from anon, authenticated;

-- Fingerprints of a sign-in email (lower case) and of a phone (digits only), for pf_trial_used.
create or replace function public.pf_fingerprints(p_email text, p_phone text) returns text[]
language sql immutable as $$
  select array_remove(array[
    case when nullif(lower(trim(coalesce(p_email, ''))), '') is not null
      then 'e:' || encode(sha256(convert_to(lower(trim(p_email)), 'UTF8')), 'hex') end,
    case when regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g') ~ '^0\d{8,9}$'
      then 'p:' || encode(sha256(convert_to(regexp_replace(p_phone, '[^0-9]', '', 'g'), 'UTF8')), 'hex') end
  ], null)
$$;

-- Everyone who is or was a client (not a signup still awaiting payment) has used the free month.
create or replace function public.pf_record_trial() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.awaiting_payment is not true then
    insert into public.pf_trial_used (fingerprint)
    select unnest(public.pf_fingerprints(coalesce(nullif(trim(new.login_email), ''), new.email), new.phone))
    on conflict do nothing;
  end if;
  return null;
end $$;

drop trigger if exists pf_record_trial on public.clients;
create trigger pf_record_trial after insert or update of awaiting_payment, login_email, email, phone on public.clients
  for each row execute function public.pf_record_trial();

-- The existing clients.
insert into public.pf_trial_used (fingerprint)
select unnest(public.pf_fingerprints(coalesce(nullif(trim(login_email), ''), email), phone))
from public.clients where awaiting_payment is not true
on conflict do nothing;

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
    new.sumit_last_charge         := old.sumit_last_charge;
    new.access_end_notice         := old.access_end_notice;
    new.deletion_held_at          := old.deletion_held_at;
    new.trial_offered             := old.trial_offered;
  end if;
  return new;
end $$;

-- Online signup by a Google account that has no client profile. Creates the profile
-- switched off and awaiting payment; the billing function opens it once SUMIT confirms.
-- Calling it again while still awaiting payment only updates name and phone.
-- trial: whether this person gets the free month (never if their sign-in email or phone was a
-- client before). A phone that belongs to another profile is refused (phone_taken): that is
-- usually an existing client signed in with a different Google account.
-- Returns {status: created | exists | invalid | phone_taken, id, trial}.
create or replace function public.pf_start_signup(p_name text, p_phone text) returns json
language plpgsql security definer set search_path = public as $$
declare
  em text := public.pf_auth_email();
  ph text := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  nm text := trim(coalesce(p_name, ''));
  found_id public.clients.id%type;
  waiting boolean;
  trial boolean;
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
  if found_id is not null and not waiting then
    return json_build_object('status', 'exists', 'id', found_id);
  end if;
  -- An existing client with this email signs in (pf_claim_client), never signs up again.
  if found_id is null and exists (select 1 from public.clients
             where user_id is null and lower(trim(coalesce(nullif(trim(login_email), ''), email))) = em) then
    return json_build_object('status', 'exists');
  end if;
  if exists (select 1 from public.clients
             where regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g') = ph
               and user_id is distinct from auth.uid()) then
    return json_build_object('status', 'phone_taken');
  end if;
  trial := not exists (select 1 from public.pf_trial_used where fingerprint = any (public.pf_fingerprints(em, ph)));
  if found_id is not null then
    update public.clients set name = nm, phone = ph, trial_offered = trial where id = found_id;
    return json_build_object('status', 'created', 'id', found_id, 'trial', trial);
  end if;
  insert into public.clients (name, phone, email, login_email, user_id, active, awaiting_payment,
                              signup_source, terms_accepted_at, trial_offered, accounts)
  values (nm, ph, em, em, auth.uid(), false, true, 'self', now(), trial,
          '[{"id":"profit","name":"רווח","type":"pct","value":"5"},
            {"id":"owner","name":"שכר הנהלה","type":"pct","value":"50"},
            {"id":"tax","name":"רשויות","type":"pct","value":"15"},
            {"id":"op","name":"הוצאות תפעול","type":"auto","value":""}]'::jsonb)
  returning id into found_id;
  return json_build_object('status', 'created', 'id', found_id, 'trial', trial);
end $$;

revoke execute on function public.pf_start_signup(text, text) from anon, public;
grant execute on function public.pf_start_signup(text, text) to authenticated;
revoke execute on function public.pf_record_trial() from anon, authenticated, public;

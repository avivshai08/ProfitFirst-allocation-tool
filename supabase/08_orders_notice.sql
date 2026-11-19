-- ADDITIVE ONLY (run after 07_renewal.sql, before deploying the pf-billing version that reads
-- it). Adds one empty column: which live standing orders the admin was already emailed about
-- (a client with open access and more than one live order for the tool; the tool cancels
-- nothing then, the admin decides). No existing value changes.
-- Also protects the column from the client (pf_protect_client_columns, as in 07 plus this one).
-- Undo: alter table public.clients drop column orders_notice; then run 07's
-- pf_protect_client_columns definition again.

alter table public.clients add column if not exists orders_notice text;

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
    new.orders_notice             := old.orders_notice;
  end if;
  return new;
end $$;

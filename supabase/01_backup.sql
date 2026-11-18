-- Full copy of the three tables into a private schema (not reachable from the app or
-- the public API). Changes nothing in the original tables. Safe to run any time; run
-- it again right before the cutover (03) with a new date suffix.
--
-- Also download each table as CSV from Table Editor → Export, and keep the files.

create schema if not exists pf_backup;
revoke all on schema pf_backup from anon, authenticated;

create table pf_backup.clients_20261118     as table public.clients;
create table pf_backup.allocations_20261118 as table public.allocations;
create table pf_backup.settings_20261118    as table public.settings;

-- The counts must match the originals.
select (select count(*) from public.clients)     as clients,     (select count(*) from pf_backup.clients_20261118)     as clients_backup,
       (select count(*) from public.allocations) as allocations, (select count(*) from pf_backup.allocations_20261118) as allocations_backup,
       (select count(*) from public.settings)    as settings,    (select count(*) from pf_backup.settings_20261118)    as settings_backup;

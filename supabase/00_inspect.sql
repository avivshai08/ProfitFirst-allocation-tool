-- READ-ONLY. Changes nothing. Run in Supabase → SQL Editor and send back the results.
-- Shows the real table structure, current access rules and scheduled jobs, so the
-- next scripts can be checked against the live database before they run.

-- 1. Columns of every table in the public schema
select table_name, column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public'
order by table_name, ordinal_position;

-- 2. Is row-level security on, and which policies exist?
select tablename, rowsecurity from pg_tables where schemaname = 'public';
select tablename, policyname, cmd, roles, qual, with_check from pg_policies where schemaname = 'public';

-- 3. Row counts (numbers only, no content) — compared again after each step
select (select count(*) from public.clients)     as clients,
       (select count(*) from public.allocations) as allocations,
       (select count(*) from public.settings)    as settings;

-- 4. Scheduled jobs (e.g. reminder emails), if pg_cron is installed
select jobid, schedule, command from cron.job;

-- 5. Clients who cannot be linked to Google automatically yet: no email, or an email
--    shared by more than one client. Fix these in the admin screen (אימייל לכניסה)
--    after step 4 of the runbook, or ask the client which Google email they use.
select id, name, email from public.clients
where coalesce(trim(email), '') = ''
   or lower(trim(email)) in (select lower(trim(email)) from public.clients
                             where coalesce(trim(email), '') <> ''
                             group by 1 having count(*) > 1)
order by name;

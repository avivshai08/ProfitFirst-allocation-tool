-- READ-ONLY. Changes nothing. Run in Supabase → SQL Editor and send back the result
-- (one table, columns "section" and "detail"; use the copy/export button to send it all).
-- Shows the real table structure, current access rules and scheduled jobs, so the
-- next scripts can be checked against the live database before they run.
-- No client data is shown except, in the last section, names of clients whose email
-- is missing or shared (they cannot be linked to Google automatically).

select section, detail from (
  -- 1. Columns of every table in the public schema
  select 1 as ord, 'columns: ' || table_name as section,
         string_agg(column_name || ' ' || data_type || case when is_nullable = 'NO' then ' NOT NULL' else '' end
                    || coalesce(' default ' || column_default, ''), ' | ' order by ordinal_position) as detail
  from information_schema.columns where table_schema = 'public' group by table_name

  -- 2. Is row-level security on, and which policies exist?
  union all
  select 2, 'row security: ' || tablename, rowsecurity::text from pg_tables where schemaname = 'public'
  union all
  select 3, 'policy: ' || tablename || '.' || policyname,
         cmd || ' to ' || array_to_string(roles, ',') || ' using (' || coalesce(qual, '') || ') check (' || coalesce(with_check, '') || ')'
  from pg_policies where schemaname = 'public'

  -- 3. What the public key (anon) is allowed to do on each table
  union all
  select 4, 'anon grants: ' || table_name, string_agg(privilege_type, ', ' order by privilege_type)
  from information_schema.role_table_grants where table_schema = 'public' and grantee = 'anon' group by table_name

  -- 4. Row counts (numbers only) — compared again after each step
  union all
  select 5, 'row counts',
         'clients=' || (select count(*) from public.clients) || ', allocations=' || (select count(*) from public.allocations)
         || ', settings=' || (select count(*) from public.settings)

  -- 5. Scheduled jobs (e.g. reminder emails) and server functions that may read the tables
  union all
  select 6, 'scheduled jobs',
         case when to_regclass('cron.job') is null then 'pg_cron not installed'
              else query_to_xml('select jobid, schedule, command from cron.job', false, false, '')::text end
  union all
  select 7, 'database triggers: ' || event_object_table, string_agg(trigger_name || ' ' || action_timing || ' ' || event_manipulation, ', ')
  from information_schema.triggers where trigger_schema = 'public' group by event_object_table

  -- 6. Clients with no email, or an email shared with another client
  union all
  select 8, 'needs login email', id::text || ' ' || name || coalesce(' <' || email || '>', ' <no email>')
  from public.clients
  where coalesce(trim(email), '') = ''
     or lower(trim(email)) in (select lower(trim(email)) from public.clients
                               where coalesce(trim(email), '') <> ''
                               group by 1 having count(*) > 1)
) s
order by ord, section, detail;

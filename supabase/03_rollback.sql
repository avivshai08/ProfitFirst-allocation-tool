-- UNDO 03_cutover.sql: puts access back exactly as it was before the cutover, so the
-- old password site works again. Changes access only — no data is touched. Clients
-- who already linked Google keep that link (an unused column for the old site).

begin;

drop trigger if exists pf_protect_client_columns on public.clients;

do $$ declare r record; begin
  for r in select tablename, policyname from pg_policies
           where schemaname = 'public' and tablename in ('clients', 'allocations', 'settings')
             and policyname like 'pf\_%' loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

grant select, insert, update, delete on public.clients, public.allocations, public.settings to anon, authenticated;

-- Restore the saved policies and the saved on/off state of row-level security.
do $$ declare r record; begin
  for r in select * from pf_backup.policies_before_cutover loop
    execute format('create policy %I on public.%I as %s for %s to %s %s %s',
      r.policyname, r.tablename, r.permissive, r.cmd,
      array_to_string(r.roles, ', '),
      case when r.qual is not null then 'using (' || r.qual || ')' else '' end,
      case when r.with_check is not null then 'with check (' || r.with_check || ')' else '' end);
  end loop;
  for r in select * from pf_backup.rls_before_cutover loop
    if r.rowsecurity then
      execute format('alter table public.%I enable row level security', r.tablename);
    else
      execute format('alter table public.%I disable row level security', r.tablename);
    end if;
  end loop;
end $$;

drop table pf_backup.policies_before_cutover;
drop table pf_backup.rls_before_cutover;

commit;

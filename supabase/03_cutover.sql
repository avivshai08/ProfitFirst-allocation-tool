-- CUTOVER. Run only at the moment the new (Google) site goes live, right after a fresh
-- backup (01). Changes ACCESS ONLY — no row is inserted, changed or deleted.
-- After this, the public key in the page can read nothing but the brand settings:
--   * a client sees and edits only their own row and their own allocation history
--   * an admin (email in pf_admins) sees and edits everything
--   * a client cannot change their own subscription, login email or Google link
-- The old password site stops working at this moment (it relies on open access).
-- Undo with 03_rollback.sql.

begin;

-- Save the current access setup so 03_rollback.sql can restore it exactly.
create schema if not exists pf_backup;
revoke all on schema pf_backup from anon, authenticated;
create table pf_backup.rls_before_cutover as
  select tablename, rowsecurity from pg_tables
  where schemaname = 'public' and tablename in ('clients', 'allocations', 'settings');
create table pf_backup.policies_before_cutover as
  select tablename, policyname, permissive, cmd, roles, qual, with_check from pg_policies
  where schemaname = 'public' and tablename in ('clients', 'allocations', 'settings');

-- Remove the old open policies (if any).
do $$ declare r record; begin
  for r in select tablename, policyname from pf_backup.policies_before_cutover loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

alter table public.clients     enable row level security;
alter table public.allocations enable row level security;
alter table public.settings    enable row level security;

-- Table permissions: the public key may only read the brand; admin_hash is unreadable.
revoke all on public.clients, public.allocations, public.settings from anon;
revoke all on public.settings from authenticated;
grant select (id, brand) on public.settings to anon, authenticated;
grant update (brand) on public.settings to authenticated;
grant select, insert, update, delete on public.clients, public.allocations to authenticated;

-- clients
create policy pf_clients_select on public.clients for select to authenticated
  using (user_id = auth.uid() or public.pf_is_admin());
create policy pf_clients_update on public.clients for update to authenticated
  using ((user_id = auth.uid() and public.pf_client_active(clients)) or public.pf_is_admin())
  with check (user_id = auth.uid() or public.pf_is_admin());
create policy pf_clients_insert on public.clients for insert to authenticated
  with check (public.pf_is_admin());
create policy pf_clients_delete on public.clients for delete to authenticated
  using (public.pf_is_admin());

create trigger pf_protect_client_columns before update on public.clients
  for each row execute function public.pf_protect_client_columns();

-- allocations
create policy pf_alloc_select on public.allocations for select to authenticated
  using (public.pf_is_admin() or exists (
    select 1 from public.clients c where c.id = allocations.client_id and c.user_id = auth.uid()));
create policy pf_alloc_insert on public.allocations for insert to authenticated
  with check (public.pf_is_admin() or exists (
    select 1 from public.clients c where c.id = allocations.client_id and c.user_id = auth.uid() and public.pf_client_active(c)));
create policy pf_alloc_delete on public.allocations for delete to authenticated
  using (public.pf_is_admin() or exists (
    select 1 from public.clients c where c.id = allocations.client_id and c.user_id = auth.uid() and public.pf_client_active(c)));
create policy pf_alloc_update on public.allocations for update to authenticated
  using (public.pf_is_admin()) with check (public.pf_is_admin());

-- settings
create policy pf_settings_select on public.settings for select to anon, authenticated using (true);
create policy pf_settings_update on public.settings for update to authenticated
  using (public.pf_is_admin()) with check (public.pf_is_admin());

commit;

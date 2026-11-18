-- ADDITIVE ONLY. Adds the access rules for signed-in (Google) users ahead of the cutover,
-- so the new site can be tried on prod data (admin sees all clients; a client only their
-- own row) while the current site keeps working: its "anon full access" rules are not
-- touched, and nothing here applies to the public key except reading the brand, which it
-- can already do. No data is changed.
-- 03_cutover.sql later removes the open rules and recreates these same rules.
-- Undo: drop policy pf_clients_select on public.clients; (and the other pf_ policies).

begin;

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

-- =============================================================================
-- 006_sales_record_production_and_inventory.sql
-- Northern Water Company Ltd — OASIS Springs
--
-- Lets the sales role record production logs and PERSIST the inventory changes
-- that their sales and production cause.
--
-- Background
-- ----------
-- Sales reps record sales, production logs and payments. By design:
--   * a sale deducts finished goods, and
--   * a production log reduces raw materials, increases finished goods, and
--     registers casual pay due (via the casuals stored on the log).
-- Both inventory effects auto-persist to inventory_state, and a production log
-- inserts a production_logs row. Until now:
--   * inventory_state INSERT/UPDATE was admin/manager only, so a sales user's
--     finished-goods deduction (from a sale) and raw-material/finished-goods
--     changes (from production) were silently rejected by RLS and never saved —
--     finished-goods stock drifted upward versus reality; and
--   * production_logs INSERT/SELECT was admin/manager only, so a sales user
--     could not save a production log at all.
-- This migration grants the sales role exactly those two capabilities and adds a
-- created_by column to production_logs so a sales user is scoped to their own
-- logs (admin/manager still see every run).
--
-- SECURITY NOTE (flagging an RLS change):
--   * inventory_state is a single shared record set (ids 'rawMaterials' /
--     'finishedGoods'); all writers — now including sales — last-write-wins on
--     the same rows. This matches the existing admin/manager model; it does not
--     introduce per-location isolation. Concurrent edits from multiple devices
--     can still race (pre-existing limitation).
--   * production_logs SELECT for sales is scoped to created_by = auth.uid().
--     UPDATE (e.g. marking casual_paid) and DELETE remain admin/manager / admin —
--     reps record runs but cannot edit or delete them.
--
-- Apply via the Supabase SQL Editor AFTER review. Idempotent — safe to re-run.
-- =============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. inventory_state — allow the sales role to write.
--    The app auto-saves inventory via upsert (INSERT ... ON CONFLICT UPDATE),
--    so BOTH INSERT and UPDATE policies must admit the role. DELETE stays
--    admin-only (unchanged).
-- ---------------------------------------------------------------------------
drop policy if exists "inventory_state_insert" on inventory_state;
create policy "inventory_state_insert"
  on inventory_state for insert
  with check (get_my_role() in ('admin', 'manager', 'sales'));

drop policy if exists "inventory_state_update" on inventory_state;
create policy "inventory_state_update"
  on inventory_state for update
  using (get_my_role() in ('admin', 'manager', 'sales'));

-- ---------------------------------------------------------------------------
-- 2. production_logs — track the creator so sales reads can be scoped.
--    Default to auth.uid() so the column is populated even though the app does
--    not always send it. Existing rows keep created_by = NULL; admin/manager
--    read by role (not by creator), so they still see those rows.
-- ---------------------------------------------------------------------------
alter table public.production_logs
  add column if not exists created_by uuid default auth.uid();

-- ---------------------------------------------------------------------------
-- 3. production_logs INSERT — admit the sales role.
-- ---------------------------------------------------------------------------
drop policy if exists "production_logs_insert" on production_logs;
create policy "production_logs_insert"
  on production_logs for insert
  with check (get_my_role() in ('admin', 'manager', 'sales'));

-- ---------------------------------------------------------------------------
-- 4. production_logs SELECT — admin/manager see all; sales see only their own.
--    A sales user must be able to read back the row they just inserted (the app
--    inserts with .select()), and to load their own production history.
-- ---------------------------------------------------------------------------
drop policy if exists "production_logs_select" on production_logs;
create policy "production_logs_select"
  on production_logs for select
  using (
    get_my_role() in ('admin', 'manager')
    or (get_my_role() = 'sales' and created_by = auth.uid())
  );

-- UPDATE / DELETE policies are intentionally left unchanged:
--   production_logs_update  -> admin/manager  (e.g. casual_paid flag)
--   production_logs_delete   -> admin

commit;

-- =============================================================================
-- After applying, verify (as a sales user):
--   insert into public.production_logs (date, items, unit, notes, casuals)
--     values (current_date, '{"0.5L":1}'::jsonb, 'cartons', 'rls test', '[]'::jsonb)
--     returning id, created_by;            -- created_by should equal auth.uid()
--   -- then delete that test row as admin.
--   -- confirm a sales user can upsert inventory_state without an RLS error.
-- =============================================================================

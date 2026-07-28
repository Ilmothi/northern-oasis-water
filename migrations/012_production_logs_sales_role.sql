-- =============================================================================
-- 012_production_logs_sales_role.sql
-- Northern Water Company Ltd — OASIS Springs
--
-- Closes audit finding 7 (docs/audit-2026-07-28.md): the sales role could reach
-- the Production tab but not use it.
--
-- THE MISMATCH
-- ------------
-- Three places already assume sales users log production:
--   * the nav grants the Production tab to ['admin','manager','sales'];
--   * CLAUDE.md lists production logging as a sales-role capability;
--   * the data loader's own comment (src/App.jsx:570) says "RLS returns every run
--     for admin/manager and only the user's own runs for sales".
--
-- Only the policies disagreed: 001 restricted production_logs SELECT and INSERT
-- to admin/manager. A sales user therefore saw an empty log list and got a hard
-- error on save. Owner decision, 2026-07-28: sales users SHOULD log production,
-- so the policies are the thing to change.
--
-- WHAT THIS DOES
-- --------------
--   select : admin/manager see every run; sales see only their OWN runs.
--   insert : admin/manager unrestricted; a sales user must stamp the row with
--            their own uid, so a run can never be invisible to the person who
--            recorded it.
--   update : unchanged, admin/manager — this sets `casual_paid` when a payout is
--            recorded, which is an HR action, not a production one.
--   delete : unchanged, admin only — deleting a run reverses stock.
--
-- DEPENDENCY — already satisfied
-- ------------------------------
-- Logging production also moves stock: raw materials down, finished goods up.
-- That runs through apply_inventory_deltas, which migration 010 already opened to
-- the sales role. Without 010 this change would half-work — the log would insert
-- and the stock would refuse to move.
--
-- Reports are admin/manager only in the nav, so a sales user's partial view of
-- the log cannot leak into a production total that reads as company-wide.
--
-- Apply via the Supabase SQL Editor AFTER review. Idempotent — safe to re-run.
-- No client change is needed; the app already fetches this table for all roles.
-- =============================================================================

begin;

-- Sales users see their own runs only. `created_by` is the author stamp the app
-- already writes on every production log.
drop policy if exists "production_logs_select" on production_logs;
create policy "production_logs_select"
  on production_logs for select
  using (
    get_my_role() in ('admin', 'manager')
    or (get_my_role() = 'sales' and created_by = auth.uid())
  );

-- The created_by condition is what makes the SELECT above meaningful: without it
-- a sales user could write a run they would then be unable to see.
drop policy if exists "production_logs_insert" on production_logs;
create policy "production_logs_insert"
  on production_logs for insert
  with check (
    get_my_role() in ('admin', 'manager')
    or (get_my_role() = 'sales' and created_by = auth.uid())
  );

-- Unchanged in effect; re-declared here so this table's policies are idempotent
-- (001 used bare `create policy`, which errors on a re-run).
drop policy if exists "production_logs_update" on production_logs;
create policy "production_logs_update"
  on production_logs for update
  using (get_my_role() in ('admin', 'manager'));

drop policy if exists "production_logs_delete" on production_logs;
create policy "production_logs_delete"
  on production_logs for delete
  using (get_my_role() = 'admin');

commit;

-- =============================================================================
-- AFTER APPLYING — verify
--
-- As a SALES user (expect: success, and the stock moves):
--   -- log a production run in the app, then confirm it is visible on reload:
--   select id, date, items, created_by from production_logs;
--       -- expect: only rows this user created
--   -- and that the BOM actually moved stock (no "stock could not be updated"
--   -- warning should have appeared when saving):
--   select data #>> '{kraStamps}' from inventory_state where id = 'rawMaterials';
--
-- As a SALES user (expect: refused / no rows changed):
--   update production_logs set casual_paid = true where id = <any id>;
--   delete from production_logs where id = <any id>;
--
-- As a MANAGER (expect: every run, not just their own):
--   select count(*) from production_logs;
-- =============================================================================

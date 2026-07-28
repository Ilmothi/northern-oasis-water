-- =============================================================================
-- 013_remove_blanket_policies.sql
-- Northern Water Company Ltd — OASIS Springs
--
-- SECURITY FIX. Removes blanket "allow everything" RLS policies that have been
-- silently overriding the entire access-control design since before 001 was
-- applied, plus a self-service profile UPDATE policy that allows privilege
-- escalation.
--
-- HOW THIS WAS FOUND
-- ------------------
-- A sales user reported seeing company-wide debt on the Customers module. The
-- expected cause (a NULL profiles.location falling through the "see all"
-- branch) was ruled out — all three sales users have location 'Loglogo'. A
-- policy dump then showed the real cause.
--
-- WHAT IS WRONG
-- -------------
-- Postgres OR's PERMISSIVE policies together. A single policy with `using (true)`
-- therefore grants everything, no matter how carefully the policies beside it are
-- written. Twelve of fifteen tables carried one:
--
--   "Authenticated full access"  ALL / true / true   — on customers, employees,
--       expenses, inventory_state, payments, payroll_payments, production_logs,
--       purchases, sales, stock_adjustments
--   "Read cost settings"    SELECT / true            — on cost_settings
--   "Update cost settings"  ALL / true / true        — on cost_settings
--       (named "Update" but registered as ALL, so it granted reads,
--        inserts and deletes too)
--   "Profiles readable by authenticated"  SELECT / true — on profiles
--
-- Consequence: every authenticated user — including the sales role — could read,
-- insert, update and DELETE every financial record via the API, whatever the UI
-- showed them. The location scoping, the admin-only deletes, and the role
-- separation in 001/002/010/011/012 have never actually been enforced on these
-- tables.
--
-- Separately, and worse:
--
--   "Users update own profile"  UPDATE / (auth.uid() = id)  — on profiles
--
-- with no column restriction. Any user could update their own profiles row,
-- including `role` — setting themselves to 'admin' — or blanking `location` to
-- widen their own data access. 001 deliberately defined NO write policy on
-- profiles; this was added outside the migrations.
--
-- WHAT THIS MIGRATION DOES
-- ------------------------
-- Drops those 13 policies. It adds nothing: every affected table already has a
-- complete, correct policy set underneath, verified against the live policy dump
-- before this was written. `consignment_movements` was never affected — it was
-- created in 008 with only its intended policies, which is why the reconcile
-- restriction from 010 is the one control that has genuinely been holding.
--
-- VERIFIED BEFORE WRITING — the two places a drop could have broken the app:
--   * profiles: the client only ever reads its OWN row (App.jsx:351-357), so
--     `profiles_select_own` covers it. No feature reads other users' profiles.
--   * expenses: `expenses_insert` excludes the sales role, and the blanket policy
--     had been covering that gap. Checked the nav — the Expenses tab is
--     admin/manager only (App.jsx:3770), so the sales branch in that view is
--     unreachable. No real workflow depends on it.
--
-- EXPECTED BEHAVIOUR CHANGES — tell your users before applying
-- ------------------------------------------------------------
-- These are the controls finally taking effect, not regressions:
--   * Sales users stop seeing other locations' customers, sales and payments.
--     This is the originally reported bug.
--   * MANAGERS LOSE DELETE. Deleting sales, payments, expenses and purchases is
--     admin-only by design (CLAUDE.md), but managers have effectively had it all
--     along. delete_sale / delete_payment will now correctly raise
--     "not permitted" for them.
--   * Sales users can no longer edit or delete records outside their location.
--   * Nobody can change their own role or location any more. Profile changes are
--     an admin/dashboard operation.
--
-- Apply via the Supabase SQL Editor AFTER review. Idempotent — safe to re-run.
-- No client change is needed; nothing in the app depends on these policies.
-- =============================================================================

begin;

-- ---------------------------------------------------------------------------
-- SECTION 1: "Authenticated full access" (ALL / true / true)
--
-- Each of these tables keeps its full policy set from 001 / 002 / 010 / 011 / 012.
-- The surviving policies are listed so a reviewer can confirm coverage without
-- cross-referencing five files.
-- ---------------------------------------------------------------------------

-- keeps: customers_select, customers_insert, customers_update_admin_manager,
--        customers_update_sales, customers_delete
drop policy if exists "Authenticated full access" on customers;

-- keeps: employees_select (admin/manager, or sales→casual only),
--        employees_insert, employees_update, employees_delete (all admin)
drop policy if exists "Authenticated full access" on employees;

-- keeps: expenses_select (admin/manager, or sales→own), expenses_insert,
--        expenses_update (admin/manager), expenses_delete (admin)
drop policy if exists "Authenticated full access" on expenses;

-- keeps: inventory_state_select (any authenticated), inventory_state_insert,
--        inventory_state_update, inventory_state_delete (all admin, per 010).
-- Note the app never writes this table directly — it goes through
-- apply_inventory_deltas / set_inventory_value, which carry their own explicit
-- role checks and are unaffected by this change.
drop policy if exists "Authenticated full access" on inventory_state;

-- keeps: payments_select (location-scoped for sales), payments_insert
--        (any authenticated), payments_delete (admin).
-- No UPDATE policy by design — payments are immutable.
drop policy if exists "Authenticated full access" on payments;

-- keeps: payroll_payments_select (admin/manager), payroll_payments_insert,
--        payroll_payments_update, payroll_payments_delete (all admin)
drop policy if exists "Authenticated full access" on payroll_payments;

-- keeps: production_logs_select / _insert (admin/manager, or sales→own, per 012),
--        production_logs_update (admin/manager), production_logs_delete (admin)
drop policy if exists "Authenticated full access" on production_logs;

-- keeps: purchases_select, purchases_insert, purchases_update (admin/manager),
--        purchases_delete (admin)
drop policy if exists "Authenticated full access" on purchases;

-- keeps: sales_select (location-scoped for sales), sales_insert_admin,
--        sales_insert_non_admin (total >= 0, per 010), sales_update_admin_manager,
--        sales_update_sales, sales_delete (admin)
drop policy if exists "Authenticated full access" on sales;

-- keeps: stock_adjustments_select (admin/manager), stock_adjustments_insert (admin).
-- No UPDATE/DELETE policy by design — the audit trail is append-only.
drop policy if exists "Authenticated full access" on stock_adjustments;


-- ---------------------------------------------------------------------------
-- SECTION 2: cost_settings
--
-- Two blanket policies. "Update cost settings" is registered as ALL despite its
-- name, so it granted select, insert, update and delete to every authenticated
-- user — carton costs and the casual rate feed COGS and payroll.
--
-- keeps: cost_settings_select (any authenticated — costs are displayed across
--        roles), cost_settings_insert, cost_settings_update,
--        cost_settings_delete (all admin)
-- ---------------------------------------------------------------------------

drop policy if exists "Read cost settings"   on cost_settings;
drop policy if exists "Update cost settings" on cost_settings;


-- ---------------------------------------------------------------------------
-- SECTION 3: profiles — the privilege-escalation fix
--
-- "Users update own profile" allowed `update profiles set role = 'admin'
-- where id = auth.uid()`. There is no column-level restriction in a USING
-- clause, so self-service profile editing means self-service role editing.
--
-- 001 defined no write policy on profiles on purpose: profile creation and role
-- assignment are done through the Supabase dashboard or a service-role function,
-- never from the client. That stays true — with no INSERT/UPDATE/DELETE policy,
-- the client cannot write this table at all.
--
-- keeps: profiles_select_own (id = auth.uid()), profiles_select_admin
-- ---------------------------------------------------------------------------

drop policy if exists "Profiles readable by authenticated" on profiles;
drop policy if exists "Users update own profile"           on profiles;

commit;


-- =============================================================================
-- AFTER APPLYING — verify
--
-- 1. No unconditional policy survives anywhere. Expect ZERO rows:
--
--      select tablename, policyname, cmd, roles, qual, with_check
--        from pg_policies
--       where schemaname = 'public'
--         and (qual is null or btrim(qual) = 'true')
--         and cmd <> 'INSERT'          -- INSERT policies legitimately have null qual
--       order by tablename;
--
--    (Two INSERT policies keep a `true`-equivalent with_check by design:
--     payments_insert and sales_insert_non_admin both allow any authenticated
--     user to record a sale/payment. That breadth predates this migration and is
--     unchanged — see audit finding 4 notes.)
--
-- 2. No write policy on profiles at all. Expect only the two SELECT rows:
--
--      select policyname, cmd from pg_policies
--       where schemaname = 'public' and tablename = 'profiles';
--
-- 3. The originally reported bug, as a SALES user (Loglogo):
--    Open the Customers module. The customer list and the Outstanding Debt card
--    must now show Loglogo only. Compare against:
--
--      select coalesce(nullif(location,''),'(no location)') as location,
--             count(*) as customers,
--             sum(greatest(0, -coalesce(balance,0))) as outstanding_debt
--        from customers group by 1 order by 2 desc;
--
--    Watch for a '(no location)' row: those customers are invisible to every
--    sales user, so their debt will not appear in any sales-side total.
--
-- 4. Privilege escalation is closed. As a SALES user (expect: 0 rows updated):
--
--      update profiles set role = 'admin' where id = auth.uid();
--
-- 5. Manager deletes are refused (expect: 'not permitted to delete sale'):
--
--      select delete_sale(<any sale id>);
--
-- ROLLBACK, if a workflow turns out to depend on the removed breadth:
-- re-create the specific policy that flow needs, scoped to the role that needs
-- it. Do NOT restore a `using (true)` policy — that reopens everything.
-- =============================================================================

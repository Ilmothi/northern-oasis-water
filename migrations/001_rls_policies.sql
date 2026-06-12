-- =============================================================================
-- 001_rls_policies.sql
-- Northern Water Company Ltd — OASIS Springs
--
-- Enables RLS on every table and creates all access policies.
-- All policies call two SECURITY DEFINER helper functions that read role and
-- location from profiles once, rather than subquerying profiles inline in
-- every policy (which would cause recursion once profiles itself has RLS).
--
-- Tables covered:
--   profiles, customers, sales, payments, expenses, purchases,
--   production_logs, employees, payroll_payments,
--   inventory_state, cost_settings, stock_adjustments
--
-- Apply via Supabase SQL Editor — do NOT run directly against prod without review.
-- =============================================================================


-- =============================================================================
-- SECTION 1: Helper functions
-- These are the single source of truth for "who is the calling user?"
-- SECURITY DEFINER means they execute as their owner (postgres) and therefore
-- bypass RLS when they read profiles — no recursion, no inline subqueries.
-- =============================================================================

create or replace function public.get_my_role()
  returns text
  language sql
  stable
  security definer
  set search_path = public
as $$
  select role from profiles where id = auth.uid()
$$;

create or replace function public.get_my_location()
  returns text
  language sql
  stable
  security definer
  set search_path = public
as $$
  select location from profiles where id = auth.uid()
$$;


-- =============================================================================
-- SECTION 2: profiles
--
-- Users read only their own row. Profile creation/deletion is done via the
-- Supabase dashboard or a service-role Edge Function — not from the client.
-- =============================================================================

alter table profiles enable row level security;

create policy "profiles_select_own"
  on profiles for select
  using (id = auth.uid());

create policy "profiles_select_admin"
  on profiles for select
  using (get_my_role() = 'admin');

-- No INSERT / UPDATE / DELETE policies for the client.


-- =============================================================================
-- SECTION 3: customers
--
-- admin/manager : full access to all customers.
-- sales         : read and insert only within their location;
--                 update allowed so the app can write back the balance field
--                 when a sale or payment is recorded.
--                 (column-level restriction to `balance` only is not enforced
--                  here — add a column privilege later if needed.)
-- =============================================================================

alter table customers enable row level security;

create policy "customers_select"
  on customers for select
  using (
    get_my_role() in ('admin', 'manager')
    or (
      get_my_role() = 'sales'
      and (
        get_my_location() is null                         -- no location set: see all
        or location = get_my_location()
      )
    )
  );

create policy "customers_insert"
  on customers for insert
  with check (
    get_my_role() in ('admin', 'manager')
    or (
      get_my_role() = 'sales'
      and (get_my_location() is null or location = get_my_location())
    )
  );

create policy "customers_update_admin_manager"
  on customers for update
  using (get_my_role() in ('admin', 'manager'));

create policy "customers_update_sales"
  on customers for update
  using (
    get_my_role() = 'sales'
    and (get_my_location() is null or location = get_my_location())
  );

create policy "customers_delete"
  on customers for delete
  using (get_my_role() = 'admin');


-- =============================================================================
-- SECTION 4: sales
--
-- Column note: the app stores the foreign key as "customerId" (camelCase).
-- If your column is actually snake_case, change the quoted identifier below.
--
-- admin/manager : full access.
-- sales         : insert any sale; read and update only sales whose customer
--                 is in their location (or own records if no location set).
-- delete        : admin only — deletion reverses stock and debt so it must be
--                 deliberate.
-- =============================================================================

alter table sales enable row level security;

create policy "sales_select"
  on sales for select
  using (
    get_my_role() in ('admin', 'manager')
    or (
      get_my_role() = 'sales'
      and (
        (
          get_my_location() is not null
          and exists (
            select 1 from customers c
            where c.id = sales."customerId"
              and c.location = get_my_location()
          )
        )
        or (get_my_location() is null and created_by = auth.uid())
      )
    )
  );

create policy "sales_insert"
  on sales for insert
  with check (auth.uid() is not null);

create policy "sales_update_admin_manager"
  on sales for update
  using (get_my_role() in ('admin', 'manager'));

-- Sales users need to update paid/status when they record a payment.
create policy "sales_update_sales"
  on sales for update
  using (
    get_my_role() = 'sales'
    and (
      (
        get_my_location() is not null
        and exists (
          select 1 from customers c
          where c.id = sales."customerId"
            and c.location = get_my_location()
        )
      )
      or (get_my_location() is null and created_by = auth.uid())
    )
  );

create policy "sales_delete"
  on sales for delete
  using (get_my_role() = 'admin');


-- =============================================================================
-- SECTION 5: payments
--
-- Column note: "customerId" and "saleId" are camelCase as stored by the app.
--
-- Same location scoping as sales. No UPDATE policy — payments are immutable;
-- corrections go through the delete-and-re-enter flow.
-- =============================================================================

alter table payments enable row level security;

create policy "payments_select"
  on payments for select
  using (
    get_my_role() in ('admin', 'manager')
    or (
      get_my_role() = 'sales'
      and (
        (
          get_my_location() is not null
          and exists (
            select 1 from customers c
            where c.id = payments."customerId"
              and c.location = get_my_location()
          )
        )
        or (get_my_location() is null and created_by = auth.uid())
      )
    )
  );

create policy "payments_insert"
  on payments for insert
  with check (auth.uid() is not null);

-- No UPDATE policy — intentional.

create policy "payments_delete"
  on payments for delete
  using (get_my_role() = 'admin');


-- =============================================================================
-- SECTION 6: expenses
--
-- admin/manager : read and write (insert/update).
-- sales         : read own records only; no write access.
-- delete        : admin only.
-- =============================================================================

alter table expenses enable row level security;

create policy "expenses_select"
  on expenses for select
  using (
    get_my_role() in ('admin', 'manager')
    or (get_my_role() = 'sales' and created_by = auth.uid())
  );

create policy "expenses_insert"
  on expenses for insert
  with check (get_my_role() in ('admin', 'manager'));

create policy "expenses_update"
  on expenses for update
  using (get_my_role() in ('admin', 'manager'));

create policy "expenses_delete"
  on expenses for delete
  using (get_my_role() = 'admin');


-- =============================================================================
-- SECTION 7: purchases
--
-- Plant-level records. admin/manager read and write; admin deletes.
-- =============================================================================

alter table purchases enable row level security;

create policy "purchases_select"
  on purchases for select
  using (get_my_role() in ('admin', 'manager'));

create policy "purchases_insert"
  on purchases for insert
  with check (get_my_role() in ('admin', 'manager'));

create policy "purchases_update"
  on purchases for update
  using (get_my_role() in ('admin', 'manager'));

create policy "purchases_delete"
  on purchases for delete
  using (get_my_role() = 'admin');


-- =============================================================================
-- SECTION 8: production_logs
--
-- Plant-level records. UPDATE is needed so admin/manager can set casual_paid
-- when recording a casual payout.
-- =============================================================================

alter table production_logs enable row level security;

create policy "production_logs_select"
  on production_logs for select
  using (get_my_role() in ('admin', 'manager'));

create policy "production_logs_insert"
  on production_logs for insert
  with check (get_my_role() in ('admin', 'manager'));

create policy "production_logs_update"
  on production_logs for update
  using (get_my_role() in ('admin', 'manager'));

create policy "production_logs_delete"
  on production_logs for delete
  using (get_my_role() = 'admin');


-- =============================================================================
-- SECTION 9: employees
--
-- admin/manager : read (manager needs the roster for payroll view).
-- admin         : all writes.
-- =============================================================================

alter table employees enable row level security;

create policy "employees_select"
  on employees for select
  using (get_my_role() in ('admin', 'manager'));

create policy "employees_insert"
  on employees for insert
  with check (get_my_role() = 'admin');

create policy "employees_update"
  on employees for update
  using (get_my_role() = 'admin');

create policy "employees_delete"
  on employees for delete
  using (get_my_role() = 'admin');


-- =============================================================================
-- SECTION 10: payroll_payments
--
-- admin/manager : read.
-- admin         : all writes.
-- =============================================================================

alter table payroll_payments enable row level security;

create policy "payroll_payments_select"
  on payroll_payments for select
  using (get_my_role() in ('admin', 'manager'));

create policy "payroll_payments_insert"
  on payroll_payments for insert
  with check (get_my_role() = 'admin');

create policy "payroll_payments_update"
  on payroll_payments for update
  using (get_my_role() = 'admin');

create policy "payroll_payments_delete"
  on payroll_payments for delete
  using (get_my_role() = 'admin');


-- =============================================================================
-- SECTION 11: inventory_state
--
-- All authenticated users can read (sales users see stock levels).
-- Write access restricted to admin/manager — the auto-save effect is only
-- triggered by production and purchase flows, which are admin/manager actions.
-- UPSERT requires both INSERT and UPDATE policies.
-- =============================================================================

alter table inventory_state enable row level security;

create policy "inventory_state_select"
  on inventory_state for select
  using (auth.uid() is not null);

create policy "inventory_state_insert"
  on inventory_state for insert
  with check (get_my_role() in ('admin', 'manager'));

create policy "inventory_state_update"
  on inventory_state for update
  using (get_my_role() in ('admin', 'manager'));

create policy "inventory_state_delete"
  on inventory_state for delete
  using (get_my_role() = 'admin');


-- =============================================================================
-- SECTION 12: cost_settings
--
-- All authenticated users can read (carton costs are displayed across roles).
-- Write: admin only.
-- =============================================================================

alter table cost_settings enable row level security;

create policy "cost_settings_select"
  on cost_settings for select
  using (auth.uid() is not null);

create policy "cost_settings_insert"
  on cost_settings for insert
  with check (get_my_role() = 'admin');

create policy "cost_settings_update"
  on cost_settings for update
  using (get_my_role() = 'admin');

create policy "cost_settings_delete"
  on cost_settings for delete
  using (get_my_role() = 'admin');


-- =============================================================================
-- SECTION 13: stock_adjustments
--
-- Immutable audit trail: INSERT only, no UPDATE or DELETE policies.
-- Only admin can create adjustment records (the Adjust tab is admin-only in UI).
-- =============================================================================

alter table stock_adjustments enable row level security;

create policy "stock_adjustments_select"
  on stock_adjustments for select
  using (get_my_role() in ('admin', 'manager'));

create policy "stock_adjustments_insert"
  on stock_adjustments for insert
  with check (get_my_role() = 'admin');

-- Deliberately no UPDATE or DELETE policies — adjustments are permanent records.

-- =============================================================================
-- 011_transactional_money_operations.sql
-- Northern Water Company Ltd — OASIS Springs
--
-- Closes audit finding 3 (docs/audit-2026-07-28.md): non-atomic customer balance
-- and sale-paid updates.
--
-- WHAT IS WRONG TODAY
-- -------------------
-- Every money operation is several separate round trips from the browser, and
-- the balance step works like this:
--
--     read c.balance from local state   (loaded ONCE at login, never refreshed)
--     compute newBalance = balance ± amount
--     UPDATE customers SET balance = newBalance
--
-- Two failures follow:
--
--   1. LOST UPDATES. The written value is absolute and derived from a snapshot
--      that may be hours stale. A second user recording a payment does not just
--      fail to see the first — it overwrites it. `sales.paid` has the same shape,
--      so two payments against one invoice can silently collapse into one.
--
--   2. PARTIAL COMPLETION. The follow-up UPDATEs only console.error on failure,
--      so a sale can insert while its balance update is refused by RLS or lost to
--      a dropped connection, leaving the books wrong with nothing on screen.
--      handleDeleteSale even carries a hand-written compensation branch to
--      half-undo itself when the second of three writes fails.
--
-- THE FIX
-- -------
-- One function per money operation. Each runs as a single statement, so it is a
-- single transaction: every row moves or none does. Within it, balances change
-- by RELATIVE DELTA under the row lock the UPDATE takes —
--
--     UPDATE customers SET balance = balance + p_delta WHERE id = ...
--
-- so concurrent callers serialize and each delta lands on the CURRENT committed
-- value. A stale client can no longer clobber a balance, exactly as migration 009
-- did for stock. `sales.paid` moves the same way, and `status` is recomputed
-- server-side from the resulting figures rather than trusted from the client.
--
-- AUTHORISATION IS UNCHANGED — these are SECURITY INVOKER
-- -------------------------------------------------------
-- Unlike 009/010's inventory helpers, these functions run as the CALLER, so every
-- statement inside is still policed by the existing RLS policies on sales,
-- payments, customers and consignment_movements. This migration deliberately
-- moves NO authorisation into application code: who may record or delete what is
-- still decided by the policies in 001 and 010.
--
-- One consequence needs care: when RLS refuses a write, Postgres does not raise —
-- it simply matches zero rows. Every UPDATE/DELETE below therefore checks
-- row_count and raises, so a refusal aborts the whole operation loudly instead of
-- silently doing half of it. This is the same class of bug the 2026-07-07 audit
-- found in the delete flows.
--
-- BALANCE SIGN CONVENTION (unchanged, matching the app)
-- ----------------------------------------------------
--   NEGATIVE balance = the customer OWES us.
--   A credit sale applies -(total - paid); a payment applies +amount.
--
-- Apply via the Supabase SQL Editor AFTER review. Idempotent — safe to re-run.
-- The client in this same PR calls these functions; applying the migration first
-- is safe (the old code paths keep working), deploying the client first is NOT.
-- =============================================================================

begin;


-- =============================================================================
-- SECTION 1: helpers
-- =============================================================================

-- Recompute a sale's status from its own figures. Single definition so the four
-- flows that touch `paid` cannot drift apart. Mirrors the existing client rule,
-- including the credit note case (total < 0, paid 0 → 0 >= total → 'paid').
create or replace function sale_status(p_paid numeric, p_total numeric)
returns text
language sql
immutable
as $$
  select case
           when p_paid >= p_total then 'paid'
           when p_paid > 0        then 'partial'
           else 'pending'
         end;
$$;

-- Build the finished-goods delta array for a sale's items.
--   sign = -1 when recording a sale (cartons leave), +1 when deleting one.
-- Sizes that do not exist in the finishedGoods blob are skipped, mirroring the
-- client's `if (updatedFinishedGoods[item.size])` guard, so an unrecognised size
-- can never create a stray key.
create or replace function fg_delta_changes(p_items jsonb, p_sign int)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'id',    'finishedGoods',
             'path',  jsonb_build_array(item ->> 'size', 'quantity'),
             'delta', p_sign * (item ->> 'quantity')::numeric
           )
         ), '[]'::jsonb)
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) as item
   where (item ->> 'quantity')::numeric <> 0
     and exists (
           select 1 from inventory_state
            where id = 'finishedGoods'
              and data ? (item ->> 'size')
         );
$$;

-- Apply a relative balance change and return the customer's fresh row.
-- Returns NULL when the customer does not exist, which the callers treat the
-- same way the client does today (skip silently — an orphaned sale). A customer
-- that EXISTS but whose UPDATE is refused by RLS raises instead.
create or replace function adjust_customer_balance(p_customer_id bigint, p_delta numeric)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_count int;
  result  jsonb;
begin
  if p_customer_id is null or p_delta is null then
    raise exception 'adjust_customer_balance: customer id and delta are required';
  end if;

  if not exists (select 1 from customers where id = p_customer_id) then
    return null;
  end if;

  -- Relative, under the row lock this UPDATE takes: concurrent callers serialize
  -- and each delta applies to the latest committed balance.
  update customers
     set balance = coalesce(balance, 0) + p_delta
   where id = p_customer_id;

  get diagnostics v_count = row_count;
  if v_count = 0 then
    raise exception 'adjust_customer_balance: not permitted to update customer %', p_customer_id;
  end if;

  select to_jsonb(c) into result from customers c where c.id = p_customer_id;
  return result;
end;
$$;

-- Apply a relative change to a sale's paid amount and recompute its status.
-- Same NULL-vs-raise rule as adjust_customer_balance.
create or replace function adjust_sale_paid(p_sale_id bigint, p_delta numeric)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_count int;
  result  jsonb;
begin
  if p_sale_id is null or p_delta is null then
    raise exception 'adjust_sale_paid: sale id and delta are required';
  end if;

  if not exists (select 1 from sales where id = p_sale_id) then
    return null;
  end if;

  update sales
     set paid   = coalesce(paid, 0) + p_delta,
         status = sale_status(coalesce(paid, 0) + p_delta, total)
   where id = p_sale_id;

  get diagnostics v_count = row_count;
  if v_count = 0 then
    raise exception 'adjust_sale_paid: not permitted to update sale %', p_sale_id;
  end if;

  select to_jsonb(s) into result from sales s where s.id = p_sale_id;
  return result;
end;
$$;


-- =============================================================================
-- SECTION 2: record_sale
--
-- Insert the sale, deduct finished goods, and debit the customer — atomically.
-- Stock movement is DERIVED from the sale's own items rather than passed in, so
-- the cartons deducted can never disagree with the cartons invoiced.
-- =============================================================================

create or replace function record_sale(p_sale jsonb)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_customer_id bigint;
  v_total       numeric;
  v_paid        numeric;
  v_items       jsonb;
  v_sale        sales;
  v_changes     jsonb;
  v_inventory   jsonb;
  v_customer    jsonb;
begin
  v_customer_id := (p_sale ->> 'customerId')::bigint;
  v_total       := (p_sale ->> 'total')::numeric;
  v_paid        := coalesce((p_sale ->> 'paid')::numeric, 0);
  v_items       := coalesce(p_sale -> 'items', '[]'::jsonb);

  if v_customer_id is null or v_total is null then
    raise exception 'record_sale: customerId and total are required';
  end if;
  if v_paid < 0 or v_paid > v_total then
    raise exception 'record_sale: paid (%) must be between 0 and total (%)', v_paid, v_total;
  end if;

  -- id and invoiceNumber stay database-assigned. status is computed here, never
  -- taken from the client.
  insert into sales ("customerId", date, items, total, paid, status, method, created_by)
  values (
    v_customer_id,
    coalesce((p_sale ->> 'date')::date, current_date),
    v_items,
    v_total,
    v_paid,
    sale_status(v_paid, v_total),
    nullif(p_sale ->> 'method', ''),
    nullif(p_sale ->> 'created_by', '')::uuid
  )
  returning * into v_sale;

  v_changes := fg_delta_changes(v_items, -1);
  if jsonb_array_length(v_changes) > 0 then
    v_inventory := apply_inventory_deltas(v_changes);
  end if;

  -- Only the unpaid remainder becomes debt.
  v_customer := adjust_customer_balance(v_customer_id, -(v_total - v_paid));

  return jsonb_build_object(
    'sale',      to_jsonb(v_sale),
    'customer',  v_customer,
    'inventory', v_inventory
  );
end;
$$;


-- =============================================================================
-- SECTION 3: record_payment
--
-- Insert the payment, credit the sale, credit the customer — atomically.
-- The over-payment check reads the CURRENT committed sale row, so a stale client
-- can no longer let a sale be paid twice over.
-- =============================================================================

create or replace function record_payment(p_payment jsonb)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_sale_id     bigint;
  v_amount      numeric;
  v_sale        sales;
  v_payment     payments;
  v_customer_id bigint;
begin
  v_sale_id := (p_payment ->> 'saleId')::bigint;
  v_amount  := (p_payment ->> 'amount')::numeric;

  if v_sale_id is null or v_amount is null then
    raise exception 'record_payment: saleId and amount are required';
  end if;
  if v_amount <= 0 then
    raise exception 'record_payment: amount must be greater than zero';
  end if;

  -- Lock the sale first so a concurrent payment cannot slip past this check.
  select * into v_sale from sales where id = v_sale_id for update;
  if not found then
    raise exception 'record_payment: sale % not found', v_sale_id;
  end if;

  if v_amount > (v_sale.total - coalesce(v_sale.paid, 0)) then
    raise exception 'record_payment: amount % exceeds the outstanding balance of % on this invoice',
      v_amount, (v_sale.total - coalesce(v_sale.paid, 0));
  end if;

  -- The customer is taken from the sale, not the client payload.
  v_customer_id := v_sale."customerId";

  insert into payments ("saleId", "customerId", date, amount, method, reference, created_by)
  values (
    v_sale_id,
    v_customer_id,
    coalesce((p_payment ->> 'date')::date, current_date),
    v_amount,
    nullif(p_payment ->> 'method', ''),
    nullif(p_payment ->> 'reference', ''),
    nullif(p_payment ->> 'created_by', '')::uuid
  )
  returning * into v_payment;

  return jsonb_build_object(
    'payment',  to_jsonb(v_payment),
    'sale',     adjust_sale_paid(v_sale_id, v_amount),
    'customer', adjust_customer_balance(v_customer_id, v_amount)
  );
end;
$$;


-- =============================================================================
-- SECTION 4: delete_sale
--
-- Remove the sale and its linked payments, return the cartons, and reverse the
-- customer's balance — atomically.
--
-- Balance reversal is +(total - paid), read from the COMMITTED sale row: deleting
-- the sale cancels the original debit of (total - paid at creation) and deleting
-- the linked payments removes the credits they applied. Net = +(total - paid).
--
-- Because this is one transaction, the client's compensation branch for "payments
-- deleted but sale delete failed" becomes unnecessary — that state can no longer
-- exist.
--
-- Consignment-linked sales are refused here, matching the client guard: their
-- stock left at DELIVERY, so returning cartons would inflate finished goods.
-- =============================================================================

create or replace function delete_sale(p_sale_id bigint)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_sale      sales;
  v_count     int;
  v_changes   jsonb;
  v_inventory jsonb;
begin
  select * into v_sale from sales where id = p_sale_id for update;
  if not found then
    raise exception 'delete_sale: sale % not found', p_sale_id;
  end if;

  if exists (select 1 from consignment_movements where sale_id = p_sale_id) then
    raise exception 'delete_sale: sale % is linked to consignment stock and must be reversed from the Consignment view', p_sale_id;
  end if;

  -- Linked payments first (they reference the sale). Zero rows is legitimate —
  -- a sale may simply have no payments — so this one is not row_count-checked.
  delete from payments where "saleId" = p_sale_id;

  delete from sales where id = p_sale_id;
  get diagnostics v_count = row_count;
  if v_count = 0 then
    raise exception 'delete_sale: not permitted to delete sale %', p_sale_id;
  end if;

  -- Return the cartons, derived from the sale row that was just removed.
  v_changes := fg_delta_changes(v_sale.items, 1);
  if jsonb_array_length(v_changes) > 0 then
    v_inventory := apply_inventory_deltas(v_changes);
  end if;

  return jsonb_build_object(
    'customer',  adjust_customer_balance(v_sale."customerId", v_sale.total - coalesce(v_sale.paid, 0)),
    'inventory', v_inventory
  );
end;
$$;


-- =============================================================================
-- SECTION 5: delete_payment
--
-- Remove the payment, roll back the sale's paid/status, and debit the customer
-- back — atomically.
-- =============================================================================

create or replace function delete_payment(p_payment_id bigint)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_payment payments;
  v_count   int;
begin
  select * into v_payment from payments where id = p_payment_id for update;
  if not found then
    raise exception 'delete_payment: payment % not found', p_payment_id;
  end if;

  delete from payments where id = p_payment_id;
  get diagnostics v_count = row_count;
  if v_count = 0 then
    raise exception 'delete_payment: not permitted to delete payment %', p_payment_id;
  end if;

  -- Both helpers return NULL when the parent row is already gone, matching the
  -- client's existing `if (sale)` / `if (customer)` guards.
  return jsonb_build_object(
    'sale',     adjust_sale_paid(v_payment."saleId", -v_payment.amount),
    'customer', adjust_customer_balance(v_payment."customerId", -v_payment.amount)
  );
end;
$$;


-- =============================================================================
-- SECTION 6: consignment_post_sale
--
-- Covers BOTH consignment money flows — Report Sold and Reconcile — because they
-- are the same transaction shape: insert a sale row, insert the matching ledger
-- movements pointing at it, adjust the shop's balance by -(total - paid).
--
--   Report Sold : positive total, movements of type 'sold'      → debt increases
--   Reconcile   : negative total, movements of type 'reconcile' → debt decreases
--
-- They are deliberately NOT split into two functions. Which of the two a caller
-- may perform is decided by the RLS policy on consignment_movements from
-- migration 010 (managers may insert 'sold', only admins may insert 'reconcile')
-- plus the negative-total sales policy. Splitting them here would duplicate that
-- rule in application code, where it does not belong.
--
-- Finished goods are deliberately untouched: those cartons left the plant at
-- delivery, and reconciled stock never returned to it.
-- =============================================================================

create or replace function consignment_post_sale(p_sale jsonb, p_movements jsonb)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_shop_id bigint;
  v_total   numeric;
  v_paid    numeric;
  v_sale    sales;
  v_moves   jsonb;
begin
  v_shop_id := (p_sale ->> 'customerId')::bigint;
  v_total   := (p_sale ->> 'total')::numeric;
  v_paid    := coalesce((p_sale ->> 'paid')::numeric, 0);

  if v_shop_id is null or v_total is null then
    raise exception 'consignment_post_sale: customerId and total are required';
  end if;
  if p_movements is null or jsonb_typeof(p_movements) <> 'array'
     or jsonb_array_length(p_movements) = 0 then
    raise exception 'consignment_post_sale: at least one movement is required';
  end if;
  if not exists (select 1 from customers where id = v_shop_id and is_consignee) then
    raise exception 'consignment_post_sale: customer % is not a consignment shop', v_shop_id;
  end if;

  insert into sales ("customerId", date, items, total, paid, status, method, created_by)
  values (
    v_shop_id,
    coalesce((p_sale ->> 'date')::date, current_date),
    coalesce(p_sale -> 'items', '[]'::jsonb),
    v_total,
    v_paid,
    sale_status(v_paid, v_total),
    nullif(p_sale ->> 'method', ''),
    nullif(p_sale ->> 'created_by', '')::uuid
  )
  returning * into v_sale;

  -- Movements carry the new sale's id, so ledger and books cannot separate.
  with inserted as (
    insert into consignment_movements
      (shop_id, date, type, size, quantity, unit_price, sale_id, note, created_by)
    select
      v_shop_id,
      coalesce((m ->> 'date')::date, current_date),
      m ->> 'type',
      m ->> 'size',
      (m ->> 'quantity')::numeric,
      (m ->> 'unit_price')::numeric,
      v_sale.id,
      nullif(m ->> 'note', ''),
      nullif(m ->> 'created_by', '')::uuid
    from jsonb_array_elements(p_movements) as m
    returning *
  )
  select coalesce(jsonb_agg(to_jsonb(inserted)), '[]'::jsonb) into v_moves from inserted;

  return jsonb_build_object(
    'sale',      to_jsonb(v_sale),
    'movements', v_moves,
    'customer',  adjust_customer_balance(v_shop_id, -(v_total - v_paid))
  );
end;
$$;


-- =============================================================================
-- SECTION 7: grants
--
-- EXECUTE only lets a signed-in user call these. Because every function is
-- SECURITY INVOKER, the existing RLS policies still decide what each caller can
-- actually read, write or delete inside them.
-- =============================================================================

grant execute on function sale_status(numeric, numeric)                  to authenticated;
grant execute on function fg_delta_changes(jsonb, int)                   to authenticated;
grant execute on function adjust_customer_balance(bigint, numeric)       to authenticated;
grant execute on function adjust_sale_paid(bigint, numeric)              to authenticated;
grant execute on function record_sale(jsonb)                             to authenticated;
grant execute on function record_payment(jsonb)                          to authenticated;
grant execute on function delete_sale(bigint)                            to authenticated;
grant execute on function delete_payment(bigint)                         to authenticated;
grant execute on function consignment_post_sale(jsonb, jsonb)            to authenticated;

revoke all on function record_sale(jsonb)                  from anon, public;
revoke all on function record_payment(jsonb)               from anon, public;
revoke all on function delete_sale(bigint)                 from anon, public;
revoke all on function delete_payment(bigint)              from anon, public;
revoke all on function consignment_post_sale(jsonb, jsonb) from anon, public;
revoke all on function adjust_customer_balance(bigint, numeric) from anon, public;
revoke all on function adjust_sale_paid(bigint, numeric)        from anon, public;

commit;


-- =============================================================================
-- AFTER APPLYING — verification
--
-- 1. Concurrency, the bug this exists to fix. Open TWO SQL Editor tabs and run
--    the payment in both at once against one invoice. Before: one payment could
--    overwrite the other. Now: both apply, or the second is refused for
--    exceeding the outstanding balance. Neither silently disappears.
--
--      select record_payment(
--        jsonb_build_object('saleId', <id>, 'amount', 100, 'method', 'cash'));
--
--    Then confirm the arithmetic ties out:
--      select s.id, s.total, s.paid, s.status,
--             (select coalesce(sum(p.amount),0) from payments p where p."saleId" = s.id)
--               as payments_recorded
--        from sales s where s.id = <id>;
--
-- 2. Atomicity. A refused step must undo the whole operation — nothing partial:
--      select delete_sale(<a consignment-linked sale id>);   -- expect: exception
--      select * from sales where id = <that id>;             -- still present
--      select * from payments where "saleId" = <that id>;    -- still present
--
-- 3. Authorisation is unchanged. As a MANAGER (deletes are admin-only in RLS):
--      select delete_sale(<id>);      -- expect: 'not permitted to delete sale'
--      select delete_payment(<id>);   -- expect: 'not permitted to delete payment'
--    As a SALES user, recording a sale and a payment for a customer at their own
--    location must still succeed.
--
-- 4. Reconciliation. Balances must equal the transactions behind them:
--      select c.id, c.name, c.balance,
--             -( coalesce((select sum(s.total - s.paid) from sales s
--                           where s."customerId" = c.id), 0) ) as expected_balance
--        from customers c
--       order by c.name;
--    Investigate any row where balance <> expected_balance BEFORE going live —
--    a pre-existing mismatch is historical drift from the old non-atomic writes,
--    not something this migration introduces.
-- =============================================================================

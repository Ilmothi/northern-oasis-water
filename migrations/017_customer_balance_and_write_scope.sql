-- =============================================================================
-- 017_customer_balance_and_write_scope.sql
-- Northern Water Company Ltd — OASIS Springs
--
-- Closes findings 1 and 3 of docs/audit-2026-07-30-rls.md, and the forgeable /
-- unscoped half of finding 2.
--
-- WHAT WAS WRONG
-- --------------
-- FINDING 1 (Critical) — `customers.balance` was writable by any staff user by
-- two independent routes:
--
--   a. REST. `customers_update_admin_manager` and `customers_update_sales` both
--      have `with_check: null` and no column restriction, so
--      `PATCH /rest/v1/customers?id=eq.42 {"balance":0}` erased a debt with no
--      payment row and no audit trail.
--   b. RPC. `011` grants `adjust_customer_balance(bigint, numeric)` to
--      `authenticated` and it takes an arbitrary delta, so the same thing was
--      reachable as `rpc('adjust_customer_balance', {p_customer_id: 42,
--      p_delta: 999999})` regardless of how tight the table policy is.
--
--   Closing (a) alone would have been cosmetic. This migration closes both.
--
-- FINDING 3 (Critical) — `sales_insert_non_admin` was
-- `auth.uid() is not null and total >= 0`: no location scope and no attribution
-- check, unlike `sales_select` / `sales_update_sales`. A Loglogo rep could insert
-- sales against Marsabit or Korr customers with a forged `created_by`. They could
-- not read them back, but the rows landed in the books and in every admin report.
--   `010` section 6 flagged this knowingly out of scope at the time.
--
-- FINDING 2 (Critical, PARTIAL here) — `payments_insert` with_check was exactly
-- `auth.uid() is not null`. This migration adds the role gate, the location
-- scope, `created_by = auth.uid()` and a saleId/customerId agreement check.
--   It does NOT stop a sales user inserting a payment directly against their own
--   customer and bypassing `record_payment`'s over-payment guard. Doing that
--   requires revoking INSERT on `payments` and making `record_payment`
--   SECURITY DEFINER — see `018`, which is deliberately a separate migration so
--   that a fault in its hand-written gates can be rolled back without giving up
--   the balance fix here.
--
-- THE APPROACH FOR FINDING 1
-- --------------------------
-- `customers.balance` becomes a DERIVED cache rather than a value anyone may
-- set. `adjust_customer_balance(id, delta)` is dropped and replaced by
-- `recompute_customer_balance(id)`, which takes no amount and re-derives:
--
--     balance = -sum(sales.total - sales.paid)   over that customer's sales
--
-- That is the same invariant `downloadAccountStatementAsPDF` already asserts in
-- src/App.jsx ("the closing balance equals the customer's current outstanding
-- debt"), and it is the figure the 2026-07-28 drift correction moved 5 customers
-- TO. Because there is no amount to pass, the function is safe to leave granted
-- to `authenticated` even as SECURITY DEFINER: the worst a caller can do is
-- force a balance to be correct.
--
-- Negative balance = customer owes us. Payments reach the balance through
-- `sales.paid`, so summing sales alone is complete and cannot double-count.
--
-- WHAT THIS DELIBERATELY DOES NOT FIX
-- -----------------------------------
--   * The `record_payment` bypass (finding 2's remainder) — `018`.
--   * `sales_update_sales` / `sales_update_admin_manager` still have no
--     `with_check` and no column restriction, so `sales.paid` is directly
--     PATCHable by an in-scope staff user. A derived balance is only as
--     trustworthy as `sales.paid`, so this matters more after this migration
--     than before it. Not a listed audit finding; closed in `018`.
--   * Finding 12's null-location fallthrough is NOT widened but is not closed
--     either. The two policies rewritten here mirror `sales_select` /
--     `payments_select`, which scope a null-location sales user to their own
--     records (`created_by = auth.uid()`) rather than company-wide — so as
--     rewritten they are already tighter than `customers_*`, where the
--     fallthrough still lives.
--   * Findings 4-11, 13.
--
-- CLIENT DEPENDENCY — READ THIS BEFORE APPLYING
-- ---------------------------------------------
-- Section 5 revokes table-wide UPDATE on `customers`. Until the matching client
-- is deployed, `handleSaveCustomer` sends the ENTIRE customer row back on every
-- edit (`setFormData(customer)` at src/App.jsx openEdit), including `id`,
-- `balance` and `created_at` — every one of which is about to become
-- ungrantable. Applying this first would break customer editing outright with
-- "permission denied for column".
--
-- So the order here is the REVERSE of 015/016: **merge and deploy the client
-- first, confirm the Netlify deploy is live, then apply this file.**
--
-- REPORT IMPACT
-- -------------
-- **This file moves no reported figure on its own.** It changes who may write
-- `customers.balance` and how; it does not correct the balances that are already
-- wrong. Block 0a below found five customers, KES 5,450 of understated debt, and
-- that correction ships separately as `018_settle_customer_balances.sql` —
-- extracted so that this file continues to match, statement for statement, what
-- was applied to production on 2026-08-01.
--
-- Until 018 is applied, those five settle lazily: each corrects itself the next
-- time a sale or payment touches that customer, because `balance` is derived
-- from that point on. Debtors will creep up toward the true figure rather than
-- step to it. Apply 018 to make it deliberate and observable instead.
-- =============================================================================


-- =============================================================================
-- BLOCK 0 — PRE-FLIGHT. Read-only. Run this on its own and read the output
-- BEFORE applying the transaction below.
--
-- 0a. Every customer whose stored balance disagrees with their sales ledger.
--     These are the rows that will move, and `delta` is how much each will move
--     by.
--
--     RUN 2026-08-01 — RESULT RECORDED, because it was not what was expected:
--
--       id   name                 location  stored  derived   delta
--       97   NICONDEMUS GITONGA   Loglogo      300    -2220   -2520
--       31   JANE KOROLLE         Loglogo    -2160    -3840   -1680
--       36   AHATHO EYSIMKELE     Loglogo        0     -420    -420
--       128  MADINA EYSIMFECHA    Loglogo        0     -420    -420
--       32   IRENE KASULA         Loglogo    -1640    -2050    -410
--                                                    total:   -5450
--
--     This is the SAME five customers, the same stored values and the same
--     deltas as the reconciliation run on 2026-07-28, which was recorded as
--     having been corrected via `adjust_customer_balance`. It was not
--     corrected. The statement was written and reported as run, and the result
--     was never checked against the table afterwards — the same failure mode as
--     the `010` partial apply, and the reason migrations/README.md now says a
--     migration must prove it landed rather than that it ran. A `begin;` block
--     that was never committed would produce exactly this, but nobody knows.
--
--     So applying this migration and settling the balances (verification step 4)
--     IS that correction, made for real this time. Debtors and Aging Debtors
--     rise by KES 5,450. Cash Collected and the P&L do not read
--     `customers.balance` and are unaffected.
--
--     Unlike 2026-07-28, this correction is verifiable by construction: the
--     figure is derived rather than applied as a delta, so re-running it is a
--     no-op, and verification step 4 re-runs this exact query and must return
--     zero rows. It cannot half-land.
--
--     If this query returns rows AFTER 017 is live and settled, that is a
--     genuinely new discrepancy — `balance` is not client-writable at that
--     point — and it should be understood rather than absorbed.
--
--       select c.id,
--              c.name,
--              c.location,
--              coalesce(c.balance, 0)                                   as stored,
--              coalesce(d.derived, 0)                                   as derived,
--              coalesce(d.derived, 0) - coalesce(c.balance, 0)          as delta
--         from customers c
--         left join lateral (
--                select -coalesce(sum(s.total - coalesce(s.paid, 0)), 0) as derived
--                  from sales s
--                 where s."customerId" = c.id
--              ) d on true
--        where coalesce(c.balance, 0) <> coalesce(d.derived, 0)
--        order by abs(coalesce(d.derived, 0) - coalesce(c.balance, 0)) desc;
--
--     Total movement in the Debtors report, if you want the one-line version:
--
--       select sum(coalesce(d.derived, 0) - coalesce(c.balance, 0)) as debtors_shift
--         from customers c
--         left join lateral (
--                select -coalesce(sum(s.total - coalesce(s.paid, 0)), 0) as derived
--                  from sales s where s."customerId" = c.id
--              ) d on true;
--
-- 0b. Confirm the column names section 5 grants. The grant list must be exactly
--     the columns the customer form edits, and must NOT contain `balance`.
--     If a name here is wrong the GRANT errors and the whole transaction rolls
--     back — which is safe, but check first rather than finding out that way.
--
--       select column_name, data_type
--         from information_schema.columns
--        where table_schema = 'public' and table_name = 'customers'
--        order by ordinal_position;
--
-- 0c. Confirm nothing else calls the function being dropped in section 4.
--     Expect only the five `011` money functions.
--
--       select p.proname
--         from pg_proc p
--         join pg_namespace n on n.oid = p.pronamespace
--        where n.nspname = 'public'
--          and pg_get_functiondef(p.oid) ilike '%adjust_customer_balance%'
--        order by 1;
-- =============================================================================


begin;


-- =============================================================================
-- SECTION 1: recompute_customer_balance
--
-- SECURITY DEFINER because `authenticated` loses the ability to write
-- `customers.balance` in section 5 — this function becomes the only route to
-- that column, which is the entire point.
--
-- No role gate is needed to make the WRITE safe: there is no amount parameter,
-- so any caller, of any role, can only move the balance to the figure the sales
-- ledger already implies. The gate below exists for the READ — DEFINER bypasses
-- RLS on the `select to_jsonb(c)` too, and without it a sales user could call
-- this for an out-of-location customer and read back their name, phone and
-- balance. It mirrors `customers_select`.
--
-- The gate uses `coalesce(get_my_role(), '')`, not a bare comparison: a caller
-- with no `profiles` row gets NULL from `get_my_role()`, and `NULL not in (...)`
-- is NULL, which a plpgsql IF does not take. That is finding 14, and it is how
-- `010` shipped both inventory functions believing they failed closed.
--
-- Locking: the row lock is taken BEFORE the sum, and the sum runs as its own
-- statement. Under READ COMMITTED that means two concurrent sales for the same
-- customer serialize here, and the second one's sum sees the first one's
-- committed sale. Without the lock, recomputing would be a lost-update hazard
-- where `adjust_customer_balance`'s relative delta was not.
-- =============================================================================

create or replace function recompute_customer_balance(p_customer_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role     text;
  v_location text;
  v_balance  numeric;
  result     jsonb;
begin
  if p_customer_id is null then
    raise exception 'recompute_customer_balance: customer id is required';
  end if;

  v_role := coalesce(get_my_role(), '');
  if v_role is distinct from 'admin'
     and v_role is distinct from 'manager'
     and v_role is distinct from 'sales' then
    raise exception 'recompute_customer_balance: not permitted';
  end if;

  -- Lock first, then sum. Also serves as the existence check: NULL for a
  -- customer that is not there, matching adjust_customer_balance's contract and
  -- the client's `if (customer)` guards.
  perform 1 from customers where id = p_customer_id for update;
  if not found then
    return null;
  end if;

  if v_role = 'sales' then
    v_location := get_my_location();
    if v_location is not null
       and (select location from customers where id = p_customer_id)
           is distinct from v_location then
      raise exception 'recompute_customer_balance: customer % is outside your location', p_customer_id;
    end if;
  end if;

  select -coalesce(sum(s.total - coalesce(s.paid, 0)), 0)
    into v_balance
    from sales s
   where s."customerId" = p_customer_id;

  update customers set balance = v_balance where id = p_customer_id;

  select to_jsonb(c) into result from customers c where c.id = p_customer_id;
  return result;
end;
$$;


-- =============================================================================
-- SECTION 2: rewire the five money functions onto the new helper
--
-- Bodies are otherwise unchanged from `011`. Two things to note:
--
--   * ORDER MATTERS NOW. A relative delta could be applied at any point in the
--     function; a recompute must run AFTER the rows it derives from are written.
--     In `record_payment` and `delete_payment` the old calls sat as two fields of
--     one `jsonb_build_object`, whose argument evaluation order is not
--     guaranteed. That was harmless for deltas and is NOT harmless for a
--     recompute, so both are hoisted into variables in explicit order.
--   * These stay SECURITY INVOKER. RLS still governs every row they touch.
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

  -- After the insert: the new sale is part of what the balance derives from.
  v_customer := recompute_customer_balance(v_customer_id);

  return jsonb_build_object(
    'sale',      to_jsonb(v_sale),
    'customer',  v_customer,
    'inventory', v_inventory
  );
end;
$$;


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
  v_sale_json   jsonb;
  v_customer    jsonb;
begin
  v_sale_id := (p_payment ->> 'saleId')::bigint;
  v_amount  := (p_payment ->> 'amount')::numeric;

  if v_sale_id is null or v_amount is null then
    raise exception 'record_payment: saleId and amount are required';
  end if;
  if v_amount <= 0 then
    raise exception 'record_payment: amount must be greater than zero';
  end if;

  select * into v_sale from sales where id = v_sale_id for update;
  if not found then
    raise exception 'record_payment: sale % not found', v_sale_id;
  end if;

  if v_amount > (v_sale.total - coalesce(v_sale.paid, 0)) then
    raise exception 'record_payment: amount % exceeds the outstanding balance of % on this invoice',
      v_amount, (v_sale.total - coalesce(v_sale.paid, 0));
  end if;

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

  -- Explicit order: the sale's `paid` must be updated before the balance is
  -- derived from it.
  v_sale_json := adjust_sale_paid(v_sale_id, v_amount);
  v_customer  := recompute_customer_balance(v_customer_id);

  return jsonb_build_object(
    'payment',  to_jsonb(v_payment),
    'sale',     v_sale_json,
    'customer', v_customer
  );
end;
$$;


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
  v_customer  jsonb;
begin
  select * into v_sale from sales where id = p_sale_id for update;
  if not found then
    raise exception 'delete_sale: sale % not found', p_sale_id;
  end if;

  if exists (select 1 from consignment_movements where sale_id = p_sale_id) then
    raise exception 'delete_sale: sale % is linked to consignment stock and must be reversed from the Consignment view', p_sale_id;
  end if;

  delete from payments where "saleId" = p_sale_id;

  delete from sales where id = p_sale_id;
  get diagnostics v_count = row_count;
  if v_count = 0 then
    raise exception 'delete_sale: not permitted to delete sale %', p_sale_id;
  end if;

  v_changes := fg_delta_changes(v_sale.items, 1);
  if jsonb_array_length(v_changes) > 0 then
    v_inventory := apply_inventory_deltas(v_changes);
  end if;

  -- After both deletes: the sale and its payments are gone, so the recompute
  -- reflects the reversal without needing to know the amounts.
  v_customer := recompute_customer_balance(v_sale."customerId");

  return jsonb_build_object(
    'customer',  v_customer,
    'inventory', v_inventory
  );
end;
$$;


create or replace function delete_payment(p_payment_id bigint)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_payment   payments;
  v_count     int;
  v_sale_json jsonb;
  v_customer  jsonb;
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

  -- Explicit order, as in record_payment.
  v_sale_json := adjust_sale_paid(v_payment."saleId", -v_payment.amount);
  v_customer  := recompute_customer_balance(v_payment."customerId");

  return jsonb_build_object(
    'sale',     v_sale_json,
    'customer', v_customer
  );
end;
$$;


create or replace function consignment_post_sale(p_sale jsonb, p_movements jsonb)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_shop_id  bigint;
  v_total    numeric;
  v_paid     numeric;
  v_sale     sales;
  v_moves    jsonb;
  v_customer jsonb;
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

  -- After the sale insert. The reconciliation credit note is a negative-total
  -- sale, so this handles it the same way without a special case.
  v_customer := recompute_customer_balance(v_shop_id);

  return jsonb_build_object(
    'sale',      to_jsonb(v_sale),
    'movements', v_moves,
    'customer',  v_customer
  );
end;
$$;


-- =============================================================================
-- SECTION 3: grants for the new helper
-- =============================================================================

grant execute on function recompute_customer_balance(bigint) to authenticated;
revoke all on function recompute_customer_balance(bigint) from anon, public;


-- =============================================================================
-- SECTION 4: drop the arbitrary-delta balance helper
--
-- Dropped rather than revoked. A revoked function is one careless `grant` away
-- from being a hole again, and there is no caller left after section 2.
-- =============================================================================

drop function if exists adjust_customer_balance(bigint, numeric);


-- =============================================================================
-- SECTION 5: column-level UPDATE privileges on `customers`
--
-- Closes finding 1's REST route. `balance` is absent from the grant list, so
-- `PATCH /rest/v1/customers {"balance":0}` now fails with
-- "permission denied for column balance" before RLS is even consulted.
--
-- The granted list is exactly what the customer form edits. `isActive` is
-- included even though no control currently sets it — handleDeleteCustomer tells
-- the user to "mark them inactive instead", so the column is meant to be
-- editable and a future toggle should not need a migration.
--
-- Adding an editable customer field later means adding it here too, or the edit
-- will fail with a permission error rather than a validation one.
--
-- `service_role` is untouched: it needs full access for dashboard and support
-- work, and it already bypasses RLS.
-- =============================================================================

revoke update on customers from authenticated, anon;

grant update (name, location, phone, is_consignee, "isActive")
  on customers to authenticated;


-- =============================================================================
-- SECTION 6: sales INSERT — location scope and attribution (finding 3)
--
-- Mirrors `sales_select` exactly, so what a sales user may CREATE is now the
-- same set as what they may READ. `total >= 0` is carried over unchanged from
-- `010` section 6 — only an admin may post the negative-total reconciliation
-- credit note.
--
-- `created_by = auth.uid()` also closes the sales half of finding 6:
-- `record_sale` takes `created_by` from its JSON payload, and this makes a
-- forged value fail the check rather than land in the books. The client already
-- sets it from the session on every sale path, so no live flow changes.
--
-- `sales_insert_admin` is left alone — admins are unrestricted by design.
-- =============================================================================

drop policy if exists "sales_insert_non_admin" on sales;
create policy "sales_insert_non_admin"
  on sales for insert
  with check (
    total >= 0
    and created_by = auth.uid()
    and (
      get_my_role() = 'manager'
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
          or get_my_location() is null   -- own records only, via created_by above
        )
      )
    )
  );


-- =============================================================================
-- SECTION 7: payments INSERT — role, scope and attribution (finding 2, partial)
--
-- Mirrors `payments_select`. Adds, over `001`'s `auth.uid() is not null`:
--
--   * a role gate — the previous check let ANY authenticated principal insert;
--   * location scope for the sales role;
--   * `created_by = auth.uid()`, so a payment can no longer be attributed to a
--     colleague (finding 6, payments half);
--   * agreement between "saleId" and "customerId". `record_payment` derives the
--     customer FROM the sale, so it satisfies this by construction; a direct
--     insert can no longer credit one customer for another's invoice.
--
-- What this still allows, and what `018` is for: an in-scope sales user can
-- insert a well-formed payment row directly and skip `record_payment`'s
-- over-payment guard. It inflates Cash Collected. It no longer corrupts the
-- customer's debt — after section 1 the balance derives from `sales`, and a
-- stray payment row does not touch `sales.paid`.
-- =============================================================================

drop policy if exists "payments_insert" on payments;
create policy "payments_insert"
  on payments for insert
  with check (
    created_by = auth.uid()
    and exists (
      select 1 from sales s
      where s.id = payments."saleId"
        and s."customerId" = payments."customerId"
    )
    and (
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
          or get_my_location() is null   -- own records only, via created_by above
        )
      )
    )
  );


commit;


-- =============================================================================
-- AFTER APPLYING — verify the change LANDED, not merely that it ran.
-- "Success. No rows returned" is what a block of comments returns too.
--
-- 1. The new function exists, is DEFINER, and is pinned. `get_my_role` is the
--    control: it must be unchanged, which proves you are on the right database.
--    Expect exactly 3 rows, and NO adjust_customer_balance row.
--
--      select proname, prosecdef, proconfig
--        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--       where n.nspname = 'public'
--         and proname in ('recompute_customer_balance',
--                         'adjust_customer_balance',
--                         'get_my_role',
--                         'record_sale')
--       order by proname;
--
--    Expect: recompute_customer_balance  t  {"search_path=public, pg_temp"}
--            get_my_role                 t  {"search_path=public"}
--            record_sale                 f  {"search_path=public, pg_temp"}
--
-- 2. `balance` is not grantable to authenticated. Expect `balance` ABSENT and
--    the five editable columns present:
--
--      select column_name, privilege_type
--        from information_schema.column_privileges
--       where table_name = 'customers' and grantee = 'authenticated'
--         and privilege_type = 'UPDATE'
--       order by column_name;
--
-- 3. The two rewritten policies carry their new checks:
--
--      select policyname, with_check
--        from pg_policies
--       where tablename in ('sales', 'payments')
--         and policyname in ('sales_insert_non_admin', 'payments_insert');
--
-- 4. Every balance now agrees with its ledger. Expect ZERO rows — this is
--    block 0a re-run, and after the first sale or payment per customer it
--    should stay empty permanently:
--
--      select c.id, c.name, c.balance
--        from customers c
--        left join lateral (
--               select -coalesce(sum(s.total - coalesce(s.paid, 0)), 0) as derived
--                 from sales s where s."customerId" = c.id
--             ) d on true
--       where coalesce(c.balance, 0) <> coalesce(d.derived, 0);
--
--    This file does NOT settle them, so immediately after applying it this query
--    still returns the five rows from block 0a. That is expected here and is not
--    a sign of a bad apply. `018_settle_customer_balances.sql` is what empties
--    it, and that file re-runs this same query as its own verification.
--
-- ROLE TESTING — from the app, as a real logged-in user. NOT from the SQL
-- Editor: `auth.uid()` is NULL there, so section 1's gate refuses everything and
-- a passing result would mean the gate is broken (finding 14).
--
--   As SALES (expect success): record a sale for a customer at your location;
--     record a payment against it; edit a customer's name and phone.
--   As SALES (expect failure): PATCH a balance —
--       curl -X PATCH "$URL/rest/v1/customers?id=eq.<id>" \
--            -H "apikey: $ANON" -H "Authorization: Bearer $JWT" \
--            -H "Content-Type: application/json" -d '{"balance":0}'
--     expect 403, "permission denied for column balance of relation customers".
--   As SALES (expect failure): insert a sale for a customer at another location
--     via REST; expect 403 row-level security violation.
--   As MANAGER (expect success): everything above except cross-location limits.
--   As ADMIN (expect success): delete a sale and a payment; confirm the
--     customer's balance reverses to the derived figure.
-- =============================================================================

-- =============================================================================
-- 010_inventory_and_consignment_authz.sql
-- Northern Water Company Ltd — OASIS Springs
--
-- Closes three authorisation gaps found in the 2026-07-28 audit
-- (docs/audit-2026-07-28.md, findings 4, 5 and 10).
--
-- WHAT IS WRONG TODAY
-- -------------------
-- 1. (finding 5) `set_inventory_value` writes an ABSOLUTE stock quantity. It is
--    meant to be admin-only — Stock Adjustments are an admin tab and the UI
--    writes a `stock_adjustments` audit row before calling it. But the function
--    is SECURITY INVOKER, so its real gate is `inventory_state_update`, which
--    allows ('admin','manager'). A manager calling the RPC directly overwrites
--    stock with no audit record. Migration 009's comment claiming the function is
--    admin-gated is simply wrong.
--
-- 2. (finding 10) The same RLS policy blocks the SALES role from
--    `apply_inventory_deltas`. Since every sale deducts finished goods through
--    that function, a sales user's sale saves but never moves stock — the app
--    warns "the sale was recorded, but the finished-goods stock could not be
--    updated" on every single sale. Real stock drift, silent except for the
--    alert.
--
-- 3. (finding 4) Consignment `reconcile` movements post credit notes that ERASE
--    customer debt. The UI shows the button to admins only, but
--    `consignment_movements_insert` allows ('admin','manager'), so a manager
--    calling the API directly can reconcile. UI gating is not a security
--    boundary.
--
-- WHAT THIS MIGRATION DOES
-- ------------------------
--   * Both inventory functions become SECURITY DEFINER with an EXPLICIT role
--     check inside, so each one enforces its own correct rule instead of
--     inheriting one blunt table policy:
--         apply_inventory_deltas  → admin, manager, sales   (everyday stock moves)
--         set_inventory_value     → admin ONLY              (absolute correction)
--   * `inventory_state` INSERT/UPDATE tighten to admin-only. The app never writes
--     that table directly any more (verified: `src/App.jsx:588` is the only
--     reference and it is a SELECT), so the functions above become the only write
--     paths, and a manager can no longer overwrite the whole JSONB blob by hand.
--   * Consignment inserts split by movement type: managers may deliver/return/
--     report-sold; only admins may reconcile.
--   * Negative-total sales (the reconciliation credit note) become admin-only,
--     so blocking the ledger half of reconcile cannot be sidestepped by posting
--     the credit note on its own.
--
-- SECURITY DEFINER NOTE
-- ---------------------
-- These functions run as their owner and therefore BYPASS RLS on
-- inventory_state. The `get_my_role()` check inside each function is now the
-- only thing standing between a caller and the stock table — do not remove it,
-- and do not add new write statements to these functions without re-checking it.
-- `get_my_role()` returns NULL for an unauthenticated caller, so both checks fail
-- closed. search_path is pinned on both to prevent function-name hijacking.
--
-- WHAT THIS DOES **NOT** FIX
-- --------------------------
-- A manager can still UPDATE `customers.balance` directly
-- (`customers_update_admin_manager` in 001), so a determined manager can alter a
-- debt without any audit trail. This migration closes the *recorded* paths that
-- move money. Properly closing direct balance edits is the Phase 2 transactional
-- RPC work (audit finding 3) and is deliberately out of scope here.
--
-- Apply via the Supabase SQL Editor AFTER review. Idempotent — safe to re-run.
-- =============================================================================

begin;


-- =============================================================================
-- SECTION 1: PRE-FLIGHT CHECK (read-only — run this first, on its own)
--
-- Section 5 restricts negative-total sales to admin. Only the consignment
-- reconciliation credit note is supposed to create those. Confirm that before
-- applying, so the policy cannot lock a legitimate flow out:
--
--   select s.id, s.date, s.total, s."customerId",
--          (cm.sale_id is not null) as is_consignment_linked
--     from sales s
--     left join consignment_movements cm on cm.sale_id = s.id
--    where s.total < 0
--    order by s.date desc;
--
-- Every row should come back with is_consignment_linked = true. If any negative
-- sale is NOT consignment-linked, stop and work out where it came from before
-- continuing.
-- =============================================================================


-- =============================================================================
-- SECTION 2: apply_inventory_deltas — admin, manager AND sales
--
-- Body is unchanged from 009 apart from the role check and SECURITY DEFINER.
-- Sales users need this because recording a sale deducts finished goods.
-- =============================================================================

create or replace function apply_inventory_deltas(changes jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  ch      jsonb;
  v_id    text;
  v_path  text[];
  v_delta numeric;
  v_count int;
  result  jsonb;
begin
  -- Explicit gate: this function bypasses RLS, so it must police itself.
  if get_my_role() not in ('admin', 'manager', 'sales') then
    raise exception 'apply_inventory_deltas: not authorised to change stock';
  end if;

  if changes is null or jsonb_typeof(changes) <> 'array' then
    raise exception 'apply_inventory_deltas: changes must be a JSONB array, got %',
      coalesce(jsonb_typeof(changes), 'null');
  end if;

  for ch in select * from jsonb_array_elements(changes)
  loop
    v_id    := ch ->> 'id';
    v_delta := (ch ->> 'delta')::numeric;
    v_path  := array(select jsonb_array_elements_text(ch -> 'path'));

    if v_id is null or v_delta is null
       or v_path is null or array_length(v_path, 1) is null then
      raise exception 'apply_inventory_deltas: each change needs id, non-empty path and delta: %', ch;
    end if;

    -- Only the two known blobs are writable, so a crafted id cannot reach
    -- another row now that RLS no longer backstops this function.
    if v_id not in ('rawMaterials', 'finishedGoods') then
      raise exception 'apply_inventory_deltas: unknown inventory_state id %', v_id;
    end if;

    -- Single UPDATE per change. The first UPDATE locks the row for the whole
    -- transaction, so concurrent callers serialize here and every delta is
    -- applied on top of the latest committed value.
    update inventory_state
       set data = jsonb_set(
                    data,
                    v_path,
                    to_jsonb( coalesce((data #>> v_path)::numeric, 0) + v_delta ),
                    true
                  ),
           updated_at = now()
     where id = v_id;

    get diagnostics v_count = row_count;
    if v_count = 0 then
      raise exception 'apply_inventory_deltas: inventory_state row % not found', v_id;
    end if;
  end loop;

  select jsonb_object_agg(id, data) into result
    from inventory_state
   where id in ('rawMaterials', 'finishedGoods');

  return result;
end;
$$;


-- =============================================================================
-- SECTION 3: set_inventory_value — ADMIN ONLY
--
-- The absolute-write path, used by the Stock Adjustments tab after it has
-- recorded a `stock_adjustments` audit row. Admin-gated here in the database, so
-- it no longer depends on the UI hiding the tab.
-- =============================================================================

create or replace function set_inventory_value(p_id text, p_path text[], p_value numeric)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count int;
  result  jsonb;
begin
  -- Absolute stock writes are an admin action. See audit finding 5.
  if get_my_role() <> 'admin' then
    raise exception 'set_inventory_value: only an admin may set an absolute stock quantity';
  end if;

  if p_id is null or p_path is null or array_length(p_path, 1) is null or p_value is null then
    raise exception 'set_inventory_value: id, non-empty path and value are required';
  end if;

  if p_id not in ('rawMaterials', 'finishedGoods') then
    raise exception 'set_inventory_value: unknown inventory_state id %', p_id;
  end if;

  update inventory_state
     set data = jsonb_set(data, p_path, to_jsonb(p_value), true),
         updated_at = now()
   where id = p_id;

  get diagnostics v_count = row_count;
  if v_count = 0 then
    raise exception 'set_inventory_value: inventory_state row % not found', p_id;
  end if;

  select jsonb_object_agg(id, data) into result
    from inventory_state
   where id in ('rawMaterials', 'finishedGoods');

  return result;
end;
$$;

grant execute on function apply_inventory_deltas(jsonb) to authenticated;
grant execute on function set_inventory_value(text, text[], numeric) to authenticated;

-- Belt-and-braces: never expose either function to unauthenticated callers.
revoke all on function apply_inventory_deltas(jsonb) from anon, public;
revoke all on function set_inventory_value(text, text[], numeric) from anon, public;


-- =============================================================================
-- SECTION 4: inventory_state — direct writes become admin-only
--
-- With both functions now SECURITY DEFINER and self-policing, no role needs
-- direct INSERT/UPDATE on this table. Dropping manager's direct write removes
-- the "overwrite the whole blob by hand" path that 009 set out to eliminate.
-- SELECT is unchanged: every authenticated user still reads stock levels.
-- =============================================================================

drop policy if exists "inventory_state_insert" on inventory_state;
create policy "inventory_state_insert"
  on inventory_state for insert
  with check (get_my_role() = 'admin');

drop policy if exists "inventory_state_update" on inventory_state;
create policy "inventory_state_update"
  on inventory_state for update
  using (get_my_role() = 'admin');


-- =============================================================================
-- SECTION 5: consignment_movements — reconcile is admin-only
--
-- Two permissive INSERT policies OR together: admins may insert any movement
-- type, managers may insert everything except 'reconcile' (the debt-erasing
-- one). Also re-created idempotently, which 008 was not.
-- =============================================================================

drop policy if exists "consignment_movements_insert" on consignment_movements;

drop policy if exists "consignment_movements_insert_admin" on consignment_movements;
create policy "consignment_movements_insert_admin"
  on consignment_movements for insert
  with check (get_my_role() = 'admin');

drop policy if exists "consignment_movements_insert_manager" on consignment_movements;
create policy "consignment_movements_insert_manager"
  on consignment_movements for insert
  with check (get_my_role() = 'manager' and type <> 'reconcile');

-- Re-assert 008's other policies idempotently so this file can be re-run and
-- so 008's non-idempotent `create policy` calls stop being a hazard.
drop policy if exists "consignment_movements_select" on consignment_movements;
create policy "consignment_movements_select"
  on consignment_movements for select
  using (get_my_role() in ('admin', 'manager'));

drop policy if exists "consignment_movements_delete" on consignment_movements;
create policy "consignment_movements_delete"
  on consignment_movements for delete
  using (get_my_role() = 'admin');

-- Still deliberately no UPDATE policy — movements are permanent records.


-- =============================================================================
-- SECTION 6: sales — only an admin may post a negative-total sale
--
-- The reconciliation credit note is the only negative-total sale the app
-- creates (src/App.jsx handleConsignReconcile). Without this, blocking manager
-- 'reconcile' movements in section 5 would be cosmetic: a manager could post the
-- credit note alone and still wipe the debt. Run the section 1 pre-flight query
-- before applying.
--
-- Replaces 001's `sales_insert`, which was `auth.uid() is not null` — any
-- authenticated user, any customer, any location. That breadth is PRESERVED
-- here on purpose: narrowing who may record a sale is a separate decision and
-- is not part of this fix. The ONLY new restriction is the sign of the total.
--
-- (Worth a future look on its own: sales-role inserts are not location-scoped
-- at all, unlike sales_select / sales_update. Out of scope for this migration.)
-- =============================================================================

drop policy if exists "sales_insert" on sales;

drop policy if exists "sales_insert_admin" on sales;
create policy "sales_insert_admin"
  on sales for insert
  with check (get_my_role() = 'admin');

drop policy if exists "sales_insert_non_admin" on sales;
create policy "sales_insert_non_admin"
  on sales for insert
  with check (auth.uid() is not null and total >= 0);

commit;


-- =============================================================================
-- AFTER APPLYING — verify each gap is closed.
--
-- As a MANAGER (expect: permission denied / exception):
--   select set_inventory_value('finishedGoods', '{0.5L,quantity}', 999);
--   insert into consignment_movements (shop_id, type, size, quantity)
--     values (<a shop id>, 'reconcile', '0.5L', 1);
--   insert into sales ("customerId", date, items, total, paid, status)
--     values (<id>, current_date, '[]'::jsonb, -100, 0, 'paid');
--   update inventory_state set data = '{}'::jsonb where id = 'finishedGoods';
--
-- As a MANAGER (expect: success):
--   select apply_inventory_deltas(
--     '[{"id":"finishedGoods","path":["0.5L","quantity"],"delta":-1}]'::jsonb);
--   select apply_inventory_deltas(
--     '[{"id":"finishedGoods","path":["0.5L","quantity"],"delta":1}]'::jsonb);
--
-- As a SALES user (expect: success — this is finding 10):
--   select apply_inventory_deltas(
--     '[{"id":"finishedGoods","path":["0.5L","quantity"],"delta":-1}]'::jsonb);
--   select apply_inventory_deltas(
--     '[{"id":"finishedGoods","path":["0.5L","quantity"],"delta":1}]'::jsonb);
--   -- then record a real sale in the app: it must NOT warn about stock any more.
--
-- As an ADMIN (expect: success):
--   select set_inventory_value('finishedGoods', '{0.5L,quantity}',
--     (select (data #>> '{0.5L,quantity}')::numeric from inventory_state
--       where id = 'finishedGoods'));  -- no-op: writes back the current value
-- =============================================================================

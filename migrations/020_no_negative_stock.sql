-- =============================================================================
-- 020_no_negative_stock.sql
-- Northern Water Company Ltd — OASIS Springs
--
-- Refuses any sale or production deletion that would drive finished goods below
-- zero. Reported 2026-08-03: "sale is posting even when the inventory is zero or
-- negative."
--
-- WHAT WAS WRONG
-- --------------
-- `apply_inventory_deltas` (009, re-applied by 014) has no floor:
--
--     set data = jsonb_set(data, v_path,
--                  to_jsonb(coalesce((data #>> v_path)::numeric, 0) + v_delta), true)
--
-- It applies whatever delta it is given. `record_sale` calls it and returns, so
-- a sale for more cartons than the plant holds posts and finished goods go
-- negative. That is the mechanism behind the figures in finding 15 of
-- docs/audit-2026-07-30-rls.md — 0.5L at −24 and 1.5L at −110 cartons.
--
-- `delete_production` has the same gap in the other direction: reversing a run
-- takes cartons OUT of finished goods, and if those cartons have since been
-- sold the reversal drives the balance negative.
--
-- Consignment already got this right. `consignment_move_stock` (016) applies the
-- delta, then inspects the blob `apply_inventory_deltas` returns and raises if
-- anything went negative. Checking AFTER the change, under the row lock the
-- UPDATE already took, is what makes it race-free — a pre-read could be
-- invalidated by a concurrent sale between the check and the write. This file
-- applies that same pattern to sales and production deletion.
--
-- WHY NOT PUT THE CHECK INSIDE apply_inventory_deltas
-- ---------------------------------------------------
-- Because "may not go negative" is not true of every caller. `delete_sale`
-- returns cartons and can only increase them; `record_production` decreases RAW
-- MATERIALS, where a negative figure means the materials record is wrong rather
-- than that the run should be refused. A blanket floor would have blocked
-- production runs as a side effect of fixing sales. The check belongs at the
-- call sites that have the business rule, which is how 016 did it.
--
-- WHAT THIS DELIBERATELY DOES NOT COVER
-- -------------------------------------
--   * `record_production` and raw materials. Producing when the materials
--     record says you have no bottles should probably also be refused, but
--     blocking production is a bigger operational decision than blocking a
--     sale, and raw materials are currently OVERSTATED (finding 15), so the
--     figures cannot be trusted to make that call yet. Left for a separate
--     decision once the stock reconciliation has run.
--   * `consignment_post_sale`. It does not touch finished goods at all — those
--     cartons left the plant at delivery, which is the whole point of the
--     consignment flow.
--   * `delete_sale`, which only adds stock back.
--
-- ONLY DECREASES ARE CHECKED. The assertion looks at paths whose delta was
-- negative. Without that, `delete_production` returning raw materials to a blob
-- that is ALREADY negative would be refused for making a bad number less bad.
--
-- REPORT IMPACT: none. No figure moves; this only refuses future writes.
--
-- CLIENT: none required. The refusal arrives as an exception, the whole
-- transaction rolls back, and src/App.jsx already surfaces the message in its
-- "Could not save this sale — nothing was recorded" alert. No client-side
-- pre-check is added on purpose: the client's stock figures are loaded once per
-- login and go stale, so a client check would refuse sales the database would
-- have accepted. The server holds the row lock and is the only place that can
-- answer this correctly.
--
-- =============================================================================
-- READ THIS BEFORE APPLYING
-- =============================================================================
--
-- **This file refuses to apply while finished goods are negative**, and that is
-- deliberate — see section 0. If 0.5L is at −24 and 1.5L at −110 when this
-- lands, every single sale of those two sizes is refused from that moment,
-- because any decrease from a negative number is still negative. That is an
-- instant trading outage across the two commonest products.
--
-- So the order is:
--
--   1. Run `docs/production-stock-reconciliation.sql` and apply the corrections
--      through the Stock Adjustments tab, so they carry an audit row.
--   2. Confirm finished goods are non-negative for every size.
--   3. Apply this file.
--
-- Step 1 is overdue independently — it has been outstanding since 2026-07-31 and
-- its window assumptions are worth re-reading before the figures are trusted.
-- =============================================================================


-- =============================================================================
-- BLOCK 0 — PRE-FLIGHT. Read-only. Run and read BEFORE applying.
--
-- 0a. Current finished goods, per size. Every quantity must be >= 0 or the
--     transaction below aborts by design.
--
--       select key as size, (value ->> 'quantity')::numeric as cartons
--         from inventory_state, jsonb_each(data)
--        where id = 'finishedGoods'
--        order by 2;
--
-- 0b. Raw materials, for context only — this file does not gate on them.
--
--       select key as material, (value ->> 'quantity')::numeric as qty
--         from inventory_state, jsonb_each(data)
--        where id = 'rawMaterials'
--        order by 2;
-- =============================================================================


begin;


-- =============================================================================
-- SECTION 0: refuse to apply on top of negative stock
--
-- Not a comment — an actual guard. Applying the rest of this file while
-- finished goods are negative would refuse every sale of the affected sizes, so
-- the migration stops itself rather than trusting whoever runs it to have read
-- the header. The whole file is one transaction, so this leaves nothing behind.
-- =============================================================================

do $$
declare
  v_bad text;
begin
  select string_agg(format('%s (%s)', key, (value ->> 'quantity')::numeric),
                    ', ' order by key)
    into v_bad
    from inventory_state, jsonb_each(data)
   where id = 'finishedGoods'
     and (value ->> 'quantity')::numeric < 0;

  if v_bad is not null then
    raise exception
      'REFUSING TO APPLY: finished goods are negative for %. This guard would then refuse every sale of those sizes. Run docs/production-stock-reconciliation.sql and correct the stock through the Stock Adjustments tab first.',
      v_bad;
  end if;
end
$$;


-- =============================================================================
-- SECTION 1: assert_stock_not_negative
--
-- Takes the inventory blob `apply_inventory_deltas` returned (post-change,
-- committed truth under the row lock) plus the change array that produced it,
-- and raises if any DECREASED path ended below zero.
--
-- SECURITY INVOKER and reads no tables — it only inspects its own arguments, so
-- there is nothing here for RLS or a role gate to govern.
-- =============================================================================

create or replace function assert_stock_not_negative(
  p_inventory jsonb,
  p_changes   jsonb,
  p_context   text
)
returns void
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_bad text;
begin
  if p_inventory is null or p_changes is null
     or jsonb_typeof(p_changes) <> 'array' then
    return;
  end if;

  select string_agg(format('%s %s (%s)', blob, item, val), ', ' order by blob, item)
    into v_bad
    from (
      select case c ->> 'id'
               when 'finishedGoods' then 'finished goods'
               when 'rawMaterials'  then 'raw materials'
               else c ->> 'id'
             end                                              as blob,
             c -> 'path' ->> 0                                as item,
             (p_inventory #>> (
                array[c ->> 'id']
                || array(select jsonb_array_elements_text(c -> 'path'))
              ))::numeric                                     as val
        from jsonb_array_elements(p_changes) as c
       -- Decreases only. A change that ADDS stock must never be refused for
       -- landing on a figure that was already negative before it ran.
       where coalesce((c ->> 'delta')::numeric, 0) < 0
    ) chk
   where val < 0;

  if v_bad is not null then
    raise exception '%: not enough stock — this would leave %', p_context, v_bad;
  end if;
end;
$$;

grant execute on function assert_stock_not_negative(jsonb, jsonb, text) to authenticated;
revoke all on function assert_stock_not_negative(jsonb, jsonb, text) from anon, public;


-- =============================================================================
-- SECTION 2: record_sale
--
-- Unchanged from `019` apart from the assertion. Still SECURITY INVOKER, still
-- stamping created_by server-side.
--
-- The raise rolls back the sale row, the stock delta and the balance recompute
-- together — record_sale has been one transaction since 011, so a refused sale
-- leaves nothing behind.
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
    auth.uid()
  )
  returning * into v_sale;

  v_changes := fg_delta_changes(v_items, -1);
  if jsonb_array_length(v_changes) > 0 then
    v_inventory := apply_inventory_deltas(v_changes);
    perform assert_stock_not_negative(v_inventory, v_changes, 'record_sale');
  end if;

  v_customer := recompute_customer_balance(v_customer_id);

  return jsonb_build_object(
    'sale',      to_jsonb(v_sale),
    'customer',  v_customer,
    'inventory', v_inventory
  );
end;
$$;


-- =============================================================================
-- SECTION 3: delete_production
--
-- Unchanged from `015` apart from the assertion.
--
-- Note the `for update` on `production_logs` is safe and stays: unlike
-- `payments`, that table has an UPDATE policy (001 section 9, replaced by 012),
-- so the lock resolves. See `019` section 2 for why that distinction matters.
--
-- The row_count check below is still doing real work — it is the admin/manager
-- DELETE policy surfacing as zero rows. Do not make this function DEFINER
-- without replacing it with an explicit role test.
-- =============================================================================

create or replace function delete_production(p_id bigint)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_log       production_logs;
  v_count     int;
  v_changes   jsonb;
  v_inventory jsonb;
begin
  select * into v_log from production_logs where id = p_id for update;
  if not found then
    raise exception 'delete_production: production log % not found', p_id;
  end if;

  delete from production_logs where id = p_id;
  get diagnostics v_count = row_count;
  if v_count = 0 then
    raise exception 'delete_production: not permitted to delete production log %', p_id;
  end if;

  v_changes := production_bom_changes(v_log.items, -1);
  if jsonb_array_length(v_changes) > 0 then
    v_inventory := apply_inventory_deltas(v_changes);
    perform assert_stock_not_negative(v_inventory, v_changes, 'delete_production');
  end if;

  return jsonb_build_object('inventory', v_inventory);
end;
$$;


commit;


-- =============================================================================
-- AFTER APPLYING — verify it landed, then prove it refuses.
--
-- 1. The helper exists and both callers reference it. Expect three rows, and
--    `calls_assert` true for record_sale and delete_production:
--
--      select proname,
--             pg_get_functiondef(p.oid) ilike '%perform assert_stock_not_negative%'
--               as calls_assert
--        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--       where n.nspname = 'public'
--         and proname in ('record_sale','delete_production','assert_stock_not_negative')
--       order by proname;
--
--    (`assert_stock_not_negative` itself will read false — it does not call
--     itself. Match the STATEMENT `perform assert...`, not the bare name, or the
--     helper's own definition matches and the check tells you nothing. See the
--     note in 019 about a verification query that matched its own comment.)
--
-- 2. Finished goods are still non-negative — section 0 should have guaranteed
--    it, but confirm rather than assume. Expect zero rows:
--
--      select key as size, (value ->> 'quantity')::numeric as cartons
--        from inventory_state, jsonb_each(data)
--       where id = 'finishedGoods' and (value ->> 'quantity')::numeric < 0;
--
-- BEHAVIOURAL TEST — in the app, and this one you should deliberately fail.
--
--   ANY ROLE (expect refusal): pick a size, note its carton count, and try to
--     sell more than that. Expect the sale to be refused with
--     "record_sale: not enough stock — this would leave finished goods <size> (-N)"
--     and the existing "nothing was recorded" alert. Then confirm nothing landed:
--
--       select id, date, total from sales order by id desc limit 1;
--       select key, (value ->> 'quantity')::numeric from inventory_state,
--              jsonb_each(data) where id = 'finishedGoods';
--
--     The sale must be absent and the carton count unchanged. If the sale is
--     absent but stock moved, the transaction is not atomic and that is a much
--     bigger problem than this file was written to solve.
--
--   ANY ROLE (expect success): sell exactly the quantity on hand, taking a size
--     to precisely zero. Zero is allowed; only negative is refused.
--
--   ADMIN (expect refusal): delete a production run whose cartons have since
--     been sold. Expect "delete_production: not enough stock...", and the
--     production log must still be there afterwards.
-- =============================================================================

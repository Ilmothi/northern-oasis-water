-- =============================================================================
-- 016_atomic_consignment_transfers.sql
-- Northern Water Company Ltd — OASIS Springs
--
-- Makes consignment DELIVER and RETURN single transactions, closing the last
-- two half-posting flows in the app.
--
-- WHAT IS WRONG TODAY
-- -------------------
-- `handleConsignDeliver` and `handleConsignReturn` (src/App.jsx) are two
-- independent round trips, the same shape migration 015 fixed for production:
--
--     1. INSERT the movement rows into consignment_movements   -- succeeds
--     2. apply_inventory_deltas(...) on plant finished goods    -- fails
--     3. alert("The delivery was recorded, but the plant finished-goods
--              stock could not be updated.")
--
-- The ledger then says cartons left the plant while inventory_state says they
-- never did. Because shop stock is DERIVED by summing the ledger
-- (`getConsignmentOnHand`), the shop is credited with cartons the plant still
-- believes it holds — the same quantity counted twice on the balance sheet, once
-- as plant finished goods and once as consignment stock, both feeding
-- `calculateTotalAssets`.
--
-- This is finding 15 in docs/audit-2026-07-30-rls.md. It bit for real between
-- migration 013 going live and 014 being applied, when every non-admin stock
-- write was refused.
--
-- Report Sold and Reconcile are NOT affected — they already run through
-- `consignment_post_sale` (011) and are atomic. They also deliberately leave
-- finished goods alone: those cartons left the plant at delivery.
--
-- THE FIX
-- -------
-- One function covering both directions, because they are one transaction shape
-- differing only in sign — the same reasoning that keeps 'sold' and 'reconcile'
-- together in `consignment_post_sale`:
--
--     deliver : plant finished goods DOWN, shop stock UP
--     return  : plant finished goods UP,   shop stock DOWN
--
-- The stock movement is DERIVED from the movement rows rather than passed in, so
-- the cartons the ledger records and the cartons the plant loses cannot disagree.
--
-- BOTH LIMIT CHECKS MOVE SERVER-SIDE
-- ----------------------------------
-- The client checks "enough at the plant" and "the shop holds that much" against
-- state loaded once per login, which can be hours stale. Both now also happen in
-- the database, and both are race-free rather than merely re-checked:
--
--   * DELIVER applies the deltas FIRST and then inspects the authoritative blob
--     that `apply_inventory_deltas` returns. That call takes the inventory_state
--     row lock, so the post-change figure is committed truth, not a snapshot. Any
--     delivered size left below zero raises and the whole transaction rolls back.
--
--   * RETURN inserts the movements first and then re-derives the shop's on-hand
--     from the ledger, which now includes those rows. Any size below zero raises.
--     A transaction-scoped advisory lock on the shop id serializes concurrent
--     movements for that shop, since two sessions would otherwise not see each
--     other's uncommitted inserts and could both pass the check.
--
-- The on-hand sign convention matches `getConsignmentOnHand` exactly:
-- deliver and reconcile ADD to what the shop holds, return and sold SUBTRACT.
--
-- NOTE ON PRE-EXISTING NEGATIVE STOCK: finished goods for 0.5L and 1.5L are
-- currently negative (finding 15). Delivering those sizes will be refused until
-- the reconciliation is run. That is not a change in behaviour — the client
-- guard already blocks them, since any positive quantity exceeds a negative
-- available figure.
--
-- AUTHORISATION IS UNCHANGED — SECURITY INVOKER
-- ---------------------------------------------
-- Runs as the caller, so 008/010's policies still decide everything: admins may
-- insert any movement type, managers everything except 'reconcile'. This
-- function only ever writes 'deliver' and 'return', so both roles keep exactly
-- the access they have today. `apply_inventory_deltas` is SECURITY DEFINER (014)
-- and polices stock access itself.
--
-- `created_by` is stamped from auth.uid() rather than the payload, as 015 did for
-- production_logs. This narrows audit finding 11, which notes that
-- `consignment_movements_insert_manager` never checks the value. It does not
-- close it — a direct INSERT bypassing this function can still forge it.
--
-- WHAT THIS DOES NOT FIX
-- ----------------------
-- Movements have no location scope (rest of finding 11), and there is still no
-- UPDATE policy on consignment_movements by design — they are permanent records.
-- Neither is in scope here.
--
-- APPLY ORDER AND CLIENT DEPENDENCY
-- ---------------------------------
-- Requires 014 (working stock writes) and is independent of 015. Apply this
-- migration BEFORE the matching client deploy: the client calls
-- `consignment_move_stock`, and `main` auto-deploys on merge.
--
-- Apply via the Supabase SQL Editor AFTER review. Idempotent — safe to re-run.
-- =============================================================================

begin;


-- =============================================================================
-- SECTION 1: PRE-FLIGHT (read-only — run this first, on its own)
--
-- ⚠️ THE QUERY BELOW IS COMMENTED OUT. Strip the leading `--` before running it,
-- or it executes nothing and the editor reports "Success. No rows returned".
--
-- Current plant stock and what each shop is derived to hold. Anything already
-- negative here is finding 15 and needs the reconciliation, not this migration:
--
--   select 'plant' as where_, key as size,
--          (value ->> 'quantity')::numeric as cartons
--     from inventory_state, jsonb_each(data)
--    where id = 'finishedGoods'
--   union all
--   select c.name, cm.size,
--          sum(case when cm.type in ('deliver','reconcile') then cm.quantity
--                   else -cm.quantity end)
--     from consignment_movements cm
--     join customers c on c.id = cm.shop_id
--    group by c.name, cm.size
--    order by where_, size;
-- =============================================================================


-- =============================================================================
-- SECTION 2: consignment_move_stock
--
--   p_shop_id   : the consignee
--   p_type      : 'deliver' or 'return'
--   p_movements : [ { "size": text, "quantity": number,
--                     "date": date (optional), "note": text (optional) }, ... ]
--
-- Returns { movements: [...inserted rows...], inventory: { rawMaterials,
-- finishedGoods } } so the client re-syncs to database truth, matching the shape
-- 011 and 015 return.
-- =============================================================================

create or replace function consignment_move_stock(
  p_shop_id   bigint,
  p_type      text,
  p_movements jsonb
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_sign      int;
  v_changes   jsonb;
  v_inventory jsonb;
  v_moves     jsonb;
  v_bad       text;
begin
  if p_type not in ('deliver', 'return') then
    raise exception 'consignment_move_stock: type must be deliver or return, got %', p_type;
  end if;

  if p_shop_id is null then
    raise exception 'consignment_move_stock: a shop is required';
  end if;

  if p_movements is null or jsonb_typeof(p_movements) <> 'array'
     or jsonb_array_length(p_movements) = 0 then
    raise exception 'consignment_move_stock: at least one line is required';
  end if;

  if not exists (select 1 from customers where id = p_shop_id and is_consignee) then
    raise exception 'consignment_move_stock: customer % is not a consignment shop', p_shop_id;
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_movements) as m
     where coalesce((m ->> 'quantity')::numeric, 0) <= 0
  ) then
    raise exception 'consignment_move_stock: every line needs a quantity greater than zero';
  end if;

  -- Serializes concurrent movements for THIS shop only. Without it two sessions
  -- would each re-derive on-hand without seeing the other's uncommitted rows and
  -- could both pass the check below. Transaction-scoped: released on commit or
  -- rollback, and it needs no table privileges.
  perform pg_advisory_xact_lock(p_shop_id);

  -- Delivering sends cartons OUT of the plant; taking stock back brings them IN.
  v_sign := case p_type when 'deliver' then -1 else 1 end;

  -- Insert and capture the new rows in one statement, as consignment_post_sale
  -- (011) does. Reading them back afterwards would need a "rows I just wrote"
  -- predicate, which is exactly the kind of guesswork RETURNING removes.
  with inserted as (
    insert into consignment_movements
      (shop_id, date, type, size, quantity, sale_id, note, created_by)
    select
      p_shop_id,
      coalesce((m ->> 'date')::date, current_date),
      p_type,
      m ->> 'size',
      (m ->> 'quantity')::numeric,
      null,                           -- deliver/return move no money
      nullif(m ->> 'note', ''),
      auth.uid()
    from jsonb_array_elements(p_movements) as m
    returning *
  )
  select coalesce(jsonb_agg(to_jsonb(inserted)), '[]'::jsonb) into v_moves from inserted;

  -- Plant finished goods, in cartons, aggregated per size so a payload listing
  -- one size twice still produces a single delta.
  select coalesce(jsonb_agg(jsonb_build_object(
           'id',    'finishedGoods',
           'path',  jsonb_build_array(size, 'quantity'),
           'delta', v_sign * qty
         )), '[]'::jsonb)
    into v_changes
    from (
      select m ->> 'size' as size, sum((m ->> 'quantity')::numeric) as qty
        from jsonb_array_elements(p_movements) as m
       group by m ->> 'size'
    ) agg;

  if jsonb_array_length(v_changes) > 0 then
    v_inventory := apply_inventory_deltas(v_changes);
  end if;

  -- DELIVER: the plant cannot send what it does not hold. Checked against the
  -- blob apply_inventory_deltas just returned, which is post-change committed
  -- truth taken under the row lock — not a pre-read that a concurrent sale could
  -- invalidate.
  if p_type = 'deliver' then
    select string_agg(format('%s (%s)', size, shortfall), ', ' order by size)
      into v_bad
      from (
        select m ->> 'size' as size,
               (v_inventory #>> array['finishedGoods', m ->> 'size', 'quantity'])::numeric as shortfall
          from jsonb_array_elements(p_movements) as m
         group by m ->> 'size'
      ) chk
     where shortfall < 0;

    if v_bad is not null then
      raise exception
        'consignment_move_stock: not enough stock at the plant — these sizes would go negative: %',
        v_bad;
    end if;
  end if;

  -- RETURN: the shop cannot hand back more than it holds. Re-derived from the
  -- ledger INCLUDING the rows just inserted, using the same sign convention as
  -- getConsignmentOnHand (deliver/reconcile add, return/sold subtract).
  if p_type = 'return' then
    select string_agg(format('%s (%s)', size, on_hand), ', ' order by size)
      into v_bad
      from (
        select cm.size,
               sum(case when cm.type in ('deliver', 'reconcile') then cm.quantity
                        else -cm.quantity end) as on_hand
          from consignment_movements cm
         where cm.shop_id = p_shop_id
           and cm.size in (select m ->> 'size' from jsonb_array_elements(p_movements) as m)
         group by cm.size
      ) chk
     where on_hand < 0;

    if v_bad is not null then
      raise exception
        'consignment_move_stock: the shop does not hold that much — these sizes would go negative: %',
        v_bad;
    end if;
  end if;

  return jsonb_build_object(
    'movements', v_moves,
    'inventory', v_inventory
  );
end;
$$;


-- =============================================================================
-- SECTION 3: grants
-- =============================================================================

grant execute on function consignment_move_stock(bigint, text, jsonb) to authenticated;
revoke all on function consignment_move_stock(bigint, text, jsonb) from anon, public;

commit;


-- =============================================================================
-- AFTER APPLYING — verify
--
-- 1. The function exists and is INVOKER (so 008/010's insert policies still
--    govern who may move consignment stock):
--
--      select p.proname,
--             case when p.prosecdef then 'DEFINER' else 'INVOKER' end as security_type
--        from pg_proc p
--        join pg_namespace n on n.oid = p.pronamespace
--       where n.nspname = 'public' and p.proname = 'consignment_move_stock';
--
-- 2. ATOMICITY — the point of this migration. From the SQL Editor the call is
--    refused by apply_inventory_deltas' null-role gate (see 014), and that
--    refusal must leave NO ledger rows behind, because the insert happens BEFORE
--    the stock call:
--
--      select count(*) from consignment_movements;
--      select consignment_move_stock(<shop id>, 'deliver',
--        '[{"size":"5L","quantity":1}]'::jsonb);   -- expect: not authorised
--      select count(*) from consignment_movements; -- expect: UNCHANGED
--
--    That unchanged count is the whole fix. Before it, the equivalent client
--    flow left the movement row committed and the stock unmoved.
--
-- 3. As an ADMIN or MANAGER in the app: deliver a size the plant genuinely has,
--    confirm the plant tile drops and the shop's on-hand rises by the same
--    number, then take it back and confirm both return exactly to where they
--    started.
--
-- 4. Limits, in the app. Try to deliver more than the plant holds, and to take
--    back more than the shop holds. Both must be refused with nothing recorded —
--    check `select count(*) from consignment_movements;` either side.
--
-- 5. Reports. Consignment stock is an asset via calculateConsignmentStockValue,
--    and plant finished goods via calculateFinishedGoodsValue. A deliver moves
--    value between the two and must leave calculateTotalAssets UNCHANGED. If the
--    headline asset figure moves on a delivery, the two halves have drifted —
--    which is exactly the double-count this migration exists to prevent.
-- =============================================================================

-- =============================================================================
-- 015_atomic_production.sql
-- Northern Water Company Ltd — OASIS Springs
--
-- Makes logging and deleting a production run a SINGLE TRANSACTION, and moves
-- the bill of materials into the database.
--
-- REQUIRES 014 TO BE LIVE FIRST. See "Apply order" at the foot.
--
-- WHAT IS WRONG TODAY
-- -------------------
-- `handleSaveProduction` (src/App.jsx) is two independent round trips:
--
--     1. INSERT into production_logs          -- succeeds
--     2. apply_inventory_deltas(...)          -- fails
--     3. alert("The production log was recorded, but the stock
--              could not be updated.")
--
-- Step 3 is the bug. The run is on the books, the raw materials were never
-- consumed and the finished goods were never posted — a permanent stock
-- discrepancy that no report can see, because production_logs says the cartons
-- exist and inventory_state says they do not. `handleDeleteProduction` has the
-- same shape in reverse: the log row is deleted, then the reversal is attempted,
-- and a failure leaves stock never returned.
--
-- Migration 011 already fixed exactly this class of bug for every money
-- operation. Production is one of the last flows still doing it the old way.
--
-- THE FIX
-- -------
-- One function per operation, so the log row and the stock movement live or die
-- together. A refused or failed stock write now aborts the whole thing and the
-- production run is simply not recorded — which is the correct outcome. Partial
-- posting becomes impossible rather than merely unlikely.
--
-- THE BOM MOVES SERVER-SIDE
-- -------------------------
-- `production_bom_changes` is now the single definition of the recipe. It
-- replaces TWO hand-written copies in the client — the deduction loop in
-- `handleSaveProduction` and its mirror-image restoration loop in
-- `handleDeleteProduction` — which had to be kept in step by hand.
--
-- Stock movement is DERIVED from the run's own `items`, exactly as
-- `fg_delta_changes` (011) derives a sale's stock from the sale's own items. The
-- cartons produced can no longer disagree with the materials consumed, and the
-- reversal on delete can no longer disagree with the original deduction —
-- because both call this one function with opposite signs.
--
-- The trade-off, stated plainly: a recipe change is now a MIGRATION, not a
-- client edit. That is deliberate. It also means the recipe is queryable, which
-- is what makes docs/production-stock-reconciliation.sql possible.
--
-- THE RECIPE (unchanged — this is what the client does today)
-- ----------------------------------------------------------
-- Per size, for `c` cartons at `b` bottles per carton (0.5L=24, 1.5L=12, 5L=4,
-- both 18.9L=1), with `n = c * b` bottles:
--
--   emptyBottles[size]  -n     one empty bottle per bottle produced
--   seals[...]          -n     0.5L and 1.5L SHARE the short_neck seal;
--                              5L uses seals['5L']; both 18.9L use seals['18.9L']
--   labels[...]         -n     both 18.9L variants share labels['18.9L']
--   caps['18.9L']       -c     18.9L only
--   overwraps[size]     -c     0.5L / 1.5L / 5L only — 18.9L is not overwrapped
--   kraStamps           -n     one stamp per BOTTLE
--   roChemical          -n/1000
--   finishedGoods[size].quantity  +c
--
-- Deltas that land on the same path are summed, so a run producing both 0.5L and
-- 1.5L emits ONE short_neck seal figure, matching the client's combined total.
--
-- A run may drive a material negative — that is how a shortage shows, and it is
-- existing behaviour that this migration deliberately preserves.
--
-- KNOWN CAVEAT CARRIED FORWARD, NOT FIXED: THE STAMP RULE CHANGED
-- --------------------------------------------------------------
-- KRA stamps were once deducted one per CARTON and are now one per BOTTLE
-- (src/App.jsx carries this note on the delete path). Deleting a run recorded
-- under the OLD rule therefore over-restores stamps for 0.5L / 1.5L / 5L.
--
-- `production_bom_changes` takes a `p_stamps_per_bottle` flag so the correct
-- rule can be applied per run, but it DEFAULTS TO TRUE and `delete_production`
-- does not yet pass anything else — because the date the rule changed is not
-- recorded anywhere. Behaviour is therefore identical to today, no better and no
-- worse. Once that date is known, `delete_production` can gate on
-- `v_log.date < 'YYYY-MM-DD'` and the caveat disappears. Until then, correct an
-- over-restored stamp count with a stock adjustment.
--
-- AUTHORISATION IS UNCHANGED — these are SECURITY INVOKER
-- ------------------------------------------------------
-- Both functions run as the CALLER, so migration 012's production_logs policies
-- still decide everything: admin/manager may log any run, sales users may log
-- runs stamped with their own uid, and DELETE stays admin-only. No authorisation
-- moves into application code. `apply_inventory_deltas` is SECURITY DEFINER
-- (014) and continues to police stock access itself.
--
-- As in 011: when RLS refuses a DELETE, Postgres does not raise — it matches zero
-- rows. `delete_production` therefore checks row_count and raises, so a refusal
-- aborts loudly instead of reversing stock for a run that is still on the books.
-- (An INSERT refused by RLS does raise, so `record_production` needs no such
-- check.)
--
-- `created_by` IS NO LONGER TAKEN FROM THE CLIENT
-- -----------------------------------------------
-- `record_production` stamps `created_by := auth.uid()` itself rather than
-- trusting the payload. Every other table still takes it from the client (audit
-- finding 6); this closes it for production_logs, which is the one table whose
-- RLS policy actually depends on the value being honest.
--
-- WHAT THIS DOES NOT FIX
-- ----------------------
-- Deleting a run whose casual payout has already been recorded (`casual_paid`)
-- still leaves the Casual Labour expense pointing at a run that no longer
-- exists. That is a real gap, but it is a payroll question rather than a stock
-- one, and blocking it here would be a new business rule rather than a fix.
-- Raised separately.
--
-- APPLY ORDER AND CLIENT DEPENDENCY — READ THIS
-- ---------------------------------------------
-- 1. Apply 014 FIRST and verify it landed. Production logging is atomic after
--    this migration, so if stock writes are still broken for non-admins, logging
--    a run will FAIL OUTRIGHT rather than half-post. That is the correct
--    behaviour and it is what was asked for, but it turns a silent discrepancy
--    into a hard stop for managers and sales users.
-- 2. Apply this migration.
-- 3. THEN deploy the client. The matching client calls `record_production` and
--    `delete_production`; deploying it before this migration is applied breaks
--    production logging completely, and `main` auto-deploys on merge.
--
-- Apply via the Supabase SQL Editor AFTER review. Idempotent — safe to re-run.
-- =============================================================================

begin;


-- =============================================================================
-- SECTION 1: PRE-FLIGHT (read-only — run this first, on its own)
--
-- ⚠️ THE QUERY BELOW IS COMMENTED OUT. Strip the leading `--` before running it.
-- Left as-is it executes nothing and the editor reports "Success. No rows
-- returned", which is indistinguishable from a genuine empty result.
--
-- Section 3 inserts into production_logs assuming `items` and `casuals` are
-- JSONB. Confirm that before applying:
--
--   select column_name, data_type
--     from information_schema.columns
--    where table_schema = 'public' and table_name = 'production_logs'
--    order by ordinal_position;
--
-- Expect `items` = jsonb and `casuals` = jsonb (or json).
--
-- If `casuals` comes back as an ARRAY (e.g. bigint[]) instead, change the one
-- `casuals` line in Section 3 to:
--
--     (select coalesce(array_agg(x::bigint), '{}')
--        from jsonb_array_elements_text(coalesce(p_log -> 'casuals', '[]'::jsonb)) x),
--
-- and nothing else in this file changes.
-- =============================================================================


-- =============================================================================
-- SECTION 2: production_bom_changes — the recipe, in one place
--
--   p_items : { "<size>": <cartons>, ... }  — a production run's `items` blob
--   p_sign  : +1 when recording a run, -1 when reversing one
--   p_stamps_per_bottle : see the stamp-rule caveat in the header
--
-- Returns a change array in exactly the shape apply_inventory_deltas expects:
--   [ {"id":"rawMaterials","path":["seals","short_neck"],"delta":-480}, ... ]
--
-- Pure — reads no tables, so it can be called freely from reporting queries as
-- well as from the write path. Unknown sizes RAISE rather than being skipped: a
-- silent skip is precisely the kind of invisible stock drift this whole
-- migration exists to remove.
-- =============================================================================

create or replace function production_bom_changes(
  p_items             jsonb,
  p_sign              int,
  p_stamps_per_bottle boolean default true
)
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_bad    text;
  v_result jsonb;
begin
  if p_sign not in (1, -1) then
    raise exception 'production_bom_changes: sign must be 1 or -1, got %', p_sign;
  end if;

  if p_items is not null and jsonb_typeof(p_items) <> 'object' then
    raise exception 'production_bom_changes: items must be a JSON object of size -> cartons, got %',
      jsonb_typeof(p_items);
  end if;

  select string_agg(key, ', ' order by key) into v_bad
    from jsonb_each_text(coalesce(p_items, '{}'::jsonb))
   where key not in ('0.5L', '1.5L', '5L', '18.9L_disposable', '18.9L_refill');

  if v_bad is not null then
    raise exception 'production_bom_changes: unknown product size(s): %', v_bad;
  end if;

  -- Assigned as a scalar subquery rather than SELECT ... INTO: PL/pgSQL's INTO
  -- detection and a leading WITH clause are an awkward pair, and this form has
  -- no such ambiguity.
  v_result := (
  with runs as (
    select key as size,
           value::numeric as cartons,
           case key
             when '0.5L' then 24::numeric
             when '1.5L' then 12::numeric
             when '5L'   then  4::numeric
             else              1::numeric   -- both 18.9L variants
           end as bpc
      from jsonb_each_text(coalesce(p_items, '{}'::jsonb))
     where value::numeric <> 0
  ),
  m as (
    select size, cartons, cartons * bpc as bottles from runs
  ),
  parts as (
    -- one empty bottle per bottle produced
    select 'rawMaterials' as id, array['emptyBottles', size] as path, -bottles as qty
      from m
    union all
    -- 0.5L and 1.5L share the short-neck seal
    select 'rawMaterials',
           array['seals', case
                            when size in ('0.5L', '1.5L') then 'short_neck'
                            when size = '5L'              then '5L'
                            else                               '18.9L'
                          end],
           -bottles
      from m
    union all
    -- both 18.9L variants share one label
    select 'rawMaterials',
           array['labels', case when size like '18.9L%' then '18.9L' else size end],
           -bottles
      from m
    union all
    -- caps: 18.9L only, one per carton
    select 'rawMaterials', array['caps', '18.9L'], -cartons
      from m where size like '18.9L%'
    union all
    -- overwraps: one per carton; 18.9L is not overwrapped
    select 'rawMaterials', array['overwraps', size], -cartons
      from m where size in ('0.5L', '1.5L', '5L')
    union all
    -- KRA stamps: one per bottle under the current rule
    select 'rawMaterials', array['kraStamps'],
           case when p_stamps_per_bottle then -bottles else -cartons end
      from m
    union all
    select 'rawMaterials', array['roChemical'], -(bottles / 1000)
      from m
    union all
    -- finished goods are counted in CARTONS
    select 'finishedGoods', array[size, 'quantity'], cartons
      from m
  )
  select coalesce(
           jsonb_agg(
             jsonb_build_object('id', id, 'path', to_jsonb(path), 'delta', p_sign * total)
             order by id, path
           ),
           '[]'::jsonb
         )
    from (
      select id, path, sum(qty) as total
        from parts
       group by id, path
      having sum(qty) <> 0
    ) agg
  );

  return v_result;
end;
$$;


-- =============================================================================
-- SECTION 3: record_production
--
-- Insert the run and move the stock — atomically. Stock is derived from the
-- run's own items, never passed in.
-- =============================================================================

create or replace function record_production(p_log jsonb)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_items     jsonb;
  v_log       production_logs;
  v_changes   jsonb;
  v_inventory jsonb;
begin
  v_items := coalesce(p_log -> 'items', '{}'::jsonb);

  if jsonb_typeof(v_items) <> 'object' then
    raise exception 'record_production: items must be a JSON object of size -> cartons';
  end if;

  if exists (select 1 from jsonb_each_text(v_items) where value::numeric < 0) then
    raise exception 'record_production: carton counts cannot be negative';
  end if;

  if not exists (select 1 from jsonb_each_text(v_items) where value::numeric <> 0) then
    raise exception 'record_production: at least one size must have a non-zero carton count';
  end if;

  -- Validate the recipe BEFORE inserting, so an unknown size gives a clean error
  -- rather than an aborted transaction half-way through.
  v_changes := production_bom_changes(v_items, 1);

  -- id is database-assigned (004b). created_by is taken from the session, not
  -- the payload — production_logs_insert (012) depends on it being honest.
  insert into production_logs (date, items, unit, notes, casuals, created_by)
  values (
    coalesce((p_log ->> 'date')::date, current_date),
    v_items,
    coalesce(nullif(p_log ->> 'unit', ''), 'cartons'),
    nullif(p_log ->> 'notes', ''),
    coalesce(p_log -> 'casuals', '[]'::jsonb),
    auth.uid()
  )
  returning * into v_log;

  if jsonb_array_length(v_changes) > 0 then
    v_inventory := apply_inventory_deltas(v_changes);
  end if;

  return jsonb_build_object(
    'production', to_jsonb(v_log),
    'inventory',  v_inventory
  );
end;
$$;


-- =============================================================================
-- SECTION 4: delete_production
--
-- Remove the run and reverse the stock — atomically. The reversal is derived
-- from the stored run, so it is guaranteed to be the exact inverse of what was
-- deducted (subject to the stamp-rule caveat in the header).
--
-- DELETE on production_logs is admin-only (001/012) and stays that way. Because
-- this function is SECURITY INVOKER, a manager calling it directly gets the
-- row_count check below and the whole transaction aborts — stock is not touched.
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
  end if;

  return jsonb_build_object('inventory', v_inventory);
end;
$$;


-- =============================================================================
-- SECTION 5: grants
--
-- EXECUTE only lets a signed-in user call these. Both write functions are
-- SECURITY INVOKER, so the production_logs policies still decide who may
-- actually record or delete a run.
-- =============================================================================

grant execute on function production_bom_changes(jsonb, int, boolean) to authenticated;
grant execute on function record_production(jsonb)                    to authenticated;
grant execute on function delete_production(bigint)                   to authenticated;

revoke all on function production_bom_changes(jsonb, int, boolean) from anon, public;
revoke all on function record_production(jsonb)                    from anon, public;
revoke all on function delete_production(bigint)                   from anon, public;

commit;


-- =============================================================================
-- AFTER APPLYING — verify
--
-- 1. The recipe matches the client it replaces. 10 cartons of 0.5L (24/carton)
--    and 5 of 1.5L (12/carton) must give: 240 + 60 = 300 short_neck seals,
--    240 emptyBottles 0.5L, 60 emptyBottles 1.5L, 300 kraStamps, 0.3 roChemical,
--    10 + 5 overwraps by size, +10 / +5 finished goods. Note the SINGLE combined
--    short_neck line — that is the aggregation working:
--
--      select jsonb_pretty(production_bom_changes(
--        '{"0.5L": 10, "1.5L": 5}'::jsonb, 1));
--
--    And the reverse must be the exact negation:
--
--      select jsonb_pretty(production_bom_changes(
--        '{"0.5L": 10, "1.5L": 5}'::jsonb, -1));
--
--    18.9L takes caps and no overwraps:
--
--      select jsonb_pretty(production_bom_changes(
--        '{"18.9L_disposable": 20}'::jsonb, 1));
--
--    An unknown size must RAISE, not silently skip:
--
--      select production_bom_changes('{"3L": 5}'::jsonb, 1);
--
-- 2. ATOMICITY — the point of this migration. As a MANAGER (delete is
--    admin-only), pick a real run id and note the stock first:
--
--      select data #>> '{kraStamps}' from inventory_state where id = 'rawMaterials';
--      select delete_production(<id>);   -- expect: 'not permitted to delete'
--      select * from production_logs where id = <id>;   -- still present
--      select data #>> '{kraStamps}' from inventory_state where id = 'rawMaterials';
--                                                       -- UNCHANGED
--
--    Before this migration the equivalent client flow could delete the row and
--    leave the stock unreversed, or the reverse.
--
-- 3. As a SALES user, log a run in the app. It must save with NO stock warning,
--    the finished-goods tile must move, and the run must be visible on reload
--    (012's created_by rule — now stamped server-side):
--
--      select id, date, items, created_by from production_logs order by id desc limit 5;
--
-- 4. Round-trip: as an ADMIN, log a run and then delete it. Every raw material
--    and finished-goods figure must return to its starting value exactly.
--
-- 5. Reports. Finished goods feed inventory valuation and P&L COGS, so confirm
--    the Inventory tab and the P&L still tie out against production_logs after
--    the round-trip in step 4.
-- =============================================================================

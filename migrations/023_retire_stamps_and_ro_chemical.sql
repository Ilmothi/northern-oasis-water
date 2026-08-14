-- =============================================================================
-- 023_retire_stamps_and_ro_chemical.sql
-- Northern Water Company Ltd — OASIS Springs
--
-- KRA stamps and RO machine chemicals are no longer used. Reported 2026-08-14.
--
-- This file redefines `production_bom_changes` (from `015`) to stop deducting
-- them on every production run. Nothing else in the recipe moves: empty
-- bottles, seals, labels, caps, overwraps and the finished-goods credit are all
-- byte-for-byte what `015` defined.
--
-- THIS IS A RECIPE CHANGE. `015`'s header calls the BOM "the single definition
-- of the recipe", and every consequence below follows from that one fact: the
-- same function is used to record a run, to reverse one, and (since `022`) to
-- report what a run consumed. Change it and all three change together.
--
--
-- WHAT MOVES, IN PLAIN TERMS
-- --------------------------
--   1. New runs stop deducting stamps and chemical. That is the point.
--
--   2. HISTORICAL RUNS RESTATE IN THE UI. `production_run_materials` (`022`)
--      derives from the CURRENT recipe, so from the moment this is applied, a
--      run recorded in June stops listing the stamps it genuinely consumed. Its
--      card will read as though stamps were never used. The stock movement that
--      actually happened is untouched — this is a reporting effect, and it is
--      exactly the drift `022`'s header warned about, arriving on the first
--      recipe change. Accepted deliberately: the material is being retired, so
--      the historical breakdown is of no further operational use.
--
--   3. DELETING AN OLD RUN BECOMES ASYMMETRIC. `delete_production` reverses
--      using the current recipe too. A run recorded while stamps were still
--      deducted, then deleted after this is applied, credits back bottles,
--      seals, labels, caps and overwraps but NOT stamps or chemical. The stock
--      those runs consumed stays consumed.
--
--      This is intentional and harmless here precisely BECAUSE the two lines
--      are being retired — the client stops displaying and valuing them in the
--      same change, so a frozen residue in the blob affects nothing. It would
--      NOT be harmless for a material still in use. If either is ever brought
--      back, the residue must be reconciled by a stock adjustment first.
--
--   4. Inventory valuation falls. That is a client-side effect (the app stops
--      counting both lines), not a database one, but it is the visible number
--      and it is listed here so the two halves are recorded together.
--
--
-- WHAT THIS FILE DELIBERATELY DOES NOT DO
-- ---------------------------------------
--   * It does NOT touch the `inventory_state` blob. `rawMaterials.kraStamps`
--     and `rawMaterials.roChemical` keep their current quantities, frozen. The
--     data is left intact so this is reversible: revert the client and the
--     figures are still there. Stripping the keys was considered and rejected —
--     it destroys the quantities with no backup and buys nothing, since an
--     unread key costs nothing.
--
--   * It does NOT touch historical purchases of either material. Those are
--     financial records.
--
--   * It does NOT touch the `KRA Stamp Costs` expense type or any expense
--     booked against it. Removing the type would leave historical expenses with
--     no P&L treatment and could silently reclassify closed periods.
--
--
-- THE VESTIGIAL PARAMETER
-- -----------------------
-- `p_stamps_per_bottle` is now dead — it existed only to switch the stamp rule
-- between one-per-bottle and one-per-carton, and there is no stamp line left to
-- switch. It is KEPT anyway, ignored, because `create or replace function`
-- cannot change a function's signature: removing it means DROP then CREATE,
-- which opens a window where production logging references a function that does
-- not exist, and requires re-granting. A dead boolean is a much smaller price
-- than that window. Callers in `015` pass two arguments and are unaffected.
--
-- If it is ever worth removing, do it as its own migration with the drop and
-- create in one explicit transaction.
--
--
-- CLIENT DEPENDENCY — ORDER OF DEPLOY
-- -----------------------------------
-- Either order is safe, and neither is silent:
--
--   * Migration first: production stops deducting stamps and chemical while the
--     client still shows both tiles. Their quantities simply stop moving.
--   * Client first: both disappear from the UI while runs keep deducting them
--     in the background, driving a hidden figure down.
--
-- Migration first is preferred — a visible frozen number beats an invisible
-- falling one. Do not leave a long gap either way.
--
-- Idempotent: `create or replace`. Safe to re-run. Requires `015`.
-- =============================================================================


-- =============================================================================
-- SECTION 1: production_bom_changes — stamps and RO chemical removed
--
-- Identical to `015` SECTION 2 except that the `kraStamps` and `roChemical`
-- branches of the `parts` union are gone. The signature, the validation, the
-- IMMUTABLE marker and the output shape are unchanged, so `record_production`,
-- `delete_production` and `production_run_materials` all keep working without
-- modification.
--
-- Unknown sizes still RAISE rather than being skipped — `015`'s rule, and the
-- reason a silent skip is never the answer to a recipe question.
-- =============================================================================

create or replace function production_bom_changes(
  p_items             jsonb,
  p_sign              int,
  p_stamps_per_bottle boolean default true   -- vestigial; see header
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
    -- KRA stamps and RO chemical were deducted here until 023. Both materials
    -- are retired; their inventory_state keys are left frozen, not removed.
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
-- VERIFICATION — run these by hand after applying
--
-- 1. Neither material appears in the recipe any more. Both must return false:
--
--      select production_bom_changes('{"0.5L": 10}'::jsonb, 1)::text like '%kraStamps%';
--      select production_bom_changes('{"0.5L": 10}'::jsonb, 1)::text like '%roChemical%';
--
-- 2. The rest of the recipe is unchanged. 10 cartons of 0.5L is 240 bottles,
--    so this must still show 240 empty bottles, 240 short-neck seals, 240
--    labels, 10 overwraps and +10 finished goods — and nothing else:
--
--      select jsonb_pretty(production_bom_changes('{"0.5L": 10}'::jsonb, 1));
--
-- 3. Reversal still mirrors recording, so a run recorded and deleted after this
--    is applied nets to zero. Must return true:
--
--      select production_bom_changes('{"1.5L": 7, "18.9L_refill": 3}'::jsonb, 1)
--           = (select jsonb_agg(jsonb_build_object(
--                       'id', c->>'id', 'path', c->'path',
--                       'delta', -((c->>'delta')::numeric)) order by c->>'id', c->'path')
--                from jsonb_array_elements(
--                       production_bom_changes('{"1.5L": 7, "18.9L_refill": 3}'::jsonb, -1)
--                     ) as t(c));
--
-- 4. The frozen quantities are still on file, untouched by this migration:
--
--      select data #>> '{kraStamps}'  as stamps,
--             data #>> '{roChemical}' as chemical
--        from inventory_state where id = 'rawMaterials';
--
--    Record both figures somewhere before applying, and confirm they are the
--    same afterwards. They should never move again.
--
-- 5. Unknown sizes still raise (the `015` rule survived the rewrite):
--
--      select production_bom_changes('{"3L": 5}'::jsonb, 1);   -- expect an error
-- =============================================================================

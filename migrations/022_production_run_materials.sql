-- =============================================================================
-- 022_production_run_materials.sql
-- Northern Water Company Ltd — OASIS Springs
--
-- The production run card (Production → History → click a run) can show what a
-- run produced, who worked it and what it is worth, but not what it CONSUMED.
-- Since `015` the recipe lives in `production_bom_changes` and the client no
-- longer has a copy, so the card can only say "materials were deducted from the
-- bill of materials" without naming them.
--
-- This file adds one read-only function that answers the question:
--
--     select production_run_materials(148);
--
--     [ {"material": "emptyBottles", "variant": "0.5L", "quantity": 960},
--       {"material": "kraStamps",    "variant": null,   "quantity": 960},
--       {"material": "roChemical",   "variant": null,   "quantity": 0.96}, ... ]
--
-- Nothing else in the schema changes. No table, no column, no policy, no
-- existing function. It reads; it cannot write.
--
--
-- READ THIS BEFORE RELYING ON THE NUMBERS
-- ---------------------------------------
-- This function reports what the CURRENT recipe says the run would consume. It
-- is not a record of what was actually deducted on the day.
--
-- The two agree today, because `production_bom_changes` is the single
-- definition used by `record_production` on the way in and `delete_production`
-- on the way out, and it has not changed since `015`. They would diverge the
-- moment the recipe is edited — every historical run's materials would silently
-- restate to the new recipe, including runs whose stock was moved under the old
-- one.
--
-- The alternative is to store the computed change array on `production_logs` at
-- record time and read that back, which is the only version that stays true
-- across a recipe change. It is deliberately NOT what this file does:
--
--   * it means altering `record_production`, which is a money/stock write path
--     that `021` has only just stabilised, and
--   * it fixes nothing for the runs already on file, which would still need
--     this function's derivation to be back-filled.
--
-- So: fine for "what did this run use", not evidence for a stock dispute. If
-- the recipe ever does change, treat every figure this function returns for a
-- run recorded before the change as reconstructed, not recorded — and consider
-- the stored-deltas version at that point.
--
--
-- WHY SECURITY INVOKER (AND NO ROLE GATE)
-- ---------------------------------------
-- The function selects from `production_logs`, so as INVOKER it inherits that
-- table's RLS: admin and manager see every run, a sales user sees only their
-- own (`001`, tightened by `012`). A run the caller cannot read returns `[]`,
-- exactly as an unknown ID does.
--
-- That is why there is no `get_my_role()` check inside it. A DEFINER function
-- here would need one, and finding 14 — `get_my_role()` returns NULL for a
-- caller with no `profiles` row, which a plpgsql `IF` then does not take — is
-- how `010` shipped two functions believing they failed closed. The way to not
-- repeat that is to not need the gate: let RLS do the work it already does.
--
-- `production_bom_changes` is `immutable` and reads no tables, so calling it
-- from here adds no privilege of its own.
--
--
-- ONE SHARP EDGE
-- --------------
-- `production_bom_changes` RAISES on a product size it does not know, rather
-- than skipping it — deliberately, per `015`, because a silent skip is exactly
-- the invisible stock drift that migration exists to remove.
--
-- Inherited here, that means a run whose `items` contain an unrecognised size
-- makes this function ERROR rather than return a partial list. That is the
-- right behaviour and it is not a new problem: such a run is ALREADY
-- undeletable, because `delete_production` calls the same function to reverse
-- it. If this errors in the field it has surfaced a genuinely broken row, not a
-- bug in the card. The client must therefore treat an RPC error as "materials
-- unavailable for this run" and still render the rest of the card.
--
-- Known sizes are the five `015` defines: 0.5L, 1.5L, 5L, 18.9L_disposable,
-- 18.9L_refill. Refill-only products (refill_10L/15L/20L) are sold, not
-- produced through this path, and have never been valid run items.
--
--
-- CLIENT DEPENDENCY — ORDER OF DEPLOY
-- -----------------------------------
-- Apply this BEFORE the client that calls it. The function is purely additive,
-- so applying it early is harmless — nothing calls it until the client ships.
-- Shipping the client first would give every card opening a "function does not
-- exist" error instead of a materials list.
--
-- Idempotent: `create or replace` throughout. Safe to re-run.
-- =============================================================================


-- =============================================================================
-- SECTION 1: production_run_materials
--
--   p_id : a `production_logs.id`
--
-- Returns a JSON array of objects, ordered by material then variant:
--
--   material : the raw-material bucket ('emptyBottles', 'seals', 'labels',
--              'caps', 'overwraps', 'kraStamps', 'roChemical')
--   variant  : the size/type within it ('0.5L', 'short_neck', '18.9L', …), or
--              null for buckets that have no sub-key (kraStamps, roChemical)
--   quantity : POSITIVE amount consumed, in that material's own unit
--
-- Note the sign flip. `production_bom_changes` returns stock DELTAS, so
-- consumption is negative there; a materials list reads as "used 960", not
-- "used -960", so the delta is negated here. Only `rawMaterials` entries are
-- returned — the `finishedGoods` entries in the change array are the run's
-- output, which the card already shows from `items`.
--
-- Called with sign +1 and the default `p_stamps_per_bottle`, matching exactly
-- how `record_production` computed the deduction. If that flag's default ever
-- changes, this function follows it — which is the recipe-drift caveat in the
-- header, in its most concrete form.
-- =============================================================================

create or replace function production_run_materials(p_id bigint)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'material', c->'path'->>0,
               'variant',  c->'path'->>1,
               'quantity', -((c->>'delta')::numeric)
             )
             order by c->'path'->>0, c->'path'->>1 nulls first
           ),
           '[]'::jsonb
         )
    from production_logs l
    cross join lateral jsonb_array_elements(production_bom_changes(l.items, 1)) as t(c)
   where l.id = p_id
     and c->>'id' = 'rawMaterials';
$$;


-- =============================================================================
-- SECTION 2: grants
--
-- `authenticated` only. Every role that can open the Production tab can call
-- it; RLS decides which runs actually return rows.
-- =============================================================================

grant execute on function production_run_materials(bigint) to authenticated;
revoke all on function production_run_materials(bigint) from anon, public;


-- =============================================================================
-- VERIFICATION — run these by hand after applying
--
-- 1. The function exists, is INVOKER, and has a pinned search_path.
--    `prosecdef` must be false and `proconfig` must show search_path. Checking
--    `pg_proc` rather than this file is the lesson of `010`.
--
--      select proname, prosecdef, proconfig
--        from pg_proc
--       where proname = 'production_run_materials';
--
-- 2. A real run returns a sensible list. Pick any recent id:
--
--      select jsonb_pretty(production_run_materials(
--               (select id from production_logs order by id desc limit 1)));
--
--    Every `quantity` must be positive. A negative one would mean the sign
--    convention in `production_bom_changes` moved.
--
-- 3. It ties back to the recipe. This must return true — the materials list is
--    the raw-material half of the change array, negated:
--
--      select production_run_materials(l.id) = (
--               select coalesce(jsonb_agg(
--                        jsonb_build_object(
--                          'material', c->'path'->>0,
--                          'variant',  c->'path'->>1,
--                          'quantity', -((c->>'delta')::numeric))
--                        order by c->'path'->>0, c->'path'->>1 nulls first),
--                      '[]'::jsonb)
--                 from jsonb_array_elements(production_bom_changes(l.items, 1)) as t(c)
--                where c->>'id' = 'rawMaterials')
--        from production_logs l
--       order by l.id desc limit 1;
--
-- 4. An unknown id returns an empty array, not an error:
--
--      select production_run_materials(-1);   -- expect []
--
-- 5. Optional, worth doing once: confirm no run on file carries a size the
--    recipe does not know. Any row this returns is a run that is already
--    undeletable and will error the card — see ONE SHARP EDGE above.
--
--      select l.id, l.date, k.key
--        from production_logs l, lateral jsonb_object_keys(l.items) k(key)
--       where k.key not in ('0.5L','1.5L','5L','18.9L_disposable','18.9L_refill');
-- =============================================================================

-- =============================================================================
-- 026_production_requires_materials.sql
-- Northern Water Company Ltd — OASIS Springs
--
-- Refuses a production run that would drive any raw material below zero.
-- Reported 2026-08-31: "production is deducting raw materials even when
-- quantities are zero — it should fail when quantities are zero."
--
-- WHAT IS WRONG TODAY
-- -------------------
-- `record_production` derives the bill of materials, applies it, and returns:
--
--     v_changes := production_bom_changes(v_items, 1);
--     ...
--     v_inventory := apply_inventory_deltas(v_changes);
--     return jsonb_build_object('production', ..., 'inventory', v_inventory);
--
-- `apply_inventory_deltas` (009, re-applied by 014) has no floor, so a run posts
-- whatever the recipe asks for. Log a run of 0.5L with empty bottles already at
-- zero and the run is recorded, the finished goods are credited, and
-- `emptyBottles.0.5L` simply goes negative. Nothing refuses it and no report
-- shows it as a failure — the negative figure is the only trace.
--
-- To be precise about what was ALREADY guarded, because the report could be read
-- either way:
--
--   * A run with no sizes filled in, or every size at 0, is already refused —
--     `record_production` raises 'at least one size must have a non-zero carton
--     count' (015 section 3, carried into 021 section 5).
--   * A size entered as 0 alongside a real size already deducts nothing for that
--     size — `production_bom_changes` filters `where value::numeric <> 0`.
--
-- Neither of those is the gap. The gap is the MATERIAL quantity being zero, not
-- the carton quantity, and this file closes it.
--
-- THE FIX
-- -------
-- One line, and it is a line that already exists twice elsewhere. `020` added
-- `assert_stock_not_negative` and wired it into `record_sale` and
-- `delete_production`; this wires it into the third and last write path that
-- decreases stock. The helper is unchanged — it already labels the
-- `rawMaterials` blob, and it already looks only at paths whose delta was
-- negative, so a run can never be refused for landing on a figure that was
-- already negative before it ran.
--
-- The check runs AFTER `apply_inventory_deltas`, under the row lock that
-- function's UPDATE already holds. That is what makes it race-free, and it is
-- the same ordering `016` established and `020` followed: a pre-read could be
-- invalidated by a concurrent run between the check and the write.
--
-- WHY THIS WAS DEFERRED IN `020`, AND WHY IT IS BEING DONE NOW
-- ------------------------------------------------------------
-- `020` named this exact case and deliberately left it out:
--
--     "Producing when the materials record says you have no bottles should
--      probably also be refused, but blocking production is a bigger
--      operational decision than blocking a sale, and raw materials are
--      currently OVERSTATED (finding 15), so the figures cannot be trusted to
--      make that call yet."
--
-- That was the right call then and the decision has now been taken the other
-- way, explicitly. Two things worth holding in mind:
--
--   * Overstated raw materials make this change SAFER, not riskier. An
--     overstated figure hits zero later than reality, so the refusal fires late
--     rather than spuriously. The risk is any material that is UNDERSTATED —
--     there, production stops before it truly needs to.
--   * Stamps and RO chemical are no longer in the recipe (023), so their frozen
--     `inventory_state` keys cannot block anything, whatever they sit at.
--
-- OPERATIONAL CONSEQUENCE — SAY THIS OUT LOUD BEFORE APPLYING
-- -----------------------------------------------------------
-- From the moment this lands, a run is refused if ANY single material in its
-- recipe would go below zero: empty bottles, seals, labels, overwraps, caps.
-- The plant then cannot log that run until the materials record is corrected
-- through the Stock Adjustments tab, which is admin-only and carries an audit
-- row. That is the intent — the correction becomes visible rather than being
-- absorbed as silent negative drift — but it does mean a wrong stock figure now
-- stops production instead of merely being wrong.
--
-- `emptyBottles.18.9L_refill` deserves a specific mention. It is a stocked
-- counter like any other, but refill production depends on customer bottles
-- coming back, so it is the material most likely to be behind reality. If refill
-- runs start being refused, the answer is a stock adjustment, not a rollback.
--
-- REPORT IMPACT: none. No existing figure moves. This only refuses future
-- writes, so every past P&L, inventory valuation and production report is
-- unchanged.
--
-- CLIENT: none required, and none should be added. `handleSaveProduction`
-- (src/App.jsx) already surfaces the raise through `saveFailureMessage` in its
-- "Could not save this production run — nothing was recorded and stock was not
-- changed" alert, which is now literally true rather than merely reassuring.
--
-- No client-side pre-check, for the reason `020` gave: the client's stock
-- figures are loaded once per login and go stale, so a client check would refuse
-- runs the database would have accepted. The server holds the lock and is the
-- only place that can answer this correctly.
--
-- AUTHORISATION UNCHANGED
-- -----------------------
-- Still `SECURITY INVOKER`, so `012`'s `production_logs` policies still decide
-- who may log a run, and `created_by` is still stamped from `auth.uid()` rather
-- than the payload. `assert_stock_not_negative` reads only the blob it is
-- handed, so there is nothing here for RLS to govern.
--
-- WHAT THIS DOES NOT FIX
-- ----------------------
--   * The raw material figures themselves. This refuses new drift; it does not
--     correct the drift already there. `docs/production-stock-reconciliation.sql`
--     is still outstanding.
--   * `assert_stock_not_negative` names the material by the FIRST path element
--     only, so a shortage of `emptyBottles.0.5L` reads as "raw materials
--     emptyBottles". Improving that would change the wording of sale refusals
--     too, so it is left for its own change rather than folded in here.
--
-- REQUIRES `020` (for `assert_stock_not_negative`) and `021` (this redefinition
-- is `021`'s `record_production` verbatim plus one line). Both are applied and
-- probe-verified as of 2026-08-08 — confirm with the pre-flight below anyway.
--
-- Apply via the Supabase SQL Editor AFTER review. Idempotent — safe to re-run.
-- =============================================================================


-- =============================================================================
-- BLOCK 0 — PRE-FLIGHT. Read-only. Run these BEFORE applying.
--
-- ⚠️ COMMENTED OUT ON PURPOSE. Strip the leading `--` before running. Left as-is
-- they execute nothing and the editor reports "Success. No rows returned",
-- which is indistinguishable from a genuine empty result.
--
-- 0a. The dependencies are live. Expect two rows, and `has_key` true for
--     record_production — that is `021`'s idempotency guard. If it comes back
--     false, `021` is NOT applied and section 1 would silently reintroduce
--     duplicate production runs. Stop and apply `021` first.
--
--       select proname,
--              pg_get_functiondef(p.oid) ilike '%client_key%' as has_key
--         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--        where n.nspname = 'public'
--          and proname in ('record_production','assert_stock_not_negative')
--        order by proname;
--
-- 0b. Which recipe materials are already at or below zero. Every row this
--     returns is a line that will start refusing runs the moment this lands.
--     Read it BEFORE applying, not after. An empty result is the happy case.
--
--       select r.key as category, v.key as item, v.value::text::numeric as qty
--         from inventory_state s,
--              jsonb_each(s.data) r,
--              jsonb_each(r.value) v
--        where s.id = 'rawMaterials'
--          and jsonb_typeof(r.value) = 'object'
--          and v.value::text::numeric <= 0
--        order by 3;
--
--     Only the object-shaped categories are checked — emptyBottles, seals,
--     labels, overwraps, caps — which is exactly the set the recipe consumes.
--     The retired scalar keys (kraStamps, roChemical) are excluded by shape, and
--     correctly so: `023` took them out of the BOM, so they cannot block a run
--     however negative they are.
-- =============================================================================


begin;


-- =============================================================================
-- SECTION 1: record_production
--
-- `021` section 5 verbatim, plus the `assert_stock_not_negative` call. Nothing
-- else moves: the `client_key` replay guard stays (both the fast path and the
-- `unique_violation` race path), `created_by := auth.uid()` stays, the carton
-- validations stay, and the function stays SECURITY INVOKER.
--
-- The replay paths return BEFORE the assertion, which is correct: replaying a
-- run that was already recorded must not re-check stock it does not move. A
-- retry of a run recorded when materials were sufficient still returns cleanly
-- even if they have since gone to zero.
--
-- The raise rolls back the `production_logs` insert and the stock delta
-- together — this has been one transaction since `015` — so a refused run leaves
-- no log row, no finished goods and no material deduction.
-- =============================================================================

create or replace function record_production(p_log jsonb)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_items     jsonb;
  v_key       uuid;
  v_log       production_logs;
  v_changes   jsonb;
  v_inventory jsonb;
begin
  v_items := coalesce(p_log -> 'items', '{}'::jsonb);
  v_key   := nullif(p_log ->> 'client_key', '')::uuid;

  if v_key is not null then
    select * into v_log from production_logs where client_key = v_key;
    if found then
      return jsonb_build_object(
        'production', to_jsonb(v_log),
        'inventory',  current_inventory(),
        'replayed',   true
      );
    end if;
  end if;

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
  begin
    insert into production_logs (date, items, unit, notes, casuals, created_by, client_key)
    values (
      coalesce((p_log ->> 'date')::date, current_date),
      v_items,
      coalesce(nullif(p_log ->> 'unit', ''), 'cartons'),
      nullif(p_log ->> 'notes', ''),
      coalesce(p_log -> 'casuals', '[]'::jsonb),
      auth.uid(),
      v_key
    )
    returning * into v_log;
  exception when unique_violation then
    select * into v_log from production_logs where client_key = v_key;
    if not found then
      raise;
    end if;
    return jsonb_build_object(
      'production', to_jsonb(v_log),
      'inventory',  current_inventory(),
      'replayed',   true
    );
  end;

  if jsonb_array_length(v_changes) > 0 then
    v_inventory := apply_inventory_deltas(v_changes);
    -- The one line this migration exists for. Raw materials may no longer be
    -- driven below zero by a production run; the whole run is refused instead.
    perform assert_stock_not_negative(v_inventory, v_changes, 'record_production');
  end if;

  return jsonb_build_object(
    'production', to_jsonb(v_log),
    'inventory',  v_inventory
  );
end;
$$;


-- =============================================================================
-- SECTION 2: grants
--
-- `create or replace` on an existing function keeps its ACL, so these are
-- no-ops on the live database. They are restated so a fresh database applying
-- this file in order ends up with the same grants `015` section 5 established.
-- =============================================================================

grant execute on function record_production(jsonb) to authenticated;
revoke all on function record_production(jsonb) from anon, public;


commit;


-- =============================================================================
-- AFTER APPLYING — verify it landed, then prove it refuses.
--
-- 1. All three decreasing write paths now assert. Expect three rows, all true:
--
--      select proname,
--             pg_get_functiondef(p.oid) ilike '%assert_stock_not_negative%'
--               as calls_assert
--        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--       where n.nspname = 'public'
--         and proname in ('record_sale','delete_production','record_production')
--       order by proname;
--
--    And `021` survived — expect true, not false:
--
--      select pg_get_functiondef(p.oid) ilike '%client_key%' as keeps_021
--        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--       where n.nspname = 'public' and proname = 'record_production';
--
-- 2. IT REFUSES. Ask for far more cartons than there are bottles for, inside a
--    transaction you roll back, so nothing is recorded either way:
--
--      begin;
--        select data #>> '{emptyBottles,0.5L}' as before
--          from inventory_state where id = 'rawMaterials';
--
--        -- Expect: 'record_production: not enough stock — this would leave
--        --          raw materials emptyBottles (-N)'
--        select record_production(
--          '{"date":"2026-08-31","items":{"0.5L":999999},"unit":"cartons"}'::jsonb);
--      rollback;
--
--    Then confirm the refusal left NOTHING behind — no log row, no movement:
--
--      select count(*) from production_logs where date = '2026-08-31';
--      select data #>> '{emptyBottles,0.5L}' from inventory_state
--       where id = 'rawMaterials';   -- unchanged from `before` above
--
-- 3. A NORMAL RUN STILL WORKS. As a sales user, log a small real run in the app
--    for a size with materials in hand. It must save with no warning, the
--    finished-goods tile must move, and the raw material figures must drop by
--    exactly the recipe amount.
--
-- 4. THE ZERO-CARTON GUARDS ARE UNTOUCHED. Both must still raise:
--
--      select record_production('{"items":{}}'::jsonb);
--      select record_production('{"items":{"0.5L":0,"1.5L":0}}'::jsonb);
--
-- 5. IDEMPOTENCY SURVIVED (`021`). Call twice with the SAME client_key inside a
--    transaction. The second must come back `replayed: true` with the same
--    production id, and stock must move exactly once:
--
--      begin;
--        select record_production('{"date":"2026-08-31","unit":"cartons",
--          "items":{"0.5L":1},
--          "client_key":"00000000-0000-4000-8000-00000000d026"}'::jsonb);
--        -- re-run the identical statement; expect "replayed": true
--        select data #>> '{emptyBottles,0.5L}' from inventory_state
--         where id = 'rawMaterials';   -- down by 24, not 48
--      rollback;
--
-- 6. Reports. Nothing should move — that is the check. Run the P&L and the
--    Inventory valuation before and after and confirm they are identical.
-- =============================================================================

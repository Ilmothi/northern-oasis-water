-- =============================================================================
-- 035_production_wastage.sql
--
-- Record wastage on a production run: empty bottles, seals, labels and
-- overwraps spoiled during the run, deducted from raw materials together with
-- the run itself.
--
-- WHY
-- ---
-- Physical raw-material counts keep coming in below the system figure. Much of
-- it is wastage during production (crushed bottles, torn labels, bad seals,
-- spoiled overwraps) that nothing in the system could record except an admin
-- stock adjustment, which the people on the floor cannot make. Owner decision
-- 2026-11-14: the sales rep enters wastage on the production form, per stock
-- item, and it is deducted from raw materials.
--
-- DECISIONS (owner, 2026-11-14)
-- -----------------------------
--   * Entered on the production form, by whoever records the run (sales,
--     manager, admin — the existing production_logs policies, unchanged).
--   * Bottles, seals, labels and overwraps. Caps are not included.
--   * ONLY WITH A RUN. A log with zero cartons is still refused, wastage or not
--     (`record_production`'s existing "at least one size" rule, untouched).
--
-- SHAPE — `production_logs.wastage`
-- ---------------------------------
-- Keyed exactly like the raw-material stock it comes off, so each figure is
-- deducted from the line staff see on the Inventory tab:
--
--   { "emptyBottles": { "0.5L": 6, "1.5L": 2 },
--     "seals":        { "short_neck": 10 },
--     "labels":       { "0.5L": 4 },
--     "overwraps":    { "5L": 1 } }
--
--   emptyBottles: 0.5L, 1.5L, 5L, 18.9L_disposable, 18.9L_refill   (bottles)
--   seals:        short_neck, 5L, 18.9L                           (seals)
--   labels:       0.5L, 1.5L, 5L, 18.9L                           (labels)
--   overwraps:    0.5L, 1.5L, 5L                                  (overwraps)
--
-- Whole, non-negative numbers only; zeros are dropped before storing. `{}` (the
-- default, and every existing row) means no wastage.
--
-- HOW
-- ---
--   * `production_wastage_clean(jsonb)`: validates the shape above and strips
--     zeros. Unknown material or size, a fraction or a negative is refused with
--     a plain message, BEFORE anything is written.
--   * `production_wastage_changes(jsonb, sign)`: the stock deltas, one per line.
--   * `record_production`: `026`'s body verbatim, plus the wastage stored on
--     the row and its deltas appended to the BOM's. Same single transaction,
--     same `assert_stock_not_negative` — so a run whose cartons PLUS wastage
--     need more stock than exists is refused whole, as today.
--   * `delete_production`: `020`'s body verbatim, plus the wastage given back.
--   The replay (client_key) paths are untouched: a retried run returns the run
--   already stored and moves nothing.
--
-- WHAT THIS MOVES (stated before applying, per CLAUDE.md)
-- -------------------------------------------------------
--   * Raw materials (and their value on the Inventory / stock views): lower by
--     whatever wastage is recorded from now on. No past figure changes.
--   * Finished goods: NOT affected. Wastage is not product.
--   * P&L: NOT affected. COGS comes from carton costs in cost_settings, not from
--     materials consumed.
--   * Casual labour pay: NOT affected. It is per carton produced.
--
-- RLS / SECURITY
-- --------------
-- No policy created, dropped or altered. Both RPCs stay SECURITY INVOKER; the
-- stock write goes through `apply_inventory_deltas` and its own role gate, as
-- before. The two helpers read no tables. Note (pre-existing, not changed
-- here): `production_logs_update` lets admin/manager update a row directly,
-- which would change `items` or `wastage` without moving stock. The app has no
-- edit flow for runs; corrections are delete + re-enter.
--
-- COMPATIBILITY: signatures are unchanged and `wastage` is optional in the
-- payload, so the live client keeps working once this is applied. Apply 035
-- BEFORE merging its client — the new client sends `wastage`, which the old
-- function would silently ignore (the run saves, the wastage is NOT deducted).
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- SECTION 1: the column
-- -----------------------------------------------------------------------------

alter table public.production_logs
  add column if not exists wastage jsonb not null default '{}'::jsonb;

comment on column public.production_logs.wastage is
  'Raw materials spoiled during this run (migration 035), keyed like '
  'rawMaterials: {emptyBottles|seals|labels|overwraps: {item: qty}}. '
  'Deducted with the run, returned when the run is deleted.';

-- -----------------------------------------------------------------------------
-- SECTION 2: helpers
-- -----------------------------------------------------------------------------

create or replace function public.production_wastage_clean(p_wastage jsonb)
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_cat     record;
  v_item    record;
  v_allowed text[];
  v_qty     numeric;
  v_inner   jsonb;
  v_result  jsonb := '{}'::jsonb;
begin
  if p_wastage is null or p_wastage = 'null'::jsonb then
    return '{}'::jsonb;
  end if;
  if jsonb_typeof(p_wastage) <> 'object' then
    raise exception 'record_production: wastage must be an object of material -> {item: quantity}';
  end if;

  for v_cat in select key, value from jsonb_each(p_wastage) loop
    v_allowed := case v_cat.key
      when 'emptyBottles' then array['0.5L', '1.5L', '5L', '18.9L_disposable', '18.9L_refill']
      when 'seals'        then array['short_neck', '5L', '18.9L']
      when 'labels'       then array['0.5L', '1.5L', '5L', '18.9L']
      when 'overwraps'    then array['0.5L', '1.5L', '5L']
      else null
    end;
    if v_allowed is null then
      raise exception 'record_production: wastage cannot be recorded for "%"', v_cat.key;
    end if;
    if jsonb_typeof(v_cat.value) <> 'object' then
      raise exception 'record_production: wastage for % must be an object of item -> quantity', v_cat.key;
    end if;

    v_inner := '{}'::jsonb;
    for v_item in select key, value from jsonb_each(v_cat.value) loop
      if not (v_item.key = any (v_allowed)) then
        raise exception 'record_production: unknown % item "%" in wastage', v_cat.key, v_item.key;
      end if;
      if jsonb_typeof(v_item.value) not in ('number', 'string') then
        raise exception 'record_production: wastage for % % must be a number', v_cat.key, v_item.key;
      end if;
      begin
        v_qty := (v_item.value #>> '{}')::numeric;
      exception when others then
        raise exception 'record_production: wastage for % % must be a number', v_cat.key, v_item.key;
      end;
      if v_qty is null then
        continue;
      end if;
      if v_qty < 0 or v_qty <> trunc(v_qty) then
        raise exception 'record_production: wastage for % % must be a whole number of 0 or more (got %)',
          v_cat.key, v_item.key, v_qty;
      end if;
      if v_qty > 0 then
        v_inner := v_inner || jsonb_build_object(v_item.key, v_qty);
      end if;
    end loop;

    if v_inner <> '{}'::jsonb then
      v_result := v_result || jsonb_build_object(v_cat.key, v_inner);
    end if;
  end loop;

  return v_result;
end;
$$;

-- Stock deltas for an ALREADY-CLEANED wastage object. sign 1 = deduct (record),
-- -1 = give back (delete).
create or replace function public.production_wastage_changes(p_wastage jsonb, p_sign int)
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'id',    'rawMaterials',
             'path',  jsonb_build_array(c.key, i.key),
             'delta', -p_sign * (i.value #>> '{}')::numeric)
           order by c.key, i.key), '[]'::jsonb)
    from jsonb_each(coalesce(p_wastage, '{}'::jsonb)) c,
         jsonb_each(c.value) i
   where jsonb_typeof(c.value) = 'object'
     and (i.value #>> '{}')::numeric <> 0;
$$;

grant execute on function public.production_wastage_clean(jsonb)        to authenticated;
grant execute on function public.production_wastage_changes(jsonb, int) to authenticated;
revoke all on function public.production_wastage_clean(jsonb)        from anon, public;
revoke all on function public.production_wastage_changes(jsonb, int) from anon, public;

-- -----------------------------------------------------------------------------
-- SECTION 3: record_production — `026` plus wastage
-- -----------------------------------------------------------------------------

create or replace function record_production(p_log jsonb)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_items     jsonb;
  v_wastage   jsonb;
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

  -- Also what makes wastage "only with a run": a log of wastage alone has no
  -- non-zero carton count and is refused here.
  if not exists (select 1 from jsonb_each_text(v_items) where value::numeric <> 0) then
    raise exception 'record_production: at least one size must have a non-zero carton count';
  end if;

  -- Validate the recipe and the wastage BEFORE inserting.
  v_changes := production_bom_changes(v_items, 1);
  v_wastage := production_wastage_clean(p_log -> 'wastage');
  v_changes := v_changes || production_wastage_changes(v_wastage, 1);

  begin
    insert into production_logs (date, items, unit, notes, casuals, created_by, client_key, wastage)
    values (
      coalesce((p_log ->> 'date')::date, current_date),
      v_items,
      coalesce(nullif(p_log ->> 'unit', ''), 'cartons'),
      nullif(p_log ->> 'notes', ''),
      coalesce(p_log -> 'casuals', '[]'::jsonb),
      auth.uid(),
      v_key,
      v_wastage
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
    perform assert_stock_not_negative(v_inventory, v_changes, 'record_production');
  end if;

  return jsonb_build_object(
    'production', to_jsonb(v_log),
    'inventory',  v_inventory
  );
end;
$$;

grant execute on function record_production(jsonb) to authenticated;
revoke all on function record_production(jsonb) from anon, public;

-- -----------------------------------------------------------------------------
-- SECTION 4: delete_production — `020` plus the wastage given back
-- -----------------------------------------------------------------------------

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

  v_changes := production_bom_changes(v_log.items, -1)
            || production_wastage_changes(v_log.wastage, -1);
  if jsonb_array_length(v_changes) > 0 then
    v_inventory := apply_inventory_deltas(v_changes);
    perform assert_stock_not_negative(v_inventory, v_changes, 'delete_production');
  end if;

  return jsonb_build_object('inventory', v_inventory);
end;
$$;

grant execute on function delete_production(bigint) to authenticated;
revoke all on function delete_production(bigint) from anon, public;

commit;


-- =============================================================================
-- AFTER APPLYING — verify it LANDED. Run each query ON ITS OWN.
--
-- 1. The column exists with its default. Expect  wastage | jsonb | '{}'::jsonb | NO
--
--      select column_name, data_type, column_default, is_nullable
--        from information_schema.columns
--       where table_name = 'production_logs' and column_name = 'wastage';
--
-- 2. Both RPCs are the new versions (each mentions wastage) and neither is
--    SECURITY DEFINER. Expect 2 rows, both  true | false:
--
--      select proname, prosrc like '%production_wastage_changes%' as has_wastage, prosecdef
--        from pg_proc
--       where proname in ('record_production', 'delete_production');
--
-- 3. The cleaner, on its own (reads no tables, changes nothing).
--    Expect {"seals": {"short_neck": 10}, "emptyBottles": {"0.5L": 6}}:
--
--      select production_wastage_clean(
--        '{"emptyBottles": {"0.5L": 6, "1.5L": 0}, "seals": {"short_neck": 10}, "labels": {}}'::jsonb);
--
--    And a refusal. Expect an ERROR: unknown labels item "short_neck":
--
--      select production_wastage_clean('{"labels": {"short_neck": 1}}'::jsonb);
--
-- 4. End to end, in the app (after the client is live): note raw materials
--    for 0.5L bottles, short-neck seals, 0.5L labels and 0.5L overwraps. Record
--    a 1-carton 0.5L run with wastage 2 bottles, 3 seals, 1 label, 1 overwrap.
--    Expect each to fall by the BOM (24 / 24 / 24 / 1) PLUS the wastage
--    (2 / 3 / 1 / 1). Then delete that run and expect all four back where they
--    started.
-- =============================================================================

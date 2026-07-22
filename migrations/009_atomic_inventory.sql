-- =============================================================================
-- 009_atomic_inventory.sql
-- Northern Water Company Ltd — OASIS Springs
--
-- Fixes stock drift caused by the "overwrite the whole inventory blob" save model.
--
-- Background
-- ----------
-- inventory_state holds two rows ('rawMaterials' / 'finishedGoods'), each a JSONB
-- blob of the entire stock. Until now the app loaded that blob once per login and,
-- on every stock change, upserted the WHOLE blob back. Two failure modes followed:
--   1. Concurrent writers last-write-wins: a session saving from its own stale
--      in-memory copy silently reverted everyone else's changes — including a
--      manual stock correction — because it wrote absolute values, not the change.
--   2. If the login-time inventory fetch failed/returned empty, the session kept
--      the hardcoded demo defaults and the next save wrote those over real stock.
--
-- Fix: apply stock changes as DELTAS server-side, inside a single UPDATE that
-- takes a row lock, so concurrent calls serialize and each delta lands on the
-- CURRENT committed value rather than a stale snapshot. A client sending "-10"
-- can no longer clobber the true quantity, even if its own copy is wrong.
--
-- Two functions:
--   * apply_inventory_deltas(changes)  — add/subtract per item (sales, production,
--     purchases, deletes, consignment). The everyday path.
--   * set_inventory_value(id,path,val) — set an item to an ABSOLUTE quantity, for
--     the admin stock-count correction (physical count wins). Kept separate on
--     purpose: only this path writes an absolute number, and it is admin-gated in
--     the UI and by inventory_state RLS.
--
-- Both are SECURITY INVOKER, so the existing inventory_state RLS (admin/manager/
-- sales may write; all authenticated may read) still governs every call — this
-- migration does NOT change who can touch stock.
--
-- Shape is unchanged (still two JSONB blobs), so all reads — valuation, P&L COGS,
-- the inventory tiles, getStockItems — are untouched. Reports still reconcile.
--
-- Apply via the Supabase SQL Editor AFTER review. Idempotent — safe to re-run.
-- =============================================================================

begin;

-- ---------------------------------------------------------------------------
-- apply_inventory_deltas(changes jsonb)
--   changes: a JSONB array of { "id": text, "path": text[], "delta": number }
--   e.g. [ {"id":"finishedGoods","path":["0.5L","quantity"],"delta":-10},
--          {"id":"rawMaterials","path":["kraStamps"],"delta":-240} ]
--   Each delta is added to the current value at that path (missing leaf = 0), so
--   subtraction can drive a value negative — matching how the app already lets
--   over-consumption show as a shortage. Returns { rawMaterials, finishedGoods }
--   with the fresh authoritative blobs so the caller re-syncs to DB truth.
-- ---------------------------------------------------------------------------
create or replace function apply_inventory_deltas(changes jsonb)
returns jsonb
language plpgsql
security invoker
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

-- ---------------------------------------------------------------------------
-- set_inventory_value(p_id text, p_path text[], p_value numeric)
--   Sets one item to an ABSOLUTE quantity (admin stock-count correction).
--   Returns { rawMaterials, finishedGoods } with the fresh blobs.
-- ---------------------------------------------------------------------------
create or replace function set_inventory_value(p_id text, p_path text[], p_value numeric)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_count int;
  result  jsonb;
begin
  if p_id is null or p_path is null or array_length(p_path, 1) is null or p_value is null then
    raise exception 'set_inventory_value: id, non-empty path and value are required';
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

-- RLS on inventory_state still applies (SECURITY INVOKER); EXECUTE just lets
-- signed-in users call the functions. A sales user calling set_inventory_value
-- is stopped by the UPDATE policy the same as a direct write would be.
grant execute on function apply_inventory_deltas(jsonb) to authenticated;
grant execute on function set_inventory_value(text, text[], numeric) to authenticated;

commit;

-- =============================================================================
-- After applying, verify:
--   -- current finished-goods 0.5L quantity:
--   select data #>> '{0.5L,quantity}' from inventory_state where id = 'finishedGoods';
--   -- deduct 3 cartons atomically, then read back the returned blob:
--   select apply_inventory_deltas(
--     '[{"id":"finishedGoods","path":["0.5L","quantity"],"delta":-3}]'::jsonb);
--   -- put it back:
--   select apply_inventory_deltas(
--     '[{"id":"finishedGoods","path":["0.5L","quantity"],"delta":3}]'::jsonb);
--   -- absolute correction (admin): set 0.5L to a physical count of 500:
--   -- select set_inventory_value('finishedGoods', '{0.5L,quantity}', 500);
-- =============================================================================

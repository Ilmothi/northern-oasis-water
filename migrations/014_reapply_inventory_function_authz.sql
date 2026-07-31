-- =============================================================================
-- 014_reapply_inventory_function_authz.sql
-- Northern Water Company Ltd — OASIS Springs
--
-- LIVE OUTAGE FIX. Apply this one FIRST, on its own, before 015.
--
-- WHAT IS WRONG TODAY
-- -------------------
-- Migration 010 was applied to production only PARTIALLY (found in the 2026-07-30
-- RLS audit, docs/audit-2026-07-30-rls.md):
--
--   * Sections 4, 5, 6 — the `inventory_state` admin-only policies, the
--     `consignment_movements` insert split, the `sales_insert_*` split — ARE live
--     and confirmed in the live `pg_policies` dump.
--   * Sections 2 and 3 — which redefine `apply_inventory_deltas` and
--     `set_inventory_value` as SECURITY DEFINER with an internal `get_my_role()`
--     check — NEVER applied. Live, both are still migration 009's SECURITY
--     INVOKER versions with no internal role check (`pg_proc.prosecdef` false).
--
-- `proconfig` is identical between the 009 and 010 versions, so only `prosecdef`
-- differs — which is why no casual inspection caught it.
--
-- WHY IT ONLY BROKE NOW
-- ---------------------
-- An INVOKER function's `UPDATE inventory_state` is policed by RLS, and 010's
-- policy section set that table to ADMIN ONLY. That was harmless while the
-- blanket `"Authenticated full access"` (ALL/true/true) policy was still in
-- place, because it permitted the UPDATE for everyone. **Migration 013 dropped
-- that blanket policy**, which made the admin-only `inventory_state_update`
-- policy binding for the first time.
--
-- Since 013, for every manager and sales user, the UPDATE inside
-- `apply_inventory_deltas` matches zero rows and the function raises
-- `apply_inventory_deltas: inventory_state row ... not found`. In the app:
--
--   * Recording a sale fails entirely — `record_sale` (011) is atomic, so the
--     exception rolls the whole thing back. That one is loud and safe.
--   * Logging production HALF-succeeds: the log row inserts, then the stock move
--     fails, and the user is told "The production log was recorded, but the stock
--     could not be updated." Raw materials are never consumed and finished goods
--     are never posted. THIS is the stock discrepancy being reported.
--   * Consignment delivery fails the same way as production.
--
-- WHAT THIS MIGRATION DOES
-- ------------------------
-- Re-applies 010 Sections 2 and 3 verbatim, and nothing else. Both functions
-- become SECURITY DEFINER, each carrying its own explicit role check:
--
--     apply_inventory_deltas  → admin, manager, sales   (everyday stock moves)
--     set_inventory_value     → admin ONLY              (absolute correction)
--
-- No policy is touched — 010's policy sections are already live and correct.
--
-- SECURITY DEFINER NOTE (unchanged from 010)
-- ------------------------------------------
-- These run as their owner and therefore BYPASS RLS on `inventory_state`. The
-- `get_my_role()` check inside each function is the ONLY thing between a caller
-- and the stock table — do not remove it, and do not add write statements to
-- either function without re-checking it. `search_path` is pinned.
--
-- ONE DELIBERATE DIFFERENCE FROM 010: the null-role handling.
-- 010's header asserts both checks "fail closed" for a caller with no role.
-- They do not — they fail OPEN, and this migration corrects that:
--
--   get_my_role() is NULL when the caller has no `profiles` row.
--     `NULL not in ('admin','manager','sales')`  -> NULL, not TRUE
--     `NULL <> 'admin'`                          -> NULL, not TRUE
--   `if NULL then raise` does not take the branch, so execution continues past
--   the gate and the caller gets unrestricted stock writes.
--
-- EXECUTE is granted to `authenticated` only and revoked from anon/public, so
-- this needs a real login — but an authenticated user with no profiles row
-- would reach `set_inventory_value`, the absolute-write path that bypasses the
-- `stock_adjustments` audit trail. Sections 2 and 3 use `coalesce(...)` and
-- `is distinct from` respectively so a NULL role is refused.
--
-- The same null-role pattern appears in the RLS policies in 001, which use bare
-- `get_my_role() in (...)` in a USING clause. That is safe — a USING clause that
-- evaluates to NULL denies the row, so policies genuinely do fail closed. It is
-- only inside plpgsql `IF` that NULL flips the meaning. Out of scope here.
--
-- Note that this RESTORES the intended design: `inventory_state` INSERT/UPDATE
-- stay admin-only at the table level (010 Section 4, already live), and these two
-- functions become the only write paths for everyone else.
--
-- WHAT THIS DOES NOT FIX
-- ----------------------
-- Nothing else from the 2026-07-30 audit. Findings 1-3 (the over-permissive
-- write policies on customers, payments and sales) are a separate migration.
-- This file is scoped to the outage.
--
-- CLIENT DEPENDENCY
-- -----------------
-- None — no client change is needed for this file, and it fixes the live app on
-- its own. It IS however a prerequisite for 015: once production logging is
-- atomic, a failing stock write stops the production log from being recorded at
-- all, so this must be live before 015's client deploy lands.
--
-- Apply via the Supabase SQL Editor AFTER review. Idempotent — safe to re-run.
-- =============================================================================

begin;


-- =============================================================================
-- SECTION 1: PRE-FLIGHT (read-only — run this first, on its own)
--
-- ⚠️ THE QUERY BELOW IS COMMENTED OUT. Strip the leading `--` before running it,
-- or it executes nothing and the editor reports "Success. No rows returned" —
-- which reads exactly like a real (and alarming) empty result. It has to stay
-- commented here because everything below sits inside a transaction that this
-- read-only check must not join.
--
-- Confirm the problem before fixing it. `record_sale` and `get_my_role` are
-- CONTROLS: they must not change, and if the whole result comes back empty you
-- are not connected to the database you think you are.
--
--   select n.nspname                                              as schema,
--          p.proname                                              as function,
--          case when p.prosecdef then 'DEFINER' else 'INVOKER' end as security_type,
--          p.proconfig,
--          pg_get_userbyid(p.proowner)                            as owner
--     from pg_proc p
--     join pg_namespace n on n.oid = p.pronamespace
--    where p.proname in ('apply_inventory_deltas', 'set_inventory_value',
--                        'record_sale', 'get_my_role')
--    order by n.nspname, p.proname;
--
-- Expected BEFORE this migration (confirmed live on 2026-07-31):
--
--   get_my_role             DEFINER   <- correct, from 001
--   record_sale             INVOKER   <- correct, from 011, by design
--   apply_inventory_deltas  INVOKER   <- WRONG, should be DEFINER (010 §2)
--   set_inventory_value     INVOKER   <- WRONG, should be DEFINER (010 §3)
--
-- If the inventory pair already says DEFINER, 010 §2-3 are live after all and
-- this migration is a harmless no-op.
-- =============================================================================


-- =============================================================================
-- SECTION 2: apply_inventory_deltas — admin, manager AND sales
--
-- Body identical to migration 010 Section 2.
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
  --
  -- coalesce is load-bearing, and this is the ONE line that differs from 010.
  -- get_my_role() returns NULL when the caller has no profiles row, and
  -- `NULL not in (...)` evaluates to NULL rather than TRUE — so the bare form
  -- 010 used never raises for a NULL role and the function carries on. That is
  -- fail-OPEN, the exact opposite of what 010's header claims. coalesce to a
  -- value that cannot match any role, so an unknown caller is refused.
  if coalesce(get_my_role(), '') not in ('admin', 'manager', 'sales') then
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
-- Body identical to migration 010 Section 3.
--
-- Worth noting (audit finding 5): live, this function is admin-only purely by
-- the `inventory_state_update` table policy — accidentally correct, and it would
-- silently loosen if that policy ever changed. The internal check below is what
-- makes it correct on purpose.
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
  --
  -- `is distinct from` rather than 010's `<>`: NULL <> 'admin' is NULL, so the
  -- bare comparison never raises for a caller with no profiles row. `is distinct
  -- from` treats NULL as a difference and refuses. Same fail-open fix as the
  -- coalesce in Section 2.
  if get_my_role() is distinct from 'admin' then
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

commit;


-- =============================================================================
-- AFTER APPLYING — verify
--
-- 1. The redefinition actually landed. Re-run the Section 1 pre-flight query
--    (remembering to strip the `--`). Exactly two things must have moved:
--
--      get_my_role             DEFINER   <- unchanged
--      record_sale             INVOKER   <- unchanged, the control
--      apply_inventory_deltas  DEFINER   <- CHANGED
--      set_inventory_value     DEFINER   <- CHANGED
--
--    Do not skip this step — silently not landing is the exact failure this
--    migration exists to correct. If `record_sale` moved, something else ran.
--
--    ⚠️ THE ROLE CHECKS CANNOT BE TESTED FROM THE SQL EDITOR. It connects as a
--    superuser with no JWT, so auth.uid() is NULL, get_my_role() returns NULL,
--    and BOTH functions treat you as an unknown caller. After this migration
--    that means every call below is REFUSED from the editor, whatever role you
--    hold in the app. That refusal is the null-role fix working — it is not a
--    failure. Steps 2-4 must be run as a real logged-in user (via the app, or
--    PostgREST with that user's token), never from the SQL editor.
--
-- 2. Smoke test — does the function execute at all? Safe to run from the editor
--    ONLY if it is refused; a delta of 0 changes no stock either way, so this
--    can be run without a compensating second call (the -1 / +1 pair the old
--    version of this file suggested leaves stock wrong if you forget the +1):
--
--      select apply_inventory_deltas('[{"id":"finishedGoods","path":["0.5L","quantity"],"delta":0}]'::jsonb);
--
--    From the SQL editor, expect: 'not authorised to change stock'.
--
-- 3. As a MANAGER or SALES user in the app (expect: success — this is the
--    outage): record a sale and log a production run. Neither should warn about
--    stock, and the finished-goods tile must move.
--
-- 4. As a MANAGER (expect: refused — the absolute-write path stays admin-only):
--      select set_inventory_value('finishedGoods', '{0.5L,quantity}', 999);
--    Expect: 'only an admin may set an absolute stock quantity'. Before this
--    migration the same call failed with 'inventory_state row ... not found' —
--    right outcome, wrong reason.
--
--    As an ADMIN (expect: success — a no-op that writes back the current value):
--      select set_inventory_value('finishedGoods', '{0.5L,quantity}',
--        (select (data #>> '{0.5L,quantity}')::numeric from inventory_state
--          where id = 'finishedGoods'));
--
-- 5. Stock recorded while the outage was live is NOT repaired by this migration.
--    Run docs/production-stock-reconciliation.sql to find the production runs
--    that logged without moving stock, and correct them through the Stock
--    Adjustments tab so the correction carries an audit row.
-- =============================================================================

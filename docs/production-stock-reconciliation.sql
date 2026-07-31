-- =============================================================================
-- production-stock-reconciliation.sql
-- Northern Water Company Ltd — OASIS Springs
--
-- READ-ONLY. Every statement here is a SELECT. Nothing in this file changes a
-- row. Do not "fix" anything by editing inventory_state directly — corrections
-- go through the Stock Adjustments tab so they carry an audit row, per the data
-- integrity rules in CLAUDE.md.
--
-- WHAT THIS IS FOR
-- ----------------
-- Between migration 013 going live and migration 014 being applied, every
-- manager and sales user hit a broken stock write (see 014's header). Production
-- logging half-succeeded during that window: the run was recorded, the raw
-- materials were never consumed and the finished goods were never posted.
--
-- This script finds those runs and works out the correction. It cannot detect
-- them directly — there is no per-run record of whether stock moved — so it
-- reasons from what IS known:
--
--   * Only non-admin users were affected. Admin-logged runs posted normally.
--   * The failure applied to every affected run in the window, without exception:
--     the RLS policy refused all of them, so this is not a sampling question.
--   * The BOM (migration 015) says exactly what each run should have moved.
--
-- REQUIRES migration 015 to be applied — it calls `production_bom_changes`.
-- Run it AFTER 014 and 015 are live, and BEFORE anyone logs new production, so
-- the figures are not moving underneath you.
--
-- SET THE WINDOW FIRST — see block 0. Getting it wrong is the main way to get a
-- wrong answer here.
-- =============================================================================


-- =============================================================================
-- BLOCK 0 — pin the outage window
--
-- The window opens when migration 013 was applied to production and closes when
-- 014 was applied. 013's exact apply date is not recorded; the 2026-07-30 RLS
-- audit confirms it was already live by then, and it was written on 2026-07-28.
--
-- These help you pin it down. Widening the window is the safer error only if you
-- then check each run individually — a run that DID post stock and gets
-- "corrected" here would be double-counted.
--
--   -- when stock last actually moved (the successful admin writes):
--   select id, updated_at from inventory_state order by updated_at desc;
--
--   -- adjustments already made by hand — anything here may ALREADY have
--   -- corrected part of this, and must not be corrected twice:
--   select * from stock_adjustments order by id desc limit 50;
--
-- Then edit the two dates in the `window` CTE of every block below.
-- They are the ONLY thing you should need to change.
-- =============================================================================


-- =============================================================================
-- BLOCK 1 — which runs are affected
--
-- Non-admin-authored production runs in the window. Check this list against what
-- the plant actually did before trusting anything downstream.
--
-- NOTE ON DATES: `production_logs.date` is the user-entered production date, not
-- the insert time. If the table has a `created_at` column, prefer it — swap the
-- two commented lines. A run back-dated by staff is the likeliest source of a
-- miscount here.
-- =============================================================================

with window_bounds as (
  select date '2026-07-28' as opened,     -- <<< EDIT: when 013 went live
         date '2026-07-31' as closed      -- <<< EDIT: when 014 goes live
)
select
  pl.id,
  pl.date,
  -- pl.created_at,                       -- <<< prefer this if the column exists
  p.role,
  p.location,
  pl.created_by as logged_by,
  pl.items,
  pl.casual_paid,
  pl.notes
from production_logs pl
left join profiles p on p.id = pl.created_by
cross join window_bounds w
where pl.date >= w.opened
  and pl.date <= w.closed
  and coalesce(p.role, 'unknown') <> 'admin'
order by pl.date, pl.id;

-- `logged_by` is a uuid. To put names to it, join whatever identifying column
-- `profiles` actually carries — there is no admin screen for profiles, so the
-- column set has never been pinned down in this repo.


-- =============================================================================
-- BLOCK 2 — what those runs should have moved, per run
--
-- Expands the BOM for each affected run. This is the same function the write
-- path now uses, so these figures are by construction what the stock movement
-- would have been.
-- =============================================================================

with window_bounds as (
  select date '2026-07-28' as opened,     -- <<< EDIT
         date '2026-07-31' as closed      -- <<< EDIT
),
affected as (
  select pl.id, pl.date, pl.items
    from production_logs pl
    left join profiles p on p.id = pl.created_by
    cross join window_bounds w
   where pl.date >= w.opened
     and pl.date <= w.closed
     and coalesce(p.role, 'unknown') <> 'admin'
)
select
  a.id   as production_log_id,
  a.date,
  ch ->> 'id'                                  as inventory_blob,
  array_to_string(
    array(select jsonb_array_elements_text(ch -> 'path')), '.'
  )                                            as item,
  (ch ->> 'delta')::numeric                    as missing_delta
from affected a
cross join lateral jsonb_array_elements(production_bom_changes(a.items, 1)) as ch
order by a.id, inventory_blob, item;


-- =============================================================================
-- BLOCK 3 — THE CORRECTION: totals, and the number to type into Stock Adjustments
--
-- `missing_delta` is the total that should have moved and did not.
-- `current_value` is what the blob says now.
-- `corrected_value` is what the physical stock should be — this is the figure to
-- enter in the Stock Adjustments tab, one item at a time.
--
-- READ BEFORE ACTING: Stock Adjustments writes an ABSOLUTE value, and the tab is
-- admin-only. A physical count ALWAYS beats this arithmetic — if you can count
-- the item, enter the counted figure and use this column only as a cross-check.
-- Raw materials will correct DOWNWARD (they were consumed but never deducted)
-- and finished goods UPWARD (they were produced but never posted).
-- =============================================================================

with window_bounds as (
  select date '2026-07-28' as opened,     -- <<< EDIT
         date '2026-07-31' as closed      -- <<< EDIT
),
affected as (
  select pl.id, pl.items
    from production_logs pl
    left join profiles p on p.id = pl.created_by
    cross join window_bounds w
   where pl.date >= w.opened
     and pl.date <= w.closed
     and coalesce(p.role, 'unknown') <> 'admin'
),
expanded as (
  select ch ->> 'id' as blob_id,
         array(select jsonb_array_elements_text(ch -> 'path')) as path,
         (ch ->> 'delta')::numeric as delta
    from affected a
    cross join lateral jsonb_array_elements(production_bom_changes(a.items, 1)) as ch
),
totals as (
  select blob_id, path, sum(delta) as missing_delta
    from expanded
   group by blob_id, path
)
select
  t.blob_id,
  array_to_string(t.path, '.')                        as item,
  (inv.data #>> t.path)::numeric                      as current_value,
  t.missing_delta,
  (inv.data #>> t.path)::numeric + t.missing_delta    as corrected_value
from totals t
join inventory_state inv on inv.id = t.blob_id
order by t.blob_id, item;


-- =============================================================================
-- BLOCK 4 — the other half-posting path: consignment
--
-- The same broken stock write hit `handleConsignDeliver` and `handleConsignReturn`
-- (src/App.jsx): the movement rows were written, then the plant finished-goods
-- update failed. Migration 015 does NOT fix these — it covers production only —
-- so any rows this returns are a second, separate discrepancy.
--
-- `consignment_movements` has a real `created_at`, so this window is exact.
--
--   deliver → plant finished goods should have gone DOWN by quantity
--   return  → plant finished goods should have gone UP   by quantity
--   sold / reconcile → finished goods are correctly untouched (that stock left
--                      the plant at delivery), so they are excluded here.
-- =============================================================================

with window_bounds as (
  select timestamptz '2026-07-28 00:00' as opened,   -- <<< EDIT
         timestamptz '2026-07-31 23:59' as closed    -- <<< EDIT
)
select
  cm.size,
  sum(case cm.type when 'deliver' then -cm.quantity
                   when 'return'  then  cm.quantity
      end)                                            as missing_fg_delta,
  count(*)                                            as movements,
  min(cm.created_at)                                  as first_seen,
  max(cm.created_at)                                  as last_seen
from consignment_movements cm
left join profiles p on p.id = cm.created_by
cross join window_bounds w
where cm.created_at >= w.opened
  and cm.created_at <= w.closed
  and cm.type in ('deliver', 'return')
  and coalesce(p.role, 'unknown') <> 'admin'
group by cm.size
having sum(case cm.type when 'deliver' then -cm.quantity
                        when 'return'  then  cm.quantity
            end) <> 0
order by cm.size;


-- =============================================================================
-- BLOCK 5 — cross-checks before you correct anything
--
-- 1. Does the shape of the answer make sense? Raw materials should come out
--    NEGATIVE in block 3 (consumed, never deducted) and finished goods POSITIVE
--    (produced, never posted). A finished-goods item correcting downward means
--    the window is wrong or a run in it did post.
--
-- 2. Blocks 3 and 4 both correct finished goods. If both return rows for the
--    same size, the corrections ADD — apply one adjustment per item carrying the
--    combined figure, not two.
--
-- 3. Anything already corrected by hand must be netted off:
--
--      select * from stock_adjustments order by id desc limit 50;
--
-- 4. Sales are NOT in scope and need no correction. `record_sale` (011) is
--    atomic, so a non-admin sale during the window failed outright rather than
--    half-posting — the books and the stock stayed in step. If a sale IS missing,
--    that is a re-entry job, not a stock correction.
--
-- 5. AFTER correcting, finished-goods value feeds inventory valuation and P&L
--    COGS. Regenerate the P&L and the Inventory view and confirm they tie out
--    against production_logs for the period. Expect COGS and closing stock value
--    to MOVE — that is the discrepancy being removed from the books, not a new
--    error being introduced.
-- =============================================================================

-- =============================================================================
-- 008_consignment.sql
-- Northern Water Company Ltd — OASIS Springs
--
-- Adds consignment handling: certain customers act as consignment shops that
-- hold OUR finished-goods stock. Delivering stock to them is a TRANSFER, not a
-- sale — no revenue and no debt is recognised until the shop reports what it
-- actually sold. Stock can also be pulled back to the plant, and existing
-- balances can be reconciled into consignment stock at cutover.
--
-- Two changes:
--   1. customers.is_consignee  — flags a customer as a consignment shop.
--   2. consignment_movements   — an append-only ledger of stock movements
--      between the plant and each shop. Current stock on hand at a shop is
--      derived by summing this ledger (deliver + reconcile add, return + sold
--      subtract). Money is never stored here — revenue/debt live in `sales`.
--
-- Apply via Supabase SQL Editor — do NOT run directly against prod without
-- review. RLS is enabled and all policies are defined in THIS migration.
-- =============================================================================


-- =============================================================================
-- SECTION 1: customers.is_consignee
-- =============================================================================

alter table customers
  add column if not exists is_consignee boolean not null default false;


-- =============================================================================
-- SECTION 2: consignment_movements
--
-- type:
--   'deliver'   — stock leaves the plant to a shop      (+ shop stock, - plant FG)
--   'return'    — stock comes back to the plant         (- shop stock, + plant FG)
--   'sold'      — shop reports goods sold; a real `sales` row is created for the
--                 revenue/debt and linked via sale_id  (- shop stock, no plant FG)
--   'reconcile' — cutover: seed shop stock that was previously (wrongly) booked
--                 as sold; the paired credit-note `sales` row reverses the
--                 revenue and debt                       (+ shop stock, no plant FG)
--
-- quantity is always POSITIVE (cartons); the sign is implied by `type`.
-- unit_price / sale_id are set only for 'sold' and 'reconcile'.
-- Ledger is immutable: INSERT + DELETE(admin) only, no UPDATE — corrections are
-- made with an opposing movement, mirroring how sales/payments are handled.
-- =============================================================================

create table if not exists consignment_movements (
  id          bigint generated always as identity primary key,
  shop_id     bigint not null references customers(id),
  date        date   not null default current_date,
  type        text   not null check (type in ('deliver', 'return', 'sold', 'reconcile')),
  size        text   not null,
  quantity    numeric not null check (quantity > 0),
  unit_price  numeric,
  sale_id     bigint references sales(id),
  note        text,
  created_by  uuid,
  created_at  timestamptz not null default now()
);

create index if not exists consignment_movements_shop_idx
  on consignment_movements (shop_id);


-- =============================================================================
-- SECTION 3: RLS
--
-- Consignment is an admin/manager activity (owner delivers stock, reports
-- sell-through, reconciles). Sales users do not touch it.
--   select : admin/manager
--   insert : admin/manager
--   delete : admin only  (deletion must reverse the paired sale by hand — rare)
--   update : none — ledger is immutable
-- =============================================================================

alter table consignment_movements enable row level security;

-- Each policy is dropped first so this file is re-runnable; they were bare
-- `create policy` statements when first applied, which error on a second run.
--
-- NOTE: migration 010 supersedes the INSERT policy below, splitting it so that
-- only an admin may insert a 'reconcile' movement (it erases customer debt).
-- Re-running THIS file would reinstate the looser manager-can-reconcile rule, so
-- if you ever replay it, apply 010 afterwards.
drop policy if exists "consignment_movements_select" on consignment_movements;
create policy "consignment_movements_select"
  on consignment_movements for select
  using (get_my_role() in ('admin', 'manager'));

drop policy if exists "consignment_movements_insert" on consignment_movements;
create policy "consignment_movements_insert"
  on consignment_movements for insert
  with check (get_my_role() in ('admin', 'manager'));

drop policy if exists "consignment_movements_delete" on consignment_movements;
create policy "consignment_movements_delete"
  on consignment_movements for delete
  using (get_my_role() = 'admin');

-- Deliberately no UPDATE policy — movements are permanent records.

-- =============================================================================
-- 034_remove_credit_notes.sql
--
-- Remove the credit-note feature (032 + 033) and go back to deleting invoices.
--
-- WHY
-- ---
-- Owner decision 2026-11-14: cancelling an invoice with a credit note is not
-- wanted. A wrong or duplicate invoice is simply deleted again, through the
-- existing `delete_sale` flow (admin only, stock returned, one transaction).
--
-- The reason 032 existed was that renumbered invoices (030/031) could NOT be
-- deleted: `invoice_renumber_log.sale_id` references `sales(id)` with no ON
-- DELETE action. This file fixes that link, so `delete_sale` works on every
-- invoice again.
--
-- WHAT IT DOES — one transaction
-- ------------------------------
--   1. invoice_renumber_log.sale_id becomes nullable, and its foreign key is
--      re-created ON DELETE SET NULL. Deleting a renumbered sale keeps the log
--      row (date, old number, new number) and just clears the sale link.
--   2. Every existing cancellation is undone AS IF THE INVOICE HAD BEEN
--      DELETED: the credit note, its two 'credit_note' legs, any
--      'sale_reversal' row, and the cancelled invoice itself are removed.
--      NO STOCK MOVES: `cancel_invoice` already returned the invoice's cartons
--      to finished goods, which is exactly what `delete_sale` would have done.
--      Calling `delete_sale` here would return them a second time.
--   3. The machinery goes: both `cancel_invoice` signatures, the three guard
--      triggers and their functions, `next_credit_note_number()` and
--      `credit_note_seq`, the columns `sales.cancels_sale_id` / `cancel_reason`
--      (with their index and check constraint), and the 'credit_note' /
--      'sale_reversal' payment kinds (`payments_kind_shape` back to `025`).
--
-- SAFETY CHECKS (the whole file aborts, changing nothing, if any fails)
-- -------------------------------------------------------------------
--   * every 'credit_note' / 'sale_reversal' row belongs to a cancelled pair;
--   * no other payment row names either half of a pair;
--   * no pair is linked to consignment stock;
--   * each pair nets to ZERO in the balance formula's sales term
--     (sum of total - paid over both rows). Deleting rows that sum to zero
--     cannot change any customer's balance, so no recompute is needed — and
--     `recompute_customer_balance` cannot be called from the SQL Editor anyway
--     (it refuses a caller with no role);
--   * nothing that cancels anything is left before the columns are dropped.
--
-- WHAT THIS MOVES IN THE REPORTS (stated before applying, per CLAUDE.md)
-- ----------------------------------------------------------------------
--   * Customer balances / Debtors: UNCHANGED (each pair nets to zero — checked).
--   * Cash Collected: UNCHANGED. For a paid-at-sale duplicate, the reversal
--     took the cash out on the original sale date; with the invoice gone, that
--     date loses the same amount through the invoice instead.
--   * P&L: MOVES BETWEEN MONTHS. Today the credit note reduces revenue/COGS in
--     the month it was made (November 2026). After this, the invoice's revenue
--     and COGS disappear from THE INVOICE'S OWN MONTH and the credit note's
--     negative disappears from November. For any cancelled invoice dated before
--     November, that earlier month's P&L goes DOWN and November's goes back UP
--     by the same amount. The pre-flight query lists the dates.
--   * Finished goods: UNCHANGED (already returned at cancellation).
--   * The CN-### records are ERASED. Save the pre-flight result first.
--
-- RLS: no policy is created, dropped or altered. The renumber log keeps its
-- admin-only SELECT policy; the SET NULL is performed by the foreign key
-- itself, not by any user.
--
-- APPLY ORDER: either order with the client is safe (the old client only
-- calls `cancel_invoice` from a button; afterwards that call just errors and
-- changes nothing). Applying this first is preferred, so the restored client
-- can delete renumbered invoices from day one.
-- =============================================================================


-- =============================================================================
-- BEFORE APPLYING — PRE-FLIGHT (read-only). Run ON ITS OWN and EXPORT THE
-- RESULT (CSV) — it is the only record of the credit notes once this runs.
--
--   select inv.id               as invoice_id,
--          inv."invoiceNumber"  as invoice,
--          inv.date             as invoice_date,
--          cn.id                as credit_note_id,
--          cn."invoiceNumber"   as credit_note,
--          cn.date              as credit_note_date,
--          c.name               as customer,
--          inv.total            as invoice_total,
--          cn.cancel_reason     as reason,
--          (select coalesce(sum(-p.amount), 0) from payments p
--            where p."saleId" = inv.id and p.kind = 'sale_reversal') as reversed_paid_at_sale,
--          (select count(*) from payments p
--            where p."saleId" in (inv.id, cn.id)
--              and p.kind not in ('credit_note', 'sale_reversal'))   as other_payments_expect_0,
--          (inv.total - coalesce(inv.paid, 0)) + (cn.total - coalesce(cn.paid, 0)) as pair_net_expect_0
--     from sales cn
--     join sales inv on inv.id = cn.cancels_sale_id
--     left join customers c on c.id = inv."customerId"
--    order by cn.id;
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- SECTION 1: let renumbered sales be deleted
-- -----------------------------------------------------------------------------

alter table public.invoice_renumber_log alter column sale_id drop not null;

alter table public.invoice_renumber_log
  drop constraint if exists invoice_renumber_log_sale_id_fkey;
alter table public.invoice_renumber_log
  add constraint invoice_renumber_log_sale_id_fkey
  foreign key (sale_id) references public.sales(id) on delete set null;

-- -----------------------------------------------------------------------------
-- SECTION 2: the permanence triggers go first, or nothing below can delete
-- -----------------------------------------------------------------------------

drop trigger if exists payments_credit_note_insert_guard on public.payments;
drop trigger if exists payments_credit_note_delete_guard on public.payments;
drop trigger if exists sales_credit_note_delete_guard    on public.sales;

drop function if exists public.guard_credit_note_payment_insert();
drop function if exists public.guard_credit_note_payment_delete();
drop function if exists public.guard_credit_note_sale_delete();

-- -----------------------------------------------------------------------------
-- SECTION 3: undo every existing cancellation, as a delete of the invoice
--
-- Guarded on the column so a re-run (after section 5 dropped it) is a no-op.
-- -----------------------------------------------------------------------------

do $$
declare
  v_bad   bigint;
  v_pairs int;
  v_pays  int;
  v_sales int;
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'sales'
       and column_name = 'cancels_sale_id'
  ) then
    raise notice '034: sales.cancels_sale_id already gone — nothing to undo';
    return;
  end if;

  create temp table _cn_pairs on commit drop as
  select cn.id as cn_id, cn.cancels_sale_id as inv_id
    from sales cn
   where cn.cancels_sale_id is not null;

  select count(*) into v_pairs from _cn_pairs;

  -- Every special-kind payment belongs to a pair.
  select count(*) into v_bad
    from payments p
   where p.kind in ('credit_note', 'sale_reversal')
     and not exists (select 1 from _cn_pairs x where p."saleId" in (x.cn_id, x.inv_id));
  if v_bad > 0 then
    raise exception '034: % credit_note/sale_reversal payment(s) are not attached to a cancelled pair — stopping, nothing changed', v_bad;
  end if;

  -- No ordinary payment names either half.
  select count(*) into v_bad
    from payments p
    join _cn_pairs x on p."saleId" in (x.cn_id, x.inv_id)
   where p.kind not in ('credit_note', 'sale_reversal');
  if v_bad > 0 then
    raise exception '034: % ordinary payment(s) name a cancelled invoice or credit note — stopping, nothing changed', v_bad;
  end if;

  -- No consignment link.
  select count(*) into v_bad
    from consignment_movements m
    join _cn_pairs x on m.sale_id in (x.cn_id, x.inv_id);
  if v_bad > 0 then
    raise exception '034: % consignment movement(s) reference a cancelled pair — stopping, nothing changed', v_bad;
  end if;

  -- Each pair contributes zero to the balance, so deleting it moves no balance.
  select count(*) into v_bad
    from _cn_pairs x
    join sales inv on inv.id = x.inv_id
    join sales cn  on cn.id  = x.cn_id
   where (inv.total - coalesce(inv.paid, 0)) + (cn.total - coalesce(cn.paid, 0)) <> 0
      or inv."customerId" is distinct from cn."customerId";
  if v_bad > 0 then
    raise exception '034: % cancelled pair(s) do not net to zero — deleting them would move a balance; stopping, nothing changed', v_bad;
  end if;

  delete from payments p
   using _cn_pairs x
   where p."saleId" in (x.cn_id, x.inv_id);
  get diagnostics v_pays = row_count;

  -- Credit notes first (they reference the invoices), then the invoices.
  delete from sales s using _cn_pairs x where s.id = x.cn_id;
  get diagnostics v_sales = row_count;
  delete from sales s using _cn_pairs x where s.id = x.inv_id;
  get diagnostics v_bad = row_count;

  if v_sales <> v_pairs or v_bad <> v_pairs then
    raise exception '034: expected to delete % credit notes and % invoices, got % and % — stopping, nothing changed',
      v_pairs, v_pairs, v_sales, v_bad;
  end if;

  raise notice '034: undid % cancellation(s): % sales and % payment rows removed, no stock moved',
    v_pairs, v_sales + v_bad, v_pays;
end $$;

-- -----------------------------------------------------------------------------
-- SECTION 4: functions and numbering
-- -----------------------------------------------------------------------------

drop function if exists public.cancel_invoice(bigint, text, date, uuid);
drop function if exists public.cancel_invoice(bigint, text, date, uuid, boolean);
drop function if exists public.next_credit_note_number();
drop sequence if exists public.credit_note_seq;

-- -----------------------------------------------------------------------------
-- SECTION 5: columns on sales
-- -----------------------------------------------------------------------------

do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'sales'
       and column_name = 'cancels_sale_id'
  ) then
    if exists (select 1 from public.sales where cancels_sale_id is not null) then
      raise exception '034: credit notes still present — refusing to drop the column';
    end if;
  end if;
end $$;

alter table public.sales drop constraint if exists sales_credit_note_shape;
drop index if exists public.sales_cancels_sale_id_key;
alter table public.sales drop column if exists cancels_sale_id;
alter table public.sales drop column if exists cancel_reason;

-- -----------------------------------------------------------------------------
-- SECTION 6: payments.kind back to `025`'s three kinds
-- -----------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from public.payments where kind in ('credit_note', 'sale_reversal')) then
    raise exception '034: credit_note/sale_reversal payments still present — refusing to narrow payments_kind_shape';
  end if;
end $$;

alter table public.payments drop constraint if exists payments_kind_shape;
alter table public.payments add constraint payments_kind_shape check (
  "customerId" is not null
  and case kind
        when 'invoice'    then "saleId" is not null and amount > 0
        when 'on_account' then "saleId" is null     and amount > 0
        when 'credit_applied' then
             ("saleId" is not null and amount > 0)
          or ("saleId" is null     and amount < 0)
        else false
      end
) not valid;

commit;


-- =============================================================================
-- AFTER APPLYING — verify it LANDED. Run each query ON ITS OWN (the SQL Editor
-- shows only the last result).
--
-- 1. Nothing of the feature is left. Expect 0 | 0 | 0 | 0 | 0:
--
--      select
--        (select count(*) from pg_proc where proname in
--           ('cancel_invoice', 'next_credit_note_number',
--            'guard_credit_note_payment_insert', 'guard_credit_note_payment_delete',
--            'guard_credit_note_sale_delete'))                                  as functions,
--        (select count(*) from pg_trigger where tgname like '%credit_note%')    as triggers,
--        (select count(*) from information_schema.columns
--          where table_name = 'sales' and column_name in ('cancels_sale_id', 'cancel_reason')) as columns,
--        (select count(*) from pg_class where relname = 'credit_note_seq')      as sequences,
--        (select count(*) from payments where kind in ('credit_note', 'sale_reversal')) as special_payments;
--
-- 2. The renumber log now lets a sale go. Expect  invoice_renumber_log_sale_id_fkey | n
--    (confdeltype 'n' = SET NULL):
--
--      select conname, confdeltype from pg_constraint
--       where conname = 'invoice_renumber_log_sale_id_fkey';
--
-- 3. Pre-flight for the VALIDATE (expect 0):
--
--      select count(*) from payments
--       where not ("customerId" is not null and case kind
--         when 'invoice' then "saleId" is not null and amount > 0
--         when 'on_account' then "saleId" is null and amount > 0
--         when 'credit_applied' then ("saleId" is not null and amount > 0)
--                                 or ("saleId" is null and amount < 0)
--         else false end);
--
-- 4. Only if check 3 returned 0; expect payments_kind_shape | true:
--
--      alter table payments validate constraint payments_kind_shape;
--
--      select conname, convalidated from pg_constraint
--       where conrelid = 'public.payments'::regclass and conname = 'payments_kind_shape';
--
-- 5. In the app, as admin, on a real duplicate that is a RENUMBERED invoice
--    (its id appears in invoice_renumber_log.sale_id): Delete it. Expect it to
--    go, its cartons to return to finished goods, and its log row to survive:
--
--      select * from invoice_renumber_log where sale_id is null;
-- =============================================================================

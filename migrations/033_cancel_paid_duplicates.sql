-- =============================================================================
-- 033_cancel_paid_duplicates.sql
--
-- Let the credit note cancel a duplicate invoice that was entered as PAID AT
-- THE POINT OF SALE when the money was never received.
--
-- WHY
-- ---
-- `032` cancels unpaid invoices only. The owner's real duplicates (2026-11-12)
-- are pairs where BOTH copies were entered with "Amount Paid" filled in, but
-- the money was received once. The duplicate carries `sales.paid` set at
-- creation and no payment record, so there was nothing to reverse and the
-- Cancel button never appeared. Cash Collected is overstated by each one.
--
-- DECISIONS (owner, 2026-11-12)
-- -----------------------------
--   * Same Cancel (credit note) flow, not a second button. When the invoice was
--     paid at the point of sale the operator is asked whether that money was
--     actually received; only "never received" proceeds.
--   * The reversal is dated the ORIGINAL SALE DATE, so that day's Cash
--     Collected is corrected to what was really received. Past Cash Collected
--     figures for those days WILL change.
--   * Invoices with separate payment records (not point-of-sale) are still
--     refused: delete the duplicate payment through the existing flow first.
--   * Everything else from `032` stands: admin only, whole invoice, credit note
--     dated today, stock always returned, permanent.
--
-- HOW — `cancel_invoice(..., p_never_received)`, one transaction
-- -------------------------------------------------------------
--   1. A payments row of the new kind 'sale_reversal': -paid, on the invoice,
--      dated the invoice's date, referencing the credit note. `adjust_sale_paid`
--      takes the invoice to paid = 0. The original "paid at sale" figure is not
--      edited away in the record: the reversal is its own visible row.
--   2. Then exactly `032`'s cancellation: credit note, the two 'credit_note'
--      settling legs, stock back, balance recomputed.
--
-- WHAT THIS MOVES (stated before applying, per CLAUDE.md)
-- ------------------------------------------------------
--   * Cash Collected: falls by the reversed amount ON THE ORIGINAL SALE DATE.
--     The client counts point-of-sale cash net of 'sale_reversal' rows.
--   * P&L: revenue/COGS fall by the invoice in the credit note's (current)
--     period — as `032`.
--   * Customer balance / Debtors: UNCHANGED. The duplicate read as paid, so it
--     was never owed; afterwards it is cancelled and still not owed. (Sales
--     term: before T - T = 0; after invoice T - T = 0 and credit note 0.)
--   * Finished goods: rise by the invoice's cartons — as `032`.
--   * Balance formula: NOT changed.
--
-- ALSO CLOSES A GAP IN 032
-- ------------------------
-- `payments_insert` does not restrict `kind`, so any role allowed to insert a
-- payment could insert a bare 'credit_note' row through the API. It could not
-- move a balance on its own (the balance reads `sales.paid`), but it would be
-- permanent and invisible to cash. Both special kinds — 'credit_note' and
-- 'sale_reversal' — may now only be written from inside `cancel_invoice`,
-- which marks its own transaction with a transaction-local setting the API
-- cannot reach (`set_config` lives in pg_catalog, which PostgREST does not
-- expose, and each API request is its own transaction).
--
-- RLS: no policy created, dropped or altered.
-- COMPATIBILITY: the 4-argument `cancel_invoice` the live client calls stays,
-- as a wrapper with p_never_received = false, so applying this before the new
-- client deploys breaks nothing. Apply 033 BEFORE merging its client.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- SECTION 1: payments.kind — 'sale_reversal'
-- `032`'s branches verbatim, plus one. Always names a sale, always negative.
-- -----------------------------------------------------------------------------

alter table public.payments drop constraint if exists payments_kind_shape;
alter table public.payments add constraint payments_kind_shape check (
  "customerId" is not null
  and case kind
        when 'invoice'    then "saleId" is not null and amount > 0
        when 'on_account' then "saleId" is null     and amount > 0
        when 'credit_applied' then
             ("saleId" is not null and amount > 0)
          or ("saleId" is null     and amount < 0)
        when 'credit_note'   then "saleId" is not null and amount <> 0
        when 'sale_reversal' then "saleId" is not null and amount < 0
        else false
      end
) not valid;

-- -----------------------------------------------------------------------------
-- SECTION 2: cancel_invoice, five arguments
--
-- `032`'s body with the paid-at-sale branch added. Differences from `032`:
--   * marks the transaction so the guard trigger admits its special rows;
--   * the credit-note number is drawn BEFORE any insert so the reversal row
--     can reference it;
--   * paid <> 0 is no longer an automatic refusal: with no payment records and
--     p_never_received = true, the point-of-sale amount is reversed first.
-- -----------------------------------------------------------------------------

create or replace function public.cancel_invoice(
  p_sale_id        bigint,
  p_reason         text,
  p_date           date,
  p_client_key     uuid,
  p_never_received boolean
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_role      text;
  v_reason    text;
  v_date      date;
  v_inv       sales;
  v_cn        sales;
  v_cn_number text;
  v_paid      numeric;
  v_items     jsonb;
  v_rev       payments;
  v_pay_inv   payments;
  v_pay_cn    payments;
  v_changes   jsonb;
  v_inventory jsonb;
  v_customer  jsonb;
begin
  v_role := coalesce(get_my_role(), '');
  if v_role is distinct from 'admin' then
    raise exception 'cancel_invoice: only an admin can cancel an invoice';
  end if;

  v_reason := nullif(btrim(coalesce(p_reason, '')), '');
  if v_reason is null then
    raise exception 'cancel_invoice: a reason is required';
  end if;

  select * into v_inv from sales where id = p_sale_id for update;
  if not found then
    raise exception 'cancel_invoice: sale % not found', p_sale_id;
  end if;

  -- Replay: this exact cancellation already happened.
  if p_client_key is not null then
    select * into v_cn from sales where client_key = p_client_key;
    if found then
      if v_cn.cancels_sale_id is distinct from p_sale_id then
        raise exception 'cancel_invoice: request key already used for a different record';
      end if;
      return jsonb_build_object(
        'credit_note', to_jsonb(v_cn),
        'invoice',     to_jsonb(v_inv),
        'payments',    coalesce((select jsonb_agg(to_jsonb(p)) from payments p
                                  where p.kind in ('credit_note', 'sale_reversal')
                                    and p."saleId" in (v_inv.id, v_cn.id)), '[]'::jsonb),
        'customer',    recompute_customer_balance(v_inv."customerId"),
        'inventory',   current_inventory(),
        'replayed',    true
      );
    end if;
  end if;

  if v_inv.cancels_sale_id is not null or coalesce(v_inv.total, 0) <= 0 then
    raise exception 'cancel_invoice: % is a credit note, not an invoice', v_inv."invoiceNumber";
  end if;

  select * into v_cn from sales where cancels_sale_id = p_sale_id;
  if found then
    raise exception 'cancel_invoice: % is already cancelled by %', v_inv."invoiceNumber", v_cn."invoiceNumber";
  end if;

  if exists (select 1 from consignment_movements where sale_id = p_sale_id) then
    raise exception 'cancel_invoice: % is linked to consignment stock and must be handled from the Consignment view', v_inv."invoiceNumber";
  end if;

  if exists (select 1 from payments where "saleId" = p_sale_id) then
    raise exception 'cancel_invoice: % has payment records against it. Delete the duplicate payment first, then cancel.',
      v_inv."invoiceNumber";
  end if;

  v_paid := coalesce(v_inv.paid, 0);
  if v_paid <> 0 then
    if p_never_received is not true then
      raise exception 'cancel_invoice: % was recorded as paid (KES %) when it was entered. It can only be cancelled if that money was never received.',
        v_inv."invoiceNumber", v_paid;
    end if;
    if v_paid < 0 or v_paid > v_inv.total then
      raise exception 'cancel_invoice: % has an impossible paid figure (KES %) and needs looking at by hand', v_inv."invoiceNumber", v_paid;
    end if;
  end if;

  v_date := coalesce(p_date, current_date);
  if v_date < current_date - 1 or v_date > current_date + 1 then
    raise exception 'cancel_invoice: a credit note is dated today (got %)', v_date;
  end if;

  -- Admit this transaction's 'credit_note' / 'sale_reversal' rows (section 3).
  perform set_config('app.cancel_invoice', 'on', true);

  v_cn_number := next_credit_note_number();

  -- Paid at the point of sale but never received: reverse it, dated the
  -- ORIGINAL sale date so that day's Cash Collected is corrected.
  if v_paid <> 0 then
    insert into payments ("saleId", "customerId", date, amount, method, reference, created_by, kind)
    values (v_inv.id, v_inv."customerId", v_inv.date, -v_paid, v_inv.method,
            'Never received — reversed by ' || v_cn_number, auth.uid(), 'sale_reversal')
    returning * into v_rev;
    perform adjust_sale_paid(v_inv.id, -v_paid);
  end if;

  -- From here on, `032` unchanged.
  select coalesce(jsonb_agg(
           case when item ? 'subtotal'
                then item || jsonb_build_object(
                       'quantity', -((item ->> 'quantity')::numeric),
                       'subtotal', -((item ->> 'subtotal')::numeric))
                else item || jsonb_build_object(
                       'quantity', -((item ->> 'quantity')::numeric))
           end), '[]'::jsonb)
    into v_items
    from jsonb_array_elements(coalesce(v_inv.items, '[]'::jsonb)) as item;

  insert into sales ("customerId", date, items, total, paid, status, method,
                     created_by, client_key, "invoiceNumber", cancels_sale_id, cancel_reason)
  values (v_inv."customerId", v_date, v_items, -v_inv.total, 0, 'pending', null,
          auth.uid(), p_client_key, v_cn_number, v_inv.id, v_reason)
  returning * into v_cn;

  insert into payments ("saleId", "customerId", date, amount, method, reference, created_by, kind)
  values (v_inv.id, v_inv."customerId", v_date, v_inv.total, null, v_cn."invoiceNumber", auth.uid(), 'credit_note')
  returning * into v_pay_inv;

  insert into payments ("saleId", "customerId", date, amount, method, reference, created_by, kind)
  values (v_cn.id, v_inv."customerId", v_date, -v_inv.total, null, v_inv."invoiceNumber", auth.uid(), 'credit_note')
  returning * into v_pay_cn;

  perform adjust_sale_paid(v_inv.id, v_inv.total);
  perform adjust_sale_paid(v_cn.id, -v_inv.total);

  v_changes := fg_delta_changes(v_inv.items, 1);
  if jsonb_array_length(v_changes) > 0 then
    v_inventory := apply_inventory_deltas(v_changes);
  else
    v_inventory := current_inventory();
  end if;

  v_customer := recompute_customer_balance(v_inv."customerId");

  select * into v_inv from sales where id = v_inv.id;
  select * into v_cn  from sales where id = v_cn.id;

  return jsonb_build_object(
    'credit_note', to_jsonb(v_cn),
    'invoice',     to_jsonb(v_inv),
    'payments',    case when v_rev.id is null
                        then jsonb_build_array(to_jsonb(v_pay_inv), to_jsonb(v_pay_cn))
                        else jsonb_build_array(to_jsonb(v_rev), to_jsonb(v_pay_inv), to_jsonb(v_pay_cn))
                   end,
    'customer',    v_customer,
    'inventory',   v_inventory
  );
end;
$$;

grant execute on function public.cancel_invoice(bigint, text, date, uuid, boolean) to authenticated;
revoke all on function public.cancel_invoice(bigint, text, date, uuid, boolean) from anon, public;

-- The 4-argument form the 032 client calls. Same behaviour as before: a paid
-- invoice is refused.
create or replace function public.cancel_invoice(
  p_sale_id    bigint,
  p_reason     text,
  p_date       date,
  p_client_key uuid
)
returns jsonb
language sql
set search_path = public, pg_temp
as $$
  select public.cancel_invoice(p_sale_id, p_reason, p_date, p_client_key, false);
$$;

grant execute on function public.cancel_invoice(bigint, text, date, uuid) to authenticated;
revoke all on function public.cancel_invoice(bigint, text, date, uuid) from anon, public;

-- -----------------------------------------------------------------------------
-- SECTION 3: guards
--
-- Insert: `032`'s rule (nothing but a 'credit_note' leg against a cancelled
-- pair), plus: the two special kinds only from inside cancel_invoice.
-- Delete: 'sale_reversal' is as permanent as 'credit_note'.
-- -----------------------------------------------------------------------------

create or replace function public.guard_credit_note_payment_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.kind in ('credit_note', 'sale_reversal')
     and coalesce(current_setting('app.cancel_invoice', true), '') <> 'on' then
    raise exception 'Payments of kind % can only be created by cancelling an invoice.', new.kind;
  end if;

  if new.kind is distinct from 'credit_note'
     and new."saleId" is not null
     and (
       exists (select 1 from sales s where s.id = new."saleId" and s.cancels_sale_id is not null)  -- a credit note
       or exists (select 1 from sales s where s.cancels_sale_id = new."saleId")                    -- a cancelled invoice
     ) then
    raise exception 'This invoice has been cancelled by a credit note; no payment can be recorded against it.';
  end if;
  return new;
end;
$$;

create or replace function public.guard_credit_note_payment_delete()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.kind in ('credit_note', 'sale_reversal') then
    raise exception 'A cancelled invoice and its credit note are permanent and cannot be deleted.';
  end if;
  return old;
end;
$$;

-- Triggers from 032 already point at these function names; nothing to re-create.

commit;


-- =============================================================================
-- AFTER APPLYING — verify it LANDED. Run each query ON ITS OWN (the SQL Editor
-- shows only the last result).
--
-- 0. Pre-flight for check 1 (expect 0):
--
--      select count(*) from payments
--       where not ("customerId" is not null and case kind
--         when 'invoice' then "saleId" is not null and amount > 0
--         when 'on_account' then "saleId" is null and amount > 0
--         when 'credit_applied' then ("saleId" is not null and amount > 0)
--                                 or ("saleId" is null and amount < 0)
--         when 'credit_note' then "saleId" is not null and amount <> 0
--         when 'sale_reversal' then "saleId" is not null and amount < 0
--         else false end);
--
-- 1. Validate (only if check 0 returned 0); expect payments_kind_shape | true:
--
--      alter table payments validate constraint payments_kind_shape;
--
--      select conname, convalidated from pg_constraint
--       where conrelid = 'public.payments'::regclass and conname = 'payments_kind_shape';
--
-- 2. Both forms of cancel_invoice exist, neither SECURITY DEFINER; expect 2
--    rows, both false:
--
--      select oid::regprocedure, prosecdef from pg_proc
--       where proname = 'cancel_invoice';
--
-- 3. The guard now refuses a bare special row. Run all three lines TOGETHER —
--    the ROLLBACK means nothing can be kept even if the guard were missing.
--    Expect an ERROR mentioning "can only be created by cancelling an invoice":
--
--      begin;
--      insert into payments ("saleId", "customerId", date, amount, kind)
--      select id, "customerId", date, 1, 'credit_note' from sales
--       where total > 0 order by id desc limit 1;
--      rollback;
--
-- 4. End to end, as admin in the app, on ONE known case-B duplicate. Before,
--    note the Cash Collected total for that invoice's DATE, the customer's
--    balance, and finished goods. Cancel it, answering "never received".
--    After, expect:
--
--      select kind, date, amount, reference from payments
--       where "saleId" = <invoice id> order by id;
--      -- sale_reversal  | <sale date> | -<paid> | Never received — reversed by CN-…
--      -- credit_note    | <today>     | +<total>| CN-…
--
--      * Cash Collected for the sale date: down by <paid>
--      * customer balance: UNCHANGED
--      * finished goods: up by the invoice's cartons
-- =============================================================================

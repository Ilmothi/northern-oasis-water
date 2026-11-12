-- =============================================================================
-- 032_invoice_credit_notes.sql
--
-- Cancel an invoice with a credit note instead of deleting it.
--
-- WHY
-- ---
-- Duplicate invoices (the same sale entered twice) had to be removed with
-- `delete_sale`. That stopped working for every sale `030`/`031` renumbered:
-- `invoice_renumber_log.sale_id` references `sales(id)` with no ON DELETE
-- action, so the delete is refused with
--   update or delete on table "sales" violates foreign key constraint
--   "invoice_renumber_log_sale_id_fkey"
-- The owner chose (2026-11-12) to cancel such invoices with a credit note
-- rather than delete them — the invoice stays on the books, the credit note
-- sits next to it, and nothing is erased. This file does NOT touch the
-- renumber-log foreign key; renumbered invoices remain undeletable.
--
-- DECISIONS (owner, 2026-11-12)
-- -----------------------------
--   * Admin only — enforced here, not just by hiding the button.
--   * Whole invoice only. No partial credit.
--   * Unpaid invoices only. An invoice with any money on it is refused; the
--     admin reverses the payment(s) first. (For a duplicate, cancel the copy
--     that carries no payment.)
--   * Dated TODAY (the operator's local date, checked to be within a day of the
--     server's), so the revenue reversal lands in the current period and no
--     past P&L is restated.
--   * Stock ALWAYS goes back to finished goods.
--
-- HOW A CANCELLATION IS RECORDED — one transaction, `cancel_invoice`
-- -----------------------------------------------------------------
--   1. A credit-note SALE: same customer, the invoice's lines with the
--      quantities negated, total = -invoice.total, numbered `CN-###` from its own
--      sequence, `cancels_sale_id` = the invoice, `cancel_reason` = the reason.
--      This is the same shape consignment reconciliation already uses for its
--      credit notes, so P&L revenue (sum of sale totals by date) and COGS
--      (quantities x carton cost) both reverse on the credit note's date.
--   2. Two `payments` rows of the new kind 'credit_note' that SETTLE the pair
--      against each other: +total on the invoice, -total on the credit note,
--      each pushed into `sales.paid` through the existing `adjust_sale_paid`.
--      Afterwards the invoice reads paid in full and the credit note reads
--      settled, so every screen that works from `total - paid` (statement,
--      Debtors, aging, payment pickers) drops both without being changed.
--   3. Finished goods: the invoice's cartons are returned (`fg_delta_changes`
--      with +1, exactly what `delete_sale` does).
--   4. `recompute_customer_balance` — the formula is NOT changed. The pair
--      contributes (T - T) + (-T - -T) = 0 to the sales term, and both legs name
--      a sale, so the credit-pool term is untouched. Net effect: the customer's
--      debt falls by T.
--
-- WHAT THIS MOVES IN THE REPORTS (stated before applying, per CLAUDE.md)
-- ----------------------------------------------------------------------
--   * P&L: revenue and COGS fall by the invoice's amounts IN THE CREDIT NOTE'S
--     PERIOD. Past periods are not restated.
--   * Debtors / customer balance: fall by the invoice total.
--   * Cash Collected: unchanged. The 'credit_note' legs move no money; the
--     client excludes them exactly as it excludes 'credit_applied'. (The
--     cash-at-sale split also comes out at 0 for both rows.)
--   * Finished goods: rise by the invoice's cartons.
--
-- PERMANENCE
-- ----------
-- A credit note and the invoice it cancels cannot be deleted, and the two
-- 'credit_note' payment legs cannot be deleted on their own (triggers in
-- section 6). Deleting either would strand the other half and corrupt the
-- balance. No payment of any other kind can be recorded against either sale.
--
-- RLS / SECURITY
-- --------------
-- No policy is created, dropped or altered. `cancel_invoice` is SECURITY
-- INVOKER like `delete_sale`: its writes go through the caller's existing
-- policies (sales_insert_admin, sales_update_admin_manager, payments_insert,
-- the inventory functions' own gates). On top of that it refuses any caller
-- whose role is not 'admin', with the role coalesced to '' first so a missing
-- profile fails CLOSED (see the null-role note in the README).
-- The two trigger functions are SECURITY DEFINER only so they can SEE the
-- credit-note link regardless of the caller's row visibility; they never
-- write, and they only ever refuse.
--
-- `payments_kind_shape` is dropped and re-added with one new branch. It is
-- re-added NOT VALID (as `025` did): new rows are checked immediately; run the
-- VALIDATE in check 1 afterwards.
--
-- Apply in the Supabase SQL Editor. Do not apply before reading the checks at
-- the bottom.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- SECTION 1: columns on sales
-- -----------------------------------------------------------------------------

alter table public.sales
  add column if not exists cancels_sale_id bigint references public.sales(id),
  add column if not exists cancel_reason   text;

comment on column public.sales.cancels_sale_id is
  'Set on a credit note only: the invoice it cancels (migration 032). The '
  'foreign key also stops the cancelled invoice being deleted.';
comment on column public.sales.cancel_reason is
  'Why the invoice was cancelled. Set on the credit note (migration 032).';

-- One credit note per invoice, ever. Also the index the triggers below use.
create unique index if not exists sales_cancels_sale_id_key
  on public.sales (cancels_sale_id)
  where cancels_sale_id is not null;

-- A row that cancels something must itself be a credit (negative) and must
-- not point at itself.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.sales'::regclass
       and conname  = 'sales_credit_note_shape'
  ) then
    alter table public.sales add constraint sales_credit_note_shape check (
      cancels_sale_id is null
      or (total < 0 and cancels_sale_id <> id)
    );
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- SECTION 2: credit-note numbering
--
-- A separate sequence so credit notes never consume an invoice number. Same
-- formatter as invoices (`031`), prefix swapped: pads to 3, never truncates.
-- -----------------------------------------------------------------------------

create sequence if not exists public.credit_note_seq start 1;
grant usage on sequence public.credit_note_seq to authenticated;

create or replace function public.next_credit_note_number()
returns text
language sql
volatile
as $$
  select 'CN-' || substr(public.format_invoice_number(nextval('public.credit_note_seq')), 5);
$$;

grant execute on function public.next_credit_note_number() to authenticated;
revoke all on function public.next_credit_note_number() from anon, public;

-- -----------------------------------------------------------------------------
-- SECTION 3: payments.kind — the 'credit_note' leg
--
-- `025`'s three branches verbatim, plus one. A credit-note leg always names a
-- sale; it is positive on the invoice and negative on the credit note.
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
        when 'credit_note' then "saleId" is not null and amount <> 0
        else false
      end
) not valid;

-- -----------------------------------------------------------------------------
-- SECTION 4: cancel_invoice
--
-- Payload-free signature so the client cannot supply amounts, items, customer
-- or attribution: all of it is read from the invoice row under a lock.
--
-- Replay: `p_client_key` is stored on the credit note. A resend of the same
-- cancellation (double-tap, retry after a timeout) returns the credit note
-- already made instead of failing. The check runs AFTER the invoice lock, so a
-- concurrent resend waits for the first to commit and then finds it.
-- -----------------------------------------------------------------------------

create or replace function public.cancel_invoice(
  p_sale_id    bigint,
  p_reason     text,
  p_date       date,
  p_client_key uuid
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
  v_items     jsonb;
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
                                  where p.kind = 'credit_note'
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

  if coalesce(v_inv.paid, 0) <> 0
     or exists (select 1 from payments where "saleId" = p_sale_id) then
    raise exception 'cancel_invoice: % has KES % paid on it. Only an unpaid invoice can be cancelled — reverse its payment(s) first.',
      v_inv."invoiceNumber", coalesce(v_inv.paid, 0);
  end if;

  v_date := coalesce(p_date, current_date);
  if v_date < current_date - 1 or v_date > current_date + 1 then
    raise exception 'cancel_invoice: a credit note is dated today (got %)', v_date;
  end if;

  -- The invoice's lines with the quantity (and subtotal, where stored) negated.
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
          auth.uid(), p_client_key, next_credit_note_number(), v_inv.id, v_reason)
  returning * into v_cn;

  -- Settle the pair against each other.
  insert into payments ("saleId", "customerId", date, amount, method, reference, created_by, kind)
  values (v_inv.id, v_inv."customerId", v_date, v_inv.total, null, v_cn."invoiceNumber", auth.uid(), 'credit_note')
  returning * into v_pay_inv;

  insert into payments ("saleId", "customerId", date, amount, method, reference, created_by, kind)
  values (v_cn.id, v_inv."customerId", v_date, -v_inv.total, null, v_inv."invoiceNumber", auth.uid(), 'credit_note')
  returning * into v_pay_cn;

  perform adjust_sale_paid(v_inv.id, v_inv.total);
  perform adjust_sale_paid(v_cn.id, -v_inv.total);

  -- Stock back, exactly as delete_sale returns it.
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
    'payments',    jsonb_build_array(to_jsonb(v_pay_inv), to_jsonb(v_pay_cn)),
    'customer',    v_customer,
    'inventory',   v_inventory
  );
end;
$$;

grant execute on function public.cancel_invoice(bigint, text, date, uuid) to authenticated;
revoke all on function public.cancel_invoice(bigint, text, date, uuid) from anon, public;

-- -----------------------------------------------------------------------------
-- SECTION 5: (intentionally empty — no policy changes)
-- -----------------------------------------------------------------------------

-- -----------------------------------------------------------------------------
-- SECTION 6: permanence triggers
--
-- (a) No payment other than a 'credit_note' leg may be recorded against a
--     credit note or a cancelled invoice. The existing payment functions would
--     already refuse (both read as fully settled), this makes it structural.
-- (b) A 'credit_note' leg cannot be deleted. That also stops `delete_sale` on
--     either half (it deletes the sale's payments first) and
--     `delete_payment` / `delete_payment_batch` on a leg.
-- (c) A credit note cannot be deleted directly. (The cancelled invoice is
--     already protected by the foreign key in section 1.)
-- -----------------------------------------------------------------------------

create or replace function public.guard_credit_note_payment_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
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
  if old.kind = 'credit_note' then
    raise exception 'A cancelled invoice and its credit note are permanent and cannot be deleted.';
  end if;
  return old;
end;
$$;

create or replace function public.guard_credit_note_sale_delete()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.cancels_sale_id is not null then
    raise exception 'A credit note is permanent and cannot be deleted.';
  end if;
  return old;
end;
$$;

revoke all on function public.guard_credit_note_payment_insert() from anon, public;
revoke all on function public.guard_credit_note_payment_delete() from anon, public;
revoke all on function public.guard_credit_note_sale_delete()    from anon, public;

drop trigger if exists payments_credit_note_insert_guard on public.payments;
create trigger payments_credit_note_insert_guard
  before insert on public.payments
  for each row execute function public.guard_credit_note_payment_insert();

drop trigger if exists payments_credit_note_delete_guard on public.payments;
create trigger payments_credit_note_delete_guard
  before delete on public.payments
  for each row execute function public.guard_credit_note_payment_delete();

drop trigger if exists sales_credit_note_delete_guard on public.sales;
create trigger sales_credit_note_delete_guard
  before delete on public.sales
  for each row execute function public.guard_credit_note_sale_delete();

commit;


-- =============================================================================
-- AFTER APPLYING — verify it LANDED, not merely that it ran.
--
-- 0. Pre-flight for check 1 (run first; expect 0). Any row here would make the
--    VALIDATE fail:
--
--      select count(*) from payments
--       where not ("customerId" is not null and case kind
--         when 'invoice' then "saleId" is not null and amount > 0
--         when 'on_account' then "saleId" is null and amount > 0
--         when 'credit_applied' then ("saleId" is not null and amount > 0)
--                                 or ("saleId" is null and amount < 0)
--         when 'credit_note' then "saleId" is not null and amount <> 0
--         else false end);
--
-- 1. Validate the kind constraint (only if check 0 returned 0):
--
--      alter table payments validate constraint payments_kind_shape;
--      select conname, convalidated from pg_constraint
--       where conrelid = 'public.payments'::regclass
--         and conname in ('payments_kind_shape');
--      -- expect: payments_kind_shape | t
--
-- 2. Objects exist, with the right security mode:
--
--      select proname, prosecdef from pg_proc
--       where proname in ('cancel_invoice', 'next_credit_note_number',
--                         'guard_credit_note_payment_insert',
--                         'guard_credit_note_payment_delete',
--                         'guard_credit_note_sale_delete')
--       order by proname;
--      -- expect: cancel_invoice f, guard_* t (x3), next_credit_note_number f
--
--      select tgname from pg_trigger
--       where tgname like '%credit_note%' and not tgisinternal order by tgname;
--      -- expect 3 rows
--
-- 3. Numbering works without consuming an invoice number:
--
--      select last_value from sales_invoice_seq;     -- note it
--      -- (check 5 below cancels one invoice; afterwards the value is unchanged)
--
-- 4. Non-admins are refused. Logged into the APP as a manager, use Cancel on
--    any unpaid invoice — expect "only an admin can cancel an invoice", and
--    nothing changes. (auth.uid() is NULL in the SQL Editor, so the function
--    cannot be exercised from there.)
--
-- 5. End to end, as an admin in the app, on one known duplicate. BEFORE, note:
--      select id, "invoiceNumber", total, paid, status from sales where id = <inv>;
--      select balance from customers where id = <customer>;
--      select data from inventory_state where id = 'finishedGoods';
--    Cancel it in the app. AFTER, expect:
--      select id, "invoiceNumber", total, paid, status, cancels_sale_id
--        from sales where id = <inv> or cancels_sale_id = <inv>;
--      -- invoice: paid = total, status 'paid'
--      -- credit note: CN-###, total = -invoice total, paid = total, status 'paid'
--      select kind, "saleId", amount from payments where kind = 'credit_note';
--      -- two rows: +total on the invoice, -total on the credit note
--      -- customers.balance moved by +invoice total (less owed)
--      -- finishedGoods up by the invoice's cartons, per size
--
-- 6. Permanence, as an admin in the app: Delete on the cancelled invoice and on
--    its credit note must both be refused with nothing changed.
--
-- 7. Balance formula still reconciles for that customer (expect 0 difference):
--
--      select c.balance
--             - ( -coalesce((select sum(total - coalesce(paid,0)) from sales where "customerId" = c.id), 0)
--                 + coalesce((select sum(amount) from payments where "customerId" = c.id and "saleId" is null), 0)
--                 + coalesce((select sum(amount) from customer_adjustments where "customerId" = c.id), 0) )
--             as difference
--        from customers c where c.id = <customer>;
-- =============================================================================

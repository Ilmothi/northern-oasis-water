-- =============================================================================
-- 025_on_account_credit.sql
-- Northern Water Company Ltd — OASIS Springs
--
-- Customers overpay. A lump sum of 50,000 against 48,500 of invoices is not an
-- error to be refused at the counter — the extra 1,500 sits against the next
-- delivery. Today `record_payment` and `024`'s `record_bulk_payment` both reject
-- it, so the clerk either turns money away or invents an invoice to absorb it.
--
-- WHY THIS IS A CHANGE TO THE BALANCE FORMULA
-- -------------------------------------------
-- Since `017`, `customers.balance` is DERIVED:
--
--     balance = -sum(sales.total - sales.paid)
--
-- Money reaches a customer's balance only through `sales.paid`, which is why a
-- payment has always had to name an invoice. Held credit is by definition money
-- that names no invoice, so it cannot reach the balance through that route. The
-- formula gains a second term:
--
--     balance = -sum(sales.total - sales.paid)              -- unchanged
--               + sum(payments.amount where "saleId" is null)  -- new
--
-- For every customer with no unapplied credit the second term is zero and the
-- figure is bit-for-bit what it is today. The blast radius is exactly the set of
-- customers actually holding credit, which is empty until this ships.
--
-- Negative balance still means the customer owes us; positive still means they
-- are in credit. The UI already renders both — the "Total Credits" tile, the
-- CREDIT badge and the customer card's "in credit" line all predate this file.
-- What was missing was a derivation that could produce a credit at all.
--
-- THE THREE KINDS
-- ---------------
--   'invoice'         "saleId" set,  amount > 0.  A normal payment. Every row
--                     written before today, and everything `record_payment`
--                     writes.
--   'on_account'      "saleId" null, amount > 0.  Money received and not yet
--                     attached to an invoice. Adds to the credit pool.
--   'credit_applied'  TWO rows sharing one batch_id, written together by
--                     `apply_credit`:
--                       ("saleId" set,  amount > 0) — settles that invoice
--                       ("saleId" null, amount < 0) — drains the pool
--
-- WHY AN INSERT PAIR AND NOT AN UPDATE
-- ------------------------------------
-- The obvious way to apply held credit is to fill in the credit row's `saleId`.
-- It is also impossible: `payments` has no UPDATE policy. `001` left it out
-- deliberately — payments are immutable and corrections go through delete and
-- re-enter — and `019` reaffirmed it after the missing policy turned out to have
-- silently blocked all payment deletion for a fortnight. Applying credit by
-- inserting a pair keeps that property: every row in `payments` is written once
-- and never edited, so the audit trail stays whole, and one credit can be split
-- across as many invoices as it needs to be.
--
-- TWO PROPERTIES WORTH CHECKING AGAINST THE ARITHMETIC
-- ----------------------------------------------------
-- Customer owes 1,000 on INV-1 and hands over 1,500:
--
--   event                     rows                          balance   cash coll.
--   ----------------------------------------------------------------------------
--   lump sum 1,500            +1000 → INV-1, +500 on-acct    +500       1,500
--   INV-2 raised for 800      —                              -300         —
--   apply the 500 to INV-2    +500 → INV-2, -500 on-acct     -300           0
--
--   * APPLYING CREDIT IS BALANCE-NEUTRAL. It moves money between buckets and
--     never changes what the customer owes. That is the property that makes the
--     "apply" button safe to press.
--   * CASH COLLECTED NETS TO ZERO on the application date, because no money
--     arrived. The two legs cancel, so the report needs no special case to stay
--     correct — the client filters the pair out of the LIST for readability, and
--     that filter provably cannot change the TOTAL.
--
-- NO AUTO-APPLICATION, DELIBERATELY
-- ---------------------------------
-- Held credit is not applied automatically when the next sale is recorded. It
-- could be — `record_sale` could look for a pool and drain it — but that makes a
-- money write a side effect of a different money write, and hands a clerk a
-- settled invoice when they entered an unpaid one. The balance is already
-- correct either way (held credit nets against new debt whether or not it has
-- been applied), so auto-application would buy tidiness on the invoice, not
-- correctness on the books. The client prompts instead.
--
-- REFUNDS ARE NOT MODELLED
-- ------------------------
-- Overpayment always sits against the next invoice; it is never handed back in
-- cash. So there is no 'refund' kind. Adding one later is a constraint swap with
-- no data migration — unlike adding the `kind` column itself, which is why the
-- column goes in now rather than when a fourth case turns up.
--
-- ORDERING — MIGRATION FIRST, THEN THE CLIENT. Apply `024` before this.
-- Idempotent — safe to re-run.
-- =============================================================================
--
-- PRE-FLIGHT — RUN THIS FIRST, IT IS READ-ONLY
-- --------------------------------------------
-- Section 2 adds a shape constraint. It is added NOT VALID so that applying this
-- file cannot fail on historical data, but you should know what is in there:
--
--   select count(*) filter (where "saleId" is null)      as no_invoice,
--          count(*) filter (where amount <= 0)           as not_positive,
--          count(*) filter (where "customerId" is null)  as no_customer
--     from payments;
--
-- All three should be 0. If they are, validate the constraint after applying —
-- the statement is in the verification block at the foot. If any is not, do NOT
-- validate; work out what those rows are first.
-- =============================================================================

begin;


-- =============================================================================
-- SECTION 1: payments.kind and a nullable "saleId"
--
-- `add column ... default` fills every existing row with 'invoice', which is
-- what they all are. NOT NULL is therefore safe in the same statement.
--
-- Dropping NOT NULL from "saleId" is guarded: `alter column ... drop not null`
-- is not idempotent-by-syntax, so it is conditioned on the catalog.
-- =============================================================================

alter table payments
  add column if not exists kind text not null default 'invoice';

comment on column payments.kind is
  'invoice = a normal payment against an invoice; on_account = money received '
  'and not yet applied to one; credit_applied = one leg of an application of '
  'held credit (two rows share a batch_id). See 025_on_account_credit.sql.';

do $$
begin
  if exists (
    select 1 from pg_attribute
     where attrelid = 'public.payments'::regclass
       and attname  = 'saleId'
       and attnotnull
  ) then
    alter table payments alter column "saleId" drop not null;
  end if;
end $$;


-- =============================================================================
-- SECTION 2: the shape constraint
--
-- One constraint rather than three, because the three kinds are three different
-- shapes and the interesting rule is the relationship between `kind`, `saleId`
-- and the SIGN of `amount`. Nothing but a credit application may be negative,
-- which is what stops a stray negative row quietly deflating Cash Collected.
--
-- NOT VALID: new and updated rows are checked from the moment this commits;
-- existing rows are not re-read. That is the point — this is a live money table
-- and a failed ALTER on it is not an acceptable outcome of applying a migration.
-- Validate it by hand afterwards, after the pre-flight query above comes back
-- clean. See the verification block.
-- =============================================================================

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.payments'::regclass
       and conname  = 'payments_kind_shape'
  ) then
    alter table payments add constraint payments_kind_shape check (
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
  end if;
end $$;


-- =============================================================================
-- SECTION 3: payments_insert — allow a row with no invoice
--
-- `017` section 7's policy, with one change: the sale/customer agreement check
-- now applies only to rows that name a sale. Everything else is untouched —
-- `created_by = auth.uid()`, the role gate, and the sales-role location scope
-- all still hold, and an on-account row is still scoped to a customer the
-- caller may write to.
--
-- Note what is NOT relaxed: a row with no `saleId` still needs a `customerId`
-- the caller can reach. Unattributed money cannot be inserted.
-- =============================================================================

drop policy if exists "payments_insert" on payments;
create policy "payments_insert"
  on payments for insert
  with check (
    created_by = auth.uid()
    and (
      payments."saleId" is null
      or exists (
        select 1 from sales s
        where s.id = payments."saleId"
          and s."customerId" = payments."customerId"
      )
    )
    and (
      get_my_role() in ('admin', 'manager')
      or (
        get_my_role() = 'sales'
        and (
          (
            get_my_location() is not null
            and exists (
              select 1 from customers c
              where c.id = payments."customerId"
                and c.location = get_my_location()
            )
          )
          or get_my_location() is null   -- own records only, via created_by above
        )
      )
    )
  );


-- =============================================================================
-- SECTION 4: recompute_customer_balance — the second term, and the pool guard
--
-- `017` section 1's function with two additions. Everything else — the role
-- gate, the `coalesce(get_my_role(), '')` that stops a caller with no profiles
-- row falling through it (finding 14), the row lock taken before the sum, the
-- sales-role location check — is verbatim from `017`.
--
-- THE GUARD IS HERE ON PURPOSE. The credit pool must never go negative: that
-- would mean more credit has been applied than was ever received. Rather than
-- write that assertion into each of the four delete paths and hope none is
-- forgotten, it lives in the one function every money path already calls after
-- writing. It is DEFINER, so its sum sees every row regardless of what RLS shows
-- the caller — an assertion that could be fooled by row visibility would be
-- worse than none.
--
-- Raising here aborts the whole transaction, which is exactly the intent: the
-- delete that would have stranded the credit is rolled back.
-- =============================================================================

create or replace function recompute_customer_balance(p_customer_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role     text;
  v_location text;
  v_sales    numeric;
  v_credit   numeric;
  result     jsonb;
begin
  if p_customer_id is null then
    raise exception 'recompute_customer_balance: customer id is required';
  end if;

  v_role := coalesce(get_my_role(), '');
  if v_role is distinct from 'admin'
     and v_role is distinct from 'manager'
     and v_role is distinct from 'sales' then
    raise exception 'recompute_customer_balance: not permitted';
  end if;

  perform 1 from customers where id = p_customer_id for update;
  if not found then
    return null;
  end if;

  if v_role = 'sales' then
    v_location := get_my_location();
    if v_location is not null
       and (select location from customers where id = p_customer_id)
           is distinct from v_location then
      raise exception 'recompute_customer_balance: customer % is outside your location', p_customer_id;
    end if;
  end if;

  select -coalesce(sum(s.total - coalesce(s.paid, 0)), 0)
    into v_sales
    from sales s
   where s."customerId" = p_customer_id;

  -- Unapplied credit: every payment row that names no invoice. On-account
  -- receipts are positive, the draining leg of an application is negative, so
  -- the sum is what is still held.
  select coalesce(sum(p.amount), 0)
    into v_credit
    from payments p
   where p."customerId" = p_customer_id
     and p."saleId" is null;

  if v_credit < 0 then
    raise exception 'recompute_customer_balance: this would leave customer % holding % in credit, which is impossible. A credit application is two rows and cannot be unpicked one at a time — reverse the whole receipt instead.',
      p_customer_id, v_credit;
  end if;

  update customers set balance = v_sales + v_credit where id = p_customer_id;

  select to_jsonb(c) into result from customers c where c.id = p_customer_id;
  return result;
end;
$$;


-- =============================================================================
-- SECTION 5: record_bulk_payment — the remainder becomes credit
--
-- `024` section 3's function with a `credit` field. Two changes only:
--
--   * an optional "credit" amount, written as a single 'on_account' row in the
--     same batch and therefore the same transaction as the allocations;
--   * allocations may now be EMPTY when there is a credit, which is the customer
--     who pays before anything has been invoiced to them.
--
-- The per-invoice over-payment guard is unchanged and still refuses to push any
-- single invoice past its outstanding balance. The remainder is not a way around
-- that check — it is what is left after it.
--
-- The client sends `credit` explicitly rather than the server inferring it from
-- a total, so that money can never become a credit balance because an amount was
-- mistyped. The clerk confirms the remainder on screen before it is sent.
-- =============================================================================

create or replace function record_bulk_payment(p_batch jsonb)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_customer_id bigint;
  v_batch_id    uuid;
  v_date        date;
  v_method      text;
  v_reference   text;
  v_allocs      jsonb;
  v_alloc       jsonb;
  v_credit      numeric;
  v_sale_id     bigint;
  v_amount      numeric;
  v_sale        sales;
  v_outstanding numeric;
  v_result      jsonb;
begin
  v_customer_id := (p_batch ->> 'customerId')::bigint;
  v_batch_id    := nullif(p_batch ->> 'batch_id', '')::uuid;
  v_date        := coalesce((p_batch ->> 'date')::date, current_date);
  v_method      := nullif(p_batch ->> 'method', '');
  v_reference   := nullif(p_batch ->> 'reference', '');
  v_allocs      := coalesce(p_batch -> 'allocations', '[]'::jsonb);
  v_credit      := coalesce((p_batch ->> 'credit')::numeric, 0);

  if v_batch_id is not null
     and exists (select 1 from payments where batch_id = v_batch_id) then
    return payment_batch(v_batch_id) || jsonb_build_object('replayed', true);
  end if;

  if v_customer_id is null then
    raise exception 'record_bulk_payment: customerId is required';
  end if;
  if v_batch_id is null then
    raise exception 'record_bulk_payment: batch_id is required';
  end if;
  if jsonb_typeof(v_allocs) <> 'array' then
    raise exception 'record_bulk_payment: allocations must be an array';
  end if;
  if v_credit < 0 then
    raise exception 'record_bulk_payment: the amount held as credit cannot be negative';
  end if;
  if jsonb_array_length(v_allocs) = 0 and v_credit = 0 then
    raise exception 'record_bulk_payment: this receipt allocates nothing and holds nothing';
  end if;

  if (
    select count(*) <> count(distinct (a ->> 'saleId'))
      from jsonb_array_elements(v_allocs) a
  ) then
    raise exception 'record_bulk_payment: the same invoice appears more than once in this receipt';
  end if;

  if exists (
    select 1 from jsonb_array_elements(v_allocs) a
     where (a ->> 'saleId') is null
        or (a ->> 'amount') is null
        or (a ->> 'amount')::numeric <= 0
  ) then
    raise exception 'record_bulk_payment: every allocation needs an invoice and an amount greater than zero';
  end if;

  perform 1
     from sales
    where id in (
      select (a ->> 'saleId')::bigint from jsonb_array_elements(v_allocs) a
    )
    order by id
      for update;

  begin
    for v_alloc in select * from jsonb_array_elements(v_allocs) loop
      v_sale_id := (v_alloc ->> 'saleId')::bigint;
      v_amount  := (v_alloc ->> 'amount')::numeric;

      select * into v_sale from sales where id = v_sale_id;
      if not found then
        raise exception 'record_bulk_payment: sale % not found', v_sale_id;
      end if;

      if v_sale."customerId" is distinct from v_customer_id then
        raise exception 'record_bulk_payment: sale % does not belong to customer %',
          v_sale_id, v_customer_id;
      end if;

      v_outstanding := v_sale.total - coalesce(v_sale.paid, 0);
      if v_amount > v_outstanding then
        raise exception 'record_bulk_payment: % allocated to invoice % exceeds its outstanding balance of %',
          v_amount, coalesce(v_sale."invoiceNumber", v_sale_id::text), v_outstanding;
      end if;

      insert into payments
        ("saleId", "customerId", date, amount, method, reference, created_by,
         client_key, batch_id, kind)
      values (
        v_sale_id, v_customer_id, v_date, v_amount, v_method, v_reference,
        auth.uid(),
        nullif(v_alloc ->> 'client_key', '')::uuid,
        v_batch_id,
        'invoice'
      );

      perform adjust_sale_paid(v_sale_id, v_amount);
    end loop;

    -- The remainder. One row, no invoice, same receipt.
    if v_credit > 0 then
      insert into payments
        ("saleId", "customerId", date, amount, method, reference, created_by,
         client_key, batch_id, kind)
      values (
        null, v_customer_id, v_date, v_credit, v_method, v_reference,
        auth.uid(),
        nullif(p_batch ->> 'credit_client_key', '')::uuid,
        v_batch_id,
        'on_account'
      );
    end if;
  exception when unique_violation then
    return payment_batch(v_batch_id) || jsonb_build_object('replayed', true);
  end;

  perform recompute_customer_balance(v_customer_id);

  v_result := payment_batch(v_batch_id);
  if v_result -> 'payments' = '[]'::jsonb then
    raise exception 'record_bulk_payment: nothing was recorded for this receipt';
  end if;

  return v_result;
end;
$$;


-- =============================================================================
-- SECTION 6: apply_credit
--
-- Payload:
--
--   {
--     "customerId": 12,
--     "saleId":     104,
--     "amount":     500,
--     "date":       "2026-08-21",          -- optional, defaults to today
--     "batch_id":            "<uuid>",
--     "client_key_invoice":  "<uuid>",
--     "client_key_credit":   "<uuid>"
--   }
--
-- Writes the two legs and settles the invoice. No `method` and no `reference`:
-- no money changed hands, and labelling this "cash" or "M-Pesa" on a statement
-- would be a lie about where it came from.
--
-- LOCK ORDER: the sale, then the customer — the order every money function in
-- this schema takes them in, and the reason a credit application and a lump sum
-- for the same customer serialise instead of deadlocking. The pool is summed
-- under the customer lock, which is what stops two clerks spending one credit.
-- =============================================================================

create or replace function apply_credit(p_apply jsonb)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_customer_id bigint;
  v_sale_id     bigint;
  v_amount      numeric;
  v_date        date;
  v_batch_id    uuid;
  v_sale        sales;
  v_available   numeric;
  v_outstanding numeric;
begin
  v_customer_id := (p_apply ->> 'customerId')::bigint;
  v_sale_id     := (p_apply ->> 'saleId')::bigint;
  v_amount      := (p_apply ->> 'amount')::numeric;
  v_date        := coalesce((p_apply ->> 'date')::date, current_date);
  v_batch_id    := nullif(p_apply ->> 'batch_id', '')::uuid;

  if v_batch_id is not null
     and exists (select 1 from payments where batch_id = v_batch_id) then
    return payment_batch(v_batch_id) || jsonb_build_object('replayed', true);
  end if;

  if v_customer_id is null or v_sale_id is null or v_amount is null then
    raise exception 'apply_credit: customerId, saleId and amount are required';
  end if;
  if v_batch_id is null then
    raise exception 'apply_credit: batch_id is required';
  end if;
  if v_amount <= 0 then
    raise exception 'apply_credit: amount must be greater than zero';
  end if;

  -- LOCK ORDER: the sale first, then the customer. Every money function in this
  -- schema takes them in that order — `record_payment` and `record_bulk_payment`
  -- lock sales and reach `customers` through `recompute_customer_balance`, and
  -- `delete_sale` does the same. Taking them the other way round here would let
  -- a credit application and a lump sum for one customer deadlock.
  select * into v_sale from sales where id = v_sale_id for update;
  if not found then
    raise exception 'apply_credit: sale % not found', v_sale_id;
  end if;
  if v_sale."customerId" is distinct from v_customer_id then
    raise exception 'apply_credit: sale % does not belong to customer %',
      v_sale_id, v_customer_id;
  end if;

  v_outstanding := v_sale.total - coalesce(v_sale.paid, 0);
  if v_amount > v_outstanding then
    raise exception 'apply_credit: % is more than the % still outstanding on invoice %',
      v_amount, v_outstanding, coalesce(v_sale."invoiceNumber", v_sale_id::text);
  end if;

  perform 1 from customers where id = v_customer_id for update;
  if not found then
    raise exception 'apply_credit: customer % not found', v_customer_id;
  end if;

  -- Summed under the customer lock taken immediately above, so two clerks cannot
  -- each spend the same credit. RLS governs this read (INVOKER) — a caller who
  -- cannot see the customer's payments sees no credit and is refused, which is
  -- the safe direction to fail.
  select coalesce(sum(p.amount), 0)
    into v_available
    from payments p
   where p."customerId" = v_customer_id
     and p."saleId" is null;

  if v_amount > v_available then
    raise exception 'apply_credit: % is more than the % this customer holds in credit',
      v_amount, v_available;
  end if;

  begin
    -- Leg 1: settles the invoice.
    insert into payments
      ("saleId", "customerId", date, amount, method, reference, created_by,
       client_key, batch_id, kind)
    values (
      v_sale_id, v_customer_id, v_date, v_amount, null, null, auth.uid(),
      nullif(p_apply ->> 'client_key_invoice', '')::uuid,
      v_batch_id, 'credit_applied'
    );

    -- Leg 2: drains the pool by the same amount, so the balance does not move.
    insert into payments
      ("saleId", "customerId", date, amount, method, reference, created_by,
       client_key, batch_id, kind)
    values (
      null, v_customer_id, v_date, -v_amount, null, null, auth.uid(),
      nullif(p_apply ->> 'client_key_credit', '')::uuid,
      v_batch_id, 'credit_applied'
    );

    perform adjust_sale_paid(v_sale_id, v_amount);
  exception when unique_violation then
    return payment_batch(v_batch_id) || jsonb_build_object('replayed', true);
  end;

  perform recompute_customer_balance(v_customer_id);

  return payment_batch(v_batch_id);
end;
$$;


-- =============================================================================
-- SECTION 7: delete_payment — refuse to unpick half a credit application
--
-- `019` section 4's function, with one guard added at the top.
--
-- A credit application is two rows. Deleting the positive leg alone would leave
-- the negative one behind and the pool short — section 4's assertion catches
-- that and aborts. Deleting the NEGATIVE leg alone would leave the pool
-- inflated by credit that was already spent, and no assertion can catch that,
-- because the resulting figure is perfectly plausible.
--
-- So neither leg may be deleted on its own. Reverse the receipt instead, which
-- takes both legs and reverses the invoice in one transaction.
-- =============================================================================

create or replace function delete_payment(p_payment_id bigint)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_payment   payments;
  v_sale_json jsonb;
  v_customer  jsonb;
begin
  -- No FOR UPDATE: payments has no UPDATE policy, so locking here would match
  -- zero rows for every role. See 019, section 2.
  select * into v_payment from payments where id = p_payment_id;
  if not found then
    raise exception 'delete_payment: payment % not found', p_payment_id;
  end if;

  if v_payment.kind = 'credit_applied' then
    raise exception 'delete_payment: payment % is one half of a credit application and cannot be removed on its own. Reverse the whole receipt instead.',
      p_payment_id;
  end if;

  delete from payments where id = p_payment_id
  returning * into v_payment;
  if not found then
    raise exception 'delete_payment: not permitted to delete payment %', p_payment_id;
  end if;

  if v_payment."saleId" is not null then
    v_sale_json := adjust_sale_paid(v_payment."saleId", -v_payment.amount);
  end if;

  -- Raises if this delete would strand spent credit — see section 4.
  v_customer := recompute_customer_balance(v_payment."customerId");

  return jsonb_build_object(
    'sale',     v_sale_json,
    'customer', v_customer
  );
end;
$$;


-- =============================================================================
-- SECTION 8: delete_sale — take the paired credit leg with it
--
-- `017`'s function, with one delete added before the existing one.
--
-- `delete from payments where "saleId" = p_sale_id` would take the positive leg
-- of a credit application and leave its negative twin behind, stranding the
-- pool. Deleting by BATCH first removes both legs together. The credit returns
-- to the pool, which is right: the invoice it was spent on no longer exists.
--
-- Ordinary lump-sum receipts are unaffected. Their allocations are independent
-- of each other, so deleting one invoice reverses that allocation and leaves the
-- rest of the receipt standing.
-- =============================================================================

create or replace function delete_sale(p_sale_id bigint)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_sale      sales;
  v_count     int;
  v_changes   jsonb;
  v_inventory jsonb;
  v_customer  jsonb;
begin
  select * into v_sale from sales where id = p_sale_id for update;
  if not found then
    raise exception 'delete_sale: sale % not found', p_sale_id;
  end if;

  if exists (select 1 from consignment_movements where sale_id = p_sale_id) then
    raise exception 'delete_sale: sale % is linked to consignment stock and must be reversed from the Consignment view', p_sale_id;
  end if;

  -- Both legs of any credit applied to this invoice, before the line below
  -- could take only the half that names the sale.
  delete from payments
   where batch_id in (
     select batch_id from payments
      where "saleId" = p_sale_id
        and kind = 'credit_applied'
        and batch_id is not null
   );

  delete from payments where "saleId" = p_sale_id;

  delete from sales where id = p_sale_id;
  get diagnostics v_count = row_count;
  if v_count = 0 then
    raise exception 'delete_sale: not permitted to delete sale %', p_sale_id;
  end if;

  v_changes := fg_delta_changes(v_sale.items, 1);
  if jsonb_array_length(v_changes) > 0 then
    v_inventory := apply_inventory_deltas(v_changes);
  end if;

  v_customer := recompute_customer_balance(v_sale."customerId");

  return jsonb_build_object(
    'customer',  v_customer,
    'inventory', v_inventory
  );
end;
$$;


-- =============================================================================
-- SECTION 9: grants
-- =============================================================================

grant execute on function apply_credit(jsonb) to authenticated;
revoke all on function apply_credit(jsonb) from anon, public;


commit;


-- =============================================================================
-- AFTER APPLYING — verify the change LANDED, not merely that it ran.
--
-- 1. VALIDATE THE CONSTRAINT, but only if the pre-flight query at the head of
--    this file came back all zeros:
--
--      alter table payments validate constraint payments_kind_shape;
--
--    Then confirm it is both present and valid:
--
--      select conname, convalidated from pg_constraint
--       where conrelid = 'public.payments'::regclass
--         and conname = 'payments_kind_shape';
--      -- expect: payments_kind_shape | t
--
-- 2. The column landed and every historical row is 'invoice':
--
--      select kind, count(*) from payments group by kind order by kind;
--      -- expect a single row: invoice | <all of them>
--
--      select is_nullable from information_schema.columns
--       where table_schema = 'public' and table_name = 'payments'
--         and column_name = 'saleId';
--      -- expect: YES
--
-- 3. The functions are all still SECURITY INVOKER except the one that must not
--    be. This is the check `010` failed for two months:
--
--      select proname, prosecdef from pg_proc
--       where proname in ('apply_credit', 'record_bulk_payment', 'delete_payment',
--                         'delete_sale', 'recompute_customer_balance')
--       order by proname;
--      -- expect: apply_credit               | f
--      --         delete_payment             | f
--      --         delete_sale                | f
--      --         record_bulk_payment        | f
--      --         recompute_customer_balance | t
--
-- 4. THE BALANCE FORMULA DID NOT MOVE FOR ANYONE. Nobody holds credit yet, so
--    every balance must be exactly what it was. This must return no rows:
--
--      select c.id, c.name, c.balance,
--             -coalesce((select sum(s.total - coalesce(s.paid,0))
--                          from sales s where s."customerId" = c.id), 0) as from_sales
--        from customers c
--       where c.balance is distinct from
--             -coalesce((select sum(s.total - coalesce(s.paid,0))
--                          from sales s where s."customerId" = c.id), 0);
--
--    Keep this query. After credit is in use it stops being an equality — the
--    difference for each customer must then equal their unapplied credit:
--
--      select c.id, c.name, c.balance,
--             coalesce((select sum(p.amount) from payments p
--                        where p."customerId" = c.id and p."saleId" is null), 0) as credit
--        from customers c
--       where c.balance is distinct from
--             -coalesce((select sum(s.total - coalesce(s.paid,0))
--                          from sales s where s."customerId" = c.id), 0)
--           + coalesce((select sum(p.amount) from payments p
--                        where p."customerId" = c.id and p."saleId" is null), 0);
--      -- must always return no rows
--
-- 5. NOBODY'S CREDIT IS NEGATIVE. Must return no rows, now and forever:
--
--      select "customerId", sum(amount) from payments
--       where "saleId" is null group by "customerId" having sum(amount) < 0;
--
-- 6. BEHAVIOUR — as admin, against a real customer with an outstanding invoice.
--
--    a. Overpay deliberately through the app and confirm the split:
--         select kind, "saleId", amount from payments where batch_id = '<uuid>';
--       -- expect the invoice legs plus ONE on_account row for the remainder
--
--    b. The balance went positive by the remainder:
--         select balance from customers where id = <id>;
--
--    c. Apply it to a new invoice and confirm the balance DID NOT MOVE. This is
--       the property that matters most — note the balance before and after:
--         select apply_credit('{...}'::jsonb);
--         select balance from customers where id = <id>;   -- unchanged
--
--    d. Cash Collected for that date nets to zero across the pair:
--         select sum(amount) from payments where batch_id = '<apply uuid>';
--       -- expect: 0
--
--    e. Half an application cannot be removed:
--         select delete_payment(<id of either leg>);
--       -- expect: ERROR  … one half of a credit application …
--
--    f. Spending credit twice is refused. With 500 held, apply 500, then try to
--       apply 500 again:
--       -- expect: ERROR  apply_credit: 500 is more than the 0 this customer
--       --         holds in credit
-- =============================================================================

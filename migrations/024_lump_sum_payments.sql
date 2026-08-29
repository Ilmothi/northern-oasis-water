-- =============================================================================
-- 024_lump_sum_payments.sql
-- Northern Water Company Ltd — OASIS Springs
--
-- Customers settle several invoices with one payment — one M-Pesa transfer, one
-- cheque, one handful of cash against four deliveries. The system has no way to
-- record that. `record_payment` takes exactly one `saleId`, so the clerk has to
-- enter the receipt as N separate payments.
--
-- WHAT IS WRONG WITH ENTERING IT AS N PAYMENTS
-- --------------------------------------------
--   1. NOT ATOMIC. Four invoices, four round trips, four independent chances to
--      fail. Three landing and the fourth not is a customer whose books say they
--      still owe money they have already handed over, with nothing on screen to
--      say so. This is the same partial-completion class of bug `011` removed
--      from the single-payment path, reintroduced by the workflow.
--   2. NO RECEIPT. One M-Pesa reference typed into four rows is the only thing
--      tying them together, and only if the clerk types it four times
--      identically. There is no object in the schema that means "this receipt".
--   3. THE ARITHMETIC IS THE CLERK'S PROBLEM. Splitting 48,000 across four
--      invoices by hand, at a counter, is where transposition errors come from.
--
-- WHAT THIS ADDS
-- --------------
--   * `payments.batch_id` — nullable. Rows sharing one are one receipt.
--   * `record_bulk_payment(jsonb)` — one call, one transaction, N invoices.
--   * `delete_payment_batch(uuid)` — reverses a whole receipt, admin-only via
--     the existing `payments_delete` policy.
--
-- Every payment row still names a `saleId`, so nothing downstream changes shape:
-- Cash Collected, the statement, the customer ledger, the Debtors report and
-- `payments_insert`'s sale/customer agreement check all keep working untouched.
-- That is the whole point of doing it this way round.
--
-- WHAT THIS DELIBERATELY DOES NOT DO — OVERPAYMENT
-- ------------------------------------------------
-- A batch whose total exceeds what the customer owes is REFUSED here, invoice by
-- invoice, by the same guard `record_payment` has always applied. Holding the
-- remainder as credit needs `customers.balance` to stop being derived from
-- `sales` alone, which is a change to the balance formula itself and belongs in
-- its own reviewable file. That is `025_on_account_credit.sql`, and it rewrites
-- `record_bulk_payment` to add the remainder branch.
--
-- Applying 024 without 025 is a coherent, shippable state: lump sums that settle
-- exactly work, overpayment keeps failing exactly as it does today.
--
-- AUTHORISATION — SECURITY INVOKER, like every function in `011`
-- -------------------------------------------------------------
-- Both functions run as the caller, so `payments_insert`, `payments_delete` and
-- the `sales` UPDATE policies still police every row. No authorisation moves
-- into application code. As in `011`, every UPDATE/DELETE checks `row_count` and
-- raises, because RLS refuses by matching zero rows rather than by erroring.
--
-- One deliberate difference from `record_payment`: `created_by` is stamped from
-- `auth.uid()` here rather than read from the payload. `payments_insert` already
-- requires the two to be equal, so the payload value can only ever be redundant
-- or wrong. This is what `019` did for `record_sale`; `record_payment` was left
-- alone at the time because it was working in production, and this file does not
-- revisit it.
--
-- ORDERING — MIGRATION FIRST, THEN THE CLIENT
-- -------------------------------------------
-- The client in this PR calls both functions. Applying the migration first is
-- safe (nothing existing changes behaviour); deploying the client first is NOT.
--
-- Idempotent — safe to re-run.
-- =============================================================================

begin;


-- =============================================================================
-- SECTION 1: payments.batch_id
--
-- Nullable, no default, no backfill. NULL means "this payment was recorded on
-- its own", which is every row written before today and every write from
-- `record_payment`, which is untouched and keeps writing NULL.
--
-- NOT unique — sharing the value is the entire point. The index is for the
-- lookups in sections 2-4, which fetch a receipt by its id, and it is partial so
-- it does not carry an entry for every historical row.
-- =============================================================================

alter table payments add column if not exists batch_id uuid;

comment on column payments.batch_id is
  'Groups the payment rows that came from one lump-sum receipt — one transfer, '
  'one cheque, one handful of cash — across several invoices. NULL for a payment '
  'recorded on its own. See 024_lump_sum_payments.sql.';

create index if not exists payments_batch_id_idx
  on payments (batch_id) where batch_id is not null;


-- =============================================================================
-- SECTION 2: payment_batch — the shared response builder
--
-- Three callers need "everything the client must refresh after this receipt
-- moved": the replay fast path, the unique_violation recovery, and the delete.
-- One definition so they cannot drift apart, which is the same reason `011`
-- gave `sale_status` its own function.
--
-- SECURITY INVOKER and read-only. A caller who cannot see the payments gets an
-- empty array, exactly as a direct select would give them.
-- =============================================================================

create or replace function payment_batch(p_batch_id uuid)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'payments', coalesce((
      select jsonb_agg(to_jsonb(p) order by p.id)
        from payments p
       where p.batch_id = p_batch_id
    ), '[]'::jsonb),
    'sales', coalesce((
      select jsonb_agg(to_jsonb(s) order by s.id)
        from sales s
       where s.id in (
         select p."saleId" from payments p
          where p.batch_id = p_batch_id and p."saleId" is not null
       )
    ), '[]'::jsonb),
    'customer', (
      select to_jsonb(c)
        from customers c
       where c.id = (
         select min(p."customerId") from payments p where p.batch_id = p_batch_id
       )
    )
  );
$$;


-- =============================================================================
-- SECTION 3: record_bulk_payment
--
-- Payload:
--
--   {
--     "customerId": 12,
--     "date":       "2026-08-21",        -- optional, defaults to today
--     "method":     "mpesa",
--     "reference":  "QGH7XY1234",
--     "batch_id":   "<uuid>",
--     "allocations": [
--       { "saleId": 101, "amount": 1000, "client_key": "<uuid>" },
--       { "saleId": 104, "amount":  500, "client_key": "<uuid>" }
--     ]
--   }
--
-- IDEMPOTENCY — TWO LAYERS, BOTH FROM `021`
-- -----------------------------------------
-- `batch_id` is the fast path: seen before, return what was recorded. But that
-- is a read followed by a write, so two concurrent sends of the same receipt can
-- both pass it. The enforcement is `021`'s partial unique index on
-- `payments.client_key` — every allocation carries its own key, generated once
-- when the form opens, so a resend carries the same keys and the second inserter
-- gets `unique_violation`. That is caught and converted into the same replay
-- response, exactly as the three `record_*` functions do.
--
-- The rollback that `exception` performs is why the insert loop and the
-- `adjust_sale_paid` calls are inside the block together: a losing racer must
-- undo its partial work before returning the winner's rows.
--
-- LOCK ORDER
-- ----------
-- The sales are locked in a single statement ordered by id, before any of them
-- is touched. Two clerks posting overlapping receipts for the same customer
-- therefore take the rows in the same order and serialise; taking them in
-- payload order would let them deadlock.
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

  -- Replay fast path. Any row carrying this batch means the whole receipt
  -- committed — it is one transaction, so there is no half-recorded batch.
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
  if jsonb_typeof(v_allocs) <> 'array' or jsonb_array_length(v_allocs) = 0 then
    raise exception 'record_bulk_payment: at least one allocation is required';
  end if;

  -- Each invoice may appear once. Twice would pass every per-row check below
  -- and still overpay the invoice, because the second check would run against
  -- the outstanding figure the first one had already reduced.
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

  -- Lock every invoice in the receipt, in id order, before touching any of them.
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

      -- The client derives the customer from the sales it lists, but a payload
      -- can say anything. `payments_insert` enforces this too; checking here
      -- turns a policy refusal into an error that names the problem.
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
        ("saleId", "customerId", date, amount, method, reference, created_by, client_key, batch_id)
      values (
        v_sale_id,
        v_customer_id,
        v_date,
        v_amount,
        v_method,
        v_reference,
        auth.uid(),
        nullif(v_alloc ->> 'client_key', '')::uuid,
        v_batch_id
      );

      -- Must run before the balance is derived from it.
      perform adjust_sale_paid(v_sale_id, v_amount);
    end loop;
  exception when unique_violation then
    -- A concurrent send of this same receipt won. Everything above is rolled
    -- back to the start of this block; return the rows that did commit.
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
-- SECTION 4: delete_payment_batch
--
-- Reverses a whole receipt. Admin-only, because that is what `payments_delete`
-- says (`001` section 5) — there is no role check in here, deliberately: the
-- policy is the boundary and this function is INVOKER so the policy applies.
--
-- No `FOR UPDATE` on the payments, for the reason `019` section 2 documents at
-- length: `payments` has no UPDATE policy, so locking would match zero rows for
-- every role including admin. The DELETE takes its own lock.
--
-- The row-count check is what turns an RLS refusal into an error. Without it a
-- manager calling this would silently delete nothing and get a success back.
-- =============================================================================

create or replace function delete_payment_batch(p_batch_id uuid)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_expected int;
  v_deleted  jsonb;
  v_row      jsonb;
  v_customer bigint;
begin
  if p_batch_id is null then
    raise exception 'delete_payment_batch: batch id is required';
  end if;

  select count(*) into v_expected from payments where batch_id = p_batch_id;
  if v_expected = 0 then
    raise exception 'delete_payment_batch: receipt % not found', p_batch_id;
  end if;

  with deleted as (
    delete from payments where batch_id = p_batch_id returning *
  )
  select jsonb_agg(to_jsonb(d)) into v_deleted from deleted;

  if v_deleted is null or jsonb_array_length(v_deleted) <> v_expected then
    raise exception 'delete_payment_batch: not permitted to delete receipt %', p_batch_id;
  end if;

  for v_row in select * from jsonb_array_elements(v_deleted) loop
    if (v_row ->> 'saleId') is not null then
      perform adjust_sale_paid(
        (v_row ->> 'saleId')::bigint,
        -((v_row ->> 'amount')::numeric)
      );
    end if;
  end loop;

  -- One receipt is one customer by construction, but derive it from the rows
  -- rather than assuming, and recompute after every sale has moved.
  for v_customer in
    select distinct (r ->> 'customerId')::bigint
      from jsonb_array_elements(v_deleted) r
     where (r ->> 'customerId') is not null
  loop
    perform recompute_customer_balance(v_customer);
  end loop;

  return jsonb_build_object(
    'deleted', v_deleted,
    'sales', coalesce((
      select jsonb_agg(to_jsonb(s) order by s.id)
        from sales s
       where s.id in (
         select (r ->> 'saleId')::bigint
           from jsonb_array_elements(v_deleted) r
          where (r ->> 'saleId') is not null
       )
    ), '[]'::jsonb),
    'customers', coalesce((
      select jsonb_agg(to_jsonb(c) order by c.id)
        from customers c
       where c.id in (
         select (r ->> 'customerId')::bigint
           from jsonb_array_elements(v_deleted) r
          where (r ->> 'customerId') is not null
       )
    ), '[]'::jsonb)
  );
end;
$$;


-- =============================================================================
-- SECTION 5: grants
--
-- Same shape as `011` section 7: `authenticated` only, never `anon` or `public`.
-- Who may actually record or delete what is decided by RLS, not by these grants.
-- =============================================================================

grant execute on function payment_batch(uuid)          to authenticated;
grant execute on function record_bulk_payment(jsonb)   to authenticated;
grant execute on function delete_payment_batch(uuid)   to authenticated;

revoke all on function payment_batch(uuid)         from anon, public;
revoke all on function record_bulk_payment(jsonb)  from anon, public;
revoke all on function delete_payment_batch(uuid)  from anon, public;


commit;


-- =============================================================================
-- AFTER APPLYING — verify the change LANDED, not merely that it ran.
-- "Success. No rows returned" is what a block of comments returns too, and
-- `010` was recorded as applied for two months while half of it was not.
--
-- 1. The column and its index exist:
--
--      select column_name, data_type, is_nullable
--        from information_schema.columns
--       where table_schema = 'public' and table_name = 'payments'
--         and column_name = 'batch_id';
--      -- expect: batch_id | uuid | YES
--
--      select indexdef from pg_indexes
--       where schemaname = 'public' and indexname = 'payments_batch_id_idx';
--      -- expect a partial index: ... WHERE (batch_id IS NOT NULL)
--
-- 2. All three functions exist and are INVOKER (`prosecdef = f`) and pinned.
--    `recompute_customer_balance` is the control — it must still be `t`, which
--    proves you are looking at the right database:
--
--      select proname, prosecdef, proconfig
--        from pg_proc
--       where proname in ('payment_batch', 'record_bulk_payment',
--                         'delete_payment_batch', 'recompute_customer_balance')
--       order by proname;
--      -- expect: delete_payment_batch      | f | {search_path=public,pg_temp}
--      --         payment_batch             | f | {search_path=public,pg_temp}
--      --         record_bulk_payment       | f | {search_path=public,pg_temp}
--      --         recompute_customer_balance| t | {search_path=public,pg_temp}
--
-- 3. Nothing existing was touched. Every historical payment still has a NULL
--    batch, and `record_payment` still writes NULL:
--
--      select count(*) filter (where batch_id is not null) as batched,
--             count(*)                                     as total
--        from payments;
--      -- expect batched = 0 immediately after applying
--
-- 4. ROLE BEHAVIOUR — what must FAIL. Signed in as a manager (not admin), with
--    a real batch id from a receipt recorded through the app:
--
--      select delete_payment_batch('<batch id>');
--      -- expect: ERROR  delete_payment_batch: not permitted to delete receipt …
--      -- and afterwards, the rows must still be there:
--      select count(*) from payments where batch_id = '<batch id>';
--
--    That second query is the one that matters. `payments_delete` is admin-only,
--    and the whole point of the row-count check is that a refusal raises instead
--    of returning success having done nothing.
--
-- 5. ATOMICITY — prove it, do not assume it. As admin, send a receipt whose
--    LAST allocation overpays its invoice and whose earlier ones are valid:
--
--      select record_bulk_payment('{
--        "customerId": <id>, "batch_id": "<fresh uuid>",
--        "allocations": [
--          {"saleId": <valid>,  "amount": 1,        "client_key": "<uuid>"},
--          {"saleId": <valid2>, "amount": 99999999, "client_key": "<uuid>"}
--        ]}'::jsonb);
--      -- expect: ERROR  … exceeds its outstanding balance of …
--
--    Then confirm the FIRST allocation did not survive it:
--
--      select count(*) from payments where batch_id = '<fresh uuid>';  -- expect 0
--      select paid from sales where id = <valid>;                      -- unchanged
--
-- 6. IDEMPOTENCY. Record a real receipt, then send the identical payload again:
--
--      select record_bulk_payment('<same payload>'::jsonb) -> 'replayed';
--      -- expect: true
--      select count(*) from payments where batch_id = '<batch id>';
--      -- expect: unchanged from the first call
-- =============================================================================

-- =============================================================================
-- 027_customer_adjustments.sql
-- Northern Water Company Ltd — OASIS Springs
--
-- Adds an explicit, auditable vehicle for correcting a customer's balance, and
-- makes it the third term of the balance formula.
--
-- WHY THIS EXISTS
-- ---------------
-- Since `017`, `customers.balance` is DERIVED and not writable by hand. `025`
-- gave it a second term:
--
--     balance = -sum(sales.total - sales.paid)               -- unpaid invoices
--             + sum(payments.amount where "saleId" is null)  -- credit held
--
-- Every money path calls `recompute_customer_balance()`, so a balance set by
-- hand is overwritten the next time that customer trades. That is not a theory:
-- of the five balances corrected by hand on 2026-07-28, four reverted for
-- exactly this reason and only the dormant account (id 97) still carries its
-- July value.
--
-- 15+ Loglogo balances are wrong from June 2026 — data entry errors made when
-- the system was new, compounded by the silent record loss that `003` fixed on
-- 2026-06-18. The CORRECT balances are known from the manual book. The
-- per-invoice detail behind them is not, and cannot be reconstructed reliably
-- two months on.
--
-- Before this migration the only vehicles that reach a balance are an invoice
-- and a payment, so posting the difference as either one distorts June's
-- revenue or June's cash in order to make Debtors right. Neither is acceptable:
-- Cash Collected and the P&L are read as fact.
--
-- A third term lets the correction be recorded as what it actually is:
--
--     balance = -sum(unpaid invoices) + credit held + adjustments
--
-- This is how an opening balance is normally carried. The correction becomes an
-- explicit row with an author, a date and a stated reason, and it survives
-- recomputation instead of fighting it.
--
-- WHAT AN ADJUSTMENT IS NOT
-- -------------------------
-- It asserts that the book is right. It is not evidence of what happened, and
-- June's transaction history stays incomplete underneath it. That is a
-- deliberate trade, and it is reversible: deleting the adjustment restores the
-- previous balance exactly, which a guessed payment date never could.
--
-- An adjustment is NOT cash and NOT revenue. It moves Debtors and Aging only.
-- Cash Collected, the P&L and every stock figure are untouched by design.
--
-- SCOPE
-- -----
--   * New table `customer_adjustments`, RLS enabled and policies defined here
--     (never in a follow-up).
--   * `recompute_customer_balance` gains the third term. No other change to it.
--   * Two SECURITY DEFINER RPCs: `record_customer_adjustment`,
--     `delete_customer_adjustment`. Admin only, both fail CLOSED.
--   * No change to sales, payments, purchases, production or inventory.
--   * No backfill. Every existing balance is unchanged by this file, because
--     the new term sums to zero until the first adjustment is posted.
--
-- THE TRAP THIS FILE MUST NOT FALL INTO
-- -------------------------------------
-- `get_my_role()` returns NULL when the caller has no `profiles` row. In
-- plpgsql, `if v_role <> 'admin' then raise` does NOT fire on NULL — the
-- comparison is NULL, the branch is skipped, and the function runs. Written
-- that way, the gate FAILS OPEN for exactly the callers who should be trusted
-- least. Both gates below are written `is distinct from`, which fails closed.
-- This is a documented past finding in this database, not a hypothetical.
--
-- A consequence worth stating: because the gates require `auth.uid()`, these
-- functions REFUSE to run from the Supabase SQL Editor, where `auth.uid()` is
-- NULL. That is correct and intended. Corrections are entered through the app.
--
-- CLIENT DEPENDENCY / DEPLOY ORDER
-- --------------------------------
-- Apply this migration FIRST, then deploy the client. The migration alone is
-- inert — the new term is zero for every customer until an adjustment exists —
-- so there is no window in which balances change without the UI to explain
-- them. Deploying the client first would point the adjustment form at a table
-- that does not exist.
--
-- The client change must also update the two places that rebuild a balance
-- OUTSIDE the database, or they will silently disagree with `customers.balance`
-- the moment the first adjustment is posted:
--   * the customer card's running ledger (src/App.jsx, `customerDetail`)
--   * the statement PDF's closing figure (src/App.jsx,
--     `downloadAccountStatementAsPDF`), which tells the customer in its own
--     header that it reconciles.
--
-- RELATED FILE THAT MUST NOT BE APPLIED
-- -------------------------------------
-- `018_settle_customer_balances.sql` hard-codes the ONE-term formula from
-- `017`. It was already stale against `025` (it would zero the credit term);
-- after this file it would zero the adjustment term too, silently undoing every
-- correction entered through the new flow. It is marked do-not-apply in
-- migrations/README.md as part of this change.
--
-- Apply via the Supabase SQL Editor AFTER review. Safe to run once; the whole
-- file is one transaction.
-- =============================================================================


-- =============================================================================
-- BLOCK 0 — PRE-FLIGHT. Read-only. Run these before the transaction below.
--
-- 0a. `025` must be live, or section 2 replaces a function that does not have
--     the credit term and this file would silently drop it. Expect one row,
--     and it must be SECURITY DEFINER (`prosecdef = t`) with a pinned
--     search_path.
--
--       select proname, prosecdef, proconfig from pg_proc p
--         join pg_namespace n on n.oid = p.pronamespace
--        where n.nspname = 'public'
--          and proname = 'recompute_customer_balance';
--
--     Expect: recompute_customer_balance | t | {"search_path=public, pg_temp"}
--
-- 0b. Confirm the CURRENT function really is the two-term version. Read the
--     body and check it sums both `sales` and the `"saleId" is null` payments.
--     Do not trust the README — a migration in this database was recorded as
--     applied when it was not, and was caught only by introspection.
--
--       select prosrc from pg_proc p
--         join pg_namespace n on n.oid = p.pronamespace
--        where n.nspname = 'public' and proname = 'recompute_customer_balance';
--
-- 0c. Confirm the table does not already exist under a different definition.
--     Expect zero rows on a first apply.
--
--       select table_name from information_schema.tables
--        where table_schema = 'public' and table_name = 'customer_adjustments';
--
-- 0d. Record the CURRENT balances of the accounts about to be corrected, so the
--     before/after is provable later. Keep this output.
--
--       select id, name, location, balance from customers
--        where location ilike 'loglogo%' order by name;
-- =============================================================================


begin;


-- =============================================================================
-- SECTION 1: the table
--
-- Column naming follows `sales` / `payments`: "customerId" is camelCase as
-- stored by the app.
--
-- `amount` is SIGNED and uses the same convention as `balance`:
--   negative balance = the customer owes us,
--   so amount > 0 REDUCES a debt and amount < 0 DEEPENS it.
-- A customer who owes 2,220 but whose stored balance reads 300 needs
-- amount = -2,520.
--
-- `id` is an identity column. No client-generated ids anywhere in this database
-- since `003` — that bug silently discarded June's sales and is half the reason
-- this table is needed.
-- =============================================================================

create table if not exists customer_adjustments (
  id              bigint generated always as identity primary key,
  "customerId"    bigint      not null references customers(id),
  amount          numeric(12,2) not null,
  date            date        not null default current_date,
  reason          text        not null,
  kind            text        not null default 'opening_balance',
  created_by      uuid,
  created_at      timestamptz not null default now(),
  client_key      uuid,

  constraint customer_adjustments_amount_nonzero
    check (amount <> 0),
  constraint customer_adjustments_reason_not_blank
    check (length(trim(reason)) > 0),
  constraint customer_adjustments_kind_valid
    check (kind in ('opening_balance', 'correction', 'write_off'))
);

comment on table customer_adjustments is
  'Explicit corrections to a customer balance. Third term of the balance '
  'formula (027). Not cash and not revenue: moves Debtors and Aging only, '
  'never Cash Collected or the P&L.';

comment on column customer_adjustments.amount is
  'Signed, same convention as customers.balance: positive reduces debt, '
  'negative deepens it.';

comment on column customer_adjustments.kind is
  'opening_balance = pre-system or reconstructed-from-book figure; '
  'correction = fixing a known data error; '
  'write_off = debt judged uncollectable. Kept distinct so a future decision '
  'to treat write-offs as a P&L cost can find them without re-opening 027.';

comment on column customer_adjustments.client_key is
  'Idempotency key — see sales.client_key (021).';

create index if not exists customer_adjustments_customer_idx
  on customer_adjustments ("customerId");

create unique index if not exists customer_adjustments_client_key_uniq
  on customer_adjustments (client_key) where client_key is not null;


-- =============================================================================
-- SECTION 2: recompute_customer_balance — the third term
--
-- Replaces the `025` version. The first two terms are copied from it verbatim;
-- the ONLY change is v_adjust and its inclusion in the final UPDATE.
--
-- The `v_credit < 0` guard is deliberately left exactly as it was. It is about
-- the credit pool specifically, and an adjustment must not be able to mask an
-- impossible credit state.
-- =============================================================================

create or replace function recompute_customer_balance(p_customer_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sales   numeric;
  v_credit  numeric;
  v_adjust  numeric;
  v_role    text;
  v_loc     text;
  result    jsonb;
begin
  if p_customer_id is null then
    raise exception 'recompute_customer_balance: customer id is required';
  end if;

  v_role := get_my_role();

  -- Fails closed on a NULL role. See the header note.
  if v_role is distinct from 'admin'
     and v_role is distinct from 'manager'
     and v_role is distinct from 'sales' then
    raise exception 'recompute_customer_balance: not permitted';
  end if;

  if v_role = 'sales' then
    v_loc := get_my_location();
    if v_loc is not null
       and not exists (
         select 1 from customers c
          where c.id = p_customer_id and c.location = v_loc
       ) then
      raise exception 'recompute_customer_balance: customer % is outside your location', p_customer_id;
    end if;
  end if;

  -- Term 1: what is still unpaid on this customer's invoices.
  select -coalesce(sum(s.total - coalesce(s.paid, 0)), 0)
    into v_sales
    from sales s
   where s."customerId" = p_customer_id;

  -- Term 2: unapplied credit. On-account receipts are positive, the draining
  -- leg of an application is negative, so the sum is what is still held.
  select coalesce(sum(p.amount), 0)
    into v_credit
    from payments p
   where p."customerId" = p_customer_id
     and p."saleId" is null;

  if v_credit < 0 then
    raise exception 'recompute_customer_balance: this would leave customer % holding % in credit, which is impossible. A credit application is two rows and cannot be unpicked one at a time — reverse the whole receipt instead.',
      p_customer_id, v_credit;
  end if;

  -- Term 3 (027): explicit corrections. No guard on the sign — an adjustment
  -- exists precisely to move a balance to a figure the transactions do not
  -- support, and either direction is legitimate.
  select coalesce(sum(a.amount), 0)
    into v_adjust
    from customer_adjustments a
   where a."customerId" = p_customer_id;

  update customers set balance = v_sales + v_credit + v_adjust where id = p_customer_id;

  select to_jsonb(c) into result from customers c where c.id = p_customer_id;
  return result;
end;
$$;


-- =============================================================================
-- SECTION 3: record_customer_adjustment
--
-- Admin only. The replay/idempotency shape is `021`'s, so a double-tap or a
-- resend after a dropped connection cannot post the same correction twice.
--
-- Payload:
--   { "customerId": 97,
--     "amount":     -2520.00,        -- signed; see section 1
--     "date":       "2026-06-30",    -- optional, defaults to today
--     "reason":     "Opening balance correction per manual book, June 2026",
--     "kind":       "opening_balance",   -- optional
--     "client_key": "<uuid>" }          -- optional but strongly recommended
--
-- `created_by` is stamped SERVER-SIDE from auth.uid() and is never read from
-- the payload. `019` left the client-supplied `created_by` on payments and
-- expenses alone; a balance correction is exactly the kind of record where that
-- would not be good enough, so it is stamped here.
-- =============================================================================

create or replace function record_customer_adjustment(p_adj jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_customer_id bigint;
  v_amount      numeric;
  v_reason      text;
  v_kind        text;
  v_key         uuid;
  v_role        text;
  v_adj         customer_adjustments;
begin
  v_customer_id := (p_adj ->> 'customerId')::bigint;
  v_amount      := (p_adj ->> 'amount')::numeric;
  v_reason      := nullif(trim(p_adj ->> 'reason'), '');
  v_kind        := coalesce(nullif(p_adj ->> 'kind', ''), 'opening_balance');
  v_key         := nullif(p_adj ->> 'client_key', '')::uuid;

  -- Replay, fast path — before any validation, so a resend of something already
  -- recorded succeeds even if the rules have tightened since.
  if v_key is not null then
    select * into v_adj from customer_adjustments where client_key = v_key;
    if found then
      return jsonb_build_object(
        'adjustment', to_jsonb(v_adj),
        'customer',   recompute_customer_balance(v_adj."customerId"),
        'replayed',   true
      );
    end if;
  end if;

  v_role := get_my_role();

  -- FAILS CLOSED on a NULL role. `<>` would not. See the header note.
  if v_role is distinct from 'admin' then
    raise exception 'record_customer_adjustment: only an admin may adjust a customer balance';
  end if;

  if v_customer_id is null or v_amount is null then
    raise exception 'record_customer_adjustment: customerId and amount are required';
  end if;
  if v_amount = 0 then
    raise exception 'record_customer_adjustment: amount must not be zero';
  end if;
  if v_reason is null then
    raise exception 'record_customer_adjustment: a reason is required — this record is the only explanation the balance will ever carry';
  end if;
  if not exists (select 1 from customers where id = v_customer_id) then
    raise exception 'record_customer_adjustment: customer % not found', v_customer_id;
  end if;

  begin
    insert into customer_adjustments
      ("customerId", amount, date, reason, kind, created_by, client_key)
    values (
      v_customer_id,
      v_amount,
      coalesce((p_adj ->> 'date')::date, current_date),
      v_reason,
      v_kind,
      auth.uid(),
      v_key
    )
    returning * into v_adj;
  exception when unique_violation then
    -- Race path: a concurrent request carrying the same key committed first.
    select * into v_adj from customer_adjustments where client_key = v_key;
    if not found then
      raise;  -- some OTHER unique constraint; not ours to swallow
    end if;
    return jsonb_build_object(
      'adjustment', to_jsonb(v_adj),
      'customer',   recompute_customer_balance(v_adj."customerId"),
      'replayed',   true
    );
  end;

  return jsonb_build_object(
    'adjustment', to_jsonb(v_adj),
    'customer',   recompute_customer_balance(v_customer_id),
    'replayed',   false
  );
end;
$$;


-- =============================================================================
-- SECTION 4: delete_customer_adjustment
--
-- Admin only, fails closed. Deleting restores the balance exactly, because the
-- balance is re-derived from what remains — an adjustment is the one financial
-- record here that is safe to remove outright, since it carries no cash, no
-- revenue and no stock.
-- =============================================================================

create or replace function delete_customer_adjustment(p_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role        text;
  v_customer_id bigint;
begin
  v_role := get_my_role();

  if v_role is distinct from 'admin' then
    raise exception 'delete_customer_adjustment: only an admin may remove a balance adjustment';
  end if;

  select "customerId" into v_customer_id
    from customer_adjustments where id = p_id;
  if not found then
    raise exception 'delete_customer_adjustment: adjustment % not found', p_id;
  end if;

  delete from customer_adjustments where id = p_id;

  return jsonb_build_object(
    'deleted',  p_id,
    'customer', recompute_customer_balance(v_customer_id)
  );
end;
$$;


-- =============================================================================
-- SECTION 5: RLS and grants
--
-- SELECT mirrors `customers_select`, deliberately NOT `payments_select`. An
-- adjustment is an attribute of a customer's balance, not a transaction someone
-- recorded, so it must be visible wherever that customer's balance is. The
-- customer card and the statement both reconcile against `customers.balance`,
-- and a hidden adjustment would make the ledger disagree with the balance
-- printed at the bottom of it.
--
-- That is why the sales branch falls through to "all" on a NULL location rather
-- than to `created_by = auth.uid()`. Only an admin can create an adjustment, so
-- the `created_by` fallback used by `payments_select` would match nothing and
-- hide every adjustment from a location-less sales user who can nonetheless see
-- the customer — `customers_select` has the same fallthrough (finding 12 of the
-- 2026-07-30 RLS audit, still open there). This grants no wider sight of an
-- account than that user already has.
--
-- There is NO insert, update or delete policy, and no table-level write grant.
-- The two SECURITY DEFINER functions are the only write path. This is the same
-- direction 017/018/025 took, and it is what makes the admin-only rule real
-- rather than a hidden button.
-- =============================================================================

alter table customer_adjustments enable row level security;

drop policy if exists "customer_adjustments_select" on customer_adjustments;
create policy "customer_adjustments_select"
  on customer_adjustments for select
  using (
    get_my_role() in ('admin', 'manager')
    or (
      get_my_role() = 'sales'
      and (
        get_my_location() is null
        or exists (
          select 1 from customers c
          where c.id = customer_adjustments."customerId"
            and c.location = get_my_location()
        )
      )
    )
  );

revoke all on table customer_adjustments from anon, public;
grant select on table customer_adjustments to authenticated;

revoke all on function record_customer_adjustment(jsonb) from anon, public;
revoke all on function delete_customer_adjustment(bigint) from anon, public;
grant execute on function record_customer_adjustment(jsonb) to authenticated;
grant execute on function delete_customer_adjustment(bigint) to authenticated;


commit;


-- =============================================================================
-- POST-APPLY VERIFICATION — run every one of these.
--
-- The 2026-07-28 balance correction was recorded as applied and had not landed.
-- It was caught months later by introspection. These checks are the difference.
--
-- 1. The functions exist, are SECURITY DEFINER, and have a pinned search_path.
--
--      select proname, prosecdef, proconfig from pg_proc p
--        join pg_namespace n on n.oid = p.pronamespace
--       where n.nspname = 'public'
--         and proname in ('recompute_customer_balance',
--                         'record_customer_adjustment',
--                         'delete_customer_adjustment')
--       order by proname;
--
--    Expect three rows, all prosecdef = t, all with search_path set.
--
-- 2. NOTHING CHANGED YET. With no adjustments posted, every balance must still
--    equal its own records. This must return no rows:
--
--      select c.id, c.name, c.balance,
--             coalesce(s.unpaid, 0) + coalesce(p.credit, 0) as derived
--        from customers c
--        left join lateral (
--             select -coalesce(sum(s.total - coalesce(s.paid, 0)), 0) as unpaid
--               from sales s where s."customerId" = c.id) s on true
--        left join lateral (
--             select coalesce(sum(p.amount), 0) as credit
--               from payments p
--              where p."customerId" = c.id and p."saleId" is null) p on true
--       where c.balance is distinct from (coalesce(s.unpaid, 0) + coalesce(p.credit, 0));
--
--    Anything returned here is PRE-EXISTING drift, not something this file did
--    — id 97 is the known one. Compare against block 0d before concluding.
--
-- 3. The table is protected. As a NON-admin (or from any client), a direct
--    write must be refused:
--
--      insert into customer_adjustments ("customerId", amount, reason)
--      values (1, 100, 'should not work');
--
--    Expect: permission denied. If this succeeds, section 5 did not apply.
--
-- 4. The gate fails closed. From the SQL Editor, where auth.uid() is NULL:
--
--      select record_customer_adjustment(
--        '{"customerId":1,"amount":100,"reason":"gate test"}'::jsonb);
--
--    Expect: 'only an admin may adjust a customer balance'. If this INSERTS,
--    the gate was written with `<>` instead of `is distinct from` — stop and
--    fix it before anyone uses the feature.
--
-- 5. End to end, from the app as an admin, on ONE account first:
--    a. note the balance,
--    b. post an adjustment,
--    c. the balance moves by exactly that amount,
--    d. the customer card ledger and the statement closing figure both agree
--       with the new balance,
--    e. delete the adjustment and confirm the balance returns to (a).
-- =============================================================================

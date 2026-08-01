-- =============================================================================
-- 019_DRAFT_payment_write_path.sql
-- Northern Water Company Ltd — OASIS Springs
--
-- ############################################################################
-- ##  DRAFT — FOR REVIEW ONLY. DO NOT APPLY.                                ##
-- ##                                                                        ##
-- ##  This file is not numbered into the apply order and is not listed in    ##
-- ##  migrations/README.md as applied. Rename it to                          ##
-- ##  019_payment_write_path.sql only once the open questions at the foot    ##
-- ##  are answered, and 017 and 018 are both live and verified.              ##
-- ############################################################################
--
-- Closes what 017 left open:
--
--   * finding 2's remainder — an in-scope sales user can still insert a
--     well-formed payment row directly over REST, skipping record_payment's
--     over-payment guard and inflating Cash Collected;
--   * the `sales.paid` residual 017 introduced pressure on — `sales_update_sales`
--     and `sales_update_admin_manager` have no `with_check` and no column
--     restriction, so `paid` is directly PATCHable. After 017 the customer
--     balance derives FROM `sales.paid`, so forging it forges the debt;
--   * finding 6 for payments — `created_by` is still read from the JSON payload.
--
-- THE SHAPE OF THE FIX
-- --------------------
-- Same move as 017, one level down. 017 made `customers.balance` derived and
-- ungrantable; this makes `sales.paid` derived and ungrantable:
--
--     paid    = initial_paid + sum(payments.amount for this sale)
--     balance = -sum(total - paid)                        [017]
--
-- `initial_paid` is a new column holding the amount received at the point of
-- sale — the part of `paid` that has no payments row behind it. The client
-- already computes exactly this figure to render the account statement
-- (`paidAtSale = s.paid - paidViaPayments`, src/App.jsx), it just was not
-- stored. Storing it is what makes `paid` derivable.
--
-- WHY THIS IS SMALLER THAN IT FIRST LOOKS
-- ---------------------------------------
-- The obvious route was to convert record_payment, delete_payment, delete_sale
-- and adjust_sale_paid to SECURITY DEFINER. That is four functions and roughly
-- seven hand-written authorization gates, because 011 uses RLS refusals AS its
-- checks:
--
--     delete from sales where id = p_sale_id;
--     get diagnostics v_count = row_count;
--     if v_count = 0 then
--       raise exception 'delete_sale: not permitted to delete sale %', p_sale_id;
--
-- Under DEFINER the owner bypasses RLS (all 15 tables have
-- relforcerowsecurity = false, audit block F), so that gate becomes dead code
-- that always passes — and it is the ONLY thing making deletes admin-only.
--
-- Making `paid` derived avoids nearly all of it. A recompute function takes no
-- amount, so it is safe to grant to `authenticated` and needs no authorization
-- gate to be safe: the worst any caller can do is force a value to be correct.
-- That leaves `delete_payment` and `delete_sale` able to stay SECURITY INVOKER
-- with their RLS-based admin gates intact, and the DEFINER conversion narrows
-- to ONE function:
--
--     record_payment   — 3 gates: null-safe role, sales-role location scope,
--                        created_by forced server-side.
--
-- The cost moved rather than vanished: this file carries a schema change and a
-- backfill, which 017 did not.
--
-- ORDER
-- -----
-- Apply AFTER 017 and 018 are live and verified. No client change is
-- required — src/App.jsx never writes `sales` or `payments` directly (every path
-- goes through record_sale / record_payment / delete_sale / delete_payment /
-- consignment_post_sale), so the revokes in sections 4 and 5 break nothing.
-- Verify that is still true before applying:
--
--     grep -n "from('sales')\|from('payments')" src/App.jsx
--     -- expect only the two .select('*') calls in the initial load
--
-- REPORT IMPACT
-- -------------
-- The backfill preserves every current `paid` value exactly, so nothing moves on
-- apply. Afterwards, Cash Collected and the P&L are unchanged in method. What
-- changes is that a payment can no longer exist without having moved the
-- invoice — the two can no longer disagree.
-- =============================================================================


-- =============================================================================
-- BLOCK 0 — PRE-FLIGHT. Read-only. Run and read BEFORE applying.
--
-- 0a. Sales where the paid-at-sale figure would come out NEGATIVE — i.e. the
--     linked payment rows already exceed `paid`. These are pre-existing
--     inconsistencies the backfill has to make a decision about (see the open
--     question at the foot). Expect ZERO rows.
--
--       select s.id, s."customerId", s.total, s.paid,
--              coalesce(p.paid_via, 0)                    as via_payments,
--              coalesce(s.paid, 0) - coalesce(p.paid_via, 0) as would_be_initial
--         from sales s
--         left join lateral (
--                select sum(amount) as paid_via
--                  from payments where "saleId" = s.id
--              ) p on true
--        where coalesce(s.paid, 0) - coalesce(p.paid_via, 0) < 0
--        order by 6;
--
-- 0b. Payments with no matching sale, which would become unreachable ledger
--     rows. Expect ZERO.
--
--       select p.id, p."saleId", p."customerId", p.amount, p.date
--         from payments p
--         left join sales s on s.id = p."saleId"
--        where s.id is null;
--
-- 0c. Confirm no client path writes sales/payments directly (see ORDER above).
-- =============================================================================


begin;


-- =============================================================================
-- SECTION 1: sales.initial_paid
--
-- The amount received at the point of sale. Idempotent per README convention 2.
-- =============================================================================

alter table sales add column if not exists initial_paid numeric not null default 0;

comment on column sales.initial_paid is
  'Amount received at the point of sale, i.e. the part of `paid` with no payments row behind it. `paid` is derived: initial_paid + sum(linked payments). Set at insert by record_sale; never edited afterwards.';


-- =============================================================================
-- SECTION 2: backfill
--
-- Guarded so a re-run is a no-op: only touches rows still at the default where
-- a non-zero at-sale amount is implied. greatest(...,0) is the decision flagged
-- in block 0a — see the open questions.
-- =============================================================================

update sales s
   set initial_paid = greatest(
         coalesce(s.paid, 0) - coalesce(
           (select sum(amount) from payments where "saleId" = s.id), 0),
         0)
 where s.initial_paid = 0
   and coalesce(s.paid, 0) - coalesce(
         (select sum(amount) from payments where "saleId" = s.id), 0) > 0;


-- =============================================================================
-- SECTION 3: recompute_sale_paid replaces adjust_sale_paid
--
-- SECURITY DEFINER because section 4 removes `authenticated`'s UPDATE on
-- `sales`. No authorization gate on the WRITE for the same reason as 017's
-- balance helper: with no amount parameter there is nothing to abuse. The role
-- gate below guards the READ — DEFINER bypasses RLS on `select to_jsonb(s)`
-- too, and it mirrors `sales_select`.
--
-- coalesce(get_my_role(), '') and `is distinct from`, not a bare `not in`:
-- finding 14.
--
-- Lock before sum, sum as its own statement — same READ COMMITTED reasoning as
-- 017 section 1. Two concurrent payments against one invoice serialize here.
-- =============================================================================

create or replace function recompute_sale_paid(p_sale_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role  text;
  v_sale  sales;
  v_paid  numeric;
  result  jsonb;
begin
  if p_sale_id is null then
    raise exception 'recompute_sale_paid: sale id is required';
  end if;

  v_role := coalesce(get_my_role(), '');
  if v_role is distinct from 'admin'
     and v_role is distinct from 'manager'
     and v_role is distinct from 'sales' then
    raise exception 'recompute_sale_paid: not permitted';
  end if;

  select * into v_sale from sales where id = p_sale_id for update;
  if not found then
    return null;   -- matches adjust_sale_paid's contract and the client's `if (sale)`
  end if;

  if v_role = 'sales'
     and get_my_location() is not null
     and not exists (
           select 1 from customers c
            where c.id = v_sale."customerId"
              and c.location = get_my_location()) then
    raise exception 'recompute_sale_paid: sale % is outside your location', p_sale_id;
  end if;

  select coalesce(v_sale.initial_paid, 0) + coalesce(sum(amount), 0)
    into v_paid
    from payments
   where "saleId" = p_sale_id;

  update sales
     set paid   = v_paid,
         status = sale_status(v_paid, v_sale.total)
   where id = p_sale_id;

  select to_jsonb(s) into result from sales s where s.id = p_sale_id;
  return result;
end;
$$;

grant execute on function recompute_sale_paid(bigint) to authenticated;
revoke all on function recompute_sale_paid(bigint) from anon, public;


-- =============================================================================
-- SECTION 4: sales — remove client UPDATE entirely
--
-- No column grants: the client never updates `sales` directly. Every legitimate
-- change to `paid`/`status` now flows through recompute_sale_paid, and `total`,
-- `items` and `date` are immutable once posted (corrections go through
-- delete-and-re-enter, per the data integrity rules in CLAUDE.md).
--
-- The `sales_update_*` policies from 001 are LEFT IN PLACE. They become
-- unreachable for `authenticated` — the table privilege is checked first — but
-- they stay correct as a second line for any future grantee, and dropping them
-- would make the policy set harder to read against 001.
-- =============================================================================

revoke update on sales from authenticated, anon;


-- =============================================================================
-- SECTION 5: payments — force every insert through record_payment
--
-- This is finding 2's remainder. With INSERT revoked, the only way a payments
-- row can appear is section 6's DEFINER function, which applies the
-- over-payment guard against the committed sale row.
--
-- `payments_insert` (017 section 7) is LEFT IN PLACE for the same reason as
-- above: unreachable for `authenticated`, still correct.
-- =============================================================================

revoke insert on payments from authenticated, anon;


-- =============================================================================
-- SECTION 6: record_payment becomes SECURITY DEFINER
--
-- THE ONLY hand-written authorization boundary in this file. Everything RLS was
-- doing for this function now has to be done here, explicitly, because the owner
-- bypasses RLS on every table it touches.
--
-- Three gates, replacing what `payments_insert` and `sales_update_*` enforced:
--
--   1. null-safe role check;
--   2. sales-role location scope, via the SALE's customer — mirrors
--      payments_select, and is now the only thing scoping a sales user;
--   3. created_by taken from auth.uid(), not the payload. This is stricter than
--      the policy it replaces (which could only compare) and closes finding 6
--      for payments. The client keeps sending created_by; it is ignored.
--
-- Read gate 1 twice. `coalesce(get_my_role(), '')` with `is distinct from` is
-- load-bearing: a caller with no `profiles` row gets NULL from get_my_role(),
-- `NULL not in (...)` is NULL, and a plpgsql IF does not take a NULL branch —
-- so the bare form would let an unprofiled caller straight through. That is
-- finding 14, and it is exactly how 010 shipped two inventory functions whose
-- header claimed they failed closed.
-- =============================================================================

create or replace function record_payment(p_payment jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sale_id     bigint;
  v_amount      numeric;
  v_role        text;
  v_sale        sales;
  v_payment     payments;
  v_customer_id bigint;
  v_sale_json   jsonb;
  v_customer    jsonb;
begin
  -- GATE 1 — role.
  v_role := coalesce(get_my_role(), '');
  if v_role is distinct from 'admin'
     and v_role is distinct from 'manager'
     and v_role is distinct from 'sales' then
    raise exception 'record_payment: not permitted';
  end if;

  v_sale_id := (p_payment ->> 'saleId')::bigint;
  v_amount  := (p_payment ->> 'amount')::numeric;

  if v_sale_id is null or v_amount is null then
    raise exception 'record_payment: saleId and amount are required';
  end if;
  if v_amount <= 0 then
    raise exception 'record_payment: amount must be greater than zero';
  end if;

  select * into v_sale from sales where id = v_sale_id for update;
  if not found then
    raise exception 'record_payment: sale % not found', v_sale_id;
  end if;

  v_customer_id := v_sale."customerId";

  -- GATE 2 — location scope for the sales role. RLS is no longer doing this.
  if v_role = 'sales'
     and get_my_location() is not null
     and not exists (
           select 1 from customers c
            where c.id = v_customer_id
              and c.location = get_my_location()) then
    raise exception 'record_payment: sale % is outside your location', v_sale_id;
  end if;

  if v_amount > (v_sale.total - coalesce(v_sale.paid, 0)) then
    raise exception 'record_payment: amount % exceeds the outstanding balance of % on this invoice',
      v_amount, (v_sale.total - coalesce(v_sale.paid, 0));
  end if;

  -- GATE 3 — attribution is server-side. p_payment's created_by is ignored.
  insert into payments ("saleId", "customerId", date, amount, method, reference, created_by)
  values (
    v_sale_id,
    v_customer_id,
    coalesce((p_payment ->> 'date')::date, current_date),
    v_amount,
    nullif(p_payment ->> 'method', ''),
    nullif(p_payment ->> 'reference', ''),
    auth.uid()
  )
  returning * into v_payment;

  v_sale_json := recompute_sale_paid(v_sale_id);
  v_customer  := recompute_customer_balance(v_customer_id);

  return jsonb_build_object(
    'payment',  to_jsonb(v_payment),
    'sale',     v_sale_json,
    'customer', v_customer
  );
end;
$$;

revoke all on function record_payment(jsonb) from anon, public;
grant execute on function record_payment(jsonb) to authenticated;


-- =============================================================================
-- SECTION 7: rewire the remaining callers of adjust_sale_paid, then drop it
--
-- delete_payment stays SECURITY INVOKER. Its `delete from payments` is still
-- policed by the admin-only DELETE policy from 001, and the row_count check
-- below is still a real gate because of that. Do NOT make this function DEFINER
-- without replacing that check with an explicit admin test.
--
-- record_sale must also set initial_paid — it is the only place a
-- point-of-sale amount enters the system. Section 8 covers it.
-- =============================================================================

create or replace function delete_payment(p_payment_id bigint)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_payment   payments;
  v_count     int;
  v_sale_json jsonb;
  v_customer  jsonb;
begin
  select * into v_payment from payments where id = p_payment_id for update;
  if not found then
    raise exception 'delete_payment: payment % not found', p_payment_id;
  end if;

  delete from payments where id = p_payment_id;
  get diagnostics v_count = row_count;
  if v_count = 0 then
    -- RLS refused it. This IS the admin-only gate. See section 7 header.
    raise exception 'delete_payment: not permitted to delete payment %', p_payment_id;
  end if;

  v_sale_json := recompute_sale_paid(v_payment."saleId");
  v_customer  := recompute_customer_balance(v_payment."customerId");

  return jsonb_build_object(
    'sale',     v_sale_json,
    'customer', v_customer
  );
end;
$$;

drop function if exists adjust_sale_paid(bigint, numeric);


-- =============================================================================
-- SECTION 8: record_sale and consignment_post_sale set initial_paid
--
-- Only the inserts change: initial_paid = the paid figure supplied at creation,
-- since no payments row exists for a sale at the moment it is created. Both
-- functions stay SECURITY INVOKER; 017 section 6's policy still governs them.
--
-- NOTE FOR THE REVIEWER: reproduced here in full in the real migration. Elided
-- in the draft to keep the diff readable — the only edit is adding
-- `initial_paid` to the column list and `v_paid` to the values list in both.
-- =============================================================================

-- create or replace function record_sale(p_sale jsonb) ...
--   insert into sales (..., paid, initial_paid, ...) values (..., v_paid, v_paid, ...)
-- create or replace function consignment_post_sale(p_sale jsonb, p_movements jsonb) ...
--   insert into sales (..., paid, initial_paid, ...) values (..., v_paid, v_paid, ...)


commit;


-- =============================================================================
-- OPEN QUESTIONS — resolve before this becomes a real migration
--
-- Q1. Block 0a / section 2: what should the backfill do with a sale whose linked
--     payments already exceed `paid`? The draft clamps to 0 with greatest(),
--     which silently absorbs the inconsistency and then, on the next recompute,
--     RAISES that sale's paid to match the payments — moving the customer's
--     debt down. If block 0a returns rows, that is a data question to answer
--     first, not a clamp to choose. If it returns zero rows the clamp never
--     fires and the question is moot.
--
-- Q2. Should `initial_paid` also be revoked at column level? Section 4 revokes
--     UPDATE on the whole table, so it is covered — but if a future migration
--     ever re-grants column UPDATE on `sales`, `initial_paid` must not be in
--     the list. Worth a comment on the column, which section 1 adds.
--
-- Q3. delete_sale deletes a sale's payments then the sale itself. With
--     `payments` INSERT revoked but DELETE still policy-governed, that path is
--     unchanged — confirm on a test sale as admin that the cascade still works
--     and the customer balance reverses.
--
-- Q4. Does any Supabase Edge Function, dashboard workflow or support script
--     insert payments or update sales outside the app? Section 4 and 5 would
--     break it. `service_role` is untouched, so anything using the service key
--     is fine; anything using an anon/user JWT is not.
--
-- VERIFICATION — after applying
--
--   1. Functions are as intended. Control row: record_sale must stay `f`.
--        select proname, prosecdef, proconfig from pg_proc p
--          join pg_namespace n on n.oid = p.pronamespace
--         where n.nspname = 'public'
--           and proname in ('record_payment','recompute_sale_paid',
--                           'adjust_sale_paid','delete_payment','record_sale')
--         order by proname;
--      Expect: record_payment t, recompute_sale_paid t, delete_payment f,
--              record_sale f, and NO adjust_sale_paid row.
--
--   2. Privileges gone.
--        select privilege_type from information_schema.table_privileges
--         where table_name in ('sales','payments') and grantee = 'authenticated';
--      Expect SELECT and DELETE only — no INSERT on payments, no UPDATE on sales.
--
--   3. Every sale's paid agrees with its ledger. Expect ZERO rows.
--        select s.id, s.paid, s.initial_paid, coalesce(p.via, 0)
--          from sales s
--          left join lateral (select sum(amount) as via from payments
--                              where "saleId" = s.id) p on true
--         where coalesce(s.paid,0)
--               <> coalesce(s.initial_paid,0) + coalesce(p.via,0);
--
-- ROLE TESTING — from the app, as real logged-in users. NOT from the SQL
-- Editor: auth.uid() is NULL there, so section 6's gates refuse everything and
-- a passing result means a gate is broken (finding 14). This file has three
-- gates and they are all on the payment path, so test all three roles.
--
--   SALES, expect success:  record a payment against an in-location invoice;
--     confirm the invoice's paid/status and the customer's balance both move.
--   SALES, expect failure:  record_payment for an out-of-location sale (gate 2);
--     direct POST to /rest/v1/payments (expect 403, permission denied for table);
--     direct PATCH of /rest/v1/sales?id=eq.N {"paid":9999} (expect 403).
--   SALES, expect the recorded created_by to be the SALES user even if the
--     payload names someone else (gate 3).
--   MANAGER, expect success: record a payment for any location.
--   MANAGER, expect failure: delete a payment (still admin-only, section 7).
--   ADMIN, expect success:   record and delete a payment; delete a sale that has
--     payments (Q3); confirm balances reverse to the derived figures.
-- =============================================================================

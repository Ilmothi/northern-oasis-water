-- =============================================================================
-- 019_server_side_attribution_and_payment_delete.sql
-- Northern Water Company Ltd — OASIS Springs
--
-- Three unrelated defects, all found on 2026-08-01/03 while testing `017` in
-- production. They ship together because each is small and all three sit on the
-- sale/payment path.
--
--   1. Sales staff could not record a sale — `017`'s `sales_insert_non_admin`
--      compares a CLIENT-SUPPLIED `created_by` against `auth.uid()`, and those
--      can differ. Fixed by stamping `created_by` server-side instead.
--   2. NOBODY could delete a payment, admin included — and this one has been
--      live since `013` on 2026-07-28, unrelated to `017`.
--   3. The admin profile's `location` is `''` rather than NULL.
--
-- =============================================================================
-- 1. SALE RECORDING — "new row violates row-level security policy for sales"
-- =============================================================================
--
-- `017` added `created_by = auth.uid()` to `sales_insert_non_admin` to stop
-- attribution being forged. The check is right; the thing it checks is not.
-- `record_sale` takes `created_by` from its JSON payload
-- (`nullif(p_sale ->> 'created_by', '')::uuid`), and the client fills it from
-- React state (`session?.user?.id`, src/App.jsx). `auth.uid()` comes from the
-- JWT on the request. Those are normally equal and are not guaranteed to be:
-- signing in as a second user in the same browser updates the stored token
-- while the in-memory session can lag, so the row arrives stamped with one
-- user's id under another user's JWT. The policy compares them and refuses.
--
-- Confirmed in production: a Loglogo sales rep, `role = 'sales'`,
-- `location = 'Loglogo'`, recording a sale for customer 13 (ASHA LEEBA,
-- Loglogo, not a consignee). Every other branch of the policy was satisfied.
--
-- The fix is not to relax the policy. It is to stop the client supplying the
-- value: `record_sale` and `consignment_post_sale` now write `auth.uid()` and
-- ignore the payload, as `record_production` has done since `015`. A check that
-- compares a client-supplied value to the JWT can always be made to fail by a
-- stale client; a value the server writes cannot. This also makes attribution
-- unforgeable rather than merely checked, which is finding 6 of
-- docs/audit-2026-07-30-rls.md closed properly for sales instead of partially.
--
-- The client keeps sending `created_by`. It is ignored, not rejected, so no
-- client deploy is required for this section.
--
-- CURRENT LIVE STATE: `sales_insert_non_admin` was reverted by hand on
-- 2026-08-01 to unblock trading, back to `010`'s
-- `auth.uid() is not null and total >= 0`. Section 3 restores `017`'s version.
-- `payments_insert` was NOT reverted and is still `017`'s — it was exercised in
-- production and works.
--
-- =============================================================================
-- 2. PAYMENT DELETION — "delete_payment: payment N not found"
-- =============================================================================
--
-- Raised by the first statement of `delete_payment`:
--
--     select * into v_payment from payments where id = p_payment_id for update;
--     if not found then raise exception '... payment % not found' ...
--
-- `SELECT ... FOR UPDATE` on an RLS table requires the UPDATE policies to be
-- satisfied as well as the SELECT ones — the row is being locked for possible
-- modification. `payments` has NO UPDATE policy: `001` left it out on purpose,
-- because payments are immutable and corrections go through delete-and-re-enter.
--
-- That was harmless while the blanket `"Authenticated full access"` policy
-- (ALL / true / true) covered UPDATE. **`013` dropped it**, and the lock has
-- matched zero rows ever since — for every role, admin included. Verified
-- 2026-08-03: `pg_policies` shows SELECT, INSERT and DELETE on `payments` and no
-- UPDATE row.
--
-- Same shape as the `010`/`013` interaction that took out stock writes: a policy
-- removal making a latent gap binding, inside a function body where no policy
-- dump would show it.
--
-- The fix is NOT to add an UPDATE policy — that would make payments mutable and
-- give up the immutability `001` wanted. Instead the `FOR UPDATE` goes away and
-- the DELETE takes its own row lock, which is all the concurrency protection
-- that was ever needed here: two concurrent deletes of the same payment now
-- serialize on the DELETE, and the loser gets zero rows.
--
-- `delete_sale` does the same `FOR UPDATE` against `sales` and is NOT affected —
-- `sales` has `sales_update_admin_manager` and `sales_update_sales`, so the lock
-- resolves. `record_payment`'s `FOR UPDATE` on `sales` is fine for the same
-- reason. `payments` is the only table in the money path with no UPDATE policy,
-- so this is the only place the bug exists.
--
-- =============================================================================
-- 3. WHAT THIS DELIBERATELY DOES NOT DO
-- =============================================================================
--
--   * It does not touch `payments_insert` — working, verified in production.
--   * It does not add an UPDATE policy to `payments`. They stay immutable.
--   * It does not address findings 4, 5, 7-13, or finding 2's remainder
--     (`020_DRAFT_payment_write_path.sql`).
--
-- REPORT IMPACT: none. No figure moves. Section 4's profile change alters no
-- policy outcome (see its header).
--
-- CLIENT: `saleCustomerOptions()` in src/App.jsx now filters on
-- `visibleCustomers` rather than `state.customers`, so a sales user is never
-- offered a customer the database will refuse. That is defence in depth, not a
-- dependency — `customers_select` already scopes the fetch — so this file can be
-- applied before or after that deploy.
-- =============================================================================


-- =============================================================================
-- BLOCK 0 — PRE-FLIGHT. Read-only.
--
-- 0a. Confirm the payments UPDATE policy really is absent, i.e. that section 2
--     is fixing what it thinks it is. Expect SELECT, INSERT, DELETE — no UPDATE.
--
--       select policyname, cmd from pg_policies
--        where tablename = 'payments' order by cmd;
--
-- 0b. Confirm the live `sales_insert_non_admin` is the reverted one, so section
--     3 is restoring rather than colliding with something else. Expect
--     `(auth.uid() IS NOT NULL) AND (total >= 0)`.
--
--       select policyname, with_check from pg_policies
--        where tablename = 'sales' and policyname like 'sales_insert%';
--
-- 0c. Confirm `017` is live — `recompute_customer_balance` present and DEFINER,
--     `record_sale` present and INVOKER (it stays INVOKER here).
--
--       select proname, prosecdef from pg_proc p
--         join pg_namespace n on n.oid = p.pronamespace
--        where n.nspname = 'public'
--          and proname in ('recompute_customer_balance','record_sale','get_my_role')
--        order by proname;
-- =============================================================================


begin;


-- =============================================================================
-- SECTION 1: record_sale — created_by is stamped server-side
--
-- Unchanged from `017` apart from the `created_by` value. Stays SECURITY
-- INVOKER: RLS still governs every row it touches, and section 3's policy is
-- still what decides whether the insert is allowed.
-- =============================================================================

create or replace function record_sale(p_sale jsonb)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_customer_id bigint;
  v_total       numeric;
  v_paid        numeric;
  v_items       jsonb;
  v_sale        sales;
  v_changes     jsonb;
  v_inventory   jsonb;
  v_customer    jsonb;
begin
  v_customer_id := (p_sale ->> 'customerId')::bigint;
  v_total       := (p_sale ->> 'total')::numeric;
  v_paid        := coalesce((p_sale ->> 'paid')::numeric, 0);
  v_items       := coalesce(p_sale -> 'items', '[]'::jsonb);

  if v_customer_id is null or v_total is null then
    raise exception 'record_sale: customerId and total are required';
  end if;
  if v_paid < 0 or v_paid > v_total then
    raise exception 'record_sale: paid (%) must be between 0 and total (%)', v_paid, v_total;
  end if;

  insert into sales ("customerId", date, items, total, paid, status, method, created_by)
  values (
    v_customer_id,
    coalesce((p_sale ->> 'date')::date, current_date),
    v_items,
    v_total,
    v_paid,
    sale_status(v_paid, v_total),
    nullif(p_sale ->> 'method', ''),
    auth.uid()          -- server-side; p_sale's created_by is ignored
  )
  returning * into v_sale;

  v_changes := fg_delta_changes(v_items, -1);
  if jsonb_array_length(v_changes) > 0 then
    v_inventory := apply_inventory_deltas(v_changes);
  end if;

  v_customer := recompute_customer_balance(v_customer_id);

  return jsonb_build_object(
    'sale',      to_jsonb(v_sale),
    'customer',  v_customer,
    'inventory', v_inventory
  );
end;
$$;


-- =============================================================================
-- SECTION 2: consignment_post_sale — same change, plus the movement rows
--
-- The movements' `created_by` is stamped too. `consignment_movements_insert_manager`
-- does not check attribution today (finding 11), so this is not fixing a refusal
-- — it is removing the same forgeable field before a future policy relies on it.
-- =============================================================================

create or replace function consignment_post_sale(p_sale jsonb, p_movements jsonb)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_shop_id  bigint;
  v_total    numeric;
  v_paid     numeric;
  v_sale     sales;
  v_moves    jsonb;
  v_customer jsonb;
begin
  v_shop_id := (p_sale ->> 'customerId')::bigint;
  v_total   := (p_sale ->> 'total')::numeric;
  v_paid    := coalesce((p_sale ->> 'paid')::numeric, 0);

  if v_shop_id is null or v_total is null then
    raise exception 'consignment_post_sale: customerId and total are required';
  end if;
  if p_movements is null or jsonb_typeof(p_movements) <> 'array'
     or jsonb_array_length(p_movements) = 0 then
    raise exception 'consignment_post_sale: at least one movement is required';
  end if;
  if not exists (select 1 from customers where id = v_shop_id and is_consignee) then
    raise exception 'consignment_post_sale: customer % is not a consignment shop', v_shop_id;
  end if;

  insert into sales ("customerId", date, items, total, paid, status, method, created_by)
  values (
    v_shop_id,
    coalesce((p_sale ->> 'date')::date, current_date),
    coalesce(p_sale -> 'items', '[]'::jsonb),
    v_total,
    v_paid,
    sale_status(v_paid, v_total),
    nullif(p_sale ->> 'method', ''),
    auth.uid()
  )
  returning * into v_sale;

  with inserted as (
    insert into consignment_movements
      (shop_id, date, type, size, quantity, unit_price, sale_id, note, created_by)
    select
      v_shop_id,
      coalesce((m ->> 'date')::date, current_date),
      m ->> 'type',
      m ->> 'size',
      (m ->> 'quantity')::numeric,
      (m ->> 'unit_price')::numeric,
      v_sale.id,
      nullif(m ->> 'note', ''),
      auth.uid()
    from jsonb_array_elements(p_movements) as m
    returning *
  )
  select coalesce(jsonb_agg(to_jsonb(inserted)), '[]'::jsonb) into v_moves from inserted;

  v_customer := recompute_customer_balance(v_shop_id);

  return jsonb_build_object(
    'sale',      to_jsonb(v_sale),
    'movements', v_moves,
    'customer',  v_customer
  );
end;
$$;


-- =============================================================================
-- SECTION 3: restore sales_insert_non_admin
--
-- Identical to `017`'s. It was correct — it refused a sale whose `created_by`
-- did not match the JWT, which is exactly what it was written to do. Sections 1
-- and 2 remove the only way that could happen legitimately, so the check now
-- passes for every real caller and still refuses a forged one.
--
-- Mirrors `sales_select`, so what a sales user may CREATE is the same set they
-- may READ. `total >= 0` is carried from `010` section 6: only an admin may post
-- the negative-total reconciliation credit note.
-- =============================================================================

drop policy if exists "sales_insert_non_admin" on sales;
create policy "sales_insert_non_admin"
  on sales for insert
  with check (
    total >= 0
    and created_by = auth.uid()
    and (
      get_my_role() = 'manager'
      or (
        get_my_role() = 'sales'
        and (
          (
            get_my_location() is not null
            and exists (
              select 1 from customers c
              where c.id = sales."customerId"
                and c.location = get_my_location()
            )
          )
          or get_my_location() is null   -- own records only, via created_by above
        )
      )
    )
  );


-- =============================================================================
-- SECTION 4: delete_payment — drop the FOR UPDATE
--
-- Otherwise identical to `017`'s version. The plain SELECT establishes "does
-- this payment exist and can I see it"; the DELETE establishes "am I allowed to
-- remove it" via the admin-only `payments_delete` policy and takes its own row
-- lock. Both original error messages are preserved and still mean what they say.
--
-- Do NOT reintroduce `FOR UPDATE` here without first giving `payments` an UPDATE
-- policy, which would mean deciding that payments are no longer immutable.
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
  -- zero rows for every role. See this file's header, section 2.
  select * into v_payment from payments where id = p_payment_id;
  if not found then
    raise exception 'delete_payment: payment % not found', p_payment_id;
  end if;

  delete from payments where id = p_payment_id
  returning * into v_payment;
  if not found then
    raise exception 'delete_payment: not permitted to delete payment %', p_payment_id;
  end if;

  v_sale_json := adjust_sale_paid(v_payment."saleId", -v_payment.amount);
  v_customer  := recompute_customer_balance(v_payment."customerId");

  return jsonb_build_object(
    'sale',     v_sale_json,
    'customer', v_customer
  );
end;
$$;


-- =============================================================================
-- SECTION 5: normalise the admin profile's location
--
-- One profile has `location = ''` rather than NULL. No policy tests an admin's
-- location — every admin branch is reached by role first — so this changes no
-- outcome today. It is cleaned up because `''` sits in the gap between both
-- halves of every location check that exists: `'' is null` is false, and
-- `'' = 'Loglogo'` is false, so such a user matches neither the scoped branch
-- nor the unscoped fallthrough. If a future policy ever tests an admin's
-- location, that is a silent lockout waiting to happen.
--
-- Idempotent. `profiles` has no client write policy, so this runs as owner.
-- =============================================================================

update profiles set location = null where location = '';


commit;


-- =============================================================================
-- AFTER APPLYING — verify it landed, then test it as a real user.
--
-- 1. Attribution is server-side. Expect `t` for both:
--
--      select proname,
--             pg_get_functiondef(p.oid) ilike '%auth.uid()%' as stamps_uid
--        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--       where n.nspname = 'public'
--         and proname in ('record_sale','consignment_post_sale')
--       order by proname;
--
-- 2. delete_payment no longer locks. Expect `f`:
--
--      select pg_get_functiondef(oid) ilike '%p_payment_id for update%'
--               as still_locks
--        from pg_proc where proname = 'delete_payment';
--
--    Match the STATEMENT, not the phrase. This check was first written as
--    `ilike '%for update%'`, which returned true against a correctly-applied
--    function because section 4's body carries a comment explaining why the
--    lock was removed — the phrase appears in the definition either way.
--    `pg_get_functiondef` returns comments as well as code, so any verification
--    query here has to match something a comment would not say.
--
-- 3. The policy is back:
--
--      select with_check from pg_policies
--       where tablename = 'sales' and policyname = 'sales_insert_non_admin';
--
-- 4. No profile has a blank location. Expect zero rows:
--
--      select id, role, location from profiles where location = '';
--
-- ROLE TESTING — in the app, as real logged-in users. This is the part that was
-- skipped for `017` and is the reason this file exists. A DEFINER role gate
-- cannot be exercised from the SQL Editor (`auth.uid()` is NULL there, so a
-- correct gate refuses everything), and neither can any of the below.
--
-- Use a fresh browser session per role — a second login in the same browser is
-- what produced the original `created_by` mismatch, and it will produce
-- confusing results here too.
--
--   SALES (expect success): record a sale for a customer at your location.
--     Then check the row was attributed to YOU and not to whoever the client
--     thought it was:
--       select id, created_by from sales order by id desc limit 1;
--
--   SALES (expect failure): record a sale for a customer at another location.
--     Expect "new row violates row-level security policy" — that is finding 3
--     working, not a bug. Note the UI should not offer such a customer once the
--     matching client deploy is live.
--
--   ADMIN (expect success): record a payment, then DELETE it. This is the whole
--     point of section 4 and has not worked since 2026-07-28. Confirm the
--     invoice's paid/status and the customer's balance both reverse.
--
--   MANAGER (expect success): record a sale for any location.
--   MANAGER (expect failure): delete a payment — still admin-only.
--
-- IF A SALE FAILS FOR THE SALES ROLE, the one-statement revert that unblocked
-- trading on 2026-08-01 still works and gives up only finding 3:
--
--      drop policy if exists "sales_insert_non_admin" on sales;
--      create policy "sales_insert_non_admin" on sales for insert
--        with check (auth.uid() is not null and total >= 0);
-- =============================================================================

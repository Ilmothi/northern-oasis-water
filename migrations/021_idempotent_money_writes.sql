-- =============================================================================
-- 021_idempotent_money_writes.sql
-- Northern Water Company Ltd — OASIS Springs
--
-- Duplicate sales, payments and production runs are being created in the field.
-- Reported 2026-08-04.
--
-- There are two distinct causes and they need two distinct fixes. Only the
-- second one belongs in the database.
--
--   1. DOUBLE-TAPPING SAVE. Two taps on a phone are two click events, so the
--      handler ran twice and sent two independent, individually-valid requests.
--      Nothing downstream could tell the second one was unwanted. Fixed in the
--      client (src/App.jsx) by an in-flight guard on the modal's Save button.
--      No database change is possible or needed for this one — two deliberate
--      identical sales a minute apart are legitimate and must stay legitimate.
--
--   2. RETRY AFTER A LOST CONNECTION. This is the one this file exists for.
--      The request reaches Postgres, the transaction commits, and the response
--      never gets back to the browser — the link drops, the tablet loses signal,
--      the fetch hangs until the client gives up. The operator sees a failure,
--      re-enters the sale, and the second one commits too. Both rows are real
--      and correct in isolation. Nothing in the schema can distinguish them
--      after the fact, and no client-side guard can prevent them, because from
--      the client's point of view the first attempt genuinely did fail.
--
-- The fix for (2) is to let the client say "this is the same form I already
-- sent you". Each opened form generates a UUID; the three record_* functions
-- store it, and a resend of a key already on file returns the row that was
-- recorded rather than recording a second one.
--
-- This makes the money-write path IDEMPOTENT — safe to call more than once with
-- the same input. It does not make it deduplicating: two separately-entered
-- sales that happen to be identical carry different keys and both save, which
-- is correct.
--
-- =============================================================================
-- WHY THE UNIQUE INDEX, AND NOT JUST THE LOOKUP
-- =============================================================================
--
-- The "have I seen this key" check at the top of each function is a read
-- followed by a write, so two concurrent requests carrying the same key can
-- both pass it and both insert. That race is exactly the double-tap this file's
-- sibling client fix is aimed at, so it is not hypothetical.
--
-- The partial unique index is what actually enforces the rule; the lookup is
-- only the fast path that avoids the error in the common case. The second
-- inserter gets `unique_violation`, which each function catches and converts
-- into the same replay response. By the time that error is raised the winning
-- transaction has necessarily committed, so under READ COMMITTED the recovery
-- SELECT — a new statement, and therefore a new snapshot — is guaranteed to see
-- the row it needs.
--
-- The index is partial (`where client_key is not null`) so that every existing
-- row, and any write from a client too old to send a key, is unaffected.
--
-- =============================================================================
-- ORDERING — CLIENT FIRST IS SAFE, AND IS THE RECOMMENDED ORDER
-- =============================================================================
--
-- Unusually for this directory, this migration and its client are independent
-- in both directions:
--
--   * Client deployed first: the extra `client_key` in the JSON payload is
--     ignored by the current functions, which read named fields out of `jsonb`
--     and discard the rest. Saves behave exactly as they do today. The client's
--     own double-tap guard — the fix for the duplicates actually being
--     reported — starts working immediately.
--   * Migration applied first: `client_key` stays NULL on every row, the
--     partial index covers nothing, and the replay branch is never entered.
--
-- So ship the client, confirm the double-tap duplicates have stopped, and apply
-- this afterwards. Neither half is urgent for the other.
--
-- REQUIRES `020`. Section 3 rewrites `record_sale` starting from `020`'s
-- version, which calls `assert_stock_not_negative`. Applying this file to a
-- database where `020` has not landed installs a `record_sale` that raises
-- `function assert_stock_not_negative(...) does not exist` on EVERY SALE.
-- Block 0 checks for it and this file will not apply without it.
--
-- REPORT IMPACT: none. No existing row is read or written, no figure moves.
-- Going forward, fewer duplicate sales means Debtors and P&L reflect what was
-- actually sold — but nothing already recorded changes, and the duplicates
-- already in the data are NOT cleaned up here (see below).
--
-- =============================================================================
-- WHAT THIS DELIBERATELY DOES NOT DO
-- =============================================================================
--
--   * It does not remove the duplicates already in production. Those are real
--     rows with real invoice numbers in a live ledger; deciding which of a pair
--     is the keeper is a business call, not a migration. They need finding and
--     reversing through the existing delete flows.
--   * It does not cover expenses, purchases, customers or employees. Those go
--     through plain PostgREST inserts rather than an RPC, so there is no
--     function body to put the check in. They get the client-side double-tap
--     guard and the timeout warning, which is the larger half of the problem.
--     Extending idempotency to them means moving them onto RPCs first.
--   * It does not cover the consignment functions (`consignment_post_sale`,
--     `consignment_move_stock`). Same pattern would work; left out to keep the
--     change reviewable, and consignment postings are low-volume and made by
--     managers at a desk rather than on a phone at a kiosk.
--   * It does not defend against a retry sent after the original was DELETED.
--     The key is gone with the row, so the retry re-creates it. The key lives
--     only as long as the form is open, so this needs a delete to land inside
--     that window — and re-creating a sale the admin just deleted is a visible,
--     recoverable outcome rather than a silent one.
--   * It does not change any policy, grant, or role. `client_key` is covered by
--     the existing table-wide INSERT grants on all three tables — only
--     `customers` carries column-scoped grants (`017` section 5), and it is not
--     touched here. This is the trap the README warns about after `017`; it was
--     checked, not assumed.
-- =============================================================================


-- =============================================================================
-- BLOCK 0 — PRE-FLIGHT. Read-only.
--
-- 0a. `020` must be live, or section 3 installs a record_sale that cannot run.
--     Expect one row. If this returns nothing, STOP and apply `020` first.
--
--       select proname from pg_proc p
--         join pg_namespace n on n.oid = p.pronamespace
--        where n.nspname = 'public' and proname = 'assert_stock_not_negative';
--
-- 0b. Confirm the three functions being replaced are the versions this file
--     expects to be starting from. Expect all three present, all INVOKER (`f`).
--
--       select proname, prosecdef from pg_proc p
--         join pg_namespace n on n.oid = p.pronamespace
--        where n.nspname = 'public'
--          and proname in ('record_sale','record_payment','record_production')
--        order by proname;
--
-- 0c. Confirm no `client_key` column exists yet under a different definition —
--     this file assumes it is either absent or already uuid. Expect zero rows
--     on a first apply, three `uuid` rows on a re-apply.
--
--       select table_name, data_type from information_schema.columns
--        where table_schema = 'public' and column_name = 'client_key';
-- =============================================================================


begin;


-- =============================================================================
-- SECTION 1: the client_key columns and their indexes
--
-- Nullable, no default, no backfill. A NULL key means "this write did not
-- identify itself", which is every row written before today and every write
-- from an older client — all of which keep working exactly as they do now.
--
-- Idempotent: `if not exists` on both the columns and the indexes.
-- =============================================================================

alter table sales            add column if not exists client_key uuid;
alter table payments         add column if not exists client_key uuid;
alter table production_logs  add column if not exists client_key uuid;

comment on column sales.client_key is
  'Identifies one filled-in form in the client, so a resend after a lost '
  'response returns the existing sale instead of recording a second one. '
  'NULL for rows written before migration 021. See 021_idempotent_money_writes.sql.';
comment on column payments.client_key is
  'Idempotency key — see sales.client_key.';
comment on column production_logs.client_key is
  'Idempotency key — see sales.client_key.';

-- Partial: existing NULL rows are not constrained, and cannot be, since they
-- are all NULL. This is the actual enforcement point — the lookups in sections
-- 3-5 are an optimisation on top of it, not a substitute for it.
create unique index if not exists sales_client_key_uniq
  on sales (client_key) where client_key is not null;
create unique index if not exists payments_client_key_uniq
  on payments (client_key) where client_key is not null;
create unique index if not exists production_logs_client_key_uniq
  on production_logs (client_key) where client_key is not null;


-- =============================================================================
-- SECTION 2: current_inventory
--
-- A replay must return the same response shape as a first-time save, including
-- the inventory blob the client uses to refresh its stock figures. The real
-- save gets that from `apply_inventory_deltas`, which is the wrong thing to
-- call on a replay — it MOVES stock. This just reads the two rows in the shape
-- that function returns.
--
-- SECURITY INVOKER, and reads only `inventory_state`, whose SELECT policy is
-- `auth.uid() is not null` (001 section 11) — so every role that can save can
-- read this, and RLS still governs it. No role gate needed precisely because it
-- is not DEFINER.
-- =============================================================================

create or replace function current_inventory()
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_object_agg(id, data)
    from inventory_state
   where id in ('rawMaterials', 'finishedGoods');
$$;

grant execute on function current_inventory() to authenticated;
revoke all on function current_inventory() from anon, public;


-- =============================================================================
-- SECTION 3: record_sale
--
-- `020`'s version, with the replay guard wrapped around it. The sale insert,
-- the stock deduction, the negative-stock assertion and the balance recompute
-- are all unchanged and still one transaction.
--
-- Two ways in to the replay response:
--   * the lookup at the top — the ordinary case, a retry seconds or minutes
--     after the response was lost;
--   * the unique_violation handler — the race, two requests in flight at once.
-- Both return `replayed: true` so the client can say so rather than silently
-- appearing to save.
--
-- The `recompute_customer_balance` call on the replay path is deliberate and
-- safe: it derives the balance from the sales ledger rather than adjusting it
-- by a delta (`017`), so calling it again recomputes the same figure. It is
-- there so the client's customer row is refreshed, not to change anything.
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
  v_key         uuid;
  v_sale        sales;
  v_changes     jsonb;
  v_inventory   jsonb;
  v_customer    jsonb;
begin
  v_customer_id := (p_sale ->> 'customerId')::bigint;
  v_total       := (p_sale ->> 'total')::numeric;
  v_paid        := coalesce((p_sale ->> 'paid')::numeric, 0);
  v_items       := coalesce(p_sale -> 'items', '[]'::jsonb);
  v_key         := nullif(p_sale ->> 'client_key', '')::uuid;

  -- Replay, fast path. Before any validation: a resend of something already
  -- recorded must succeed even if the rules have tightened since, otherwise the
  -- operator is told their sale failed when it is sitting in the ledger.
  if v_key is not null then
    select * into v_sale from sales where client_key = v_key;
    if found then
      return jsonb_build_object(
        'sale',      to_jsonb(v_sale),
        'customer',  recompute_customer_balance(v_sale."customerId"),
        'inventory', current_inventory(),
        'replayed',  true
      );
    end if;
  end if;

  if v_customer_id is null or v_total is null then
    raise exception 'record_sale: customerId and total are required';
  end if;
  if v_paid < 0 or v_paid > v_total then
    raise exception 'record_sale: paid (%) must be between 0 and total (%)', v_paid, v_total;
  end if;

  -- Sub-block so the unique_violation can be caught without discarding the
  -- whole transaction. Nothing before this point has written anything.
  begin
    insert into sales ("customerId", date, items, total, paid, status, method, created_by, client_key)
    values (
      v_customer_id,
      coalesce((p_sale ->> 'date')::date, current_date),
      v_items,
      v_total,
      v_paid,
      sale_status(v_paid, v_total),
      nullif(p_sale ->> 'method', ''),
      auth.uid(),
      v_key
    )
    returning * into v_sale;
  exception when unique_violation then
    -- Replay, race path. A concurrent request carrying the same key committed
    -- first. It has committed — that is what makes the violation possible — so
    -- this SELECT, on a fresh snapshot, will find it.
    select * into v_sale from sales where client_key = v_key;
    if not found then
      raise;  -- some OTHER unique constraint; not ours to swallow
    end if;
    return jsonb_build_object(
      'sale',      to_jsonb(v_sale),
      'customer',  recompute_customer_balance(v_sale."customerId"),
      'inventory', current_inventory(),
      'replayed',  true
    );
  end;

  v_changes := fg_delta_changes(v_items, -1);
  if jsonb_array_length(v_changes) > 0 then
    v_inventory := apply_inventory_deltas(v_changes);
    perform assert_stock_not_negative(v_inventory, v_changes, 'record_sale');
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
-- SECTION 4: record_payment
--
-- `017`'s version plus the same guard. Note what the replay skips: the
-- outstanding-balance check. That is correct — on a replay the payment is
-- already applied to the invoice, so re-testing it against the now-reduced
-- balance would reject a payment that succeeded.
--
-- `created_by` is still taken from the payload here, unlike record_sale. That
-- is `019`'s deliberate choice — `payments_insert` was verified working in
-- production and was left alone — and this file does not revisit it.
-- =============================================================================

create or replace function record_payment(p_payment jsonb)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_sale_id     bigint;
  v_amount      numeric;
  v_key         uuid;
  v_sale        sales;
  v_payment     payments;
  v_customer_id bigint;
  v_sale_json   jsonb;
  v_customer    jsonb;
begin
  v_sale_id := (p_payment ->> 'saleId')::bigint;
  v_amount  := (p_payment ->> 'amount')::numeric;
  v_key     := nullif(p_payment ->> 'client_key', '')::uuid;

  if v_key is not null then
    select * into v_payment from payments where client_key = v_key;
    if found then
      select to_jsonb(s) into v_sale_json from sales s where id = v_payment."saleId";
      return jsonb_build_object(
        'payment',  to_jsonb(v_payment),
        'sale',     v_sale_json,
        'customer', recompute_customer_balance(v_payment."customerId"),
        'replayed', true
      );
    end if;
  end if;

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

  if v_amount > (v_sale.total - coalesce(v_sale.paid, 0)) then
    raise exception 'record_payment: amount % exceeds the outstanding balance of % on this invoice',
      v_amount, (v_sale.total - coalesce(v_sale.paid, 0));
  end if;

  v_customer_id := v_sale."customerId";

  begin
    insert into payments ("saleId", "customerId", date, amount, method, reference, created_by, client_key)
    values (
      v_sale_id,
      v_customer_id,
      coalesce((p_payment ->> 'date')::date, current_date),
      v_amount,
      nullif(p_payment ->> 'method', ''),
      nullif(p_payment ->> 'reference', ''),
      nullif(p_payment ->> 'created_by', '')::uuid,
      v_key
    )
    returning * into v_payment;
  exception when unique_violation then
    select * into v_payment from payments where client_key = v_key;
    if not found then
      raise;
    end if;
    select to_jsonb(s) into v_sale_json from sales s where id = v_payment."saleId";
    return jsonb_build_object(
      'payment',  to_jsonb(v_payment),
      'sale',     v_sale_json,
      'customer', recompute_customer_balance(v_payment."customerId"),
      'replayed', true
    );
  end;

  -- Explicit order: the sale's `paid` must be updated before the balance is
  -- derived from it.
  v_sale_json := adjust_sale_paid(v_sale_id, v_amount);
  v_customer  := recompute_customer_balance(v_customer_id);

  return jsonb_build_object(
    'payment',  to_jsonb(v_payment),
    'sale',     v_sale_json,
    'customer', v_customer
  );
end;
$$;


-- =============================================================================
-- SECTION 5: record_production
--
-- `015`'s version plus the same guard. This is the one where a duplicate costs
-- the most: a repeated run deducts the whole bill of materials a second time
-- and credits finished goods that were never made, so the stock error compounds
-- across every raw material in the recipe.
--
-- The replay returns current stock rather than re-running the BOM, so a retry
-- moves nothing.
-- =============================================================================

create or replace function record_production(p_log jsonb)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_items     jsonb;
  v_key       uuid;
  v_log       production_logs;
  v_changes   jsonb;
  v_inventory jsonb;
begin
  v_items := coalesce(p_log -> 'items', '{}'::jsonb);
  v_key   := nullif(p_log ->> 'client_key', '')::uuid;

  if v_key is not null then
    select * into v_log from production_logs where client_key = v_key;
    if found then
      return jsonb_build_object(
        'production', to_jsonb(v_log),
        'inventory',  current_inventory(),
        'replayed',   true
      );
    end if;
  end if;

  if jsonb_typeof(v_items) <> 'object' then
    raise exception 'record_production: items must be a JSON object of size -> cartons';
  end if;

  if exists (select 1 from jsonb_each_text(v_items) where value::numeric < 0) then
    raise exception 'record_production: carton counts cannot be negative';
  end if;

  if not exists (select 1 from jsonb_each_text(v_items) where value::numeric <> 0) then
    raise exception 'record_production: at least one size must have a non-zero carton count';
  end if;

  -- Validate the recipe BEFORE inserting, so an unknown size gives a clean error
  -- rather than an aborted transaction half-way through.
  v_changes := production_bom_changes(v_items, 1);

  -- id is database-assigned (004b). created_by is taken from the session, not
  -- the payload — production_logs_insert (012) depends on it being honest.
  begin
    insert into production_logs (date, items, unit, notes, casuals, created_by, client_key)
    values (
      coalesce((p_log ->> 'date')::date, current_date),
      v_items,
      coalesce(nullif(p_log ->> 'unit', ''), 'cartons'),
      nullif(p_log ->> 'notes', ''),
      coalesce(p_log -> 'casuals', '[]'::jsonb),
      auth.uid(),
      v_key
    )
    returning * into v_log;
  exception when unique_violation then
    select * into v_log from production_logs where client_key = v_key;
    if not found then
      raise;
    end if;
    return jsonb_build_object(
      'production', to_jsonb(v_log),
      'inventory',  current_inventory(),
      'replayed',   true
    );
  end;

  if jsonb_array_length(v_changes) > 0 then
    v_inventory := apply_inventory_deltas(v_changes);
  end if;

  return jsonb_build_object(
    'production', to_jsonb(v_log),
    'inventory',  v_inventory
  );
end;
$$;


commit;


-- =============================================================================
-- AFTER APPLYING — verify it landed, then prove it actually deduplicates.
--
-- 1. The three columns exist and are uuid. Expect three rows:
--
--      select table_name, column_name, data_type
--        from information_schema.columns
--       where table_schema = 'public' and column_name = 'client_key'
--       order by table_name;
--
-- 2. The three unique indexes exist and are PARTIAL. Each `indexdef` must end
--    in `WHERE (client_key IS NOT NULL)` — a non-partial index here would be a
--    different and much worse thing, since every pre-021 row is NULL:
--
--      select tablename, indexdef from pg_indexes
--       where schemaname = 'public' and indexname like '%client_key_uniq'
--       order by tablename;
--
-- 3. The functions carry the guard, and `020`'s assertion survived section 3's
--    rewrite. Expect `t` for both columns on record_sale:
--
--      select proname,
--             pg_get_functiondef(p.oid) ilike '%client_key%'                as has_guard,
--             pg_get_functiondef(p.oid) ilike '%assert_stock_not_negative%' as keeps_020
--        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--       where n.nspname = 'public'
--         and proname in ('record_sale','record_payment','record_production')
--       order by proname;
--
--    `keeps_020` is `f` for record_payment and record_production — correct,
--    neither ever called it. It must be `t` for record_sale.
--
-- 4. No existing row was touched. Expect zero on all three:
--
--      select (select count(*) from sales           where client_key is not null),
--             (select count(*) from payments        where client_key is not null),
--             (select count(*) from production_logs where client_key is not null);
--
-- FUNCTIONAL TESTING — in the app, as a real logged-in user. The replay path
-- cannot be exercised from the SQL Editor: `auth.uid()` is NULL there, so the
-- INSERT is refused by RLS long before any of this is reached.
--
--   A. ORDINARY SALE (expect success, unchanged): record a sale. It saves once.
--      Confirm the key was stored, not dropped:
--        select id, client_key from sales order by id desc limit 1;
--
--   B. DOUBLE-TAP (expect ONE sale): open a sale, tap Save twice as fast as
--      possible. This is the reported bug. With the client fix live the second
--      tap never fires; with this migration live it would be harmless anyway.
--      Expect exactly one new row.
--
--   C. THE REAL TEST — RETRY AFTER A LOST RESPONSE. This is what the migration
--      is for and it is worth the trouble of staging properly:
--        1. Open a sale form and fill it in. Do not save.
--        2. Turn the device's wifi/data OFF.
--        3. Tap Save. Wait for the "connection was lost" message (20 seconds).
--        4. Turn the connection back ON.
--        5. Tap Save again on the same still-open form.
--      Expect: "This sale was already recorded as invoice N." — OR an ordinary
--      successful save if the first attempt never reached the server. Either is
--      correct. What must NOT happen is two invoices for one form.
--      Then confirm: select count(*) from sales where client_key = '<the key>';
--      Expect 1. The browser console logs the payload if you need the key.
--
--   D. PRODUCTION REPLAY (expect stock to move ONCE): repeat C on a production
--      run, then check finished goods and the raw materials in that recipe.
--      The BOM must have been applied one time, not two.
--
--   E. TWO GENUINELY SEPARATE SALES (expect TWO sales): record the same
--      customer, items and amount twice, closing and reopening the form in
--      between. Both must save. If this produces one sale, the key is being
--      reused across forms and that is a serious bug — it would silently
--      swallow real second sales to the same customer. Check `handleAddSale`
--      calls `newClientKey()`.
--
-- ROLLBACK. The functions revert by re-applying `020` section 2 (record_sale),
-- `017`'s record_payment and `015` section 3 (record_production). Leave the
-- columns and indexes in place if you do — they constrain nothing on their own,
-- and dropping a column from `sales` in a live ledger is not worth it.
-- =============================================================================

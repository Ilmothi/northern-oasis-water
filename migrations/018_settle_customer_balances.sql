-- =============================================================================
-- 018_settle_customer_balances.sql
-- Northern Water Company Ltd — OASIS Springs
--
-- Corrects five customer balances that disagree with the sales ledger behind
-- them: KES 5,450 of understated debt, all at Loglogo.
--
-- **Applying this raises Debtors and Aging Debtors by KES 5,450.** That is the
-- whole point of the file, not a side effect. Cash Collected and the P&L do not
-- read `customers.balance` and are unaffected. Decide that the Debtors report
-- SHOULD go up by 5,450 before you apply — it should: the invoices behind it
-- were always right, and it is the balance column that has been wrong since
-- before `011`.
--
-- WHY THIS IS A SEPARATE FILE
-- ---------------------------
-- It was written as section 8 of `017`, but `017` had already been applied to
-- production by then. Adding a statement to an applied file would leave the
-- repo's record disagreeing with the database — which is the exact failure this
-- directory's README exists to prevent. So it was extracted, and `017` now
-- matches what was applied on 2026-08-01 statement for statement.
--
-- THE HISTORY, BECAUSE IT DECIDES HOW THIS ONE IS VERIFIED
-- --------------------------------------------------------
-- These same five customers, with these same stored values and these same
-- deltas, were found on 2026-07-28 and **recorded as corrected** via
-- `adjust_customer_balance`. Re-running the reconciliation on 2026-08-01
-- returned them unchanged. The correction never landed. The statement was
-- written and reported as run, and nobody queried the table afterwards to
-- check — the same failure mode as the `010` partial apply.
--
--       id   name                 location  stored  derived   delta
--       97   NICONDEMUS GITONGA   Loglogo      300    -2220   -2520
--       31   JANE KOROLLE         Loglogo    -2160    -3840   -1680
--       36   AHATHO EYSIMKELE     Loglogo        0     -420    -420
--       128  MADINA EYSIMFECHA    Loglogo        0     -420    -420
--       32   IRENE KASULA         Loglogo    -1640    -2050    -410
--                                                    total:   -5450
--
-- This attempt is verifiable by construction, which the last one was not: the
-- figure is DERIVED rather than applied as a delta, so re-running is a no-op
-- (a delta double-applies, which is why the 2026-07-28 statement had to be
-- written as self-recomputing in the first place), and the verification query at
-- the foot is the same query that found the problem. It cannot half-land, and it
-- cannot be believed done while undone.
--
-- REQUIRES `017`. Do not apply this against a database where `balance` is still
-- client-writable — it would correct the figures and then let them drift again.
-- Block 0a below checks that.
-- =============================================================================


-- =============================================================================
-- BLOCK 0 — PRE-FLIGHT. Read-only. Run and read BEFORE applying.
--
-- 0a. Confirm 017 is live. `recompute_customer_balance` must exist and be
--     SECURITY DEFINER; `adjust_customer_balance` must be gone; `get_my_role` is
--     the control and must be unchanged, which proves you are connected to the
--     right database. Expect exactly 3 rows.
--
--       select proname, prosecdef, proconfig
--         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--        where n.nspname = 'public'
--          and proname in ('recompute_customer_balance',
--                          'adjust_customer_balance',
--                          'get_my_role',
--                          'record_sale')
--        order by proname;
--
--     Expect: get_my_role                 t  {"search_path=public"}
--             recompute_customer_balance  t  {"search_path=public, pg_temp"}
--             record_sale                 f  {"search_path=public, pg_temp"}
--     and NO adjust_customer_balance row.
--
--     Also confirm `balance` is not client-writable — expect five rows, none of
--     them `balance`:
--
--       select column_name from information_schema.column_privileges
--        where table_name = 'customers' and grantee = 'authenticated'
--          and privilege_type = 'UPDATE'
--        order by column_name;
--
-- 0b. See exactly what will move, and by how much. Read the total before you
--     apply — it is the amount the Debtors report will change by.
--
--       select c.id, c.name, c.location,
--              coalesce(c.balance, 0)                          as stored,
--              coalesce(d.derived, 0)                          as derived,
--              coalesce(d.derived, 0) - coalesce(c.balance, 0) as delta
--         from customers c
--         left join lateral (
--                select -coalesce(sum(s.total - coalesce(s.paid, 0)), 0) as derived
--                  from sales s where s."customerId" = c.id
--              ) d on true
--        where coalesce(c.balance, 0) <> coalesce(d.derived, 0)
--        order by abs(coalesce(d.derived, 0) - coalesce(c.balance, 0)) desc;
--
--     Expect the five rows above. FEWER than five is normal and not a problem:
--     `balance` has been derived since 017, so any of these customers who has
--     transacted since then has already settled themselves. MORE than five, or
--     different customers, means something new — stop and understand it, because
--     after 017 nothing should be able to make a balance drift.
-- =============================================================================


begin;


-- =============================================================================
-- SECTION 1: settle every customer whose balance disagrees with their ledger
--
-- WHY THIS IS A PLAIN UPDATE and not `select recompute_customer_balance(id)
-- from customers;` — that call CANNOT succeed here. A migration is applied from
-- the SQL Editor, where there is no JWT, so `auth.uid()` is NULL,
-- `get_my_role()` returns NULL, and 017's read gate refuses. That is finding
-- 14's testing trap seen from the other side: a correct gate refuses the SQL
-- Editor, so anything a migration needs to do must run as the owner rather than
-- be routed through a gated function. Attempting the function call would raise
-- "recompute_customer_balance: not permitted" and roll the file back — safe,
-- but confusing enough to be worth the paragraph.
--
-- Audit-neutral: it writes only the figure the sales ledger already implies. No
-- stock moves, no financial record is created, edited or deleted, and the
-- invoices and payments it derives from are untouched — so this does not need to
-- go through the Stock Adjustments-style audit flow that a real correction
-- would. It is repairing a cache, not restating the books.
--
-- Idempotent: `is distinct from` limits it to rows that actually move, so a
-- re-run updates nothing. The row count the editor reports IS the number of
-- corrected customers — read it. Expect 5, or fewer per block 0b.
-- =============================================================================

update customers c
   set balance = d.derived
  from (
    select cc.id,
           -coalesce((select sum(s.total - coalesce(s.paid, 0))
                        from sales s where s."customerId" = cc.id), 0) as derived
      from customers cc
  ) d
 where d.id = c.id
   and coalesce(c.balance, 0) is distinct from d.derived;


commit;


-- =============================================================================
-- AFTER APPLYING — this is not optional.
--
-- The 2026-07-28 attempt at this same correction was believed done for four days
-- because nobody ran this query. Run it.
--
-- 1. Every balance agrees with its ledger. Expect ZERO rows, immediately:
--
--      select c.id, c.name, coalesce(c.balance, 0) as stored,
--             coalesce(d.derived, 0)               as derived
--        from customers c
--        left join lateral (
--               select -coalesce(sum(s.total - coalesce(s.paid, 0)), 0) as derived
--                 from sales s where s."customerId" = c.id
--             ) d on true
--       where coalesce(c.balance, 0) <> coalesce(d.derived, 0);
--
--    Rows here mean the UPDATE did not do what it claims. Do not re-run the
--    file hoping it takes — find out why first.
--
-- 2. The five are individually correct:
--
--      select id, name, balance from customers
--       where id in (97, 31, 36, 128, 32) order by id;
--
--    Expect: 31 JANE KOROLLE −3840, 32 IRENE KASULA −2050,
--            36 AHATHO EYSIMKELE −420, 97 NICONDEMUS GITONGA −2220,
--            128 MADINA EYSIMFECHA −420.
--
-- 3. In the app: Debtors and Aging Debtors are KES 5,450 higher than before.
--    Cash Collected and the P&L are unchanged — if either moved, something in
--    this file did more than it was supposed to.
--
-- 4. From this point the query in step 1 should return zero rows permanently.
--    `balance` is not client-writable after 017 and every write to it derives
--    from the ledger. If it ever returns rows again, that is a NEW defect and
--    not residue — treat it as one.
-- =============================================================================

-- ============================================================================
-- THE BALANCE RECONCILIATION -- the standing control on balance drift.
-- READ-ONLY. Makes NO changes. Safe to run on production at any time.
-- Paste into the Supabase SQL Editor.
--
-- This is the maintained successor to `025` check 4, which was designated the
-- permanent drift control and is now TWO-TERM and out of date. `027` added a
-- third term to the balance formula and did not extend it, so the old query
-- reports every adjusted customer as drift. Finding 4 of
-- `docs/audit-2026-09-08.md`. Run THIS one; do not run `025` check 4.
--
-- WHY THIS EXISTS. Balance drift is the recurring defect in this system's
-- history: `018` was written for it, `017` made the figure derived-on-write
-- because of it, and one account is still out. A formula with three terms and
-- no detector is how the next one goes unnoticed.
--
-- WHEN THE FORMULA CHANGES AGAIN, CHANGE THIS FILE IN THE SAME MIGRATION.
-- A fourth term added without touching this query silently disables it: the
-- query keeps returning rows, the rows get dismissed as known, and the control
-- is gone without anyone deciding to remove it. That is exactly how the
-- two-term version stopped working.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- A. THE RECONCILIATION. Every customer whose stored balance disagrees with
--    the three terms that derive it.
--
--    EXPECT: id 97 (understated by KES 2,520, pre-existing and known) and
--    NOTHING ELSE. Any other row is a real defect -- do not dismiss it.
--
--    LAST RUN 2026-09-16 against production: returned id 97 and nothing else.
--    Update this line when you run it again; a control nobody records running
--    decays into a file nobody runs.
--
--    The three terms mirror `recompute_customer_balance` exactly
--    (`027:246`-`027:310`). If you change one, change the other:
--      v_sales  = -sum(total - paid) over all the customer's sales
--      v_credit =  sum(amount) over payments with a null "saleId"
--      v_adjust =  sum(amount) over customer_adjustments
-- ----------------------------------------------------------------------------
select c.id, c.name, c.location, c.balance,
       coalesce(s.unpaid, 0)                                          as from_sales,
       coalesce(p.credit, 0)                                          as from_credit,
       coalesce(a.adj, 0)                                             as from_adjustments,
       coalesce(s.unpaid, 0) + coalesce(p.credit, 0) + coalesce(a.adj, 0) as derived,
       c.balance - (coalesce(s.unpaid, 0) + coalesce(p.credit, 0) + coalesce(a.adj, 0)) as drift
  from customers c
  left join lateral (select -coalesce(sum(s.total - coalesce(s.paid, 0)), 0) as unpaid
                       from sales s where s."customerId" = c.id) s on true
  left join lateral (select coalesce(sum(p.amount), 0) as credit
                       from payments p
                      where p."customerId" = c.id and p."saleId" is null) p on true
  left join lateral (select coalesce(sum(a.amount), 0) as adj
                       from customer_adjustments a
                      where a."customerId" = c.id) a on true
 where c.balance is distinct from
       (coalesce(s.unpaid, 0) + coalesce(p.credit, 0) + coalesce(a.adj, 0))
 order by abs(c.balance - (coalesce(s.unpaid, 0) + coalesce(p.credit, 0) + coalesce(a.adj, 0))) desc;


-- ----------------------------------------------------------------------------
-- B. NOBODY'S CREDIT IS NEGATIVE. Carried forward from `025` check 5 -- still
--    correct, still two-term-free, and the function raises on this condition,
--    so a row here means something wrote around the function.
--
--    EXPECT: no rows, now and forever.
-- ----------------------------------------------------------------------------
select "customerId", sum(amount) as credit
  from payments
 where "saleId" is null
 group by "customerId"
having sum(amount) < 0;


-- ----------------------------------------------------------------------------
-- C. WHAT THE ADJUSTMENT TERM IS MADE OF. Not a drift check -- context for
--    reading A. A balance that looks wrong is often an adjustment nobody
--    remembers posting, and A cannot tell you that on its own.
--
--    EXPECT: the Loglogo corrections entered 2026-09-02, and whatever has been
--    posted since.
-- ----------------------------------------------------------------------------
select a.id, a."customerId", c.name, c.location,
       a.kind, a.amount, a.reason, a.date, a.created_at
  from customer_adjustments a
  join customers c on c.id = a."customerId"
 order by a.created_at desc;

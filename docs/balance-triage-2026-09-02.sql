-- =============================================================================
-- balance-triage-2026-09-02.sql
-- Northern Water Company Ltd — OASIS Springs
--
-- READ-ONLY. Every statement here is a SELECT. Nothing is written, nothing is
-- locked, and it is safe to run against production during working hours.
--
-- PURPOSE
-- -------
-- Build the worklist for the balance corrections on 15+ LOGLOGO accounts, from
-- data entry errors made in JUNE 2026 when the system was new. Three error
-- classes were reported: duplicate invoices, unentered payments, and payments
-- entered for the wrong amount. The correct balances are known from the manual
-- book, so BLOCK F is the one that turns that book into a correction list.
--
-- JUNE MATTERS — there is a fourth error class in that month
-- ----------------------------------------------------------
-- Until 2026-06-18, sales and payments were inserted with a CLIENT-generated id
-- (`Math.max(visible rows) + 1`). A sales-role user only loads their own
-- location's rows, so that id collided with a row at another branch and the
-- INSERT was silently rejected: the record showed on the rep's screen and was
-- never persisted. See migrations/003_db_generated_ids.sql. Sales for
-- 2026-06-14 and 2026-06-16 are known to have been lost this way and were never
-- reconstructed.
--
-- So a June discrepancy is not necessarily a typing error. It can be a record
-- that VANISHED — including whole invoices, not just payments. Two consequences:
--
--   * A missing INVOICE makes the system show LESS debt than the book. A
--     missing PAYMENT makes it show MORE. Block F's `direction` column tells
--     you which, per account, and that is the fastest triage you have.
--   * Some "duplicates" in block B are probably this bug too: the save appeared
--     to fail, so it was entered again, and sometimes both landed.
--
-- BLOCK G looks at the affected window directly.
--
-- Run each block in the Supabase SQL editor and keep the output. Block F gives
-- the target; A, B, C and D explain how each account got where it is, which
-- decides how it gets fixed.
--
-- Re-run block F after the corrections. It is the verification step, and it is
-- the step that has been skipped twice in this database's history: a balance
-- correction on 2026-07-28 was recorded as applied and had not landed, and it
-- was only caught by introspecting the live state months later.
--
-- LOCATION SCOPE
-- --------------
-- Every block is filtered to Loglogo by the line
--
--     and c.location ilike 'loglogo%'
--
-- Run BLOCK 0 first to confirm how that value is actually spelled here. To
-- widen a block to the whole company, delete its filter line. The filter is on
-- the CUSTOMER's location, which is what a balance belongs to, so it still
-- catches an account whose sales were keyed at another branch.
--
-- BACKGROUND — how balance is defined (migration 017, amended by 025)
-- ------------------------------------------------------------------
--     balance = -sum(sales.total - sales.paid)               -- unpaid invoices
--             + sum(payments.amount where "saleId" is null)  -- credit held
--
-- Negative = the customer owes us. `customers.balance` is a DERIVED cache, not
-- a figure anyone sets by hand: every money path calls
-- recompute_customer_balance(), so a hand-set value is overwritten the next
-- time that customer trades. That is why the correction has to be made in the
-- records underneath, and why the book figure is used as the TARGET to assert
-- against rather than as a value to write.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- BLOCK 0 — confirm the location spelling before trusting any filter below
-- -----------------------------------------------------------------------------
select coalesce(location, '(null)')          as location,
       count(*)                              as customers,
       count(*) filter (where balance < 0)   as owing
  from customers
 group by location
 order by customers desc;


-- -----------------------------------------------------------------------------
-- BLOCK A — stored balance vs what the records currently support
--
-- Any row here is an account whose cached balance disagrees with its own sales
-- and payments. Expect this to be SHORT even though 15+ accounts are wrong: a
-- duplicate invoice or a missing payment makes the balance a faithful reading
-- of bad data, so the cache still agrees with it. Rows here are the separate,
-- older stale-cache problem — id 97 is the known one.
-- -----------------------------------------------------------------------------
select c.id,
       c.name,
       c.location,
       c.balance                                     as stored,
       coalesce(s.unpaid, 0) + coalesce(p.credit, 0) as derived,
       coalesce(s.unpaid, 0) + coalesce(p.credit, 0) - c.balance as delta,
       coalesce(p.credit, 0)                         as credit_held
  from customers c
  left join lateral (
       select -coalesce(sum(s.total - coalesce(s.paid, 0)), 0) as unpaid
         from sales s where s."customerId" = c.id
  ) s on true
  left join lateral (
       select coalesce(sum(p.amount), 0) as credit
         from payments p
        where p."customerId" = c.id and p."saleId" is null
  ) p on true
 where c.balance is distinct from (coalesce(s.unpaid, 0) + coalesce(p.credit, 0))
   and c.location ilike 'loglogo%'
 order by abs(coalesce(s.unpaid, 0) + coalesce(p.credit, 0) - c.balance) desc;


-- -----------------------------------------------------------------------------
-- BLOCK B — candidate duplicate invoices
--
-- Same customer, same date, same total, entered more than once. Candidates, not
-- proof: a customer genuinely can buy the same order twice in one day. Check
-- each against the book before deleting anything.
--
-- IMPORTANT: a duplicate invoice double-deducted its cartons too, so finished
-- goods have been understated by that amount ever since. Removing the duplicate
-- gives those cartons back — the correct outcome, not a new error.
-- -----------------------------------------------------------------------------
select s."customerId",
       c.name,
       s.date,
       s.total,
       count(*)                                     as times_entered,
       array_agg(s.id order by s.id)                as sale_ids,
       array_agg(s."invoiceNumber" order by s.id)   as invoices,
       array_agg(coalesce(s.paid, 0) order by s.id) as paid_each
  from sales s
  join customers c on c.id = s."customerId"
 where c.location ilike 'loglogo%'
 group by s."customerId", c.name, s.date, s.total
having count(*) > 1
 order by s.date desc, s.total desc;


-- -----------------------------------------------------------------------------
-- BLOCK C — invoices whose `paid` disagrees with the payment rows behind them
--
-- Where "payment entered for the wrong amount" surfaces. `paid` is what the
-- invoice claims was received; the sum of linked payment rows is what was
-- actually recorded as arriving.
--
--   paid > payments  -> the invoice is credited with money that has no receipt
--                       behind it. This OVERSTATES cash collected.
--   paid < payments  -> receipts exist that never reached the invoice.
--
-- Credit-application legs are included deliberately: on an invoice they are
-- real settlement. Their draining leg names no sale and cannot appear here.
--
-- NOTE: a payment never entered AT ALL will not appear here — the invoice and
-- its absent payment rows agree at zero. Those are found by block E.
-- -----------------------------------------------------------------------------
select s.id                                             as sale_id,
       s."invoiceNumber",
       s.date,
       c.name,
       s.total,
       coalesce(s.paid, 0)                              as paid_on_invoice,
       coalesce(pay.received, 0)                        as payment_rows,
       coalesce(s.paid, 0) - coalesce(pay.received, 0)  as gap,
       coalesce(pay.n, 0)                               as n_payments
  from sales s
  join customers c on c.id = s."customerId"
  left join lateral (
       select sum(p.amount) as received, count(*) as n
         from payments p where p."saleId" = s.id
  ) pay on true
 where coalesce(s.paid, 0) is distinct from coalesce(pay.received, 0)
   and c.location ilike 'loglogo%'
 order by abs(coalesce(s.paid, 0) - coalesce(pay.received, 0)) desc;


-- -----------------------------------------------------------------------------
-- BLOCK D — impossible states worth clearing before you start
--
-- D1. Negative credit pool. recompute_customer_balance() REFUSES to run for
--     such a customer, so their balance cannot be repaired and any sale or
--     payment against them will fail outright. Fix these first.
-- -----------------------------------------------------------------------------
select p."customerId",
       c.name,
       sum(p.amount) as credit_pool
  from payments p
  join customers c on c.id = p."customerId"
 where p."saleId" is null
   and c.location ilike 'loglogo%'
 group by p."customerId", c.name
having sum(p.amount) < 0;

-- D2. Overpaid invoices — paid exceeds the total. Usually a wrong payment
--     amount, and it drags the customer's balance positive.
select s.id as sale_id, s."invoiceNumber", s.date, c.name,
       s.total, s.paid, s.paid - s.total as overpaid
  from sales s
  join customers c on c.id = s."customerId"
 where coalesce(s.paid, 0) > s.total
   and c.location ilike 'loglogo%'
 order by (s.paid - s.total) desc;

-- D3. Sales linked to consignment stock. These CANNOT be reversed like an
--     ordinary sale — their cartons were deducted at DELIVERY, not at the sale,
--     so returning stock here would inflate the counts. If one of the
--     duplicates in block B appears in this list, say so before it is touched.
select m.sale_id, s."invoiceNumber", s.date, c.name, s.total
  from consignment_movements m
  join sales s     on s.id = m.sale_id
  join customers c on c.id = s."customerId"
 where m.sale_id is not null
   and c.location ilike 'loglogo%'
 order by s.date desc;


-- -----------------------------------------------------------------------------
-- BLOCK E — working sheet: every Loglogo invoice still showing unpaid
--
-- Check this against the book. An unentered payment shows up here as an invoice
-- that looks outstanding but is not. Nothing in the database can find those on
-- its own, because the evidence that they were paid does not live in it.
--
-- Restricted to invoices dated on or after 2026-06-01. Change the date to widen.
-- -----------------------------------------------------------------------------
select c.id                          as customer_id,
       c.name,
       s.id                          as sale_id,
       s."invoiceNumber",
       s.date,
       s.total,
       coalesce(s.paid, 0)           as paid,
       s.total - coalesce(s.paid, 0) as outstanding
  from sales s
  join customers c on c.id = s."customerId"
 where s.total - coalesce(s.paid, 0) > 0
   and s.date >= '2026-06-01'
   and c.location ilike 'loglogo%'
 order by c.name, s.date;


-- -----------------------------------------------------------------------------
-- BLOCK F — the book vs the system: fill this in, and it becomes the worklist
--
-- Put the manual book's figure for each account into the VALUES list below, in
-- the system's sign convention: NEGATIVE means the customer owes us, positive
-- means they hold credit. So a customer who owes 2,220 in the book is -2220.
--
-- Get the customer ids from block 0 / block A, or add the name column and match
-- by eye first. Then send me this output — it is exactly what the correction
-- migration needs, and its `to_move` column is the amount each account has to
-- shift, which is the check that the corrections add up before anything is run.
--
-- Nothing here writes. The book figure is only ever compared, never stored.
-- -----------------------------------------------------------------------------
with book(customer_id, book_balance) as (
  values
    -- (customer_id, book_balance)   -- replace these with the real figures
      (97,   -2220.00),
      (31,   -3840.00)
    -- , (36,  -420.00)
    -- , (128, -420.00)
)
select b.customer_id,
       c.name,
       c.location,
       c.balance                          as system_balance,
       b.book_balance                     as book_balance,
       b.book_balance - c.balance         as to_move,
       case
         when b.book_balance = c.balance                    then 'agrees'
         when b.book_balance < c.balance                    then 'system shows too little debt'
         else                                                    'system shows too much debt'
       end                                as direction
  from book b
  join customers c on c.id = b.customer_id
 order by abs(b.book_balance - c.balance) desc;


-- -----------------------------------------------------------------------------
-- BLOCK G — the June silent-loss window (see the header note on migration 003)
--
-- G1. Daily entry counts across June, company-wide. The client-id collision bug
--     ran until 2026-06-18. A day with far fewer sales than its neighbours, or
--     none at all, is a day whose entries were silently rejected. 2026-06-14 and
--     2026-06-16 are the known casualties; the 15th and 17th were never
--     confirmed either way, so check their counts against the book too.
--
--     Not location-filtered on purpose: the collision was caused by rows at
--     OTHER branches, so the shape of the whole month is the useful picture.
-- -----------------------------------------------------------------------------
select d.day::date                                        as day,
       count(s.id)                                        as sales_entered,
       coalesce(sum(s.total), 0)                          as sales_value,
       count(distinct s."customerId")                     as customers
  from generate_series('2026-06-01'::date, '2026-06-30'::date, interval '1 day') d(day)
  left join sales s on s.date = d.day::date
 group by d.day
 order by d.day;

-- G2. The same for payments — a payment lost to the collision leaves an invoice
--     looking unpaid that the book shows as settled.
select d.day::date               as day,
       count(p.id)               as payments_entered,
       coalesce(sum(p.amount), 0) as payments_value
  from generate_series('2026-06-01'::date, '2026-06-30'::date, interval '1 day') d(day)
  left join payments p on p.date = d.day::date
 group by d.day
 order by d.day;

-- G3. Every Loglogo sale dated inside the risk window, with what it claims was
--     paid. This is the sheet to read against the book page for June: an invoice
--     the book has and this list does not is a lost sale to re-enter; an invoice
--     here that the book shows as settled is a lost payment.
select c.id                          as customer_id,
       c.name,
       s.id                          as sale_id,
       s."invoiceNumber",
       s.date,
       s.total,
       coalesce(s.paid, 0)           as paid,
       s.total - coalesce(s.paid, 0) as outstanding
  from sales s
  join customers c on c.id = s."customerId"
 where s.date between '2026-06-01' and '2026-06-30'
   and c.location ilike 'loglogo%'
 order by s.date, c.name;

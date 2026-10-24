-- =============================================================================
-- 030_invoice_number_overflow.sql
-- Northern Water Company Ltd — OASIS Springs
--
-- Fixes the invoice-number default, which has been stamping the literal string
-- 'INV-###' onto every sale since the 1,000th one, and renumbers the sales that
-- already carry it.
--
-- WHY THIS EXISTS
-- ---------------
-- `003_db_generated_ids.sql` moved invoice numbering into the database:
--
--     set default 'INV-' || to_char(nextval('public.sales_invoice_seq'), 'FM000')
--
-- and its own comment recorded the intent as "FM000 = min 3 digits, grows
-- beyond 3 without truncating — matches the old padStart(3,'0')".
--
-- That is not what `to_char` does. A numeric template in `to_char` is a FIXED
-- WIDTH. A value that does not fit is not widened — PostgreSQL returns a row of
-- '#' characters instead, which is its documented way of signalling overflow:
--
--     select to_char(999,  'FM000');   -- '999'
--     select to_char(1000, 'FM000');   -- '###'      <-- the bug
--
-- So invoice 1,000 and every invoice after it was written to the table as the
-- literal text 'INV-###'. Reported from production on 2026-10-24: invoice
-- numbers "showing ###" on sales from 2026-10-06 onwards.
--
-- This is a numbering fault, not a money fault. No total, balance, payment,
-- stock movement or P&L figure is wrong because of it. What IS wrong is that
-- many sales to many different customers share one invoice number, so a printed
-- invoice no longer identifies the sale it came from — which matters for
-- reconciliation and for a KRA audit.
--
-- The disappearing-sales half of the same report has a DIFFERENT cause with the
-- same trigger (the client never paged past PostgREST's 1,000-row cap, so it
-- stopped fetching sales at exactly the same sale). That half is fixed in the
-- client, not here. Both symptoms surfaced on one date because both are tripped
-- by sale number 1,000.
--
-- SCOPE
-- -----
--   * Section 1: the `sales."invoiceNumber"` default is rewritten with `lpad`,
--     which pads to 3 and then grows without limit — what `003` intended.
--   * Section 2: a new table `invoice_renumber_log`, RLS enabled and its policy
--     defined here (never in a follow-up), holding the old -> new mapping.
--   * Section 3: the overflowed rows are renumbered in `id` order.
--   * Section 4: the sequence is moved FORWARD only, never back.
--   * No change to any amount, date, customer, status, stock figure, policy or
--     function. No change to how a balance or a report is computed.
--
-- THIS FILE EDITS A FINANCIAL RECORD, WHICH IS NORMALLY FORBIDDEN
-- --------------------------------------------------------------
-- `CLAUDE.md` says never to directly edit financial records. Section 3 does
-- edit `sales`, and that is deliberate and authorised by the owner on
-- 2026-10-24. The justification is narrow: `"invoiceNumber"` is a LABEL, and
-- the label currently on these rows was never a valid invoice number — it is an
-- overflow marker emitted by a broken default. Writing a real number is a
-- repair of a field that never held data, not a restatement of a transaction.
--
-- Nothing that carries value is touched. Payment allocation, deletion and
-- reversal all key on `sales.id`, never on the invoice number, so renumbering
-- cannot move money or relink a payment.
--
-- CONSEQUENCE YOU MUST PLAN FOR: invoices and delivery notes already PRINTED
-- and handed to customers between 2026-10-06 and the day this is applied say
-- 'INV-###'. After this runs, the system says something else for those sales.
-- Reprint them from Sales -> the sale -> Print Invoice, and keep the mapping in
-- `invoice_renumber_log` (section 2) as the bridge between the two.
--
-- NUMBERING: GAPS ARE PREFERRED TO REUSE
-- --------------------------------------
-- Every overflowed sale still consumed a real `nextval`, and so did any sale
-- that was later deleted. Those consumed numbers cannot be recovered from the
-- table. Section 3 therefore renumbers from the highest surviving valid number
-- (999) upwards in `id` order, and section 4 leaves the sequence wherever it has
-- already reached if that is higher.
--
-- If no sale was ever deleted the result is gapless. If sales WERE deleted, new
-- invoices resume above the gap rather than filling it. That is the intended
-- trade: a gap in invoice numbering is ordinary and harmless, whereas reissuing
-- a number that a deleted invoice once carried would put one number on two
-- different documents, which is the thing an audit cannot tolerate.
--
-- IDEMPOTENT
-- ----------
-- Yes. After section 3 no row matches its WHERE clause, so a second run updates
-- nothing and logs nothing. Section 4 only ever moves the sequence forward.
-- =============================================================================

begin;

-- ---------------------------------------------------------------------------
-- SECTION 1: the default — fixed-width to_char -> lpad, which grows
--
-- lpad(n::text, 3, '0') is exactly the old client-side padStart(3, '0'):
--     5 -> '005',  999 -> '999',  1000 -> '1000',  12345 -> '12345'
-- It pads up to 3 characters and returns longer values untouched. There is no
-- width past which it fails, which is the property `003` believed it was
-- getting from 'FM000'.
-- ---------------------------------------------------------------------------
alter table public.sales
  alter column "invoiceNumber"
  set default 'INV-' || lpad(nextval('public.sales_invoice_seq')::text, 3, '0');

comment on column public.sales."invoiceNumber" is
  'Invoice number, assigned by the database from sales_invoice_seq as '
  'INV-<zero-padded to at least 3 digits>. Never set by the client. Do not '
  'format this with to_char(..., ''000'') — a fixed-width numeric template '
  'returns ''###'' once the value outgrows it (see migration 030).';

-- ---------------------------------------------------------------------------
-- SECTION 2: the audit trail for the renumber
--
-- A printed invoice number that a customer holds is being changed. That has to
-- leave a permanent record, so the mapping goes in a table rather than in the
-- SQL Editor's scrollback.
--
-- RLS: enabled, with a single admin-only SELECT policy and NO insert, update or
-- delete policy at all. No client role can write to or alter this log through
-- the API; only a migration run in the SQL Editor (which bypasses RLS as the
-- table owner) can, and only by appending. The gate is written against
-- get_my_role() in a USING clause, where a NULL role from a missing profiles
-- row evaluates to NULL and the row is withheld — fail-closed. (In a
-- SECURITY DEFINER plpgsql IF, the same NULL would fail OPEN; that trap is
-- documented in 027 and is why nothing here is a DEFINER function.)
-- ---------------------------------------------------------------------------
create table if not exists public.invoice_renumber_log (
  id          bigint generated always as identity primary key,
  sale_id     bigint      not null references public.sales(id),
  sale_date   text,
  old_number  text,
  new_number  text        not null,
  migration   text        not null,
  applied_at  timestamptz not null default now()
);

comment on table public.invoice_renumber_log is
  'Append-only record of invoice numbers reassigned by a migration. Written by '
  'migration 030, which replaced the overflow marker ''INV-###'' on sales from '
  'the 1000th onwards. Read it to match a pre-030 printed invoice to the number '
  'the system now holds for that sale.';

alter table public.invoice_renumber_log enable row level security;

drop policy if exists invoice_renumber_log_select_admin on public.invoice_renumber_log;
create policy invoice_renumber_log_select_admin
  on public.invoice_renumber_log
  for select
  using (public.get_my_role() = 'admin');

-- ---------------------------------------------------------------------------
-- SECTION 3: renumber the overflowed rows, in id order, and log the mapping
--
-- `id` order, not date order: the invoice number records the order invoices
-- were ISSUED, and a sale's date is picked by the clerk and can be backdated.
-- `id` is the order the rows were actually written.
--
-- `base` reads the high-water mark from the rows whose numbers are still VALID
-- only. That matters: regexp_replace('INV-###', '\D', '', 'g') is the empty
-- string, and ''::int raises, so the broken rows must never reach the cast.
--
-- One statement, so `base` is computed against the same snapshot the UPDATE
-- writes, and the log cannot end up disagreeing with the table.
-- ---------------------------------------------------------------------------
with base as (
  select coalesce(max((regexp_replace("invoiceNumber", '\D', '', 'g'))::int), 0) as high
    from public.sales
   where "invoiceNumber" ~ '^INV-[0-9]+$'
),
renumbered as (
  select s.id,
         s.date::text                        as sale_date,
         s."invoiceNumber"                   as old_number,
         'INV-' || lpad((base.high + row_number() over (order by s.id))::text, 3, '0')
                                             as new_number
    from public.sales s
   cross join base
   where s."invoiceNumber" is null
      or s."invoiceNumber" !~ '^INV-[0-9]+$'
),
upd as (
  update public.sales s
     set "invoiceNumber" = r.new_number
    from renumbered r
   where s.id = r.id
  returning s.id
)
insert into public.invoice_renumber_log (sale_id, sale_date, old_number, new_number, migration)
select r.id, r.sale_date, r.old_number, r.new_number, '030'
  from renumbered r
 where exists (select 1 from upd u where u.id = r.id);

-- ---------------------------------------------------------------------------
-- SECTION 4: move the sequence forward past everything now in the table
--
-- `greatest` is the whole point of this section. The sequence has already been
-- advanced once per overflowed sale AND once per sale that was later deleted,
-- so it may legitimately stand higher than the highest number in the table.
-- Setting it to max+1 unconditionally could hand a future sale a number that a
-- deleted invoice already carried. This only ever raises it.
--
-- is_called = true, so the next nextval() returns the stored value + 1.
-- ---------------------------------------------------------------------------
select setval(
  'public.sales_invoice_seq',
  greatest(
    (select last_value from public.sales_invoice_seq),
    (select coalesce(max((regexp_replace("invoiceNumber", '\D', '', 'g'))::int), 0)
       from public.sales
      where "invoiceNumber" ~ '^INV-[0-9]+$')
  ),
  true
);

commit;

-- =============================================================================
-- VERIFY AFTER APPLYING
--
-- Run these as the SQL Editor (not as a logged-in app user — the log table is
-- admin-only through the API and the Editor bypasses RLS).
--
-- Check 1 — the overflow is gone. MUST return 0.
--
--   select count(*) as still_broken
--     from public.sales
--    where "invoiceNumber" is null
--       or "invoiceNumber" !~ '^INV-[0-9]+$';
--
-- Check 2 — every invoice number is now unique. MUST return no rows.
--   (It will NOT return rows for pre-1000 history either; if it does, that is a
--   separate pre-existing duplicate and worth knowing about.)
--
--   select "invoiceNumber", count(*)
--     from public.sales
--    group by "invoiceNumber"
--   having count(*) > 1
--    order by 2 desc;
--
-- Check 3 — the mapping was recorded, and its size matches what was repaired.
--   The two numbers MUST be equal, and the count MUST match how many sales were
--   recorded from 2026-10-06 onwards.
--
--   select (select count(*) from public.invoice_renumber_log where migration = '030') as logged,
--          (select count(*) from public.invoice_renumber_log
--            where migration = '030' and old_number = 'INV-###')                      as from_overflow;
--
--   select sale_id, sale_date, old_number, new_number
--     from public.invoice_renumber_log
--    where migration = '030'
--    order by sale_id
--    limit 20;
--
-- Check 4 — the next number the database will issue is above every number in
--   the table. `next_issue` MUST be greater than `highest_in_table`.
--   NOTE: this CONSUMES a sequence value, so the first real sale after you run
--   it skips one number. That is harmless (see "GAPS ARE PREFERRED TO REUSE").
--
--   select (select max((regexp_replace("invoiceNumber", '\D', '', 'g'))::int)
--             from public.sales)                                as highest_in_table,
--          (select nextval('public.sales_invoice_seq'))          as next_issue;
--
-- Check 5 — the default itself is fixed. The returned text MUST contain `lpad`
--   and MUST NOT contain `to_char`. Reported as a single row with a verdict so
--   the Editor cannot hide it by showing only the last result set.
--
--   select case
--            when d like '%lpad%' and d not like '%to_char%' then 'PASS'
--            else 'FAIL — default is still ' || coalesce(d, '<none>')
--          end as verdict
--     from (select pg_get_expr(ad.adbin, ad.adrelid) as d
--             from pg_attrdef ad
--             join pg_attribute a
--               on a.attrelid = ad.adrelid and a.attnum = ad.adnum
--            where ad.adrelid = 'public.sales'::regclass
--              and a.attname  = 'invoiceNumber') t;
--
-- Check 6 — the format actually widens now. Does not touch the table.
--   MUST return INV-005, INV-999, INV-1000, INV-12345.
--
--   select 'INV-' || lpad(n::text, 3, '0') as formatted
--     from (values (5), (999), (1000), (12345)) v(n);
--
-- Check 7 — the log is not writable through the API. As a logged-in ADMIN in
--   the app's browser console (not the SQL Editor), an insert MUST be refused:
--
--     await supabase.from('invoice_renumber_log')
--       .insert([{ sale_id: 1, new_number: 'X', migration: 'hack' }])
--   Expect an RLS error. A success means a write policy was added by mistake.
-- =============================================================================

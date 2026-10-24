-- =============================================================================
-- 031_invoice_number_lpad_truncation.sql
-- Northern Water Company Ltd — OASIS Springs
--
-- Repairs migration `030`, which replaced one fixed-width formatting bug with
-- another and assigned 28 invoice numbers to 271 sales.
--
-- ✅ APPLIED 2026-10-24, the same day as `030`, with every check below reported
-- passing by the operator — including check 1 (the formatter at nine widths) and
-- check 5's `distinct_new = repaired = span` triple, which is the test that
-- fails loudly on precisely the bug this file repairs.
--
-- (The urgency this was written under, kept for the record: `030`'s default was
-- live and stamping a truncated, colliding number on every new sale, so the
-- repair set grew with every sale recorded. Trading did not need to stop — the
-- amounts, allocations and stock were correct throughout and only the label was
-- wrong.)
--
-- WHAT `030` GOT WRONG
-- --------------------
-- `030` correctly diagnosed `to_char(n, 'FM000')` as a FIXED-WIDTH template that
-- returns '###' when the value outgrows it. It then replaced it with:
--
--     'INV-' || lpad(nextval('public.sales_invoice_seq')::text, 3, '0')
--
-- believing `lpad` pads to 3 and leaves longer values alone. It does not.
-- PostgreSQL's `lpad` is documented as: "If the string is already longer than
-- length then it is truncated (on the right)."
--
--     select lpad('5',    3, '0');   -- '005'     correct
--     select lpad('999',  3, '0');   -- '999'     correct
--     select lpad('1000', 3, '0');   -- '100'     TRUNCATED
--     select lpad('1270', 3, '0');   -- '127'     TRUNCATED
--
-- So `030` swapped a formatter that mangles values above 999 for a different
-- formatter that mangles values above 999. The analysis was right and the fix
-- reproduced the bug it was fixing.
--
-- WHAT THAT DID TO THE DATA
-- -------------------------
-- `030`'s anchor was correct (999), and `row_number()` correctly produced
-- 1..271 for the 271 overflowed rows, giving the intended 1000..1270. Every one
-- was then truncated to its first three characters:
--
--     1000..1009  ->  'INV-100'      (10 rows)
--     1010..1019  ->  'INV-101'      (10 rows)
--     ...
--     1260..1269  ->  'INV-126'      (10 rows)
--     1270        ->  'INV-127'      (1 row)
--
-- 27 numbers with 10 rows each plus one with 1 = 271 rows over 28 numbers. The
-- 24 legitimate early sales that already held INV-100..INV-127 then make the
-- observed counts: 23 numbers with 11, 4 with 10, and INV-127 with 2 — 295 rows
-- in all, which is exactly what check 2 returned on 2026-10-24.
--
-- WHAT IT DID NOT DO
-- ------------------
-- Nothing was destroyed, and no valid number was overwritten. `030`'s WHERE
-- clause only matched rows failing `^INV-[0-9]+$` — rows holding the overflow
-- marker. All 271 of them carried the IDENTICAL string 'INV-###' beforehand, so
-- there was no distinct identity to lose: the information content of those
-- labels was already zero. `invoice_renumber_log` records every row `030`
-- touched, so the repair set is known by name and not by inference.
--
-- Money was never involved. Allocation, deletion and reversal all key on
-- `sales.id`. No amount, balance, payment, stock figure or report total has
-- moved at any point in this episode.
--
-- SCOPE
-- -----
--   * Section 1: `format_invoice_number(bigint)` — a PURE, IMMUTABLE formatter
--     that pads to 3 and never truncates. Testable without touching a table,
--     which is the whole point.
--   * Section 2: `next_invoice_number()` — calls `nextval` exactly once and
--     formats it. The column default becomes this function.
--   * Section 3: re-numbers every row `030` mis-numbered, plus every sale
--     recorded since under the broken default, from above the sequence.
--   * Section 4: sequence moved forward past the block just issued.
--   * No change to any amount, balance, date, status, stock figure, policy or
--     other function. No change to how a balance or a report is computed.
--
-- WHY A FUNCTION AND NOT A LONGER EXPRESSION
-- ------------------------------------------
-- The formatting has to be correct at every width, and the only way to know it
-- is to run it at every width. A column default cannot be tested without
-- inserting a row and consuming a sequence value; `format_invoice_number` can
-- be tested by selecting from a VALUES list, costing nothing and touching
-- nothing. Check 1 below does exactly that, and it is the check that would have
-- caught BOTH this bug and the one in `003`.
--
-- Splitting the pure formatter from the sequence call is what makes that
-- possible. `next_invoice_number()` must call `nextval` exactly once, which is
-- also why this cannot be written inline: a default with `greatest(3,
-- length(nextval(...)::text))` would call `nextval` twice and burn a number on
-- every insert, and a column default may not contain a sub-select.
--
-- IDEMPOTENT
-- ----------
-- Yes, and by construction rather than by luck. Section 3 selects rows whose
-- number is still at or below 999; everything it repairs comes out at 1289 or
-- above, so a second run matches nothing.
-- =============================================================================

begin;

-- ---------------------------------------------------------------------------
-- SECTION 1: the pure formatter
--
-- Pads to a minimum of three digits and NEVER truncates, at any width. The
-- explicit `case` is deliberate: it does not rely on remembering the edge
-- behaviour of a formatting function, which is the mistake `003` and `030` each
-- made in turn. `lpad` is only reached on the branch where the value provably
-- fits in three characters.
--
-- IMMUTABLE, so it can be used in an index or a generated column later, and so
-- the planner can fold it in verification queries.
-- ---------------------------------------------------------------------------
create or replace function public.format_invoice_number(n bigint)
returns text
language sql
immutable
strict
as $$
  select 'INV-' || case
                     when n < 1000 then lpad(n::text, 3, '0')
                     else n::text
                   end;
$$;

comment on function public.format_invoice_number(bigint) is
  'Formats an invoice number: pads to at least 3 digits, never truncates at any '
  'width. Pure and side-effect free, so it can be tested across widths without '
  'touching a table or consuming a sequence value. Do NOT reimplement this as '
  'to_char(n, ''000'') (returns ''###'' above 999 — migration 003) or as '
  'lpad(n::text, 3, ''0'') (TRUNCATES above 999 — migration 030).';

-- ---------------------------------------------------------------------------
-- SECTION 2: the sequence-consuming wrapper, and the column default
--
-- `nextval` is called EXACTLY ONCE per invocation. VOLATILE, because it has a
-- side effect; SECURITY INVOKER (the default), so the caller's own privileges
-- on the sequence apply exactly as they did when the default called `nextval`
-- directly. Nothing here is SECURITY DEFINER, so the null-role gate trap
-- documented in `027` and the README does not arise.
-- ---------------------------------------------------------------------------
create or replace function public.next_invoice_number()
returns text
language sql
volatile
as $$
  select public.format_invoice_number(nextval('public.sales_invoice_seq'));
$$;

comment on function public.next_invoice_number() is
  'Issues the next invoice number. Calls nextval exactly once. This is the '
  'default for sales."invoiceNumber" from migration 031 onwards.';

grant execute on function public.format_invoice_number(bigint) to authenticated;
grant execute on function public.next_invoice_number()        to authenticated;

alter table public.sales
  alter column "invoiceNumber"
  set default public.next_invoice_number();

comment on column public.sales."invoiceNumber" is
  'Invoice number, assigned by the database via next_invoice_number(). Never '
  'set by the client. Formatting lives in format_invoice_number(bigint) so that '
  'it can be tested at every width — see migration 031.';

-- ---------------------------------------------------------------------------
-- SECTION 3: re-number everything the broken formatter touched
--
-- THE REPAIR SET is every row that either
--   (a) appears in `invoice_renumber_log` for migration '030' — the 271 rows it
--       mis-numbered, known by name rather than guessed at; or
--   (b) has an id above the highest id `030` logged — i.e. was recorded AFTER
--       `030` ran, and so was numbered by its truncating default.
--
-- (b) is safe to express with an id comparison because every sale from
-- 2026-10-06 onwards was overflowed, so the highest id `030` logged was also
-- the highest id in the table at that moment. Anything above it is newer.
--
-- ...AND WHOSE NUMBER IS STILL AT OR BELOW 999. This is the idempotency guard
-- and it is what keeps the 24 legitimate early sales holding INV-100..INV-127
-- untouched — they are in neither (a) nor (b) — while making a second run of
-- this file a no-op, because everything repaired here lands at 1289 or above.
--
-- The guard is written as a CASE, not as `is null or !~ ... or ...::int <= 999`.
-- PostgreSQL does not promise left-to-right evaluation of OR, so the cast in
-- that form could still meet a non-numeric value and raise. CASE does promise
-- it. (The same trap the README records for `to_char`: do not rely on what a
-- construct happens to do, use the one that is defined to do it.)
--
-- Numbers are issued from above the SEQUENCE, not from the top of the table.
-- The sequence stood at 1288 with the table's highest valid number at 999, so
-- the repaired block starts at 1289 and cannot collide with the legitimate
-- 1..999 history, with the truncated block, or with itself.
-- ---------------------------------------------------------------------------
with bounds as (
  select
    -- NULL when migration '030' logged nothing, and that NULL is LOAD-BEARING.
    -- `s.id > NULL` is NULL, which is not true, so the (b) half of the repair
    -- set collapses to empty and this file becomes a no-op on a database 030
    -- never touched. Do NOT coalesce this to 0: `s.id > 0` is true for every
    -- sale, which would renumber the entire table — including the legitimate
    -- 1..999 history this file exists to protect.
    (select max(sale_id)
       from public.invoice_renumber_log
      where migration = '030')                              as max_logged,
    greatest(
      (select last_value from public.sales_invoice_seq),
      (select coalesce(max(
                 case when "invoiceNumber" ~ '^INV-[0-9]+$'
                      then (regexp_replace("invoiceNumber", '\D', '', 'g'))::int
                 end), 0)
         from public.sales)
    )                                                        as high
),
target as (
  select s.id,
         s.date::text                 as sale_date,
         s."invoiceNumber"            as old_number,
         public.format_invoice_number(
           b.high + row_number() over (order by s.id)
         )                            as new_number
    from public.sales s
   cross join bounds b
   where (
           s.id in (select sale_id
                      from public.invoice_renumber_log
                     where migration = '030')
           or s.id > b.max_logged
         )
     and case
           when s."invoiceNumber" is null                   then true
           when s."invoiceNumber" !~ '^INV-[0-9]+$'          then true
           else (regexp_replace(s."invoiceNumber", '\D', '', 'g'))::int <= 999
         end
),
upd as (
  update public.sales s
     set "invoiceNumber" = t.new_number
    from target t
   where s.id = t.id
  returning s.id
)
insert into public.invoice_renumber_log (sale_id, sale_date, old_number, new_number, migration)
select t.id, t.sale_date, t.old_number, t.new_number, '031'
  from target t
 where exists (select 1 from upd u where u.id = t.id);

-- ---------------------------------------------------------------------------
-- SECTION 4: move the sequence past the block just issued
--
-- Section 3 handed out numbers above `last_value` without consuming them, so
-- the sequence must now be advanced past them or the next real sale would
-- reissue one. `greatest` keeps it monotonic, as in `030`.
-- ---------------------------------------------------------------------------
select setval(
  'public.sales_invoice_seq',
  greatest(
    (select last_value from public.sales_invoice_seq),
    (select coalesce(max(
               case when "invoiceNumber" ~ '^INV-[0-9]+$'
                    then (regexp_replace("invoiceNumber", '\D', '', 'g'))::int
               end), 0)
       from public.sales)
  ),
  true
);

commit;

-- =============================================================================
-- VERIFY AFTER APPLYING
--
-- Check 1 — THE ONE THAT MATTERS. The formatter is correct at every width.
--   Pure arithmetic: touches no table and consumes no sequence value, which is
--   why there is no excuse for not having run it before shipping 003 or 030.
--   MUST return 'PASS' on a single row.
--
--   select case when count(*) filter (where got <> want) = 0
--               then 'PASS'
--               else 'FAIL: ' || string_agg(n || ' -> ' || got || ' (want ' || want || ')',
--                                           ', ') filter (where got <> want)
--          end as verdict
--     from (
--       select n,
--              public.format_invoice_number(n) as got,
--              want
--         from (values (1,    'INV-001'),
--                      (5,    'INV-005'),
--                      (99,   'INV-099'),
--                      (100,  'INV-100'),
--                      (999,  'INV-999'),
--                      (1000, 'INV-1000'),     -- 003 gave INV-###, 030 gave INV-100
--                      (1270, 'INV-1270'),     -- 030 gave INV-127
--                      (1289, 'INV-1289'),
--                      (12345,'INV-12345')) v(n, want)
--     ) t;
--
-- Check 2 — no duplicate invoice numbers anywhere in the table. MUST return no
--   rows. Unlike 030's check 2 this is NOT scoped: after this file there is no
--   known-bad block left to exclude, so the whole table should be clean. If it
--   returns rows, read them — do not scope the check to hide them.
--
--   select "invoiceNumber", count(*)
--     from public.sales
--    group by "invoiceNumber"
--   having count(*) > 1
--    order by 2 desc;
--
-- Check 3 — nothing is left holding an overflow marker or a null. MUST be 0.
--
--   select count(*) as unnumbered
--     from public.sales
--    where "invoiceNumber" is null
--       or "invoiceNumber" !~ '^INV-[0-9]+$';
--
-- Check 4 — the 24 legitimate early sales kept their numbers. These are the
--   rows that held INV-100..INV-127 before 030 and are in neither repair set.
--   `touched_by_031` MUST be 0.
--
--   select count(*) as touched_by_031
--     from public.invoice_renumber_log l
--    where l.migration = '031'
--      and l.sale_id not in (select sale_id from public.invoice_renumber_log
--                             where migration = '030')
--      and l.sale_id <= (select max(sale_id) from public.invoice_renumber_log
--                         where migration = '030');
--
-- Check 5 — the repair set was what was expected. `repaired` should be 271 plus
--   however many sales were recorded between 030 and this file. `first_new` MUST
--   be 1289 and the block MUST be contiguous.
--
--   select count(*)                                                      as repaired,
--          min((regexp_replace(new_number, '\D', '', 'g'))::int)         as first_new,
--          max((regexp_replace(new_number, '\D', '', 'g'))::int)         as last_new,
--          count(distinct new_number)                                    as distinct_new,
--          max((regexp_replace(new_number, '\D', '', 'g'))::int)
--            - min((regexp_replace(new_number, '\D', '', 'g'))::int) + 1 as span
--     from public.invoice_renumber_log
--    where migration = '031';
--
--   `distinct_new` MUST equal `repaired` MUST equal `span`. That triple is what
--   would have caught 030 on the day: it had repaired = 271, distinct_new = 28.
--
-- Check 6 — the default is the function, not an inline formatter. MUST be PASS.
--
--   select case when d = 'next_invoice_number()' then 'PASS' else 'FAIL: ' || d end as verdict
--     from (select pg_get_expr(ad.adbin, ad.adrelid) as d
--             from pg_attrdef ad
--             join pg_attribute a
--               on a.attrelid = ad.adrelid and a.attnum = ad.adnum
--            where ad.adrelid = 'public.sales'::regclass
--              and a.attname  = 'invoiceNumber') t;
--
--   (pg_get_expr prints the default schema-qualified or not depending on
--   search_path; if it comes back as 'public.next_invoice_number()' that is the
--   same thing and still a PASS.)
--
-- Check 7 — the next number the database will issue is clear of the table.
--   Reads last_value rather than calling nextval, so it consumes nothing.
--   `seq_at` MUST be >= `highest_in_table`.
--
--   select (select max((regexp_replace("invoiceNumber", '\D', '', 'g'))::int)
--             from public.sales
--            where "invoiceNumber" ~ '^INV-[0-9]+$')         as highest_in_table,
--          (select last_value from public.sales_invoice_seq) as seq_at;
--
-- Check 8 — one real insert, end to end. Do this LAST and as an admin, in the
--   app: record a genuine sale through the Sales form and confirm its invoice
--   number reads INV-1xxx with four digits and no '#'. Checks 1 and 6 prove the
--   parts; this proves the whole path, which is what neither 003 nor 030 ever
--   had done to them.
--
-- THE REPRINT POSITION, which has now changed twice:
--   * Invoices printed 2026-10-06 to the day 030 was applied read 'INV-###'.
--   * Invoices printed between 030 and this file read a truncated INV-1xx that
--     up to ten other sales also carry.
--   Both sets are superseded by the numbers this file assigns.
--   `invoice_renumber_log` holds both hops: migration '030' maps '###' to the
--   truncated value, migration '031' maps the truncated value to the final one.
--   Join them on `sale_id` to trace any printed document to the sale it belongs
--   to.
-- =============================================================================

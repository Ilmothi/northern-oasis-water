# Migrations

SQL for the Supabase (PostgreSQL) database behind the Northern Water / OASIS
Springs app. There is **no migration runner and no ledger table** — each file is
reviewed and applied by hand in the Supabase SQL Editor, and this directory is
the only record of what the schema should look like.

That is why the conventions below matter: the files themselves have to carry the
information a tool would otherwise track.

## Apply order

**Apply in filename order.** `004a` then `004b` then `005`, and so on.

Every file is idempotent except where noted, so applying the whole directory in
order against a fresh database is the supported way to rebuild the schema.

## What has been applied to production

⚠️ **Do not trust this table alone.** On 2026-07-30 the RLS audit found that
`010` had been applied only *partially* while this file recorded it as fully
live — its policy sections landed, its two function redefinitions did not.
Nothing here is verified against the database automatically. When it matters,
check the live catalog: `pg_policies` for policies and **`pg_proc` for
functions** (`prosecdef`, `proconfig`). See `docs/audit-2026-07-30-rls.md`.

📏 **The standing balance check is `docs/balance-reconciliation.sql`.**
It reconciles `customers.balance` against all THREE terms that derive it and is
the maintained successor to `025` check 4, which is two-term and now reports
every adjusted customer as drift. Run the file; do not run `025` check 4.
**If a migration changes the balance formula again, change that file in the same
migration** — a term added without it silently disables the only drift detector
this system has. Finding 4 of `docs/audit-2026-09-08.md`.
Last run 2026-09-16: returned id 97 only, as expected.

| File | What it does |
|------|--------------|
| `001_rls_policies.sql` | RLS enabled and policies defined for all twelve tables; `get_my_role()` / `get_my_location()` helpers |
| `002_employees_rls_sales_casual.sql` | Lets sales users read casual employees (needed for the production log) |
| `003_db_generated_ids.sql` | `sales.id`, `payments.id` become identity columns |
| `004a_production_logs_identity.sql` | `production_logs.id` → identity. **Superseded by `004b`** |
| `004b_db_generated_ids_production_purchases.sql` | `production_logs.id` and `purchases.id` → identity, idempotently |
| `005_customers_expenses_purchases_identity.sql` | `customers.id`, `expenses.id`, `purchases.id` → identity |
| `006_sales_record_production_and_inventory.sql` | Sales/production/inventory record-keeping changes |
| `007_sales_payment_method.sql` | Adds `sales.method` (how a point-of-sale amount was received) |
| `008_consignment.sql` | `customers.is_consignee` + the `consignment_movements` ledger, with RLS |
| `009_atomic_inventory.sql` | `apply_inventory_deltas` / `set_inventory_value` — fixes inventory lost-update drift |
| `010_inventory_and_consignment_authz.sql` | Admin-only absolute stock writes; sales role can apply stock deltas; reconcile and negative-total sales restricted to admin. **PARTIALLY APPLIED — sections 2 and 3 never landed; see below and `014`** |
| `011_transactional_money_operations.sql` | `record_sale`, `record_payment`, `delete_sale`, `delete_payment`, `consignment_post_sale` — makes every money operation a single transaction |
| `012_production_logs_sales_role.sql` | Sales role can log production and see its own runs |
| `013_remove_blanket_policies.sql` | Drops the `using(true)` policies that made RLS inert on 12 of 15 tables, and closes the profile privilege-escalation hole |
| `014_reapply_inventory_function_authz.sql` | Re-applies `010` sections 2–3, and corrects their null-role fail-open. Closed the stock-write outage |
| `015_atomic_production.sql` | `production_bom_changes`, `record_production`, `delete_production` — moves the BOM into the database and makes production logging a single transaction |
| `016_atomic_consignment_transfers.sql` | `consignment_move_stock` — makes consignment deliver and take-back single transactions, and moves both stock limits server-side |
| `017_customer_balance_and_write_scope.sql` | Makes `customers.balance` derived (`recompute_customer_balance` replaces `adjust_customer_balance`) and removes the client's UPDATE privilege on the column; adds location scope and `created_by` attribution to the `sales` and `payments` INSERT policies. Closes audit findings 1 and 3, and the forgeable/unscoped part of 2 |
| `019_server_side_attribution_and_payment_delete.sql` | Stamps `created_by` server-side in `record_sale` / `consignment_post_sale` and restores `017`'s `sales_insert_non_admin`; removes `delete_payment`'s `FOR UPDATE`, which had blocked all payment deletion since `013`; normalises a blank profile location |
| `020_no_negative_stock.sql` | Refuses any sale or production deletion that would drive finished goods below zero, using `016`'s post-change pattern |
| `021_idempotent_money_writes.sql` | Adds a `client_key` idempotency key to `sales`, `payments` and `production_logs`, so a save retried after a lost response returns the existing row instead of recording a duplicate. Rewrites the three `record_*` functions around it |
| `022_production_run_materials.sql` | Adds `production_run_materials(id)`, a read-only function returning the raw materials a production run consumed, for the production run card. Purely additive — one new function, no table, column, policy or existing function touched |
| `023_retire_stamps_and_ro_chemical.sql` | Redefines `production_bom_changes` without the KRA stamp and RO chemical lines — both materials are retired. **Changes the recipe**, so historical runs restate in the UI and reversing a pre-change run no longer credits either back. Leaves the `inventory_state` keys frozen rather than deleting them |
| `024_lump_sum_payments.sql` | `payments.batch_id` + `record_bulk_payment` / `delete_payment_batch`, so one receipt can settle several invoices in a single transaction. Every payment row still names a `saleId`, so nothing downstream changes shape. **Applied 2026-08-29**, probe-verified, PR #37 (`5658b7d`) |
| `025_on_account_credit.sql` | Overpayment becomes held credit. Adds `payments.kind`, makes `payments."saleId"` nullable, and **extends the balance formula** to `-sum(sales.total - sales.paid) + unapplied credit`. Adds `apply_credit`; guards `delete_payment` and `delete_sale` against stranding half a credit application. **Applied 2026-08-29**, probe-verified, PR #37 (`5658b7d`). 🛑 **Never re-apply** — `027` added a third term that a re-apply of this file would silently remove. Its check 4 is likewise superseded: use `docs/balance-reconciliation.sql` |
| `026_production_requires_materials.sql` | Refuses a production run that would drive any raw material below zero, by wiring `020`'s `assert_stock_not_negative` into `record_production` — the last decreasing write path without it. Closes the gap `020` deliberately deferred. No figure moved; it only refuses future writes. **Applied 2026-08-31**, PR #39 (`beb0ae9`) |
| `027_customer_adjustments.sql` | New `customer_adjustments` table (RLS + policies defined in the same file) and **a third term in the balance formula**: `-sum(unpaid invoices) + credit held + adjustments`. Adds admin-only `record_customer_adjustment` / `delete_customer_adjustment`, both failing CLOSED on a null role. Inert on apply — the term is zero until an adjustment is posted. Moved Debtors and Aging only; never Cash Collected, the P&L or stock. **Applied 2026-09-02**, PR #43 (`f77c7c2`); the Loglogo corrections were entered the same day |
| `028_atomic_payroll.sql` | Closes the payroll gap — finding 1 of `docs/audit-2026-09-08.md`, open since 2026-08-08. Unique index on `payroll_payments (type, employee_id, period_label)`, `expenses.client_key` for idempotency, and atomic `record_salary_payment` / `record_casual_payout`, so a Salary expense can no longer be left standing without its payroll row. Both gates fail CLOSED on a null role. Net pay, casual pay and the runs a payout covers are DERIVED server-side; the client sends its own figure only as a cross-check. No figure moves — it only refuses future duplicates. **Applied 2026-09-15**, ahead of its client (branch `guard-payroll`), which is the safe order and the one the file requires |
| `029_atomic_payroll_reversal.sql` | Findings 2 and 3 of `docs/audit-2026-09-17.md`. `delete_expense` makes the payroll REVERSE path one transaction — `028` made the write atomic and left this untouched, so deleting a payroll expense was N+2 unjoined round trips with no FK behind them; it is idempotent on purpose, so "delete it again, asking twice is safe" stays true. And `record_casual_payout` now evaluates the pay ONCE off the LOCKED run ids — it read the run set THREE times at three snapshots, so a run logged mid-transaction could be paid for and never flagged, and the expense could differ from the payroll rows it is the sum of. No figure moved. **Applied 2026-09-18.** Verified: check 4 (the arithmetic is unchanged — `differing_rows = 0` over `total_rows = 14` of live data, both directions) and check 2 (`locks_runs t, fails_closed t, reads_locked_ids t, reads_range_again f` — the last is finding 3 itself). The admin gate was seen failing CLOSED from a null-role session. **Checks 5, 6 and 6b were NOT run** — atomicity is structural (one plpgsql function, one transaction) but is not empirically proved. Its client merged FIRST, breaking expense deletion for a day; see below |

| `030_invoice_number_overflow.sql` | Fixes the `sales."invoiceNumber"` default, which `003` wrote as `to_char(nextval(...), 'FM000')` — a FIXED-WIDTH template, so from the 1,000th sale on it returned the overflow marker `###` and every invoice since 2026-10-06 was stamped `INV-###`. 🛑 **ITS FIX WAS ALSO BROKEN AND IT IS SUPERSEDED BY `031`. DO NOT RE-APPLY, DO NOT COPY FROM IT.** It rewrote the default as `lpad(n::text, 3, '0')` in the belief that `lpad` pads to 3 and then grows — `lpad` is fixed width too and **TRUNCATES** above 999, so the same class of bug one line later. **Applied 2026-10-24** before the defect was found, where it gave 271 sales just 28 distinct numbers (1000..1270 each cut to three characters) and left a default still mangling every new sale. The diagnosis of `003` in its header is correct and worth keeping; nothing else in it is. ⚠️ **Verified at apply time only by the `setval` result (1288)**, which proves the file reached its final statement and nothing more — had check 2 or a nine-width test of the formatter been run, this would have been caught on the day. See the `lpad` section below and `031` for the repair |

| `031_invoice_number_lpad_truncation.sql` | Repairs `030`. Splits invoice formatting into a PURE `format_invoice_number(bigint)` — pads to 3, never truncates, explicit `case` rather than a formatting function's edge behaviour — and a `next_invoice_number()` wrapper calling `nextval` exactly once, which becomes the column default. Renumbers the 271 rows `030` mis-numbered plus every sale recorded since under its broken default, from 1289 upwards, leaving the 24 legitimate early sales holding `INV-100`–`INV-127` untouched. Idempotent by construction: it only selects rows numbered at or below 999 and everything it repairs lands above that. No amount, balance, date, status, stock figure, policy or other function touched. **Applied 2026-10-24** and **reported by the operator as passing every check** — check 1 (the formatter at nine widths, including 1000, 1270 and 12345), check 2 (no duplicate invoice number anywhere in `sales`, unscoped), check 3 (nothing left holding `###` or null), check 4 (the legitimate early sales untouched), check 5 (`distinct_new = repaired = span`, the triple that would have caught `030` on the day), check 6 (the default is the function), check 7 (the sequence is clear of the table) and check 8 (a real sale recorded through the app) |

Apply dates were not recorded before this file existed. Known: `007` on
2026-07-02; `008` and `009` on 2026-07-22; `010`, `011` and `012` on 2026-07-28;
`013` on 2026-07-28 or shortly after (confirmed live by the 2026-07-30 audit);
`014`, `015` and `016` on 2026-07-31, all verified against `pg_proc` rather than
trusting the apply to have succeeded — `014`'s two inventory functions
`prosecdef = true` with `record_sale`/`get_my_role` unchanged as controls, and
`015`'s three plus `016`'s one all present and all `SECURITY INVOKER`. `016` was
additionally proved atomic against the live database: a refused call left the
`consignment_movements` count unchanged, where the code it replaces would have
committed the ledger row.
`019`, `020` and `021` on 2026-08-04, reported applied by the operator. **These
three have NOT been independently verified against `pg_proc` at the time of
writing** — run each file's own verification block before relying on this row.
That matters more than usual for `020`: it is written to REFUSE to apply while
finished goods are negative, so a successful apply implies the outstanding stock
reconciliation (0.5 L −24, 1.5 L −110) was completed first. If it was not, check
what actually landed before assuming the guard is live.

`021` was applied ahead of its client, which is the safe order for that file and
the one its header recommends — `client_key` simply stays NULL until the client
starts sending it, and the replay branch is never entered. Until PR for
`prevent-double-submit` merges, the idempotency half of `021` is inert and only
the double-tap guard is missing from production.

`017` on 2026-08-01, verified three ways: all five money functions confirmed
rewired onto `recompute_customer_balance` with none still referencing the dropped
`adjust_customer_balance`; the five column grants on `customers` present with
`balance` absent; and the two rewritten INSERT policies in `pg_policies`.
The rest were applied between 2026-06-12 and 2026-06-29, in filename order.

`015` and `016` were applied ahead of the clients that call them, which is the
safe order for those files — the new functions sat unused until
`record_production`, `delete_production` and `consignment_move_stock` shipped in
`src/App.jsx` (PRs #29 and #30, 2026-08-01). Deploying either client first would
have broken production logging or consignment transfers outright.

`017` is the opposite case and was applied in the wrong order — see the note
under 018 below.

**This table was itself wrong for a day**, and it is worth recording why. `016`
was applied on 2026-07-31 and verified, but the commit recording that never
reached `main`, so this file went on listing it as pending while its client was
live in production. Nothing broke — the migration really had been applied — but
for a day the only written record said consignment transfers should have been
failing. Re-verified against `pg_proc` on 2026-08-01 before this correction was
written, rather than trusting the commit message that had gone missing.

The lesson is not "remember to merge the commit". It is that **a record of what
is applied, kept in a branch, is not a record.** If you verify an apply, land
that verification on `main` in the same sitting.

`022` and `023` on 2026-08-14, both **verified by probing the live functions**
rather than trusting the apply, and every verification block in both files run
and passed. `023` is the first change to the recipe since `015` defined it:
`production_bom_changes('{"0.5L": 10}', 1)` now contains neither `kraStamps` nor
`roChemical`, the rest of the recipe is unchanged, and reversal is still
symmetric — a run recorded and deleted nets to zero.

Both were applied ahead of their client (`production-run-detail`), which is the
safe order for both. `022`'s function simply sits unused until the run card
ships. `023` is the more visible half: production stopped deducting stamps and
chemical immediately, while the client still displayed both tiles until the
branch merged, so the two quantities were briefly visible and frozen — which is
the intended failure mode, and the reason migration-first was chosen.

The two frozen `inventory_state` quantities should never move again. If the
pre-apply figures were not recorded, the values as at 2026-08-14 are the
baseline by default.

### Written but NOT yet applied

| File | What it does |
|------|--------------|
| `018_settle_customer_balances.sql` | 🛑 **DO NOT APPLY — superseded, and now actively destructive.** See the warning below |

`018` is the only file in this table, and it is not outstanding work — it is a
file that must never run. There is nothing here waiting to be applied.

The one piece of this episode still outstanding is **not** a migration: it is the
client-side paging fix in `src/App.jsx` (branch
`fix-invoice-overflow-and-row-cap`), without which production still reads only
the first 1,000 of 1,134 sales.

### `030` — applied 2026-10-24, client half NOT yet deployed

`030_invoice_number_overflow.sql` was applied by the operator on 2026-10-24, the
same day the fault was reported. See the row in the table above for what it
does.

**Its client half is still outstanding.** The pagination fix in `src/App.jsx`
(branch `fix-invoice-overflow-and-row-cap`) is committed but not merged, so
production is still subject to the row cap and still only sees the first 1,000
sales until that deploys or Max rows is raised.

That split is safe here, unlike `029`: the client calls no new function and
reads `"invoiceNumber"` as an opaque string, so either half works alone and
neither can break the other.

* Migration first (what happened) → printed invoice numbers are correct and
  unique, while sales past row 1,000 stay invisible until the client deploys.
* Client first → every sale reappears and the reports reconcile again, while the
  recent invoices still read `INV-###`.

**Scheduling note for the record, since it was not observed:** data loads once
per login, so a clerk already signed in held the old `INV-###` values in memory
across the renumber and could have printed one afterwards. Any invoice printed
on 2026-10-24 is worth re-checking against `invoice_renumber_log`.

⚠️ **`030`'s own check 3 was WRONG when it was applied** and has since been
corrected. It said "expect 135 rows renumbered", reasoning 1,134 sales minus 999
valid numbers. The live sequence disproved it: it stood at **1288** against 1,134
rows, so 154 numbers had already been spent on sales that no longer exist.
`nextval` is non-transactional — every sale this database ever REFUSED kept its
number (negative-stock guard, raw-material floor, overpayment guard, RLS
refusal, timeout), as did every deleted one. The repaired count is therefore 135
plus whatever share of those burns fell below 1000, which is not recoverable
from the table. **135 was a floor, not an expectation.** Check 3 now tests
identities (`logged = numbered_1000_up`, `first_new = 1000`,
`last_new = 999 + logged`) that hold whatever the burn count was.

Two consequences worth knowing:

* **Invoice numbering has always had gaps**, well before the overflow. This is
  not something `030` introduced.
* **There is a visible jump after the repaired block.** It ends around
  `INV-1134`; the next real sale gets about `INV-1289`. That is the burned
  numbers, it is correct, and it is not a new fault.

This is the third time this file has had to record the same lesson. `010` taught
it, `016` and `024`–`027` repeated it, and now `030`: **a figure derived by
arithmetic from two other figures is not a verification.** Check 3's constant was
reasoned, plausible and wrong, and only reading the live sequence showed it.
Prefer an identity that the data must satisfy over a number you worked out.

### ✅ CLOSED 2026-10-24 by `031`. Cause was `030` itself: `lpad` truncates

`031` was applied the same day and the operator reported every check passing,
including check 5's `distinct_new = repaired = span` triple — the one that fails
loudly on exactly this bug (`030` would have shown `repaired = 271,
distinct_new = 28`) — and check 2 unscoped across the whole table, so there is no
duplicate invoice number left anywhere in `sales`.

What follows is the record of the fault, kept because the episode cost three
migrations and the reasoning is the part worth not repeating.


**Cause confirmed 2026-10-24 from `invoice_renumber_log`:** `logged = 271`,
`first_new = 100`, `last_new = 127`. 271 rows, 28 distinct numbers. `030` did it.

`030` replaced `to_char(n, 'FM000')` — fixed width, returns `###` above 999 —
with `lpad(n::text, 3, '0')`, which is **also fixed width and truncates on the
right** above 999:

```sql
select lpad('999',  3, '0');   -- '999'   correct
select lpad('1000', 3, '0');   -- '100'   TRUNCATED
select lpad('1270', 3, '0');   -- '127'   TRUNCATED
```

`030`'s anchor (999) and its `row_number()` were both correct: it generated the
intended 1000..1270 and then truncated every value to three characters. 1000–1009
all became `INV-100`, 1010–1019 `INV-101`, through to 1270 → `INV-127`. That is
27 numbers holding 10 rows each plus one holding 1 = **271 rows over 28 numbers**.
The 24 legitimate early sales already holding `INV-100`–`INV-127` produce the
observed counts exactly: 23 numbers with 11, 4 with 10, `INV-127` with 2, 295 in
all.

**The withdrawn pre-`003` explanation was wrong, and the October date was the
clue that it was.** Those October rows were not survivors of an old fault; they
were sales `030` had just renumbered.

**`030`'s default was left broken and live.** Every sale recorded between the
apply and `031` is given a truncated number from
`lpad(nextval(...)::text, 3, '0')` — `nextval` 1289 produced `INV-128`. `031`
repairs those rows too, by the id test described in its section 3.

**Nothing was destroyed and no valid number was overwritten.** `030` only matched
rows failing `^INV-[0-9]+$`, and all 271 of them held the identical string
`INV-###` beforehand — there was no distinct identity to lose. Money was never
involved at any point: allocation, deletion and reversal all key on `sales.id`,
and no amount, balance, payment, stock figure or report total moved.

Reprints have now been invalidated twice — `INV-###` first, then a truncated
`INV-1xx` shared with up to ten other sales. `invoice_renumber_log` holds both
hops (`migration = '030'` then `'031'`, joinable on `sale_id`), so any printed
document can still be traced to its sale.

<details>
<summary>The original UNRESOLVED note, kept because the reasoning in it is the
part worth learning from</summary>


Found by running `030`'s check 2 against the whole `sales` table immediately
after applying `030`. It returned 28 numbers, **`INV-100` through `INV-127`,
carrying 295 rows between them** — 23 numbers with 11 rows each, 4 with 10, and
`INV-127` with 2.

**This is not understood yet. Do not act on it until it is.** What is known:

```
rows 295 · distinct numbers 28 · earliest 2026-06-01 · latest 2026-10-21
total KES 205,620
```

**A first explanation was written here and is now WITHDRAWN.** It said these
were pre-`003` rows from when the client generated invoice numbers against an
RLS-filtered subset of `sales` — which is a real hazard, named in `003`'s own
header as its reason for existing. The **`latest` date of 2026-10-21 refutes
it**: `003` was applied on 2026-06-18, so a row it left behind cannot carry an
October date. The pre-`003` story may still explain part of the set, but it
cannot explain the recent end of it.

What has been ruled out by reading the code rather than reasoning about it:

* **No client-side invoice numbering exists.** `grep` for `INV-`, `padStart(3`
  in `src/App.jsx`: nothing. The client never sends `"invoiceNumber"`.
* **No RPC sets it explicitly.** No `insert` in any migration names the column;
  `024`/`025` only read it for error messages. The column default is the only
  writer.

Which leaves the question open: with the sequence at 1288 and the default the
only source of values, **how does any row carry a number in the 100–127 range
with an October date?** Candidate lines of enquiry, none confirmed:

1. **`030`'s own renumber did it** — possible only if its anchor evaluated to 99.
   That requires no surviving row to have had a valid number above 99 at apply
   time, which is hard to square with 1,134 rows and a sequence at 1288. The
   version applied may not have carried the `greatest(999, ...)` guard added in
   `8160d66`. **Check `invoice_renumber_log` first — it records exactly what
   `030` assigned, which settles this one way or the other.**
2. **The sequence was reset at some point**, re-issuing a low block more than
   once. Repeated re-issue of 100–127 would produce roughly this shape.
3. **Rows were inserted by a path that bypasses the default** — a restore, a
   manual backfill, or a direct SQL insert naming the column.

The discriminating queries are at the end of this note. **`invoice_renumber_log`
is the first thing to read**: it exists precisely so the renumber's own output
can be audited, and it makes enquiry 1 a matter of fact rather than inference.

**Money is not affected either way.** Payment allocation, deletion and reversal
all key on `sales.id`; the invoice number is a label. Balances, the P&L, Cash
Collected and every stock figure are untouched. What is at stake is document
identity — 295 sales carrying KES 205,620 do not uniquely name themselves — and,
if enquiry 1 turns out to be the answer, the correctness of `030` itself.

Nothing is being repaired until the cause is known. A repair aimed at the wrong
cause would be a second renumber on top of a misunderstood first one.

```sql
-- 1. WHAT 030 ACTUALLY ASSIGNED. Read this before anything else.
select count(*) as logged,
       min((regexp_replace(new_number, '\D', '', 'g'))::int) as first_new,
       max((regexp_replace(new_number, '\D', '', 'g'))::int) as last_new
  from public.invoice_renumber_log
 where migration = '030';

-- 2. Per duplicate number: how many of its rows did 030 touch?
--    renumbered_by_030 = 0 everywhere  -> 030 is not involved, enquiry 2 or 3
--    renumbered_by_030 = 1 everywhere  -> 030 assigned into an occupied range
select s."invoiceNumber",
       count(*)            as rows,
       count(l.sale_id)    as renumbered_by_030,
       min(s.date)         as earliest,
       max(s.date)         as latest,
       min(s.id)           as min_id,
       max(s.id)           as max_id
  from public.sales s
  left join public.invoice_renumber_log l
         on l.sale_id = s.id and l.migration = '030'
 where s."invoiceNumber" in (
   select "invoiceNumber" from public.sales
    group by "invoiceNumber" having count(*) > 1)
 group by s."invoiceNumber"
 order by (regexp_replace(s."invoiceNumber", '\D', '', 'g'))::int;

-- 3. Is the block 030 assigned internally clean?
select "invoiceNumber", count(*) from public.sales
 where "invoiceNumber" ~ '^INV-[0-9]+$'
   and (regexp_replace("invoiceNumber", '\D', '', 'g'))::int >= 1000
 group by "invoiceNumber" having count(*) > 1;

-- 4. The shape of the whole numbering space, by era.
select case
         when n < 100  then '001-099'
         when n < 128  then '100-127  (the duplicated block)'
         when n < 1000 then '128-999'
         else '1000+'
       end as band,
       count(*) as rows, count(distinct n) as distinct_numbers,
       min(date) as earliest, max(date) as latest
  from (select (regexp_replace("invoiceNumber", '\D', '', 'g'))::int as n, date
          from public.sales
         where "invoiceNumber" ~ '^INV-[0-9]+$') t
 group by band order by band;
```

</details>

Remember that the stopgap for the client half is a dashboard setting
(**Settings → API → Max rows**), not a migration. Raising it makes the missing
sales reappear without a deploy, but it does not fix anything — it moves the
threshold. The paging in `fetchAllRows` is what actually removes the cap from the
picture, and it should stay in place whatever the setting says.

**Confirmed against production on 2026-10-24: 1,134 sales, Max rows 1000.** So
134 sales — about 12% of the book — were invisible to the app, and every
browser-computed report was short by whatever those rows contained.

One thing not to assume when reconciling that period: **the hidden rows were not
necessarily the newest 134.** Without an ORDER BY, PostgREST returns heap order,
and an UPDATE moves a row's heap position — every payment recorded against a
sale updates its `paid` and `status`. An older sale that was recently part-paid
could therefore have been hidden while a newer one was visible. The cut-off only
*looks* like 2026-10-06 because that is where the bulk of it falls.

### What the `029` apply cost, and why the ordering rule is in this file

`029` was applied on 2026-09-18 and has moved to the table above. It is recorded
here because the apply went wrong in a way worth not repeating.

**Its client merged first.** PR #58 landed on 2026-09-17, `main` auto-deploys,
and `handleDeleteExpense` calls `delete_expense` — which did not exist yet. **Every
expense delete in production failed for about a day** with `function
public.delete_expense(bigint) does not exist`. Nothing was corrupted: a delete
that cannot start cannot half-complete, and the old non-atomic path was already
gone from the client, so there was no partial unwind to clean up. It was an
outage on one path, not a data problem, and applying the file ended it.

This is the lesson `017` taught and this file already recorded: **an ordering
constraint stated only in a migration header is not a constraint.** `029`'s
header said "migration first, not optional" and it was read after the merge, not
before. Which is why the constraint now goes in the pending row above, where the
merge decision actually gets made.

**Two defects were found in `029`'s own verification block, both by running it
rather than reading it**, and both were invisible on the page:

- Checks 5 and 6 called `delete_expense` from a plain SQL Editor session, where
  `auth.uid()` is NULL, so `get_my_role()` is NULL and the admin gate **correctly
  refuses**. A correct gate presenting as a broken migration. They now impersonate
  (`set local role authenticated` + `request.jwt.claims`) and print
  `auth.uid()`/`get_my_role()` first to prove the impersonation took.
- Check 5 was six separate `select count(*)` statements in one transaction. The
  Supabase SQL Editor **shows only the last result set**, so it returned a bare
  `count: 0` and hid the five numbers that gave it meaning — and that 0 is
  trivially true for an expense with no linked runs, so it read as a pass while
  proving nothing. It is now three steps, each returning one row.

**A verification block is code.** Reading it proves nothing; only running it
finds this class of defect. Write the next one expecting to be wrong.

> **Corrected 2026-09-15.** This table listed `024`–`027` as pending for two
> weeks after all four went live — finding 2 of `docs/audit-2026-09-08.md`. They
> have now been confirmed applied and moved to the table above. The risk that
> created was not theoretical: re-applying `025` on the strength of this table
> would have silently reverted the balance formula to two terms and wiped the
> adjustment term `027` added.
>
> The lesson is `010`'s, again: **this file is a record of intent, not of
> production.** When it matters, check `pg_proc` and `pg_policies`.

### 🛑 `018_settle_customer_balances.sql` must not be applied

It hard-codes the ONE-term formula from `017`
(`balance = -sum(sales.total - sales.paid)`) and recomputes live rather than
replaying the July figures.

* After `025` it would **zero the credit term** for anyone holding credit.
* After `027` it would additionally **zero the adjustment term**, silently
  undoing every balance correction entered through the new flow — the exact
  corrections it was originally written to make.

Its "expect 5 rows" verification and per-id expected figures are also long out
of date: four of those five balances self-healed once `017` made the figure
derived-on-write, leaving only id 97. Anything it was meant to achieve is now
done by posting an adjustment through `027`. Keep the file for its history;
do not run it.

`019`, `020` and `021` moved to the applied table on 2026-08-04;
`022` and `023` on 2026-08-14. `024`, `025`, `026` and `027` were applied between
2026-08-29 and 2026-09-02 but were only **moved to the applied table on
2026-09-15**, a fortnight late — see the correction note above. `028` was applied
and recorded the same day, which is how it should go.

> **The notes that follow on `024`–`027` are pre-apply guidance, kept as
> history.** All four are live; nothing below is still to be done. The pre-flight
> queries and ordering constraints are preserved because they record *why* each
> was applied the way it was, not because anything remains outstanding.

`024` and `025` are the lump-sum payment work (branch `lump-sum-payments`).
**Both must be applied before that client merges** — `main` auto-deploys, and
the client calls `record_bulk_payment` and `apply_credit`, so merging first
breaks payment saving outright. This is the `015`/`016` ordering, not `017`'s.

`026` is a one-line behaviour change carrying a long header, because its risk is
operational rather than technical: once it is live, a wrong raw material figure
STOPS production instead of quietly going negative. Run its pre-flight `0b`
first — every row that query returns is a recipe line which will start refusing
runs on apply. It stands alone and blocks nothing else. No client change is
needed and none should be added; the client's stock figures are a login-time
snapshot, so a client-side pre-check would refuse runs the database accepts.

`024` is shippable on its own if `025` needs more review: lump sums that settle
exactly work, and overpayment keeps failing exactly as it does today.

`025` changes a formula rather than adding a function, which puts it in the same
class as `017` and deserves the same care. Two things before applying it:

- Run the **read-only pre-flight query at the head of the file**. Its shape
  constraint is added `NOT VALID` so the apply cannot fail on historical rows,
  and it should only be validated afterwards if no existing payment row has a
  null `saleId`, a null `customerId`, or a non-positive amount.
- Run **check 4 in its verification block**, which proves no customer's balance
  moved as a result of the formula change. Nobody holds credit at apply time, so
  the new term is zero for everyone and every balance must be unchanged. Keep
  that query — once credit is in use it stops being an equality and becomes the
  reconciliation between `customers.balance` and the credit pool.

### 017 aftermath — two live defects, and what they have in common

Testing `017` in production turned up two failures worth recording, because
neither would have shown up in a policy dump.

**Sales staff could not record a sale.** `017` added `created_by = auth.uid()` to
`sales_insert_non_admin`. The check was right; the value it checked was
client-supplied. `record_sale` read `created_by` from its JSON payload, the
client filled it from React state, and `auth.uid()` comes from the JWT — signing
in as a second user in the same browser makes those diverge, and the policy then
refuses a legitimate sale. Worked around on 2026-08-01 by reverting the policy to
`010`'s form; fixed properly in `019` by stamping the value server-side so there
is nothing left to disagree.

**Nobody could delete a payment, admin included** — and this one predates `017`
by four days. `delete_payment` opens with `select … for update`, and
`SELECT … FOR UPDATE` requires the UPDATE policies to be satisfied as well as
SELECT. `payments` has no UPDATE policy: `001` omitted it deliberately because
payments are immutable. The blanket `"Authenticated full access"` policy covered
it until **`013` dropped that**, and the lock has matched zero rows ever since.

The common thread is worth more than either bug. Both live **inside function
bodies**, where RLS changes behaviour silently rather than raising — a
`FOR UPDATE` that matches nothing, a `row_count = 0` treated as "not permitted".
`pg_policies` looked correct throughout, and the 2026-07-30 audit read the policy
set rather than the function bodies, so it caught neither. `013` has now made two
separate latent gaps binding this way, the first being the stock-write outage
fixed by `014`.

**So: when a policy is dropped, grep the function bodies for `for update` and for
`row_count`, not just the policy list.** Those are the two places where the
absence of a policy is silent.

### The 017 ordering mistake, and why 018 exists

`017` inverts the usual rule: it must be applied **after** its client, not
before. It revokes table-wide UPDATE on `customers`, and the client that shipped
before it sent the entire customer row back on every edit — including `balance`
and `id`, neither of which is grantable afterwards.

It was applied first, on 2026-08-01, and customer editing broke immediately with
`permission denied for table customers`. Nothing else was affected: no money
path writes `customers` outside `recompute_customer_balance`, which runs as
owner. The remedy was to deploy the client, not to roll anything back.

Two things worth carrying forward from that. **`permission denied for table X` is
what PostgreSQL reports for a missing COLUMN privilege too** — it checks the
table-level grant first and reports the failure against the table, so the message
does not tell you which column caused it. `information_schema.column_privileges`
does. And an ordering constraint stated only in a file header is not much of a
constraint; if a file must not be applied before something else, that belongs in
this table where the apply decision is actually made.

`018` exists because the balance correction was written as a section of `017`
after `017` was already live. Appending it would have left this repo's record
disagreeing with the database — the precise failure this README exists to
prevent — so it was extracted. `017` now matches what was applied, statement for
statement.

`020`'s row sat here for three days, below this prose rather than in the table
above — where, having no header, it did not render as a table row at all. It has
been moved. A pending migration listed somewhere the apply decision is not made
is the same failure as `016` being recorded only in an unmerged branch.

### Draft, not in the apply order

`DRAFT_payment_write_path.sql` closes finding 2's remainder: it makes
`sales.paid` derived, revokes client INSERT on `payments` and UPDATE on `sales`,
and converts `record_payment` to `SECURITY DEFINER`. It carries the only
hand-written authorization gates in this series — three of them, all on the
payment path — plus a schema change and a backfill. Open questions are listed at
the foot of the file. Give it the next free number and rename it only once those
are answered and `017` and `018` are both live and verified.

It carries no number on purpose. A draft that sits in the directory for weeks
collides with every real migration written in the meantime, and renumbering it
each time is churn that risks a stale cross-reference. Numbers are for files in
the apply order; this one earns its number when it joins.

## The 010 partial apply

Worth knowing, because it is the reason for the warning above and it caused a
production incident.

`010` sections 4, 5 and 6 (policies) applied. Sections 2 and 3 — redefining
`apply_inventory_deltas` and `set_inventory_value` as `SECURITY DEFINER` with
internal role checks — did not. `proconfig` is identical between the `009` and
`010` versions of both functions, so only `prosecdef` differed and no casual
inspection caught it.

It stayed invisible while the blanket `"Authenticated full access"` policy on
`inventory_state` was in place, because that policy permitted the `UPDATE` for
everyone. `013` dropped it, which made `010`'s admin-only `inventory_state_update`
policy binding for the first time — and stock writes started failing for every
manager and sales user. Production logging half-succeeded as a result: the run
recorded, the stock never moved.

Fixed by `014` on 2026-07-31.

Three things follow for anyone writing a migration here:

- **A partially applied migration is a realistic failure mode.** Put a
  verification step at the foot of the file that proves the change landed, not
  just that it was run. "Success. No rows returned" proves nothing — `create
  function`, `grant`, and a block of `--` comments all report it.
- **Check functions, not only policies.** `pg_policies` looked correct
  throughout. Include a control in the check: a function that must *not* change,
  so an empty or unchanged result is distinguishable from a wrong connection.
- **Apply a file whole, `begin;` to `commit;`.** Running it section by section is
  how `010` ended up half-live.

## Null roles in `SECURITY DEFINER` gates

`get_my_role()` returns NULL when the caller has no `profiles` row — which is
every connection from the Supabase SQL Editor, since `auth.uid()` is NULL there.

Inside plpgsql this inverts the gate:

```sql
if get_my_role() not in ('admin','manager','sales') then  -- NULL, not TRUE
  raise exception '...';                                  -- never fires
end if;                                                   -- execution continues
```

`010` shipped both inventory functions this way while its header claimed they
"fail closed". They failed open. `014` uses `coalesce(get_my_role(), '')` and
`is distinct from` instead.

This affects `IF` statements only. The same expression in an RLS `USING` clause
is safe — a NULL there denies the row, so the policies in `001` genuinely do fail
closed. Any new `SECURITY DEFINER` function needs the null-safe form, and its
gate cannot be tested from the SQL Editor: from there, a correct gate refuses
everything.

## Fixed-width formatters: `to_char` gives `###`, `lpad` TRUNCATES

A trap this database fell into **twice in four months, the second time while
fixing the first**. Recorded at length because reading about it plainly did not
prevent it.

### The second one first, because it is the more embarrassing

`030` was written to fix `003`. Its header diagnosed `to_char` correctly, and
then it shipped:

```sql
'INV-' || lpad(nextval('public.sales_invoice_seq')::text, 3, '0')
```

PostgreSQL's `lpad` is documented as: *"If the string is already longer than
length then it is truncated (on the right)."*

```sql
select lpad('999',  3, '0');   -- '999'    correct
select lpad('1000', 3, '0');   -- '100'    TRUNCATED
```

So the fix for a fixed-width formatter that mangles values above 999 was a
different fixed-width formatter that mangles values above 999. Applied, it gave
271 sales 28 invoice numbers and left the default still breaking every new
sale. `031` is the repair.

**Neither file ever ran its formatter at a width above the one it was designed
for.** That costs one `select` and touches no data. It is the entire defence, and
it was skipped twice.

This is why `031` splits formatting into a PURE function,
`format_invoice_number(bigint)`, separate from the sequence call. A column
default cannot be tested without inserting a row and burning a sequence value, so
in practice it never gets tested. A pure function can be tested against a VALUES
list for nothing, and `031`'s check 1 does exactly that across nine widths — the
check that would have caught both bugs.

**Write neither `to_char(n, '000')` nor `lpad(n::text, 3, '0')` for an
identifier that grows.** Use an explicit branch that cannot truncate:

```sql
'INV-' || case when n < 1000 then lpad(n::text, 3, '0') else n::text end
```

### And the original

A trap this database already fell into, recorded so it is not repeated.

`003` generated invoice numbers with:

```sql
'INV-' || to_char(nextval('public.sales_invoice_seq'), 'FM000')
```

and its own comment stated the intent: *"FM000 = min 3 digits, grows beyond 3
without truncating"*. That is not what `to_char` does. A numeric template is a
**fixed width**, and a value that does not fit is not widened — PostgreSQL
returns a row of `#` characters, which is its documented overflow signal:

```sql
select to_char(999,  'FM000');   -- '999'
select to_char(1000, 'FM000');   -- '###'
```

`FM` suppresses padding; it does not add capacity. So on the 1,000th sale every
invoice number silently became the literal text `INV-###`, and stayed that way
for eighteen days until someone noticed on the printed invoices. `030` fixes it
with `lpad(n::text, 3, '0')`, which pads to 3 and returns anything longer
unchanged.

**For a zero-padded identifier that must keep growing, use `lpad`, never
`to_char`.** Reserve `to_char` for formatting where a known bound exists
(dates, money to 2 dp).

Two things made this expensive out of proportion to the typo:

* **It fails at a threshold, not on the first run.** Every test at three digits
  passes. There is no error, no log line and no failed write — the column just
  starts holding a different string. Any generated identifier with a width needs
  a test at the width *above* the one it was designed for.
* **The comment asserted the behaviour instead of checking it.** One line in
  `psql` would have shown `###`. A comment stating what a built-in does is worth
  nothing unless someone ran it.

## The 004 / 005 tangle

Worth knowing, because the filenames alone are misleading.

`004a` and `004b` were both originally numbered `004`, so filename order could not
tell you which to apply first. They have been renamed; their contents are
unchanged apart from added idempotency guards.

The true chronology was **`004a` → `005` → `004b`**: `004a` converted
`production_logs`, `005` converted `customers` / `expenses` / `purchases`, and then
`004b` was written later the same day as a safer, guarded redo that covered
`production_logs` *and* `purchases` again. So `purchases.id` is converted in both
`004b` and `005`.

Both files were bare `ALTER`s at the time, which meant whichever ran second
errored with `column ... already has a default`. Both are now guarded on
`pg_attribute.attidentity`, so the second one is a no-op and in-order apply works.

`004a` is kept only as the record of what was actually run. **On a fresh database,
`004b` alone is sufficient** — but applying both in order is harmless.

## Conventions for new migrations

1. **Sequential prefix, no reuse.** Check the highest existing number first. Two
   files sharing a number is the defect this README exists to prevent.
2. **Idempotent.** Guard `ALTER`s (`pg_attribute.attidentity`, `if not exists`),
   use `drop policy if exists` before `create policy`, and
   `create or replace function`. Re-running a migration must be a no-op, never an
   error.
3. **Wrap in `begin; … commit;`** so a failure part-way leaves nothing behind.
4. **RLS in the same migration as the table.** A new table must have RLS enabled
   and all its policies defined in the migration that creates it — never in a
   follow-up. RLS is the security boundary; UI role checks are convenience only.
5. **Header comment explaining *why*.** What was wrong, what this changes, and
   what it deliberately does not fix. These files are the design record.
6. **Verification steps at the foot.** Queries to confirm the change landed, and
   where roles are involved, what should *fail* for each role. Add a read-only
   pre-flight query if the migration could lock out existing data.
7. **Pin `search_path`** on every function (`set search_path = public, pg_temp`).
8. **Prefer `SECURITY INVOKER`** so existing RLS still governs. Use
   `SECURITY DEFINER` only when the function must enforce a rule RLS cannot
   express — and then put an explicit `get_my_role()` check inside it, because
   RLS is no longer backstopping you.
9. **Never run destructive SQL against production.** Write the migration, get it
   reviewed, apply it by hand.
10. **If the client depends on it, say so in the header.** Note whether the
    migration must be applied *before* the matching client deploy. `main`
    auto-deploys on merge, so a client that calls a function which does not exist
    yet breaks the moment the PR lands.

## Known limitation

`001_rls_policies.sql` (45 policies) and `002_employees_rls_sales_casual.sql`
(1 policy) still use bare `create policy` and will error if re-run. They are the
only two files in this directory that are not idempotent — `006`, `008`, `010`
and `012` all pair every `create policy` with a `drop policy if exists`.

They were deliberately left alone: `001` defines the entire security boundary
across twelve tables, and mechanically rewriting 45 policy statements carries more
risk than the re-runnability is worth while the schema is live and stable.

The practical consequence is that rebuilding from scratch needs `001` and `002`
applied to a genuinely empty database. If a staging-environment rebuild ever
becomes a routine need, converting them to `drop policy if exists` + `create
policy` is the fix — as its own migration, reviewed on its own.

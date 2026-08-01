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

### Written but NOT yet applied

| File | What it does |
|------|--------------|
| `018_settle_customer_balances.sql` | Corrects the five customer balances that disagree with their sales ledger. **Debtors and Aging Debtors rise by KES 5,450 on apply.** Requires `017` |

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

### Draft, not in the apply order

`019_DRAFT_payment_write_path.sql` closes finding 2's remainder: it makes
`sales.paid` derived, revokes client INSERT on `payments` and UPDATE on `sales`,
and converts `record_payment` to `SECURITY DEFINER`. It carries the only
hand-written authorization gates in this series — three of them, all on the
payment path — plus a schema change and a backfill. Open questions are listed at
the foot of the file. Rename it to `019_payment_write_path.sql` only once those
are answered and `017` and `018` are both live and verified.

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

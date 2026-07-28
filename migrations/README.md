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

All of the following are live as of 2026-07-28.

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
| `010_inventory_and_consignment_authz.sql` | Admin-only absolute stock writes; sales role can apply stock deltas; reconcile and negative-total sales restricted to admin |
| `011_transactional_money_operations.sql` | `record_sale`, `record_payment`, `delete_sale`, `delete_payment`, `consignment_post_sale` — makes every money operation a single transaction |
| `012_production_logs_sales_role.sql` | Sales role can log production and see its own runs |

Apply dates were not recorded before this file existed. Known: `007` on
2026-07-02; `008` and `009` on 2026-07-22; `010`, `011` and `012` on 2026-07-28.
The rest were applied between 2026-06-12 and 2026-06-29, in filename order.

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

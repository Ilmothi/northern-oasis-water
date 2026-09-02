# Plan — Customer balance adjustments (migration 027 + client)

**Status:** proposed, awaiting approval. Nothing built, nothing applied.
**Date:** 2026-09-02
**Driver:** 15+ Loglogo customer balances are wrong from June 2026 data entry
errors and June's silent record loss. The correct balances are known from the
manual book; the underlying per-invoice detail is not.

---

## 1. Why a new record type rather than fixing the balances

Since migration 017, `customers.balance` is derived and not writable by hand.
Migration 025 gave it a second term:

```
balance = -sum(sales.total - sales.paid)               -- unpaid invoices
        + sum(payments.amount where "saleId" is null)  -- credit held
```

Every money path calls `recompute_customer_balance()`, so a hand-set balance is
overwritten the next time that customer trades. That is not a theory: of the
five balances corrected by hand in July, four reverted for exactly this reason
and only the dormant one (id 97) survived.

The book gives the correct endpoint but not the path, and this schema has only
two vehicles that reach a balance — an invoice or a payment. Posting the
difference as either one distorts June's revenue or June's cash to make Debtors
right. A third term makes the correction expressible as what it actually is:

```
balance = -sum(unpaid invoices) + credit held + adjustments
```

This is how an opening balance is normally carried. The correction becomes an
explicit, attributable, reversible record instead of a number that silently
changed.

**The honest limitation:** an adjustment asserts that the book is right. It is
not evidence of what happened, and the June transaction history stays incomplete
underneath it. Adjustments are trivially reversible if the detail is ever
reconstructed, which guessed payment dates would not be.

---

## 2. Migration 027 — schema

New table `customer_adjustments`. Column naming follows `sales` / `payments`
(quoted camelCase `"customerId"`).

| column | type | notes |
|---|---|---|
| `id` | bigint identity PK | DB-generated (never client-generated — see 003) |
| `"customerId"` | bigint not null | FK → `customers(id)` |
| `amount` | numeric(12,2) not null | **signed.** Positive reduces debt, negative increases it. `check (amount <> 0)` |
| `date` | date not null default current_date | effective date of the correction |
| `reason` | text not null | `check (length(trim(reason)) > 0)` — never optional |
| `kind` | text not null default `'opening_balance'` | `check kind in ('opening_balance','correction','write_off')` |
| `created_by` | uuid | stamped **server-side** from `auth.uid()`, never from the client payload |
| `created_at` | timestamptz default now() | |
| `idempotency_key` | text unique | double-submit guard, same pattern as 021 |

Sign convention matches `balance`: negative balance = customer owes us, so an
adjustment of `+2520` reduces a debt by 2,520 and `-2520` deepens it.

## 3. Migration 027 — the formula

`recompute_customer_balance(p_customer_id)` gains a third term:

```sql
select coalesce(sum(a.amount), 0) into v_adjust
  from customer_adjustments a
 where a."customerId" = p_customer_id;

update customers set balance = v_sales + v_credit + v_adjust where id = p_customer_id;
```

The existing `v_credit < 0` guard stays exactly as it is — it is about the
credit pool specifically and adjustments must not be able to mask it.

**This is the third change to the balance formula (017, 025, now 027).** It gets
the same treatment 025 got: the reasoning in the migration header, and a
post-apply reconciliation query proving every balance still equals its own
records plus its adjustments.

## 4. Migration 027 — write path

Direct table writes are not granted. Two SECURITY DEFINER functions, matching
the shape of `record_payment` / `delete_sale`:

- `record_customer_adjustment(jsonb)` — validates, inserts, stamps `created_by`
  from `auth.uid()`, calls `recompute_customer_balance`, returns the adjustment
  and the updated customer row for the client to apply.
- `delete_customer_adjustment(p_id bigint)` — admin only, removes the row and
  recomputes.

**Both gates must be written to fail CLOSED.** `get_my_role()` returns NULL when
the caller has no `profiles` row, and in plpgsql `if v_role <> 'admin' then
raise` does **not** fire on NULL — the check passes and the function runs. The
gate must be `if v_role is distinct from 'admin' then raise`. This exact trap is
documented from an earlier audit and is the single most important detail in the
migration.

Consequence worth knowing: these functions therefore refuse to run from the
Supabase SQL editor, where `auth.uid()` is NULL. That is correct, and it is why
the bulk load in §7 is written as plain SQL rather than as RPC calls.

## 5. Migration 027 — RLS (in the same migration, per CLAUDE.md)

- **RLS enabled** on the table at creation.
- `select`: admin and manager see all; sales role sees only adjustments for
  customers at their location, mirroring `customers_select`. Needed so the
  customer card and statement reconcile for every role that can open them.
- `insert` / `update` / `delete`: **no policy and no grant to `authenticated`.**
  The RPCs are the only write path. Same direction of travel as 017/018/025.

## 6. Client changes (`src/App.jsx`)

1. **Load** `customer_adjustments` in `loadDataFromSupabase` into
   `state.customerAdjustments`, in the tier appropriate to each role.

2. **Post an adjustment** — admin only, from the customer card. Two input modes,
   because the task at hand is "make this account read what the book says":
   - *Target mode (primary):* type the correct balance from the book. The form
     shows current balance, the book figure, and the delta it will post, then
     stores the delta. This is the 15-numbers-once workflow.
   - *Delta mode:* type the adjustment directly, for ordinary future corrections.

   Reason is required in both. Date defaults to today, editable.

3. **Customer card ledger** (`src/App.jsx:7062`) — MUST show adjustment rows.
   The running balance there is reconstructed from invoices and payments, and
   the code comments already note it must not "drift away from
   customers.balance". A third term with no ledger line breaks that silently.

4. **Statement PDF** (`src/App.jsx:2807`) — MUST include adjustments in
   `closing`. It is currently `totalCharged - totalPaid - onAccount`, documented
   as reconciling with `customers.balance`; that promise is in the document's own
   header text. An adjustment line is added to the statement body.

5. **Debtors / Aging** — no mechanical change (they read `balance`), but the
   report gains a total-adjustments line so this can never become a quiet hole.

6. **Recorded by** — adjustments show their author under the existing admin-only
   attribution pattern.

## 7. Loading the 15+ Loglogo corrections

Two routes, decide at review time:

- **Through the UI** (recommended): 15 entries in target mode, ~20 seconds each.
  Proper server-side attribution, over-payment guards intact, nothing bypassed.
- **Migration 028**: a `VALUES` list of `(customer_id, book_balance)`, computing
  each delta at apply time, inserting the adjustments, recomputing, and
  **asserting every resulting balance equals its book figure — rolling the whole
  transaction back if any does not.** One action, and the assertion closes the
  "recorded as applied, never landed" failure this database has had twice.
  Cost: `created_by` is null, so these show as "Not recorded".

Either way the book figures should be captured in the repo alongside the
migration, so the correction is reproducible and auditable later.

## 8. What moves in the reports

| Report | Effect |
|---|---|
| Debtors, Aging Debtors | Changes by exactly the adjustments posted. Intended. |
| Customer statement / card | New adjustment line; closing balance changes. |
| Cash Collected | **No change.** An adjustment is not cash. |
| P&L (revenue, COGS, expenses) | **No change.** An adjustment is not revenue or expense. |
| Stock / Finished Goods | **No change.** |

If some of these corrections are really uncollectable debt rather than data
errors, treating them as a P&L write-off is a separate decision — `kind =
'write_off'` exists so that can be told apart later without re-opening this.

## 9. Risks and prerequisites

- **`migrations/018` must not be applied.** It is already stale — it hard-codes
  the pre-025 one-term formula — and after 027 it would zero out both the credit
  and adjustment terms. It should be marked do-not-apply, or rewritten, as part
  of this work.
- **The DEFINER null-role trap** (§4) is the main way this migration could fail
  open. Called out in the header, and verified after apply.
- **Client/migration deploy order.** The formula change is safe to apply before
  the client ships (balances simply gain a term that is zero for everyone until
  the first adjustment exists). The client must not ship before the migration,
  or the adjustment UI writes to a table that is not there. Apply 027 first.
- **Stock is not addressed here.** June's duplicates and lost sales left the
  finished-goods counts wrong in both directions. That closes out with one
  physical count and a single stock adjustment — already outstanding from the
  July work — not by unwinding two-month-old movements.

## 10. Out of scope

Reconstructing June's missing invoices and payments; any change to how sales,
payments or stock are recorded; the P&L treatment of write-offs.

## 11. Verification after apply

1. `recompute_customer_balance` exists, is SECURITY DEFINER, and has a pinned
   `search_path` (`pg_proc` check, not the README — a migration was once recorded
   as applied and was not).
2. With no adjustments posted, **every balance is unchanged** — the reconciliation
   from 025 check 4 must still return no rows.
3. Post one adjustment on a test account: balance moves by exactly that amount;
   card ledger, statement closing figure and `customers.balance` all agree.
4. Delete it: balance returns to its previous value.
5. Confirm a non-admin cannot call `record_customer_adjustment`, and that it
   refuses rather than fails open when the caller has no `profiles` row.

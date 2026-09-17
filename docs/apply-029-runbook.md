# Applying migration 029 — runbook

Northern Water Company Ltd (OASIS Springs). Written 2026-09-17 to be picked up
later, by whoever gets to it, without re-reading the whole migration first.

**File:** `migrations/029_atomic_payroll_reversal.sql`
**Where:** Supabase SQL Editor, against production.
**How long:** twenty minutes, most of it reading results.

---

## Why this is outstanding, and what is broken while it is

🔴 **Expense deletion is failing in production right now.**

`029` was written to be applied *before* its client. That is not what happened.
PR #58 merged on 2026-09-17, `main` auto-deploys, and the client now calls
`supabase.rpc('delete_expense', …)` (`src/App.jsx`, `handleDeleteExpense`). The
function does not exist until this file is applied, so every expense delete
returns:

```
function public.delete_expense(bigint) does not exist
```

**Nothing is corrupted by the gap.** A delete that cannot start cannot
half-complete, and the old non-atomic path is gone from the client, so there is
no partial unwind to clean up. It is an outage on one path, not a data problem.
Applying this file ends it.

The other half of `029` — `record_casual_payout` computing the pay once off the
runs it locked — also only takes effect on apply. Until then a production run
logged mid-payout can be paid for and never flagged, and paid again next time.
Narrow window, real defect.

---

## Before you start

**Merge `fix-029-verification-impersonation` first**, if it is not already in.
Checks 5 and 6 in the file as originally written could never have passed — they
call `delete_expense` from the SQL Editor, where `auth.uid()` is NULL, so
`get_my_role()` returns NULL and the admin gate correctly refuses. That branch
fixes them and adds check 6c. **The migration itself is unchanged by it**
(sections 1–5 byte-identical), so if you have already applied `029` from the old
file, nothing needs redoing — only the checks were wrong.

Check whether it is merged:

```bash
git fetch origin && git log --oneline -1 origin/main
git show origin/main:migrations/029_atomic_payroll_reversal.sql | grep -c "request.jwt.claims"
# 0 = not merged yet, 4 = merged
```

Then get the two values every step below needs:

```sql
-- Your admin's auth uid. profiles.id IS the auth uid.
select id, email, role from profiles where role = 'admin';
```

```sql
-- A payroll expense that has BOTH payroll rows and linked runs, for check 5.
select e.id, e.date, e.subcategory, e.amount,
       (select count(*) from payroll_payments pp where pp.expense_id = e.id)     as payroll_rows,
       (select count(*) from production_logs l where l.casual_expense_id = e.id) as linked_runs
  from expenses e
 where e.subcategory in ('Salary', 'Casual Labour')
 order by e.date desc
 limit 20;
```

Write both down. `<ADMIN_UUID>` and `<EXPENSE_ID>` below mean these.

---

## Step 1 — Pre-apply checks (read-only, nothing is written)

### 1a. Is `028` live?

```sql
select proname, prosecdef
  from pg_proc
 where proname in ('casual_runs_in_range', 'casual_pay_for_range',
                   'record_casual_payout', 'record_salary_payment')
 order by proname;
```

**Expect four rows.** `record_*` with `prosecdef = t`, the two helpers `f`.
If `casual_pay_for_range` is missing, `028` is not applied — **stop.**

### 1b. Read the live bodies before replacing them

```sql
select p.proname, pg_get_functiondef(p.oid)
  from pg_proc p
 where p.proname in ('casual_pay_for_range', 'record_casual_payout');
```

Diff both against `028` sections 4 and 6. They should be identical — nothing has
redefined them since 2026-09-15. **If either differs, stop and find out why.**
`029` sections 2 and 3 are written against `028`'s text, and replacing a body you
have not read is how a lock or a guard gets dropped by accident. This is the
house rule: *never `create or replace` against a function you have not just read
out of `pg_proc`.*

### 1c. 🛑 Orphans the old path may already have left

**This is the one that can stop the apply**, and it is a money question before it
is a technical one. Each row is a payroll record pointing at an expense that no
longer exists, or a production run flagged paid against one.

```sql
select 'payroll row with no expense' as kind, pp.id, pp.expense_id,
       pp.type, pp.employee_name, pp.period_label, pp.amount
  from payroll_payments pp
  left join expenses e on e.id = pp.expense_id
 where pp.expense_id is not null and e.id is null
union all
select 'run flagged paid with no expense', l.id, l.casual_expense_id,
       null, null, l.date::text, null
  from production_logs l
  left join expenses e on e.id = l.casual_expense_id
 where l.casual_expense_id is not null and e.id is null;
```

**Expect no rows.** Save the output either way — check 6b compares against it.

If rows come back: **do not delete anything to make them go away.** Somebody's
pay history is wrong and that needs deciding, not tidying. `029` does not repair
orphans; it only stops more being created, so you *can* apply with rows
outstanding — but know what they are first.

---

## Step 2 — Apply

Open `migrations/029_atomic_payroll_reversal.sql`. Copy from `begin;` down to and
including `commit;` — **not** the verification block after it.

**Paste and run it as one statement.** Not section by section: running a file
piecemeal is how `010` ended up half-applied, with its policies live and its
function redefinitions missing, which took out stock writes for three days.

It should report success with no rows. That proves nothing on its own, which is
what the next step is for.

---

## Step 3 — Verify

### Check 1 — the functions exist, with the right security and `search_path`

```sql
select p.proname,
       p.prosecdef        as security_definer,
       p.proconfig        as settings,
       pg_get_function_identity_arguments(p.oid) as args
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('casual_pay_for_runs', 'casual_pay_for_range',
                     'record_casual_payout', 'delete_expense',
                     'record_salary_payment')
 order by p.proname;
```

**Expect five rows:**

| proname | security_definer | settings |
|---|---|---|
| `casual_pay_for_range` | `f` | `{search_path=public, pg_temp}` |
| `casual_pay_for_runs` | `f` | `{search_path=public, pg_temp}` |
| `delete_expense` | `t` | `{search_path=public, pg_temp}` |
| `record_casual_payout` | `t` | `{search_path=public, pg_temp}` |
| `record_salary_payment` | `t` | `{search_path=public, pg_temp}` |

`record_salary_payment` is the **control** — `029` does not touch it. If it is
missing you are on the wrong database and the other four rows mean nothing.

### Check 2 — `record_casual_payout` kept its lock and its gate

```sql
select pg_get_functiondef(p.oid) ilike '%any(v_run_ids) for update%'        as locks_runs,
       pg_get_functiondef(p.oid) ilike '%v_role is distinct from ''admin''%' as fails_closed,
       pg_get_functiondef(p.oid) ilike '%casual_pay_for_runs(v_run_ids)%'    as reads_locked_ids,
       pg_get_functiondef(p.oid) ilike '%casual_pay_for_range(%'             as reads_range_again
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'record_casual_payout';
```

**Expect `t, t, t, f`.** The last one is the finding-3 check itself: the body
must no longer mention `casual_pay_for_range` at all.

`fails_closed` matters because `<>` against a NULL role skips the branch and
fails **open** inside a `SECURITY DEFINER` function. `is distinct from` does not.

### Check 3 — `delete_expense` is admin-gated

```sql
select pg_get_functiondef(p.oid) ilike '%v_role is distinct from ''admin''%' as fails_closed,
       p.prosecdef as is_definer
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'delete_expense';
```

**Expect `t, t`.**

### Check 4 — 🔑 NO FIGURE MOVED

**This is the check that matters.** Everything else confirms the apply landed;
this one confirms it changed nothing it should not have.

```sql
with ids as (
  select array(select run_id from casual_runs_in_range(date '2026-06-01',
                                                       date '2026-09-30')) as v
),
by_range as (
  select * from casual_pay_for_range(date '2026-06-01', date '2026-09-30')
),
by_runs as (
  select * from casual_pay_for_runs((select v from ids))
)
select (select count(*) from by_range) as total_rows,
       (select count(*) from (
          (select employee_id, days, cartons, pay from by_range
           except all
           select employee_id, days, cartons, pay from by_runs)
          union all
          (select employee_id, days, cartons, pay from by_runs
           except all
           select employee_id, days, cartons, pay from by_range)
        ) d) as differing_rows;
```

**Expect `differing_rows = 0` AND `total_rows > 0`.**

⚠️ **If `total_rows` is 0 the check has proved nothing** — every run in that
window is already paid. Widen the dates until it is non-zero, then read
`differing_rows`.

### Check 6c — the gate refuses a NULL role

**Run this on its own.** It ends in a deliberate error, and the SQL Editor aborts
anything pasted after one.

```sql
select get_my_role() as should_be_null;
select delete_expense(-1);
```

**Expect** `should_be_null` to be NULL, then
`ERROR: delete_expense: only an admin may delete an expense`.

A success here, or a row actually deleted, means the gate fails open — that is
the `010` failure mode, and it would mean the gate was written with `<>`.

### Check 5 — `delete_expense` is atomic

Substitute `<ADMIN_UUID>` and `<EXPENSE_ID>`. **This rolls back and writes
nothing.** Run it as one block including the `rollback;`.

```sql
begin;

  set local role authenticated;
  set local request.jwt.claims = '{"sub":"<ADMIN_UUID>","role":"authenticated"}';

  -- Prove the impersonation took BEFORE relying on it.
  select auth.uid() as acting_as, get_my_role() as role;   -- expect <ADMIN_UUID>, admin

  select count(*) from expenses         where id = <EXPENSE_ID>;                -- 1
  select count(*) from payroll_payments where expense_id = <EXPENSE_ID>;        -- > 0
  select count(*) from production_logs  where casual_expense_id = <EXPENSE_ID>; -- note it

  select delete_expense(<EXPENSE_ID>);

  select count(*) from expenses         where id = <EXPENSE_ID>;                -- 0
  select count(*) from payroll_payments where expense_id = <EXPENSE_ID>;        -- 0
  select count(*) from production_logs  where casual_expense_id = <EXPENSE_ID>; -- 0

rollback;
```

Then, **outside** the transaction, confirm everything came back:

```sql
select count(*) from expenses         where id = <EXPENSE_ID>;                -- 1
select count(*) from payroll_payments where expense_id = <EXPENSE_ID>;        -- the earlier number
select count(*) from production_logs  where casual_expense_id = <EXPENSE_ID>; -- the earlier number
```

The three counts going to zero **together** is the point of the whole file.

### Check 6 — deleting something already gone succeeds

```sql
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"<ADMIN_UUID>","role":"authenticated"}';
  select auth.uid() as acting_as, get_my_role() as role;   -- expect <ADMIN_UUID>, admin
  select delete_expense(-1);
rollback;
```

**Expect** `{"expenseId": -1, "payrollIds": [], "runIds": [], "alreadyGone": true}`.

This is the idempotency the app's own advice depends on: `deleteFailureMessage`
tells operators on every timeout to *"delete it again — asking twice is safe."*
If this raises **while genuinely acting as admin** (check the `acting_as` line),
that advice has become false and section 4 is wrong.

### Check 6b — no new orphans

Re-run the query from step 1c. **The answer must be exactly what it gave then.**
`029` does not repair orphans, so a *new* row here means the apply broke
something.

---

## Step 4 — From the app

Sign in and try each role from the Expenses list:

| Role | Expected |
|---|---|
| **admin** | Delete succeeds. If it was a payroll expense, the HR "Paid" status clears and linked production runs return to "Pay Due" — all of it, or none of it. |
| **manager** | Refused: *"only an admin may delete an expense."* Before `029` the same attempt failed on the RLS policy with *"permission denied"*. Outcome unchanged, message clearer. **If a manager succeeds, stop** — access has been widened and section 4's gate is wrong. |
| **sales** | The Expenses tab is not theirs. Nothing to try. |

Then record one casual payout with **at least four casuals** in range, and check
the expense equals the sum of its payroll rows:

```sql
select e.amount as expense_total,
       (select sum(pp.amount) from payroll_payments pp where pp.expense_id = e.id) as payroll_total
  from expenses e where e.id = <THE NEW EXPENSE ID>;
```

**Expect the two to be equal.** Since `029` they are equal by construction — both
come from one evaluation — rather than by two queries happening to agree.

Four casuals is deliberate: it also exercises the finding-1 rounding fix that
merged separately, which was refusing about half of all real payouts before.

---

## Step 5 — Record it

**Do this in the same sitting.** The lesson this directory keeps re-learning is
that a verification kept in a branch, or in one person's head, is not a record —
`016` was verified and the commit never reached `main`, so the README said
consignment transfers should have been failing for a day.

1. Move `029` from **"Written but NOT yet applied"** to the applied table in
   `migrations/README.md`, with the date and how it was verified.
2. Delete the 🔴 outstanding note above that row — the outage it describes is
   over.
3. Mark findings 2 and 3 **FIXED** in `docs/audit-2026-09-17.md`. They are
   currently "fix written, not live", which stops being true the moment this is
   applied. In this repo **FIXED means merged and live**, so the status only
   changes after step 3 passes, not after the PR merges.
4. Commit on a branch, PR, merge. Never straight to `main`.

---

## If something goes wrong

**The apply errors part-way.** It is wrapped `begin; … commit;`, so nothing
landed. Read the error, fix the cause, run the whole file again. Do not run the
remaining sections by hand.

**Check 4 shows `differing_rows > 0`.** Stop. That means `casual_pay_for_runs`
and `casual_pay_for_range` disagree, which they cannot if the wrapper is right —
so something in section 1 or 2 did not land as written. Nothing is damaged
(both functions are read-only), but do not trust a payout until it is resolved.

**Check 5 shows the counts not going to zero together.** Stop and do not merge
anything further. That is the atomicity claim failing, and it is the whole
reason the file exists.

**A manager can delete an expense.** Stop immediately and revoke: this is a
privilege escalation, not a cosmetic bug.

```sql
revoke all on function delete_expense(bigint) from authenticated, anon, public;
```

Expense deletion goes back to being broken for everyone, which is the safe
direction, and the gate can be fixed without time pressure.

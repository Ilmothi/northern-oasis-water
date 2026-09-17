-- =============================================================================
-- 029_atomic_payroll_reversal.sql
-- Northern Water Company Ltd — OASIS Springs
--
-- Findings 2 and 3 of `docs/audit-2026-09-17.md`. Both are payroll, both are
-- small, and both are about the SAME defect class that `028` was written to
-- close — a money operation made of several statements that can come apart —
-- so they are one file with one verification block.
--
--   Finding 2: `028` made the payroll WRITE atomic and left the REVERSE path
--              untouched. Deleting a payroll expense is still N+2 separate
--              round trips with no transaction.
--   Finding 3: `record_casual_payout` reads the run set THREE times at three
--              different snapshots, so what is paid for, what the expense says,
--              and what is marked paid can all disagree.
--
-- REQUIRES `028`. Block 0 checks for it.
--
-- =============================================================================
-- FINDING 3 — WHAT IS WRONG TODAY
-- =============================================================================
--
-- `028`'s header states: "`casual_runs_in_range` is now the single definition,
-- and both the pay calculation and the flag update read it, so the runs paid
-- for and the runs marked paid cannot come apart."
--
-- The definition is single. The READ is not. `record_casual_payout` evaluates
-- the run set three separate times:
--
--     v_run_ids := array(select run_id from casual_runs_in_range(...));   -- 548
--     perform 1 from production_logs where id = any(v_run_ids) for update;-- 554
--     select sum(pay) into v_total from casual_pay_for_range(...);        -- 561
--     insert into payroll_payments ... from casual_pay_for_range(...);    -- 606
--     update production_logs ... where id = any(v_run_ids);               -- 614
--
-- `casual_pay_for_range` calls `casual_runs_in_range` again internally, and
-- under READ COMMITTED every statement takes a fresh snapshot. So a production
-- run committed between 548 and 561 — in range, with casuals and a non-zero
-- carton count — is paid for at 561 and 606 but is NOT in `v_run_ids`. It is
-- not locked at 554 and not flagged at 614, so it still reads as "Pay Due" and
-- is paid again in the next payout.
--
-- The audit found one instance of this. Writing the fix turned up a second, and
-- it is the worse of the two: lines 561 and 606 are ALSO two different
-- snapshots from each other. The expense amount and the payroll rows it is
-- supposed to be the exact sum of are computed independently. `028`'s header
-- claims "the expense can be the exact sum of the payroll rows rather than a
-- total that differs from its own parts" — that claim currently rests on two
-- evaluations agreeing, not on there being one.
--
-- The window is narrow in both cases: the gap between two statements inside one
-- transaction. The cross-check against the client's figure backstops the first
-- case incidentally, because the extra run's pay blows past the tolerance — but
-- that is luck, and it is skipped entirely when the caller sends no total.
--
-- THE FIX. The pay is evaluated ONCE, off the LOCKED run ids, and that one
-- evaluation is used for the total, for the cross-check and for the payroll
-- rows. `casual_pay_for_runs(bigint[])` becomes the single definition of "what
-- is owed for THESE runs", and `casual_pay_for_range` becomes a thin wrapper
-- over it so the read-only helper and the write path cannot drift apart.
--
-- =============================================================================
-- FINDING 2 — WHAT IS WRONG TODAY
-- =============================================================================
--
-- `handleDeleteExpense` (src/App.jsx) is the path that reverses a payroll
-- payment, and `028` did not touch it:
--
--     1. delete from expenses                      -- succeeds
--     2. delete from payroll_payments              -- fails
--     3. alert("Expense deleted, but its payroll records could not be removed")
--     4. for each production run: update ...       -- N more chances to fail
--
-- No transaction, and no foreign key doing it for us: nothing in this directory
-- declares an FK on `payroll_payments.expense_id` or
-- `production_logs.casual_expense_id`. The orphan is the point — a payroll row
-- pointing at an expense that no longer exists, or a production run flagged
-- paid against one.
--
-- It is the exact inverse of the shape `028` closed, and its consequences now
-- run into `028`'s own guards. If the payroll rows survive, the browser shows
-- the salary unpaid, the operator records it again, and `028`'s unique index
-- refuses with "a salary for X has already been recorded" — correct, but
-- baffling in front of a screen offering "Record Payment". If a run fails to
-- un-flag, the next payout's client total and server total disagree and the
-- cross-check refuses it for a second, unrelated reason.
--
-- THE FIX. One function, one transaction: un-flag the runs, delete the payroll
-- rows, delete the expense. It returns the ids it touched so the client applies
-- state from the RESULT rather than from what it assumed would happen.
--
-- =============================================================================
-- WHY `delete_expense` AND NOT `delete_payroll_expense`
-- =============================================================================
--
-- The audit proposed `delete_payroll_expense`. This file deliberately covers
-- EVERY expense instead, because the alternative is a client that has to decide
-- which kind of expense it is holding and call a different function for each.
-- That branch is a bug waiting to happen and it buys nothing: an expense with
-- no payroll rows and no linked runs simply deletes, which is what the plain
-- path did anyway. One path, always atomic, nothing to choose.
--
-- It also brings the ordinary expense delete inside a timeout-wrapped RPC,
-- which it was not.
--
-- =============================================================================
-- WHAT THIS DELIBERATELY DOES NOT DO
-- =============================================================================
--
--   * It does not change WHO may delete an expense. `001`'s `expenses_delete`
--     is `get_my_role() = 'admin'`, and the gate here is admin-only to match.
--     A manager is refused today and is refused after this, with a clearer
--     message. This file must not widen access and does not.
--
--   * It does not change what deleting an ADVANCE does. An expense carrying
--     `advance_employee_id` feeds `getAdvancesForEmployee` and therefore next
--     month's net salary; deleting one after that salary is paid leaves the
--     paid figure standing while the displayed net moves. That is existing
--     behaviour, it is a business question rather than a correctness one, and
--     changing it here would be scope this file has not earned.
--
--   * It does not touch the cross-check tolerance. Finding 1 of the same audit
--     — the tolerance being a flat cent while the rounding error scales with
--     the number of payees — is fixed CLIENT-side on branch
--     `fix-casual-payout-rounding`, by rounding per employee the way
--     `casual_pay_for_runs` does. Widening the tolerance here would paper over
--     that instead of fixing it. The two changes are independent and can land
--     in either order.
--
-- =============================================================================
-- NO FIGURE MOVES
-- =============================================================================
--
-- `casual_pay_for_runs` computes exactly what `casual_pay_for_range` computed —
-- the same split, the same `round(sum(cartons) * rate, 2)` per employee, the
-- same `category = 'casual'` filter — for the same set of runs. Running the old
-- and new functions over any range returns identical rows; verification check 4
-- proves it against live data before anything is trusted.
--
-- No existing expense, payroll row, production flag, balance or report changes.
-- P&L, Cash Collected, Debtors, Aging and stock are all untouched. This file
-- only changes how a write and a delete are MADE.
--
-- =============================================================================
-- APPLY ORDER — MIGRATION FIRST, AND THE CLIENT IS NOT OPTIONAL
-- =============================================================================
--
-- Finding 3 is closed by applying this file alone; `record_casual_payout` is
-- rewritten in place and the client calls it unchanged.
--
-- Finding 2 is NOT. `delete_expense` sits unused until the client calls it, so
-- applying this file on its own leaves the expense delete exactly as broken as
-- it is today — inert, not fixed. The client half ships in the same branch.
--
-- Apply this file, run the verification below, then merge the client. The
-- reverse order breaks expense deletion outright with "function does not
-- exist", because the new client has no fallback path.
-- =============================================================================


-- =============================================================================
-- BLOCK 0: PRE-APPLY CHECKS — run these BEFORE the transaction below.
-- All read-only.
--
-- 0a. `028` IS LIVE. This file replaces two of its functions and calls a third.
--
--       select proname, prosecdef
--         from pg_proc
--        where proname in ('casual_runs_in_range', 'casual_pay_for_range',
--                          'record_casual_payout', 'record_salary_payment')
--        order by proname;
--
--     EXPECT four rows. `record_*` with prosecdef = true, the helpers false.
--     If `casual_pay_for_range` is missing, `028` is not applied — stop.
--
-- 0b. READ THE LIVE BODIES BEFORE REPLACING THEM. This is the house rule, and
--     it is in this README because `027` was nearly drafted against a repo file
--     that might not have matched production:
--
--       "NEVER write `create or replace` against a function you have not just
--        read out of `pg_proc`."
--
--       select pg_get_functiondef(p.oid)
--         from pg_proc p
--        where p.proname in ('casual_pay_for_range', 'record_casual_payout');
--
--     Diff both against `028` sections 4 and 6. They should be identical —
--     nothing has redefined them since 2026-09-15. If either differs, STOP and
--     work out why before applying: section 2 and section 3 below are written
--     against `028`'s text, and replacing a body you have not read is how a
--     lock or a guard gets dropped by accident.
--
-- 0c. WHAT `delete_expense` WOULD HAVE TO UNDO TODAY. Context, not a blocker —
--     it shows how much is riding on the non-atomic path being replaced:
--
--       select e.id, e.date, e.subcategory, e.amount,
--              (select count(*) from payroll_payments pp where pp.expense_id = e.id)   as payroll_rows,
--              (select count(*) from production_logs l where l.casual_expense_id = e.id) as linked_runs
--         from expenses e
--        where e.subcategory in ('Salary', 'Casual Labour')
--        order by e.date desc
--        limit 20;
--
-- 0d. ORPHANS THE OLD PATH MAY ALREADY HAVE LEFT. A money question before it is
--     a technical one — each row is a payroll record pointing at an expense that
--     no longer exists, or a production run flagged paid against one.
--
--       select 'payroll row with no expense' as kind, pp.id, pp.expense_id,
--              pp.type, pp.employee_name, pp.period_label, pp.amount
--         from payroll_payments pp
--         left join expenses e on e.id = pp.expense_id
--        where pp.expense_id is not null and e.id is null
--       union all
--       select 'run flagged paid with no expense', l.id, l.casual_expense_id,
--              null, null, l.date::text, null
--         from production_logs l
--         left join expenses e on e.id = l.casual_expense_id
--        where l.casual_expense_id is not null and e.id is null;
--
--     EXPECT no rows. This file does NOT clean up anything it finds — it only
--     stops more being created. If rows come back, decide what they mean before
--     applying; someone's pay history is wrong.
-- =============================================================================


begin;


-- =============================================================================
-- SECTION 1: casual_pay_for_runs — the single definition of what is owed
--
-- Takes the run ids rather than a date range, so the caller can LOCK them first
-- and compute the pay off exactly what it locked. That is the whole of finding
-- 3: the arithmetic was never wrong, it was just evaluated against a set that
-- could have moved.
--
-- The body is `028` section 4 with the range predicate lifted out. The two
-- silent exclusions it inherited from `getCasualPay` are KEPT — a run with no
-- casuals on duty and a run with zero cartons are skipped rather than paid at
-- zero — because this function is now callable with an arbitrary array and must
-- not divide by a zero head count. For the intended input they are no-ops:
-- `casual_runs_in_range` has already applied both.
--
-- `category = 'casual'` is likewise kept exactly as `028` had it. It matches the
-- client's filter, and any divergence makes the cross-check refuse every payout
-- over a range where a permanent employee stood in on a run.
-- =============================================================================

create or replace function casual_pay_for_runs(p_run_ids bigint[])
returns table (employee_id bigint, days integer, cartons numeric, pay numeric)
language sql
stable
set search_path = public, pg_temp
as $$
  with rate as (
    select coalesce((costs ->> 'casual_rate')::numeric, 0) as v
      from cost_settings where id = 1
  ),
  runs as (
    select l.id,
           (select coalesce(sum(v.value::numeric), 0)
              from jsonb_each_text(coalesce(l.items, '{}'::jsonb)) v) as cartons,
           jsonb_array_length(l.casuals) as casual_count,
           l.casuals
      from production_logs l
     where l.id = any(p_run_ids)
       and jsonb_typeof(l.casuals) = 'array'
       and jsonb_array_length(l.casuals) > 0
  ),
  split as (
    select (c.value #>> '{}')::bigint as employee_id,
           r.cartons / r.casual_count as cartons
      from runs r
      cross join lateral jsonb_array_elements(r.casuals) c
     where r.cartons > 0
  )
  select s.employee_id,
         count(*)::integer,
         sum(s.cartons),
         round(sum(s.cartons) * (select v from rate), 2)
    from split s
    join employees e on e.id = s.employee_id and e.category = 'casual'
   group by s.employee_id;
$$;


-- =============================================================================
-- SECTION 2: casual_pay_for_range becomes a wrapper
--
-- Same signature, same rows, same grants — nothing that calls it needs to know.
-- It is now defined IN TERMS OF section 1 rather than alongside it, so the
-- read-only helper and the write path cannot drift apart. Two copies of this
-- split arithmetic is how the client and the server came to disagree in the
-- first place (finding 1); there is no reason to keep two inside the database.
-- =============================================================================

create or replace function casual_pay_for_range(p_start date, p_end date)
returns table (employee_id bigint, days integer, cartons numeric, pay numeric)
language sql
stable
set search_path = public, pg_temp
as $$
  select * from casual_pay_for_runs(
    array(select run_id from casual_runs_in_range(p_start, p_end))
  );
$$;


-- =============================================================================
-- SECTION 3: record_casual_payout — the pay evaluated ONCE, off the locked runs
--
-- `028` section 6, with three changes and nothing else:
--
--   1. `v_pay` holds ONE evaluation of `casual_pay_for_runs(v_run_ids)`, taken
--      after the lock. The total, the cross-check and the payroll rows all read
--      that one value, so they cannot be three different snapshots.
--   2. The total is summed from `v_pay` instead of from a second query.
--   3. The payroll INSERT reads `v_pay` instead of a third query.
--
-- Everything else is preserved verbatim, and each preserved piece is
-- load-bearing:
--
--   * the replay branch BEFORE any validation, so a resend of something already
--     recorded succeeds even if the rules have moved since;
--   * `v_role is distinct from 'admin'`, which fails CLOSED on the null role a
--     caller with no profiles row produces — `<>` would not;
--   * the `for update` on the runs, then the re-read that catches a concurrent
--     payout, which is the only thing that can see two OVERLAPPING ranges
--     paying for the same work (two ranges give two different `period_label`s,
--     so the unique index cannot);
--   * the unique_violation handlers on both inserts, the second of which aborts
--     the whole function so the expense rolls back with it.
-- =============================================================================

create or replace function record_casual_payout(p_payout jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_start    date;
  v_end      date;
  v_key      uuid;
  v_claimed  numeric;
  v_role     text;
  v_date     date;
  v_label    text;
  v_run_ids  bigint[];
  v_pay      jsonb;
  v_total    numeric;
  v_expense  expenses;
  v_rows     jsonb;
begin
  v_start   := (p_payout ->> 'start')::date;
  v_end     := (p_payout ->> 'end')::date;
  v_key     := nullif(p_payout ->> 'client_key', '')::uuid;
  v_claimed := (p_payout ->> 'total')::numeric;
  v_date    := coalesce((p_payout ->> 'date')::date, current_date);

  -- Replay, fast path. Before any validation, so a resend of something already
  -- recorded succeeds even if the figures have moved since.
  if v_key is not null then
    select * into v_expense from expenses where client_key = v_key;
    if found then
      return jsonb_build_object(
        'expense',  to_jsonb(v_expense),
        'payroll',  coalesce((select jsonb_agg(to_jsonb(pp) order by pp.id)
                                from payroll_payments pp
                               where pp.expense_id = v_expense.id), '[]'::jsonb),
        'runIds',   coalesce((select jsonb_agg(l.id order by l.id)
                                from production_logs l
                               where l.casual_expense_id = v_expense.id), '[]'::jsonb),
        'replayed', true
      );
    end if;
  end if;

  v_role := get_my_role();

  -- FAILS CLOSED on a NULL role.
  if v_role is distinct from 'admin' then
    raise exception 'record_casual_payout: only an admin may record a casual payout';
  end if;

  if v_start is null or v_end is null then
    raise exception 'record_casual_payout: a start and end date are required';
  end if;
  if v_start > v_end then
    raise exception 'record_casual_payout: the start date is after the end date';
  end if;

  v_label := to_char(v_start, 'YYYY-MM-DD') || ' to ' || to_char(v_end, 'YYYY-MM-DD');

  -- Lock the runs BEFORE computing anything. Two payouts over overlapping
  -- ranges are two different `period_label`s, so the unique index cannot see
  -- that they pay for the same work — this lock is the only thing that can.
  v_run_ids := array(select run_id from casual_runs_in_range(v_start, v_end) order by run_id);

  if array_length(v_run_ids, 1) is null then
    raise exception 'record_casual_payout: no unpaid casual work in % — nothing was saved', v_label;
  end if;

  perform 1 from production_logs where id = any(v_run_ids) for update;

  if exists (select 1 from production_logs
              where id = any(v_run_ids) and coalesce(casual_paid, false)) then
    raise exception 'record_casual_payout: someone else recorded a payout covering these production runs while this one was being saved. Nothing was saved — reload and check.';
  end if;

  -- CHANGED IN 029. ONE evaluation, off the ids just locked, reused three times
  -- below. `028` called `casual_pay_for_range` here and again at the INSERT, so
  -- the total and the rows it is meant to be the sum of came from two snapshots,
  -- and both could include a run that `v_run_ids` does not — paid for, never
  -- flagged, paid again next time.
  select coalesce(jsonb_agg(jsonb_build_object(
           'employee_id',   p.employee_id,
           'employee_name', e.name,
           'pay',           p.pay
         ) order by p.employee_id), '[]'::jsonb)
    into v_pay
    from casual_pay_for_runs(v_run_ids) p
    join employees e on e.id = p.employee_id;

  select coalesce(sum((item ->> 'pay')::numeric), 0)
    into v_total
    from jsonb_array_elements(v_pay) as pr(item);

  if v_total <= 0 then
    raise exception 'record_casual_payout: the casual rate or the cartons produced give a total of zero for % — nothing was saved', v_label;
  end if;

  -- Cross-check, not source. A mismatch means the browser is holding stale
  -- production logs or a stale casual rate.
  if v_claimed is not null and abs(v_claimed - v_total) > 0.01 then
    raise exception 'record_casual_payout: this screen shows % but the production records give % for %. Reload and try again.',
      v_claimed, v_total, v_label;
  end if;

  begin
    insert into expenses
      (date, category, subcategory, description, amount, advance_employee_id,
       created_by, client_key)
    values (
      v_date, 'operating', 'Casual Labour',
      'Casual labour (' || v_label || ')',
      v_total, null, auth.uid(), v_key
    )
    returning * into v_expense;
  exception when unique_violation then
    select * into v_expense from expenses where client_key = v_key;
    if not found then
      raise;
    end if;
    return jsonb_build_object(
      'expense',  to_jsonb(v_expense),
      'payroll',  coalesce((select jsonb_agg(to_jsonb(pp) order by pp.id)
                              from payroll_payments pp
                             where pp.expense_id = v_expense.id), '[]'::jsonb),
      'runIds',   coalesce((select jsonb_agg(l.id order by l.id)
                              from production_logs l
                             where l.casual_expense_id = v_expense.id), '[]'::jsonb),
      'replayed', true
    );
  end;

  -- CHANGED IN 029. From `v_pay`, so the expense above is the exact sum of
  -- these rows by construction rather than by two queries agreeing.
  begin
    insert into payroll_payments
      (type, employee_id, employee_name, period_label, period_start, period_end,
       amount, date_paid, expense_id)
    select 'casual',
           (item ->> 'employee_id')::bigint,
           item ->> 'employee_name',
           v_label, v_start, v_end,
           (item ->> 'pay')::numeric,
           v_date, v_expense.id
      from jsonb_array_elements(v_pay) as pr(item);
  exception when unique_violation then
    raise exception 'record_casual_payout: a payout for % has already been recorded. Nothing was saved.', v_label;
  end;

  -- The same run list the pay was computed from — now genuinely the same one.
  update production_logs
     set casual_paid = true, casual_expense_id = v_expense.id
   where id = any(v_run_ids);

  select coalesce(jsonb_agg(to_jsonb(pp) order by pp.id), '[]'::jsonb) into v_rows
    from payroll_payments pp where pp.expense_id = v_expense.id;

  return jsonb_build_object(
    'expense',  to_jsonb(v_expense),
    'payroll',  v_rows,
    'runIds',   to_jsonb(v_run_ids),
    'replayed', false
  );
end;
$$;


-- =============================================================================
-- SECTION 4: delete_expense — the reversal, in one transaction
--
-- Un-flag the runs, delete the payroll rows, delete the expense. All or none.
--
-- ORDER MATTERS for readability rather than for correctness — it is one
-- transaction, so nothing is observable in between — but the children go first
-- so the sequence reads as an unwind rather than a cascade that is not there.
-- There is no FK to cascade: nothing in this directory declares one on
-- `payroll_payments.expense_id` or `production_logs.casual_expense_id`.
--
-- The gate is admin-only, matching `001`'s `expenses_delete` exactly, and uses
-- `is distinct from` so a caller with no profiles row is REFUSED rather than
-- waved through. Inside a SECURITY DEFINER function the RLS policy is no longer
-- backstopping this, so the gate is the boundary.
--
-- Returns the ids it touched. The client applies state from that rather than
-- from what it assumed would happen — which is the other half of finding 2:
-- the old code called `setPayrollPayments` BEFORE the delete it was describing.
--
-- IT IS IDEMPOTENT, AND THAT IS NOT OPTIONAL. Deleting an id that is already
-- gone SUCCEEDS. Every delete in this app tells the operator, on a timeout,
-- "delete it again — asking twice is safe" (`deleteFailureMessage` in
-- src/App.jsx). Raising "not found" on the second attempt would make that advice
-- false in exactly the case it was written for: the first attempt landed, the
-- response was lost, and the operator does as they were told. The old path was
-- idempotent by accident — `delete().eq('id', …)` on a missing row is a no-op
-- that reports success — and this must not quietly give that up.
--
-- So there is no `if not found then raise`. The unwind runs unconditionally
-- against the id, and `alreadyGone` in the result is how the client knows which
-- happened. A repeat therefore also finishes an unwind the OLD non-atomic path
-- left half-done, which is a useful consequence rather than the point: this
-- file does not go hunting for orphans (block 0d does that, and reports only),
-- but it will complete the one id it was asked about.
--
-- The `for update` on the expense row is safe here, unlike the one in
-- `delete_payment` that `019` had to remove. That one matched zero rows because
-- `SELECT … FOR UPDATE` needs the UPDATE policies satisfied as well as SELECT,
-- and `payments` deliberately has none. Two things differ: `expenses` DOES have
-- an UPDATE policy (`001`'s `expenses_update`), and this function is SECURITY
-- DEFINER, so RLS is not consulted inside it at all. Recorded because the
-- README says to grep function bodies for `for update` whenever policies are in
-- question, and this is the answer for this one.
-- =============================================================================

create or replace function delete_expense(p_expense_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role         text;
  -- no expense row variable: only its EXISTENCE matters, via FOUND below
  v_already_gone boolean;
  v_run_ids      bigint[];
  v_payroll_ids  bigint[];
begin
  if p_expense_id is null then
    raise exception 'delete_expense: an expense id is required';
  end if;

  v_role := get_my_role();

  -- FAILS CLOSED on a NULL role. Matches `001`'s expenses_delete: admin only.
  -- This function must not widen who may delete an expense, and does not.
  if v_role is distinct from 'admin' then
    raise exception 'delete_expense: only an admin may delete an expense';
  end if;

  -- Lock the expense if it is there. Its absence is NOT an error — see the
  -- header. `for update` is safe inside a SECURITY DEFINER function; it is the
  -- `019` trap only where RLS applies and the table has no UPDATE policy.
  perform 1 from expenses where id = p_expense_id for update;
  v_already_gone := not found;

  -- Lock the linked runs before reading them, so nothing can move underneath
  -- the un-flag. A concurrent payout always creates a NEW expense and so can
  -- never point a run at this one, but locking what we are about to update is
  -- the habit, not the exception.
  perform 1 from production_logs where casual_expense_id = p_expense_id for update;

  v_run_ids := array(select id from production_logs
                      where casual_expense_id = p_expense_id order by id);

  v_payroll_ids := array(select id from payroll_payments
                          where expense_id = p_expense_id order by id);

  -- Unconditional, so a retry after a lost response finishes the job instead of
  -- refusing. Each of these is a no-op when there is nothing left to do.
  update production_logs
     set casual_paid = false, casual_expense_id = null
   where id = any(v_run_ids);

  delete from payroll_payments where expense_id = p_expense_id;

  delete from expenses where id = p_expense_id;

  return jsonb_build_object(
    'expenseId',   p_expense_id,
    'payrollIds',  to_jsonb(v_payroll_ids),
    'runIds',      to_jsonb(v_run_ids),
    'alreadyGone', v_already_gone
  );
end;
$$;


-- =============================================================================
-- SECTION 5: grants
--
-- No new table, so no new RLS. `expenses`, `payroll_payments` and
-- `production_logs` keep `001`'s policies — all bypassed inside these SECURITY
-- DEFINER functions, which is exactly why the explicit admin gates above are
-- the real boundary.
--
-- EXECUTE goes to `authenticated`, not to a role: the gate inside decides. anon
-- gets nothing. `casual_pay_for_runs` is granted on the same terms as the
-- helper it generalises — it is read-only and exposes nothing
-- `casual_pay_for_range` did not already expose.
-- =============================================================================

revoke all on function casual_pay_for_runs(bigint[]) from anon, public;
revoke all on function casual_pay_for_range(date, date) from anon, public;
revoke all on function record_casual_payout(jsonb) from anon, public;
revoke all on function delete_expense(bigint) from anon, public;

grant execute on function casual_pay_for_runs(bigint[]) to authenticated;
grant execute on function casual_pay_for_range(date, date) to authenticated;
grant execute on function record_casual_payout(jsonb) to authenticated;
grant execute on function delete_expense(bigint) to authenticated;


commit;


-- =============================================================================
-- VERIFICATION — run every block below AFTER the commit above.
--
-- "Success. No rows returned" proves nothing: `create function`, `grant` and a
-- block of comments all report it. Each check below has an expected result, and
-- checks 1 and 4 carry a control so an empty answer is distinguishable from a
-- wrong connection.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- CHECK 1: all four functions exist, with the right security and search_path.
--
-- EXPECT exactly five rows:
--   casual_pay_for_runs     f   {search_path=public, pg_temp}
--   casual_pay_for_range    f   {search_path=public, pg_temp}
--   record_casual_payout    t   {search_path=public, pg_temp}
--   delete_expense          t   {search_path=public, pg_temp}
--   record_salary_payment   t   {search_path=public, pg_temp}   <- the CONTROL
--
-- `record_salary_payment` is the control: this file does not touch it, so it
-- must still be there and still be SECURITY DEFINER. If it is missing, you are
-- on the wrong database and the other four rows mean nothing.
-- -----------------------------------------------------------------------------
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


-- -----------------------------------------------------------------------------
-- CHECK 2: record_casual_payout kept its lock and its fail-closed gate.
--
-- The two things a rewrite of this function could silently lose. Both must be
-- true. `is distinct from` matters because `<>` against a NULL role skips the
-- branch and fails OPEN inside a SECURITY DEFINER function.
--
-- EXPECT: locks_runs = t, fails_closed = t, reads_locked_ids = t,
--         reads_range_again = f
--
-- `reads_range_again` is the finding-3 check itself: the body must no longer
-- mention `casual_pay_for_range` at all.
-- -----------------------------------------------------------------------------
select pg_get_functiondef(p.oid) ilike '%any(v_run_ids) for update%' as locks_runs,
       pg_get_functiondef(p.oid) ilike '%v_role is distinct from ''admin''%' as fails_closed,
       pg_get_functiondef(p.oid) ilike '%casual_pay_for_runs(v_run_ids)%'    as reads_locked_ids,
       pg_get_functiondef(p.oid) ilike '%casual_pay_for_range(%'             as reads_range_again
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'record_casual_payout';


-- -----------------------------------------------------------------------------
-- CHECK 3: delete_expense is admin-gated and fails closed.
--
-- EXPECT: fails_closed = t, is_definer = t
--
-- The gate CANNOT be tested by calling it from the SQL Editor. `auth.uid()` is
-- NULL there, so `get_my_role()` is NULL, so a CORRECT gate refuses everything
-- — a refusal from here proves the gate fires, not that it fires on the right
-- people. That is the `010` lesson: from the SQL Editor, a correct gate and a
-- broken one are told apart by reading the text, not by the response.
-- Role behaviour is checked from the app, in check 7.
-- -----------------------------------------------------------------------------
select pg_get_functiondef(p.oid) ilike '%v_role is distinct from ''admin''%' as fails_closed,
       p.prosecdef as is_definer
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'delete_expense';


-- -----------------------------------------------------------------------------
-- CHECK 4: NO FIGURE MOVED. The new arithmetic equals the old, on live data.
--
-- This is the check that matters. `casual_pay_for_runs` fed the ids for a range
-- must return exactly what `casual_pay_for_range` returns for that range — and
-- `casual_pay_for_range` is now defined in terms of it, so this also proves the
-- wrapper did not change shape.
--
-- Run it over a range with real unpaid casual work. If every run in the window
-- is already paid, widen the dates until `total_rows` is non-zero — a check
-- that passes over an empty set has proved nothing.
--
-- EXPECT: differing_rows = 0, and total_rows > 0.
-- -----------------------------------------------------------------------------
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
select (select count(*) from by_range)                       as total_rows,
       (select count(*) from (
          (select employee_id, days, cartons, pay from by_range
           except all
           select employee_id, days, cartons, pay from by_runs)
          union all
          -- Both directions. `except all` is one-way, and a row appearing only
          -- in the NEW result is just as much a difference as one lost from the
          -- old — checking one direction would miss half the ways this can fail.
          (select employee_id, days, cartons, pay from by_runs
           except all
           select employee_id, days, cartons, pay from by_range)
        ) d)                                                 as differing_rows;


-- -----------------------------------------------------------------------------
-- CHECK 5: delete_expense is ATOMIC — the whole point of section 4.
--
-- ROLLS BACK. It writes nothing. Run it as written, including the rollback.
--
-- Pick a payroll expense id that HAS linked payroll rows and linked runs
-- (block 0c lists candidates) and substitute it below. The three counts must
-- all go to zero together inside the transaction, and the rollback must put
-- every one of them back.
--
-- EXPECT: before > 0 for all three, after = 0 for all three, restored = before.
-- -----------------------------------------------------------------------------
-- begin;
--
--   select count(*) from expenses          where id = <EXPENSE_ID>;                 -- expect 1
--   select count(*) from payroll_payments  where expense_id = <EXPENSE_ID>;         -- expect > 0
--   select count(*) from production_logs   where casual_expense_id = <EXPENSE_ID>;  -- note this number
--
--   select delete_expense(<EXPENSE_ID>);
--
--   select count(*) from expenses          where id = <EXPENSE_ID>;                 -- expect 0
--   select count(*) from payroll_payments  where expense_id = <EXPENSE_ID>;         -- expect 0
--   select count(*) from production_logs   where casual_expense_id = <EXPENSE_ID>;  -- expect 0
--
-- rollback;
--
--   -- and then, OUTSIDE the transaction, that everything came back:
--   select count(*) from expenses          where id = <EXPENSE_ID>;                 -- expect 1
--   select count(*) from payroll_payments  where expense_id = <EXPENSE_ID>;         -- expect the earlier number
--   select count(*) from production_logs   where casual_expense_id = <EXPENSE_ID>;  -- expect the earlier number


-- -----------------------------------------------------------------------------
-- CHECK 6: deleting something already gone SUCCEEDS, and changes nothing.
--
-- The idempotency the timeout advice depends on — "delete it again, asking
-- twice is safe." An id that does not exist must come back as a normal result
-- with `alreadyGone: true`, NOT as an error, and must not have touched anything
-- on the way.
--
-- EXPECT: {"expenseId": -1, "payrollIds": [], "runIds": [], "alreadyGone": true}
--
-- If this RAISES, the advice `deleteFailureMessage` gives on every delete in the
-- app has become false and section 4 is wrong.
-- -----------------------------------------------------------------------------
select delete_expense(-1);


-- -----------------------------------------------------------------------------
-- CHECK 6b: no orphans, before or after.
--
-- The same query as block 0d. Run it again now: this file does not repair
-- orphans, so the answer must be exactly what block 0d gave. A NEW row here
-- means the apply itself broke something.
--
-- EXPECT: both counts zero, and in any case unchanged from block 0d.
-- -----------------------------------------------------------------------------
select count(*) as orphaned_payroll_rows
  from payroll_payments pp
  left join expenses e on e.id = pp.expense_id
 where pp.expense_id is not null and e.id is null;

select count(*) as runs_flagged_against_nothing
  from production_logs l
  left join expenses e on e.id = l.casual_expense_id
 where l.casual_expense_id is not null and e.id is null;


-- -----------------------------------------------------------------------------
-- CHECK 7: role behaviour — FROM THE APP, not from here.
--
-- Signed in as each role, try to delete an expense from the Expenses list:
--
--   admin    -> succeeds. The expense goes, and if it was a payroll expense
--               the HR "Paid" status clears and any linked production runs
--               return to "Pay Due" — all of it, or none of it.
--   manager  -> refused with "only an admin may delete an expense".
--               BEFORE this file the same attempt failed on the RLS policy with
--               "permission denied"; the outcome is unchanged, the message is
--               clearer. If a manager SUCCEEDS, stop — this file has widened
--               access and section 4's gate is wrong.
--   sales    -> the Expenses tab is not theirs; nothing to try.
--
-- Then record one casual payout with at least four casuals in range and confirm
-- the Casual Labour expense equals the sum of the payroll rows it created:
--
--   select e.amount as expense_total,
--          (select sum(pp.amount) from payroll_payments pp where pp.expense_id = e.id) as payroll_total
--     from expenses e where e.id = <THE NEW EXPENSE ID>;
--
--   EXPECT the two to be equal. Since 029 they are equal by construction — both
--   come from one evaluation — rather than by two queries happening to agree.
-- -----------------------------------------------------------------------------

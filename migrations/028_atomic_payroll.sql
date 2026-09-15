-- =============================================================================
-- 028_atomic_payroll.sql
-- Northern Water Company Ltd — OASIS Springs
--
-- Payroll is the last money path with no guard of any kind. Finding 1 of
-- docs/audit-2026-08-08.md, still OPEN and unchanged a month later as finding 1
-- of docs/audit-2026-09-08.md. In that audit's coverage table (finding 6) it is
-- the only row with four crosses: no double-tap guard, no timeout, no
-- idempotency key, not atomic.
--
-- This file is the database half of all four. The client half — `runSave`,
-- `withTimeout`, disabled buttons and the keys these functions read — ships in
-- the same branch.
--
-- REQUIRES `021` (the client-key pattern this follows) and `027` (the
-- fail-closed admin gate this copies). Block 0 checks for both.
--
-- =============================================================================
-- WHAT IS WRONG TODAY
-- =============================================================================
--
-- `recordSalaryPayment` (src/App.jsx) is two unrelated round trips:
--
--     1. INSERT into expenses          -- succeeds, Salary hits the P&L
--     2. INSERT into payroll_payments  -- fails
--     3. alert("Expense saved but the payroll record failed")
--
-- Step 3 is the bug, and it is worse than the usual half-write because of what
-- the UI does next. `isSalaryPaid` reads `payroll_payments`. No payroll row
-- exists, so it returns false, so the button goes back to reading "Record
-- Payment". The operator does the obvious thing, and now there are TWO Salary
-- expenses in the P&L for one salary paid once.
--
-- `recordCasualPayment` has the same shape over more steps — one expense, then
-- N payroll rows, then a loop of N `production_logs` updates, each its own
-- round trip — and its own code already admits the exposure by alerting "Do NOT
-- record a second payout for this range".
--
-- Nothing at the database refuses any of it. There is no unique constraint on
-- `payroll_payments` anywhere in this directory.
--
-- =============================================================================
-- THE FIX, IN THREE LAYERS
-- =============================================================================
--
--   1. A UNIQUE INDEX on payroll_payments (type, employee_id, period_label).
--      This is the real enforcement and it is independent of any client. A
--      salary is paid once per employee per month; a casual is paid once per
--      employee per payout range. Casual rows already carry a stable
--      `period_label` — "<start> to <end>" — so one index covers both types.
--
--   2. AN IDEMPOTENCY KEY, on `expenses` rather than on `payroll_payments`.
--      Both payroll paths create exactly ONE expense and one-or-many payroll
--      rows, so the expense is the only place a single key identifies the whole
--      operation. A resend of a key already on file returns what was recorded
--      instead of recording it again. Same pattern as `021`, same reasoning:
--      the index enforces, the lookup is only the fast path.
--
--   3. ATOMICITY. One function per operation, so the expense, the payroll rows
--      and the production-run flags live or die together. Following `015`/`016`.
--      This is the only layer that closes the half-committed expense, which is
--      the part that actively invites the duplicate.
--
-- =============================================================================
-- THE AMOUNTS ARE NOW DERIVED, AND THE CLIENT'S FIGURE IS A CROSS-CHECK
-- =============================================================================
--
-- `015` established the house rule: a run's stock movement is derived from the
-- run's own items rather than sent alongside them, so the two can never
-- disagree. Payroll now works the same way.
--
--   * Salary net = employees.rate MINUS advances (expenses tagged to that
--     employee in that month). Derived here, not taken from the payload.
--   * Casual pay = per production run in range, total cartons split equally
--     among the casuals on duty, times the shared rate from `cost_settings`.
--     Derived here, not taken from the payload.
--
-- The client still SENDS its own figure, and these functions refuse the write
-- if it differs by more than a cent. That is deliberate and it is not
-- redundant. Silently recording a different number from the one the operator
-- just confirmed in a dialog is its own kind of wrong — worse, in a payroll
-- context, than refusing. A mismatch means the browser is holding stale
-- production logs, advances or a stale casual rate, and the honest response is
-- to say so and make them reload.
--
-- One consequence worth stating: casual pay is now rounded to the cent PER
-- EMPLOYEE and the expense is the sum of those rounded rows. The client totals
-- unrounded floats. The two agree to the cent for every realistic payout, and
-- where they would not, the tolerance below absorbs it rather than refusing.
--
-- =============================================================================
-- WHICH PRODUCTION RUNS A PAYOUT COVERS IS ALSO DERIVED
-- =============================================================================
--
-- The old client picked the runs to flag and the amounts to pay in two separate
-- passes over its own state. `casual_runs_in_range` is now the single
-- definition, and both the pay calculation and the flag update read it, so the
-- runs paid for and the runs marked paid cannot come apart.
--
-- The runs are locked FOR UPDATE before anything is computed, which is what
-- stops two concurrent payouts over overlapping ranges from both paying the
-- same run. The unique index cannot catch that one on its own: two overlapping
-- ranges produce two different `period_label`s.
--
-- =============================================================================
-- WHAT DOES NOT MOVE
-- =============================================================================
--
-- No existing figure changes. The index only refuses FUTURE duplicate rows;
-- the functions only change how a write is made, not what it writes. P&L, Cash
-- Collected, Debtors, Aging and stock are all untouched. Applying this file on
-- its own is inert until the client calls the new functions.
--
-- =============================================================================
-- APPLY ORDER — MIGRATION FIRST. NOT OPTIONAL.
-- =============================================================================
--
-- Unlike `021`, the two halves are NOT independent. The client in this branch
-- calls `record_salary_payment` and `record_casual_payout` and has no fallback
-- path; deploying it against a database without them makes every payroll write
-- fail with "function does not exist". Apply this file, run the verification
-- below, then merge the client.
--
-- The reverse order is safe: these functions simply sit unused until the client
-- ships, exactly as `022` did.
-- =============================================================================


-- =============================================================================
-- BLOCK 0: PRE-APPLY CHECKS — run these BEFORE the transaction below.
--
-- 0a. THE ONE THAT CAN STOP THIS FILE. Section 2 creates a unique index on
--     existing data. If production already contains duplicate payroll rows it
--     will fail, and that is a money question before it is a technical one —
--     somebody may have been paid twice. Do not delete anything to make the
--     index apply. Find out what happened first.
--
--       select type, employee_id, period_label, count(*), sum(amount),
--              array_agg(id order by id), array_agg(expense_id order by id)
--         from payroll_payments
--        group by type, employee_id, period_label
--       having count(*) > 1;
--
--     Expect zero rows. Anything returned is a real duplicate payroll record
--     with (probably) a real duplicate expense behind it. Stop and report it.
--
-- 0b. The table shape these functions assume.
--
--       select column_name, data_type, is_nullable
--         from information_schema.columns
--        where table_schema = 'public' and table_name = 'payroll_payments'
--        order by ordinal_position;
--
--     Expect: id, type, employee_id, employee_name, period_label, period_start,
--     period_end, amount, date_paid, expense_id.
--
-- 0c. `021` and `027` are live — both are required.
--
--       select proname from pg_proc p
--         join pg_namespace n on n.oid = p.pronamespace
--        where n.nspname = 'public'
--          and proname in ('record_sale', 'record_customer_adjustment',
--                          'get_my_role');
--
--     Expect three rows. `record_sale` carries `021`'s client-key branch,
--     `record_customer_adjustment` is `027`'s fail-closed gate, `get_my_role`
--     is what both depend on.
--
-- 0d. Confirm the expense key is not already taken by something else.
--
--       select count(*) from information_schema.columns
--        where table_schema = 'public' and table_name = 'expenses'
--          and column_name = 'client_key';
--
--     Expect 0 on a first apply. A 1 means this file has already been applied;
--     every statement below is guarded, so re-running is safe, but check 0a and
--     0e before assuming that is what happened.
--
-- 0e. Record the current totals, so the "nothing moved" claim is provable.
--     KEEP THIS OUTPUT — verification check 3 diffs against it.
--
--       select subcategory, count(*), sum(amount)
--         from expenses
--        where subcategory in ('Salary', 'Casual Labour')
--        group by subcategory;
--
--       select type, count(*), sum(amount) from payroll_payments group by type;
-- =============================================================================


begin;


-- =============================================================================
-- SECTION 1: the idempotency key
--
-- On `expenses`, not `payroll_payments` — see the header. A casual payout is N
-- payroll rows from one request, so no single key can be unique across them;
-- the one expense they all hang off is the natural identity of the operation.
--
-- The index is partial (`where client_key is not null`) so every existing
-- expense row, and every write from the ordinary expense form which does not
-- send a key, is unaffected. Same shape as `021`.
-- =============================================================================

alter table expenses add column if not exists client_key uuid;

create unique index if not exists expenses_client_key_uniq
  on expenses (client_key)
  where client_key is not null;


-- =============================================================================
-- SECTION 2: the duplicate guard
--
-- This is the layer that does not depend on the client behaving. Even with
-- every guard in the client bypassed — an old tablet, a direct API call, a
-- client key that got regenerated — the database refuses a second payroll row
-- for the same person and the same period.
--
-- `employee_id` is nullable in principle and NULLs do not collide in a unique
-- index. That is correct here: a payroll row with no employee is already broken
-- in a way this index is not the right place to fix.
-- =============================================================================

create unique index if not exists payroll_payments_period_uniq
  on payroll_payments (type, employee_id, period_label);


-- =============================================================================
-- SECTION 3: which production runs an unpaid casual payout covers
--
-- The single definition of "casual work due in this range", replacing the two
-- copies of this predicate the client kept in step by hand (one to compute the
-- pay, one to pick the runs to flag).
--
-- It mirrors `getCasualPay` exactly, including the two silent exclusions that
-- are easy to miss: a run with no casuals on duty, and a run with zero cartons,
-- are both skipped rather than paid at zero.
--
-- `date` is compared as a date. The column holds ISO 'YYYY-MM-DD' either way,
-- so the cast is a no-op where it is already typed and a correct comparison
-- where it is text — unlike the client's string compare, which happens to work
-- only because of the format.
-- =============================================================================

create or replace function casual_runs_in_range(p_start date, p_end date)
returns table (run_id bigint, cartons numeric, casual_count integer)
language sql
stable
set search_path = public, pg_temp
as $$
  select l.id,
         (select coalesce(sum(v.value::numeric), 0)
            from jsonb_each_text(coalesce(l.items, '{}'::jsonb)) v),
         jsonb_array_length(l.casuals)
    from production_logs l
   where coalesce(l.casual_paid, false) = false
     and l.date::date between p_start and p_end
     and jsonb_typeof(l.casuals) = 'array'
     and jsonb_array_length(l.casuals) > 0
     and (select coalesce(sum(v.value::numeric), 0)
            from jsonb_each_text(coalesce(l.items, '{}'::jsonb)) v) > 0;
$$;


-- =============================================================================
-- SECTION 4: what each casual is owed for that range
--
-- Each run's total cartons split equally among the casuals on duty, times the
-- shared rate from `cost_settings`. Rounded to the cent per employee, so the
-- expense can be the exact sum of the payroll rows rather than a total that
-- differs from its own parts.
--
-- The rate is read live rather than passed in, for the same reason `015` moved
-- the BOM server-side: a rate the client sends is a rate that can be stale.
--
-- Only employees whose category is 'casual' are paid, which is the client's
-- rule (`employees.filter(e => e.category === 'casual' && pay[e.id])`) and has
-- to be matched exactly or the cross-check above refuses every payout where a
-- permanent employee stood in on a run. Such a run is still marked paid, as it
-- is today — the share simply goes to nobody, which is a data-entry question
-- for the production log, not something to fix by quietly paying them here.
-- =============================================================================

create or replace function casual_pay_for_range(p_start date, p_end date)
returns table (employee_id bigint, days integer, cartons numeric, pay numeric)
language sql
stable
set search_path = public, pg_temp
as $$
  with rate as (
    select coalesce((costs ->> 'casual_rate')::numeric, 0) as v
      from cost_settings where id = 1
  ),
  split as (
    select (c.value #>> '{}')::bigint as employee_id,
           r.cartons / r.casual_count as cartons
      from casual_runs_in_range(p_start, p_end) r
      join production_logs l on l.id = r.run_id
      cross join lateral jsonb_array_elements(l.casuals) c
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
-- SECTION 5: record_salary_payment
--
-- Admin only. HR is admin-only throughout the app, and this is the write that
-- puts a salary in the P&L.
--
-- The gate is `is distinct from`, NOT `<>`. `get_my_role()` returns NULL for a
-- caller with no profiles row, and `NULL <> 'admin'` is NULL, which skips the
-- branch and FAILS OPEN inside a SECURITY DEFINER function. That trap is
-- documented in `027` and it is the reason this shape is copied verbatim.
-- =============================================================================

create or replace function record_salary_payment(p_pay jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_emp_id    bigint;
  v_month     text;
  v_key       uuid;
  v_claimed   numeric;
  v_role      text;
  v_emp       employees;
  v_advances  numeric;
  v_net       numeric;
  v_date      date;
  v_expense   expenses;
  v_pay       payroll_payments;
begin
  v_emp_id  := (p_pay ->> 'employeeId')::bigint;
  v_month   := nullif(trim(p_pay ->> 'month'), '');
  v_key     := nullif(p_pay ->> 'client_key', '')::uuid;
  v_claimed := (p_pay ->> 'amount')::numeric;
  v_date    := coalesce((p_pay ->> 'date')::date, current_date);

  -- Replay, fast path — before any validation, so a resend of something already
  -- recorded succeeds even if the rules or the figures have moved since. This
  -- is the branch that makes retrying after a lost connection safe.
  if v_key is not null then
    select * into v_expense from expenses where client_key = v_key;
    if found then
      return jsonb_build_object(
        'expense',  to_jsonb(v_expense),
        'payroll',  coalesce((select jsonb_agg(to_jsonb(pp) order by pp.id)
                                from payroll_payments pp
                               where pp.expense_id = v_expense.id), '[]'::jsonb),
        'replayed', true
      );
    end if;
  end if;

  v_role := get_my_role();

  -- FAILS CLOSED on a NULL role. `<>` would not.
  if v_role is distinct from 'admin' then
    raise exception 'record_salary_payment: only an admin may record a salary payment';
  end if;

  if v_emp_id is null or v_month is null then
    raise exception 'record_salary_payment: employeeId and month are required';
  end if;
  if v_month !~ '^\d{4}-\d{2}$' then
    raise exception 'record_salary_payment: month must be YYYY-MM, got %', v_month;
  end if;

  select * into v_emp from employees where id = v_emp_id;
  if not found then
    raise exception 'record_salary_payment: employee % not found', v_emp_id;
  end if;
  if v_emp.category is distinct from 'permanent' then
    raise exception 'record_salary_payment: % is not a permanent employee — casual work is paid through record_casual_payout', v_emp.name;
  end if;

  -- Net = salary minus advances already taken that month. Derived, never taken
  -- from the payload. An advance is an expense tagged to the employee, which is
  -- the same definition `getAdvancesForEmployee` uses in the client.
  select coalesce(sum(amount), 0) into v_advances
    from expenses
   where advance_employee_id = v_emp_id
     and to_char(date::date, 'YYYY-MM') = v_month;

  v_net := round(coalesce(v_emp.rate, 0) - v_advances, 2);

  if v_net <= 0 then
    raise exception 'record_salary_payment: nothing to pay % for % (salary %, advances %)',
      v_emp.name, v_month, coalesce(v_emp.rate, 0), v_advances;
  end if;

  -- The client's figure is a cross-check, not the source. A mismatch means the
  -- browser is holding a stale salary or stale advances, and recording a
  -- different number from the one just confirmed in a dialog is not acceptable
  -- on a payroll write. Refuse and make them reload.
  if v_claimed is not null and abs(v_claimed - v_net) > 0.01 then
    raise exception 'record_salary_payment: this screen shows % but the records give % for % (%). Reload and try again.',
      v_claimed, v_net, v_emp.name, v_month;
  end if;

  begin
    insert into expenses
      (date, category, subcategory, description, amount, advance_employee_id,
       created_by, client_key)
    values (
      v_date,
      'operating',
      'Salary',
      'Salary - ' || v_emp.name || ' (' || v_month || ')',
      v_net,
      null,
      auth.uid(),
      v_key
    )
    returning * into v_expense;
  exception when unique_violation then
    -- Race path: a concurrent request carrying the same key committed first.
    select * into v_expense from expenses where client_key = v_key;
    if not found then
      raise;  -- some OTHER unique constraint; not ours to swallow
    end if;
    return jsonb_build_object(
      'expense',  to_jsonb(v_expense),
      'payroll',  coalesce((select jsonb_agg(to_jsonb(pp) order by pp.id)
                              from payroll_payments pp
                             where pp.expense_id = v_expense.id), '[]'::jsonb),
      'replayed', true
    );
  end;

  -- Section 2's index is what refuses a genuine second payment for the month —
  -- a re-entry a week later, carrying a fresh key, which the replay branch
  -- above cannot and should not recognise. Raising here aborts the whole
  -- function, so the expense inserted a moment ago rolls back with it. That
  -- rollback is the entire point of this file: there is no longer any way to
  -- leave a Salary expense standing without its payroll row.
  begin
    insert into payroll_payments
      (type, employee_id, employee_name, period_label, period_start, period_end,
       amount, date_paid, expense_id)
    values (
      'salary', v_emp_id, v_emp.name, v_month,
      (v_month || '-01')::date,
      (date_trunc('month', (v_month || '-01')::date) + interval '1 month - 1 day')::date,
      v_net, v_date, v_expense.id
    )
    returning * into v_pay;
  exception when unique_violation then
    raise exception 'record_salary_payment: a salary for % has already been recorded for %. Nothing was saved.',
      v_emp.name, v_month;
  end;

  return jsonb_build_object(
    'expense',  to_jsonb(v_expense),
    'payroll',  jsonb_build_array(to_jsonb(v_pay)),
    'replayed', false
  );
end;
$$;


-- =============================================================================
-- SECTION 6: record_casual_payout
--
-- One expense, N payroll rows, and N production runs flagged paid — previously
-- 2 + N round trips, any of which could be the last one to succeed. Now one
-- transaction.
--
-- Note what is NOT in the payload: the employees, the amounts, the total, and
-- the run ids. All four are derived from the range. The client sends the range,
-- its own total as a cross-check, and a key.
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
  v_total    numeric;
  v_expense  expenses;
  v_rows     jsonb;
begin
  v_start   := (p_payout ->> 'start')::date;
  v_end     := (p_payout ->> 'end')::date;
  v_key     := nullif(p_payout ->> 'client_key', '')::uuid;
  v_claimed := (p_payout ->> 'total')::numeric;
  v_date    := coalesce((p_payout ->> 'date')::date, current_date);

  -- Replay, fast path. Same reasoning as the salary path.
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
  -- ranges are two different `period_label`s, so section 2's index cannot see
  -- that they pay for the same work — this lock is the only thing that can.
  -- The second caller blocks on the FOR UPDATE, then re-reads below and finds
  -- the runs already flagged.
  v_run_ids := array(select run_id from casual_runs_in_range(v_start, v_end) order by run_id);

  if array_length(v_run_ids, 1) is null then
    raise exception 'record_casual_payout: no unpaid casual work in % — nothing was saved', v_label;
  end if;

  perform 1 from production_logs where id = any(v_run_ids) for update;

  if exists (select 1 from production_logs
              where id = any(v_run_ids) and coalesce(casual_paid, false)) then
    raise exception 'record_casual_payout: someone else recorded a payout covering these production runs while this one was being saved. Nothing was saved — reload and check.';
  end if;

  select coalesce(sum(pay), 0) into v_total from casual_pay_for_range(v_start, v_end);

  if v_total <= 0 then
    raise exception 'record_casual_payout: the casual rate or the cartons produced give a total of zero for % — nothing was saved', v_label;
  end if;

  -- Cross-check, not source. See the salary path.
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

  begin
    insert into payroll_payments
      (type, employee_id, employee_name, period_label, period_start, period_end,
       amount, date_paid, expense_id)
    select 'casual', p.employee_id, e.name, v_label, v_start, v_end,
           p.pay, v_date, v_expense.id
      from casual_pay_for_range(v_start, v_end) p
      join employees e on e.id = p.employee_id;
  exception when unique_violation then
    raise exception 'record_casual_payout: a payout for % has already been recorded. Nothing was saved.', v_label;
  end;

  -- The same run list the pay was computed from, so what was paid for and what
  -- is marked paid cannot disagree.
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
-- SECTION 7: grants
--
-- No new table, so no new RLS. `payroll_payments` keeps `001`'s policies
-- (admin/manager read, admin write) and `expenses` keeps its own — both are
-- bypassed inside these SECURITY DEFINER functions, which is exactly why the
-- explicit admin gate at the top of each one is the real boundary.
--
-- EXECUTE goes to `authenticated`, not to a role: the gate inside decides. anon
-- gets nothing.
--
-- The two read-only helpers are granted as well — the client uses neither
-- today, but they are how the Casual Pay view will eventually stop computing
-- pay in the browser, and they expose nothing a manager cannot already see.
-- =============================================================================

revoke all on function casual_runs_in_range(date, date) from anon, public;
revoke all on function casual_pay_for_range(date, date) from anon, public;
revoke all on function record_salary_payment(jsonb) from anon, public;
revoke all on function record_casual_payout(jsonb) from anon, public;

grant execute on function casual_runs_in_range(date, date) to authenticated;
grant execute on function casual_pay_for_range(date, date) to authenticated;
grant execute on function record_salary_payment(jsonb) to authenticated;
grant execute on function record_casual_payout(jsonb) to authenticated;


commit;


-- =============================================================================
-- POST-APPLY VERIFICATION — run every one of these.
--
-- The 2026-07-28 balance correction was recorded as applied and had not landed.
-- `010` was recorded as applied and was half-applied for three months. These
-- checks are the difference between a record of intent and a record of fact.
--
-- 1. The functions exist, the two that write are SECURITY DEFINER, and all four
--    have a pinned search_path.
--
--      select proname, prosecdef, proconfig from pg_proc p
--        join pg_namespace n on n.oid = p.pronamespace
--       where n.nspname = 'public'
--         and proname in ('casual_runs_in_range', 'casual_pay_for_range',
--                         'record_salary_payment', 'record_casual_payout')
--       order by proname;
--
--    Expect four rows. `record_salary_payment` and `record_casual_payout` must
--    show prosecdef = t. All four must show search_path set.
--
-- 2. Both indexes exist.
--
--      select indexname, indexdef from pg_indexes
--       where schemaname = 'public'
--         and indexname in ('payroll_payments_period_uniq',
--                           'expenses_client_key_uniq');
--
--    Expect two rows, both UNIQUE, and `expenses_client_key_uniq` carrying its
--    `WHERE (client_key IS NOT NULL)` clause. Without that clause it is not
--    partial and the next unkeyed expense insert collides with the one before.
--
-- 3. NOTHING MOVED. Re-run block 0e and diff it against what you kept.
--
--      select subcategory, count(*), sum(amount)
--        from expenses
--       where subcategory in ('Salary', 'Casual Labour')
--       group by subcategory;
--
--      select type, count(*), sum(amount) from payroll_payments group by type;
--
--    Both must be IDENTICAL to before. This file records nothing; if a figure
--    moved, something else did it and you want to know that now.
--
-- 4. The duplicate guard actually refuses. Use a real (type, employee_id,
--    period_label) that already exists — pick one from
--    `select type, employee_id, period_label from payroll_payments limit 1`.
--
--      begin;
--      insert into payroll_payments
--        (type, employee_id, period_label, amount, date_paid)
--      values ('<type>', <employee_id>, '<period_label>', 1, current_date);
--      rollback;
--
--    Expect: `duplicate key value violates unique constraint
--    "payroll_payments_period_uniq"`. If the insert is accepted, section 2 did
--    not apply and the whole first layer is missing.
--
-- 5. THE GATE FAILS CLOSED. From the SQL Editor, where auth.uid() is NULL and
--    therefore get_my_role() is NULL. Use a REAL permanent employee id — with a
--    non-existent one, a gate that failed open would be stopped by the "employee
--    not found" check instead, which reads like a refusal and is not one. The
--    whole point of this check is to tell those two apart.
--
--    ROLL THESE BACK. A gate that refuses aborts its own transaction anyway, so
--    the wrapper costs nothing in the expected case — but if the gate FAILS
--    OPEN, the bare call writes a real Salary expense into the P&L and a real
--    payroll row, and you would be cleaning up the thing you were testing for.
--    Check 4 below is wrapped for the same reason.
--
--      begin;
--      select record_salary_payment(
--        '{"employeeId":<real_permanent_id>,"month":"2026-01"}'::jsonb);
--      rollback;
--
--      begin;
--      select record_casual_payout(
--        '{"start":"2026-01-01","end":"2026-01-07"}'::jsonb);
--      rollback;
--
--    Expect exactly 'only an admin may record a salary payment' and 'only an
--    admin may record a casual payout'.
--
--    ANY other outcome is a failure. Two in particular:
--      * A returned row means the gate was written `<>` instead of
--        `is distinct from` and NULL skipped the branch. STOP — do not merge
--        the client, and remove what it wrote.
--      * 'employee ... not found' or 'no unpaid casual work' means the gate was
--        skipped and you reached the validation below it. Same conclusion.
--
-- 6. The derived figures agree with what the app is showing. Read-only, and
--    worth running BEFORE the first real payout:
--
--      select * from casual_pay_for_range('<start>', '<end>') order by employee_id;
--
--    Compare against the Casual Pay view in the app for the same range. Per
--    employee and in total they must match to the cent. A difference means the
--    browser is stale, or the casual rate in `cost_settings` is not the one the
--    screen is using — settle that before paying anyone, not after.
--
-- 7. End to end, from the app as an admin, on ONE employee first:
--    a. record a salary; confirm ONE Salary expense and ONE payroll row appear,
--       and the P&L moves by exactly that amount and no more,
--    b. the button for that employee/month must now read "Paid",
--    c. delete that expense from the Expenses tab and confirm the payroll row
--       goes with it and the month returns to unpaid,
--    d. repeat a-c for a casual payout over a SHORT range, and confirm the
--       production runs in that range flip to paid and back.
--
-- 8. THE HALF-COMMITTED EXPENSE IS GONE. This is the finding the file exists to
--    close, so prove it rather than assume it. As an admin, from the app,
--    record a salary for an employee/month that ALREADY has a payroll row (the
--    button is hidden, so call the RPC from the browser console). The write must
--    fail AND leave no expense behind:
--
--      select count(*) from expenses
--       where subcategory = 'Salary' and description like '%<name>%<month>%';
--
--    Expect the same count as before the attempt. Under the old code this is
--    exactly where the second Salary expense appeared.
--
--    Unlike check 5, this one needs no rollback wrapper and cannot be given one
--    — it runs through the app. It does not need one: the RPC is a single
--    transaction, so the unique violation on the payroll row takes the expense
--    down with it. That self-rollback IS the property under test. If an expense
--    survives this, the function is not atomic and the finding is not closed.
-- =============================================================================

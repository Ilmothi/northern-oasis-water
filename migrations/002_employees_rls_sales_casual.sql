-- Allow sales role to read casual employees (needed for production log casuals selector).
-- admin and manager retain full read access.

drop policy "employees_select" on employees;

create policy "employees_select"
  on employees for select
  using (
    get_my_role() in ('admin', 'manager')
    or (get_my_role() = 'sales' and category = 'casual')
  );
